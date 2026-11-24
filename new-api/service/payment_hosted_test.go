package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Calcium-Ion/go-epay/epay"
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
