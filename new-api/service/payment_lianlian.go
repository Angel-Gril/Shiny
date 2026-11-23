package service

import (
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/shopspring/decimal"
)

// Open Platform v1 CHECKOUT acquiring. Document-audit and payout notifications
// never authorize wallet credit.
type lianLianPayment struct {
	UserID          string `json:"user_id"`
	StoreID         string `json:"store_id"`
	PayOrderNo      string `json:"pay_order_no"`
	MerchantOrderNo string `json:"merchant_order_no"`
	PaymentStatus   string `json:"payment_status"`
	Amount          string `json:"amount"`
	Currency        string `json:"currency"`
	GatewayURL      string `json:"gateway_url"`
}

func (client *HostedPaymentClient) validateLianLianSignature(raw []byte, signature string, webhook bool) bool {
	decoded, err := base64.StdEncoding.DecodeString(signature)
	if err != nil || len(decoded) == 0 {
		return false
	}
	if client.Config.SignatureType == "RSA" {
		key, err := hostedRSAPublicKey(client.Config.PlatformPublicKey)
		digest := sha256.Sum256(raw)
		return err == nil && rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], decoded) == nil
	}
	secret := []byte(client.Config.WebhookSecret)
	if !webhook {
		secret, err = base64.StdEncoding.DecodeString(client.Config.APISecret)
		if err != nil || len(secret) < 32 {
			return false
		}
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(raw)
	return hostedEqualSignature(mac.Sum(nil), decoded)
}

func (client *HostedPaymentClient) lianLianAPI(ctx context.Context, path string, body any, requestID string, result any) error {
	var raw []byte
	var err error
	method := http.MethodGet
	if body != nil {
		raw, err = common.Marshal(body)
		if err != nil {
			return err
		}
		method = http.MethodPost
	}
	timestamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
	nonceBytes := make([]byte, 24)
	if _, err := rand.Read(nonceBytes); err != nil {
		return err
	}
	nonce := base64.RawURLEncoding.EncodeToString(nonceBytes)
	content := []byte(timestamp + "\n" + nonce + "\n" + string(raw))
	var signature []byte
	if client.Config.SignatureType == "RSA" {
		key, keyErr := hostedRSAPrivateKey(client.Config.PrivateKey)
		if keyErr != nil {
			return keyErr
		}
		digest := sha256.Sum256(content)
		signature, err = rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
		if err != nil {
			return err
		}
	} else {
		secret, err := base64.StdEncoding.DecodeString(client.Config.APISecret)
		if err != nil || len(secret) < 32 {
			return errors.New("invalid LianLian API secret")
		}
		mac := hmac.New(sha256.New, secret)
		mac.Write(content)
		signature = mac.Sum(nil)
	}
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+client.Config.APIKey)
	headers.Set("Content-Type", "application/json")
	headers.Set("LL-Timestamp", timestamp)
	headers.Set("LL-Nonce", nonce)
	headers.Set("LL-Signature-Type", client.Config.SignatureType)
	headers.Set("LL-Signature", base64.StdEncoding.EncodeToString(signature))
	if client.Config.OnBehalfOf != "" {
		headers.Set("LL-On-Behalf-Of", client.Config.OnBehalfOf)
	}
	if requestID != "" {
		headers.Set("Idempotency-Key", requestID)
	}
	base := "https://api.lianlianpay.com"
	if client.Config.Environment == "test" {
		base = "https://api-test.lianlianpay.com"
	}
	response, responseHeaders, status, err := client.request(ctx, method, base+path, raw, headers)
	if err != nil {
		return err
	}
	if responseHeaders.Get("LL-Signature-Type") != client.Config.SignatureType ||
		!client.validateLianLianSignature(response, responseHeaders.Get("LL-Signature"), false) {
		return errors.New("invalid LianLian response signature")
	}
	return hostedDecodeResponse(response, status, result)
}

