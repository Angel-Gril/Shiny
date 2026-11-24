package controller

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
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func hostedControllerFixture(t *testing.T) setting.HostedPaymentConfig {
	t.Helper()
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousType, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
	previousMaster, previousCache, previousRedis, previousSQLite := common.IsMasterNode, common.MemoryCacheEnabled, common.RedisEnabled, common.SQLitePath
	common.OptionMapRWMutex.Lock()
	previousOptions := common.OptionMap
	common.OptionMap = map[string]string{}
	common.OptionMapRWMutex.Unlock()
	t.Setenv("SQL_DSN", "local")
	t.Setenv("LOG_SQL_DSN", "")
	common.IsMasterNode, common.MemoryCacheEnabled, common.RedisEnabled = false, false, false
	common.SQLitePath = filepath.Join(t.TempDir(), "hosted-controller.db")
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousType, previousLogType)
		common.IsMasterNode, common.MemoryCacheEnabled, common.RedisEnabled, common.SQLitePath = previousMaster, previousCache, previousRedis, previousSQLite
		common.OptionMapRWMutex.Lock()
		common.OptionMap = previousOptions
		common.OptionMapRWMutex.Unlock()
	})
	require.NoError(t, model.InitDB())
	db := model.DB
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	model.DB, model.LOG_DB = db, db
	require.NoError(t, db.AutoMigrate(&model.Option{}, &model.TopUp{}, &model.HostedPayment{}, &model.User{}, &model.Log{}, &model.SystemTask{}, &model.SystemTaskLock{}))
	t.Cleanup(func() {
		require.NoError(t, sqlDB.Close())
	})
	t.Setenv("PAYMENTS_ENVIRONMENT", "live")
	confirmPaymentComplianceForTest(t)
	cfg := setting.DefaultHostedPaymentConfig("lianlian")
	cfg.Enabled, cfg.AcceptNew, cfg.Environment = true, true, "live"
	cfg.APIKey, cfg.WebhookSecret = "fixture-api-key", "whsec_fixture"
	cfg.APISecret = base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32)))
	cfg.StoreID, cfg.UserID, cfg.DeveloperUserID, cfg.CountryCode = "store", "merchant", "developer", "US"
	cfg.CheckoutHosts, cfg.GoodsURL, cfg.ShippingProvider = []string{"checkout.example.com"}, "https://ru.example.com/product", "provider-approved-code"
	raw, err := common.Marshal(setting.HostedPaymentSettings{"lianlian": cfg})
	require.NoError(t, err)
	common.OptionMap[setting.HostedPaymentOption] = string(raw)
	return cfg
}

type hostedControllerTransport func(*http.Request) (*http.Response, error)

