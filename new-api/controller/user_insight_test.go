package controller

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func userInsightTestDatabase(t *testing.T, kind, dsn string) (*gorm.DB, string) {
	t.Helper()
	db, isolatedDSN := newAuditTestDatabase(t, kind, dsn)
	connection, err := db.DB()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, connection.Close()) })
	return db, isolatedDSN
}

func userInsightRequest(t *testing.T, id string, role int, query string, data any) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/user/"+id+"/insight?"+query, nil)
	c.Params = gin.Params{{Key: "id", Value: id}}
	c.Set("role", role)
	GetUserInsight(c)
	if data != nil {
		var response struct {
			Success bool `json:"success"`
			Data    any  `json:"data"`
		}
		response.Data = data
		require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
		require.True(t, response.Success, recorder.Body.String())
	}
	return recorder
}

func TestUserInsightRequiresAdminAuthentication(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/api/user/:id/insight", middleware.AdminAuth(), GetUserInsight)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/user/1/insight", nil))
	assert.Equal(t, http.StatusUnauthorized, recorder.Code)
	for _, role := range []int{0, common.RoleCommonUser} {
		recorder = userInsightRequest(t, "1", role, "", nil)
		assert.Equal(t, http.StatusForbidden, recorder.Code)
		assert.NotContains(t, recorder.Body.String(), "quota")
	}
}

