package middleware

import (
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
)

type turnstileCheckResponse struct {
	Success  bool   `json:"success"`
	Action   string `json:"action"`
	Hostname string `json:"hostname"`
}

var turnstileHTTPClient = &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
var turnstileUsedTokens = struct {
	sync.Mutex
	expires map[[32]byte]time.Time
}{expires: make(map[[32]byte]time.Time)}

// Cloudflare replay detection is eventually consistent. The atomic guard stops
// a second redemption at this gateway; Redis shares it across application nodes.
func claimTurnstileToken(c *gin.Context, token string) bool {
	digest := sha256.Sum256([]byte(common.TurnstileSiteKey + ":" + token))
	if common.RedisEnabled {
		if common.RDB == nil {
			return false
		}
		claimed, err := common.RDB.SetNX(c.Request.Context(), fmt.Sprintf("newapi:turnstile:used:%x", digest), "1", 5*time.Minute).Result()
		return err == nil && claimed
	}
	now := time.Now()
	turnstileUsedTokens.Lock()
	defer turnstileUsedTokens.Unlock()
	for key, expiry := range turnstileUsedTokens.expires {
		if !expiry.After(now) {
			delete(turnstileUsedTokens.expires, key)
		}
	}
	if expiry, ok := turnstileUsedTokens.expires[digest]; ok && expiry.After(now) {
		return false
	}
	if len(turnstileUsedTokens.expires) >= 10000 {
		return false
	}
	turnstileUsedTokens.expires[digest] = now.Add(5 * time.Minute)
	return true
}

func TurnstileCheck(expectedAction string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !common.TurnstileCheckEnabled {
			c.Next()
			return
		}
		reject := func() { common.ApiErrorT(c, "Turnstile verification failed, please refresh and try again!"); c.Abort() }
		if !common.TurnstileConfigured() {
			reject()
			return
		}
		token := c.GetHeader("CF-Turnstile-Response")
		if token == "" {
			token = c.Query("turnstile")
		} // Already-open older frontends retain their transport.
		if token == "" || len(token) > 2048 {
			reject()
			return
		}
		origin, err := url.Parse(system_setting.ServerAddress)
		if err != nil || origin.Hostname() == "" || expectedAction == "" {
			reject()
			return
		}
		request, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, "https://challenges.cloudflare.com/turnstile/v0/siteverify", strings.NewReader(url.Values{"secret": {common.TurnstileSecretKey}, "response": {token}, "remoteip": {c.ClientIP()}}.Encode()))
		if err != nil {
			reject()
			return
		}
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		response, err := turnstileHTTPClient.Do(request)
		if err != nil {
			reject()
			return
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			reject()
			return
		}
		var result turnstileCheckResponse
		if common.DecodeJson(io.LimitReader(response.Body, 16*1024), &result) != nil || !result.Success || result.Action != expectedAction || !strings.EqualFold(result.Hostname, origin.Hostname()) {
			reject()
			return
		}
		if !claimTurnstileToken(c, token) {
			reject()
			return
		}
		c.Next()
	}
}