func (client *HostedPaymentClient) createLianLian(ctx context.Context, order *model.HostedPayment, returnURL string) (*HostedCheckout, error) {
	cfg := client.Config
	body := map[string]any{
		"store_id": cfg.StoreID, "merchant_order_no": order.TradeNo,
		"amount": order.Amount, "currency": order.Currency, "country_code": cfg.CountryCode,
		"txn_type": "PAYMENT", "integration_mode": "CHECKOUT", "pay_expire": 30,
		"return_url": returnURL, "cancel_url": returnURL,
		"order_info": map[string]any{
			"order_desc": "Shiny API credit", "order_time": order.CreatedAt,
			"goods_info": []map[string]any{{
				"product_id": "api-credit", "goods_name": "Shiny API credit", "sku": "api-credit",
				"price": order.Amount, "quantity": 1, "goods_url": cfg.GoodsURL, "shipping_provider": cfg.ShippingProvider,
			}},
		},
	}
	var result lianLianPayment
	if err := client.lianLianAPI(ctx, "/api/v1/acquiring/payments/apply", body, order.TradeNo, &result); err != nil {
		return nil, err
	}
	expected, _ := decimal.NewFromString(order.Amount)
	actual, err := decimal.NewFromString(result.Amount)
	if err != nil || !actual.Equal(expected) || result.Currency != order.Currency || result.MerchantOrderNo != order.TradeNo || result.PayOrderNo == "" {
		return nil, errors.New("LianLian invoice does not match order")
	}
	checkoutURL, err := setting.HostedCheckoutURL(result.GatewayURL, cfg.CheckoutHosts)
	if err != nil {
		return nil, err
	}
	return &HostedCheckout{RemoteID: result.PayOrderNo, URL: checkoutURL}, nil
}

func (client *HostedPaymentClient) verifyLianLian(body []byte, headers http.Header) (*HostedPaymentEvent, error) {
	timestamp := headers.Get("LL-Timestamp")
	millis, err := strconv.ParseInt(timestamp, 10, 64)
	now := time.Now().UnixMilli()
	if err != nil || len(timestamp) != 13 || millis < now-300000 || millis > now+300000 {
		return nil, errors.New("expired payment notification")
	}
	eventID := headers.Get("LL-Event-Id")
	if !regexp.MustCompile(`^evt_[A-Za-z0-9_-]{1,120}$`).MatchString(eventID) || headers.Get("LL-Signature-Type") != client.Config.SignatureType ||
		!client.validateLianLianSignature(append([]byte(timestamp+"\n"+eventID+"\n"), body...), headers.Get("LL-Signature"), true) {
		return nil, errors.New("invalid payment signature")
	}
	var event struct {
		EventType       string          `json:"event_type"`
		DeveloperUserID string          `json:"developer_user_id"`
		Data            lianLianPayment `json:"data"`
	}
	if err := common.Unmarshal(body, &event); err != nil {
		return nil, errors.New("invalid payment notification")
	}
	if event.EventType != "acquiring.payment.succeeded" {
		return nil, nil
	}
	if event.DeveloperUserID != client.Config.DeveloperUserID || event.Data.UserID != client.Config.UserID || event.Data.StoreID != client.Config.StoreID {
		return nil, errors.New("payment merchant mismatch")
	}
	return &HostedPaymentEvent{Reference: event.Data.MerchantOrderNo, RemoteID: event.Data.PayOrderNo}, nil
}

func (client *HostedPaymentClient) queryLianLian(ctx context.Context, remoteID string) (*HostedPaymentResult, error) {
	if remoteID == "" || len(remoteID) > 128 {
		return nil, errors.New("missing provider order ID")
	}
	var result lianLianPayment
	if err := client.lianLianAPI(ctx, "/api/v1/acquiring/payments/"+url.PathEscape(remoteID), nil, "", &result); err != nil {
		return nil, err
	}
	if result.PayOrderNo != remoteID || result.UserID != client.Config.UserID || result.StoreID != client.Config.StoreID {
		return nil, errors.New("payment merchant mismatch")
	}
	return &HostedPaymentResult{Reference: result.MerchantOrderNo, RemoteID: result.PayOrderNo,
		Amount: result.Amount, Currency: result.Currency, Paid: result.PaymentStatus == "SUCCESS"}, nil
}
