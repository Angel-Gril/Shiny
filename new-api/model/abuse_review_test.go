package model

import (
	"os"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestAbuseReviewDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			var driver gorm.Dialector
			switch dialect {
			case "sqlite":
				driver = sqlite.Open(":memory:")
			case "mysql":
				dsn := os.Getenv("TEST_MYSQL_DSN")
				if dsn == "" {
					t.Skip("TEST_MYSQL_DSN absent")
				}
				driver = mysql.Open(dsn)
			case "postgres":
				dsn := os.Getenv("TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("TEST_POSTGRES_DSN absent")
				}
				driver = postgres.Open(dsn)
			}
			db, err := gorm.Open(driver, &gorm.Config{})
			require.NoError(t, err)
			old := DB
			DB = db
			t.Cleanup(func() {
				require.NoError(t, db.Migrator().DropTable(&AbuseReview{}))
				conn, _ := db.DB()
				require.NoError(t, conn.Close())
				DB = old
			})
			require.NoError(t, db.AutoMigrate(&AbuseReview{}))
			require.NoError(t, CreateAbuseReview(&AbuseReview{EventId: "prior-version", UserId: 17, TokenId: 19, Action: "abuse.keyword_match", RiskScore: 6, ScoreVersion: "abuse-score-v1", Status: AbuseReviewStatusPending, EvidenceJSON: `{"source":"legacy"}`}))
			require.NoError(t, CreateAbuseReview(&AbuseReview{EventId: "current-version", UserId: 17, TokenId: 19, Action: "abuse.content_audit", RiskScore: 5, ScoreVersion: AbuseReviewScoreVersion, Status: AbuseReviewStatusPending, EvidenceJSON: `{"confidence":0.9,"category_scores":{"credential_theft":0.9}}`}))
			require.NoError(t, db.AutoMigrate(&AbuseReview{}))
			require.NoError(t, db.AutoMigrate(&AbuseReview{}))
			items, n, err := ListAbuseReviews("pending", "", 0, 20, 3)
			require.NoError(t, err)
			require.Equal(t, int64(1), n)
			require.Len(t, items, 1)
			require.Equal(t, "current-version", items[0].EventId)
			summary, err := GetAbuseReviewSummary()
			require.NoError(t, err)
			require.Equal(t, int64(1), summary.ReviewPriority)
			require.Equal(t, int64(0), summary.ManualPriority)
		})
	}
}

func setupAbuseReviewModelTest(t *testing.T) *gorm.DB {
	t.Helper()
	previousDB := DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&AbuseReview{}))
	DB = db
	t.Cleanup(func() { DB = previousDB })
	return db
}

func TestAbuseReviewScoreAndDisposition(t *testing.T) {
	assert.Zero(t, AbuseSignalScore("long_stream", AuditFields{"duration_ms": 106980, "status": 200}))
	assert.Zero(t, AbuseSignalScore("provider_error", AuditFields{"status": 429}))
	assert.Zero(t, AbuseSignalScore("multi_ip", AuditFields{"distinct_count": 2}))
	assert.Equal(t, 6, AbuseSignalScore("content_audit", AuditFields{"confidence": 0.96}))
	assert.Equal(t, 3, AbuseSignalScore("content_audit", AuditFields{"confidence": 0.75}))
	assert.Equal(t, 1, AbuseSignalWeight("keyword_match"))
	db := setupAbuseReviewModelTest(t)
	now := common.GetTimestamp()
	require.NoError(t, CreateAbuseReview(&AbuseReview{
		EventId: "event-a", UserId: 7, TokenId: 8, Action: "abuse.provider_error",
		Status: AbuseReviewStatusPending, RiskScore: 2, CreatedAt: now,
	}))
	score := AbuseAggregateScore(7, 8, "retry_storm", AuditFields{"attempts": 3})
	assert.Equal(t, 0, score)
	assert.Equal(t, "observe", AbuseDisposition(2))
	assert.Equal(t, "review", AbuseDisposition(3))
	assert.Equal(t, "manual_action", AbuseDisposition(6))
	var count int64
	require.NoError(t, db.Model(&AbuseReview{}).Count(&count).Error)
	assert.Equal(t, int64(1), count)
}

