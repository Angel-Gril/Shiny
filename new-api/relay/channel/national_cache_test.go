package channel

import (
	"net/http"
	"strings"
	"testing"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestKimiCachePolicyUsesEffectiveOutboundBodyAndResetsOnRetry(t *testing.T) {
	info := &relaycommon.RelayInfo{OriginModelName: "kimi-k3.1-pro", RelayFormat: types.RelayFormatOpenAI}
	for _, tc := range []struct{ body, expected string }{
		{`{"prompt_cache_options":{"ttl":"1h"}}`, "1h"},
		{`{"prompt_cache_options":{"ttl":"5m"}}`, "5m"},
		{`{}`, "5m"},
	} {
		req, err := http.NewRequest(http.MethodPost, "http://example.invalid", strings.NewReader(tc.body))
		require.NoError(t, err)
		require.NoError(t, captureKimiCacheTTL(req, info))
		assert.Equal(t, tc.expected, info.KimiCacheTTL)
	}
	info.OriginModelName = "gpt-6.1-sol"
	req, err := http.NewRequest(http.MethodPost, "http://example.invalid", strings.NewReader(`{}`))
	require.NoError(t, err)
	require.NoError(t, captureKimiCacheTTL(req, info))
	assert.Empty(t, info.KimiCacheTTL)
}
