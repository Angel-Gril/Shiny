package middleware

import (
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestModelConcurrencyInternalAccountKeysShareOverrideAndGlobalBudget(t *testing.T) {
	previousOverrides := setting.ModelRequestConcurrencyOverridesJSON()
	previousUser, previousGlobal, previousRedis := setting.ModelRequestConcurrencyPerUser, setting.ModelRequestConcurrencyGlobal, common.RedisEnabled
	t.Cleanup(func() {
		_ = setting.UpdateModelRequestConcurrencyOverrides(previousOverrides)
		setting.ModelRequestConcurrencyPerUser, setting.ModelRequestConcurrencyGlobal, common.RedisEnabled = previousUser, previousGlobal, previousRedis
		resetModelConcurrencyForTest()
	})
	for _, backend := range []string{"memory", "redis"} {
		t.Run(backend, func(t *testing.T) {
			common.RedisEnabled = false
			if backend == "redis" {
				useRateLimitMiniRedis(t)
			}
			resetModelConcurrencyForTest()
			setting.ModelRequestConcurrencyPerUser, setting.ModelRequestConcurrencyGlobal = 1, 3
			require.NoError(t, setting.UpdateModelRequestConcurrencyOverrides(`{"42":2}`))
			admit := func(userID int) (func(), bool) {
				ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
				ctx.Request = httptest.NewRequest("POST", "/v1/chat/completions", nil)
				ctx.Set("id", userID)
				return modelConcurrencyAdmission(ctx)
			}
			first, allowed := admit(42)
			require.True(t, allowed)
			defer first()
			second, allowed := admit(42)
			require.True(t, allowed, "a second key on the relay account uses the configured budget")
			defer second()
			_, allowed = admit(42)
			require.False(t, allowed, "keys cannot each bypass the account cap")
			ordinary, allowed := admit(43)
			require.True(t, allowed)
			defer ordinary()
			_, allowed = admit(44)
			require.False(t, allowed, "overrides never bypass the global cap")
		})
	}
}
