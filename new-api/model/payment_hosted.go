package model

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
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
	SessionID     string `json:"-" gorm:"type:varchar(128);default:''"`
	ProductID     string `json:"-" gorm:"type:varchar(128);default:''"`
	CustomerID    string `json:"-" gorm:"type:varchar(128);default:''"`
	CustomerHash  string `json:"-" gorm:"type:varchar(64);default:''"`
	CallbackHash  string `json:"-" gorm:"type:varchar(64);default:''"`
	CoinCurrency  string `json:"-" gorm:"type:varchar(32);default:''"`
	CoinAmount    string `json:"-" gorm:"type:varchar(80);default:''"`
	CoinUSDRate   string `json:"-" gorm:"type:varchar(80);default:''"`
	CheckoutURL   string `json:"-" gorm:"type:text"`
	State         string `json:"payment_state" gorm:"type:varchar(32)"`
	CreatedAt     int64  `json:"created_at"`
	LastCheckedAt int64  `json:"last_checked_at" gorm:"default:0;index"`
	CheckStatus   string `json:"check_status" gorm:"type:varchar(32);default:''"`
}

// A remote invoice can fulfill only one local order, including across workers.
// A digest primary key avoids oversized compound indexes on MySQL 5.7.
type HostedPaymentClaim struct {
	Key     string `gorm:"primaryKey;type:varchar(64)"`
	TradeNo string `gorm:"type:varchar(64);index"`
}

type HostedPaymentSequence struct {
	Key   string `gorm:"primaryKey;type:varchar(64)"`
	Value int64
}

// FreeKassa requires an increasing nonce. Hold the merchant row lock until the
// request finishes, so another process cannot send a later nonce first. Persist
// the increment even when the HTTP request fails or times out.
func WithHostedPaymentNonce(ctx context.Context, key string, send func(int64) error) error {
	var requestErr error
	transactionCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 45*time.Second)
	defer cancel()
	err := DB.WithContext(transactionCtx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&HostedPaymentSequence{Key: key}).Error; err != nil {
			return err
		}
		var sequence HostedPaymentSequence
		if err := lockForUpdate(tx).Where(map[string]any{"key": key}).First(&sequence).Error; err != nil {
			return err
		}
		if sequence.Value >= 9007199254740991 {
			return errors.New("payment nonce exhausted")
		}
		sequence.Value = max(sequence.Value+1, time.Now().UnixMicro())
		if err := tx.Model(&sequence).Update("value", sequence.Value).Error; err != nil {
			return err
		}
		requestErr = send(sequence.Value)
		return nil
	})
	if err != nil {
		return err
	}
	return requestErr
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
		refs = append(refs, topup.TradeNo)
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

func SaveHostedCheckout(tradeNo, remoteID, checkoutURL string, sessionID ...string) error {
	// A fast webhook may have completed the order before the create response.
	updates := map[string]any{"checkout_url": checkoutURL, "state": "pending"}
	if remoteID != "" {
		updates["remote_id"] = remoteID
	}
	if len(sessionID) > 0 {
		updates["session_id"] = sessionID[0]
	}
	return DB.Model(&HostedPayment{}).Where("trade_no = ? AND state = ?", tradeNo, "creating").
		Updates(updates).Error
}

// Persist a coin quote before creating the remote invoice. Recovery must use
// this snapshot, never a later ticker rate or the current merchant settings.
func SaveHostedCoinQuote(order *HostedPayment) error {
	result := DB.Model(&HostedPayment{}).Where("trade_no = ? AND state = ? AND coin_amount = ?", order.TradeNo, "creating", "").
		Updates(map[string]any{"coin_currency": order.CoinCurrency, "coin_amount": order.CoinAmount, "coin_usd_rate": order.CoinUSDRate})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return errors.New("payment coin quote could not be saved")
	}
	return nil
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
		// Upgraded installations also contain paid invoices from before claims
		// existed. They must never be reused to recover a different local order.
		var priorCredits int64
		if err := tx.Model(&HostedPayment{}).Where("provider = ? AND remote_id = ? AND state = ? AND trade_no <> ?",
			order.Provider, verified.RemoteID, "paid", order.TradeNo).Count(&priorCredits).Error; err != nil {
			return err
		}
		if priorCredits > 0 {
			return ErrPaymentMethodMismatch
		}
		claimDigest := sha256.Sum256([]byte(order.Provider + "\n" + verified.RemoteID))
		claimKey := hex.EncodeToString(claimDigest[:])
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&HostedPaymentClaim{Key: claimKey, TradeNo: order.TradeNo}).Error; err != nil {
			return err
		}
		var claim HostedPaymentClaim
		if err := tx.Where(map[string]any{"key": claimKey}).First(&claim).Error; err != nil {
			return err
		}
		if claim.TradeNo != order.TradeNo {
			return ErrPaymentMethodMismatch
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
