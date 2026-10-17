package controller

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// GetUserInsight is a read-only support view. The router applies AdminAuth,
// and target authorization is repeated here before any financial/log reads.
func GetUserInsight(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if c.GetInt("role") < common.RoleAdminUser {
		common.ApiErrorStatus(c, http.StatusForbidden, common.NewMessage("Unauthorized, insufficient privileges"))
		return
	}
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("Invalid parameters"))
		return
	}
	section := c.DefaultQuery("section", "overview")
	switch section {
	case "overview", "topups", "redemptions", "checkins", "logs":
	default:
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("Invalid parameters"))
		return
	}
	page, err := strconv.Atoi(c.DefaultQuery("p", "1"))
	if err != nil {
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("Invalid parameters"))
		return
	}
	page = max(page, 1)
	pageSize, err := strconv.Atoi(c.DefaultQuery("page_size", "10"))
	if err != nil {
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("Invalid parameters"))
		return
	}
	if pageSize <= 0 {
		pageSize = 10
	}
	pageSize = min(pageSize, 50)
	if page > int(^uint(0)>>1)/pageSize {
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("Invalid parameters"))
		return
	}
	logType, err := strconv.Atoi(c.DefaultQuery("log_type", "0"))
	if err != nil || logType < model.LogTypeUnknown || logType > model.LogTypeLogin {
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("Invalid parameters"))
		return
	}
	user, err := model.GetUserInsightUser(c.Request.Context(), id)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		common.ApiErrorStatus(c, http.StatusNotFound, common.NewMessage("User does not exist"))
		return
	}
	if err != nil {
		common.ApiErrorStatus(c, http.StatusInternalServerError, common.NewMessage("Database error, please contact the administrator"))
		return
	}
	if !canManageTargetRole(c.GetInt("role"), user.Role) {
		common.ApiErrorStatus(c, http.StatusForbidden, common.NewMessage("No permission to access users of same or higher level"))
		return
	}
	var data any
	switch section {
	case "overview":
		data, err = model.GetUserInsightOverview(c.Request.Context(), user)
	case "topups":
		data, err = model.GetUserInsightTopups(c.Request.Context(), id, page, pageSize)
	case "redemptions":
		data, err = model.GetUserInsightRedemptions(c.Request.Context(), id, page, pageSize)
	case "checkins":
		data, err = model.GetUserInsightCheckins(c.Request.Context(), id, page, pageSize)
	case "logs":
		data, err = model.GetUserInsightLogs(c.Request.Context(), id, page, pageSize, logType)
	}
	if err != nil {
		common.ApiErrorStatus(c, http.StatusInternalServerError, common.NewMessage("Database error, please contact the administrator"))
		return
	}
	common.ApiSuccess(c, data)
}
