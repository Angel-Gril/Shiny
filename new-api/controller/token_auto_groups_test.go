package controller

import (
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func configureTokenAutoGroupsTest(t *testing.T, maxCount string, autoGroups string) {
	t.Helper()
	originalMax := setting.GetMaxTokenAutoGroups()
	originalAutoGroups := setting.AutoGroups2JsonString()
	originalUsableGroups := setting.UserUsableGroups2JSONString()
	originalRatios := ratio_setting.GroupRatio2JSONString()
	require.NoError(t, setting.UpdateMaxTokenAutoGroups(maxCount))
	require.NoError(t, setting.UpdateAutoGroupsByJsonString(autoGroups))
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"Default","vip":"VIP"}`))
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1,"vip":1}`))
	t.Cleanup(func() {
		require.NoError(t, setting.UpdateMaxTokenAutoGroups(stringInt(originalMax)))
		require.NoError(t, setting.UpdateAutoGroupsByJsonString(originalAutoGroups))
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(originalUsableGroups))
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(originalRatios))
	})
}

func stringInt(value int) string {
	return fmt.Sprintf("%d", value)
}

func setupTokenAutoGroupsControllerTest(t *testing.T) *model.User {
	t.Helper()
	db := setupTokenControllerTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.User{}))
	user := &model.User{
		Id:       101,
		Username: "token-auto-user",
		Password: "password",
		Group:    "default",
		Status:   common.UserStatusEnabled,
	}
	require.NoError(t, db.Create(user).Error)
	return user
}

func baseAutoTokenRequest(name string) map[string]any {
	return map[string]any{
		"name":              name,
		"expired_time":      -1,
		"remain_quota":      0,
		"unlimited_quota":   true,
		"group":             "auto",
		"cross_group_retry": true,
	}
}

func newTokenAutoGroupsAuthenticatedContext(t *testing.T, method string, target string, body any, userID int) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	ctx, recorder := newAuthenticatedContext(t, method, target, body, userID)
	common.SetContextKey(ctx, constant.ContextKeyUserGroup, "default")
	return ctx, recorder
}

func TestAddTokenRejectsUnauthorizedGroup(t *testing.T) {
	configureTokenAutoGroupsTest(t, "5", `["default","vip"]`)
	user := setupTokenAutoGroupsControllerTest(t)
	request := baseAutoTokenRequest("unauthorized-group")
	request["group"] = "private-admin-group"
	delete(request, "auto_groups")

	ctx, recorder := newTokenAutoGroupsAuthenticatedContext(t, http.MethodPost, "/api/token/", request, user.Id)
	AddToken(ctx)

	response := decodeAPIResponse(t, recorder)
	assert.False(t, response.Success)
	var count int64
	require.NoError(t, model.DB.Model(&model.Token{}).Count(&count).Error)
	assert.Zero(t, count)
}

func TestUpdateTokenRejectsUnauthorizedGroup(t *testing.T) {
	configureTokenAutoGroupsTest(t, "5", `["default","vip"]`)
	user := setupTokenAutoGroupsControllerTest(t)
	token := &model.Token{UserId: user.Id, Name: "group-owner", Key: "group-owner-key", Status: common.TokenStatusEnabled, ExpiredTime: -1, UnlimitedQuota: true, Group: "default"}
	require.NoError(t, model.DB.Create(token).Error)

	request := baseAutoTokenRequest("group-owner")
	request["id"] = token.Id
	request["group"] = "private-admin-group"
	delete(request, "auto_groups")

	ctx, recorder := newTokenAutoGroupsAuthenticatedContext(t, http.MethodPut, "/api/token/", request, user.Id)
	UpdateToken(ctx)

	response := decodeAPIResponse(t, recorder)
	assert.False(t, response.Success)
	var stored model.Token
	require.NoError(t, model.DB.First(&stored, token.Id).Error)
	assert.Equal(t, "default", stored.Group)
}

