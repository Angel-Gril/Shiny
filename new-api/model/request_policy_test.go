package model

import (
	"errors"
	"maps"
	"math"
	"os"
	"strconv"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

func TestRequestPolicyDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			var driver gorm.Dialector
			switch dialect {
			case "sqlite":
				driver = sqlite.Open(":memory:")
			case "mysql":
				dsn := os.Getenv("TEST_MYSQL_DSN")
				if dsn == "" {
					t.Skip("TEST_MYSQL_DSN not configured")
				}
				driver = mysql.Open(dsn)
			case "postgres":
				dsn := os.Getenv("TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("TEST_POSTGRES_DSN not configured")
				}
				driver = postgres.Open(dsn)
			}
			db, err := gorm.Open(driver, &gorm.Config{NamingStrategy: schema.NamingStrategy{TablePrefix: "policy_test_"}})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(1)
			previousDB, previousType, previousSnapshot := DB, common.MainDatabaseType(), CurrentRequestPolicy()
			common.OptionMapRWMutex.Lock()
			previousOptions := maps.Clone(common.OptionMap)
			common.OptionMap = maps.Clone(previousSnapshot.Options)
			common.OptionMapRWMutex.Unlock()
			DB = db
			common.SetMainDatabaseType(common.DatabaseType(dialect))
			initCol()
			t.Cleanup(func() {
				require.NoError(t, db.Migrator().DropTable(&SystemTask{}, &Option{}))
				for k, v := range previousSnapshot.Options {
					require.NoError(t, updateOptionMap(k, v))
				}
				requestPolicySnapshot.Store(previousSnapshot)
				common.OptionMapRWMutex.Lock()
				common.OptionMap = previousOptions
				common.OptionMapRWMutex.Unlock()
				DB = previousDB
				common.SetMainDatabaseType(previousType)
				initCol()
				require.NoError(t, sqlDB.Close())
			})
			require.NoError(t, db.AutoMigrate(&Option{}, &SystemTask{}))
			var version string
			query := "SELECT version()"
			if dialect == "sqlite" {
				query = "SELECT sqlite_version()"
			}
			require.NoError(t, db.Raw(query).Scan(&version).Error)
			t.Logf("database version: %s", version)
			rules := `[{"name":"session","model_regex":[".*"],"key_sources":[{"type":"request_header","key":"X-Session"}],"ttl_seconds":0,"skip_retry_on_failure":false,"include_using_group":false,"param_override_template":{"temperature":0},"future_field":{"enabled":false}}]`
			require.NoError(t, UpdateRequestPolicyOptions(map[string]string{"RetryTimes": "2", "channel_affinity_setting.rules": rules}))
			require.NoError(t, UpdateRequestPolicyOptions(map[string]string{"ContentAuditMode": "shadow", "ContentAuditProvider": "typesafe", "ContentAuditMaxChunks": "8", "ContentAuditTypesafePolicy": "Judge current intent", "ContentAuditPreflightScope": "signal", "SensitiveWordSignals": "窃取 API 密钥\nbypass billing", "SensitiveWords": ""}))
			previousCryptoSecret, previousCryptoConfigured := common.CryptoSecret, common.PersistentCryptoSecretConfigured
			common.CryptoSecret, common.PersistentCryptoSecretConfigured = "stable-policy-test-secret-with-entropy", true
			t.Cleanup(func() {
				common.CryptoSecret, common.PersistentCryptoSecretConfigured = previousCryptoSecret, previousCryptoConfigured
			})
			require.NoError(t, UpdateRequestPolicySettings(nil, map[string]string{"typesafe": "private-jev-fixture"}, nil))
			var secretOption Option
			require.NoError(t, db.Where(map[string]any{"key": "ContentAuditTypesafeApiKey"}).First(&secretOption).Error)
			assert.NotContains(t, secretOption.Value, "private-jev-fixture")
			assert.Contains(t, secretOption.Value, "enc:v1:")
			secret, source, err := ContentAuditCredential("typesafe")
			require.NoError(t, err)
			assert.Equal(t, "private-jev-fixture", secret)
			assert.Equal(t, "console", source)
			t.Setenv("TYPESAFE_API_KEY", "environment-jev-fixture")
			require.NoError(t, UpdateRequestPolicySettings(nil, nil, []string{"typesafe"}))
			secret, source, err = ContentAuditCredential("typesafe")
			require.NoError(t, err)
			assert.Equal(t, "environment-jev-fixture", secret)
			assert.Equal(t, "environment", source)
			t.Setenv("TYPESAFE_API_KEY", "")
			_, source, err = ContentAuditCredential("typesafe")
			require.NoError(t, err)
			assert.Empty(t, source)
			t.Setenv("TYPESAFE_API_KEY", "environment-jev-fixture")
			require.NoError(t, UpdateRequestPolicySettings(map[string]string{
				"ContentAuditProvider": "subq", "ContentAuditEndpoint": "https://api.subq.ai/v1/systemone", "ContentAuditModel": "subq-snap-1.2", "ContentAuditSubqPolicy": "SubQ-only boundary",
			}, map[string]string{"subq": "private-subq-fixture"}, nil))
			require.NoError(t, LoadOptionsFromDatabase())
			require.NoError(t, LoadOptionsFromDatabase())
			secretOption = Option{}
			require.NoError(t, db.Where(map[string]any{"key": "ContentAuditSubqApiKey"}).First(&secretOption).Error)
			assert.NotContains(t, secretOption.Value, "private-subq-fixture")
			secret, source, err = ContentAuditCredential("subq")
			require.NoError(t, err)
			assert.Equal(t, "private-subq-fixture", secret)
			assert.Equal(t, "console", source)
			assert.Equal(t, "SubQ-only boundary", CurrentRequestPolicy().Options["ContentAuditSubqPolicy"])
			assert.Equal(t, "Judge current intent", CurrentRequestPolicy().Options["ContentAuditTypesafePolicy"])
			assert.NotContains(t, CurrentRequestPolicy().Options, "ContentAuditSubqApiKey")
			assert.Error(t, UpdateOption("ContentAuditSubqApiKey", "must-not-be-plaintext"))
			assert.Error(t, UpdateOptionsBulk(map[string]string{"ContentAuditSubqApiKey": "must-not-be-plaintext"}))
			require.NoError(t, UpdateRequestPolicySettings(nil, nil, []string{"subq"}))
			t.Setenv("SUBQ_API_KEY", "")
			secret, source, err = ContentAuditCredential("subq")
			require.NoError(t, err)
			assert.Empty(t, secret, "SubQ never falls back to the Jev credential")
			assert.Empty(t, source)
			t.Setenv("SUBQ_API_KEY", "environment-subq-fixture")
			secret, source, err = ContentAuditCredential("subq")
			require.NoError(t, err)
			assert.Equal(t, "environment-subq-fixture", secret)
			assert.Equal(t, "environment", source)
			require.NoError(t, UpdateRequestPolicyOptions(map[string]string{"ContentAuditProvider": "typesafe"}))
			require.NoError(t, UpdateRequestPolicyOptions(map[string]string{"BehaviorAuditEnabled": "false"}))
			require.NoError(t, LoadOptionsFromDatabase())
			require.NoError(t, LoadOptionsFromDatabase())
			assert.False(t, CurrentRequestPolicy().BehaviorAuditEnabled)
			assert.Equal(t, "shadow", CurrentRequestPolicy().Options["ContentAuditMode"])
			assert.Equal(t, "typesafe", CurrentRequestPolicy().Options["ContentAuditProvider"])
			assert.Equal(t, "8", CurrentRequestPolicy().Options["ContentAuditMaxChunks"])
			assert.Equal(t, "Judge current intent", CurrentRequestPolicy().Options["ContentAuditTypesafePolicy"])
			require.NoError(t, UpdateOption("BehaviorAuditEnabled", "true"))
			assert.True(t, CurrentRequestPolicy().BehaviorAuditEnabled)
			assert.Equal(t, "shadow", CurrentRequestPolicy().Options["ContentAuditMode"], "behavior auditing never changes the content audit mode")
			assert.Len(t, CurrentRequestPolicy().TextSignals, 2)
			assert.Empty(t, CurrentRequestPolicy().TextKeywords)
			assert.Equal(t, 2, CurrentRequestPolicy().RetryTimes)
			assert.Equal(t, 2, common.RetryTimes, "the runtime global follows the same write")
			require.NoError(t, UpdateOption("AutomaticRetryStatusCodes", "429,500-503"))
			assert.Equal(t, "429,500-503", CurrentRequestPolicy().Options["AutomaticRetryStatusCodes"])
			assert.Equal(t, "429,500-503", operation_setting.AutomaticRetryStatusCodesToString())
			assert.Error(t, UpdateRequestPolicyOptions(map[string]string{"request_policy_setting.mode": "off"}), "the removed mode switch is not a policy option")
			assert.False(t, CurrentRequestPolicy().Affinity.Rules[0].SkipRetryOnFailure)
			assert.Equal(t, rules, CurrentRequestPolicy().Options["channel_affinity_setting.rules"])
			LoadOptionsFromDatabase()
			LoadOptionsFromDatabase()
			assert.Equal(t, rules, CurrentRequestPolicy().Options["channel_affinity_setting.rules"], "legacy rule JSON survives reloads without dropping extension fields")
			require.NoError(t, UpdateRequestPolicyOptions(map[string]string{"channel_affinity_setting.session_mode": "strict"}))
			LoadOptionsFromDatabase()
			LoadOptionsFromDatabase()
			assert.Equal(t, "strict", CurrentRequestPolicy().Affinity.SessionMode)
			assert.Equal(t, rules, CurrentRequestPolicy().Options["channel_affinity_setting.rules"], "a global mode never rewrites rule fields")
			snapshot := CurrentRequestPolicy()
			assert.Error(t, UpdateRequestPolicyOptions(map[string]string{"BehaviorAuditEnabled": "invalid"}))
			assert.Same(t, snapshot, CurrentRequestPolicy())
			assert.Error(t, UpdateRequestPolicyOptions(map[string]string{"channel_affinity_setting.session_mode": "unknown"}))
			assert.Same(t, snapshot, CurrentRequestPolicy())
			for _, value := range []string{"-1", "1.5", "bad", strconv.Itoa(math.MaxInt)} {
				assert.Error(t, UpdateRequestPolicyOptions(map[string]string{"RetryTimes": value}))
				assert.Same(t, snapshot, CurrentRequestPolicy())
			}
			assert.Error(t, UpdateRequestPolicyOptions(map[string]string{"channel_affinity_setting.rules": "[", "RetryTimes": "8"}))
			assert.Same(t, snapshot, CurrentRequestPolicy())
			var option Option
			require.NoError(t, db.Where(map[string]any{"key": "RetryTimes"}).First(&option).Error)
			assert.Equal(t, "2", option.Value)
			require.NoError(t, db.Callback().Update().Before("gorm:update").Register("policy_fail", func(tx *gorm.DB) {
				if tx.Statement.Table == "policy_test_options" {
					tx.AddError(errors.New("save rejected"))
				}
			}))
			assert.Error(t, UpdateRequestPolicyOptions(map[string]string{"RetryTimes": "8", "channel_affinity_setting.session_mode": "off"}))
			assert.Same(t, snapshot, CurrentRequestPolicy())
			require.NoError(t, db.Callback().Update().Remove("policy_fail"))
			option = Option{}
			require.NoError(t, db.Where(map[string]any{"key": "RetryTimes"}).First(&option).Error)
			assert.Equal(t, "2", option.Value)
			LoadOptionsFromDatabase()
			assert.Equal(t, "strict", CurrentRequestPolicy().Affinity.SessionMode, "a failed save keeps the persisted global mode")
		})
	}
}

