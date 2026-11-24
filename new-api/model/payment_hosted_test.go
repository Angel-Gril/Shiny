package model

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

// Schema on commercial/ru-portal before native product and coin snapshots.
type previousHostedPayment struct {
	TradeNo       string `gorm:"primaryKey;type:varchar(64)"`
	Provider      string `gorm:"type:varchar(32);index"`
	Identity      string `gorm:"type:varchar(64)"`
	Currency      string `gorm:"type:varchar(3)"`
	Amount        string `gorm:"type:varchar(32)"`
	RemoteID      string `gorm:"type:varchar(128)"`
	PaymentID     string `gorm:"type:varchar(128)"`
	CheckoutURL   string `gorm:"type:text"`
	State         string `gorm:"type:varchar(32)"`
	CreatedAt     int64
	LastCheckedAt int64  `gorm:"default:0;index"`
	CheckStatus   string `gorm:"type:varchar(32);default:''"`
}

// Exercises new schema on a fresh DB and an upgrade from existing TopUp/User
// tables, including repeated startup migration, exact-once credit and rollback.
func TestHostedPaymentDatabaseMatrix(t *testing.T) {
	previousOptions := common.OptionMap
	common.OptionMap = map[string]string{}
	previousValues := config.GlobalConfig.ExportAllConfigs()
	previousValues["GroupRatio"] = ratio_setting.GroupRatio2JSONString()
	previousValues["GroupGroupRatio"] = ratio_setting.GroupGroupRatio2JSONString()
	previousValues["UserUsableGroups"] = setting.UserUsableGroups2JSONString()
	previousValues["AutoGroups"] = setting.AutoGroups2JsonString()
	previousValues["DefaultUseAutoGroup"] = fmt.Sprint(setting.DefaultUseAutoGroup)
	previousValues["RetryTimes"] = fmt.Sprint(common.RetryTimes)
	previousValues["QuotaForNewUser"] = fmt.Sprint(common.QuotaForNewUser)
	previousValues["QuotaForInviter"] = fmt.Sprint(common.QuotaForInviter)
	previousValues["QuotaForInvitee"] = fmt.Sprint(common.QuotaForInvitee)
	previousValues["QuotaRemindEnabled"] = fmt.Sprint(common.QuotaRemindEnabled)
	t.Cleanup(func() {
		for key := range setting.RUProfileDefaults() {
			if value, exists := previousValues[key]; exists {
				require.NoError(t, updateOptionMap(key, value))
			}
		}
		common.OptionMap = previousOptions
	})
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			var driver gorm.Dialector
			switch dialect {
			case "sqlite":
				driver = sqlite.Open(":memory:")
			case "mysql":
				dsn := os.Getenv("TEST_MYSQL_DSN")
				if dsn == "" {
					t.Skip("TEST_MYSQL_DSN is not configured")
				}
				driver = mysql.Open(dsn)
			case "postgres":
				dsn := os.Getenv("TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("TEST_POSTGRES_DSN is not configured")
				}
				driver = postgres.Open(dsn)
			}
			for _, upgrade := range []bool{false, true} {
				t.Run(fmt.Sprintf("upgrade=%t", upgrade), func(t *testing.T) {
					db, err := gorm.Open(driver, &gorm.Config{NamingStrategy: schema.NamingStrategy{TablePrefix: "hosted_matrix_"}})
					require.NoError(t, err)
					sqlDB, err := db.DB()
					require.NoError(t, err)
					if dialect == "sqlite" {
						sqlDB.SetMaxOpenConns(1)
					}
					previousDB, previousLogDB := DB, LOG_DB
					previousMainType, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
					DB, LOG_DB = db, db
					common.SetDatabaseTypes(common.DatabaseType(dialect), common.DatabaseType(dialect))
					initCol()
					t.Cleanup(func() {
						require.NoError(t, db.Migrator().DropTable(&HostedPaymentClaim{}, &HostedPaymentSequence{}, &HostedPayment{}, &TopUp{}, &User{}, &Log{}))
						require.NoError(t, sqlDB.Close())
						DB, LOG_DB = previousDB, previousLogDB
						common.SetDatabaseTypes(previousMainType, previousLogType)
						initCol()
					})
					var version string
					query := "SELECT version()"
					if dialect == "sqlite" {
						query = "SELECT sqlite_version()"
					}
					require.NoError(t, db.Raw(query).Scan(&version).Error)
					t.Logf("database version: %s", version)
					if dialect == "mysql" {
						require.NoError(t, checkMySQLChineseSupport(db))
					}
					require.NoError(t, db.AutoMigrate(&User{}, &TopUp{}, &Log{}, &Option{}))
					t.Cleanup(func() { require.NoError(t, db.Migrator().DropTable(&Option{})) })
					// Upgrade runs additionally exercise LOG_SQL_DSN isolation with a
					// separate real database, including repeated log-table startup.
					if upgrade {
						var logDriver gorm.Dialector
						switch dialect {
						case "sqlite":
							logDriver = sqlite.Open(":memory:")
						case "mysql":
							logDSN := os.Getenv("TEST_MYSQL_LOG_DSN")
							require.NotEmpty(t, logDSN, "configure a separate MySQL log database")
							logDriver = mysql.Open(logDSN)
						case "postgres":
							logDSN := os.Getenv("TEST_POSTGRES_LOG_DSN")
							require.NotEmpty(t, logDSN, "configure a separate PostgreSQL log database")
							logDriver = postgres.Open(logDSN)
						}
						logDB, err := gorm.Open(logDriver, &gorm.Config{NamingStrategy: schema.NamingStrategy{TablePrefix: "hosted_log_matrix_"}})
						require.NoError(t, err)
						logSQLDB, err := logDB.DB()
						require.NoError(t, err)
						logSQLDB.SetMaxOpenConns(1)
						t.Cleanup(func() {
							require.NoError(t, logDB.Migrator().DropTable(&Log{}))
							require.NoError(t, logSQLDB.Close())
						})
						LOG_DB = logDB
						if dialect == "mysql" {
							require.NoError(t, checkMySQLChineseSupport(logDB))
						}
						for range 2 {
							require.NoError(t, logDB.AutoMigrate(&Log{}))
						}
					}
					if upgrade {
						require.NoError(t, db.Create(&TopUp{TradeNo: "legacy-order", PaymentProvider: "epay", Status: common.TopUpStatusPending, Money: 72, Amount: 10}).Error)
						table := db.NamingStrategy.TableName("HostedPayment")
						require.NoError(t, db.Table(table).AutoMigrate(&previousHostedPayment{}))
						require.NoError(t, db.Table(table).Create(&previousHostedPayment{TradeNo: "HP-existing", Provider: "paypal", Amount: "12.00", Currency: "USD", State: "pending", RemoteID: "existing-id"}).Error)
					}
					for range 2 {
						require.NoError(t, db.AutoMigrate(&HostedPayment{}, &HostedPaymentClaim{}, &HostedPaymentSequence{}, &TopUp{}))
					}
					if upgrade {
						var legacy TopUp
						require.NoError(t, db.Where("trade_no = ?", "legacy-order").First(&legacy).Error)
						require.Equal(t, "epay", legacy.PaymentProvider)
						require.Equal(t, 72.0, legacy.Money)
						payment, err := GetHostedPayment("HP-existing")
						require.NoError(t, err)
						require.Equal(t, "existing-id", payment.RemoteID)
						require.Equal(t, "12.00", payment.Amount)
						require.Zero(t, payment.LastCheckedAt)
						require.Empty(t, payment.CheckStatus)
						require.Empty(t, payment.ProductID)
						require.Empty(t, payment.CustomerHash)
						require.Empty(t, payment.SessionID)
						require.Empty(t, payment.CallbackHash)
						require.Empty(t, payment.CoinAmount)
						require.Empty(t, payment.CoinCurrency)
						require.Empty(t, payment.CoinUSDRate)
					}
					// RU defaults are opt-in, repeatable, and preserve operator values,
					// including configuration saved under the registered group alias.
					t.Setenv("SHINY_SITE_PROFILE", "")
					require.NoError(t, InitializeRUProfileOptions())
					var optionCount int64
					require.NoError(t, db.Model(&Option{}).Count(&optionCount).Error)
					require.Zero(t, optionCount)
					t.Setenv("SHINY_SITE_PROFILE", "ru")
					if upgrade {
						require.NoError(t, db.Create(&Option{Key: "group_ratio_setting.group_ratio", Value: `{"default":1.25}`}).Error)
						require.NoError(t, db.Create(&Option{Key: "QuotaForNewUser", Value: "100"}).Error)
					}
					for range 2 {
						require.NoError(t, InitializeRUProfileOptions())
					}
					var savedGift Option
					require.NoError(t, db.Where(commonKeyCol+" = ?", "QuotaForNewUser").First(&savedGift).Error)
					if upgrade {
						require.Equal(t, "100", savedGift.Value)
						require.NoError(t, db.Model(&Option{}).Where(commonKeyCol+" = ?", "GroupRatio").Count(&optionCount).Error)
						require.Zero(t, optionCount, "do not override the canonical group map with new defaults")
					} else {
						require.Equal(t, "0", savedGift.Value)
					}
					require.Equal(t, "ru", setting.RUConsoleDefaultLanguage())
					user := &User{Username: "hosted-matrix-user", Status: common.UserStatusEnabled, Quota: 50}
					require.NoError(t, db.Create(user).Error)
					order := HostedPayment{TradeNo: "HP-matrix", Provider: "lianlian", Identity: "merchant-test", Amount: "10.00", Currency: "USD", RemoteID: "PAY-matrix", State: "pending", ProductID: "product", CustomerID: "user-fixture", CustomerHash: "buyer-hash"}
					topup := &TopUp{UserId: user.Id, TradeNo: order.TradeNo, Amount: 10, CreditedQuota: 12345, Money: 10,
						PaymentProvider: order.Provider, PaymentMethod: order.Provider, Status: common.TopUpStatusPending}
					require.NoError(t, CreateHostedPayment(topup, &order))
					pending, err := HasPendingHostedPayments(order.Provider)
					require.NoError(t, err)
					require.True(t, pending)
					require.ErrorContains(t, ManualCompleteTopUp(order.TradeNo, "127.0.0.1"), "must be verified")
					wrong := order
					wrong.Currency = "EUR"
					_, err = CompleteHostedPayment(wrong, "127.0.0.1")
					require.ErrorIs(t, err, ErrPaymentMethodMismatch)
					wrong = order
					wrong.Amount = "10.01"
					_, err = CompleteHostedPayment(wrong, "127.0.0.1")
					require.ErrorIs(t, err, ErrTopUpAmountMismatch)
					var wg sync.WaitGroup
					creditErrors := make(chan error, 8)
					for range 8 {
						wg.Go(func() { _, err := CompleteHostedPayment(order, "127.0.0.1"); creditErrors <- err })
					}
					wg.Wait()
					close(creditErrors)
					for err := range creditErrors {
						require.NoError(t, err)
					}
					var credited User
					require.NoError(t, db.First(&credited, user.Id).Error)
					require.Equal(t, 50+12345, credited.Quota)
					var logs int64
					require.NoError(t, LOG_DB.Model(&Log{}).Where("user_id = ?", user.Id).Count(&logs).Error)
					require.EqualValues(t, 1, logs)
					conflict := order
					conflict.TradeNo = "HP-reused-invoice"
					conflictingTopup := *topup
					conflictingTopup.Id, conflictingTopup.TradeNo = 0, conflict.TradeNo
					require.NoError(t, CreateHostedPayment(&conflictingTopup, &conflict))
					_, err = CompleteHostedPayment(conflict, "127.0.0.1")
					require.ErrorIs(t, err, ErrPaymentMethodMismatch, "one provider invoice cannot fulfill a second local order")
					// Before this upgrade, completed invoices did not have a claim
					// row. Preserve their ownership when an operator recovers a new order.
					require.NoError(t, db.Where("trade_no = ?", order.TradeNo).Delete(&HostedPaymentClaim{}).Error)
					_, err = CompleteHostedPayment(conflict, "127.0.0.1")
					require.ErrorIs(t, err, ErrPaymentMethodMismatch, "pre-claim paid invoices cannot be reused after upgrade")
					require.NoError(t, db.Model(&TopUp{}).Where("trade_no = ?", conflict.TradeNo).Update("status", common.TopUpStatusFailed).Error)
					var nonces []int64
					nonceErrors := make(chan error, 4)
					for range 4 {
						wg.Go(func() {
							nonceErrors <- WithHostedPaymentNonce(context.Background(), "merchant-fixture", func(nonce int64) error {
								nonces = append(nonces, nonce) // Merchant lock serializes callbacks.
								return nil
							})
						})
					}
					wg.Wait()
					close(nonceErrors)
					for nonceErr := range nonceErrors {
						require.NoError(t, nonceErr)
					}
					require.Len(t, nonces, 4)
					for index := 1; index < len(nonces); index++ {
						require.Greater(t, nonces[index], nonces[index-1])
					}
					require.Error(t, WithHostedPaymentNonce(context.Background(), "merchant-fixture", func(nonce int64) error {
						nonces = append(nonces, nonce)
						return errors.New("fixture network timeout")
					}))
					require.NoError(t, WithHostedPaymentNonce(context.Background(), "merchant-fixture", func(nonce int64) error {
						require.Greater(t, nonce, nonces[len(nonces)-1], "failed requests consume their nonce")
						return nil
					}))
					if upgrade {
						require.NoError(t, db.Model(&Log{}).Where("user_id = ?", user.Id).Count(&logs).Error)
						require.Zero(t, logs, "separate log DB never writes the main DB log table")
					}
					pending, err = HasPendingHostedPayments(order.Provider)
					require.NoError(t, err)
					require.False(t, pending)
					// Recharge history must retain each adapter's original payment
					// currency, independently of the wallet's display currency.
					for _, payment := range []HostedPayment{
						{TradeNo: "HP-cispay-history", Provider: "cispay", Currency: "RUB", Amount: "950.00", State: "pending"},
						{TradeNo: "HP-zpay-history", Provider: "zpay", Currency: "CNY", Amount: "72.00", State: "pending"},
					} {
						history := &TopUp{UserId: user.Id, TradeNo: payment.TradeNo, PaymentProvider: payment.Provider,
							PaymentMethod: payment.Provider, Amount: 10, CreditedQuota: 12345, Status: common.TopUpStatusPending}
						require.NoError(t, CreateHostedPayment(history, &payment))
						require.NoError(t, AttachHostedPaymentDetails([]*TopUp{history}))
						require.Equal(t, payment.Currency, history.PaymentCurrency)
						require.Equal(t, "pending", history.PaymentState)
						require.Equal(t, payment.Amount, history.PaymentAmount)
					}
					coinOrder := HostedPayment{TradeNo: "HP-coin-quote", Provider: "apirone", Currency: "USD", Amount: "10.50", State: "creating"}
					coinTopup := &TopUp{TradeNo: coinOrder.TradeNo, UserId: user.Id, PaymentProvider: coinOrder.Provider, CreditedQuota: 12345, Status: common.TopUpStatusPending}
					require.NoError(t, CreateHostedPayment(coinTopup, &coinOrder))
					coinOrder.CoinCurrency, coinOrder.CoinAmount, coinOrder.CoinUSDRate = "usdt@bnb", "10500000000000000000", "0.999"
					require.NoError(t, SaveHostedCoinQuote(&coinOrder))
					storedCoin, err := GetHostedPayment(coinOrder.TradeNo)
					require.NoError(t, err)
					require.Equal(t, coinOrder.CoinAmount, storedCoin.CoinAmount, "minimal coin units must never pass through a SQL float or int64")
					require.Equal(t, "0.999", storedCoin.CoinUSDRate)
					require.Error(t, SaveHostedCoinQuote(&coinOrder), "a coin quote may be saved only once")
					require.NoError(t, db.Model(&TopUp{}).Where("trade_no = ?", coinOrder.TradeNo).Update("status", common.TopUpStatusFailed).Error)
					// Fair, cross-provider reconciliation keeps exact money strings and
					// excludes completed/failed topups regardless of provider state.
					require.NoError(t, db.Model(&HostedPayment{}).Where("trade_no = ?", "HP-zpay-history").Update("created_at", 100).Error)
					require.NoError(t, db.Model(&HostedPayment{}).Where("trade_no = ?", "HP-cispay-history").Update("created_at", 10).Error)
					items, total, overdue, err := GetHostedPaymentQueue("", 50)
					require.NoError(t, err)
					require.EqualValues(t, 2, total)
					require.EqualValues(t, 1, overdue)
					require.Len(t, items, 2)
					require.Equal(t, "HP-cispay-history", items[0].TradeNo)
					require.Equal(t, "950.00", items[0].Amount)
					require.NoError(t, RecordHostedPaymentCheck(items[0].TradeNo, "needs_reference", 200))
					queue, err := GetPendingHostedPayments("", 1000, 1000, 1)
					require.NoError(t, err)
					require.Len(t, queue, 1)
					require.Equal(t, "HP-zpay-history", queue[0].TradeNo, "another provider goes before recently checked orders")
					require.NoError(t, db.Model(&TopUp{}).Where("trade_no = ?", queue[0].TradeNo).Update("status", common.TopUpStatusFailed).Error)
					queue, err = GetPendingHostedPayments("", 1000, 1000, 100)
					require.NoError(t, err)
					require.Len(t, queue, 1)
					require.Equal(t, "HP-cispay-history", queue[0].TradeNo)
					duplicate := order
					require.Error(t, db.Create(&duplicate).Error)
					// Ceiling failure must leave both payment state and wallet intact.
					require.NoError(t, db.Model(&User{}).Where("id = ?", user.Id).Update("quota", common.MaxWalletQuota).Error)
					order.TradeNo, order.RemoteID = "HP-overflow", "PAY-overflow"
					topup.Id = 0
					topup.TradeNo = order.TradeNo
					require.NoError(t, CreateHostedPayment(topup, &order))
					_, err = CompleteHostedPayment(order, "127.0.0.1")
					require.ErrorIs(t, err, ErrTopUpQuotaLimitExceeded)
					stored, err := GetHostedPayment(order.TradeNo)
					require.NoError(t, err)
					require.Equal(t, "pending", stored.State)
					require.Equal(t, common.TopUpStatusPending, GetTopUpByTradeNo(order.TradeNo).Status)
				})
			}
		})
	}
}
