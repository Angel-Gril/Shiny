package service

import (
	"bytes"
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/require"
)

type hostedTestTransport func(*http.Request) (*http.Response, error)

func (transport hostedTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return transport(req)
}

func hostedTestResponse(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}
}

func TestHostedCisPayUsesShopHeadersAndChecksInvoiceAndWebhook(t *testing.T) {
	cfg := setting.DefaultHostedPaymentConfig("cispay")
	cfg.Environment = "live"
	cfg.StoreID, cfg.APIKey = "shop-fixture", "cis_sec_fixture-key"
	cfg.CheckoutHosts, cfg.PaymentMethod = []string{"checkout.cispay.app"}, "SBP"
	client := NewHostedPaymentClient("cispay", cfg)
	client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
		require.Equal(t, "https://api.cispay.app", req.URL.Scheme+"://"+req.URL.Host)
		require.Equal(t, "/payments", req.URL.Path)
		require.Equal(t, cfg.StoreID, req.Header.Get("X-Shop-ID"))
		require.Equal(t, cfg.APIKey, req.Header.Get("X-Api-Key"))
		var request map[string]any
		require.NoError(t, common.DecodeJson(req.Body, &request))
		require.Equal(t, float64(1050), request["amount"])
		require.Equal(t, "RUB", request["currency"])
		require.Equal(t, "HP-fixture", request["order_id"])
		require.Equal(t, "SBP", request["payment_method"])
		require.Equal(t, "user-123", request["customer_id"])
		return hostedTestResponse(`{"id":"019ad028-2100-7000-8000-000000000002","order_id":"HP-fixture","status":"PENDING","amount":1050,"charged_amount":1092,"payment_url":"https://checkout.cispay.app/pay/123"}`), nil
	})
	checkout, err := client.Create(context.Background(), &model.HostedPayment{
		TradeNo: "HP-fixture", Amount: "10.50", Currency: "RUB",
	}, HostedCheckoutOptions{ReturnURL: "https://ru.example.com/wallet", CustomerID: "user-123"})
	require.NoError(t, err)
	require.Equal(t, "019ad028-2100-7000-8000-000000000002", checkout.RemoteID)
	require.Equal(t, "https://checkout.cispay.app/pay/123", checkout.URL)

	body := []byte(`{"id":"019ad028-2100-7000-8000-000000000002","store_id":"shop-fixture","order_id":"HP-fixture","payment_method":"SBP","status":"PAID","amount":1050,"charged_amount":1092,"currency":"RUB","is_sandbox":false}`)
	mac := hmac.New(sha256.New, []byte(cfg.APIKey))
	mac.Write(body)
	headers := http.Header{}
	headers.Set("X-Signature", hex.EncodeToString(mac.Sum(nil)))
	event, err := client.VerifyWebhook(context.Background(), body, headers)
	require.NoError(t, err)
	require.Equal(t, "HP-fixture", event.Reference)
	require.Equal(t, "019ad028-2100-7000-8000-000000000002", event.RemoteID)
	_, err = client.VerifyWebhook(context.Background(), append(body[:len(body)-1], []byte(`,"tampered":true}`)...), headers)
	require.ErrorContains(t, err, "invalid payment signature")
	headers.Set("X-Signature", hex.EncodeToString(make([]byte, sha256.Size)))
	_, err = client.VerifyWebhook(context.Background(), body, headers)
	require.ErrorContains(t, err, "invalid payment signature")
	body = bytes.Replace(body, []byte(`"shop-fixture"`), []byte(`"other-shop"`), 1)
	mac = hmac.New(sha256.New, []byte(cfg.APIKey))
	mac.Write(body)
	headers.Set("X-Signature", hex.EncodeToString(mac.Sum(nil)))
	_, err = client.VerifyWebhook(context.Background(), body, headers)
	require.ErrorContains(t, err, "payment merchant mismatch")
}

func TestHostedCisPayQueriesByShinyOrderWhenRemoteIDIsUnknown(t *testing.T) {
	cfg := setting.DefaultHostedPaymentConfig("cispay")
	cfg.StoreID, cfg.APIKey = "shop-fixture", "cis_sec_fixture-key"
	cfg.Environment = "test"
	client := NewHostedPaymentClient("cispay", cfg)
	for _, test := range []struct {
		status, currency, amount string
		paid                     bool
	}{
		{"PAID", "RUB", "1050", true},
		{"PENDING", "RUB", "1050", false},
		{"EXPIRED", "RUB", "1050", false},
	} {
		t.Run(test.status, func(t *testing.T) {
			client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
				require.Equal(t, http.MethodGet, req.Method)
				require.Equal(t, "HP-fixture", req.URL.Query().Get("order_id"))
				require.Empty(t, req.URL.Query().Get("id"))
				return hostedTestResponse(fmt.Sprintf(`{"id":"019ad028-2100-7000-8000-000000000002","order_id":"HP-fixture","status":%q,"amount":%s,"currency":%q,"is_sandbox":true}`, test.status, test.amount, test.currency)), nil
			})
			result, err := client.Query(context.Background(), &model.HostedPayment{
				TradeNo: "HP-fixture", Amount: "10.50", Currency: "RUB",
			}, "", "")
			require.NoError(t, err)
			require.Equal(t, "10.50", result.Amount)
			require.Equal(t, "RUB", result.Currency)
			require.Equal(t, test.paid, result.Paid)
		})
	}
	client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
		return hostedTestResponse(`{"id":"019ad028-2100-7000-8000-000000000002","order_id":"HP-other","status":"PAID","amount":1050,"currency":"RUB","is_sandbox":true}`), nil
	})
	_, err := client.Query(context.Background(), &model.HostedPayment{
		TradeNo: "HP-fixture", Amount: "10.50", Currency: "RUB",
	}, "019ad028-2100-7000-8000-000000000002", "")
	require.ErrorContains(t, err, "order mismatch")
}

