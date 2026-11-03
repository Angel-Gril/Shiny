package service

import (
	"testing"

	"github.com/QuantumNous/new-api/pkg/billingexpr"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestKimiOneHourCacheSplitDoesNotDoubleChargeInput(t *testing.T) {
	usage := &dto.Usage{PromptTokens: 10000, CompletionTokens: 100, PromptTokensDetails: dto.InputTokenDetails{CachedTokens: 2000, CacheWriteTokens: 3000, CacheWriteTokensDetails: &dto.CacheWriteTokenDetails{TTL1hTokens: 3000}}}
	for _, tc := range []struct {
		expr              string
		p, cc, cc1h, cost float64
	}{
		{`tier("base", p * 13 + cr * 1.3 + cc * 13 + cc1h * 26 + c * 68)`, 5000, 0, 3000, 152400},
		{`tier("base", p * 13 + cr * 1.3 + cc * 13 + c * 68)`, 5000, 6000, 0, 152400},
		{`tier("base", p * 13 + cr * 1.3 + c * 68)`, 11000, 0, 0, 152400},
	} {
		params := BuildTieredTokenParams(usage, false, billingexpr.UsedVars(tc.expr))
		assert.Equal(t, tc.p, params.P)
		assert.Equal(t, tc.cc, params.CC)
		assert.Equal(t, tc.cc1h, params.CC1h)
		assert.Equal(t, float64(10000), params.Len)
		cost, _, err := billingexpr.RunExpr(tc.expr, params)
		require.NoError(t, err)
		assert.Equal(t, tc.cost, cost)
	}
}