func (transport hostedControllerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestHostedCheckoutAndVerifiedCallbackCreditTheSavedQuoteOnce(t *testing.T) {
	hostedControllerFixture(t)
	previousAddress, previousQuota := system_setting.ServerAddress, common.QuotaPerUnit
	previousDiscounts := operation_setting.GetPaymentSetting().AmountDiscount
	previousDisplay := operation_setting.GetGeneralSetting().QuotaDisplayType
	previousTransport := http.DefaultTransport
	t.Cleanup(func() {
		system_setting.ServerAddress, common.QuotaPerUnit = previousAddress, previousQuota
		operation_setting.GetPaymentSetting().AmountDiscount = previousDiscounts
		operation_setting.GetGeneralSetting().QuotaDisplayType = previousDisplay
		http.DefaultTransport = previousTransport
	})
	system_setting.ServerAddress, common.QuotaPerUnit = "https://ru.example.com", 500000
	operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeUSD
	operation_setting.GetPaymentSetting().AmountDiscount = map[int]float64{}
	user := model.User{Username: "hosted-checkout", Group: "default", Status: common.UserStatusEnabled, Quota: 100}
	require.NoError(t, model.DB.Create(&user).Error)
	cfg := setting.DefaultHostedPaymentConfig("nowpayments")
	cfg.Enabled, cfg.AcceptNew, cfg.UnitPrice = true, true, "0.95"
	cfg.AccountID, cfg.APIKey, cfg.WebhookSecret = "fixture-account", "fixture-key", "fixture-ipn-secret"
	writeSettings := func() {
		raw, err := common.Marshal(setting.HostedPaymentSettings{"nowpayments": cfg})
		require.NoError(t, err)
		require.NoError(t, model.UpdateOptionsBulk(map[string]string{setting.HostedPaymentOption: string(raw)}))
	}
	writeSettings()
	tradeNo, remoteAmount := "", "9.51"
	http.DefaultTransport = hostedControllerTransport(func(request *http.Request) (*http.Response, error) {
		require.Equal(t, "api.nowpayments.io", request.URL.Host)
		var response map[string]any
		switch request.URL.Path {
		case "/v1/invoice":
			var payload map[string]any
			require.NoError(t, common.DecodeJson(request.Body, &payload))
			tradeNo = payload["order_id"].(string)
			require.Equal(t, 9.5, payload["price_amount"])
			require.Equal(t, "https://ru.example.com/wallet?show_history=true", payload["success_url"])
			require.Equal(t, "https://ru.example.com/api/payments/nowpayments/webhook/live", payload["ipn_callback_url"])
			response = map[string]any{"id": 456, "order_id": tradeNo, "price_amount": 9.5, "price_currency": "usd", "invoice_url": "https://nowpayments.io/payment/fixture"}
		case "/v1/payment/123":
			response = map[string]any{"payment_id": 123, "invoice_id": 456, "order_id": tradeNo, "price_amount": remoteAmount,
				"price_currency": "usd", "payment_status": "finished", "pay_amount": 1, "actually_paid": 1}
		default:
			t.Fatalf("unexpected provider request: %s", request.URL.Path)
		}
		raw, err := common.Marshal(response)
		require.NoError(t, err)
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(raw))}, nil
	})
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Set("id", user.Id)
	ctx.Params = gin.Params{{Key: "provider", Value: "nowpayments"}}
	ctx.Request = httptest.NewRequest(http.MethodPost, "/pay", strings.NewReader(`{"amount":10,"payment_amount":"0.01"}`))
	RequestHostedPay(ctx)
	require.Contains(t, recorder.Body.String(), "checkout_url")
	topup := model.GetTopUpByTradeNo(tradeNo)
	require.NotNil(t, topup)
	require.EqualValues(t, 5000000, topup.CreditedQuota)
	require.Equal(t, 9.5, topup.Money)
	cfg.UnitPrice = "2"
	writeSettings() // Later prices do not change this order's payment or quota.
	body, err := common.Marshal(map[string]any{"order_id": tradeNo, "payment_id": 123})
	require.NoError(t, err)
	mac := hmac.New(sha512.New, []byte(cfg.WebhookSecret))
	mac.Write(body) // This fixed payload is already alphabetically ordered.
	callback := func() int {
		recorder := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(recorder)
		ctx.Params = gin.Params{{Key: "provider", Value: "nowpayments"}, {Key: "env", Value: "live"}}
		ctx.Request = httptest.NewRequest(http.MethodPost, "/webhook/live", bytes.NewReader(body))
		ctx.Request.Header.Set("x-nowpayments-sig", hex.EncodeToString(mac.Sum(nil)))
		HostedPaymentWebhook(ctx)
		return recorder.Code
	}
	require.Equal(t, http.StatusServiceUnavailable, callback(), "wrong amount cannot credit")
	require.Equal(t, common.TopUpStatusPending, model.GetTopUpByTradeNo(tradeNo).Status)
	remoteAmount = "9.50"
	require.Equal(t, http.StatusOK, callback())
	require.Equal(t, http.StatusOK, callback())
	var credited model.User
	require.NoError(t, model.DB.First(&credited, user.Id).Error)
	require.Equal(t, 5000100, credited.Quota)
	var logs int64
	require.NoError(t, model.LOG_DB.Model(&model.Log{}).Count(&logs).Error)
	require.EqualValues(t, 1, logs)
	order, err := model.GetHostedPayment(tradeNo)
	require.NoError(t, err)
	require.Equal(t, "paid", order.State)
	require.Empty(t, order.CheckoutURL)
}

