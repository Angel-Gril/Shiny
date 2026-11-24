package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"slices"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

type cisPayPayment struct {
	ID             string `json:"id"`
	StoreID        string `json:"store_id"`
	OrderID        string `json:"order_id"`
	PaymentMethod  string `json:"payment_method"`
	Status         string `json:"status"`
	Event          string `json:"event"`
	Object         string `json:"object"`
	SubscriptionID string `json:"subscription_id"`
	Amount         int64  `json:"amount"`
	Currency       string `json:"currency"`
	SourceAmount   *int64 `json:"source_amount"`
	SourceCurrency string `json:"source_currency"`
	PaymentURL     string `json:"payment_url"`
	ChargedAmount  int64  `json:"charged_amount"`
	IsSandbox      *bool  `json:"is_sandbox"`
	IsSubscription bool   `json:"is_subscription"`
	BlockReason    string `json:"block_reason"`
}

func (client *HostedPaymentClient) cisPayAPI(ctx context.Context, method, path string, body any, result any) error {
	var raw []byte
	var err error
	if body != nil {
		raw, err = common.Marshal(body)
		if err != nil {
			return err
		}
	}
	headers := http.Header{}
	headers.Set("X-Shop-ID", client.Config.StoreID)
	headers.Set("X-Api-Key", client.Config.APIKey)
	headers.Set("Content-Type", "application/json")
	response, _, status, err := client.request(ctx, method, "https://api.cispay.app"+path, raw, headers)
	if err != nil {
		return err
	}
	return hostedDecodeResponse(response, status, result)
}

// HostedMinorAmount converts a positive two-decimal money snapshot without
// floating point rounding. Provider-specific limits are checked by the adapter.
func HostedMinorAmount(value string) (int64, error) {
	amount, err := decimal.NewFromString(value)
	if err != nil || !amount.IsPositive() {
		return 0, errors.New("invalid payment amount")
	}
	minor := amount.Mul(decimal.NewFromInt(100))
	if !minor.Equal(minor.Truncate(0)) || minor.GreaterThan(decimal.NewFromInt(9223372036854775807)) {
		return 0, errors.New("invalid payment amount precision")
	}
	return minor.IntPart(), nil
}

func cisPayAmount(minor int64) string {
	return decimal.NewFromInt(minor).Div(decimal.NewFromInt(100)).StringFixed(2)
}

func cisPaySettlement(result cisPayPayment, order *model.HostedPayment, invoice bool) (string, string, error) {
	expectedAmount, err := HostedMinorAmount(order.Amount)
	if err != nil {
		return "", "", err
	}
	if result.Amount <= 0 {
		return "", "", errors.New("invalid cisPay amount")
	}
	if result.SourceAmount != nil || result.SourceCurrency != "" {
		if result.SourceAmount == nil || *result.SourceAmount != expectedAmount || result.SourceCurrency != "RUB" || order.Currency != "RUB" ||
			(result.Currency != "USD" && !(invoice && result.Currency == "")) || (!invoice && result.PaymentMethod != "CRYPTO") {
			return "", "", errors.New("cisPay source amount does not match order")
		}
		return cisPayAmount(*result.SourceAmount), result.SourceCurrency, nil
	}
	if result.Currency == "" && !invoice {
		return "", "", errors.New("cisPay currency is required")
	}
	if result.Amount != expectedAmount {
		return "", "", errors.New("cisPay amount does not match order")
	}
	if result.Currency != "" && result.Currency != order.Currency {
		return "", "", errors.New("cisPay currency does not match order")
	}
	return cisPayAmount(result.Amount), order.Currency, nil
}

