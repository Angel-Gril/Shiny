package controller

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestGenericOptionUpdateCannotStoreAuditCredentialsAsPlaintext(t *testing.T) {
	body := `{"key":"ContentAuditTypesafeApiKey","value":"plain-secret-fixture"}`
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = httptest.NewRequest(http.MethodPut, "/api/option/", strings.NewReader(body))
	UpdateOption(context)
	require.Contains(t, response.Body.String(), `"success":false`)
	require.NotContains(t, response.Body.String(), "plain-secret-fixture")
}

func TestAuditModelConnectionCheckDoesNotReturnUnsavedKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/models", r.URL.Path)
		require.Equal(t, "Bearer one-time-fixture-key", r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"models":[{"name":"jev-1.14.0"}]}`))
	}))
	defer server.Close()
	body, err := json.Marshal(map[string]string{
		"provider": "typesafe",
		"endpoint": server.URL + "/v1/systemone",
		"api_key":  "one-time-fixture-key",
	})
	require.NoError(t, err)
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = httptest.NewRequest(http.MethodPost, "/api/option/content_audit/models", strings.NewReader(string(body)))
	GetContentAuditModels(context)
	require.Equal(t, http.StatusOK, response.Code)
	require.Contains(t, response.Body.String(), "jev-1.14.0")
	require.NotContains(t, response.Body.String(), "one-time-fixture-key")
}

func TestRequestPolicyResponseNeverReturnsAuditCredential(t *testing.T) {
	previousSecret, previousPersistent := common.CryptoSecret, common.PersistentCryptoSecretConfigured
	common.CryptoSecret, common.PersistentCryptoSecretConfigured = "credential-response-test-secret-with-entropy", true
	t.Cleanup(func() {
		common.CryptoSecret, common.PersistentCryptoSecretConfigured = previousSecret, previousPersistent
	})
	encrypted, err := common.EncryptStoredSecret("private-audit-response-fixture")
	require.NoError(t, err)
	common.OptionMapRWMutex.Lock()
	previousMapWasNil := common.OptionMap == nil
	if common.OptionMap == nil {
		common.OptionMap = map[string]string{}
	}
	previous, existed := common.OptionMap["ContentAuditTypesafeApiKey"]
	common.OptionMap["ContentAuditTypesafeApiKey"] = encrypted
	common.OptionMapRWMutex.Unlock()
	t.Cleanup(func() {
		common.OptionMapRWMutex.Lock()
		if existed {
			common.OptionMap["ContentAuditTypesafeApiKey"] = previous
		} else {
			delete(common.OptionMap, "ContentAuditTypesafeApiKey")
		}
		if previousMapWasNil {
			common.OptionMap = nil
		}
		common.OptionMapRWMutex.Unlock()
	})
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = httptest.NewRequest(http.MethodGet, "/api/option/request_policy", nil)
	GetRequestPolicy(context)
	require.Equal(t, http.StatusOK, response.Code)
	require.Contains(t, response.Body.String(), `"configured":true`)
	require.Contains(t, response.Body.String(), `"store_ready":true`)
	require.NotContains(t, response.Body.String(), "private-audit-response-fixture")
	require.NotContains(t, response.Body.String(), encrypted)
	response = httptest.NewRecorder()
	context, _ = gin.CreateTestContext(response)
	context.Request = httptest.NewRequest(http.MethodGet, "/api/option/", nil)
	GetOptions(context)
	require.Equal(t, http.StatusOK, response.Code)
	require.NotContains(t, response.Body.String(), "ContentAuditTypesafeApiKey")
	require.NotContains(t, response.Body.String(), encrypted)
}
