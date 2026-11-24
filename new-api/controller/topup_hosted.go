package controller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/mail"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
)

var hostedSettingsMutex sync.RWMutex

func GetHostedPaymentSettings(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	settings, err := setting.GetHostedPaymentSettings()
	if err != nil {
		common.ApiErrorT(c, "Failed to load payment settings")
		return
	}
	for provider, cfg := range settings {
		settings[provider] = cfg.Public(provider)
	}
	common.ApiSuccess(c, settings)
}

func SaveHostedPaymentSettings(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64*1024)
	var request struct {
		Provider string                      `json:"provider"`
		Config   setting.HostedPaymentConfig `json:"config"`
	}
	if err := common.DecodeJson(c.Request.Body, &request); err != nil || !slices.Contains(setting.HostedPaymentProviders, request.Provider) {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	hostedSettingsMutex.Lock()
	defer hostedSettingsMutex.Unlock()
	settings, err := setting.GetHostedPaymentSettings()
	if err != nil {
		common.ApiErrorT(c, "Failed to load payment settings")
		return
	}
	saved := settings[request.Provider]
	request.Config.MergeSecrets(saved)
	request.Config.CheckoutHosts = slices.DeleteFunc(request.Config.CheckoutHosts, func(host string) bool { return strings.TrimSpace(host) == "" })
	for i, host := range request.Config.CheckoutHosts {
		request.Config.CheckoutHosts[i] = strings.ToLower(strings.TrimSpace(host))
	}
	if request.Config.Enabled && request.Config.Environment != setting.HostedPaymentsEnvironment() {
		common.ApiErrorT(c, "Payment environment does not match this instance")
		return
	}
	if request.Config.Enabled && request.Config.AcceptNew && !setting.HostedPaymentSelected(request.Provider) {
		common.ApiErrorT(c, "Payment provider is not selected for this deployment")
		return
	}
	if err := request.Config.Validate(request.Provider); err != nil {
		common.ApiErrorT(c, "Payment configuration is incomplete or invalid")
		return
	}
	if request.Config.Enabled && request.Config.AcceptNew && !isPaymentComplianceConfirmed() {
		requirePaymentCompliance(c)
		return
	}
	if request.Provider == "lianlian" && request.Config.Enabled {
		if err := service.ValidateHostedSigningKeys(request.Config); err != nil {
			common.ApiErrorT(c, "Payment configuration is incomplete or invalid")
			return
		}
	}
	if request.Provider == setting.HostedProviderPancake && request.Config.Enabled {
		if err := service.ValidateHostedPancakeKeys(request.Config); err != nil {
			common.ApiErrorT(c, "Payment configuration is incomplete or invalid")
			return
		}
	}
	pending, err := model.HasPendingHostedPayments(request.Provider)
	if err != nil {
		common.ApiErrorT(c, "Failed to load payment settings")
		return
	}
	if pending && (!request.Config.Enabled || saved.Identity(request.Provider) != request.Config.Identity(request.Provider)) {
		common.ApiErrorT(c, "Pending payments exist. Pause new payments before changing the merchant or environment.")
		return
	}
	settings[request.Provider] = request.Config
	raw, err := common.Marshal(settings)
	if err != nil || model.UpdateOptionsBulk(map[string]string{setting.HostedPaymentOption: string(raw)}) != nil {
		common.ApiErrorT(c, "Failed to save configuration")
		return
	}
	logger.LogInfo(c.Request.Context(), common.LogText("Hosted payment settings updated provider=%s user_id=%d", request.Provider, c.GetInt("id")))
	common.ApiSuccess(c, request.Config.Public(request.Provider))
}

func hostedPaymentConfig(c *gin.Context, newPayment bool) (setting.HostedPaymentConfig, bool) {
	provider := c.Param("provider")
	settings, err := setting.GetHostedPaymentSettings()
	cfg, ok := settings[provider]
	if err != nil || !ok || !cfg.Enabled || cfg.Validate(provider) != nil || cfg.Environment != setting.HostedPaymentsEnvironment() ||
		(newPayment && (!cfg.AcceptNew || !setting.HostedPaymentSelected(provider) || !isPaymentComplianceConfirmed())) {
		paymentError(c, common.NewMessage("Payment method is unavailable"))
		return cfg, false
	}
	return cfg, true
}