func TestAbuseReviewCreateIsIdempotentAndExpiresFromAggregateWindow(t *testing.T) {
	db := setupAbuseReviewModelTest(t)
	now := common.GetTimestamp()
	review := &AbuseReview{EventId: "duplicate-event", UserId: 9, TokenId: 10, Action: "abuse.token_churn", Status: AbuseReviewStatusPending, RiskScore: 2, CreatedAt: now}
	require.NoError(t, CreateAbuseReview(review))
	require.NoError(t, CreateAbuseReview(&AbuseReview{EventId: review.EventId, UserId: 9, TokenId: 10, Action: review.Action, Status: AbuseReviewStatusPending, RiskScore: 2, CreatedAt: now}))
	var count int64
	require.NoError(t, db.Model(&AbuseReview{}).Count(&count).Error)
	assert.Equal(t, int64(1), count)
	require.NoError(t, CreateAbuseReview(&AbuseReview{
		EventId: "old-event", UserId: 11, TokenId: 12, Action: "abuse.provider_error",
		Status: AbuseReviewStatusPending, RiskScore: 2,
		CreatedAt: now - int64((AbuseReviewWindow+time.Second)/time.Second),
	}))
	assert.Equal(t, 0, AbuseAggregateScore(11, 12, "retry_storm", AuditFields{"attempts": 3}))
	assert.Equal(t, 0, AbuseAggregateScore(9, 10, "retry_storm", AuditFields{"attempts": 3}))
}

func TestAbuseReviewRejectsInvalidInput(t *testing.T) {
	setupAbuseReviewModelTest(t)
	assert.Error(t, CreateAbuseReview(nil))
	assert.Error(t, CreateAbuseReview(&AbuseReview{EventId: "x", UserId: 1, TokenId: 1, Action: "abuse.x", Status: "closed"}))
	assert.Error(t, UpdateAbuseReview(&AbuseReview{Id: 1, Status: "closed"}))
	assert.False(t, ValidAbuseReviewTransition(AbuseReviewStatusPending))
	assert.True(t, ValidAbuseReviewTransition(AbuseReviewStatusResolved))
}

func TestGetAbuseReviewSummaryCountsQueueAndSignals(t *testing.T) {
	setupAbuseReviewModelTest(t)
	now := common.GetTimestamp()
	reviews := []*AbuseReview{
		{EventId: "summary-pending", UserId: 1, TokenId: 1, Action: "abuse.content_audit", Status: AbuseReviewStatusPending, RiskScore: 3, CreatedAt: now},
		{EventId: "summary-resolved", UserId: 1, TokenId: 1, Action: "abuse.keyword_match", Status: AbuseReviewStatusResolved, RiskScore: 6, CreatedAt: now},
		{EventId: "summary-false-positive", UserId: 1, TokenId: 1, Action: "abuse.provider_error", Status: AbuseReviewStatusFalsePositive, RiskScore: 1, CreatedAt: now},
		{EventId: "summary-old", UserId: 1, TokenId: 1, Action: "abuse.content_audit", Status: AbuseReviewStatusPending, RiskScore: 1, CreatedAt: now - 25*60*60},
	}
	for _, review := range reviews {
		require.NoError(t, CreateAbuseReview(review))
	}
	summary, err := GetAbuseReviewSummary()
	require.NoError(t, err)
	assert.Equal(t, int64(4), summary.Total)
	assert.Equal(t, int64(2), summary.Pending)
	assert.Equal(t, int64(1), summary.Resolved)
	assert.Equal(t, int64(1), summary.FalsePositive)
	assert.Equal(t, int64(3), summary.Last24Hours)
	assert.Equal(t, int64(1), summary.ReviewPriority)
	assert.Equal(t, int64(0), summary.ManualPriority)
	assert.Equal(t, int64(2), summary.ContentAudit)
	assert.Equal(t, int64(1), summary.KeywordMatch)
	assert.NotZero(t, summary.GeneratedAt)
}