func TestHostedCisPayMapsOriginalRubQuoteForCryptoAndRejectsRealPaymentsInTest(t *testing.T) {
	cfg := setting.DefaultHostedPaymentConfig("cispay")
	cfg.Environment, cfg.StoreID, cfg.APIKey = "live", "shop-fixture", "cis_sec_fixture-key"
	cfg.CheckoutHosts, cfg.PaymentMethod = []string{"checkout.cispay.app"}, "CRYPTO"
	client := NewHostedPaymentClient("cispay", cfg)
	client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
		var request map[string]any
		require.NoError(t, common.DecodeJson(req.Body, &request))
		require.Equal(t, "RUB", request["currency"])
		return hostedTestResponse(`{"id":"019ad028-2100-7000-8000-000000000002","order_id":"HP-fixture","status":"PENDING","amount":146,"charged_amount":151,"source_amount":1050,"source_currency":"RUB","payment_url":"https://checkout.cispay.app/pay/123"}`), nil
	})
	checkout, err := client.Create(context.Background(), &model.HostedPayment{
		TradeNo: "HP-fixture", Amount: "10.50", Currency: "RUB",
	}, HostedCheckoutOptions{ReturnURL: "https://ru.example.com/wallet", CustomerID: "user-123"})
	require.NoError(t, err)
	require.Equal(t, "019ad028-2100-7000-8000-000000000002", checkout.RemoteID)

	client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
		return hostedTestResponse(`{"id":"019ad028-2100-7000-8000-000000000002","order_id":"HP-fixture","status":"PAID","amount":146,"currency":"USD","source_amount":1050,"source_currency":"RUB","is_sandbox":false,"payment_method":"CRYPTO"}`), nil
	})
	result, err := client.Query(context.Background(), &model.HostedPayment{
		TradeNo: "HP-fixture", Amount: "10.50", Currency: "RUB",
	}, "019ad028-2100-7000-8000-000000000002", "")
	require.NoError(t, err)
	require.True(t, result.Paid)
	require.Equal(t, "10.50", result.Amount)
	require.Equal(t, "RUB", result.Currency)
	client.Config.Environment = "test"
	_, err = client.Query(context.Background(), &model.HostedPayment{TradeNo: "HP-fixture", Amount: "10.50", Currency: "RUB"}, "", "")
	require.ErrorContains(t, err, "environment mismatch")
	_, err = client.Create(context.Background(), &model.HostedPayment{TradeNo: "HP-fixture", Amount: "10.50", Currency: "RUB"}, HostedCheckoutOptions{CustomerID: "user-123"})
	require.ErrorContains(t, err, "merchant dashboard")
}