func (client *HostedPaymentClient) createCisPay(ctx context.Context, order *model.HostedPayment, options HostedCheckoutOptions) (*HostedCheckout, error) {
	// The documented Merchant API has no sandbox-create flag or sandbox base.
	// Sandbox transactions are created in cisPay's merchant dashboard instead.
	if client.Config.Environment != "live" {
		return nil, errors.New("create cisPay sandbox payments in the merchant dashboard")
	}
	if options.CustomerID == "" || len(options.CustomerID) > 40 {
		return nil, errors.New("cisPay requires a stable customer ID")
	}
	amount, err := HostedMinorAmount(order.Amount)
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"amount": amount, "currency": order.Currency, "order_id": order.TradeNo,
		"customer_id": options.CustomerID, "description": "Shiny API credit",
		"redirect_success_url": options.ReturnURL, "redirect_fail_url": options.ReturnURL,
	}
	if client.Config.PaymentMethod != "" {
		body["payment_method"] = client.Config.PaymentMethod
	}
	var result cisPayPayment
	if err := client.cisPayAPI(ctx, http.MethodPost, "/payments", body, &result); err != nil {
		return nil, err
	}
	if len(result.ID) != 36 || uuid.Validate(result.ID) != nil || result.OrderID != order.TradeNo || result.Status != "PENDING" ||
		(result.IsSandbox != nil && *result.IsSandbox) || result.IsSubscription || result.BlockReason != "" {
		return nil, errors.New("cisPay invoice does not match order")
	}
	if _, _, err := cisPaySettlement(result, order, true); err != nil {
		return nil, err
	}
	checkoutURL, err := setting.HostedCheckoutURL(result.PaymentURL, client.Config.CheckoutHosts)
	if err != nil {
		return nil, err
	}
	return &HostedCheckout{RemoteID: result.ID, URL: checkoutURL}, nil
}

func (client *HostedPaymentClient) verifyCisPay(body []byte, headers http.Header) (*HostedPaymentEvent, error) {
	signature, err := hex.DecodeString(headers.Get("X-Signature"))
	if err != nil || len(signature) != sha256.Size {
		return nil, errors.New("invalid payment signature")
	}
	mac := hmac.New(sha256.New, []byte(client.Config.APIKey))
	mac.Write(body)
	if !hostedEqualSignature(mac.Sum(nil), signature) {
		return nil, errors.New("invalid payment signature")
	}
	var event cisPayPayment
	if err := common.Unmarshal(body, &event); err != nil {
		return nil, errors.New("invalid payment notification")
	}
	if event.StoreID != client.Config.StoreID {
		return nil, errors.New("payment merchant mismatch")
	}
	if event.Object == "subscription" || event.SubscriptionID != "" || event.Event != "" {
		return nil, nil // Subscription notifications cannot authorize a wallet recharge.
	}
	if len(event.ID) != 36 || uuid.Validate(event.ID) != nil {
		return nil, errors.New("invalid payment ID")
	}
	if !slices.Contains([]string{"PENDING", "PAID", "FAILED", "EXPIRED", "REFUNDED"}, event.Status) {
		return nil, errors.New("invalid payment status")
	}
	if event.OrderID == "" || (event.Currency == "" && event.SourceCurrency == "") || event.Amount <= 0 {
		return nil, errors.New("payment notification does not match merchant")
	}
	return &HostedPaymentEvent{Reference: event.OrderID, RemoteID: event.ID, ExpectsPaid: event.Status == "PAID"}, nil
}

func (client *HostedPaymentClient) queryCisPay(ctx context.Context, order *model.HostedPayment, remoteID string) (*HostedPaymentResult, error) {
	if remoteID != "" && (len(remoteID) != 36 || uuid.Validate(remoteID) != nil) {
		return nil, errors.New("invalid cisPay order ID")
	}
	query := url.Values{}
	if remoteID != "" {
		query.Set("id", remoteID)
	} else {
		query.Set("order_id", order.TradeNo)
	}
	// PaymentStatusResponse documents these defaults for omitted fields. A test
	// instance still requires an explicit true marker, and JSON null is rejected.
	result := cisPayPayment{Currency: "RUB", IsSandbox: new(bool)}
	if err := client.cisPayAPI(ctx, http.MethodGet, "/payments/status?"+query.Encode(), nil, &result); err != nil {
		return nil, err
	}
	if len(result.ID) != 36 || uuid.Validate(result.ID) != nil || result.OrderID != order.TradeNo ||
		(remoteID != "" && result.ID != remoteID) {
		return nil, errors.New("payment merchant or order mismatch")
	}
	if result.IsSandbox == nil || *result.IsSandbox != (client.Config.Environment == "test") {
		return nil, errors.New("payment environment mismatch")
	}
	if result.IsSubscription || result.SubscriptionID != "" || result.BlockReason != "" {
		return nil, errors.New("cisPay payment is unavailable for wallet recharge")
	}
	if !slices.Contains([]string{"PENDING", "PAID", "FAILED", "EXPIRED", "REFUNDED"}, result.Status) {
		return nil, errors.New("invalid cisPay payment status")
	}
	amount, currency, err := cisPaySettlement(result, order, false)
	if err != nil {
		return nil, err
	}
	return &HostedPaymentResult{
		Reference: result.OrderID, RemoteID: result.ID, Amount: amount,
		Currency: currency, Paid: result.Status == "PAID",
	}, nil
}
