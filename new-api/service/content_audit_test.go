package service

import (
	"context"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestAuditModesAndQuotedKeywordRegression(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.Option{}, &model.AbuseReview{}, &model.AuditLog{}))
	oldDB, oldLog := model.DB, model.LOG_DB
	oldPolicy := maps.Clone(model.CurrentRequestPolicy().Options)
	common.OptionMapRWMutex.Lock()
	oldOptions := common.OptionMap
	common.OptionMap = maps.Clone(oldPolicy)
	common.OptionMapRWMutex.Unlock()
	oldSensitive, oldPrompt := setting.CheckSensitiveEnabled, setting.CheckSensitiveOnPromptEnabled
	model.DB, model.LOG_DB = db, db
	t.Cleanup(func() {
		require.NoError(t, model.UpdateRequestPolicyOptions(oldPolicy))
		model.DB, model.LOG_DB = oldDB, oldLog
		common.OptionMapRWMutex.Lock()
		common.OptionMap = oldOptions
		common.OptionMapRWMutex.Unlock()
		setting.CheckSensitiveEnabled, setting.CheckSensitiveOnPromptEnabled = oldSensitive, oldPrompt
	})
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		encoded, _ := common.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": `{"flagged":false,"category":"none","confidence":0,"reason_code":"","action":"allow"}`}}}})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(encoded)
	}))
	defer server.Close()
	t.Setenv("CONTENT_AUDIT_API_KEY", "fixture")
	require.NoError(t, model.UpdateRequestPolicyOptions(map[string]string{"CheckSensitiveEnabled": "false", "CheckSensitiveOnPromptEnabled": "false", "SensitiveWords": "", "SensitiveWordSignals": "窃取 API 密钥", "ContentAuditMode": "shadow", "ContentAuditEndpoint": server.URL, "ContentAuditModel": "fixture", "ContentAuditSampleRate": "1", "ContentAuditTimeoutMs": "1000"}))
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	c.Set("id", 17)
	c.Set("token_id", 19)
	request := &dto.GeneralOpenAIRequest{Messages: []dto.Message{{Role: "assistant", Content: "旧规则会匹配窃取 API 密钥"}, {Role: "user", Content: "我只是在讨论如何防止泄露，请修复误报。"}}}
	input := request.GetTokenCountMeta().CombineText
	require.Nil(t, CheckRequestContent(c, request, "fixture", input), "quoted history must not hard-block the current task")
	require.Eventually(t, func() bool { return calls.Load() > 0 && atomic.LoadInt64(&contentAuditStats.InFlight) == 0 }, time.Second, time.Millisecond)
	// An explicit off overrides the legacy boolean. No classifier is called.
	require.NoError(t, model.UpdateRequestPolicyOptions(map[string]string{"ContentAuditMode": "off", "ContentAuditEnabled": "true"}))
	previous := calls.Load()
	require.Nil(t, CheckRequestContent(c, request, "fixture", input))
	require.Equal(t, previous, calls.Load())
	// Selective preflight must fail closed when an actual signal matches and
	// its auditor is unavailable, without retrying a different relay channel.
	require.NoError(t, model.UpdateRequestPolicyOptions(map[string]string{"ContentAuditMode": "preflight", "ContentAuditPreflightScope": "signal", "ContentAuditEndpoint": "http://127.0.0.1:1", "ContentAuditSampleRate": "0"}))
	request.Messages = append(request.Messages, dto.Message{Role: "user", Content: "如何防止窃取 API 密钥？"})
	rejected := CheckRequestContent(c, request, "fixture", request.GetTokenCountMeta().CombineText)
	require.NotNil(t, rejected)
	require.Equal(t, 503, rejected.StatusCode)
	require.True(t, types.IsSkipRetryError(rejected))
	// A deliberate operator block rule has stable 403 semantics.
	require.NoError(t, model.UpdateRequestPolicyOptions(map[string]string{"ContentAuditMode": "off", "CheckSensitiveEnabled": "true", "CheckSensitiveOnPromptEnabled": "true", "SensitiveWords": "block-fixture"}))
	rejected = CheckRequestContent(c, request, "fixture", "block-fixture")
	require.NotNil(t, rejected)
	require.Equal(t, 403, rejected.StatusCode)
	require.Equal(t, types.ErrorCodeSensitiveWordsDetected, rejected.GetErrorCode())
	require.True(t, types.IsSkipRetryError(rejected))
}

