package service

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/setting"
	"github.com/gin-gonic/gin"
)

var auditJobs = make(chan struct{}, 8)
var contentAuditStats struct {
	Requests, Flagged, Errors, Dropped, InFlight, LastErrorAt   int64
	Evaluations, RateLimited, Incomplete, SampledOut, Completed int64
	sync.Mutex
	Durations []int64
}

type ContentAuditHealth struct {
	Enabled          bool    `json:"enabled"`
	Configured       bool    `json:"configured"`
	Mode             string  `json:"mode"`
	Scope            string  `json:"preflight_scope"`
	Model            string  `json:"model"`
	TimeoutMS        int64   `json:"timeout_ms"`
	SampleRate       float64 `json:"sample_rate"`
	FlaggedThreshold float64 `json:"flagged_threshold"`
	ReviewThreshold  float64 `json:"review_threshold"`
	Requests         int64   `json:"requests"`
	Flagged          int64   `json:"flagged"`
	Errors           int64   `json:"errors"`
	Dropped          int64   `json:"dropped"`
	InFlight         int64   `json:"in_flight"`
	LastErrorAt      int64   `json:"last_error_at"`
	Evaluations      int64   `json:"evaluations"`
	RateLimited      int64   `json:"rate_limited"`
	Incomplete       int64   `json:"incomplete"`
	SampledOut       int64   `json:"sampled_out"`
	Completed        int64   `json:"completed"`
	P50MS            int64   `json:"p50_ms"`
	P95MS            int64   `json:"p95_ms"`
	P99MS            int64   `json:"p99_ms"`
	LatencySamples   int     `json:"latency_samples"`
}

func ContentAuditHealthSnapshot() ContentAuditHealth {
	cfg := LoadContentAuditConfig()
	h := ContentAuditHealth{Enabled: cfg.Mode != "off", Configured: cfg.Endpoint != "" && cfg.APIKey != "" && cfg.Model != "", Mode: cfg.Mode, Scope: cfg.Scope, Model: cfg.Model, TimeoutMS: cfg.Timeout.Milliseconds(), SampleRate: cfg.SampleRate, FlaggedThreshold: cfg.FlaggedThreshold, ReviewThreshold: cfg.ReviewThreshold,
		Requests: atomic.LoadInt64(&contentAuditStats.Requests), Flagged: atomic.LoadInt64(&contentAuditStats.Flagged), Errors: atomic.LoadInt64(&contentAuditStats.Errors), Dropped: atomic.LoadInt64(&contentAuditStats.Dropped), InFlight: atomic.LoadInt64(&contentAuditStats.InFlight), LastErrorAt: atomic.LoadInt64(&contentAuditStats.LastErrorAt), Evaluations: atomic.LoadInt64(&contentAuditStats.Evaluations), RateLimited: atomic.LoadInt64(&contentAuditStats.RateLimited), Incomplete: atomic.LoadInt64(&contentAuditStats.Incomplete), SampledOut: atomic.LoadInt64(&contentAuditStats.SampledOut), Completed: atomic.LoadInt64(&contentAuditStats.Completed)}
	contentAuditStats.Lock()
	durations := slices.Clone(contentAuditStats.Durations)
	contentAuditStats.Unlock()
	slices.Sort(durations)
	h.LatencySamples = len(durations)
	if len(durations) > 0 {
		h.P50MS = durations[(len(durations)-1)*50/100]
		h.P95MS = durations[(len(durations)*95+99)/100-1]
		h.P99MS = durations[(len(durations)*99+99)/100-1]
	}
	return h
}

func EvaluateContentAuditSegments(ctx context.Context, cfg ContentAuditConfig, text string) (ContentAuditResult, error) {
	return evaluateAuditInput(ctx, cfg, ContentAuditInput{Segments: []ContentAuditSegment{{Source: "normalized_request", Text: text}}, CoverageComplete: true})
}