func TestHostedCisPayKeepsCustomerIdentityAndRejectsSandboxBeforeCrediting(t *testing.T) {
	hostedControllerFixture(t)
	previousAddress, previousQuota := system_setting.ServerAddress, common.QuotaPerUnit
	previousDiscounts := operation_setting.GetPaymentSetting().AmountDiscount
	previousDisplay, previousTransport := operation_setting.GetGeneralSetting().QuotaDisplayType, http.DefaultTransport
	t.Cleanup(func() {
		system_setting.ServerAddress, common.QuotaPerUnit = previousAddress, previousQuota
		operation_setting.GetPaymentSetting().AmountDiscount = previousDiscounts
		operation_setting.GetGeneralSetting().QuotaDisplayType, http.DefaultTransport = previousDisplay, previousTransport
	})
	system_setting.ServerAddress, common.QuotaPerUnit = "https://ru.example.com", 500000
	operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeUSD
	operation_setting.GetPaymentSetting().AmountDiscount = map[int]float64{}
	user := model.User{Username: "cispay-checkout", Group: "default", Status: common.UserStatusEnabled, Quota: 100}
	require.NoError(t, model.DB.Create(&user).Error)
	cfg := setting.DefaultHostedPaymentConfig("cispay")
	cfg.Enabled, cfg.AcceptNew, cfg.Environment, cfg.UnitPrice = true, true, "live", "95"
	cfg.StoreID, cfg.APIKey = "019ad028-2100-7000-8000-000000000001", "cis_sec_fixture-key"
	cfg.CheckoutHosts, cfg.PaymentMethod = []string{"checkout.cispay.app"}, "SBP"
	raw, err := common.Marshal(setting.HostedPaymentSettings{"cispay": cfg})
	require.NoError(t, err)
	require.NoError(t, model.UpdateOptionsBulk(map[string]string{setting.HostedPaymentOption: string(raw)}))
	tradeNo, remoteID := "", "019ad028-2100-7000-8000-000000000002"
	sandbox, paymentAmount, queries := true, int64(95000), 0
	http.DefaultTransport = hostedControllerTransport(func(request *http.Request) (*http.Response, error) {
		require.Equal(t, "api.cispay.app", request.URL.Host)
		var response map[string]any
		switch request.URL.Path {
		case "/payments":
			var payload map[string]any
			require.NoError(t, common.DecodeJson(request.Body, &payload))
			tradeNo = payload["order_id"].(string)
			require.Equal(t, "user-"+fmt.Sprint(user.Id), payload["customer_id"])
			require.Equal(t, float64(95000), payload["amount"])
			response = map[string]any{"id": remoteID, "order_id": tradeNo, "status": "PENDING", "amount": 95000,
				"charged_amount": 96000, "payment_url": "https://checkout.cispay.app/pay/fixture"}
		case "/payments/status":
			queries++
			require.Equal(t, remoteID, request.URL.Query().Get("id"))
			response = map[string]any{"id": remoteID, "order_id": tradeNo, "status": "PAID", "amount": paymentAmount,
				"charged_amount": 96000, "currency": "RUB", "is_sandbox": sandbox, "payment_method": "SBP"}
		default:
			t.Fatalf("unexpected provider request: %s", request.URL.Path)
		}
		body, err := common.Marshal(response)
		require.NoError(t, err)
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(body))}, nil
	})
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Set("id", user.Id)
	ctx.Params = gin.Params{{Key: "provider", Value: "cispay"}}
	ctx.Request = httptest.NewRequest(http.MethodPost, "/pay", strings.NewReader(`{"amount":10}`))
	RequestHostedPay(ctx)
	require.Contains(t, recorder.Body.String(), "checkout_url")
	callback := func(signatureValid bool) int {
		body, err := common.Marshal(map[string]any{"id": remoteID, "store_id": cfg.StoreID, "order_id": tradeNo,
			"status": "PAID", "amount": 95000, "currency": "RUB", "is_sandbox": false})
		require.NoError(t, err)
		mac := hmac.New(sha256.New, []byte(cfg.APIKey))
		mac.Write(body)
		response := httptest.NewRecorder()
		context, _ := gin.CreateTestContext(response)
		context.Params = gin.Params{{Key: "provider", Value: "cispay"}, {Key: "env", Value: "live"}}
		context.Request = httptest.NewRequest(http.MethodPost, "/webhook/live", bytes.NewReader(body))
		if signatureValid {
			context.Request.Header.Set("X-Signature", hex.EncodeToString(mac.Sum(nil)))
		}
		HostedPaymentWebhook(context)
		return response.Code
	}
	require.Equal(t, http.StatusUnauthorized, callback(false))
	require.Zero(t, queries, "an invalid signature must not contact the provider")
	require.Equal(t, http.StatusServiceUnavailable, callback(true), "sandbox money cannot credit the live wallet")
	sandbox, paymentAmount = false, 95001
	require.Equal(t, http.StatusServiceUnavailable, callback(true), "an amount mismatch cannot credit the wallet")
	require.Equal(t, common.TopUpStatusPending, model.GetTopUpByTradeNo(tradeNo).Status)
	paymentAmount = 95000
	require.Equal(t, http.StatusOK, callback(true))
	require.Equal(t, http.StatusOK, callback(true))
	var credited model.User
	require.NoError(t, model.DB.First(&credited, user.Id).Error)
	require.Equal(t, 5000100, credited.Quota, "credit the stored quote once, without the customer's processing fee")
	orders := []*model.TopUp{model.GetTopUpByTradeNo(tradeNo)}
	require.NoError(t, model.AttachHostedPaymentDetails(orders))
	require.Equal(t, "RUB", orders[0].PaymentCurrency)
	require.Equal(t, "paid", orders[0].PaymentState)
}

