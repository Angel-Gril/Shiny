package model

import (
	"errors"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
)

// HostedPayment preserves the payment facts independently of mutable admin
// settings. No card data, provider secrets or raw webhook payloads are stored.
type HostedPayment struct {
	TradeNo       string `json:"trade_no" gorm:"primaryKey;type:varchar(64)"`
	Provider      string `json:"provider" gorm:"type:varchar(32);index"`
	Identity      string `json:"-" gorm:"type:varchar(64)"`
	Currency      string `json:"currency" gorm:"type:varchar(3)"`
	Amount        string `json:"payment_amount" gorm:"type:varchar(32)"`
	RemoteID      string `json:"remote_id" gorm:"type:varchar(128)"`
	PaymentID     string `json:"payment_id" gorm:"type:varchar(128)"`
	CheckoutURL   string `json:"-" gorm:"type:text"`
	State         string `json:"payment_state" gorm:"type:varchar(32)"`
	CreatedAt     int64  `json:"created_at"`
	LastCheckedAt int64  `json:"last_checked_at" gorm:"default:0;index"`
	CheckStatus   string `json:"check_status" gorm:"type:varchar(32);default:''"`
}

// The queue contains no checkout links, customer credentials or raw responses.
// LastCheckedAt provides fair scheduling when some orders need manual IDs.
func GetPendingHostedPayments(provider string, createdBefore, checkedBefore int64, limit int) ([]HostedPayment, error) {
	var orders []HostedPayment
	topupTable := DB.NamingStrategy.TableName("TopUp")
	query := DB.Model(&HostedPayment{}).
		Where("state <> ? AND created_at <= ? AND last_checked_at <= ?", "paid", createdBefore, checkedBefore).
		Where("trade_no IN (?)", DB.Table(topupTable).Select("trade_no").Where("status = ?", common.TopUpStatusPending)).
		Order("last_checked_at ASC").Order("created_at ASC").Order("trade_no ASC").Limit(min(max(limit, 1), 100))
	if provider != "" {
		query = query.Where("provider = ?", provider)
	}
	err := query.Find(&orders).Error
	return orders, err
}

func RecordHostedPaymentCheck(tradeNo, status string, checkedAt int64) error {
	switch status {
	case "pending", "paid", "verification_failed", "needs_reference", "configuration_unavailable":
	default:
		return errors.New("invalid payment check status")
	}
	return DB.Model(&HostedPayment{}).Where("trade_no = ?", tradeNo).
		Updates(map[string]any{"last_checked_at": checkedAt, "check_status": status}).Error
}

type HostedPaymentQueueItem struct {
	TradeNo       string `json:"trade_no"`
	Provider      string `json:"provider"`
	Currency      string `json:"currency"`
	Amount        string `json:"payment_amount"`
	State         string `json:"payment_state"`
	CreatedAt     int64  `json:"created_at"`
	LastCheckedAt int64  `json:"last_checked_at"`
	CheckStatus   string `json:"check_status"`
}

func GetHostedPaymentQueue(provider string, alertBefore int64) ([]HostedPaymentQueueItem, int64, int64, error) {
	orders, err := GetPendingHostedPayments(provider, time.Now().Unix(), time.Now().Unix(), 100)
	if err != nil {
		return nil, 0, 0, err
	}
	topupTable := DB.NamingStrategy.TableName("TopUp")
	query := DB.Model(&HostedPayment{}).Where("state <> ?", "paid").
		Where("trade_no IN (?)", DB.Table(topupTable).Select("trade_no").Where("status = ?", common.TopUpStatusPending))
	if provider != "" {
		query = query.Where("provider = ?", provider)
	}
	var total, overdue int64
	if err := query.Session(&gorm.Session{}).Count(&total).Error; err != nil {
		return nil, 0, 0, err
	}
	if err := query.Session(&gorm.Session{}).Where("created_at <= ?", alertBefore).Count(&overdue).Error; err != nil {
		return nil, 0, 0, err
	}
	items := make([]HostedPaymentQueueItem, 0, len(orders))
	for _, order := range orders {
		items = append(items, HostedPaymentQueueItem{TradeNo: order.TradeNo, Provider: order.Provider, Currency: order.Currency,
			Amount: order.Amount, State: order.State, CreatedAt: order.CreatedAt, LastCheckedAt: order.LastCheckedAt, CheckStatus: order.CheckStatus})
	}
	return items, total, overdue, nil
}

func CreateHostedPayment(topUp *TopUp, payment *HostedPayment) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(topUp).Error; err != nil {
			return err
		}
		return tx.Create(payment).Error
	})
}

func GetHostedPayment(tradeNo string) (*HostedPayment, error) {
	var payment HostedPayment
	if err := DB.Where("trade_no = ?", tradeNo).First(&payment).Error; err != nil {
		return nil, err
	}
	return &payment, nil
}

func AttachHostedPaymentDetails(topups []*TopUp) error {
	refs := []string{}
	for _, topup := range topups {
		if topup.PaymentProvider == "cispay" || topup.PaymentProvider == "lianlian" ||
			topup.PaymentProvider == "nowpayments" || topup.PaymentProvider == "paypal" || topup.PaymentProvider == "zpay" {
			refs = append(refs, topup.TradeNo)
		}
	}
	if len(refs) == 0 {
		return nil
	}
	var orders []HostedPayment
	if err := DB.Select("trade_no", "currency", "state", "amount", "last_checked_at", "check_status").Where("trade_no IN ?", refs).Find(&orders).Error; err != nil {
		return err
	}
	byRef := make(map[string]HostedPayment, len(orders))
	for _, order := range orders {
		byRef[order.TradeNo] = order
	}
	for _, topup := range topups {
		if order, ok := byRef[topup.TradeNo]; ok {
			topup.PaymentCurrency, topup.PaymentState = order.Currency, order.State
			topup.PaymentAmount, topup.PaymentCheckedAt, topup.PaymentCheckStatus = order.Amount, order.LastCheckedAt, order.CheckStatus
		}
	}
	return nil
}