func evaluateAuditInput(ctx context.Context, cfg ContentAuditConfig, input ContentAuditInput) (ContentAuditResult, error) {
	chunks, complete := auditInputChunks(input)
	if cfg.Mode == "shadow" && len(chunks) > 4 {
		chunks = chunks[:4]
		complete = false
	}
	merged := ContentAuditResult{Category: "none", PrimaryCategory: "none", Action: "allow", Context: "ambiguous", Categories: map[string]bool{}, CategoryScores: map[string]float64{}}
	if len(chunks) == 0 {
		return merged, nil
	}
	ctx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	type outcome struct {
		Result ContentAuditResult
		Err    error
	}
	jobs := make(chan ContentAuditSegment, len(chunks))
	results := make(chan outcome, len(chunks))
	for _, chunk := range chunks {
		jobs <- chunk
	}
	close(jobs)
	var workers sync.WaitGroup
	for range min(2, len(chunks)) {
		workers.Go(func() {
			for chunk := range jobs {
				data, _ := common.Marshal(chunk)
				result, err := EvaluateContentAudit(ctx, cfg, string(data))
				results <- outcome{result, err}
			}
		})
	}
	workers.Wait()
	close(results)
	var firstError error
	for item := range results {
		if item.Err != nil {
			if firstError == nil {
				firstError = item.Err
			}
			continue
		}
		current := item.Result
		scores, flags := merged.CategoryScores, merged.Categories
		if current.Flagged && (!merged.Flagged || current.Confidence > merged.Confidence) {
			merged = current
		}
		merged.CategoryScores = scores
		merged.Categories = flags
		for category, value := range current.CategoryScores {
			scores[category] = max(scores[category], value)
		}
		for category, value := range current.Categories {
			flags[category] = flags[category] || value
		}
	}
	if !complete {
		if firstError == nil {
			return merged, ErrContentAuditCoverage
		}
		return merged, errors.Join(ErrContentAuditCoverage, firstError)
	}
	return merged, firstError
}

func auditSample(c *gin.Context, userID, tokenID int, rate float64) bool {
	if rate <= 0 {
		return false
	}
	if rate >= 1 {
		return true
	}
	seed := sha256.Sum256([]byte(fmt.Sprintf("%d:%d:%s", userID, tokenID, c.GetString(common.RequestIdKey))))
	return float64(binary.BigEndian.Uint64(seed[:8])%1000000)/1000000 < rate
}

func runAudit(c *gin.Context, cfg ContentAuditConfig, userID, tokenID int, modelName string, input ContentAuditInput, signalHit bool) (ContentAuditResult, error) {
	started := time.Now()
	defer func() {
		atomic.AddInt64(&contentAuditStats.InFlight, -1)
		atomic.AddInt64(&contentAuditStats.Completed, 1)
		contentAuditStats.Lock()
		if len(contentAuditStats.Durations) >= 256 {
			contentAuditStats.Durations = contentAuditStats.Durations[1:]
		}
		contentAuditStats.Durations = append(contentAuditStats.Durations, time.Since(started).Milliseconds())
		contentAuditStats.Unlock()
	}()
	parent := context.Background()
	if c != nil && c.Request != nil {
		parent = c.Request.Context()
	}
	ctx, cancel := context.WithTimeout(parent, cfg.Timeout)
	defer cancel()
	result, err := evaluateAuditInput(ctx, cfg, input)
	if err != nil {
		if errors.Is(err, ErrContentAuditCoverage) {
			atomic.AddInt64(&contentAuditStats.Incomplete, 1)
		}
		// A deliberately bounded background sample is not a provider failure.
		if err != ErrContentAuditCoverage {
			atomic.AddInt64(&contentAuditStats.Errors, 1)
			atomic.StoreInt64(&contentAuditStats.LastErrorAt, time.Now().Unix())
		}
	}
	if result.Flagged {
		atomic.AddInt64(&contentAuditStats.Flagged, 1)
		length := 0
		for _, part := range input.Segments {
			length += utf8.RuneCountInString(part.Text)
		}
		if userID > 0 && tokenID > 0 {
			model.RecordAbuseSignal(c, userID, tokenID, "content_audit", model.AuditFields{"source": "deepseek", "mode": cfg.Mode, "category": result.Category, "category_scores": result.CategoryScores, "categories": result.Categories, "confidence": result.Confidence, "context": result.Context, "reason_code": result.ReasonCode, "action": "review", "audit_model": cfg.Model, "model_name": modelName, "input_length": length, "coverage_complete": err == nil, "keyword_signal": signalHit})
		}
	}
	return result, err
}