func TestAddTokenEmptyAutoGroupsInheritGlobalAuto(t *testing.T) {
	tests := []struct {
		name         string
		includeField bool
		value        any
	}{
		{name: "omitted"},
		{name: "null", includeField: true, value: nil},
		{name: "empty array", includeField: true, value: []string{}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			configureTokenAutoGroupsTest(t, "5", `["default","vip"]`)
			user := setupTokenAutoGroupsControllerTest(t)
			request := baseAutoTokenRequest("create-" + test.name)
			if test.includeField {
				request["auto_groups"] = test.value
			}

			ctx, recorder := newTokenAutoGroupsAuthenticatedContext(t, http.MethodPost, "/api/token/", request, user.Id)
			AddToken(ctx)

			response := decodeAPIResponse(t, recorder)
			require.True(t, response.Success, response.Message)
			var token model.Token
			require.NoError(t, model.DB.Where("name = ?", request["name"]).First(&token).Error)
			assert.Empty(t, token.AutoGroups)
			assert.True(t, token.CrossGroupRetry)
			payload, err := common.Marshal(buildMaskedTokenResponse(&token))
			require.NoError(t, err)
			var responseData map[string]any
			require.NoError(t, common.Unmarshal(payload, &responseData))
			assert.Nil(t, responseData["auto_groups"])
		})
	}
}

func TestAddTokenPersistsOrderedAutoGroupsSnapshot(t *testing.T) {
	configureTokenAutoGroupsTest(t, "5", `["default","vip"]`)
	user := setupTokenAutoGroupsControllerTest(t)
	request := baseAutoTokenRequest("ordered-snapshot")
	request["auto_groups"] = []string{"vip", "default"}

	ctx, recorder := newTokenAutoGroupsAuthenticatedContext(t, http.MethodPost, "/api/token/", request, user.Id)
	AddToken(ctx)
	require.True(t, decodeAPIResponse(t, recorder).Success)

	var token model.Token
	require.NoError(t, model.DB.Where("name = ?", "ordered-snapshot").First(&token).Error)
	assert.JSONEq(t, `["vip","default"]`, token.AutoGroups)

	getCtx, getRecorder := newTokenAutoGroupsAuthenticatedContext(t, http.MethodGet, "/api/token/"+stringInt(token.Id), nil, user.Id)
	getCtx.Params = append(getCtx.Params, gin.Param{Key: "id", Value: stringInt(token.Id)})
	GetToken(getCtx)
	getResponse := decodeAPIResponse(t, getRecorder)
	require.True(t, getResponse.Success)
	var data struct {
		AutoGroups []string `json:"auto_groups"`
	}
	require.NoError(t, common.Unmarshal(getResponse.Data, &data))
	assert.Equal(t, []string{"vip", "default"}, data.AutoGroups)
}

func TestUpdateTokenAutoGroupsTriStateAndNonAutoCleanup(t *testing.T) {
	tests := []struct {
		name               string
		includeField       bool
		value              any
		group              string
		expectedAutoGroups string
		expectedRetry      bool
	}{
		{name: "omitted preserves", group: "auto", expectedAutoGroups: `["vip","default"]`, expectedRetry: true},
		{name: "null inherits", includeField: true, value: nil, group: "auto", expectedRetry: true},
		{name: "empty inherits", includeField: true, value: []string{}, group: "auto", expectedRetry: true},
		{name: "non auto clears and disables retry", includeField: true, value: []string{"vip"}, group: "default"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			configureTokenAutoGroupsTest(t, "5", `["default","vip"]`)
			user := setupTokenAutoGroupsControllerTest(t)
			token := seedToken(t, model.DB, user.Id, "update-auto", "update-auto-key")
			token.Group = "auto"
			token.CrossGroupRetry = true
			require.NoError(t, token.SetAutoGroups([]string{"vip", "default"}))
			require.NoError(t, model.DB.Save(token).Error)

			request := baseAutoTokenRequest("updated-auto")
			request["id"] = token.Id
			request["status"] = common.TokenStatusEnabled
			request["group"] = test.group
			if test.includeField {
				request["auto_groups"] = test.value
			}
			ctx, recorder := newTokenAutoGroupsAuthenticatedContext(t, http.MethodPut, "/api/token/", request, user.Id)
			UpdateToken(ctx)
			response := decodeAPIResponse(t, recorder)
			require.True(t, response.Success, response.Message)

			var updated model.Token
			require.NoError(t, model.DB.First(&updated, token.Id).Error)
			if test.expectedAutoGroups == "" {
				assert.Empty(t, updated.AutoGroups)
			} else {
				assert.JSONEq(t, test.expectedAutoGroups, updated.AutoGroups)
			}
			assert.Equal(t, test.expectedRetry, updated.CrossGroupRetry)
		})
	}
}

