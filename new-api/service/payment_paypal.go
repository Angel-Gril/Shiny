package service

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"regexp"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/shopspring/decimal"
)

type payPalMoney struct {
	Currency string `json:"currency_code"`
	Value    string `json:"value"`
}

type payPalUnit struct {
	ReferenceID string      `json:"reference_id"`
	CustomID    string      `json:"custom_id"`
	Amount      payPalMoney `json:"amount"`
	Payee       struct {
		MerchantID string `json:"merchant_id"`
	} `json:"payee"`
	Payments struct {
		Captures []struct {
			Status string      `json:"status"`
			Amount payPalMoney `json:"amount"`
		} `json:"captures"`
	} `json:"payments"`
}

type payPalOrder struct {
	ID            string       `json:"id"`
	Status        string       `json:"status"`
	PurchaseUnits []payPalUnit `json:"purchase_units"`
	Links         []struct {
		Rel  string `json:"rel"`
		Href string `json:"href"`
	} `json:"links"`
}

func (client *HostedPaymentClient) payPalAPI(ctx context.Context, path string, body any, requestID string, result any) error {
	base := "https://api-m.paypal.com"
	if client.Config.Environment == "test" {
		base = "https://api-m.sandbox.paypal.com"
	}
	authHeaders := http.Header{}
	authHeaders.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(client.Config.ClientID+":"+client.Config.ClientSecret)))
	authHeaders.Set("Content-Type", "application/x-www-form-urlencoded")
	authRaw, _, authStatus, err := client.request(ctx, http.MethodPost, base+"/v1/oauth2/token", []byte("grant_type=client_credentials"), authHeaders)
	if err != nil {
		return err
	}
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := hostedDecodeResponse(authRaw, authStatus, &token); err != nil || token.AccessToken == "" {
		return errors.New("PayPal authentication failed")
	}
	var raw []byte
	method := http.MethodGet
	if body != nil {
		raw, err = common.Marshal(body)
		if err != nil {
			return err
		}
		method = http.MethodPost
	}
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+token.AccessToken)
	headers.Set("Content-Type", "application/json")
	headers.Set("Prefer", "return=representation")
	if requestID != "" {
		headers.Set("PayPal-Request-Id", requestID)
	}
	response, _, status, err := client.request(ctx, method, base+path, raw, headers)
	if err != nil {
		return err
	}
	return hostedDecodeResponse(response, status, result)
}

func (client *HostedPaymentClient) createPayPal(ctx context.Context, order *model.HostedPayment, returnURL string) (*HostedCheckout, error) {
	body := map[string]any{
		"intent": "CAPTURE",
		"purchase_units": []map[string]any{{
			"reference_id": order.TradeNo, "custom_id": order.TradeNo, "invoice_id": order.TradeNo,
			"amount": payPalMoney{Currency: order.Currency, Value: order.Amount},
			"payee":  map[string]string{"merchant_id": client.Config.MerchantID}, "description": "Shiny API credit",
		}},
		"payment_source": map[string]any{"paypal": map[string]any{"experience_context": map[string]any{
			"shipping_preference": "NO_SHIPPING", "user_action": "PAY_NOW", "return_url": returnURL, "cancel_url": returnURL,
		}}},
	}
	var result payPalOrder
	if err := client.payPalAPI(ctx, "/v2/checkout/orders", body, order.TradeNo, &result); err != nil {
		return nil, err
	}
	if !regexp.MustCompile(`^[A-Z0-9]{1,40}$`).MatchString(result.ID) {
		return nil, errors.New("invalid PayPal order ID")
	}
	hosts := []string{"www.paypal.com", "paypal.com"}
	if client.Config.Environment == "test" {
		hosts = []string{"www.sandbox.paypal.com", "sandbox.paypal.com"}
	}
	for _, link := range result.Links {
		if link.Rel != "payer-action" && link.Rel != "approve" {
			continue
		}
		checkoutURL, err := setting.HostedCheckoutURL(link.Href, hosts)
		if err != nil {
			return nil, err
		}
		return &HostedCheckout{RemoteID: result.ID, URL: checkoutURL}, nil
	}
	return nil, errors.New("missing PayPal approval URL")
}