func hostedPaymentQuote(c *gin.Context, cfg setting.HostedPaymentConfig) (int64, int, decimal.Decimal, bool) {
	var request AmountRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil || request.Amount <= 0 {
		paymentError(c, common.NewMessage("Invalid parameters"))
		return 0, 0, decimal.Zero, false
	}
	quota, err := validateTopUpQuota(request.Amount)
	if err != nil || rejectInvalidTopUpQuota(c, c.GetInt("id"), request.Amount) {
		if err != nil {
			paymentError(c, err)
		}
		return 0, 0, decimal.Zero, false
	}
	units := decimal.NewFromInt(int64(quota)).Div(decimal.NewFromFloat(common.QuotaPerUnit))
	if units.LessThan(decimal.NewFromInt(cfg.MinTopUp)) {
		paymentError(c, common.NewMessage("Top-up amount cannot be less than {{min}}", map[string]any{"min": cfg.MinTopUp}))
		return 0, 0, decimal.Zero, false
	}
	group, err := model.GetUserGroup(c.GetInt("id"), true)
	if err != nil {
		paymentError(c, common.NewMessage("Failed to get the user group"))
		return 0, 0, decimal.Zero, false
	}
	ratio := common.GetTopupGroupRatio(group)
	if ratio == 0 {
		ratio = 1
	}
	discount := operation_setting.GetPaymentSetting().AmountDiscount[int(request.Amount)]
	if discount == 0 {
		discount = 1
	}
	rate, _ := decimal.NewFromString(cfg.UnitPrice)
	if math.IsNaN(ratio) || math.IsInf(ratio, 0) || math.IsNaN(discount) || math.IsInf(discount, 0) || ratio <= 0 || discount <= 0 || ratio > 1000000 || discount > 1000000 {
		paymentError(c, common.NewMessage("Payment configuration is incomplete or invalid"))
		return 0, 0, decimal.Zero, false
	}
	money := units.Mul(rate).Mul(decimal.NewFromFloat(ratio)).Mul(decimal.NewFromFloat(discount)).Round(2)
	if money.LessThan(decimal.NewFromFloat(0.01)) || money.GreaterThan(decimal.NewFromInt(999999999)) {
		paymentError(c, common.NewMessage("Invalid top-up amount"))
		return 0, 0, decimal.Zero, false
	}
	return units.IntPart(), quota, money, true
}

func RequestHostedAmount(c *gin.Context) {
	cfg, ok := hostedPaymentConfig(c, true)
	if !ok {
		return
	}
	_, _, money, ok := hostedPaymentQuote(c, cfg)
	if ok {
		c.JSON(http.StatusOK, gin.H{"message": "success", "data": money.StringFixed(2), "currency": cfg.Currency})
	}
}

