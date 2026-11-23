package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/stretchr/testify/require"
)

type hostedTestTransport func(*http.Request) (*http.Response, error)

func (transport hostedTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return transport(req)
}

func hostedTestResponse(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}
}

func TestHostedLianLianSignsRequestsAndChecksResponseBeforeOpeningCheckout(t *testing.T) {
	secret := strings.Repeat("k", 32)
	cfg := setting.DefaultHostedPaymentConfig("lianlian")
	cfg.APISecret = base64.StdEncoding.EncodeToString([]byte(secret))
	cfg.APIKey = "fixture-api-key"
	cfg.CheckoutHosts = []string{"checkout.example.com"}
	client := NewHostedPaymentClient("lianlian", cfg)
	validSignature := true
	client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
		require.Equal(t, "api-test.lianlianpay.com", req.URL.Host)
		require.Equal(t, "/api/v1/acquiring/payments/apply", req.URL.Path)
		require.Equal(t, "HP-fixture", req.Header.Get("Idempotency-Key"))
		raw, err := io.ReadAll(req.Body)
		require.NoError(t, err)
		mac := hmac.New(sha256.New, []byte(secret))
		fmt.Fprintf(mac, "%s\n%s\n%s", req.Header.Get("LL-Timestamp"), req.Header.Get("LL-Nonce"), raw)
		require.Equal(t, base64.StdEncoding.EncodeToString(mac.Sum(nil)), req.Header.Get("LL-Signature"))
		var request map[string]any
		require.NoError(t, common.Unmarshal(raw, &request))
		require.Equal(t, "CHECKOUT", request["integration_mode"])
		require.NotContains(t, request, "notify_url")
		response := hostedTestResponse(`{"pay_order_no":"PAY-fixture","merchant_order_no":"HP-fixture","amount":"10.00","currency":"USD","gateway_url":"https://checkout.example.com/pay"}`)
		response.Header.Set("LL-Signature-Type", "HMAC-SHA256")
		mac = hmac.New(sha256.New, []byte(secret))
		fmt.Fprint(mac, `{"pay_order_no":"PAY-fixture","merchant_order_no":"HP-fixture","amount":"10.00","currency":"USD","gateway_url":"https://checkout.example.com/pay"}`)
		if validSignature {
			response.Header.Set("LL-Signature", base64.StdEncoding.EncodeToString(mac.Sum(nil)))
		}
		return response, nil
	})
	order := &model.HostedPayment{TradeNo: "HP-fixture", Amount: "10.00", Currency: "USD"}
	checkout, err := client.Create(context.Background(), order, "https://ru.example.com/wallet", "https://ru.example.com/webhook")
	require.NoError(t, err)
	require.Equal(t, "PAY-fixture", checkout.RemoteID)
	validSignature = false
	_, err = client.Create(context.Background(), order, "https://ru.example.com/wallet", "https://ru.example.com/webhook")
	require.EqualError(t, err, "invalid LianLian response signature")
}

func TestHostedLianLianWebhookRejectsReplayWrongMerchantAndAuditEvents(t *testing.T) {
	cfg := setting.DefaultHostedPaymentConfig("lianlian")
	cfg.WebhookSecret, cfg.UserID, cfg.StoreID, cfg.DeveloperUserID = "whsec_fixture", "merchant", "store", "developer"
	client := NewHostedPaymentClient("lianlian", cfg)
	for _, test := range []struct {
		name, event, merchant string
		age                   time.Duration
		wantError, ignored    bool
	}{
		{name: "valid", event: "acquiring.payment.succeeded", merchant: "merchant"},
		{name: "expired", event: "acquiring.payment.succeeded", merchant: "merchant", age: -6 * time.Minute, wantError: true},
		{name: "wrong merchant", event: "acquiring.payment.succeeded", merchant: "other", wantError: true},
		{name: "audit", event: "documents.audit.succeeded", merchant: "merchant", ignored: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := []byte(fmt.Sprintf(`{"event_type":%q,"developer_user_id":"developer","data":{"user_id":%q,"store_id":"store","merchant_order_no":"HP-fixture","pay_order_no":"PAY-fixture"}}`, test.event, test.merchant))
			headers := http.Header{}
			headers.Set("LL-Timestamp", fmt.Sprint(time.Now().Add(test.age).UnixMilli()))
			headers.Set("LL-Event-Id", "evt_fixture")
			headers.Set("LL-Signature-Type", "HMAC-SHA256")
			mac := hmac.New(sha256.New, []byte(cfg.WebhookSecret))
			fmt.Fprintf(mac, "%s\nevt_fixture\n%s", headers.Get("LL-Timestamp"), body)
			headers.Set("LL-Signature", base64.StdEncoding.EncodeToString(mac.Sum(nil)))
			event, err := client.VerifyWebhook(context.Background(), body, headers)
			if test.wantError {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
				if test.ignored {
					require.Nil(t, event)
				} else {
					require.Equal(t, "HP-fixture", event.Reference)
				}
			}
		})
	}
}