func TestAddTokenRejectsInvalidAutoGroups(t *testing.T) {
	tests := []struct {
		name     string
		maxCount string
		groups   []string
	}{
		{name: "over limit", maxCount: "1", groups: []string{"default", "vip"}},
		{name: "duplicate", maxCount: "5", groups: []string{"default", "default"}},
		{name: "auto pseudo group", maxCount: "5", groups: []string{"auto"}},
		{name: "unavailable", maxCount: "5", groups: []string{"missing"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			configureTokenAutoGroupsTest(t, test.maxCount, `["default","vip"]`)
			user := setupTokenAutoGroupsControllerTest(t)
			request := baseAutoTokenRequest("invalid-" + test.name)
			request["auto_groups"] = test.groups

			ctx, recorder := newTokenAutoGroupsAuthenticatedContext(t, http.MethodPost, "/api/token/", request, user.Id)
			AddToken(ctx)

			response := decodeAPIResponse(t, recorder)
			assert.False(t, response.Success)
			var count int64
			require.NoError(t, model.DB.Model(&model.Token{}).Count(&count).Error)
			assert.Zero(t, count)
		})
	}
}

func TestGetTokenAutoGroupsReturnsFullFilteredGlobalOrderAndLimit(t *testing.T) {
	configureTokenAutoGroupsTest(t, "1", `["vip","missing","default"]`)
	user := setupTokenAutoGroupsControllerTest(t)

	ctx, recorder := newTokenAutoGroupsAuthenticatedContext(t, http.MethodGet, "/api/token/auto-groups", nil, user.Id)
	GetTokenAutoGroups(ctx)

	response := decodeAPIResponse(t, recorder)
	require.True(t, response.Success, response.Message)
	var data struct {
		Groups   []string `json:"groups"`
		MaxCount int      `json:"max_count"`
	}
	require.NoError(t, common.Unmarshal(response.Data, &data))
	assert.Equal(t, []string{"vip", "default"}, data.Groups)
	assert.Equal(t, 1, data.MaxCount)
}

func TestRUUniversalKeyPresetInheritsAccountAccess(t *testing.T) {
	t.Setenv("SHINY_SITE_PROFILE", "ru")
	db := setupModelListControllerTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.Token{}))
	user := model.User{Id: 101, Username: "universal-owner", Password: "fixture", Group: "default", Status: common.UserStatusEnabled}
	require.NoError(t, db.Create(&user).Error)
	ctx, recorder := newAuthenticatedContext(t, http.MethodPost, "/api/token/", map[string]any{
		"preset": "ru_universal", "name": "All models", "user_id": 999,
		"group": "admin-only", "auto_groups": []string{"admin-only"},
		"model_limits_enabled": true, "model_limits": "one-model",
		"expired_time": 0, "remain_quota": -1, "cross_group_retry": true,
	}, user.Id)
	AddToken(ctx)
	response := decodeAPIResponse(t, recorder)
	require.True(t, response.Success, response.Message)
	var saved model.Token
	require.NoError(t, db.Where("user_id = ?", user.Id).First(&saved).Error)
	assert.Empty(t, saved.Group)
	assert.Empty(t, saved.AutoGroups)
	assert.False(t, saved.CrossGroupRetry)
	assert.False(t, saved.ModelLimitsEnabled)
	assert.Empty(t, saved.ModelLimits)
	assert.True(t, saved.UnlimitedQuota)
	assert.EqualValues(t, -1, saved.ExpiredTime)
	assert.True(t, saved.AllowUserQuotaQuery)
	var returned model.Token
	require.NoError(t, common.Unmarshal(response.Data, &returned))
	assert.Equal(t, saved.Id, returned.Id)
	assert.Equal(t, saved.GetMaskedKey(), returned.Key)
	assert.NotContains(t, recorder.Body.String(), saved.Key)
	assert.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
	assert.True(t, common.GetContextKeyBool(ctx, constant.ContextKeyTokenAuditSucceeded))

	// Existing auth and model discovery resolve the owner's group dynamically.
	oldSelfUse := operation_setting.SelfUseModeEnabled
	operation_setting.SelfUseModeEnabled = true
	t.Cleanup(func() { operation_setting.SelfUseModeEnabled = oldSelfUse })
	require.NoError(t, db.Create(&[]model.Ability{
		{Group: "default", Model: "fixture-openai", ChannelId: 1, Enabled: true},
		{Group: "default", Model: "fixture-claude", ChannelId: 2, Enabled: true},
		{Group: "default", Model: "fixture-gemini", ChannelId: 3, Enabled: true},
		{Group: "admin-only", Model: "fixture-private", ChannelId: 4, Enabled: true},
	}).Error)
	for _, expected := range [][]string{
		{"fixture-openai", "fixture-claude", "fixture-gemini"},
		{"fixture-openai", "fixture-claude", "fixture-gemini", "fixture-new-model"},
	} {
		listCtx, listRecorder := newAuthenticatedContext(t, http.MethodGet, "/v1/models", nil, user.Id)
		require.NoError(t, middleware.SetupContextForToken(listCtx, &saved))
		ListModels(listCtx, constant.ChannelTypeOpenAI)
		assert.ElementsMatch(t, expected, slices.Collect(maps.Keys(decodeListModelsResponse(t, listRecorder))))
		if len(expected) == 3 {
			require.NoError(t, db.Create(&model.Ability{Group: "default", Model: "fixture-new-model", ChannelId: 5, Enabled: true}).Error)
		}
	}
}

