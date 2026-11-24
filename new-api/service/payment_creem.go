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
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
)

type hostedCreemProduct struct {
	ID                 string `json:"id"`
	Mode               string `json:"mode"`
	Status             string `json:"status"`
	BillingType        string `json:"billing_type"`
	Currency           string `json:"currency"`
	TaxMode            string `json:"tax_mode"`
	BusinessNetPricing bool   `json:"business_net_pricing"`
}

type hostedCreemCheckout struct {
	ID           string            `json:"id"`
	RequestID    string            `json:"request_id"`
	Mode         string            `json:"mode"`
	Status       string            `json:"status"`
	Units        int64             `json:"units"`
	CustomPrice  int64             `json:"custom_price"`
	CheckoutURL  string            `json:"checkout_url"`
	Product      common.RawMessage `json:"product"`
	Metadata     map[string]string `json:"metadata"`
	Subscription common.RawMessage `json:"subscription"`
	Order        struct {
		ID             string `json:"id"`
		Product        string `json:"product"`
		Mode           string `json:"mode"`
		Currency       string `json:"currency"`
		Amount         int64  `json:"amount"`
		AmountDue      int64  `json:"amount_due"`
		AmountPaid     int64  `json:"amount_paid"`
		DiscountAmount int64  `json:"discount_amount"`
		Status         string `json:"status"`
		Type           string `json:"type"`
	} `json:"order"`
}

func (client *HostedPaymentClient) creemModeMatches(mode string) bool {
	if client.Config.Environment == "test" {
		return mode == "test" || mode == "sandbox"
	}
	return mode == "prod"
}

func (client *HostedPaymentClient) creemAPI(ctx context.Context, method, path string, body any, result any) error {
	base := "https://api.creem.io"
	if client.Config.Environment == "test" {
		base = "https://test-api.creem.io"
	}
	var raw []byte
	var err error
	if body != nil {
		raw, err = common.Marshal(body)
		if err != nil {
			return err
		}
	}
	headers := http.Header{}
	headers.Set("x-api-key", client.Config.APIKey)
	headers.Set("Content-Type", "application/json")
	response, _, status, err := client.request(ctx, method, base+path, raw, headers)
	if err != nil {
		return err
	}
	return hostedDecodeResponse(response, status, result)
}

func (client *HostedPaymentClient) createCreem(ctx context.Context, order *model.HostedPayment, options HostedCheckoutOptions) (*HostedCheckout, error) {
	minor, err := HostedMinorAmount(order.Amount)
	if err != nil || minor < 100 || minor > 99999999 || order.ProductID == "" || options.CustomerEmail == "" {
		return nil, errors.New("invalid Creem checkout amount, product or customer")
	}
	var product hostedCreemProduct
	if err := client.creemAPI(ctx, http.MethodGet, "/v1/products/"+url.PathEscape(order.ProductID), nil, &product); err != nil {
		return nil, err
	}
	if product.ID != order.ProductID || !client.creemModeMatches(product.Mode) || product.Status != "active" ||
		product.BillingType != "onetime" || product.Currency != order.Currency || product.TaxMode != "inclusive" || product.BusinessNetPricing {
		return nil, errors.New("Creem requires an active tax-inclusive one-time product without business net pricing")
	}
	body := map[string]any{
		"product_id": order.ProductID, "request_id": order.TradeNo, "custom_price": minor, "units": 1,
		"success_url": options.ReturnURL, "customer": map[string]string{"email": options.CustomerEmail},
		"metadata": map[string]string{"reference_id": order.TradeNo, "user_id": order.CustomerID},
	}
	var checkout hostedCreemCheckout
	if err := client.creemAPI(ctx, http.MethodPost, "/v1/checkouts", body, &checkout); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(checkout.ID, "chk_") || checkout.RequestID != order.TradeNo || !client.creemModeMatches(checkout.Mode) ||
		!slices.Contains([]string{"pending", "processing", "completed"}, checkout.Status) {
		return nil, errors.New("Creem checkout does not match order")
	}
	checkoutURL, err := setting.HostedCheckoutURL(checkout.CheckoutURL, []string{"www.creem.io", "creem.io", "test.creem.io"})
	if err != nil {
		return nil, err
	}
	return &HostedCheckout{RemoteID: checkout.ID, URL: checkoutURL}, nil
}