func (client *HostedPaymentClient) verifyPayPal(ctx context.Context, body []byte, headers http.Header) (*HostedPaymentEvent, error) {
	var event struct {
		EventType string `json:"event_type"`
		Resource  struct {
			ID                string `json:"id"`
			SupplementaryData struct {
				RelatedIDs struct {
					OrderID string `json:"order_id"`
				} `json:"related_ids"`
			} `json:"supplementary_data"`
		} `json:"resource"`
	}
	if err := common.Unmarshal(body, &event); err != nil {
		return nil, errors.New("invalid payment notification")
	}
	payload := map[string]any{"webhook_id": client.Config.WebhookID, "webhook_event": common.RawMessage(body)}
	for _, field := range []string{"auth_algo", "cert_url", "transmission_id", "transmission_sig", "transmission_time"} {
		header := "PayPal-"
		for _, character := range field {
			if character == '_' {
				header += "-"
			} else {
				header += string(character)
			}
		}
		value := headers.Get(header)
		if value == "" {
			return nil, errors.New("missing PayPal signature")
		}
		payload[field] = value
	}
	var result struct {
		Status string `json:"verification_status"`
	}
	if err := client.payPalAPI(ctx, "/v1/notifications/verify-webhook-signature", payload, "", &result); err != nil || result.Status != "SUCCESS" {
		return nil, errors.New("invalid PayPal signature")
	}
	if event.EventType == "CHECKOUT.ORDER.APPROVED" {
		return &HostedPaymentEvent{RemoteID: event.Resource.ID}, nil
	}
	if event.EventType == "PAYMENT.CAPTURE.COMPLETED" {
		return &HostedPaymentEvent{RemoteID: event.Resource.SupplementaryData.RelatedIDs.OrderID}, nil
	}
	return nil, nil
}

func (client *HostedPaymentClient) payPalUnit(result payPalOrder, order *model.HostedPayment) (*payPalUnit, error) {
	if result.ID != order.RemoteID || len(result.PurchaseUnits) != 1 {
		return nil, errors.New("PayPal order identity mismatch")
	}
	unit := result.PurchaseUnits[0]
	expected, _ := decimal.NewFromString(order.Amount)
	actual, err := decimal.NewFromString(unit.Amount.Value)
	if unit.ReferenceID != order.TradeNo || unit.CustomID != order.TradeNo || unit.Payee.MerchantID != client.Config.MerchantID ||
		unit.Amount.Currency != order.Currency || err != nil || !actual.Equal(expected) {
		return nil, errors.New("PayPal order does not match merchant or payment amount")
	}
	return &unit, nil
}

func (client *HostedPaymentClient) queryPayPal(ctx context.Context, order *model.HostedPayment) (*HostedPaymentResult, error) {
	if !regexp.MustCompile(`^[A-Z0-9]{1,40}$`).MatchString(order.RemoteID) {
		return nil, errors.New("missing PayPal order ID")
	}
	path := "/v2/checkout/orders/" + url.PathEscape(order.RemoteID)
	var result payPalOrder
	if err := client.payPalAPI(ctx, path, nil, "", &result); err != nil {
		return nil, err
	}
	unit, err := client.payPalUnit(result, order)
	if err != nil {
		return nil, err
	}
	if result.Status == "APPROVED" {
		var captureResult payPalOrder
		if err := client.payPalAPI(ctx, path+"/capture", map[string]any{}, order.TradeNo+"-cap", &captureResult); err != nil {
			return nil, err
		}
		if err := client.payPalAPI(ctx, path, nil, "", &result); err != nil {
			return nil, err
		}
		unit, err = client.payPalUnit(result, order)
		if err != nil {
			return nil, err
		}
	}
	paid := false
	if result.Status == "COMPLETED" && len(unit.Payments.Captures) == 1 {
		capture := unit.Payments.Captures[0]
		amount, err := decimal.NewFromString(capture.Amount.Value)
		expected, _ := decimal.NewFromString(order.Amount)
		paid = err == nil && capture.Status == "COMPLETED" && capture.Amount.Currency == order.Currency && amount.Equal(expected)
	}
	return &HostedPaymentResult{Reference: order.TradeNo, RemoteID: result.ID, Amount: unit.Amount.Value, Currency: unit.Amount.Currency, Paid: paid}, nil
}