func TestUserInsightDatabaseMatrix(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, dialect := range []struct {
		kind, env string
		typ       common.DatabaseType
	}{
		{"sqlite", "", common.DatabaseTypeSQLite},
		{"mysql", "TEST_MYSQL_DSN", common.DatabaseTypeMySQL},
		{"postgres", "TEST_POSTGRES_DSN", common.DatabaseTypePostgreSQL},
		{"clickhouse", "AUDIT_CLICKHOUSE_DSN", common.DatabaseTypeClickHouse},
	} {
		t.Run(dialect.kind, func(t *testing.T) {
			if dialect.env != "" && os.Getenv(dialect.env) == "" {
				t.Skip(dialect.env + " is not configured")
			}
			mainKind, mainType := dialect.kind, dialect.typ
			if dialect.kind == "clickhouse" {
				mainKind, mainType = "sqlite", common.DatabaseTypeSQLite
			}
			db, _ := userInsightTestDatabase(t, mainKind, os.Getenv(dialect.env))
			logDB, logDSN := userInsightTestDatabase(t, dialect.kind, os.Getenv(dialect.env))
			useLogExportDatabases(t, db, logDB, mainType, dialect.typ)
			require.NoError(t, db.AutoMigrate(&model.User{}, &model.TopUp{}, &model.Redemption{}, &model.Checkin{}, &model.Log{}))
			if dialect.kind == "clickhouse" {
				t.Setenv("LOG_SQL_DSN", logDSN)
				require.NoError(t, model.InitLogDB())
				logDB = model.LOG_DB
			} else {
				require.NoError(t, logDB.AutoMigrate(&model.Log{}))
			}
			var version string
			versionQuery := "SELECT version()"
			if mainKind == "sqlite" {
				versionQuery = "SELECT sqlite_version()"
			}
			require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
			t.Logf("main database: %s %s; separate log database: %s", mainKind, version, dialect.kind)

			legacyToken := "fixture-only-access-token"
			users := []model.User{
				{Id: 1, Username: "target", Password: "fixture-password-secret", Role: common.RoleCommonUser, Email: "target@example.invalid", Group: "Plus", Quota: 700, UsedQuota: 300, RequestCount: 4, InviterId: 2, AffCode: "target-aff", AccessToken: &legacyToken, Setting: `{"secret":"fixture-settings-secret"}`, GitHubId: "private-binding"},
				{Id: 2, Username: "inviter", Password: "fixture", Role: common.RoleCommonUser, AffCode: "inviter-aff"},
				{Id: 3, Username: "peer-admin", Password: "fixture", Role: common.RoleAdminUser, AffCode: "admin-aff"},
				{Id: 4, Username: "root", Password: "fixture", Role: common.RoleRootUser, AffCode: "root-aff"},
			}
			require.NoError(t, db.Create(&users).Error)
			topups := []model.TopUp{
				{Id: 11, UserId: 1, TradeNo: "legacy-order", Amount: 100, Money: 73, CreditedQuota: 0, Status: common.TopUpStatusSuccess, PaymentMethod: "alipay", CreateTime: 100},
				{Id: 12, UserId: 1, TradeNo: "new-order", Amount: 6, Money: 6.66, CreditedQuota: 1234567, Status: common.TopUpStatusPending, PaymentProvider: model.PaymentProviderEpay, CreateTime: 200},
				{Id: 13, UserId: 2, TradeNo: "foreign-order", Amount: 9999, Money: 9999, Status: common.TopUpStatusSuccess, CreateTime: 300},
			}
			require.NoError(t, db.Create(&topups).Error)
			redemptions := []model.Redemption{
				{Id: 21, UsedUserId: 1, Key: "fixture-used-secret", Name: "Campaign credit", Status: common.RedemptionCodeStatusUsed, Quota: 20, RedeemedTime: 100},
				{Id: 22, UsedUserId: 2, Key: "fixture-foreign-secret", Status: common.RedemptionCodeStatusUsed, Quota: 30},
				{Id: 23, UsedUserId: 1, Key: "fixture-enabled-secret", Status: common.RedemptionCodeStatusEnabled, Quota: 40},
				{Id: 24, UsedUserId: 1, Key: "fixture-deleted-secret", Name: "Old redeemed code", Status: common.RedemptionCodeStatusUsed, Quota: 50, RedeemedTime: 200},
			}
			require.NoError(t, db.Create(&redemptions).Error)
			require.NoError(t, db.Delete(&model.Redemption{}, 24).Error)
			require.NoError(t, db.Create(&[]model.Checkin{
				{Id: 31, UserId: 1, CheckinDate: "2026-10-16", QuotaAwarded: 7, CreatedAt: 100},
				{Id: 32, UserId: 2, CheckinDate: "2026-10-17", QuotaAwarded: 9, CreatedAt: 200},
			}).Error)
			logs := []model.Log{
				{Id: 100, UserId: 1, CreatedAt: 100, Type: model.LogTypeSystem, Content: `[{"key":"New user sign-up bonus {{quota}}","params":{"quota":"$3"}}]`, RequestId: "target-01"},
				{Id: 101, UserId: 1, CreatedAt: 200, Type: model.LogTypeConsume, Quota: 300, ModelName: "gpt-example", ChannelId: 9, PromptTokens: 13, CompletionTokens: 4, UseTime: 2, IsStream: true, TokenName: "Primary API", RequestId: "target-02", Other: `{"admin_info":{"private":"admin-only"},"root_info":{"secret":"root-only"},"prompt":"private request body"}`, Ip: "192.0.2.1"},
				{Id: 102, UserId: 1, CreatedAt: 200, Type: model.LogTypeRefund, Quota: 10, Content: "Task quota returned", RequestId: "target-03"},
				{Id: 103, UserId: 1, CreatedAt: 202, Type: model.LogTypeError, Content: "upstream response body: private-prompt sk-fixture-secret", RequestId: "target-04"},
				{Id: 104, UserId: 2, CreatedAt: 300, Type: model.LogTypeConsume, Content: "foreign-user-log", RequestId: "foreign-01"},
			}
			for i := range logs {
				require.NoError(t, logDB.Create(&logs[i]).Error)
			}
			// A conflicting main-database log proves reads use LOG_DB.
			require.NoError(t, db.Create(&model.Log{UserId: 1, Type: model.LogTypeConsume, Content: "wrong-database-log", RequestId: "main-only"}).Error)

			t.Run("overview_and_wallet_semantics", func(t *testing.T) {
				var overview model.UserInsightOverview
				recorder := userInsightRequest(t, "1", common.RoleAdminUser, "", &overview)
				assert.Equal(t, http.StatusOK, recorder.Code)
				assert.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
				assert.Equal(t, "inviter", overview.User.InviterUsername)
				assert.Equal(t, "Plus", overview.User.Group)
				assert.Equal(t, 700, overview.User.Quota)
				assert.Equal(t, 300, overview.User.UsedQuota)
				assert.Equal(t, model.UserInsightStats{SuccessfulTopups: 1, Redemptions: 2, Checkins: 1, LogCount: 4, ConsumeCount: 1, RefundCount: 1}, overview.Stats)
				assert.False(t, overview.Limitations.WalletProvenanceComplete)
				assert.False(t, overview.Limitations.PaymentCurrencyRecorded)
				for _, private := range []string{"password", "access_token", "setting", "private-binding", "aff_code", "refundable", "paid_remaining"} {
					assert.NotContains(t, recorder.Body.String(), private)
				}
			})
			t.Run("orders_preserve_recorded_values", func(t *testing.T) {
				var page model.UserInsightPage[model.UserInsightTopup]
				recorder := userInsightRequest(t, "1", common.RoleAdminUser, "section=topups&p=2&page_size=1", &page)
				assert.EqualValues(t, 2, page.Total)
				require.Len(t, page.Items, 1)
				assert.Equal(t, "legacy-order", page.Items[0].TradeNo)
				assert.EqualValues(t, 100, page.Items[0].Amount)
				assert.Equal(t, 73.0, page.Items[0].Money)
				assert.Zero(t, page.Items[0].CreditedQuota)
				assert.NotContains(t, recorder.Body.String(), "currency")
				userInsightRequest(t, "1", common.RoleRootUser, "section=topups&p=1&page_size=1", &page)
				assert.EqualValues(t, 1234567, page.Items[0].CreditedQuota)
				assert.Equal(t, 6.66, page.Items[0].Money)
			})
			t.Run("redeemed_codes_and_checkins", func(t *testing.T) {
				var codes model.UserInsightPage[model.UserInsightRedemption]
				recorder := userInsightRequest(t, "1", common.RoleAdminUser, "section=redemptions", &codes)
				assert.EqualValues(t, 2, codes.Total)
				require.Len(t, codes.Items, 2)
				assert.Equal(t, 24, codes.Items[0].Id)
				assert.NotContains(t, recorder.Body.String(), "secret")
				assert.NotContains(t, recorder.Body.String(), "key")
				var checkins model.UserInsightPage[model.UserInsightCheckin]
				userInsightRequest(t, "1", common.RoleAdminUser, "section=checkins", &checkins)
				assert.EqualValues(t, 1, checkins.Total)
				require.Len(t, checkins.Items, 1)
				assert.Equal(t, 7, checkins.Items[0].QuotaAwarded)
				assert.Equal(t, "2026-10-16", checkins.Items[0].CheckinDate)
			})
			t.Run("separate_logs_filtered_and_sanitized", func(t *testing.T) {
				var page model.UserInsightPage[model.UserInsightLog]
				recorder := userInsightRequest(t, "1", common.RoleAdminUser, "section=logs", &page)
				assert.EqualValues(t, 4, page.Total)
				require.Len(t, page.Items, 4)
				assert.Equal(t, "target-04", page.Items[0].RequestId)
				assert.Empty(t, page.Items[0].Content)
				assert.Equal(t, "target-03", page.Items[1].RequestId)
				assert.Equal(t, "target-02", page.Items[2].RequestId)
				assert.Equal(t, 9, page.Items[2].ChannelId)
				assert.Equal(t, "New user sign-up bonus $3", page.Items[3].Content)
				for _, private := range []string{"foreign-user-log", "wrong-database-log", "private-prompt", "sk-fixture", "other", "admin-only", "root-only", "192.0.2.1"} {
					assert.NotContains(t, recorder.Body.String(), private)
				}
				userInsightRequest(t, "1", common.RoleRootUser, "section=logs&log_type=6", &page)
				assert.EqualValues(t, 1, page.Total)
				require.Len(t, page.Items, 1)
				assert.Equal(t, model.LogTypeRefund, page.Items[0].Type)
				assert.Equal(t, 10, page.Items[0].Quota)
			})
			t.Run("target_authorization_and_validation", func(t *testing.T) {
				for _, section := range []string{"overview", "topups", "redemptions", "checkins", "logs"} {
					for _, target := range []string{"3", "4"} {
						recorder := userInsightRequest(t, target, common.RoleAdminUser, "section="+section, nil)
						assert.Equal(t, http.StatusForbidden, recorder.Code)
						assert.NotContains(t, recorder.Body.String(), "data")
					}
				}
				var root model.UserInsightPage[model.UserInsightTopup]
				userInsightRequest(t, "4", common.RoleRootUser, "section=topups", &root)
				assert.Empty(t, root.Items)
				assert.Contains(t, userInsightRequest(t, "4", common.RoleRootUser, "section=topups", nil).Body.String(), `"items":[]`)
				assert.Equal(t, http.StatusNotFound, userInsightRequest(t, "999", common.RoleRootUser, "", nil).Code)
				for _, id := range []string{"0", "-1", "invalid"} {
					assert.Equal(t, http.StatusBadRequest, userInsightRequest(t, id, common.RoleRootUser, "", nil).Code)
				}
				for _, query := range []string{"section=invalid", "log_type=-1", "log_type=8", "log_type=2+OR+1=1", "p=invalid", "page_size=invalid", "p=" + strconv.FormatUint(^uint64(0)>>1, 10) + "&page_size=50"} {
					assert.Equal(t, http.StatusBadRequest, userInsightRequest(t, "1", common.RoleRootUser, query, nil).Code)
				}
			})
			t.Run("pagination_boundary", func(t *testing.T) {
				// Exactly 51 records exercises the 50-item API boundary and
				// stable tie-breaking without an arbitrary stress workload.
				for i := range 49 {
					require.NoError(t, db.Create(&model.TopUp{Id: 1000 + i, UserId: 1, TradeNo: fmt.Sprintf("page-order-%02d", i), CreateTime: 300}).Error)
				}
				var page model.UserInsightPage[model.UserInsightTopup]
				userInsightRequest(t, "1", common.RoleRootUser, "section=topups&p=-10&page_size=999999", &page)
				assert.Equal(t, 1, page.Page)
				assert.Equal(t, 50, page.PageSize)
				assert.EqualValues(t, 51, page.Total)
				require.Len(t, page.Items, 50)
				assert.Equal(t, "page-order-48", page.Items[0].TradeNo)
				userInsightRequest(t, "1", common.RoleRootUser, "section=topups&p=2&page_size=50", &page)
				require.Len(t, page.Items, 1)
				assert.Equal(t, "legacy-order", page.Items[0].TradeNo)
				userInsightRequest(t, "1", common.RoleRootUser, "section=topups&page_size=-1", &page)
				assert.Equal(t, 10, page.PageSize)
			})
			// All support reads leave actual wallet and usage accounting intact.
			var after model.User
			require.NoError(t, db.First(&after, 1).Error)
			assert.Equal(t, users[0].Quota, after.Quota)
			assert.Equal(t, users[0].UsedQuota, after.UsedQuota)
			assert.Equal(t, users[0].RequestCount, after.RequestCount)
		})
	}
}