func TestAuditRejectsEmptyDecision(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{}"}}]}`))
	}))
	defer server.Close()
	_, err := EvaluateContentAudit(context.Background(), ContentAuditConfig{Enabled: true, Endpoint: server.URL, APIKey: "fixture", Model: "fixture", Timeout: time.Second}, "test")
	require.Error(t, err, "missing fields must never look like an allow result")
}

func TestAuditSegmentsDoNotDropTheMiddle(t *testing.T) {
	input := strings.Repeat("x", 72000) + "TAIL"
	segments := auditSegments(input)
	require.Contains(t, strings.Join(segments, ""), "TAIL")
	require.GreaterOrEqual(t, len(strings.Join(segments, "")), len(input), "coverage must never silently truncate")
}

func TestAuditMergeDoesNotLoseFlaggedResultToBenignConfidence(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		require.NoError(t, common.DecodeJson(r.Body, &body))
		decision := `{"flagged":false,"category":"none","confidence":0.99,"reason_code":"","action":"allow"}`
		if strings.Contains(body.Messages[1].Content, "MALICIOUS") {
			decision = `{"flagged":true,"category":"credential_theft","confidence":0.90,"reason_code":"credential_theft","action":"review"}`
		}
		encoded, _ := common.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": decision}}}})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(encoded)
	}))
	defer server.Close()
	result, err := EvaluateContentAuditSegments(context.Background(), ContentAuditConfig{Enabled: true, Endpoint: server.URL, APIKey: "fixture", Model: "fixture", Timeout: time.Second}, strings.Repeat("x", 6000)+"MALICIOUS")
	require.NoError(t, err)
	require.True(t, result.Flagged)
	require.Equal(t, "credential_theft", result.Category)
}

func TestAuditInputKeepsSourcesAndPrioritizesLatest(t *testing.T) {
	request := &dto.GeneralOpenAIRequest{Messages: []dto.Message{{Role: "system", Content: "client instruction"}, {Role: "user", Content: "earlier question"}, {Role: "tool", Content: "external result"}, {Role: "user", Content: "latest question"}}}
	input := BuildContentAuditInput(request, "")
	require.Equal(t, "user", input.Segments[0].Source)
	require.Contains(t, input.Segments[0].Text, "latest question")
	require.Equal(t, "tool", input.Segments[1].Source)
	require.True(t, input.Segments[1].Current)
	require.Contains(t, fmt.Sprint(input.Segments), "external result")
	require.Contains(t, fmt.Sprint(input.Segments), "client instruction")
}

func TestEvaluateContentAuditParsesStrictShadowResult(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"flagged\":true,\"category\":\"cyber_abuse\",\"confidence\":0.91,\"reason_code\":\"third_party_attack\",\"action\":\"review\"}"}}]}`))
	}))
	defer server.Close()
	result, err := EvaluateContentAudit(context.Background(), ContentAuditConfig{
		Enabled: true, Endpoint: server.URL, APIKey: "test-key", Model: "audit-model", Timeout: time.Second,
	}, "audit this")
	require.NoError(t, err)
	require.True(t, result.Flagged)
	require.Equal(t, "cyber_abuse", result.Category)
	require.Equal(t, "review", result.Action)
}

func TestEvaluateContentAuditTreatsDefensiveContextAsNonFlagged(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"flagged\":true,\"categories\":{\"credential_theft\":true,\"cyber_abuse\":false,\"security_bypass\":false,\"bulk_account_abuse\":false,\"provider_policy_evasion\":false,\"cost_abuse\":false},\"category_scores\":{\"credential_theft\":0.92,\"cyber_abuse\":0,\"security_bypass\":0,\"bulk_account_abuse\":0,\"provider_policy_evasion\":0,\"cost_abuse\":0},\"primary_category\":\"credential_theft\",\"context\":\"defensive\",\"reason_code\":\"quoted_defense\"}"}}]}`))
	}))
	defer server.Close()
	result, err := EvaluateContentAudit(context.Background(), ContentAuditConfig{
		Enabled: true, Endpoint: server.URL, APIKey: "test-key", Model: "audit-model", Timeout: time.Second,
	}, "how do I prevent credential theft?")
	require.NoError(t, err)
	require.False(t, result.Flagged)
	require.Equal(t, "credential_theft", result.Category)
}