func TestHostedSettingsKeepSecretsAndPreservePausedWebhook(t *testing.T) {
	cfg := hostedControllerFixture(t)
	cfg.AcceptNew, cfg.APIKey, cfg.APISecret, cfg.WebhookSecret = false, "", "", ""
	raw, err := common.Marshal(map[string]any{"provider": "lianlian", "config": cfg})
	require.NoError(t, err)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest(http.MethodPut, "/api/option/payments/hosted", bytes.NewReader(raw))
	SaveHostedPaymentSettings(ctx)
	saved, err := setting.GetHostedPaymentSettings()
	require.NoError(t, err)
	require.True(t, saved["lianlian"].Enabled)
	require.False(t, saved["lianlian"].AcceptNew)
	require.Equal(t, "fixture-api-key", saved["lianlian"].APIKey)

	recorder := httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/option/payments/hosted", nil)
	GetHostedPaymentSettings(ctx)
	require.NotContains(t, recorder.Body.String(), "fixture-api-key")
	require.NotContains(t, recorder.Body.String(), "whsec_fixture")
	require.Contains(t, recorder.Body.String(), "secrets_configured")
	ctx.Params = gin.Params{{Key: "provider", Value: "lianlian"}}
	_, available := hostedPaymentConfig(ctx, true)
	require.False(t, available)
	_, available = hostedPaymentConfig(ctx, false)
	require.True(t, available)
}

func TestHostedDeploymentSelectionStopsNewSalesAndPreservesExistingCallbacks(t *testing.T) {
	cfg := hostedControllerFixture(t)
	t.Setenv("PAYMENTS_PROVIDERS", "cispay,nowpayments")
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Params = gin.Params{{Key: "provider", Value: "lianlian"}}
	ctx.Request = httptest.NewRequest(http.MethodPost, "/pay", strings.NewReader(`{"amount":10}`))
	_, available := hostedPaymentConfig(ctx, true)
	require.False(t, available, "deployment selection must be enforced on the server")
	_, available = hostedPaymentConfig(ctx, false)
	require.True(t, available, "removed providers must still drain existing payments")
	require.Empty(t, appendHostedPaymentMethods(nil))
	public := cfg.Public("lianlian")
	require.NotNil(t, public.DeploymentSelected)
	require.False(t, *public.DeploymentSelected)
	require.Empty(t, public.APIKey)
	for _, selection := range []string{"none", "cispay,cispay", "cispay,unknown", ""} {
		t.Setenv("PAYMENTS_PROVIDERS", selection)
		providers, err := setting.SelectedHostedPaymentProviders()
		switch selection {
		case "none":
			require.NoError(t, err)
			require.Empty(t, providers)
		case "cispay,cispay":
			require.NoError(t, err)
			require.Equal(t, []string{"cispay"}, providers)
		default:
			require.Error(t, err, "invalid deployment names cannot silently enable everything")
		}
	}
}

