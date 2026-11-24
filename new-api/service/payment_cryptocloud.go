package service

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/golang-jwt/jwt/v5"
	"github.com/shopspring/decimal"
)

type hostedCryptoCloudInvoice struct {
	ID            string          `json:"uuid"`
	Reference     string          `json:"order_id"`
	URL           string          `json:"link"`
	Currency      string          `json:"fiat_currency"`
	Amount        decimal.Decimal `json:"amount_in_fiat"`
	ToPay         decimal.Decimal `json:"amount_to_pay"`
	Paid          decimal.Decimal `json:"amount_paid"`
	Surcharge     decimal.Decimal `json:"to_surcharge"`
	Status        string          `json:"status"`
	InvoiceStatus string          `json:"invoice_status"`
	TestMode      *bool           `json:"test_mode"`
}

func (client *HostedPaymentClient) cryptoCloudAPI(ctx context.Context, path string, body any, result any) error {
	base := "https://api.trybit.com/v2"
	if client.Config.APIVariant == "cryptocloud" {
		base = "https://api.cryptocloud.plus/v2"
	} else if client.Config.APIVariant != "trybit" {
		return errors.New("select an explicit CryptoCloud API variant")
	}
	raw, err := common.Marshal(body)
	if err != nil {
		return err
	}
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	headers.Set("Authorization", "Token "+client.Config.APIKey)
	response, _, status, err := client.request(ctx, http.MethodPost, base+path, raw, headers)
	if err != nil {
		return err
	}
	return hostedDecodeResponse(response, status, result)
}

func (client *HostedPaymentClient) createCryptoCloud(ctx context.Context, order *model.HostedPayment, options HostedCheckoutOptions) (*HostedCheckout, error) {
	body := map[string]any{"shop_id": client.Config.AccountID, "order_id": order.TradeNo, "amount": common.RawMessage(order.Amount), "currency": order.Currency}
	if client.Config.PayCurrency != "" {
		body["add_fields"] = map[string]string{"cryptocurrency": client.Config.PayCurrency}
	}
	var response struct {
		Status string                   `json:"status"`
		Result hostedCryptoCloudInvoice `json:"result"`
	}
	if err := client.cryptoCloudAPI(ctx, "/invoice/create", body, &response); err != nil {
		return nil, err
	}
	result := response.Result
	expected, _ := decimal.NewFromString(order.Amount)
	if response.Status != "success" || !strings.HasPrefix(result.ID, "INV-") || len(result.ID) > 128 ||
		result.TestMode == nil || *result.TestMode != (client.Config.Environment == "test") ||
		result.Currency != order.Currency || !result.Amount.Equal(expected) {
		return nil, errors.New("CryptoCloud invoice does not match quote or environment")
	}
	checkoutURL, err := setting.HostedCheckoutURL(result.URL, client.Config.CheckoutHosts)
	if err != nil {
		return nil, err
	}
	return &HostedCheckout{RemoteID: result.ID, URL: checkoutURL}, nil
}

func (client *HostedPaymentClient) verifyCryptoCloud(body []byte, headers http.Header) (*HostedPaymentEvent, error) {
	var event struct {
		Status    string `json:"status"`
		ID        string `json:"invoice_id"`
		Reference string `json:"order_id"`
		Token     string `json:"token"`
	}
	if strings.HasPrefix(headers.Get("Content-Type"), "application/x-www-form-urlencoded") {
		values, err := hostedPaymentForm(body, headers)
		if err != nil {
			return nil, err
		}
		event.Status, event.ID, event.Reference, event.Token = values.Get("status"), values.Get("invoice_id"), values.Get("order_id"), values.Get("token")
	} else if common.Unmarshal(body, &event) != nil {
		return nil, errors.New("invalid payment notification")
	}
	if event.Token == "" || client.Config.WebhookSecret == "" || len(event.Token) > 8192 {
		return nil, errors.New("missing payment notification JWT")
	}
	claims := jwt.MapClaims{}
	token, err := jwt.ParseWithClaims(event.Token, claims, func(_ *jwt.Token) (any, error) {
		return []byte(client.Config.WebhookSecret), nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithExpirationRequired(), jwt.WithIssuedAt())
	if err != nil || !token.Valid {
		return nil, errors.New("invalid or expired payment notification JWT")
	}
	expires, err := claims.GetExpirationTime()
	if err != nil || expires == nil || expires.Time.After(time.Now().Add(5*time.Minute+30*time.Second)) {
		return nil, errors.New("invalid payment notification expiry")
	}
	if event.Status != "success" {
		return nil, nil
	}
	if event.ID == "" || event.Reference == "" || len(event.ID) > 124 || strings.ContainsAny(event.ID, "/?#\r\n ") {
		return nil, errors.New("invalid CryptoCloud invoice reference")
	}
	id := event.ID
	if !strings.HasPrefix(id, "INV-") {
		id = "INV-" + id
	}
	return &HostedPaymentEvent{Reference: event.Reference, RemoteID: id, ExpectsPaid: true}, nil
}

func (client *HostedPaymentClient) queryCryptoCloud(ctx context.Context, order *model.HostedPayment, remoteID string) (*HostedPaymentResult, error) {
	if !strings.HasPrefix(remoteID, "INV-") || len(remoteID) > 128 || strings.ContainsAny(remoteID, "/?#\r\n ") {
		return nil, errors.New("invalid CryptoCloud invoice ID")
	}
	var response struct {
		Status  string                     `json:"status"`
		Results []hostedCryptoCloudInvoice `json:"result"`
	}
	if err := client.cryptoCloudAPI(ctx, "/invoice/merchant/info", map[string]any{"uuids": []string{remoteID}}, &response); err != nil {
		return nil, err
	}
	if response.Status != "success" || len(response.Results) != 1 {
		return nil, errors.New("CryptoCloud invoice not found or ambiguous")
	}
	result := response.Results[0]
	if result.ID != remoteID || result.Reference != order.TradeNo || result.Currency != order.Currency ||
		result.TestMode == nil || *result.TestMode != (client.Config.Environment == "test") {
		return nil, errors.New("CryptoCloud order, currency or environment mismatch")
	}
	paid := (result.Status == "paid" || result.Status == "overpaid") && result.InvoiceStatus == "success" &&
		result.ToPay.IsPositive() && result.Paid.GreaterThanOrEqual(result.ToPay) && !result.Surcharge.IsPositive()
	return &HostedPaymentResult{Reference: result.Reference, RemoteID: result.ID, Amount: result.Amount.String(), Currency: result.Currency, Paid: paid}, nil
}
