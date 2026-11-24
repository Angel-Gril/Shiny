package service

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

func (client *HostedPaymentClient) plategaAPI(ctx context.Context, method, path string, body any, result any) error {
	var raw []byte
	var err error
	if body != nil {
		raw, err = common.Marshal(body)
		if err != nil {
			return err
		}
	}
	headers := http.Header{}
	headers.Set("X-MerchantId", client.Config.MerchantID)
	headers.Set("X-Secret", client.Config.APISecret)
	headers.Set("Content-Type", "application/json")
	response, _, status, err := client.request(ctx, method, "https://app.platega.io"+path, raw, headers)
	if err != nil {
		return err
	}
	return hostedDecodeResponse(response, status, result)
}

func (client *HostedPaymentClient) createPlatega(ctx context.Context, order *model.HostedPayment, options HostedCheckoutOptions) (*HostedCheckout, error) {
	if client.Config.Environment != "live" || options.CustomerEmail == "" || order.CustomerID == "" {
		return nil, errors.New("Platega requires a live merchant and authenticated customer")
	}
	amount, err := decimal.NewFromString(order.Amount)
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"paymentDetails": map[string]any{"amount": common.RawMessage(amount.String()), "currency": order.Currency},
		"description":    "Shiny API credit", "return": options.ReturnURL, "failedUrl": options.ReturnURL,
		"payload": order.TradeNo, "orderId": order.TradeNo,
		"metadata": map[string]string{"user_email": options.CustomerEmail, "userId": order.CustomerID},
	}
	path := "/v2/transaction/process"
	if client.Config.PaymentMethod != "" {
		method, err := strconv.Atoi(client.Config.PaymentMethod)
		if err != nil {
			return nil, errors.New("invalid Platega payment method")
		}
		body["paymentMethod"] = method
		path = "/transaction/process"
	}
	var result struct {
		ID         string `json:"transactionId"`
		URL        string `json:"redirect"`
		MerchantID string `json:"merchantId"`
		Status     string `json:"status"`
	}
	if err := client.plategaAPI(ctx, http.MethodPost, path, body, &result); err != nil {
		return nil, err
	}
	if uuid.Validate(result.ID) != nil || (result.MerchantID != "" && result.MerchantID != client.Config.MerchantID) || result.Status != "PENDING" {
		return nil, errors.New("Platega transaction does not match merchant")
	}
	checkoutURL, err := setting.HostedCheckoutURL(result.URL, []string{"pay.platega.io"})
	if err != nil {
		return nil, err
	}
	return &HostedCheckout{RemoteID: result.ID, URL: checkoutURL}, nil
}

func (client *HostedPaymentClient) verifyPlatega(body []byte, headers http.Header) (*HostedPaymentEvent, error) {
	if client.Config.APISecret == "" || !hostedEqualSignature([]byte(client.Config.APISecret), []byte(headers.Get("X-Secret"))) ||
		!hostedEqualSignature([]byte(client.Config.MerchantID), []byte(headers.Get("X-MerchantId"))) {
		return nil, errors.New("invalid payment callback credentials")
	}
	var event struct {
		ID        string `json:"id"`
		Status    string `json:"status"`
		Reference string `json:"payload"`
	}
	if common.Unmarshal(body, &event) != nil || uuid.Validate(event.ID) != nil || event.Reference == "" {
		return nil, errors.New("invalid payment notification")
	}
	if event.Status != "CONFIRMED" {
		return nil, nil
	}
	return &HostedPaymentEvent{Reference: event.Reference, RemoteID: event.ID, ExpectsPaid: true}, nil
}

func (client *HostedPaymentClient) queryPlatega(ctx context.Context, order *model.HostedPayment, remoteID string) (*HostedPaymentResult, error) {
	if client.Config.Environment != "live" || uuid.Validate(remoteID) != nil {
		return nil, errors.New("invalid Platega transaction ID or environment")
	}
	var result struct {
		ID         string `json:"id"`
		Reference  string `json:"payload"`
		MerchantID string `json:"mechantId"` // This spelling is in the official schema.
		Status     string `json:"status"`
		Payment    struct {
			Amount   decimal.Decimal `json:"amount"`
			Currency string          `json:"currency"`
		} `json:"paymentDetails"`
	}
	if err := client.plategaAPI(ctx, http.MethodGet, "/transaction/"+url.PathEscape(remoteID), nil, &result); err != nil {
		return nil, err
	}
	if result.ID != remoteID || result.Reference != order.TradeNo || result.MerchantID != client.Config.MerchantID {
		return nil, errors.New("Platega merchant or order mismatch")
	}
	return &HostedPaymentResult{Reference: result.Reference, RemoteID: result.ID, Amount: result.Payment.Amount.String(),
		Currency: result.Payment.Currency, Paid: result.Status == "CONFIRMED"}, nil
}