func TestHostedZPayGetCallbackUsesVerifiedQueryAndAcknowledgesDuplicates(t *testing.T) {
	hostedControllerFixture(t)
	previousTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	t.Setenv("PAYMENTS_PROVIDERS", "none") // Drain a gateway removed from new sales.
	cfg := setting.DefaultHostedPaymentConfig("zpay")
	cfg.Enabled, cfg.AcceptNew, cfg.MerchantID, cfg.APISecret = true, false, "123456", "fixture-secret"
	cfg.CheckoutHosts = []string{"zpayz.cn"}
	raw, err := common.Marshal(setting.HostedPaymentSettings{"zpay": cfg})
	require.NoError(t, err)
	require.NoError(t, model.UpdateOptionsBulk(map[string]string{setting.HostedPaymentOption: string(raw)}))
	user := model.User{Username: "zpay-callback", Status: common.UserStatusEnabled, Quota: 50}
	require.NoError(t, model.DB.Create(&user).Error)
	order := model.HostedPayment{TradeNo: "HP-zpay", Provider: "zpay", Identity: cfg.Identity("zpay"), RemoteID: "202611240001", Amount: "10.50", Currency: "CNY", State: "pending"}
	require.NoError(t, model.CreateHostedPayment(&model.TopUp{UserId: user.Id, TradeNo: order.TradeNo, Amount: 1, CreditedQuota: 1000,
		Money: 10.5, PaymentProvider: "zpay", PaymentMethod: "zpay", Status: common.TopUpStatusPending}, &order))
	sdk, err := epay.NewClient(&epay.Config{PartnerID: cfg.MerchantID, Key: cfg.APISecret}, "https://zpayz.cn")
	require.NoError(t, err)
	params, err := sdk.SignParams(map[string]string{"out_trade_no": order.TradeNo, "trade_no": order.RemoteID, "money": order.Amount, "type": "alipay", "trade_status": "TRADE_SUCCESS"})
	require.NoError(t, err)
	values := url.Values{}
	for key, value := range params {
		values.Set(key, value)
	}
	money, paymentStatus := "10.51", 0
	http.DefaultTransport = hostedControllerTransport(func(request *http.Request) (*http.Response, error) {
		require.Equal(t, "zpayz.cn", request.URL.Host)
		body, err := common.Marshal(map[string]any{"code": 1, "pid": cfg.MerchantID, "out_trade_no": order.TradeNo,
			"trade_no": order.RemoteID, "money": money, "status": paymentStatus, "type": "alipay"})
		require.NoError(t, err)
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(body))}, nil
	})
	callback := func() *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(response)
		ctx.Params = gin.Params{{Key: "provider", Value: "zpay"}, {Key: "env", Value: "live"}}
		ctx.Request = httptest.NewRequest(http.MethodGet, "/api/payments/zpay/webhook/live?"+values.Encode(), nil)
		HostedPaymentWebhook(ctx)
		return response
	}
	require.Equal(t, http.StatusServiceUnavailable, callback().Code)
	money = order.Amount
	require.Equal(t, http.StatusServiceUnavailable, callback().Code, "do not acknowledge a paid notification before the query confirms payment")
	var credited model.User
	require.NoError(t, model.DB.First(&credited, user.Id).Error)
	require.Equal(t, 50, credited.Quota)
	paymentStatus = 1
	for range 2 {
		response := callback()
		require.Equal(t, http.StatusOK, response.Code)
		require.Equal(t, "success", response.Body.String())
	}
	require.NoError(t, model.DB.First(&credited, user.Id).Error)
	require.Equal(t, 1050, credited.Quota)
}

