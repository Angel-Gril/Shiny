package controller

import (
	"net/http"
	"sort"
	"strings"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

func GetRequestPolicy(c *gin.Context) {
	chatConfigured, chatSource, chatError := model.ContentAuditCredentialStatus("chat_completions")
	jevConfigured, jevSource, jevError := model.ContentAuditCredentialStatus("typesafe")
	subqConfigured, subqSource, subqError := model.ContentAuditCredentialStatus("subq")
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{
		"options": model.CurrentRequestPolicy().Options,
		"credentials": gin.H{
			"chat_completions": gin.H{"configured": chatConfigured, "source": chatSource, "error": chatError},
			"typesafe":         gin.H{"configured": jevConfigured, "source": jevSource, "error": jevError},
			"subq":             gin.H{"configured": subqConfigured, "source": subqSource, "error": subqError},
			"store_ready":      model.ContentAuditCredentialStoreReady(),
		},
	}})
}

func UpdateRequestPolicy(c *gin.Context) {
	var request struct {
		Options     map[string]string `json:"options"`
		Credentials map[string]string `json:"credentials"`
		ClearKeys   []string          `json:"clear_credentials"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}
	if err := model.UpdateRequestPolicySettings(request.Options, request.Credentials, request.ClearKeys); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}
	if len(request.Credentials) > 0 || len(request.ClearKeys) > 0 {
		updatedProviders := make([]string, 0, len(request.Credentials))
		for provider := range request.Credentials {
			updatedProviders = append(updatedProviders, provider)
		}
		sort.Strings(updatedProviders)
		clearedProviders := append([]string(nil), request.ClearKeys...)
		sort.Strings(clearedProviders)
		recordManageAudit(c, "option.content_audit_credentials", map[string]any{
			"updated_providers": strings.Join(updatedProviders, ", "),
			"cleared_providers": strings.Join(clearedProviders, ", "),
		})
	}
	GetRequestPolicy(c)
}

func GetContentAuditModels(c *gin.Context) {
	var request struct {
		Endpoint string `json:"endpoint"`
		Provider string `json:"provider"`
		APIKey   string `json:"api_key"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}
	models, err := service.FetchContentAuditModelsWithAPIKey(c.Request.Context(), request.Endpoint, request.Provider, request.APIKey)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"models": models}})
}
