package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
)

type HostedPaymentClient struct {
	Provider string
	Config   setting.HostedPaymentConfig
	HTTP     *http.Client
}

type HostedCheckout struct {
	RemoteID string
	URL      string
}

// Customer facts are supplied by the authenticated request and never inferred
// from an order number or supplied by an untrusted checkout payload.
type HostedCheckoutOptions struct {
	ReturnURL  string
	WebhookURL string
	CustomerID string
	ClientIP   string
}

type HostedPaymentEvent struct {
	Reference string
	RemoteID  string
	PaymentID string
	// A successful notification must be retried if the authoritative query has
	// not caught up; acknowledging it early can leave a paid order uncredited.
	ExpectsPaid bool
}

type HostedPaymentResult struct {
	Reference string
	RemoteID  string
	PaymentID string
	Amount    string
	Currency  string
	Paid      bool
}

func NewHostedPaymentClient(provider string, cfg setting.HostedPaymentConfig) *HostedPaymentClient {
	return &HostedPaymentClient{Provider: provider, Config: cfg, HTTP: &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

func (client *HostedPaymentClient) Create(ctx context.Context, order *model.HostedPayment, options HostedCheckoutOptions) (*HostedCheckout, error) {
	switch client.Provider {
	case "cispay":
		return client.createCisPay(ctx, order, options)
	case "zpay":
		return client.createZPay(ctx, order, options)
	case "lianlian":
		return client.createLianLian(ctx, order, options.ReturnURL)
	case "nowpayments":
		return client.createNOWPayments(ctx, order, options.ReturnURL, options.WebhookURL)
	case "paypal":
		return client.createPayPal(ctx, order, options.ReturnURL)
	default:
		return nil, errors.New("unsupported payment provider")
	}
}

func (client *HostedPaymentClient) VerifyWebhook(ctx context.Context, body []byte, headers http.Header) (*HostedPaymentEvent, error) {
	switch client.Provider {
	case "cispay":
		return client.verifyCisPay(body, headers)
	case "zpay":
		return client.verifyZPay(body)
	case "lianlian":
		return client.verifyLianLian(body, headers)
	case "nowpayments":
		return client.verifyNOWPayments(body, headers)
	case "paypal":
		return client.verifyPayPal(ctx, body, headers)
	default:
		return nil, errors.New("unsupported payment provider")
	}
}

func (client *HostedPaymentClient) Query(ctx context.Context, order *model.HostedPayment, remoteID, paymentID string) (*HostedPaymentResult, error) {
	switch client.Provider {
	case "cispay":
		return client.queryCisPay(ctx, order, remoteID)
	case "zpay":
		return client.queryZPay(ctx, order, remoteID)
	case "lianlian":
		return client.queryLianLian(ctx, remoteID)
	case "nowpayments":
		return client.queryNOWPayments(ctx, paymentID)
	case "paypal":
		return client.queryPayPal(ctx, order)
	default:
		return nil, errors.New("unsupported payment provider")
	}
}

func (client *HostedPaymentClient) request(ctx context.Context, method, endpoint string, body []byte, headers http.Header) ([]byte, http.Header, int, error) {
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, nil, 0, errors.New("invalid payment request")
	}
	req.Header = headers
	response, err := client.HTTP.Do(req)
	if err != nil {
		return nil, nil, 0, errors.New("payment provider unavailable; check order before retrying")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
	if err != nil || len(raw) > 1024*1024 {
		return nil, nil, 0, errors.New("invalid payment provider response")
	}
	return raw, response.Header, response.StatusCode, nil
}

func hostedDecodeResponse(raw []byte, status int, result any) error {
	if status < 200 || status >= 300 {
		return errors.New("payment provider rejected request; check order before retrying")
	}
	if err := common.Unmarshal(raw, result); err != nil {
		return errors.New("invalid payment provider response")
	}
	return nil
}

func hostedEqualSignature(expected, signature []byte) bool {
	return len(signature) > 0 && hmac.Equal(expected, signature)
}

func hostedRSAPrivateKey(value string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(value))
	if block == nil {
		return nil, errors.New("invalid RSA private key")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err == nil {
		if rsaKey, ok := key.(*rsa.PrivateKey); ok && rsaKey.N.BitLen() >= 2048 {
			return rsaKey, nil
		}
	}
	rsaKey, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil || rsaKey.N.BitLen() < 2048 {
		return nil, errors.New("invalid RSA private key")
	}
	return rsaKey, nil
}

func hostedRSAPublicKey(value string) (*rsa.PublicKey, error) {
	block, _ := pem.Decode([]byte(value))
	if block == nil {
		return nil, errors.New("invalid RSA public key")
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err == nil {
		if rsaKey, ok := key.(*rsa.PublicKey); ok && rsaKey.N.BitLen() >= 2048 {
			return rsaKey, nil
		}
	}
	if certificate, err := x509.ParseCertificate(block.Bytes); err == nil {
		if rsaKey, ok := certificate.PublicKey.(*rsa.PublicKey); ok && rsaKey.N.BitLen() >= 2048 {
			return rsaKey, nil
		}
	}
	rsaKey, err := x509.ParsePKCS1PublicKey(block.Bytes)
	if err != nil || rsaKey.N.BitLen() < 2048 {
		return nil, errors.New("invalid RSA public key")
	}
	return rsaKey, nil
}

func ValidateHostedSigningKeys(cfg setting.HostedPaymentConfig) error {
	if cfg.SignatureType == "RSA" {
		if _, err := hostedRSAPrivateKey(cfg.PrivateKey); err != nil {
			return err
		}
		_, err := hostedRSAPublicKey(cfg.PlatformPublicKey)
		return err
	}
	secret, err := base64.StdEncoding.DecodeString(cfg.APISecret)
	if err != nil || len(secret) < 32 || cfg.WebhookSecret == "" {
		return errors.New("invalid LianLian signing secrets")
	}
	return nil
}