func TestHostedSettingsRejectMerchantChangeWhenPaymentPending(t *testing.T) {
	cfg := hostedControllerFixture(t)
	order := &model.HostedPayment{TradeNo: "HP-pending", Provider: "lianlian", Identity: cfg.Identity("lianlian"), State: "pending", Amount: "10", Currency: "USD"}
	require.NoError(t, model.CreateHostedPayment(&model.TopUp{TradeNo: order.TradeNo, Status: common.TopUpStatusPending, PaymentProvider: "lianlian"}, order))
	cfg.StoreID = "other-store"
	raw, err := common.Marshal(map[string]any{"provider": "lianlian", "config": cfg})
	require.NoError(t, err)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPut, "/api/option/payments/hosted", bytes.NewReader(raw))
	SaveHostedPaymentSettings(ctx)
	require.Contains(t, recorder.Body.String(), "Pending payments exist")
	saved, err := setting.GetHostedPaymentSettings()
	require.NoError(t, err)
	require.Equal(t, "store", saved["lianlian"].StoreID)
}

func TestHostedSettingsRejectSandboxInProductionAndHideGeneralOptions(t *testing.T) {
	cfg := hostedControllerFixture(t)
	cfg.Environment = "test"
	raw, err := common.Marshal(map[string]any{"provider": "lianlian", "config": cfg})
	require.NoError(t, err)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPut, "/api/option/payments/hosted", bytes.NewReader(raw))
	SaveHostedPaymentSettings(ctx)
	require.Contains(t, recorder.Body.String(), "Payment environment does not match this instance")

	recorder = httptest.NewRecorder()
	ctx, _ = gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/option/", nil)
	GetOptions(ctx)
	require.NotContains(t, recorder.Body.String(), setting.HostedPaymentOption)
	require.NotContains(t, recorder.Body.String(), "fixture-api-key")
}

func TestHostedReconciliationRejectsConfigurationFromAnotherEnvironment(t *testing.T) {
	cfg := hostedControllerFixture(t)
	cfg.Environment = "test"
	order := &model.HostedPayment{Provider: "lianlian", Identity: cfg.Identity("lianlian")}
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest(http.MethodPost, "/reconcile", nil)
	_, err := verifyHostedOrderPayment(ctx, cfg, order, "", "")
	require.ErrorContains(t, err, "environment changed")
}

func TestHostedCustomerCheckEnforcesOwnershipAndRecoversAnExactSavedQuoteOnce(t *testing.T) {
	hostedControllerFixture(t)
	previousTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	t.Setenv("PAYMENTS_PROVIDERS", "none")
	cfg := setting.DefaultHostedPaymentConfig("zpay")
	cfg.Enabled, cfg.AcceptNew, cfg.MerchantID, cfg.APISecret = true, false, "123456", "fixture-secret"
	cfg.CheckoutHosts = []string{"zpayz.cn"}
	raw, err := common.Marshal(setting.HostedPaymentSettings{"zpay": cfg})
	require.NoError(t, err)
	require.NoError(t, model.UpdateOptionsBulk(map[string]string{setting.HostedPaymentOption: string(raw)}))
	user := model.User{Username: "payment-owner", Quota: 50, Status: common.UserStatusEnabled}
	require.NoError(t, model.DB.Create(&user).Error)
	order := model.HostedPayment{TradeNo: "HP-owner", Provider: "zpay", Identity: cfg.Identity("zpay"), Amount: "10.50", Currency: "CNY", RemoteID: "remote-owner", State: "pending"}
	require.NoError(t, model.CreateHostedPayment(&model.TopUp{UserId: user.Id, TradeNo: order.TradeNo, CreditedQuota: 1000,
		PaymentProvider: "zpay", PaymentMethod: "zpay", Status: common.TopUpStatusPending}, &order))
	queries, paid := 0, false
	http.DefaultTransport = hostedControllerTransport(func(request *http.Request) (*http.Response, error) {
		queries++
		status := 0
		if paid {
			status = 1
		}
		raw, err := common.Marshal(map[string]any{"code": 1, "pid": cfg.MerchantID, "out_trade_no": order.TradeNo,
			"trade_no": order.RemoteID, "money": order.Amount, "status": status, "type": "alipay"})
		require.NoError(t, err)
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(raw))}, nil
	})
	check := func(userID int, provider string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(recorder)
		ctx.Set("id", userID)
		ctx.Params = gin.Params{{Key: "provider", Value: provider}}
		ctx.Request = httptest.NewRequest(http.MethodPost, "/check", strings.NewReader(`{"trade_no":"HP-owner","payment_amount":"0.01","remote_id":"attacker"}`))
		CheckUserHostedPayment(ctx)
		return recorder
	}
	assert.Contains(t, check(user.Id+1, "zpay").Body.String(), "Order not found")
	assert.Contains(t, check(user.Id, "paypal").Body.String(), "Order not found")
	assert.Zero(t, queries)
	assert.Contains(t, check(user.Id, "zpay").Body.String(), `"payment_check_status":"pending"`)
	assert.Equal(t, 1, queries)
	check(user.Id, "zpay")
	assert.Equal(t, 1, queries, "repeat customer queries within 30 seconds must not hit the provider")
	require.NoError(t, model.RecordHostedPaymentCheck(order.TradeNo, "pending", time.Now().Unix()-31))
	paid = true
	assert.Contains(t, check(user.Id, "zpay").Body.String(), `"status":"success"`)
	check(user.Id, "zpay")
	assert.Equal(t, 2, queries, "a credited order is not queried again by the customer")
	// A callback/poller arriving after the customer check uses the same
	// transaction; it cannot credit the account a second time.
	stored, err := model.GetHostedPayment(order.TradeNo)
	require.NoError(t, err)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Go(func() { _, err := verifyHostedPayment(context.Background(), "", cfg, stored, "", ""); results <- err })
	}
	wg.Wait()
	close(results)
	for err := range results {
		require.NoError(t, err)
	}
	var credited model.User
	require.NoError(t, model.DB.First(&credited, user.Id).Error)
	assert.Equal(t, 1050, credited.Quota)
	var logs int64
	require.NoError(t, model.LOG_DB.Model(&model.Log{}).Where("user_id = ?", user.Id).Count(&logs).Error)
	assert.EqualValues(t, 1, logs)
}