func (client *HostedPaymentClient) verifyCreem(body []byte, headers http.Header) (*HostedPaymentEvent, error) {
	signature, err := hex.DecodeString(headers.Get("creem-signature"))
	if err != nil || len(signature) != sha256.Size || client.Config.WebhookSecret == "" {
		return nil, errors.New("invalid payment signature")
	}
	mac := hmac.New(sha256.New, []byte(client.Config.WebhookSecret))
	mac.Write(body)
	if !hostedEqualSignature(mac.Sum(nil), signature) {
		return nil, errors.New("invalid payment signature")
	}
	var event struct {
		EventType string              `json:"eventType"`
		Object    hostedCreemCheckout `json:"object"`
	}
	if common.Unmarshal(body, &event) != nil {
		return nil, errors.New("invalid payment notification")
	}
	if event.EventType != "checkout.completed" {
		return nil, nil
	}
	if !client.creemModeMatches(event.Object.Mode) || event.Object.RequestID == "" || !strings.HasPrefix(event.Object.ID, "chk_") {
		return nil, errors.New("Creem environment or order mismatch")
	}
	return &HostedPaymentEvent{Reference: event.Object.RequestID, RemoteID: event.Object.ID, ExpectsPaid: true}, nil
}

func (client *HostedPaymentClient) queryCreem(ctx context.Context, order *model.HostedPayment, remoteID string) (*HostedPaymentResult, error) {
	if !strings.HasPrefix(remoteID, "chk_") || strings.ContainsAny(remoteID, "/?#") {
		return nil, errors.New("invalid Creem checkout ID")
	}
	var result hostedCreemCheckout
	if err := client.creemAPI(ctx, http.MethodGet, "/v1/checkouts?checkout_id="+url.QueryEscape(remoteID), nil, &result); err != nil {
		return nil, err
	}
	minor, err := HostedMinorAmount(order.Amount)
	if err != nil || result.ID != remoteID || result.RequestID != order.TradeNo || !client.creemModeMatches(result.Mode) ||
		result.CustomPrice != minor || result.Units != 1 || result.Metadata["user_id"] != order.CustomerID ||
		(len(result.Subscription) > 0 && string(result.Subscription) != "null") {
		return nil, errors.New("Creem checkout does not match immutable quote")
	}
	productID := ""
	if len(result.Product) > 0 && result.Product[0] == '"' {
		if err := common.Unmarshal(result.Product, &productID); err != nil {
			return nil, errors.New("invalid Creem product")
		}
	} else {
		var product hostedCreemProduct
		if err := common.Unmarshal(result.Product, &product); err != nil {
			return nil, errors.New("invalid Creem product")
		}
		productID = product.ID
	}
	if productID != order.ProductID || !slices.Contains([]string{"pending", "processing", "completed", "expired"}, result.Status) {
		return nil, errors.New("Creem product or status mismatch")
	}
	paid := result.Status == "completed" && result.Order.Status == "paid"
	if paid && (result.Order.ID == "" || result.Order.Product != order.ProductID || !client.creemModeMatches(result.Order.Mode) ||
		result.Order.Currency != order.Currency || result.Order.Type != "onetime" || result.Order.Amount != minor ||
		result.Order.AmountDue != minor || result.Order.AmountPaid != minor || result.Order.DiscountAmount != 0) {
		return nil, errors.New("Creem paid amount, product or environment mismatch")
	}
	return &HostedPaymentResult{Reference: result.RequestID, RemoteID: result.ID, PaymentID: result.Order.ID,
		Amount: order.Amount, Currency: order.Currency, Paid: paid}, nil
}
