package relayconvert

import (
	"context"
	"testing"

	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/relayconvert/convmeta"
	kitutil "github.com/QuantumNous/new-api/relaykit/relayconvert/kitutil"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestKimiCacheTTLIsPreservedAcrossRequestProtocols(t *testing.T) {
	request := &dto.ClaudeRequest{Model: "kimi-k3.1-pro", CacheControl: []byte(`{"type":"ephemeral","ttl":"1h"}`), Messages: []dto.ClaudeMessage{{Role: "user", Content: "hello"}}}
	chat, err := ConvertRequest(context.Background(), &convmeta.Values{}, types.RelayFormatOpenAI, request)
	require.NoError(t, err)
	value := chat.Value.(*dto.GeneralOpenAIRequest)
	assert.JSONEq(t, `{"mode":"implicit","ttl":"1h"}`, string(value.PromptCacheOptions))
	response, err := ConvertRequest(context.Background(), &convmeta.Values{}, types.RelayFormatOpenAIResponses, value)
	require.NoError(t, err)
	back, err := ConvertRequest(context.Background(), &convmeta.Values{}, types.RelayFormatOpenAI, response.Value)
	require.NoError(t, err)
	encoded, err := kitutil.Marshal(back.Value)
	require.NoError(t, err)
	var policy struct {
		Options map[string]string `json:"prompt_cache_options"`
	}
	require.NoError(t, kitutil.Unmarshal(encoded, &policy))
	assert.Equal(t, "1h", policy.Options["ttl"])
}
