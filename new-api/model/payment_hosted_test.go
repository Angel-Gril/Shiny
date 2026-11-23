package model

import (
	"fmt"
	"os"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

// Exercises new schema on a fresh DB and an upgrade from existing TopUp/User
// tables, including repeated startup migration, exact-once credit and rollback.
func TestHostedPaymentDatabaseMatrix(t *testing.T) {
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
					DB, LOG_DB = db, db
					common.SetDatabaseTypes(common.DatabaseType(dialect), common.DatabaseType(dialect))
					t.Cleanup(func() {
						require.NoError(t, db.Migrator().DropTable(&HostedPayment{}, &TopUp{}, &User{}, &Log{}))
						require.NoError(t, sqlDB.Close())
						DB, LOG_DB = previousDB, previousLogDB
						common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
					})
					var version string
					query := "SELECT version()"
					if dialect == "sqlite" {
						query = "SELECT sqlite_version()"
					}
					require.NoError(t, db.Raw(query).Scan(&version).Error)
					t.Logf("database version: %s", version)
					require.NoError(t, db.AutoMigrate(&User{}, &TopUp{}, &Log{}))
					if upgrade {
						require.NoError(t, db.Create(&TopUp{TradeNo: "legacy-order", PaymentProvider: "epay", Status: common.TopUpStatusPending, Money: 72, Amount: 10}).Error)
					}
					for range 2 {
						require.NoError(t, db.AutoMigrate(&HostedPayment{}, &TopUp{}))
					}
					if upgrade {
						var legacy TopUp
						require.NoError(t, db.Where("trade_no = ?", "legacy-order").First(&legacy).Error)
						require.Equal(t, "epay", legacy.PaymentProvider)
						require.Equal(t, 72.0, legacy.Money)
					}
					user := &User{Username: "hosted-matrix-user", Status: common.UserStatusEnabled, Quota: 50}
					require.NoError(t, db.Create(user).Error)
					order := HostedPayment{TradeNo: "HP-matrix", Provider: "lianlian", Identity: "merchant-test", Amount: "10.00", Currency: "USD", RemoteID: "PAY-matrix", State: "pending"}
					topup := &TopUp{UserId: user.Id, TradeNo: order.TradeNo, Amount: 10, CreditedQuota: 12345, Money: 10,
						PaymentProvider: order.Provider, PaymentMethod: order.Provider, Status: common.TopUpStatusPending}
					require.NoError(t, CreateHostedPayment(topup, &order))
					pending, err := HasPendingHostedPayments(order.Provider)
					require.NoError(t, err)
					require.True(t, pending)
					wrong := order
					wrong.Currency = "EUR"
					_, err = CompleteHostedPayment(wrong, "127.0.0.1")
					require.ErrorIs(t, err, ErrPaymentMethodMismatch)
					wrong = order
					wrong.Amount = "10.01"
					_, err = CompleteHostedPayment(wrong, "127.0.0.1")
					require.ErrorIs(t, err, ErrTopUpAmountMismatch)
					var wg sync.WaitGroup
					errors := make(chan error, 8)
					for range 8 {
						wg.Go(func() { _, err := CompleteHostedPayment(order, "127.0.0.1"); errors <- err })
					}
					wg.Wait()
					close(errors)
					for err := range errors {
						require.NoError(t, err)
					}
					var credited User
					require.NoError(t, db.First(&credited, user.Id).Error)
					require.Equal(t, 50+12345, credited.Quota)
					var logs int64
					require.NoError(t, db.Model(&Log{}).Where("user_id = ?", user.Id).Count(&logs).Error)
					require.EqualValues(t, 1, logs)
					pending, err = HasPendingHostedPayments(order.Provider)
					require.NoError(t, err)
					require.False(t, pending)
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