func TestEvaluateContentAuditRejectsInvalidDecision(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"flagged\":true,\"category\":\"unknown\",\"confidence\":0.9,\"reason_code\":\"x\",\"action\":\"block\"}"}}]}`))
	}))
	defer server.Close()
	_, err := EvaluateContentAudit(context.Background(), ContentAuditConfig{
		Enabled: true, Endpoint: server.URL, APIKey: "test-key", Model: "audit-model", Timeout: time.Second,
	}, "audit this")
	require.Error(t, err)
}

func TestEvaluateContentAuditDisabledDoesNotCallEndpoint(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer server.Close()
	_, err := EvaluateContentAudit(context.Background(), ContentAuditConfig{Endpoint: server.URL}, "audit this")
	require.ErrorIs(t, err, ErrContentAuditDisabled)
	require.False(t, called)
}

func TestEvaluateContentAuditOversizeDoesNotSilentlyTruncate(t *testing.T) {
	_, err := EvaluateContentAudit(context.Background(), ContentAuditConfig{Enabled: true, Endpoint: "http://unused.invalid", APIKey: "fixture", Model: "fixture"}, strings.Repeat("审", 13000))
	require.ErrorIs(t, err, ErrContentAuditCoverage)
}

func TestAuditSegmentsCoverHeadAndTailWithoutSilentTruncation(t *testing.T) {
	segments := auditSegments(strings.Repeat("前", 6000) + strings.Repeat("中", 6000) + strings.Repeat("后", 6000))
	require.Greater(t, len(segments), 3)
	require.Equal(t, "前", string([]rune(segments[0])[0]))
	require.Equal(t, "后", string([]rune(segments[len(segments)-1])[len([]rune(segments[len(segments)-1]))-1]))
}

func TestEvaluateContentAuditTimeoutFailsClosed(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(50 * time.Millisecond)
		_, _ = w.Write([]byte(`{"choices":[]}`))
	}))
	defer server.Close()
	_, err := EvaluateContentAudit(context.Background(), ContentAuditConfig{
		Enabled: true, Endpoint: server.URL, APIKey: "test-key", Model: "audit-model", Timeout: 5 * time.Millisecond,
	}, "timeout")
	require.Error(t, err)
}

func TestEvaluateContentAuditRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 70*1024)))
	}))
	defer server.Close()
	_, err := EvaluateContentAudit(context.Background(), ContentAuditConfig{
		Enabled: true, Endpoint: server.URL, APIKey: "test-key", Model: "audit-model", Timeout: time.Second,
	}, "oversized")
	require.Error(t, err)
}

func TestFetchContentAuditModelsDiscoversAndDeduplicatesIDs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/models", r.URL.Path)
		require.Equal(t, "Bearer test-key", r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"audit-small"},{"id":"audit-small"},{"id":"audit-large"}]}`))
	}))
	defer server.Close()
	t.Setenv("CONTENT_AUDIT_API_KEY", "test-key")
	models, err := FetchContentAuditModels(context.Background(), server.URL+"/v1/chat/completions")
	require.NoError(t, err)
	require.Equal(t, []string{"audit-small", "audit-large"}, models)
}