func TestHostedCisPayQueryRejectsMismatchedAndUnsupportedPaymentFacts(t *testing.T) {
	cfg := setting.DefaultHostedPaymentConfig("cispay")
	client := NewHostedPaymentClient("cispay", cfg)
	order := &model.HostedPayment{TradeNo: "HP-fixture", Amount: "10.50", Currency: "RUB"}
	for _, test := range []struct{ name, extra string }{
		{"wrong amount", `"amount":1051,"currency":"RUB","is_sandbox":false`},
		{"empty currency", `"amount":1050,"currency":"","is_sandbox":false`},
		{"null sandbox", `"amount":1050,"currency":"RUB","is_sandbox":null`},
		{"live receives sandbox", `"amount":1050,"currency":"RUB","is_sandbox":true`},
		{"subscription", `"amount":1050,"currency":"RUB","is_sandbox":false,"is_subscription":true`},
		{"blocked payer", `"amount":1050,"currency":"RUB","is_sandbox":false,"block_reason":"blocked"`},
		{"wrong crypto source", `"amount":146,"currency":"USD","is_sandbox":false,"source_amount":1051,"source_currency":"RUB","payment_method":"CRYPTO"`},
		{"wrong crypto currency", `"amount":146,"currency":"EUR","is_sandbox":false,"source_amount":1050,"source_currency":"RUB","payment_method":"CRYPTO"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			client.HTTP.Transport = hostedTestTransport(func(*http.Request) (*http.Response, error) {
				return hostedTestResponse(`{"id":"019ad028-2100-7000-8000-000000000002","order_id":"HP-fixture","status":"PAID",` + test.extra + `}`), nil
			})
			_, err := client.Query(context.Background(), order, "", "")
			require.Error(t, err)
		})
	}
	client.HTTP.Transport = hostedTestTransport(func(*http.Request) (*http.Response, error) {
		return hostedTestResponse(`{"id":"019ad028-2100-7000-8000-000000000002","order_id":"HP-fixture","status":"PAID","amount":1050,"charged_amount":1092,"created_at":"2026-11-24T00:00:00Z"}`), nil
	})
	result, err := client.Query(context.Background(), order, "", "")
	require.NoError(t, err, "omitted currency and sandbox use the documented RUB/false defaults")
	require.True(t, result.Paid)
	require.Equal(t, "RUB", result.Currency)
	client.Config.Environment = "test"
	_, err = client.Query(context.Background(), order, "", "")
	require.ErrorContains(t, err, "environment mismatch", "test wallets require an explicit sandbox marker")
}

func TestHostedZPayUsesDocumentedFormAndQueriesBeforeCrediting(t *testing.T) {
	cfg := setting.DefaultHostedPaymentConfig("zpay")
	cfg.MerchantID, cfg.APISecret = "123456", "fixture-merchant-secret"
	cfg.CheckoutHosts = []string{"zpayz.cn"}
	client := NewHostedPaymentClient("zpay", cfg)
	sdk, err := epay.NewClient(&epay.Config{PartnerID: cfg.MerchantID, Key: cfg.APISecret}, "https://zpayz.cn")
	require.NoError(t, err)
	client.HTTP.Transport = hostedTestTransport(func(request *http.Request) (*http.Response, error) {
		require.Equal(t, "/mapi.php", request.URL.Path)
		require.Equal(t, "zpayz.cn", request.URL.Host)
		require.NoError(t, request.ParseMultipartForm(16384))
		defer request.MultipartForm.RemoveAll()
		params := map[string]string{}
		for key, values := range request.PostForm {
			params[key] = values[0]
		}
		verified, err := sdk.Verify(params)
		require.NoError(t, err)
		require.True(t, verified.VerifyStatus)
		require.Equal(t, "10.50", params["money"])
		require.Equal(t, "203.0.113.10", params["clientip"])
		require.Equal(t, "https://ru.example.com/wallet", params["return_url"])
		require.Equal(t, "https://ru.example.com/api/payments/zpay/webhook/live", params["notify_url"])
		return hostedTestResponse(`{"code":1,"trade_no":"202611240001","payurl":"https://zpayz.cn/pay/fixture"}`), nil
	})
	order := &model.HostedPayment{TradeNo: "HP-fixture", Amount: "10.50", Currency: "CNY"}
	checkout, err := client.Create(context.Background(), order, HostedCheckoutOptions{
		ReturnURL: "https://ru.example.com/wallet?show_history=true", WebhookURL: "https://ru.example.com/api/payments/zpay/webhook/live", ClientIP: "203.0.113.10",
	})
	require.NoError(t, err)
	require.Equal(t, "202611240001", checkout.RemoteID)
	params, err := sdk.SignParams(map[string]string{"out_trade_no": order.TradeNo, "trade_no": checkout.RemoteID,
		"money": "10.50", "type": "alipay", "trade_status": "TRADE_SUCCESS"})
	require.NoError(t, err)
	query := url.Values{}
	for key, value := range params {
		query.Set(key, value)
	}
	event, err := client.VerifyWebhook(context.Background(), []byte(query.Encode()), http.Header{})
	require.NoError(t, err)
	require.Equal(t, order.TradeNo, event.Reference)
	_, err = client.VerifyWebhook(context.Background(), []byte(query.Encode()+"&money=0.01"), http.Header{})
	require.ErrorContains(t, err, "duplicate")
	query.Set("money", "0.01")
	_, err = client.VerifyWebhook(context.Background(), []byte(query.Encode()), http.Header{})
	require.ErrorContains(t, err, "signature")
	query.Set("pid", "other")
	_, err = client.VerifyWebhook(context.Background(), []byte(query.Encode()), http.Header{})
	require.ErrorContains(t, err, "merchant")
	for _, state := range []string{"0", "1"} {
		client.HTTP.Transport = hostedTestTransport(func(request *http.Request) (*http.Response, error) {
			require.Equal(t, "/api.php", request.URL.Path)
			require.Equal(t, cfg.APISecret, request.URL.Query().Get("key"))
			require.Equal(t, order.TradeNo, request.URL.Query().Get("out_trade_no"))
			return hostedTestResponse(`{"code":1,"pid":"123456","trade_no":"202611240001","out_trade_no":"HP-fixture","money":"10.50","type":"alipay","status":` + state + `}`), nil
		})
		result, err := client.Query(context.Background(), order, checkout.RemoteID, "")
		require.NoError(t, err)
		require.Equal(t, "CNY", result.Currency)
		require.Equal(t, state == "1", result.Paid)
	}
	client.HTTP.Transport = hostedTestTransport(func(*http.Request) (*http.Response, error) {
		return hostedTestResponse(`{"code":1,"pid":"other","trade_no":"202611240001","out_trade_no":"HP-fixture","money":"10.50","type":"alipay","status":1}`), nil
	})
	_, err = client.Query(context.Background(), order, checkout.RemoteID, "")
	require.ErrorContains(t, err, "merchant order")
	client.HTTP.Transport = hostedTestTransport(func(*http.Request) (*http.Response, error) {
		return hostedTestResponse(`{"code":1,"trade_no":"202611240001","payurl":"https://unapproved.example.com/pay/fixture"}`), nil
	})
	_, err = client.Create(context.Background(), order, HostedCheckoutOptions{ReturnURL: "https://ru.example.com/wallet", ClientIP: "203.0.113.10"})
	require.ErrorContains(t, err, "unapproved checkout host")
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
	checkout, err := client.Create(context.Background(), order, HostedCheckoutOptions{ReturnURL: "https://ru.example.com/wallet"})
	require.NoError(t, err)
	require.Equal(t, "PAY-fixture", checkout.RemoteID)
	validSignature = false
	_, err = client.Create(context.Background(), order, HostedCheckoutOptions{ReturnURL: "https://ru.example.com/wallet"})
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

func TestHostedCreemCreatesDynamicInclusivePriceAndRequeriesPaidOrder(t *testing.T) {
	cfg := setting.DefaultHostedPaymentConfig(setting.HostedProviderCreem)
	cfg.APIKey, cfg.WebhookSecret = "fixture-api", "fixture-webhook"
	client := NewHostedPaymentClient(setting.HostedProviderCreem, cfg)
	order := &model.HostedPayment{TradeNo: "HP-fixture", ProductID: "prod_fixture", CustomerID: "user-123", Amount: "10.50", Currency: "USD"}
	paidAmount, productMode, productTax := int64(1050), "test", "inclusive"
	checkoutResponse := func() string {
		return fmt.Sprintf(`{"id":"chk_fixture","mode":"test","request_id":"HP-fixture","status":"completed","units":1,"custom_price":1050,"product":"prod_fixture","metadata":{"user_id":"user-123"},"order":{"id":"ord_fixture","mode":"test","product":"prod_fixture","currency":"USD","amount":1050,"amount_due":1050,"amount_paid":%d,"discount_amount":0,"status":"paid","type":"onetime"}}`, paidAmount)
	}
	client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
		require.Equal(t, "test-api.creem.io", req.URL.Host)
		require.Equal(t, cfg.APIKey, req.Header.Get("x-api-key"))
		if strings.HasPrefix(req.URL.Path, "/v1/products/") {
			return hostedTestResponse(fmt.Sprintf(`{"id":"prod_fixture","mode":%q,"status":"active","billing_type":"onetime","currency":"USD","tax_mode":%q}`, productMode, productTax)), nil
		}
		if req.Method == http.MethodPost {
			var body map[string]any
			require.NoError(t, common.DecodeJson(req.Body, &body))
			require.Equal(t, float64(1050), body["custom_price"])
			require.Equal(t, "prod_fixture", body["product_id"])
			require.Equal(t, "HP-fixture", body["request_id"])
			return hostedTestResponse(`{"id":"chk_fixture","request_id":"HP-fixture","mode":"test","status":"pending","checkout_url":"https://test.creem.io/payment/chk_fixture"}`), nil
		}
		require.Equal(t, "chk_fixture", req.URL.Query().Get("checkout_id"))
		return hostedTestResponse(checkoutResponse()), nil
	})
	checkout, err := client.Create(context.Background(), order, HostedCheckoutOptions{CustomerEmail: "buyer@example.com", ReturnURL: "https://ru.example.com/wallet"})
	require.NoError(t, err)
	require.Equal(t, "chk_fixture", checkout.RemoteID)
	result, err := client.Query(context.Background(), order, checkout.RemoteID, "")
	require.NoError(t, err)
	require.True(t, result.Paid)
	paidAmount = 1000
	_, err = client.Query(context.Background(), order, checkout.RemoteID, "")
	require.ErrorContains(t, err, "paid amount")
	productTax = "exclusive"
	_, err = client.Create(context.Background(), order, HostedCheckoutOptions{CustomerEmail: "buyer@example.com"})
	require.ErrorContains(t, err, "tax-inclusive")
	productTax, productMode = "inclusive", "prod"
	_, err = client.Create(context.Background(), order, HostedCheckoutOptions{CustomerEmail: "buyer@example.com"})
	require.Error(t, err, "a live product cannot be sold from a test instance")
	body := []byte(`{"eventType":"checkout.completed","object":{"id":"chk_fixture","request_id":"HP-fixture","mode":"test"}}`)
	mac := hmac.New(sha256.New, []byte(cfg.WebhookSecret))
	mac.Write(body)
	headers := http.Header{}
	headers.Set("creem-signature", hex.EncodeToString(mac.Sum(nil)))
	event, err := client.VerifyWebhook(context.Background(), body, headers)
	require.NoError(t, err)
	require.Equal(t, "chk_fixture", event.RemoteID)
	_, err = client.VerifyWebhook(context.Background(), bytes.Replace(body, []byte(`"test"`), []byte(`"prod"`), 1), headers)
	require.Error(t, err)
	client.Config.WebhookSecret = ""
	_, err = client.VerifyWebhook(context.Background(), body, headers)
	require.Error(t, err, "test mode cannot bypass a missing webhook secret")
}

func TestHostedPancakeSignsExactTaxInclusiveBodyAndSeparatesSessionFromOrder(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	cfg := setting.DefaultHostedPaymentConfig(setting.HostedProviderPancake)
	cfg.MerchantID, cfg.StoreID, cfg.ProductID = "MER_fixture", "STO_fixture", "PROD_fixture"
	cfg.PrivateKey = string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	publicKey, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	require.NoError(t, err)
	cfg.PlatformPublicKey = string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicKey}))
	client := NewHostedPaymentClient(setting.HostedProviderPancake, cfg)
	order := &model.HostedPayment{TradeNo: "HP-fixture", ProductID: cfg.ProductID, CustomerID: "user-123", Amount: "10.50", Currency: "USD"}
	mode, discount := true, "0"
	client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
		raw, err := io.ReadAll(req.Body)
		require.NoError(t, err)
		digest := sha256.Sum256(raw)
		canonical := "POST\n" + req.URL.Path + "\n" + req.Header.Get("X-Timestamp") + "\n" + base64.StdEncoding.EncodeToString(digest[:])
		signed := sha256.Sum256([]byte(canonical))
		signature, err := base64.StdEncoding.DecodeString(req.Header.Get("X-Signature"))
		require.NoError(t, err)
		require.NoError(t, rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, signed[:], signature))
		require.Equal(t, "test", req.Header.Get("X-Environment"))
		switch req.URL.Path {
		case "/v1/actions/checkout/create-session":
			var body map[string]any
			require.NoError(t, common.Unmarshal(raw, &body))
			require.Equal(t, "ru-RU", body["language"])
			require.Equal(t, false, body["allowPromotionCodes"])
			require.Equal(t, map[string]any{"amount": "10.50", "taxIncluded": true, "taxCategory": "saas"}, body["priceSnapshot"])
			return hostedTestResponse(`{"data":{"sessionId":"cs_fixture","checkoutUrl":"https://checkout.waffo.ai/store/checkout/cs_fixture"}}`), nil
		case "/v1/actions/auth/issue-session-token":
			return hostedTestResponse(`{"data":{"token":"fixture-buyer-token"}}`), nil
		case "/v1/graphql":
			require.Empty(t, req.Header.Get("X-Idempotency-Key"), "query results must not be cached by mutation idempotency")
			return hostedTestResponse(fmt.Sprintf(`{"data":{"onetimeOrders":[{"id":"ORD_fixture","orderMerchantExternalId":"HP-fixture","currency":"USD","status":"completed","testMode":%t,"metadata":{"user_id":"user-123"},"priceSnapshot":{"currency":"USD","total":"10.50"},"onetimeProduct":{"id":"PROD_fixture"},"payments":[{"id":"PAY_fixture","status":"succeeded","refundStatus":"none","snapshotAmountDetails":{"currency":"USD","total":"10.50","discountAmount":%q},"refunds":[]}]}]}}`, mode, discount)), nil
		}
		t.Fatalf("unexpected Waffo request path %s", req.URL.Path)
		return nil, nil
	})
	checkout, err := client.Create(context.Background(), order, HostedCheckoutOptions{CustomerEmail: "buyer@example.com", ReturnURL: "https://ru.example.com/wallet"})
	require.NoError(t, err)
	require.Empty(t, checkout.RemoteID)
	require.Equal(t, "cs_fixture", checkout.SessionID)
	require.Equal(t, "https://checkout.waffo.ai/store/checkout/cs_fixture?test=true#token=fixture-buyer-token", checkout.URL)
	result, err := client.Query(context.Background(), order, "", "")
	require.NoError(t, err)
	require.True(t, result.Paid)
	require.Equal(t, "ORD_fixture", result.RemoteID)
	mode = false
	_, err = client.Query(context.Background(), order, "", "")
	require.Error(t, err, "test instance rejects live order")
	mode, discount = true, "1.00"
	_, err = client.Query(context.Background(), order, "", "")
	require.ErrorContains(t, err, "payment amount")
	_, err = client.Query(context.Background(), order, "cs_fixture", "")
	require.ErrorContains(t, err, "session ID")
	for _, age := range []time.Duration{0, -31 * time.Minute, -46 * time.Minute, 46 * time.Minute} {
		body := []byte(`{"eventType":"order.completed","storeId":"STO_fixture","mode":"test","data":{"orderId":"ORD_fixture","orderMerchantExternalId":"HP-fixture","merchantProvidedBuyerIdentity":"user-123","paymentId":"PAY_fixture","paymentStatus":"succeeded"}}`)
		timestamp := strconv.FormatInt(time.Now().Add(age).UnixMilli(), 10)
		digest := sha256.Sum256([]byte(timestamp + "." + string(body)))
		signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
		require.NoError(t, err)
		headers := http.Header{}
		headers.Set("X-Waffo-Signature", "t="+timestamp+",v1="+base64.StdEncoding.EncodeToString(signature))
		event, err := client.VerifyWebhook(context.Background(), body, headers)
		if age < -45*time.Minute || age > 45*time.Minute {
			require.Error(t, err)
		} else {
			require.NoError(t, err, "Pancake retries keep their original signature timestamp for more than 31 minutes")
			require.Equal(t, "user-123", event.CustomerID)
		}
	}
}

func TestHostedPlategaUsesV2BuyerMetadataAndChecksMisspelledMerchantField(t *testing.T) {
	cfg := setting.DefaultHostedPaymentConfig("platega")
	cfg.MerchantID, cfg.APISecret = "019ad028-2100-7000-8000-000000000001", "fixture-secret"
	client := NewHostedPaymentClient("platega", cfg)
	order := &model.HostedPayment{TradeNo: "HP-fixture", CustomerID: "user-123", Amount: "10.50", Currency: "RUB"}
	merchant := cfg.MerchantID
	client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
		require.Equal(t, cfg.APISecret, req.Header.Get("X-Secret"))
		if req.Method == http.MethodPost {
			var body map[string]any
			require.NoError(t, common.DecodeJson(req.Body, &body))
			if client.Config.PaymentMethod == "" {
				require.Equal(t, "/v2/transaction/process", req.URL.Path)
				require.NotContains(t, body, "paymentMethod")
			} else {
				require.Equal(t, "/transaction/process", req.URL.Path)
				require.Equal(t, float64(2), body["paymentMethod"])
			}
			require.Equal(t, map[string]any{"user_email": "buyer@example.com", "userId": "user-123"}, body["metadata"])
			return hostedTestResponse(`{"transactionId":"019ad028-2100-7000-8000-000000000002","status":"PENDING","redirect":"https://pay.platega.io/fixture"}`), nil
		}
		return hostedTestResponse(fmt.Sprintf(`{"id":"019ad028-2100-7000-8000-000000000002","mechantId":%q,"payload":"HP-fixture","status":"CONFIRMED","paymentDetails":{"amount":10.50,"currency":"RUB"}}`, merchant)), nil
	})
	checkout, err := client.Create(context.Background(), order, HostedCheckoutOptions{CustomerEmail: "buyer@example.com"})
	require.NoError(t, err)
	result, err := client.Query(context.Background(), order, checkout.RemoteID, "")
	require.NoError(t, err)
	require.True(t, result.Paid)
	client.Config.PaymentMethod = "2"
	_, err = client.Create(context.Background(), order, HostedCheckoutOptions{CustomerEmail: "buyer@example.com"})
	require.NoError(t, err, "fixed Platega methods use the documented non-V2 endpoint")
	merchant = "other-merchant"
	_, err = client.Query(context.Background(), order, checkout.RemoteID, "")
	require.ErrorContains(t, err, "merchant")
	headers := http.Header{}
	headers.Set("X-MerchantId", cfg.MerchantID)
	headers.Set("X-Secret", cfg.APISecret)
	_, err = client.VerifyWebhook(context.Background(), []byte(`{"id":"019ad028-2100-7000-8000-000000000002","payload":"HP-fixture","status":"CONFIRMED"}`), headers)
	require.NoError(t, err)
	headers.Set("X-Secret", "wrong")
	_, err = client.VerifyWebhook(context.Background(), []byte(`{}`), headers)
	require.Error(t, err)
}

func TestHostedLavaUsesOfficialServiceKeyAndChecksBuyerOfferAndReceipt(t *testing.T) {
	cfg := setting.DefaultHostedPaymentConfig("lava")
	cfg.APIKey, cfg.WebhookSecret = "fixture-outbound-key", "fixture-callback-key"
	cfg.CheckoutHosts = []string{"pay.lava.top"}
	client := NewHostedPaymentClient("lava", cfg)
	buyer := sha256.Sum256([]byte("buyer@example.com"))
	order := &model.HostedPayment{TradeNo: "HP-fixture", ProductID: "019ad028-2100-7000-8000-000000000001", CustomerHash: hex.EncodeToString(buyer[:]), Amount: "10.50", Currency: "EUR"}
	invoiceID, offerID := "019ad028-2100-7000-8000-000000000002", order.ProductID
	client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
		require.Equal(t, cfg.APIKey, req.Header.Get("X-Api-Key"))
		if req.Method == http.MethodPost {
			require.Equal(t, "/api/v3/invoice", req.URL.Path)
			var body map[string]any
			require.NoError(t, common.DecodeJson(req.Body, &body))
			require.Equal(t, "https://ru.example.com/wallet", body["successful_return_url"])
			require.Equal(t, float64(10.5), body["amount"])
			return hostedTestResponse(fmt.Sprintf(`{"id":%q,"paymentUrl":"https://pay.lava.top/fixture","amountTotal":{"amount":10.5,"currency":"EUR"}}`, invoiceID)), nil
		}
		require.Equal(t, "/api/v1/invoices/"+invoiceID, req.URL.Path)
		return hostedTestResponse(fmt.Sprintf(`{"id":%q,"type":"ONE_TIME","status":"completed","receipt":{"amount":10.5,"currency":"EUR","fee":0.5},"buyer":{"email":"buyer@example.com"},"product":{"offer":%q}}`, invoiceID, offerID)), nil
	})
	checkout, err := client.Create(context.Background(), order, HostedCheckoutOptions{CustomerEmail: "buyer@example.com", ReturnURL: "https://ru.example.com/wallet"})
	require.NoError(t, err)
	result, err := client.Query(context.Background(), order, checkout.RemoteID, "")
	require.NoError(t, err)
	require.True(t, result.Paid)
	require.Equal(t, "10.5", result.Amount)
	offerID = "wrong-offer"
	_, err = client.Query(context.Background(), order, checkout.RemoteID, "")
	require.ErrorContains(t, err, "product or buyer")
	headers := http.Header{}
	headers.Set("X-Api-Key", cfg.APIKey)
	_, err = client.VerifyWebhook(context.Background(), []byte(`{}`), headers)
	require.Error(t, err, "outbound key must not authenticate a callback")
	headers.Set("X-Api-Key", cfg.WebhookSecret)
	event, err := client.VerifyWebhook(context.Background(), []byte(fmt.Sprintf(`{"eventType":"payment.success","contractId":%q}`, invoiceID)), headers)
	require.NoError(t, err)
	require.Equal(t, invoiceID, event.RemoteID)
	event, err = client.VerifyWebhook(context.Background(), []byte(`{"event_type":"refund.success","data":{"amount":10.5}}`), headers)
	require.NoError(t, err)
	require.Nil(t, event, "refund envelopes cannot authorize top-ups")
}

func TestHostedCryptoCloudPinsVariantAndRequiresFullPaymentAndFreshHS256JWT(t *testing.T) {
	cfg := setting.DefaultHostedPaymentConfig("cryptocloud")
	cfg.APIKey, cfg.WebhookSecret, cfg.AccountID = "fixture-api", "fixture-jwt-secret", "fixture-shop"
	cfg.CheckoutHosts = []string{"pay.trybit.com"}
	client := NewHostedPaymentClient("cryptocloud", cfg)
	order := &model.HostedPayment{TradeNo: "HP-fixture", Amount: "10.50", Currency: "USD"}
	for _, test := range []struct {
		status, paid string
		expected     bool
	}{
		{"paid", "1", true}, {"overpaid", "1.1", true}, {"partial", "0.9", false}, {"paid", "0.9", false},
	} {
		t.Run(test.status+test.paid, func(t *testing.T) {
			client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
				require.Equal(t, "api.trybit.com", req.URL.Host)
				require.Equal(t, "Token fixture-api", req.Header.Get("Authorization"))
				return hostedTestResponse(fmt.Sprintf(`{"status":"success","result":[{"uuid":"INV-FIXTURE","order_id":"HP-fixture","fiat_currency":"USD","amount_in_fiat":10.50,"test_mode":false,"status":%q,"invoice_status":"success","amount_to_pay":1,"amount_paid":%s,"to_surcharge":0}]}`, test.status, test.paid)), nil
			})
			result, err := client.Query(context.Background(), order, "INV-FIXTURE", "")
			require.NoError(t, err)
			require.Equal(t, test.expected, result.Paid)
		})
	}
	client.Config.Environment = "test"
	_, err := client.Query(context.Background(), order, "INV-FIXTURE", "")
	require.ErrorContains(t, err, "environment")
	client.Config.Environment = "live"
	client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
		return hostedTestResponse(`{"status":"success","result":[{"uuid":"INV-FIXTURE","order_id":"HP-fixture","amount_in_fiat":10.50,"amount_usd":10.50,"test_mode":false,"status":"paid","invoice_status":"success","amount_to_pay":1,"amount_paid":1,"to_surcharge":0}]}`), nil
	})
	_, err = client.Query(context.Background(), order, "INV-FIXTURE", "")
	require.ErrorContains(t, err, "currency", "USD valuation cannot replace a missing original fiat currency")
	for _, test := range []struct {
		name    string
		method  jwt.SigningMethod
		expires time.Time
		missing bool
	}{
		{"valid", jwt.SigningMethodHS256, time.Now().Add(4 * time.Minute), false},
		{"expired", jwt.SigningMethodHS256, time.Now().Add(-time.Minute), false},
		{"wrong algorithm", jwt.SigningMethodHS512, time.Now().Add(time.Minute), false},
		{"missing expiry", jwt.SigningMethodHS256, time.Time{}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			claims := jwt.MapClaims{"id": 13}
			if !test.missing {
				claims["exp"] = test.expires.Unix()
			}
			token, err := jwt.NewWithClaims(test.method, claims).SignedString([]byte(cfg.WebhookSecret))
			require.NoError(t, err)
			body, err := common.Marshal(map[string]string{"status": "success", "invoice_id": "FIXTURE", "order_id": "HP-fixture", "token": token})
			require.NoError(t, err)
			event, err := client.VerifyWebhook(context.Background(), body, http.Header{})
			if test.name == "valid" {
				require.NoError(t, err)
				require.Equal(t, "INV-FIXTURE", event.RemoteID)
			} else {
				require.Error(t, err)
			}
		})
	}
	_, err = client.VerifyWebhook(context.Background(), []byte(`{"status":"success","invoice_id":"FIXTURE","order_id":"HP-fixture"}`), http.Header{})
	require.Error(t, err)
}

func TestHostedOxaPayUsesV1InvoiceAndRejectsToleranceManualAcceptanceAndWrongCallback(t *testing.T) {
	cfg := setting.DefaultHostedPaymentConfig("oxapay")
	cfg.APIKey = "fixture-merchant-key"
	client := NewHostedPaymentClient("oxapay", cfg)
	callback := "https://sandbox.example.com/api/payments/oxapay/webhook/test"
	hash := sha256.Sum256([]byte(callback))
	order := &model.HostedPayment{TradeNo: "HP-fixture", Amount: "10.50", Currency: "USD", CallbackHash: hex.EncodeToString(hash[:])}
	status, coverage, returnedCallback := "paid", "0", callback
	client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
		require.Equal(t, "api.oxapay.com", req.URL.Host)
		require.Equal(t, cfg.APIKey, req.Header.Get("merchant_api_key"))
		if req.Method == http.MethodPost {
			require.Equal(t, "/v1/payment/invoice", req.URL.Path)
			var body map[string]any
			require.NoError(t, common.DecodeJson(req.Body, &body))
			require.Equal(t, true, body["sandbox"])
			require.Equal(t, float64(0), body["under_paid_coverage"])
			require.Equal(t, false, body["mixed_payment"])
			require.Equal(t, callback, body["callback_url"])
			return hostedTestResponse(`{"status":200,"error":null,"data":{"track_id":"151811887","payment_url":"https://pay.oxapay.com/151811887"}}`), nil
		}
		require.Equal(t, "/v1/payment/151811887", req.URL.Path)
		return hostedTestResponse(fmt.Sprintf(`{"status":200,"error":null,"data":{"track_id":"151811887","order_id":"HP-fixture","type":"invoice","amount":10.50,"currency":"USD","status":%q,"under_paid_coverage":%s,"callback_url":%q,"txs":[{"tx_hash":"confirmed-fixture","status":"confirmed","amount":1}]}}`, status, coverage, returnedCallback)), nil
	})
	checkout, err := client.Create(context.Background(), order, HostedCheckoutOptions{WebhookURL: callback, ReturnURL: "https://sandbox.example.com/wallet"})
	require.NoError(t, err)
	require.Equal(t, "151811887", checkout.RemoteID)
	result, err := client.Query(context.Background(), order, checkout.RemoteID, "")
	require.NoError(t, err)
	require.True(t, result.Paid)
	status = "manual_accept"
	result, err = client.Query(context.Background(), order, checkout.RemoteID, "")
	require.NoError(t, err)
	require.False(t, result.Paid)
	status, coverage = "paid", "1"
	_, err = client.Query(context.Background(), order, checkout.RemoteID, "")
	require.ErrorContains(t, err, "underpayment")
	coverage, returnedCallback = "0", "https://live.example.com/api/payments/oxapay/webhook/live"
	_, err = client.Query(context.Background(), order, checkout.RemoteID, "")
	require.ErrorContains(t, err, "environment")
	body := []byte(`{"track_id":"151811887","order_id":"HP-fixture","status":"Paid","type":"invoice"}`)
	mac := hmac.New(sha512.New, []byte(cfg.APIKey))
	mac.Write(body)
	headers := http.Header{}
	headers.Set("HMAC", hex.EncodeToString(mac.Sum(nil)))
	event, err := client.VerifyWebhook(context.Background(), body, headers)
	require.NoError(t, err)
	require.Equal(t, "151811887", event.RemoteID)
	_, err = client.VerifyWebhook(context.Background(), append(body, ' '), headers)
	require.Error(t, err, "raw-body HMAC must reject modified bytes")
}

func TestHostedApironePinsExactCoinQuoteAndWaitsForCompletedPrivateInvoice(t *testing.T) {
	cfg := setting.DefaultHostedPaymentConfig("apirone")
	cfg.AccountID, cfg.APIKey, cfg.WebhookSecret = "apr-00000000000000000000000000000001", "fixture-transfer-key", strings.Repeat("w", 32)
	client := NewHostedPaymentClient("apirone", cfg)
	reference := "HP-" + strings.Repeat("a", 24)
	callback := "https://ru.example.com/api/payments/apirone/webhook/live?ref=" + reference + "&token=" + HostedApironeCallbackToken(cfg.WebhookSecret, reference)
	hash := sha256.Sum256([]byte(callback))
	order := &model.HostedPayment{TradeNo: reference, Amount: "10.50", Currency: "USD", CallbackHash: hex.EncodeToString(hash[:])}
	status, returnedAmount, receipt := "completed", "10500000", "10500000"
	returnedAccount, returnedCurrency := cfg.AccountID, cfg.PayCurrency
	client.HTTP.Transport = hostedTestTransport(func(req *http.Request) (*http.Response, error) {
		require.Equal(t, "apirone.com", req.URL.Host)
		require.NotContains(t, req.URL.String(), cfg.APIKey)
		if req.Method == http.MethodOptions {
			return hostedTestResponse(`{"currencies":[{"abbr":"usdt@trx","units-factor":0.000001},{"abbr":"usdt@bnb","units-factor":0.000000000000000001}]}`), nil
		}
		if req.URL.Path == "/api/v2/ticker" {
			return hostedTestResponse(`{"usd":1}`), nil
		}
		if req.URL.Path == "/api/v2/auth/login" {
			var body map[string]string
			require.NoError(t, common.DecodeJson(req.Body, &body))
			require.Equal(t, cfg.APIKey, body["password"])
			return hostedTestResponse(fmt.Sprintf(`{"login":%q,"access-token":"fixture-short-lived-token"}`, cfg.AccountID)), nil
		}
		require.Equal(t, "Bearer fixture-short-lived-token", req.Header.Get("Authorization"))
		if req.Method == http.MethodPost {
			var body map[string]any
			require.NoError(t, common.DecodeJson(req.Body, &body))
			require.Equal(t, "10500000", body["amount"], "minor units remain an exact string")
			require.Equal(t, callback, body["callback-url"])
			return hostedTestResponse(fmt.Sprintf(`{"invoice":"amr94MKUQCYAzR6c","account":%q,"amount":"10500000","currency":"usdt@trx","status":"created","callback-url":%q,"user-data":{"reference_id":%q},"invoice-url":"https://apirone.com/invoice?id=amr94MKUQCYAzR6c"}`, cfg.AccountID, callback, reference)), nil
		}
		return hostedTestResponse(fmt.Sprintf(`{"invoice":"amr94MKUQCYAzR6c","account":%q,"amount":%s,"currency":%q,"status":%q,"callback-url":%q,"user-data":{"reference_id":%q},"history":[{"txid":"fixture-receipt","amount":%s},{"txid":"fixture-receipt","amount":%s}]}`, returnedAccount, returnedAmount, returnedCurrency, status, callback, reference, receipt, receipt)), nil
	})
	require.NoError(t, client.PrepareApironeQuote(context.Background(), order))
	require.Equal(t, "10500000", order.CoinAmount)
	require.Equal(t, "1", order.CoinUSDRate)
	checkout, err := client.Create(context.Background(), order, HostedCheckoutOptions{WebhookURL: callback, ReturnURL: "https://ru.example.com/wallet"})
	require.NoError(t, err)
	result, err := client.Query(context.Background(), order, checkout.RemoteID, "")
	require.NoError(t, err)
	require.True(t, result.Paid)
	for _, unconfirmed := range []string{"paid", "overpaid", "partpaid", "expired"} {
		status = unconfirmed
		result, err = client.Query(context.Background(), order, checkout.RemoteID, "")
		require.NoError(t, err)
		require.False(t, result.Paid)
	}
	status, receipt = "completed", "7000000"
	result, err = client.Query(context.Background(), order, checkout.RemoteID, "")
	require.NoError(t, err)
	require.False(t, result.Paid, "duplicate transaction history must not make a partial payment sufficient")
	returnedAmount = "10499999"
	_, err = client.Query(context.Background(), order, checkout.RemoteID, "")
	require.ErrorContains(t, err, "coin quote")
	returnedAmount, returnedAccount = "10500000", "apr-other"
	_, err = client.Query(context.Background(), order, checkout.RemoteID, "")
	require.ErrorContains(t, err, "account")
	client.Config.PayCurrency = "usdt@bnb"
	require.NoError(t, client.PrepareApironeQuote(context.Background(), order))
	require.Equal(t, "10500000000000000000", order.CoinAmount, "BNB token precision is 18, never 6")
	client.Config.Environment = "test"
	require.Error(t, client.PrepareApironeQuote(context.Background(), order), "never invent a sandbox coin")
	body := []byte(fmt.Sprintf(`{"invoice":"amr94MKUQCYAzR6c","account":%q,"status":"completed"}`, cfg.AccountID))
	headers := http.Header{}
	headers.Set("X-Shiny-Apirone-Reference", reference)
	headers.Set("X-Shiny-Apirone-Token", HostedApironeCallbackToken(cfg.WebhookSecret, reference))
	event, err := client.VerifyWebhook(context.Background(), body, headers)
	require.NoError(t, err)
	require.Equal(t, reference, event.Reference)
	headers.Set("X-Shiny-Apirone-Token", "wrong")
	_, err = client.VerifyWebhook(context.Background(), body, headers)
	require.Error(t, err)
}
