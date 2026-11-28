package middleware

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTurnstileVerificationRequiresActionHostnameAndSingleUse(t *testing.T) {
	turnstileUsedTokens.Lock()
	previousUsedTokens := turnstileUsedTokens.expires
	turnstileUsedTokens.expires = make(map[[32]byte]time.Time)
	turnstileUsedTokens.Unlock()
	previousEnabled, previousSite, previousSecret := common.TurnstileCheckEnabled, common.TurnstileSiteKey, common.TurnstileSecretKey
	previousURL, previousClient := system_setting.ServerAddress, turnstileHTTPClient
	previousRedis, previousRDB := common.RedisEnabled, common.RDB
	common.TurnstileCheckEnabled, common.TurnstileSiteKey, common.TurnstileSecretKey = true, "public-fixture", "secret-fixture"
	system_setting.ServerAddress = "https://shinyapi.com"
	t.Cleanup(func() {
		turnstileUsedTokens.Lock()
		turnstileUsedTokens.expires = previousUsedTokens
		turnstileUsedTokens.Unlock()
		common.TurnstileCheckEnabled, common.TurnstileSiteKey, common.TurnstileSecretKey = previousEnabled, previousSite, previousSecret
		system_setting.ServerAddress = previousURL
		turnstileHTTPClient = previousClient
		common.RedisEnabled, common.RDB = previousRedis, previousRDB
	})
	for _, redisMode := range []bool{false, true} {
		t.Run(fmt.Sprintf("redis=%t", redisMode), func(t *testing.T) {
			common.RedisEnabled = redisMode
			if redisMode {
				server := miniredis.RunT(t)
				client := redis.NewClient(&redis.Options{Addr: server.Addr()})
				common.RDB = client
				t.Cleanup(func() { _ = client.Close() })
			}
			var calls atomic.Int64
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				require.NoError(t, r.ParseForm())
				assert.Equal(t, "secret-fixture", r.Form.Get("secret"))
				token := r.Form.Get("response")
				w.Header().Set("Content-Type", "application/json")
				switch {
				case strings.Contains(token, "wrong-action"):
					fmt.Fprint(w, `{"success":true,"action":"signup","hostname":"shinyapi.com"}`)
				case strings.Contains(token, "wrong-host"):
					fmt.Fprint(w, `{"success":true,"action":"login","hostname":"evil.example"}`)
				case strings.Contains(token, "ru-host"):
					fmt.Fprint(w, `{"success":true,"action":"login","hostname":"ru.shinyapi.com"}`)
				case strings.Contains(token, "expired"):
					fmt.Fprint(w, `{"success":false,"error-codes":["timeout-or-duplicate"]}`)
				case strings.Contains(token, "malformed"):
					fmt.Fprint(w, `{"success":true`)
				case strings.Contains(token, "unavailable"):
					w.WriteHeader(503)
				default:
					fmt.Fprint(w, `{"success":true,"action":"login","hostname":"shinyapi.com"}`)
				}
			}))
			defer upstream.Close()
			turnstileHTTPClient = &http.Client{Timeout: time.Second, Transport: turnstileTestTransport{url: upstream.URL}}
			var handled atomic.Int64
			engine := gin.New()
			engine.POST("/api/user/login", TurnstileCheck("login"), func(c *gin.Context) { handled.Add(1); c.JSON(200, gin.H{"success": true}) })
			send := func(token string) *httptest.ResponseRecorder {
				req := httptest.NewRequest("POST", "/api/user/login", bytes.NewBufferString(`{}`))
				req.Header.Set("CF-Turnstile-Response", token)
				req.Header.Set("Host", "evil.example")
				rec := httptest.NewRecorder()
				engine.ServeHTTP(rec, req)
				return rec
			}
			for _, token := range []string{"", strings.Repeat("x", 2049), "wrong-action", "wrong-host", "expired", "malformed", "unavailable"} {
				rec := send(token)
				assert.NotContains(t, rec.Body.String(), "secret-fixture")
				assert.Contains(t, rec.Body.String(), `"success":false`)
			}
			assert.Zero(t, handled.Load())
			token := fmt.Sprintf("valid-%t", redisMode)
			assert.Contains(t, send(token).Body.String(), `"success":true`)
			assert.Contains(t, send(token).Body.String(), `"success":false`)
			assert.EqualValues(t, 1, handled.Load(), "replayed tokens must never run the handler twice even if Siteverify returns success twice")
			system_setting.ServerAddress = "https://ru.shinyapi.com"
			assert.Contains(t, send(fmt.Sprintf("primary-host-%t", redisMode)).Body.String(), `"success":false`, "RU must reject a main-site token")
			assert.Contains(t, send(fmt.Sprintf("ru-host-%t", redisMode)).Body.String(), `"success":true`)
			system_setting.ServerAddress = "https://shinyapi.com"
			assert.Greater(t, calls.Load(), int64(0))
			if redisMode {
				require.NoError(t, common.RDB.Close())
				assert.Contains(t, send("redis-outage").Body.String(), `"success":false`)
				assert.EqualValues(t, 2, handled.Load())
				common.RDB = nil
			}
		})
	}
}

type turnstileTestTransport struct{ url string }

func (tr turnstileTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Context().Err() != nil {
		return nil, req.Context().Err()
	}
	clone := req.Clone(context.Background())
	clone.URL.Scheme = "http"
	clone.URL.Host = strings.TrimPrefix(tr.url, "http://")
	response, err := http.DefaultTransport.RoundTrip(clone)
	if err != nil {
		return nil, err
	}
	return response, nil
}

func TestTurnstileDisabledDoesNotGateExistingHandler(t *testing.T) {
	before := common.TurnstileCheckEnabled
	common.TurnstileCheckEnabled = false
	t.Cleanup(func() { common.TurnstileCheckEnabled = before })
	engine := gin.New()
	engine.POST("/test", TurnstileCheck("login"), func(c *gin.Context) { c.String(200, "existing handler") })
	req := httptest.NewRequest("POST", "/test", io.NopCloser(strings.NewReader("")))
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	require.Equal(t, "existing handler", rec.Body.String())
}