func TestRUUniversalKeyPresetRejectsUnsupportedSitesAndKeepsTokenLimit(t *testing.T) {
	for _, test := range []struct{ name, profile, preset string }{
		{"domestic", "", "ru_universal"},
		{"unknown preset", "ru", "grant-every-group"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("SHINY_SITE_PROFILE", test.profile)
			db := setupTokenControllerTestDB(t)
			ctx, recorder := newAuthenticatedContext(t, http.MethodPost, "/api/token/", map[string]any{"preset": test.preset}, 101)
			AddToken(ctx)
			assert.False(t, decodeAPIResponse(t, recorder).Success)
			var count int64
			require.NoError(t, db.Model(&model.Token{}).Count(&count).Error)
			assert.Zero(t, count)
		})
	}
	t.Run("token limit", func(t *testing.T) {
		t.Setenv("SHINY_SITE_PROFILE", "ru")
		db := setupTokenControllerTestDB(t)
		previous := operation_setting.GetMaxUserTokens()
		operation_setting.GetTokenSetting().MaxUserTokens = 1
		t.Cleanup(func() { operation_setting.GetTokenSetting().MaxUserTokens = previous })
		seedToken(t, db, 101, "existing", "synthetic-existing-key")
		ctx, recorder := newAuthenticatedContext(t, http.MethodPost, "/api/token/", map[string]any{"preset": "ru_universal"}, 101)
		AddToken(ctx)
		assert.False(t, decodeAPIResponse(t, recorder).Success)
		var count int64
		require.NoError(t, db.Model(&model.Token{}).Count(&count).Error)
		assert.EqualValues(t, 1, count)
	})
}

func TestRUUniversalKeyDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			t.Setenv("SHINY_SITE_PROFILE", "ru")
			if dialect == "sqlite" {
				setupTokenControllerTestDB(t)
			} else {
				dsn := os.Getenv("TEST_MYSQL_DSN")
				if dialect == "postgres" {
					dsn = os.Getenv("TEST_POSTGRES_DSN")
				}
				if dsn == "" {
					t.Skip("external test database is not configured")
				}
				db, managed := openTokenControllerExternalDB(t, dialect, dsn)
				*managed = true
				migrateTokenControllerTestDB(t, db)
			}
			versionQuery := "SELECT version()"
			if dialect == "sqlite" {
				versionQuery = "SELECT sqlite_version()"
			}
			var version string
			require.NoError(t, model.DB.Raw(versionQuery).Scan(&version).Error)
			t.Logf("%s: %s", dialect, version)
			ctx, recorder := newAuthenticatedContext(t, http.MethodPost, "/api/token/", map[string]any{"preset": "ru_universal"}, 101)
			AddToken(ctx)
			response := decodeAPIResponse(t, recorder)
			require.True(t, response.Success, response.Message)
			var data model.Token
			require.NoError(t, common.Unmarshal(response.Data, &data))
			var stored model.Token
			require.NoError(t, model.DB.First(&stored, data.Id).Error)
			assert.Equal(t, "Universal API key", stored.Name)
			assert.Equal(t, 101, stored.UserId)
			assert.Empty(t, stored.Group)
			assert.False(t, stored.ModelLimitsEnabled)
			assert.True(t, stored.UnlimitedQuota)
			assert.Equal(t, common.TokenStatusEnabled, stored.Status)
			assert.Equal(t, stored.GetMaskedKey(), data.Key)
		})
	}
}