func RequestHostedPay(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	hostedSettingsMutex.RLock()
	locked := true
	defer func() {
		if locked {
			hostedSettingsMutex.RUnlock()
		}
	}()
	cfg, ok := hostedPaymentConfig(c, true)
	if !ok {
		return
	}
	units, quota, money, ok := hostedPaymentQuote(c, cfg)
	if !ok {
		return
	}
	provider := c.Param("provider")
	// Pin browser return and provider notifications to the configured RU site.
	origin := strings.TrimRight(system_setting.ServerAddress, "/")
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		paymentError(c, common.NewMessage("Payment configuration is incomplete or invalid"))
		return
	}
	tradeNo := "HP-" + common.GetRandomString(24)
	options := service.HostedCheckoutOptions{
		ReturnURL: origin + "/wallet?show_history=true", WebhookURL: origin + "/api/payments/" + provider + "/webhook/" + cfg.Environment,
		CustomerID: "user-" + fmt.Sprint(c.GetInt("id")), ClientIP: c.ClientIP(),
	}
	if provider == "apirone" {
		callback, _ := url.Parse(options.WebhookURL)
		query := callback.Query()
		query.Set("ref", tradeNo)
		query.Set("token", service.HostedApironeCallbackToken(cfg.WebhookSecret, tradeNo))
		callback.RawQuery = query.Encode()
		options.WebhookURL = callback.String()
	}
	callbackHash := sha256.Sum256([]byte(options.WebhookURL))
	order := &model.HostedPayment{TradeNo: tradeNo, Provider: provider, Identity: cfg.Identity(provider),
		Currency: cfg.Currency, Amount: money.StringFixed(2), State: "creating", CreatedAt: time.Now().Unix(),
		ProductID: cfg.ProductID, CustomerID: options.CustomerID, CallbackHash: hex.EncodeToString(callbackHash[:])}
	email := ""
	if slices.Contains([]string{setting.HostedProviderCreem, setting.HostedProviderPancake, "platega", "freekassa", "lava"}, provider) {
		email, err = model.GetUserEmail(c.GetInt("id"))
		parsed, parseErr := mail.ParseAddress(email)
		if err != nil || parseErr != nil || parsed.Address != email || len(email) > 254 {
			paymentError(c, common.NewMessage("Add a valid email address to your account before using this payment method"))
			return
		}
		emailHash := sha256.Sum256([]byte(strings.ToLower(email)))
		order.CustomerHash = hex.EncodeToString(emailHash[:])
	}
	if provider == setting.HostedProviderCreem {
		minor, err := service.HostedMinorAmount(order.Amount)
		if err != nil || minor < 100 || minor > 99999999 {
			paymentError(c, common.NewMessage("Invalid top-up amount"))
			return
		}
	}
	topUp := &model.TopUp{UserId: c.GetInt("id"), Amount: units, CreditedQuota: int64(quota), Money: money.InexactFloat64(),
		TradeNo: tradeNo, PaymentMethod: provider, PaymentProvider: provider, CreateTime: order.CreatedAt, Status: common.TopUpStatusPending}
	if err := model.CreateHostedPayment(topUp, order); err != nil {
		paymentError(c, common.NewMessage("Failed to create order"))
		return
	}
	hostedSettingsMutex.RUnlock()
	locked = false
	// The order and immutable quote exist before any external create request.
	client := service.NewHostedPaymentClient(provider, cfg)
	options.CustomerEmail = email
	if provider == "apirone" {
		if err := client.PrepareApironeQuote(c.Request.Context(), order); err != nil {
			_ = model.MarkHostedCreationUnknown(tradeNo)
			paymentError(c, common.NewMessage("Payment creation could not be confirmed. Check this order before starting another payment."))
			return
		}
		if err := model.SaveHostedCoinQuote(order); err != nil {
			paymentError(c, common.NewMessage("Payment creation could not be confirmed. Check this order before starting another payment."))
			return
		}
	}
	checkout, err := client.Create(c.Request.Context(), order, options)
	if err != nil {
		_ = model.MarkHostedCreationUnknown(tradeNo)
		logger.LogWarn(c.Request.Context(), common.LogText("Hosted checkout creation uncertain provider=%s trade_no=%s", provider, tradeNo))
		paymentError(c, common.NewMessage("Payment creation could not be confirmed. Check this order before starting another payment."))
		return
	}
	checkoutToSave := checkout.URL
	if provider == setting.HostedProviderPancake {
		// The buyer session token is needed only for the immediate redirect.
		// Never retain a usable session credential in the order table.
		checkoutToSave = ""
	}
	if err := model.SaveHostedCheckout(tradeNo, checkout.RemoteID, checkoutToSave, checkout.SessionID); err != nil {
		paymentError(c, common.NewMessage("Payment creation could not be confirmed. Check this order before starting another payment."))
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "success", "data": gin.H{"checkout_url": checkout.URL, "order_id": tradeNo,
		"payment_amount": order.Amount, "currency": order.Currency}})
}

func verifyHostedOrderPayment(c *gin.Context, cfg setting.HostedPaymentConfig, order *model.HostedPayment, remoteID, paymentID string) (bool, error) {
	return verifyHostedPayment(c.Request.Context(), c.ClientIP(), cfg, order, remoteID, paymentID)
}