func TestContentAuditPolicyOptionsValidateWithoutSecrets(t *testing.T) {
	options := maps.Clone(requestPolicyDefaultOptions())
	options["ContentAuditEnabled"] = "true"
	options["ContentAuditMode"] = "shadow"
	options["SensitiveWordSignals"] = "bypass captcha\nsteal api key"
	options["ContentAuditEndpoint"] = "https://audit.example/v1/chat/completions"
	options["ContentAuditModel"] = "audit-model"
	options["ContentAuditTimeoutMs"] = "2500"
	options["ContentAuditSampleRate"] = "0.1"
	options["ContentAuditReviewThreshold"] = "0.4"
	options["ContentAuditFlaggedThreshold"] = "0.7"
	options["ContentAuditPrompt"] = "Keep ordinary defensive testing in review-only mode."
	_, err := BuildRequestPolicy(options)
	require.NoError(t, err)

	for key, value := range map[string]string{
		"ContentAuditEndpoint":         "ftp://audit.example/v1/chat/completions",
		"ContentAuditProvider":         "unknown",
		"ContentAuditMaxChunks":        "17",
		"ContentAuditTimeoutMs":        "50",
		"ContentAuditSampleRate":       "1.5",
		"ContentAuditReviewThreshold":  "-0.1",
		"ContentAuditFlaggedThreshold": "not-a-number",
	} {
		invalid := maps.Clone(options)
		invalid[key] = value
		assert.Error(t, func() error {
			_, err := BuildRequestPolicy(invalid)
			return err
		}())
	}
	for _, endpoint := range []string{"http://audit.example/v1/chat/completions", "https://user:password@audit.example/v1/chat/completions", "https://audit.example/v1/chat/completions?key=value"} {
		invalid := maps.Clone(options)
		invalid["ContentAuditEndpoint"] = endpoint
		_, err := BuildRequestPolicy(invalid)
		assert.Error(t, err, "credential-bearing content audit endpoints must not include HTTP remotes or embedded credentials")
	}
}
