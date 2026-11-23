package controller

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
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
	require.NoError(t, db.AutoMigrate(&model.Option{}, &model.TopUp{}, &model.HostedPayment{}, &model.User{}, &model.Log{}, &model.SystemTask{}))
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