func TestHostedOperationsValidateGenericUpdatesAndRecordMissingReferencesWithoutQuerying(t *testing.T) {
	cfg := hostedControllerFixture(t)
	for key, value := range map[string]string{
		"payment_operations.interval_minutes": "0", "payment_operations.batch_size": "101",
		"payment_operations.pending_alert_minutes": "1", "payment_operations.auto_reconcile_enabled": "yes",
	} {
		assert.Error(t, model.UpdateOptionsBulk(map[string]string{key: value}), key)
	}
	assert.False(t, setting.GetHostedPaymentOperations().AutoReconcileEnabled)
	require.NoError(t, model.UpdateOptionsBulk(map[string]string{"payment_operations.auto_reconcile_enabled": "true", "payment_operations.batch_size": "2"}))
	assert.True(t, hostedPaymentReconcileHandler{}.Enabled())
	assert.Equal(t, 2, setting.GetHostedPaymentOperations().BatchSize)
	order := model.HostedPayment{TradeNo: "HP-no-reference", Provider: "lianlian", Identity: cfg.Identity("lianlian"), Amount: "10.00", Currency: "USD", State: "creation_unknown"}
	require.NoError(t, model.CreateHostedPayment(&model.TopUp{TradeNo: order.TradeNo, PaymentProvider: order.Provider, Status: common.TopUpStatusPending}, &order))
	previousTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	http.DefaultTransport = hostedControllerTransport(func(*http.Request) (*http.Response, error) {
		t.Error("a missing reference must not trigger a guessed provider query")
		return nil, fmt.Errorf("unexpected network")
	})
	_, err := verifyHostedPayment(context.Background(), "", cfg, &order, "", "")
	require.ErrorContains(t, err, "operator recovery")
	stored, err := model.GetHostedPayment(order.TradeNo)
	require.NoError(t, err)
	assert.Equal(t, "needs_reference", stored.CheckStatus)
	assert.Positive(t, stored.LastCheckedAt)
	cfg.Enabled = false
	_, err = verifyHostedPayment(context.Background(), "", cfg, stored, "", "")
	require.Error(t, err)
	stored, err = model.GetHostedPayment(order.TradeNo)
	require.NoError(t, err)
	assert.Equal(t, "configuration_unavailable", stored.CheckStatus)
}

