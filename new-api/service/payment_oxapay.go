package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/shopspring/decimal"
)

func (client *HostedPaymentClient) oxaPayAPI(ctx context.Context, method, path string, body any, result any) error {
	var raw []byte
	var err error
	if body != nil {
		raw, err = common.Marshal(body)
		if err != nil {
			return err
		}
	}
	headers := http.Header{}
	headers.Set("merchant_api_key", client.Config.APIKey)
	headers.Set("Content-Type", "application/json")
	response, _, status, err := client.request(ctx, method, "https://api.oxapay.com/v1"+path, raw, headers)
	if err != nil {
		return err
	}
	var envelope struct {
		Status int               `json:"status"`
		Error  common.RawMessage `json:"error"`
		Data   common.RawMessage `json:"data"`
	}
	if err := hostedDecodeResponse(response, status, &envelope); err != nil {
		return err
	}
	if envelope.Status != http.StatusOK || (len(envelope.Error) > 0 && string(envelope.Error) != "null") || len(envelope.Data) == 0 {
		return errors.New("OxaPay rejected the request")
	}
	return common.Unmarshal(envelope.Data, result)
}

func (client *HostedPaymentClient) createOxaPay(ctx context.Context, order *model.HostedPayment, options HostedCheckoutOptions) (*HostedCheckout, error) {
	var result struct {
		ID  string `json:"track_id"`
		URL string `json:"payment_url"`
	}
	body := map[string]any{
		"amount": common.RawMessage(order.Amount), "currency": order.Currency, "order_id": order.TradeNo,
		"callback_url": options.WebhookURL, "return_url": options.ReturnURL, "lifetime": 60,
		"under_paid_coverage": 0, "mixed_payment": false, "fee_paid_by_payer": 0,
		"sandbox": client.Config.Environment == "test", "description": "Shiny API credit",
	}
	if err := client.oxaPayAPI(ctx, http.MethodPost, "/payment/invoice", body, &result); err != nil {
		return nil, err
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`).MatchString(result.ID) {
		return nil, errors.New("invalid OxaPay track ID")
	}
	checkoutURL, err := setting.HostedCheckoutURL(result.URL, []string{"pay.oxapay.com"})
	if err != nil {
		return nil, err
	}
	return &HostedCheckout{RemoteID: result.ID, URL: checkoutURL}, nil
}

func (client *HostedPaymentClient) verifyOxaPay(body []byte, headers http.Header) (*HostedPaymentEvent, error) {
	if client.Config.APIKey == "" {
		return nil, errors.New("missing OxaPay Merchant API key")
	}
	signature, err := hex.DecodeString(headers.Get("HMAC"))
	mac := hmac.New(sha512.New, []byte(client.Config.APIKey))
	mac.Write(body)
	if err != nil || !hostedEqualSignature(mac.Sum(nil), signature) {
		return nil, errors.New("invalid payment signature")
	}
	var event struct {
		ID        string `json:"track_id"`
		Reference string `json:"order_id"`
		Type      string `json:"type"`
		Status    string `json:"status"`
	}
	if common.Unmarshal(body, &event) != nil {
		return nil, errors.New("invalid payment notification")
	}
	if event.Type != "invoice" || !strings.EqualFold(event.Status, "paid") {
		return nil, nil
	}
	if event.Reference == "" || !regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`).MatchString(event.ID) {
		return nil, errors.New("invalid OxaPay payment reference")
	}
	return &HostedPaymentEvent{Reference: event.Reference, RemoteID: event.ID, ExpectsPaid: true}, nil
}

func (client *HostedPaymentClient) queryOxaPay(ctx context.Context, order *model.HostedPayment, remoteID string) (*HostedPaymentResult, error) {
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`).MatchString(remoteID) {
		return nil, errors.New("invalid OxaPay track ID")
	}
	var result struct {
		ID           string           `json:"track_id"`
		Reference    string           `json:"order_id"`
		Type         string           `json:"type"`
		Amount       decimal.Decimal  `json:"amount"`
		Currency     string           `json:"currency"`
		Status       string           `json:"status"`
		Coverage     *decimal.Decimal `json:"under_paid_coverage"`
		Mixed        bool             `json:"mixed_payment"`
		CallbackURL  string           `json:"callback_url"`
		Transactions []struct {
			Status string          `json:"status"`
			Hash   string          `json:"tx_hash"`
			Amount decimal.Decimal `json:"amount"`
		} `json:"txs"`
	}
	if err := client.oxaPayAPI(ctx, http.MethodGet, "/payment/"+url.PathEscape(remoteID), nil, &result); err != nil {
		return nil, err
	}
	// v1 does not document a sandbox field on queries. Pin provenance to the
	// exact callback URL saved before the explicit sandbox/live create request.
	callbackHash := sha256.Sum256([]byte(result.CallbackURL))
	if result.ID != remoteID || result.Reference != order.TradeNo || result.Type != "invoice" ||
		order.CallbackHash == "" || hex.EncodeToString(callbackHash[:]) != order.CallbackHash || result.Mixed ||
		result.Coverage == nil || !result.Coverage.IsZero() {
		return nil, errors.New("OxaPay invoice, callback environment or underpayment policy mismatch")
	}
	confirmed := false
	for _, transaction := range result.Transactions {
		if transaction.Status == "confirmed" && transaction.Hash != "" && transaction.Amount.IsPositive() {
			confirmed = true
		}
	}
	return &HostedPaymentResult{Reference: result.Reference, RemoteID: result.ID, Amount: result.Amount.String(),
		Currency: strings.ToUpper(result.Currency), Paid: strings.EqualFold(result.Status, "paid") && confirmed}, nil
}