func TestHostedNOWPaymentsUsesPaymentIDAndRequiresFinishedFullPayment(t *testing.T) {
	client := NewHostedPaymentClient("nowpayments", setting.DefaultHostedPaymentConfig("nowpayments"))
	for _, test := range []struct {
		status, paid string
		credited     bool
	}{
		{"finished", "1.00000000", true}, {"finished", "0.99", false}, {"confirmed", "1", false}, {"sending", "1", false}, {"partially_paid", "0.5", false},
	} {
		t.Run(test.status+test.paid, func(t *testing.T) {
			client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
				require.Equal(t, "/v1/payment/123", req.URL.Path)
				return hostedTestResponse(fmt.Sprintf(`{"payment_id":123,"invoice_id":456,"order_id":"HP-fixture","price_amount":10,"price_currency":"usd","pay_amount":1,"actually_paid":%s,"payment_status":%q}`, test.paid, test.status)), nil
			})
			result, err := client.Query(context.Background(), &model.HostedPayment{RemoteID: "456"}, "456", "123")
			require.NoError(t, err)
			require.Equal(t, test.credited, result.Paid)
			require.Equal(t, "456", result.RemoteID)
		})
	}
	_, err := client.Query(context.Background(), &model.HostedPayment{RemoteID: "456"}, "456", "")
	require.ErrorContains(t, err, "invoice ID is not a payment ID")
}

func TestHostedNOWPaymentsIPNSignatureUsesCanonicalJSON(t *testing.T) {
	client := NewHostedPaymentClient("nowpayments", setting.HostedPaymentConfig{WebhookSecret: "fixture-ipn-secret"})
	// Fixed canonical vector follows JSON.stringify, including decimal normalization.
	body := []byte(`{"price_amount":10.00,"payment_id":123,"order_id":"HP-fixture","extra":{"z":1.0,"a":0.00000001,"text":"<>&Тест"}}`)
	canonical := `{"extra":{"a":1e-8,"text":"<>&Тест","z":1},"order_id":"HP-fixture","payment_id":123,"price_amount":10}`
	mac := hmac.New(sha512.New, []byte(client.Config.WebhookSecret))
	mac.Write([]byte(canonical))
	headers := http.Header{}
	headers.Set("x-nowpayments-sig", hex.EncodeToString(mac.Sum(nil)))
	event, err := client.VerifyWebhook(context.Background(), body, headers)
	require.NoError(t, err)
	require.Equal(t, "123", event.PaymentID)
	_, err = client.VerifyWebhook(context.Background(), append(body[:len(body)-1], []byte(`,"tampered":true}`)...), headers)
	require.Error(t, err)
}

func TestHostedPayPalQueriesMerchantBeforeIdempotentCapture(t *testing.T) {
	cfg := setting.DefaultHostedPaymentConfig("paypal")
	cfg.MerchantID = "merchant"
	client := NewHostedPaymentClient("paypal", cfg)
	order := &model.HostedPayment{TradeNo: "HP-fixture", RemoteID: "ORDER123", Currency: "USD", Amount: "10.00"}
	for _, merchant := range []string{"merchant", "wrong-merchant"} {
		t.Run(merchant, func(t *testing.T) {
			captured := false
			client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
				if req.URL.Path == "/v1/oauth2/token" {
					return hostedTestResponse(`{"access_token":"fixture-access-token"}`), nil
				}
				if strings.HasSuffix(req.URL.Path, "/capture") {
					require.Equal(t, "HP-fixture-cap", req.Header.Get("PayPal-Request-Id"))
					captured = true
					return hostedTestResponse(`{}`), nil
				}
				status, payments := "APPROVED", ""
				if captured {
					status, payments = "COMPLETED", `,"payments":{"captures":[{"status":"COMPLETED","amount":{"currency_code":"USD","value":"10.00"}}]}`
				}
				return hostedTestResponse(fmt.Sprintf(`{"id":"ORDER123","status":%q,"purchase_units":[{"reference_id":"HP-fixture","custom_id":"HP-fixture","payee":{"merchant_id":%q},"amount":{"currency_code":"USD","value":"10.00"}%s}]}`, status, merchant, payments)), nil
			})
			result, err := client.Query(context.Background(), order, order.RemoteID, "")
			if merchant != cfg.MerchantID {
				require.Error(t, err)
				require.False(t, captured)
			} else {
				require.NoError(t, err)
				require.True(t, result.Paid)
			}
		})
	}
}