func verifyHostedPayment(ctx context.Context, callerIP string, cfg setting.HostedPaymentConfig, order *model.HostedPayment, remoteID, paymentID string) (paid bool, verifyErr error) {
	checkStatus := "verification_failed"
	defer func() {
		if err := model.RecordHostedPaymentCheck(order.TradeNo, checkStatus, time.Now().Unix()); err != nil {
			logger.LogWarn(ctx, common.LogText("Hosted payment check could not be recorded provider=%s trade_no=%s", order.Provider, order.TradeNo))
		}
	}()
	if !cfg.Enabled || cfg.Environment != setting.HostedPaymentsEnvironment() || order.Identity != cfg.Identity(order.Provider) {
		checkStatus = "configuration_unavailable"
		return false, errors.New("payment merchant or environment changed")
	}
	if remoteID == "" {
		remoteID = order.RemoteID
	}
	if paymentID == "" {
		paymentID = order.PaymentID
	}
	if (order.Provider == "nowpayments" && paymentID == "") ||
		(slices.Contains([]string{"lianlian", "paypal", setting.HostedProviderCreem, "platega", "lava", "cryptocloud", "oxapay", "apirone"}, order.Provider) && remoteID == "") {
		checkStatus = "needs_reference"
		return false, errors.New("payment reference requires operator recovery")
	}
	if order.RemoteID != "" && remoteID != order.RemoteID {
		return false, model.ErrPaymentMethodMismatch
	}
	// PayPal APPROVED events can trigger capture; the official query is authoritative.
	queried := *order
	queried.RemoteID = remoteID
	client := service.NewHostedPaymentClient(order.Provider, cfg)
	result, err := client.Query(ctx, &queried, remoteID, paymentID)
	if err != nil {
		return false, err
	}
	expected, _ := decimal.NewFromString(order.Amount)
	amount, err := decimal.NewFromString(result.Amount)
	if err != nil || !amount.Equal(expected) || result.Currency != order.Currency || result.Reference != order.TradeNo ||
		result.RemoteID == "" || (order.RemoteID != "" && result.RemoteID != order.RemoteID) {
		return false, errors.New("provider query does not match payment order")
	}
	if err := model.BindHostedPayment(order.TradeNo, result.RemoteID, result.PaymentID); err != nil {
		return false, err
	}
	if !result.Paid {
		checkStatus = "pending"
		return false, nil
	}
	verified := *order
	verified.RemoteID, verified.PaymentID = result.RemoteID, result.PaymentID
	_, err = model.CompleteHostedPayment(verified, callerIP)
	if err == nil {
		checkStatus = "paid"
	}
	return err == nil, err
}

func HostedPaymentWebhook(c *gin.Context) {
	provider, environment := c.Param("provider"), c.Param("env")
	if c.Request.Method == http.MethodGet && provider != "zpay" {
		c.Status(http.StatusMethodNotAllowed)
		return
	}
	settings, err := setting.GetHostedPaymentSettings()
	cfg, exists := settings[provider]
	if err != nil || !exists || !cfg.Enabled || cfg.Environment != environment || environment != setting.HostedPaymentsEnvironment() {
		c.String(http.StatusForbidden, "payment webhook unavailable")
		return
	}
	var body []byte
	if c.Request.Method == http.MethodGet {
		body = []byte(c.Request.URL.RawQuery)
	} else {
		body, err = io.ReadAll(io.LimitReader(c.Request.Body, 256*1024+1))
	}
	if err != nil || len(body) > 256*1024 {
		c.String(http.StatusBadRequest, "invalid payload")
		return
	}
	client := service.NewHostedPaymentClient(provider, cfg)
	headers := c.Request.Header.Clone()
	if provider == "apirone" {
		values := c.Request.URL.Query()
		if len(values["ref"]) != 1 || len(values["token"]) != 1 {
			c.String(http.StatusUnauthorized, "invalid payment notification")
			return
		}
		headers.Set("X-Shiny-Apirone-Reference", values.Get("ref"))
		headers.Set("X-Shiny-Apirone-Token", values.Get("token"))
	}
	event, err := client.VerifyWebhook(c.Request.Context(), body, headers)
	if err != nil {
		c.String(http.StatusUnauthorized, "invalid payment notification")
		return
	}
	acknowledgement := "OK"
	if provider == "zpay" {
		acknowledgement = "success"
	} else if provider == "freekassa" {
		acknowledgement = "YES"
	} else if provider == "oxapay" {
		acknowledgement = "ok"
	} else if provider == "apirone" {
		acknowledgement = "*ok*"
	}
	if event == nil {
		c.String(http.StatusOK, acknowledgement)
		return
	}
	var order *model.HostedPayment
	if event.Reference != "" {
		order, err = model.GetHostedPayment(event.Reference)
	} else if event.RemoteID != "" {
		order, err = model.GetHostedPaymentByRemoteID(provider, event.RemoteID)
	} else {
		err = errors.New("missing payment reference")
	}
	if err != nil || order.Provider != provider {
		c.String(http.StatusServiceUnavailable, "retry")
		return
	}
	if event.CustomerID != "" && event.CustomerID != order.CustomerID {
		c.String(http.StatusUnauthorized, "payment customer mismatch")
		return
	}
	LockOrder(order.TradeNo)
	defer UnlockOrder(order.TradeNo)
	if paid, err := verifyHostedOrderPayment(c, cfg, order, event.RemoteID, event.PaymentID); err != nil || (event.ExpectsPaid && !paid) {
		logger.LogWarn(c.Request.Context(), common.LogText("Hosted payment verification failed provider=%s trade_no=%s", provider, order.TradeNo))
		c.String(http.StatusServiceUnavailable, "retry")
		return
	}
	c.String(http.StatusOK, acknowledgement)
}