func enqueueAudit(c *gin.Context, cfg ContentAuditConfig, userID, tokenID int, modelName string, input ContentAuditInput, force bool) {
	if c == nil || userID <= 0 || tokenID <= 0 || len(input.Segments) == 0 {
		return
	}
	if !force && !auditSample(c, userID, tokenID, cfg.SampleRate) {
		atomic.AddInt64(&contentAuditStats.SampledOut, 1)
		return
	}
	select {
	case auditJobs <- struct{}{}:
	default:
		atomic.AddInt64(&contentAuditStats.Dropped, 1)
		return
	}
	copyContext := c.Copy()
	atomic.AddInt64(&contentAuditStats.Requests, 1)
	atomic.AddInt64(&contentAuditStats.InFlight, 1)
	if c.Request != nil {
		copyContext.Request = c.Request.Clone(context.Background())
	}
	go func() {
		defer func() { <-auditJobs }()
		_, _ = runAudit(copyContext, cfg, userID, tokenID, modelName, input, force)
	}()
}

// Kept for callers of the original shadow API. Signal audit uses the structured
// request path below, independent of both sensitive-word switches.
func EnqueueContentAuditShadow(c *gin.Context, userID, tokenID int, modelName, input string) {
	cfg := LoadContentAuditConfig()
	if cfg.Mode != "shadow" {
		return
	}
	enqueueAudit(c, cfg, userID, tokenID, modelName, BuildContentAuditInput(nil, input), false)
}

func CheckRequestContent(c *gin.Context, request dto.Request, modelName, normalized string) *types.NewAPIError {
	if setting.ShouldCheckPromptSensitive() {
		if hit, words := CheckSensitiveText(normalized); hit {
			if c.GetInt("id") > 0 && c.GetInt("token_id") > 0 {
				model.RecordAbuseSignal(c, c.GetInt("id"), c.GetInt("token_id"), "keyword_match", model.AuditFields{"source": "operator_block_rule", "match_count": len(words), "input_length": utf8.RuneCountInString(normalized)})
			}
			return types.NewError(errors.New("request matched an operator block rule"), types.ErrorCodeSensitiveWordsDetected, types.ErrOptionWithStatusCode(http.StatusForbidden), types.ErrOptionWithSkipRetry())
		}
	}
	cfg := LoadContentAuditConfig()
	if cfg.Mode == "off" {
		return nil
	}
	input := BuildContentAuditInput(request, normalized)
	var current strings.Builder
	for _, part := range input.Segments {
		if part.Current || part.Source == "normalized_request" {
			current.WriteString(part.Text)
			current.WriteByte('\n')
		}
	}
	hit, _ := CheckSensitiveSignalText(current.String())
	if len(input.Segments) == 0 {
		return nil
	}
	userID, tokenID := c.GetInt("id"), c.GetInt("token_id")
	if cfg.Mode == "shadow" || cfg.Scope != "all" && !hit {
		enqueueAudit(c, cfg, userID, tokenID, modelName, input, hit)
		return nil
	}
	atomic.AddInt64(&contentAuditStats.Requests, 1)
	atomic.AddInt64(&contentAuditStats.InFlight, 1)
	result, err := runAudit(c, cfg, userID, tokenID, modelName, input, hit)
	if err != nil {
		return types.NewError(errors.New("content audit temporarily unavailable"), types.ErrorCodeContentAuditUnavailable, types.ErrOptionWithStatusCode(http.StatusServiceUnavailable), types.ErrOptionWithSkipRetry())
	}
	if result.Flagged && result.Confidence >= cfg.FlaggedThreshold {
		return types.NewError(errors.New("request rejected by content policy"), types.ErrorCodeContentAuditRejected, types.ErrOptionWithStatusCode(http.StatusForbidden), types.ErrOptionWithSkipRetry())
	}
	return nil
}
