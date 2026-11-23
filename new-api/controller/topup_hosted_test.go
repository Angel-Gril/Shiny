package controller

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func hostedControllerFixture(t *testing.T) setting.HostedPaymentConfig {
	t.Helper()
	previousDB, previousLogDB := model.DB, model.LOG_DB
	common.OptionMapRWMutex.Lock()
	previousOptions := common.OptionMap
	common.OptionMap = map[string]string{}
	common.OptionMapRWMutex.Unlock()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	model.DB, model.LOG_DB = db, db
	require.NoError(t, db.AutoMigrate(&model.Option{}, &model.TopUp{}, &model.HostedPayment{}, &model.User{}))
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.OptionMapRWMutex.Lock()
		common.OptionMap = previousOptions
		common.OptionMapRWMutex.Unlock()
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