func ReconcileHostedPayment(c *gin.Context) {
	var request struct {
		TradeNo   string `json:"trade_no"`
		RemoteID  string `json:"remote_id"`
		PaymentID string `json:"payment_id"`
	}
	if common.DecodeJson(c.Request.Body, &request) != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	order, err := model.GetHostedPayment(request.TradeNo)
	if err != nil || order.Provider != c.Param("provider") {
		common.ApiErrorT(c, "Order not found")
		return
	}
	settings, err := setting.GetHostedPaymentSettings()
	if err != nil {
		common.ApiErrorT(c, "Failed to load payment settings")
		return
	}
	LockOrder(order.TradeNo)
	defer UnlockOrder(order.TradeNo)
	paid, err := verifyHostedOrderPayment(c, settings[order.Provider], order, request.RemoteID, request.PaymentID)
	if err != nil {
		common.ApiErrorT(c, "Payment could not be verified. Check the provider order and try again.")
		return
	}
	logger.LogInfo(c.Request.Context(), common.LogText("Hosted payment reconciled provider=%s trade_no=%s paid=%t user_id=%d", order.Provider, order.TradeNo, paid, c.GetInt("id")))
	common.ApiSuccess(c, gin.H{"paid": paid, "trade_no": order.TradeNo})
}

func appendHostedPaymentMethods(payMethods []map[string]string) []map[string]string {
	settings, err := setting.GetHostedPaymentSettings()
	if err != nil || !isPaymentComplianceConfirmed() {
		return payMethods
	}
	names := map[string]string{"cispay": "cisPay", "lianlian": "LianLian", "nowpayments": "Crypto · NOWPayments", "paypal": "PayPal", "zpay": "ZPAY",
		setting.HostedProviderCreem: "Creem", setting.HostedProviderPancake: "Waffo Pancake", "platega": "Platega",
		"freekassa": "FreeKassa", "lava": "Lava.top", "cryptocloud": "TryBit", "oxapay": "OxaPay", "apirone": "Apirone"}
	for _, provider := range setting.HostedPaymentProviders {
		cfg := settings[provider]
		if setting.HostedPaymentSelected(provider) && cfg.Enabled && cfg.AcceptNew && cfg.Validate(provider) == nil && cfg.Environment == setting.HostedPaymentsEnvironment() {
			payMethods = append(payMethods, map[string]string{"name": names[provider], "type": provider,
				"min_topup": fmt.Sprint(cfg.MinTopUp), "currency": cfg.Currency, "unit_price": cfg.UnitPrice})
		}
	}
	return payMethods
}