func GetHostedPaymentByRemoteID(provider, remoteID string) (*HostedPayment, error) {
	var orders []HostedPayment
	if err := DB.Where("provider = ? AND remote_id = ?", provider, remoteID).Limit(2).Find(&orders).Error; err != nil {
		return nil, err
	}
	if len(orders) != 1 {
		return nil, ErrTopUpNotFound
	}
	return &orders[0], nil
}

func BindHostedPayment(tradeNo, remoteID, paymentID string) error {
	result := DB.Model(&HostedPayment{}).Where("trade_no = ? AND (remote_id = ? OR remote_id = ?)", tradeNo, "", remoteID).
		Updates(map[string]any{"remote_id": remoteID, "payment_id": paymentID})
	if result.Error != nil {
		return result.Error
	}
	// MySQL may report zero for an unchanged row, so verify the persisted ID.
	order, err := GetHostedPayment(tradeNo)
	if err != nil || order.RemoteID != remoteID {
		return ErrPaymentMethodMismatch
	}
	return nil
}

func SaveHostedCheckout(tradeNo, remoteID, checkoutURL string) error {
	// A fast webhook may have completed the order before the create response.
	return DB.Model(&HostedPayment{}).Where("trade_no = ? AND state = ?", tradeNo, "creating").
		Updates(map[string]any{"remote_id": remoteID, "checkout_url": checkoutURL, "state": "pending"}).Error
}

func MarkHostedCreationUnknown(tradeNo string) error {
	return DB.Model(&HostedPayment{}).Where("trade_no = ? AND state = ?", tradeNo, "creating").Update("state", "creation_unknown").Error
}

func HasPendingHostedPayments(provider string) (bool, error) {
	var orders []HostedPayment
	if err := DB.Where("provider = ? AND state <> ?", provider, "paid").Find(&orders).Error; err != nil {
		return false, err
	}
	for _, order := range orders {
		var count int64
		if err := DB.Model(&TopUp{}).Where("trade_no = ? AND status = ?", order.TradeNo, common.TopUpStatusPending).Count(&count).Error; err != nil {
			return false, err
		}
		if count > 0 {
			return true, nil
		}
	}
	return false, nil
}

// CompleteHostedPayment validates provider ownership and immutable money facts
// under the same transaction that credits the existing wallet. Repeated events
// (including concurrent delivery to different processes) credit at most once.
func CompleteHostedPayment(verified HostedPayment, callerIP string) (bool, error) {
	var topUp TopUp
	var quota int
	alreadyDone := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("trade_no = ?", verified.TradeNo).First(&topUp).Error; err != nil {
			return ErrTopUpNotFound
		}
		if topUp.PaymentProvider != verified.Provider {
			return ErrPaymentMethodMismatch
		}
		var order HostedPayment
		if err := tx.Where("trade_no = ?", verified.TradeNo).First(&order).Error; err != nil {
			return err
		}
		if order.Provider != verified.Provider || order.Identity != verified.Identity || order.Currency != verified.Currency ||
			verified.RemoteID == "" || (order.RemoteID != "" && order.RemoteID != verified.RemoteID) {
			return ErrPaymentMethodMismatch
		}
		amount, err := decimal.NewFromString(verified.Amount)
		expected, expectedErr := decimal.NewFromString(order.Amount)
		if err != nil || expectedErr != nil || !amount.IsPositive() || !amount.Equal(expected) {
			return ErrTopUpAmountMismatch
		}
		if topUp.Status == common.TopUpStatusSuccess {
			alreadyDone = true
			return nil
		}
		if topUp.Status != common.TopUpStatusPending || topUp.CreditedQuota <= 0 {
			return ErrTopUpStatusInvalid
		}
		quota, err = common.WalletQuotaFromDecimalStrict(decimal.NewFromInt(topUp.CreditedQuota))
		if err != nil || quota <= 0 {
			return ErrInvalidTopUpQuota
		}
		result := tx.Model(&TopUp{}).Where("id = ? AND status = ?", topUp.Id, common.TopUpStatusPending).
			Updates(map[string]any{"status": common.TopUpStatusSuccess, "complete_time": time.Now().Unix()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return errors.New("payment settlement conflict; retry")
		}
		if err := creditTopUpQuota(tx, topUp.UserId, quota, nil); err != nil {
			return err
		}
		return tx.Model(&HostedPayment{}).Where("trade_no = ?", order.TradeNo).Updates(map[string]any{
			"state": "paid", "remote_id": verified.RemoteID, "payment_id": verified.PaymentID, "checkout_url": "",
		}).Error
	})
	if err != nil || alreadyDone {
		return alreadyDone, err
	}
	syncCreditUserQuotaCache(topUp.UserId, quota, "hosted payment topup")
	RecordTopupLog(topUp.UserId, common.NewMessage("{{provider}} top-up succeeded, amount added: {{quota}}, payment amount: {{amount}}", map[string]any{
		"provider": verified.Provider, "quota": logger.FormatQuota(quota), "amount": verified.Amount + " " + verified.Currency,
	}), callerIP, verified.Provider, verified.Provider)
	return false, nil
}
