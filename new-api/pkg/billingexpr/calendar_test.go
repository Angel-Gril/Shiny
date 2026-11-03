package billingexpr_test

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/pkg/billingexpr"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDeepSeekPeakExpressionIsSupported(t *testing.T) {
	_, err := billingexpr.CompileFromCache(`deepseekPeak() ? tier("peak", p * 2) : tier("off_peak", p * 1)`)
	require.NoError(t, err)
}

func TestDeepSeekCalendarAndBoundaries(t *testing.T) {
	for _, tc := range []struct {
		at          string
		peak, ready bool
		reason      string
	}{
		{"2026-11-04T08:59:59+08:00", false, true, "off_peak"},
		{"2026-11-04T09:00:00+08:00", true, true, "peak"},
		{"2026-11-04T11:59:59+08:00", true, true, "peak"},
		{"2026-11-04T12:00:00+08:00", false, true, "off_peak"},
		{"2026-11-04T14:00:00+08:00", true, true, "peak"},
		{"2026-11-04T18:00:00+08:00", false, true, "off_peak"},
		{"2026-10-01T10:00:00+08:00", false, true, "public_holiday"},
		{"2026-02-23T10:00:00+08:00", false, true, "public_holiday"},
		{"2026-10-10T10:00:00+08:00", false, true, "weekend"},
		{"2027-01-04T10:00:00+08:00", false, false, "missing_calendar"},
	} {
		t.Run(tc.at, func(t *testing.T) {
			at, err := time.Parse(time.RFC3339, tc.at)
			require.NoError(t, err)
			status := billingexpr.DeepSeekPeriodAt(at)
			assert.Equal(t, tc.peak, status.Peak)
			assert.Equal(t, tc.ready, status.CalendarReady)
			assert.Equal(t, tc.reason, status.Reason)
			cost, trace, err := billingexpr.RunExprWithRequest(`deepseekPeak() ? tier("peak", p * 2) : tier("off_peak", p * 1)`, billingexpr.TokenParams{P: 100}, billingexpr.RequestInput{BillingTime: at})
			require.NoError(t, err)
			expected := float64(100)
			if tc.peak {
				expected = 200
			}
			assert.Equal(t, expected, cost)
			require.NotNil(t, trace.DeepSeekPeriod)
			assert.Equal(t, tc.peak, trace.DeepSeekPeriod.Peak)
		})
	}
}

func TestSettlementUsesFrozenArrivalAndCalendar(t *testing.T) {
	at, err := time.Parse(time.RFC3339, "2026-11-04T08:59:59+08:00")
	require.NoError(t, err)
	expression := `deepseekPeak() ? tier("peak", p * 2) : tier("off_peak", p * 1)`
	_, trace, err := billingexpr.RunExprWithRequest(expression, billingexpr.TokenParams{P: 1000}, billingexpr.RequestInput{BillingTime: at})
	require.NoError(t, err)
	snap := &billingexpr.BillingSnapshot{ExprString: expression, ExprHash: billingexpr.ExprHashString(expression), BillingTime: at, DeepSeekPeriod: trace.DeepSeekPeriod, QuotaPerUnit: 500000, GroupRatio: .35, EstimatedTier: trace.MatchedTier}
	result, err := billingexpr.ComputeTieredQuotaWithRequest(snap, billingexpr.TokenParams{P: 1000}, billingexpr.RequestInput{BillingTime: at.Add(2 * time.Hour), DeepSeekPeriod: &billingexpr.DeepSeekPeriod{Peak: true}})
	require.NoError(t, err)
	assert.Equal(t, 175, result.ActualQuotaAfterGroup)
	assert.Equal(t, "off_peak", result.MatchedTier)
	assert.False(t, result.CrossedTier)
	// Calendar/clock changes at settlement cannot retroactively reprice the request.
	assert.Equal(t, trace.DeepSeekPeriod, result.DeepSeekPeriod)
	expression = `hour("Asia/Shanghai") < 9 ? tier("early", p * 1) : tier("late", p * 2)`
	snap.ExprString, snap.ExprHash = expression, billingexpr.ExprHashString(expression)
	result, err = billingexpr.ComputeTieredQuotaWithRequest(snap, billingexpr.TokenParams{P: 1000}, billingexpr.RequestInput{BillingTime: at.Add(2 * time.Hour)})
	require.NoError(t, err)
	assert.Equal(t, "early", result.MatchedTier)
}
