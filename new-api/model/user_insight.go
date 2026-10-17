package model

import (
	"context"
	"regexp"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

// UserInsightUser is deliberately separate from User: support views must not
// acquire credentials or security bindings when the User schema grows.
type UserInsightUser struct {
	Id              int    `json:"id"`
	Username        string `json:"username"`
	DisplayName     string `json:"display_name"`
	Email           string `json:"email"`
	Role            int    `json:"role"`
	Status          int    `json:"status"`
	Group           string `json:"group"`
	Remark          string `json:"remark"`
	CreatedAt       int64  `json:"created_at"`
	LastLoginAt     int64  `json:"last_login_at"`
	InviterId       int    `json:"inviter_id"`
	InviterUsername string `json:"inviter_username" gorm:"-"`
	Quota           int    `json:"quota"`
	UsedQuota       int    `json:"used_quota"`
	RequestCount    int    `json:"request_count"`
}

type UserInsightStats struct {
	SuccessfulTopups int64 `json:"successful_topups"`
	Redemptions      int64 `json:"redemptions"`
	Checkins         int64 `json:"checkins"`
	LogCount         int64 `json:"log_count"`
	ConsumeCount     int64 `json:"consume_count"`
	RefundCount      int64 `json:"refund_count"`
}

type UserInsightLimitations struct {
	WalletProvenanceComplete bool `json:"wallet_provenance_complete"`
	PaymentCurrencyRecorded  bool `json:"payment_currency_recorded"`
}

type UserInsightOverview struct {
	User        UserInsightUser        `json:"user"`
	Stats       UserInsightStats       `json:"stats"`
	Limitations UserInsightLimitations `json:"limitations"`
}

type UserInsightPage[T any] struct {
	Items    []T   `json:"items"`
	Total    int64 `json:"total"`
	Page     int   `json:"p"`
	PageSize int   `json:"page_size"`
}

// Money and Amount retain the historical order values. Neither is a reliable
// currency snapshot, and a zero CreditedQuota must remain unknown to the UI.
type UserInsightTopup struct {
	Id              int     `json:"id"`
	TradeNo         string  `json:"trade_no"`
	Amount          int64   `json:"amount"`
	CreditedQuota   int64   `json:"credited_quota"`
	Money           float64 `json:"money"`
	PaymentMethod   string  `json:"payment_method"`
	PaymentProvider string  `json:"payment_provider"`
	CreateTime      int64   `json:"create_time"`
	CompleteTime    int64   `json:"complete_time"`
	Status          string  `json:"status"`
}

type UserInsightRedemption struct {
	Id           int    `json:"id"`
	Name         string `json:"name"`
	Quota        int    `json:"quota"`
	RedeemedTime int64  `json:"redeemed_time"`
}

type UserInsightCheckin struct {
	Id           int    `json:"id"`
	CheckinDate  string `json:"checkin_date"`
	QuotaAwarded int    `json:"quota_awarded"`
	CreatedAt    int64  `json:"created_at"`
}

type UserInsightLog struct {
	Id               int    `json:"id"`
	CreatedAt        int64  `json:"created_at"`
	Type             int    `json:"type"`
	Content          string `json:"content"`
	ModelName        string `json:"model_name"`
	Quota            int    `json:"quota"`
	PromptTokens     int    `json:"prompt_tokens"`
	CompletionTokens int    `json:"completion_tokens"`
	UseTime          int    `json:"use_time"`
	IsStream         bool   `json:"is_stream"`
	ChannelId        int    `json:"channel_id"`
	TokenName        string `json:"token_name"`
	RequestId        string `json:"request_id"`
}

func GetUserInsightUser(ctx context.Context, id int) (UserInsightUser, error) {
	var user UserInsightUser
	err := DB.WithContext(ctx).Model(&User{}).Select([]string{
		"id", "username", "display_name", "email", "role", "status", "group", "remark",
		"created_at", "last_login_at", "inviter_id", "quota", "used_quota", "request_count",
	}).Where("id = ?", id).First(&user).Error
	return user, err
}

func GetUserInsightOverview(ctx context.Context, user UserInsightUser) (UserInsightOverview, error) {
	result := UserInsightOverview{User: user}
	if user.InviterId > 0 {
		var inviter UserInsightUser
		// A missing or deleted inviter is historical information, not an error.
		if err := DB.WithContext(ctx).Model(&User{}).Select("username").Where("id = ?", user.InviterId).Find(&inviter).Error; err != nil {
			return result, err
		}
		result.User.InviterUsername = inviter.Username
	}
	if err := DB.WithContext(ctx).Model(&TopUp{}).Where("user_id = ? AND status = ?", user.Id, common.TopUpStatusSuccess).Count(&result.Stats.SuccessfulTopups).Error; err != nil {
		return result, err
	}
	if err := DB.WithContext(ctx).Unscoped().Model(&Redemption{}).Where("used_user_id = ? AND status = ?", user.Id, common.RedemptionCodeStatusUsed).Count(&result.Stats.Redemptions).Error; err != nil {
		return result, err
	}
	if err := DB.WithContext(ctx).Model(&Checkin{}).Where("user_id = ?", user.Id).Count(&result.Stats.Checkins).Error; err != nil {
		return result, err
	}
	// Aggregate in the log database without loading the user's request history.
	var counts []struct {
		Type  int
		Total int64
	}
	if err := LOG_DB.WithContext(ctx).Model(&Log{}).Select("type, COUNT(*) AS total").Where("user_id = ?", user.Id).Group("type").Scan(&counts).Error; err != nil {
		return result, err
	}
	for _, count := range counts {
		result.Stats.LogCount += count.Total
		switch count.Type {
		case LogTypeConsume:
			result.Stats.ConsumeCount = count.Total
		case LogTypeRefund:
			result.Stats.RefundCount = count.Total
		}
	}
	return result, nil
}

func GetUserInsightTopups(ctx context.Context, userID, page, pageSize int) (UserInsightPage[UserInsightTopup], error) {
	result := UserInsightPage[UserInsightTopup]{Items: []UserInsightTopup{}, Page: page, PageSize: pageSize}
	query := DB.WithContext(ctx).Model(&TopUp{}).Where("user_id = ?", userID)
	if err := query.Count(&result.Total).Error; err != nil {
		return result, err
	}
	err := query.Select([]string{"id", "trade_no", "amount", "credited_quota", "money", "payment_method", "payment_provider", "create_time", "complete_time", "status"}).
		Order("create_time DESC, id DESC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&result.Items).Error
	return result, err
}

func GetUserInsightRedemptions(ctx context.Context, userID, page, pageSize int) (UserInsightPage[UserInsightRedemption], error) {
	result := UserInsightPage[UserInsightRedemption]{Items: []UserInsightRedemption{}, Page: page, PageSize: pageSize}
	// Used codes may subsequently be soft-deleted by administrative cleanup.
	// They remain part of the user's recorded quota history, without the code.
	query := DB.WithContext(ctx).Unscoped().Model(&Redemption{}).Where("used_user_id = ? AND status = ?", userID, common.RedemptionCodeStatusUsed)
	if err := query.Count(&result.Total).Error; err != nil {
		return result, err
	}
	err := query.Select([]string{"id", "name", "quota", "redeemed_time"}).Order("redeemed_time DESC, id DESC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&result.Items).Error
	return result, err
}

func GetUserInsightCheckins(ctx context.Context, userID, page, pageSize int) (UserInsightPage[UserInsightCheckin], error) {
	result := UserInsightPage[UserInsightCheckin]{Items: []UserInsightCheckin{}, Page: page, PageSize: pageSize}
	query := DB.WithContext(ctx).Model(&Checkin{}).Where("user_id = ?", userID)
	if err := query.Count(&result.Total).Error; err != nil {
		return result, err
	}
	err := query.Select([]string{"id", "checkin_date", "quota_awarded", "created_at"}).Order("created_at DESC, id DESC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&result.Items).Error
	return result, err
}

func GetUserInsightLogs(ctx context.Context, userID, page, pageSize, logType int) (UserInsightPage[UserInsightLog], error) {
	result := UserInsightPage[UserInsightLog]{Items: []UserInsightLog{}, Page: page, PageSize: pageSize}
	query := LOG_DB.WithContext(ctx).Model(&Log{}).Where("user_id = ?", userID)
	if logType != LogTypeUnknown {
		query = query.Where("type = ?", logType)
	}
	if err := query.Count(&result.Total).Error; err != nil {
		return result, err
	}
	order := "created_at DESC, id DESC"
	columns := []string{"id", "created_at", "type", "content", "model_name", "quota", "prompt_tokens", "completion_tokens", "use_time", "is_stream", "channel_id", "token_name", "request_id"}
	if common.UsingLogDatabase(common.DatabaseTypeClickHouse) {
		order = clickHouseLogOrder("")
		// ClickHouse logs have no auto-increment id; use display ids like the
		// existing log APIs and request_id as the stable identity.
		columns = columns[1:]
	}
	err := query.Select(columns).Order(order).Offset((page - 1) * pageSize).Limit(pageSize).Find(&result.Items).Error
	if err != nil {
		return result, err
	}
	for i := range result.Items {
		item := &result.Items[i]
		if common.UsingLogDatabase(common.DatabaseTypeClickHouse) {
			item.Id = (page-1)*pageSize + i + 1
		}
		item.Content = userInsightLogContent(item.Type, item.Content)
	}
	return result, nil
}

var userInsightSecrets = regexp.MustCompile(`(?i)\b(?:sk-[a-z0-9_-]+|(?:bearer|basic)\s+[^\s,;"']+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|password|client[_-]?secret|secret|authorization)["']?\s*[=:]\s*["']?(?:(?:bearer|basic)\s+)?[^\s,;"']+)`)
var userInsightBody = regexp.MustCompile(`(?i)(?:\b(?:request|response)[ _-]?body\b|\b(?:body|prompt|messages)["']?\s*[=:])`)

// Support summaries never expand provider error bodies or expose request
// prompts. Detailed diagnostics remain in the existing role-scoped log view.
func userInsightLogContent(logType int, content string) string {
	if logType == LogTypeError {
		return ""
	}
	content = strings.TrimSpace(content)
	if strings.HasPrefix(content, "[") {
		var messages []*common.Message
		if common.UnmarshalJsonStr(content, &messages) != nil {
			return ""
		}
		parts := make([]string, 0, len(messages))
		for _, message := range messages {
			if message != nil && message.Key != "" {
				parts = append(parts, message.Error())
			}
		}
		content = strings.Join(parts, ", ")
	} else if strings.HasPrefix(content, "{") {
		return ""
	}
	if location := userInsightBody.FindStringIndex(content); location != nil {
		content = content[:location[0]]
	}
	content = common.MaskSensitiveInfo(userInsightSecrets.ReplaceAllString(content, "[redacted]"))
	runes := []rune(content)
	if len(runes) > 1024 {
		content = string(runes[:1024]) + "…"
	}
	return strings.TrimSpace(content)
}
