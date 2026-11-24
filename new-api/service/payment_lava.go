package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

func (client *HostedPaymentClient) lavaAPI(ctx context.Context, method, path string, body any, result any) error {
	var raw []byte
	var err error
	if body != nil {
		raw, err = common.Marshal(body)
		if err != nil {
			return err
		}
	}
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	headers.Set("X-Api-Key", client.Config.APIKey)
	response, _, status, err := client.request(ctx, method, "https://gate.lava.top"+path, raw, headers)
	if err != nil {
		return err
	}
	return hostedDecodeResponse(response, status, result)
}

func (client *HostedPaymentClient) createLava(ctx context.Context, order *model.HostedPayment, options HostedCheckoutOptions) (*HostedCheckout, error) {
	if client.Config.Environment != "live" || order.ProductID == "" || options.CustomerEmail == "" {
		return nil, errors.New("invalid Lava.top offer, customer or environment")
	}
	body := map[string]any{
		"email": options.CustomerEmail, "offerId": order.ProductID, "currency": order.Currency, "amount": common.RawMessage(order.Amount),
		"successful_return_url": options.ReturnURL, "failure_return_url": options.ReturnURL, "cancel_return_url": options.ReturnURL,
	}
	if client.Config.PaymentMethod != "" {
		body["paymentProvider"] = client.Config.PaymentMethod
	}
	var result struct {
		ID     string `json:"id"`
		URL    string `json:"paymentUrl"`
		Amount struct {
			Currency string          `json:"currency"`
			Amount   decimal.Decimal `json:"amount"`
		} `json:"amountTotal"`
	}
	if err := client.lavaAPI(ctx, http.MethodPost, "/api/v3/invoice", body, &result); err != nil {
		return nil, err
	}
	expected, _ := decimal.NewFromString(order.Amount)
	if uuid.Validate(result.ID) != nil || result.Amount.Currency != order.Currency || !result.Amount.Amount.Equal(expected) {
		return nil, errors.New("Lava.top invoice does not match quote")
	}
	checkoutURL, err := setting.HostedCheckoutURL(result.URL, client.Config.CheckoutHosts)
	if err != nil {
		return nil, err
	}
	return &HostedCheckout{RemoteID: result.ID, URL: checkoutURL}, nil
}

func (client *HostedPaymentClient) verifyLava(body []byte, headers http.Header) (*HostedPaymentEvent, error) {
	// This is our separately generated webhook service key, not the outbound
	// Lava.top API key. The official header-key mode does not use body HMAC.
	if client.Config.WebhookSecret == "" || !hostedEqualSignature([]byte(client.Config.WebhookSecret), []byte(headers.Get("X-Api-Key"))) {
		return nil, errors.New("invalid payment callback credentials")
	}
	var event struct {
		Type     string `json:"eventType"`
		ID       string `json:"contractId"`
		ParentID string `json:"parentContractId"`
	}
	if common.Unmarshal(body, &event) != nil {
		return nil, errors.New("invalid payment notification")
	}
	if event.Type != "payment.success" || event.ParentID != "" {
		return nil, nil
	}
	if uuid.Validate(event.ID) != nil {
		return nil, errors.New("invalid Lava.top invoice ID")
	}
	return &HostedPaymentEvent{RemoteID: event.ID, ExpectsPaid: true}, nil
}

func (client *HostedPaymentClient) queryLava(ctx context.Context, order *model.HostedPayment, remoteID string) (*HostedPaymentResult, error) {
	if client.Config.Environment != "live" || uuid.Validate(remoteID) != nil {
		return nil, errors.New("invalid Lava.top invoice ID or environment")
	}
	var result struct {
		ID       string `json:"id"`
		Type     string `json:"type"`
		Status   string `json:"status"`
		ParentID any    `json:"parentInvoice"`
		Receipt  struct {
			Amount   decimal.Decimal `json:"amount"`
			Currency string          `json:"currency"`
		} `json:"receipt"`
		Product struct {
			Offer string `json:"offer"`
		} `json:"product"`
		Buyer struct {
			Email string `json:"email"`
		} `json:"buyer"`
	}
	if err := client.lavaAPI(ctx, http.MethodGet, "/api/v1/invoices/"+url.PathEscape(remoteID), nil, &result); err != nil {
		return nil, err
	}
	buyerHash := sha256.Sum256([]byte(strings.ToLower(result.Buyer.Email)))
	if result.ID != remoteID || result.Type != "ONE_TIME" || result.ParentID != nil || result.Product.Offer != order.ProductID ||
		order.CustomerHash == "" || hex.EncodeToString(buyerHash[:]) != order.CustomerHash {
		return nil, errors.New("Lava.top invoice product or buyer mismatch")
	}
	// The V3 API documents no merchant order reference. A saved invoice binding
	// is required; on a lost create response, an operator supplies the invoice
	// ID and recovery checks product, buyer hash and exact receipt before credit.
	return &HostedPaymentResult{Reference: order.TradeNo, RemoteID: result.ID, Amount: result.Receipt.Amount.String(),
		Currency: result.Receipt.Currency, Paid: result.Status == "completed"}, nil
}