func TestEvaluateContentAuditAppendsCompletionsPathForV1Endpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/chat/completions", r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"flagged\":false,\"category\":\"none\",\"confidence\":0,\"reason_code\":\"\",\"action\":\"allow\"}"}}]}`))
	}))
	defer server.Close()
	result, err := EvaluateContentAudit(context.Background(), ContentAuditConfig{
		Enabled: true, Endpoint: server.URL + "/v1", APIKey: "test-key", Model: "audit-model", Timeout: time.Second,
	}, "hello")
	require.NoError(t, err)
	require.False(t, result.Flagged)
}

func TestContentAuditHealthReportsConfigurationWithoutSecrets(t *testing.T) {
	t.Setenv("CONTENT_AUDIT_ENABLED", "true")
	t.Setenv("CONTENT_AUDIT_ENDPOINT", "https://audit.example.invalid/v1/chat/completions")
	t.Setenv("CONTENT_AUDIT_API_KEY", "do-not-return-this")
	t.Setenv("CONTENT_AUDIT_MODEL", "safe-audit-model")
	t.Setenv("CONTENT_AUDIT_TIMEOUT_MS", "3500")
	t.Setenv("CONTENT_AUDIT_SAMPLE_RATE", "0.25")
	health := ContentAuditHealthSnapshot()
	require.True(t, health.Enabled)
	require.True(t, health.Configured)
	require.Equal(t, "safe-audit-model", health.Model)
	require.Equal(t, int64(3500), health.TimeoutMS)
	require.Equal(t, 0.25, health.SampleRate)
}

func TestEnqueueContentAuditShadowCreatesPendingReview(t *testing.T) {
	previousDB := model.DB
	db, err := gorm.Open(sqlite.Open("file::memory:?cache=shared"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.AbuseReview{}))
	model.DB = db
	t.Cleanup(func() { model.DB = previousDB })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"flagged\":true,\"category\":\"cyber_abuse\",\"confidence\":0.88,\"reason_code\":\"third_party_attack\",\"action\":\"review\"}"}}]}`))
	}))
	defer server.Close()
	t.Setenv("CONTENT_AUDIT_ENABLED", "true")
	t.Setenv("CONTENT_AUDIT_ENDPOINT", server.URL)
	t.Setenv("CONTENT_AUDIT_API_KEY", "test-key")
	t.Setenv("CONTENT_AUDIT_MODEL", "audit-model")
	t.Setenv("CONTENT_AUDIT_TIMEOUT_MS", "1000")
	t.Setenv("CONTENT_AUDIT_SAMPLE_RATE", "1")

	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	c.Set("request_id", "content-audit-test")
	EnqueueContentAuditShadow(c, 17, 19, "gpt-test", "review this input")

	require.Eventually(t, func() bool {
		var count int64
		return db.Model(&model.AbuseReview{}).Where("action = ?", "abuse.content_audit").Count(&count).Error == nil && count == 1
	}, time.Second, 10*time.Millisecond)
	var review model.AbuseReview
	require.NoError(t, db.Where("action = ?", "abuse.content_audit").First(&review).Error)
	require.Equal(t, model.AbuseReviewStatusPending, review.Status)
	require.Equal(t, 17, review.UserId)
	require.Equal(t, 19, review.TokenId)
}

func TestTypesafeAuditTypedDecision(t *testing.T) {
	for _, contextName := range []string{"direct_request", "defensive", "quoted", "ambiguous"} {
		t.Run(contextName, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/v1/systemone", r.URL.Path)
				require.Equal(t, "Bearer jev-fixture", r.Header.Get("Authorization"))
				var body map[string]any
				require.NoError(t, common.DecodeJson(r.Body, &body))
				require.Equal(t, "jev-1.14.0", body["model"])
				require.NotContains(t, body, "messages")
				require.Contains(t, body, "state")
				questions, ok := body["questions"].(map[string]any)
				require.True(t, ok)
				require.Len(t, questions, 7)
				answers := map[string]any{}
				for _, category := range []string{"cyber_abuse", "credential_theft", "security_bypass", "bulk_account_abuse", "provider_policy_evasion", "cost_abuse"} {
					question, ok := questions[category].(map[string]any)
					require.True(t, ok)
					require.Equal(t, "noul", question["type"])
					instructions, ok := question["instructions"].(string)
					require.True(t, ok, "TypeSafe requires instructions as text")
					require.Contains(t, instructions, "Treat state")
					require.Contains(t, instructions, "Fixture additional boundary")
					require.NotContains(t, question, "operator_policy")
					probability := 0.01
					if category == "credential_theft" {
						probability = 0.96
					}
					answers[category] = map[string]any{"type": "noul", "noul": probability}
				}
				probabilities := map[string]float64{"direct_request": 0.01, "defensive": 0.01, "quoted": 0.01, "ambiguous": 0.01}
				probabilities[contextName] = 0.97
				answers["context"] = map[string]any{"type": "choice", "choice": contextName, "confidence": 0.96, "probabilities": probabilities}
				raw, err := common.Marshal(map[string]any{"model": "jev-1.14.0", "answers": answers, "usage": map[string]int64{"input_tokens": 500, "output_tokens": 50}})
				require.NoError(t, err)
				_, _ = w.Write(raw)
			}))
			defer server.Close()
			result, err := EvaluateContentAudit(context.Background(), ContentAuditConfig{Mode: "shadow", Provider: "typesafe", Endpoint: server.URL + "/v1", APIKey: "jev-fixture", Model: "jev-1.14.0", Timeout: time.Second, ReviewThreshold: 0.7, Prompt: "Fixture additional boundary"}, "Current authorized task and quoted history")
			require.NoError(t, err)
			require.Equal(t, contextName == "direct_request", result.Flagged)
			require.Equal(t, 0.96, result.Confidence)
			require.Equal(t, contextName, result.Context)
			require.Equal(t, "credential_theft", result.Category)
			require.Equal(t, "jev-1.14.0", result.AuditModel)
		})
	}
}