func TestUserInsightLogSummaryDoesNotExposeBodiesOrSecrets(t *testing.T) {
	db, _ := userInsightTestDatabase(t, "sqlite", "")
	useLogExportDatabases(t, db, db, common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	require.NoError(t, db.AutoMigrate(&model.Log{}))
	for i, test := range []struct {
		content, expected string
	}{
		{"Granted 7 quota; api_key=fixture-secret", "Granted 7 quota; [redacted]"},
		{"Adjusted quota; Bearer fixture-token", "Adjusted quota; [redacted]"},
		{"Adjusted quota; Authorization: Bearer fixture-token", "Adjusted quota; [redacted]"},
		{`Granted 7 quota; "access_token": "fixture-token"`, `Granted 7 quota; "[redacted]"`},
		{"Quota returned. body=private-request", "Quota returned."},
		{`{"messages":[{"content":"private-prompt"}]}`, ""},
		{`[ {"key":"Granted {{quota}}", "params":{"quota":"7"}} ]`, "Granted 7"},
	} {
		require.NoError(t, db.Create(&model.Log{UserId: 1, Type: model.LogTypeSystem, Content: test.content, RequestId: fmt.Sprintf("summary-%d", i)}).Error)
		page, err := model.GetUserInsightLogs(t.Context(), 1, 1, 10, model.LogTypeSystem)
		require.NoError(t, err)
		require.NotEmpty(t, page.Items)
		assert.Equal(t, test.expected, page.Items[0].Content)
	}
}

// Keep test fixtures using GORM's public model contract, including accidental
// DB errors: response bodies must not leak schema names or SQL diagnostics.
func TestUserInsightDatabaseErrorIsGeneric(t *testing.T) {
	db, _ := userInsightTestDatabase(t, "sqlite", "")
	useLogExportDatabases(t, db, db, common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	require.NoError(t, db.AutoMigrate(&model.User{}))
	require.NoError(t, db.Create(&model.User{Id: 1, Username: "fixture", Password: "fixture", Role: common.RoleCommonUser}).Error)
	recorder := userInsightRequest(t, "1", common.RoleRootUser, "section=topups", nil)
	assert.Equal(t, http.StatusInternalServerError, recorder.Code)
	assert.NotContains(t, recorder.Body.String(), "top_ups")
	assert.NotContains(t, recorder.Body.String(), "SELECT")
	assert.NotContains(t, recorder.Body.String(), "no such table")
}