func TestHostedReconciliationWorkerBoundsTheQueueCreditsVerifiedPaymentsAndReleasesItsLease(t *testing.T) {
	lianlian := hostedControllerFixture(t)
	zpay := setting.DefaultHostedPaymentConfig("zpay")
	zpay.Enabled, zpay.AcceptNew, zpay.MerchantID, zpay.APISecret = true, false, "123456", "fixture-secret"
	zpay.CheckoutHosts = []string{"zpayz.cn"}
	raw, err := common.Marshal(setting.HostedPaymentSettings{"lianlian": lianlian, "zpay": zpay})
	require.NoError(t, err)
	require.NoError(t, model.UpdateOptionsBulk(map[string]string{
		setting.HostedPaymentOption: string(raw), "payment_operations.auto_reconcile_enabled": "true",
		"payment_operations.batch_size": "2", "payment_operations.interval_minutes": "1",
	}))
	t.Setenv("PAYMENTS_PROVIDERS", "none") // Drain existing payments with new sales paused.
	user := model.User{Username: "worker-owner", Quota: 50, Status: common.UserStatusEnabled}
	require.NoError(t, model.DB.Create(&user).Error)
	now := time.Now().Unix()
	orders := []model.HostedPayment{
		{TradeNo: "HP-worker-missing", Provider: "lianlian", Identity: lianlian.Identity("lianlian"), Amount: "10.00", Currency: "USD", State: "creation_unknown", CreatedAt: now - 180},
		{TradeNo: "HP-worker-paid", Provider: "zpay", Identity: zpay.Identity("zpay"), Amount: "10.50", Currency: "CNY", State: "pending", RemoteID: "remote-worker", CreatedAt: now - 120},
		{TradeNo: "HP-worker-next", Provider: "zpay", Identity: zpay.Identity("zpay"), Amount: "10.50", Currency: "CNY", State: "pending", RemoteID: "remote-next", CreatedAt: now - 90},
	}
	for index := range orders {
		order := &orders[index]
		require.NoError(t, model.CreateHostedPayment(&model.TopUp{UserId: user.Id, TradeNo: order.TradeNo, CreditedQuota: 1000,
			PaymentProvider: order.Provider, PaymentMethod: order.Provider, Status: common.TopUpStatusPending}, order))
	}
	previousTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	queries := 0
	http.DefaultTransport = hostedControllerTransport(func(request *http.Request) (*http.Response, error) {
		queries++
		require.Equal(t, "HP-worker-paid", request.URL.Query().Get("out_trade_no"))
		raw, err := common.Marshal(map[string]any{"code": 1, "pid": zpay.MerchantID, "out_trade_no": orders[1].TradeNo,
			"trade_no": orders[1].RemoteID, "money": orders[1].Amount, "status": 1, "type": "alipay"})
		require.NoError(t, err)
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(raw))}, nil
	})
	task, err := model.CreateSystemTask(model.SystemTaskTypeHostedPaymentReconcile, nil, nil)
	require.NoError(t, err)
	claimed, acquired, err := model.ClaimSystemTask(task.ID, task.Type, "fixture-worker", now+300)
	require.NoError(t, err)
	require.True(t, acquired)
	hostedPaymentReconcileHandler{}.Run(context.Background(), claimed, "fixture-worker")
	finished, err := model.GetSystemTaskByTaskID(task.TaskID)
	require.NoError(t, err)
	require.Equal(t, model.SystemTaskStatusSucceeded, finished.Status)
	assert.JSONEq(t, `{"checked":2,"verified_paid":1,"unresolved":1,"overdue":0}`, finished.Result)
	assert.Equal(t, 1, queries)
	var credited model.User
	require.NoError(t, model.DB.First(&credited, user.Id).Error)
	assert.Equal(t, 1050, credited.Quota)
	next, err := model.GetPendingHostedPayments("", now, now, 1)
	require.NoError(t, err)
	require.Len(t, next, 1)
	assert.Equal(t, "HP-worker-next", next[0].TradeNo, "missing references move behind unchecked orders")
	var leases int64
	require.NoError(t, model.DB.Model(&model.SystemTaskLock{}).Count(&leases).Error)
	assert.Zero(t, leases)
}