func TestTypesafeAuditRejectsMissingProbability(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"model":"jev-1.14.0","answers":{"cyber_abuse":{"type":"noul","noul":0.99}}}`))
	}))
	defer server.Close()
	_, err := EvaluateContentAudit(context.Background(), ContentAuditConfig{Mode: "preflight", Provider: "typesafe", Endpoint: server.URL, APIKey: "fixture", Model: "jev-1.14.0", Timeout: time.Second}, "input")
	require.Error(t, err, "incomplete Jev answers must not become an allow")
}

func TestTypesafeAuditTreatsLowContextProbabilityAsAmbiguous(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		answers := map[string]any{}
		for _, category := range []string{"cyber_abuse", "credential_theft", "security_bypass", "bulk_account_abuse", "provider_policy_evasion", "cost_abuse"} {
			probability := 0.02
			if category == "cyber_abuse" {
				probability = 0.99
			}
			answers[category] = map[string]any{"type": "noul", "noul": probability}
		}
		answers["context"] = map[string]any{
			"type": "choice", "choice": "direct_request",
			"probabilities": map[string]float64{"direct_request": 0.69, "defensive": 0.11, "quoted": 0.1, "ambiguous": 0.1},
		}
		_, _ = w.Write(mustMarshalAuditFixture(t, map[string]any{"model": "jev-1.14.0", "answers": answers}))
	}))
	defer server.Close()
	before := ContentAuditHealthSnapshot()
	result, err := EvaluateContentAudit(context.Background(), ContentAuditConfig{Mode: "preflight", Provider: "typesafe", Endpoint: server.URL, APIKey: "fixture", Model: "jev-1.14.0", Timeout: time.Second, ReviewThreshold: 0.7}, "unclear")
	require.NoError(t, err)
	require.Equal(t, "ambiguous", result.Context)
	require.False(t, result.Flagged, "a high category score cannot turn uncertain intent into an abuse flag")
	after := ContentAuditHealthSnapshot()
	require.Equal(t, before.InputTokens, after.InputTokens, "missing usage must not be reported as zero-token usage")
	require.Equal(t, before.OutputTokens, after.OutputTokens)
	require.Equal(t, before.UsageUnreported+1, after.UsageUnreported)
}

func TestTypesafeAuditRateLimitDoesNotRetryOrExposeProviderBody(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		http.Error(w, "fixture-provider-secret", http.StatusTooManyRequests)
	}))
	defer server.Close()
	_, err := EvaluateContentAudit(context.Background(), ContentAuditConfig{Mode: "shadow", Provider: "typesafe", Endpoint: server.URL, APIKey: "fixture", Model: "jev-1.14.0", Timeout: time.Second}, "input")
	require.Error(t, err)
	require.NotContains(t, err.Error(), "fixture-provider-secret")
	require.EqualValues(t, 1, calls.Load(), "audit rate limits must not create retries or duplicate charges")
}

func mustMarshalAuditFixture(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	return encoded
}

func TestShadowAuditChunkBudgetIsExplicit(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"model":"jev-1.14.0","answers":{"context":{"type":"choice","choice":"defensive","probabilities":{"direct_request":0.01,"defensive":0.97,"quoted":0.01,"ambiguous":0.01}},"cyber_abuse":{"type":"noul","noul":0.99},"credential_theft":{"type":"noul","noul":0.01},"security_bypass":{"type":"noul","noul":0.01},"bulk_account_abuse":{"type":"noul","noul":0.01},"provider_policy_evasion":{"type":"noul","noul":0.01},"cost_abuse":{"type":"noul","noul":0.01}}}`))
	}))
	defer server.Close()
	input := ContentAuditInput{CoverageComplete: true, Segments: []ContentAuditSegment{{Source: "current", Current: true, Text: strings.Repeat("request", 5000)}}}
	result, err := evaluateAuditInput(context.Background(), ContentAuditConfig{Mode: "shadow", Provider: "typesafe", Endpoint: server.URL, APIKey: "fixture", Model: "jev-1.14.0", Timeout: time.Second, ReviewThreshold: 0.7, MaxChunks: 1}, input)
	require.ErrorIs(t, err, ErrContentAuditCoverage)
	require.False(t, result.Flagged, "defensive context must stay unflagged even when a category score is high")
	require.EqualValues(t, 1, calls.Load(), "only the configured shadow chunk budget is evaluated")
	require.False(t, result.Categories["none"], "a positive category signal must not contradict the none flag")
}

