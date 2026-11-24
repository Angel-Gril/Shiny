package controller

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/gin-gonic/gin"
)

func GetHostedPaymentOperations(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	common.ApiSuccess(c, setting.GetHostedPaymentOperations())
}

func SaveHostedPaymentOperations(c *gin.Context) {
	var request setting.HostedPaymentOperations
	if common.DecodeJson(c.Request.Body, &request) != nil || request.IntervalMinutes < 1 || request.IntervalMinutes > 1440 ||
		request.BatchSize < 1 || request.BatchSize > 100 || request.PendingAlertMinutes < 5 || request.PendingAlertMinutes > 10080 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	values := map[string]string{
		"payment_operations.auto_reconcile_enabled": common.Interface2String(request.AutoReconcileEnabled),
		"payment_operations.interval_minutes":       common.Interface2String(request.IntervalMinutes),
		"payment_operations.batch_size":             common.Interface2String(request.BatchSize),
		"payment_operations.pending_alert_minutes":  common.Interface2String(request.PendingAlertMinutes),
	}
	if err := model.UpdateOptionsBulk(values); err != nil {
		common.ApiErrorT(c, "Failed to save configuration")
		return
	}
	recordManageAudit(c, "payments.operations.update", map[string]any{"auto_reconcile_enabled": request.AutoReconcileEnabled})
	common.ApiSuccess(c, setting.GetHostedPaymentOperations())
}

func GetHostedPaymentQueue(c *gin.Context) {
	if !slices.Contains(setting.HostedPaymentProviders, c.Param("provider")) {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	settings := setting.GetHostedPaymentOperations()
	items, total, overdue, err := model.GetHostedPaymentQueue(c.Param("provider"), time.Now().Unix()-int64(settings.PendingAlertMinutes)*60)
	if err != nil {
		common.ApiErrorT(c, "Failed to load billing history")
		return
	}
	c.Header("Cache-Control", "no-store")
	common.ApiSuccess(c, gin.H{"items": items, "total": total, "overdue": overdue, "alert_minutes": settings.PendingAlertMinutes})
}

// Customers can query only their own order, using persisted provider references.
// They cannot supply a merchant, amount, environment or provider payment ID.
func CheckUserHostedPayment(c *gin.Context) {
	var request struct {
		TradeNo string `json:"trade_no"`
	}
	if common.DecodeJson(c.Request.Body, &request) != nil || len(request.TradeNo) < 1 || len(request.TradeNo) > 64 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	LockOrder(request.TradeNo)
	defer UnlockOrder(request.TradeNo)
	topup := model.GetTopUpByTradeNo(request.TradeNo)
	if topup == nil || topup.UserId != c.GetInt("id") || topup.PaymentProvider != c.Param("provider") {
		common.ApiErrorT(c, "Order not found")
		return
	}
	order, err := model.GetHostedPayment(request.TradeNo)
	if err != nil || order.Provider != c.Param("provider") {
		common.ApiErrorT(c, "Order not found")
		return
	}
	if topup.Status == common.TopUpStatusPending && order.LastCheckedAt <= time.Now().Unix()-30 {
		settings, err := setting.GetHostedPaymentSettings()
		if err != nil {
			common.ApiErrorT(c, "Payment could not be verified. Check the provider order and try again.")
			return
		}
		_, _ = verifyHostedOrderPayment(c, settings[order.Provider], order, "", "")
		order, err = model.GetHostedPayment(request.TradeNo)
		if err != nil {
			common.ApiErrorT(c, "Order not found")
			return
		}
		topup = model.GetTopUpByTradeNo(request.TradeNo)
	}
	if topup == nil {
		common.ApiErrorT(c, "Order not found")
		return
	}
	c.Header("Cache-Control", "no-store")
	common.ApiSuccess(c, gin.H{"trade_no": order.TradeNo, "status": topup.Status, "payment_state": order.State,
		"payment_check_status": order.CheckStatus, "last_checked_at": order.LastCheckedAt})
}

type hostedPaymentReconcileHandler struct{}

func (hostedPaymentReconcileHandler) Type() string { return model.SystemTaskTypeHostedPaymentReconcile }
func (hostedPaymentReconcileHandler) Enabled() bool {
	return setting.GetHostedPaymentOperations().AutoReconcileEnabled
}
func (hostedPaymentReconcileHandler) Interval() time.Duration {
	return time.Duration(setting.GetHostedPaymentOperations().IntervalMinutes) * time.Minute
}
func (hostedPaymentReconcileHandler) NewPayload() any { return nil }

func (hostedPaymentReconcileHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	operations := setting.GetHostedPaymentOperations()
	settings, err := setting.GetHostedPaymentSettings()
	if err != nil {
		finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, nil, errors.New("payment settings unavailable"))
		return
	}
	checked, credited, unresolved, overdue := 0, 0, 0, int64(0)
	// Bound provider time as well as batch size; this task renews its DB lease
	// through the existing runner and never modifies unverified money facts.
	runCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	_, _, overdue, err = model.GetHostedPaymentQueue("", time.Now().Unix()-int64(operations.PendingAlertMinutes)*60)
	if err == nil {
		var orders []model.HostedPayment
		// Across providers, oldest unchecked orders go first. A busy provider
		// cannot starve others, and missing references move to the back.
		orders, err = model.GetPendingHostedPayments("", time.Now().Unix()-60,
			time.Now().Unix()-int64(operations.IntervalMinutes)*60, operations.BatchSize)
		for _, order := range orders {
			if runCtx.Err() != nil {
				err = errors.New("payment reconciliation interrupted")
				break
			}
			LockOrder(order.TradeNo)
			paid, verifyErr := verifyHostedPayment(runCtx, "", settings[order.Provider], &order, "", "")
			UnlockOrder(order.TradeNo)
			checked++
			if paid {
				credited++
			} else if verifyErr != nil {
				unresolved++
			}
		}
	}
	if overdue > 0 {
		service.NotifyChannelWatchers("hosted_payment_pending", func(lang string) (string, string) {
			return i18n.Translate(lang, i18n.MsgPaymentPendingSubject), i18n.Translate(lang, i18n.MsgPaymentPendingContent, map[string]any{
				"Count": overdue, "Minutes": operations.PendingAlertMinutes,
			})
		})
	}
	status := model.SystemTaskStatusSucceeded
	if err != nil {
		status = model.SystemTaskStatusFailed
	}
	finishSystemTaskHandler(task, runnerID, status, map[string]any{"checked": checked, "verified_paid": credited, "unresolved": unresolved, "overdue": overdue}, err)
}
