package service

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/shopspring/decimal"
	pancake "github.com/waffo-com/waffo-pancake-sdk-go"
)

func ValidateHostedPancakeKeys(cfg setting.HostedPaymentConfig) error {
	if _, err := hostedRSAPrivateKey(cfg.PrivateKey); err != nil {
		return err
	}
	if cfg.PlatformPublicKey != "" {
		_, err := hostedRSAPublicKey(cfg.PlatformPublicKey)
		return err
	}
	return nil
}

// Manual signing follows the official canonical request specification. The
// installed SDK predates taxIncluded/language; its verifier remains reusable.
func (client *HostedPaymentClient) pancakeAPI(ctx context.Context, path string, body any, result any) error {
	raw, err := common.Marshal(body)
	if err != nil {
		return err
	}
	key, err := hostedRSAPrivateKey(client.Config.PrivateKey)
	if err != nil {
		return err
	}
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	bodyDigest := sha256.Sum256(raw)
	canonical := "POST\n" + path + "\n" + timestamp + "\n" + base64.StdEncoding.EncodeToString(bodyDigest[:])
	digest := sha256.Sum256([]byte(canonical))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return err
	}
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	headers.Set("X-Merchant-Id", client.Config.MerchantID)
	headers.Set("X-Timestamp", timestamp)
	headers.Set("X-Signature", base64.StdEncoding.EncodeToString(signature))
	environment := "prod"
	if client.Config.Environment == "test" {
		environment = "test"
	}
	// Checkout buyer tokens choose the environment with this header; the
	// merchant signing key itself is also bound to its issued environment.
	headers.Set("X-Environment", environment)
	if path != "/v1/graphql" {
		idempotency := sha256.Sum256([]byte(client.Config.MerchantID + ":" + path + ":" + string(raw)))
		headers.Set("X-Idempotency-Key", hex.EncodeToString(idempotency[:]))
	}
	response, _, status, err := client.request(ctx, http.MethodPost, "https://api.waffo.ai"+path, raw, headers)
	if err != nil {
		return err
	}
	var envelope struct {
		Data   common.RawMessage   `json:"data"`
		Errors []common.RawMessage `json:"errors"`
	}
	if err := hostedDecodeResponse(response, status, &envelope); err != nil {
		return err
	}
	if len(envelope.Errors) > 0 || len(envelope.Data) == 0 || string(envelope.Data) == "null" {
		return errors.New("Waffo Pancake rejected the request")
	}
	return common.Unmarshal(envelope.Data, result)
}

func (client *HostedPaymentClient) createPancake(ctx context.Context, order *model.HostedPayment, options HostedCheckoutOptions) (*HostedCheckout, error) {
	if order.CustomerID == "" || order.ProductID == "" {
		return nil, errors.New("Waffo Pancake requires an authenticated buyer and one-time product")
	}
	var session struct {
		ID  string `json:"sessionId"`
		URL string `json:"checkoutUrl"`
	}
	body := map[string]any{
		"productId": order.ProductID, "currency": order.Currency, "buyerEmail": options.CustomerEmail,
		"successUrl": options.ReturnURL, "orderMerchantExternalId": order.TradeNo, "expiresInSeconds": 1800,
		"priceSnapshot": map[string]any{"amount": order.Amount, "taxIncluded": true, "taxCategory": client.Config.TaxCategory},
		"language":      "ru-RU", "allowPromotionCodes": false, "metadata": map[string]string{"user_id": order.CustomerID},
	}
	if err := client.pancakeAPI(ctx, "/v1/actions/checkout/create-session", body, &session); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(session.ID, "cs_") || !strings.HasSuffix(session.URL, "/"+session.ID) {
		return nil, errors.New("invalid Waffo Pancake checkout session")
	}
	checkoutURL, err := setting.HostedCheckoutURL(session.URL, []string{"checkout.waffo.ai", "pancake.waffo.ai"})
	if err != nil {
		return nil, err
	}
	var token struct {
		Token string `json:"token"`
	}
	if err := client.pancakeAPI(ctx, "/v1/actions/auth/issue-session-token", map[string]string{
		"productId": order.ProductID, "buyerIdentity": order.CustomerID,
	}, &token); err != nil {
		return nil, err
	}
	if token.Token == "" || len(token.Token) > 8192 || strings.ContainsAny(token.Token, "\r\n") {
		return nil, errors.New("invalid Waffo Pancake buyer session")
	}
	u, _ := url.Parse(checkoutURL)
	if client.Config.Environment == "test" {
		query := u.Query()
		query.Set("test", "true")
		u.RawQuery = query.Encode()
	}
	u.Fragment = "token=" + token.Token
	// A checkout session is not an ORD_* order. The callback or GraphQL query
	// binds RemoteID later, independently of this non-secret session ID.
	return &HostedCheckout{SessionID: session.ID, URL: u.String()}, nil
}