func TestTypesafeModelsAndDedicatedKey(t *testing.T) {
	t.Setenv("CONTENT_AUDIT_API_KEY", "legacy-fixture-key")
	t.Setenv("TYPESAFE_API_KEY", "jev-fixture-key")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/models", r.URL.Path)
		require.Equal(t, "Bearer jev-fixture-key", r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"models":[{"name":"jev-latest"},{"name":"jev-latest"},{"name":"jev-1.14.0"}]}`))
	}))
	defer server.Close()
	models, err := FetchContentAuditModelsForProvider(context.Background(), server.URL+"/v1/systemone", "typesafe")
	require.NoError(t, err)
	require.Equal(t, []string{"jev-latest", "jev-1.14.0"}, models)
	t.Setenv("TYPESAFE_API_KEY", "")
	_, err = FetchContentAuditModelsForProvider(context.Background(), server.URL+"/v1/systemone", "typesafe")
	require.Error(t, err, "Jev must never fall back to the DeepSeek key")
}

func TestContentAuditModelCheckUsesUnsavedKeyWithoutReturningIt(t *testing.T) {
	t.Setenv("CONTENT_AUDIT_API_KEY", "")
	t.Setenv("TYPESAFE_API_KEY", "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/models", r.URL.Path)
		require.Equal(t, "Bearer unsaved-credential-fixture", r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"models":[{"name":"jev-1.14.0"}]}`))
	}))
	defer server.Close()
	models, err := FetchContentAuditModelsWithAPIKey(context.Background(), server.URL+"/v1/systemone", "typesafe", "unsaved-credential-fixture")
	require.NoError(t, err)
	require.Equal(t, []string{"jev-1.14.0"}, models)
}

func TestContentAuditRefusesCredentialRedirect(t *testing.T) {
	var targetCalls atomic.Int64
	var forwardedCredentials atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetCalls.Add(1)
		if r.Header.Get("Authorization") != "" {
			forwardedCredentials.Add(1)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"flagged\":false,\"category\":\"none\",\"confidence\":0,\"reason_code\":\"\",\"action\":\"allow\"}"}}]}`))
	}))
	defer target.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	_, err := EvaluateContentAudit(context.Background(), ContentAuditConfig{Mode: "shadow", Provider: "typesafe", Endpoint: origin.URL, APIKey: "fixture", Model: "fixture", Timeout: time.Second}, "fixture")
	require.Error(t, err)
	require.Zero(t, targetCalls.Load(), "TypeSafe audit credentials must not follow redirects")
	_, err = EvaluateContentAudit(context.Background(), ContentAuditConfig{Mode: "shadow", Provider: "chat_completions", Endpoint: origin.URL, APIKey: "fixture", Model: "fixture", Timeout: time.Second}, "fixture")
	require.Error(t, err)
	require.EqualValues(t, 0, targetCalls.Load(), "audit credentials must not be forwarded through redirects")
	require.Zero(t, forwardedCredentials.Load())
}