func (client *HostedPaymentClient) verifyPancake(body []byte, headers http.Header) (*HostedPaymentEvent, error) {
	environment := pancake.EnvironmentProd
	if client.Config.Environment == "test" {
		environment = pancake.EnvironmentTest
	}
	// Retries replay the original header; the last scheduled attempt can arrive
	// after 31 minutes. The current docs require 45 minutes, unlike this SDK's
	// older 5-minute default. Wallet credit remains atomic and once per invoice.
	options := &pancake.VerifyWebhookOptions{Environment: environment, PublicKey: client.Config.PlatformPublicKey,
		ToleranceMS: (45 * time.Minute).Milliseconds()}
	raw, err := pancake.VerifyWebhook(string(body), headers.Get("X-Waffo-Signature"), options)
	if err != nil {
		return nil, errors.New("invalid payment signature")
	}
	if raw.Mode != environment || raw.StoreID != client.Config.StoreID {
		return nil, errors.New("Waffo Pancake merchant or environment mismatch")
	}
	if raw.EventType != "order.completed" {
		return nil, nil
	}
	var data struct {
		OrderID       string `json:"orderId"`
		Reference     string `json:"orderMerchantExternalId"`
		CustomerID    string `json:"merchantProvidedBuyerIdentity"`
		PaymentID     string `json:"paymentId"`
		PaymentStatus string `json:"paymentStatus"`
	}
	if common.Unmarshal(raw.Data, &data) != nil || data.Reference == "" || !strings.HasPrefix(data.OrderID, "ORD_") ||
		data.CustomerID == "" || !strings.HasPrefix(data.PaymentID, "PAY_") || data.PaymentStatus != "succeeded" {
		return nil, errors.New("invalid Waffo Pancake completed order")
	}
	return &HostedPaymentEvent{Reference: data.Reference, RemoteID: data.OrderID, PaymentID: data.PaymentID,
		CustomerID: data.CustomerID, ExpectsPaid: true}, nil
}

func (client *HostedPaymentClient) queryPancake(ctx context.Context, order *model.HostedPayment, remoteID, paymentID string) (*HostedPaymentResult, error) {
	if remoteID != "" && (!strings.HasPrefix(remoteID, "ORD_") || strings.ContainsAny(remoteID, "/?#")) {
		return nil, errors.New("use the Waffo Pancake order ID, not its checkout session ID")
	}
	var result struct {
		Orders []struct {
			ID        string            `json:"id"`
			Reference string            `json:"orderMerchantExternalId"`
			Currency  string            `json:"currency"`
			Status    string            `json:"status"`
			TestMode  *bool             `json:"testMode"`
			Metadata  map[string]string `json:"metadata"`
			Price     struct {
				Currency string          `json:"currency"`
				Total    decimal.Decimal `json:"total"`
			} `json:"priceSnapshot"`
			Product struct {
				ID string `json:"id"`
			} `json:"onetimeProduct"`
			Payments []struct {
				ID           string `json:"id"`
				Status       string `json:"status"`
				RefundStatus string `json:"refundStatus"`
				Price        struct {
					Currency string          `json:"currency"`
					Total    decimal.Decimal `json:"total"`
					Discount decimal.Decimal `json:"discountAmount"`
				} `json:"snapshotAmountDetails"`
				Refunds []struct {
					Status string `json:"status"`
				} `json:"refunds"`
			} `json:"payments"`
		} `json:"onetimeOrders"`
	}
	query := `query($storeId: String!, $ref: String!) {
		onetimeOrders(storeId: $storeId, filter: { orderMerchantExternalId: { eq: $ref } }, limit: 2) {
			id orderMerchantExternalId currency status testMode metadata
			priceSnapshot { currency total } onetimeProduct { id }
			payments { id status refundStatus snapshotAmountDetails { currency total discountAmount } refunds { status } }
		}
	}`
	if err := client.pancakeAPI(ctx, "/v1/graphql", map[string]any{"query": query,
		"variables": map[string]string{"storeId": client.Config.StoreID, "ref": order.TradeNo}}, &result); err != nil {
		return nil, err
	}
	if len(result.Orders) != 1 {
		return nil, errors.New("Waffo Pancake order not yet found or ambiguous")
	}
	row := result.Orders[0]
	expected, _ := decimal.NewFromString(order.Amount)
	if !strings.HasPrefix(row.ID, "ORD_") || (remoteID != "" && row.ID != remoteID) || row.Reference != order.TradeNo ||
		row.Product.ID != order.ProductID || row.Metadata["user_id"] != order.CustomerID || row.Currency != order.Currency ||
		row.TestMode == nil || *row.TestMode != (client.Config.Environment == "test") || row.Price.Currency != order.Currency ||
		!row.Price.Total.Equal(expected) || !slices.Contains([]string{"pending", "completed", "canceled"}, row.Status) {
		return nil, errors.New("Waffo Pancake order does not match immutable quote")
	}
	paidID := ""
	for _, payment := range row.Payments {
		if payment.Status != "succeeded" {
			continue
		}
		if !strings.HasPrefix(payment.ID, "PAY_") || payment.Price.Currency != order.Currency || !payment.Price.Total.Equal(expected) ||
			!payment.Price.Discount.IsZero() || !slices.Contains([]string{"", "none"}, payment.RefundStatus) || paidID != "" {
			return nil, errors.New("Waffo Pancake payment amount or refund mismatch")
		}
		for _, refund := range payment.Refunds {
			if refund.Status == "succeeded" {
				return nil, errors.New("Waffo Pancake payment has been refunded")
			}
		}
		paidID = payment.ID
	}
	if paymentID != "" && paidID != "" && paidID != paymentID {
		return nil, errors.New("Waffo Pancake payment ID mismatch")
	}
	return &HostedPaymentResult{Reference: row.Reference, RemoteID: row.ID, PaymentID: paidID,
		Amount: row.Price.Total.StringFixed(2), Currency: row.Currency, Paid: row.Status == "completed" && paidID != ""}, nil
}
