package controller

import (
	"errors"
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func manageUserQuota(c *gin.Context, req ManageRequest) {
	action := "generic"
	params := model.AuditFields{
		"target_user_id":  req.Id,
		"mode":            req.Mode,
		"requested_quota": req.Value,
	}
	switch req.Mode {
	case "add":
		action = "user.quota_add"
	case "subtract":
		action = "user.quota_subtract"
	case "override":
		action = "user.quota_override"
	default:
		params["action"] = "add_quota"
		params["method"] = c.Request.Method
		params["route"] = c.FullPath()
	}
	success := false
	defer func() {
		content := auditContentEN(action, params)
		if !success {
			// Failed requests have no committed balance changes to render.
			content = "Failed user quota adjustment"
		}
		model.RecordOperationAuditLog(c.GetInt("id"), c.GetInt("role"), content, c.ClientIP(), action, params,
			auditOperatorInfo(c), &model.AuditRequestInfo{
				Method: c.Request.Method, Route: c.FullPath(), Status: c.Writer.Status(), Success: success,
			}, c)
		markAuditLogged(c)
	}()

	adjustment, err := model.AdjustUserQuota(req.Id, c.GetInt("role"), req.Mode, req.Value)
	if err != nil {
		switch {
		case errors.Is(err, model.ErrInvalidUserQuotaAdjustment):
			params["failure_reason"] = "invalid_parameters"
			if (req.Mode == "add" || req.Mode == "subtract") && req.Value <= 0 {
				common.ApiErrorT(c, "Quota change amount cannot be zero")
			} else {
				common.ApiErrorT(c, "Invalid parameters")
			}
		case errors.Is(err, model.ErrUserQuotaPermission):
			params["failure_reason"] = "permission_denied"
			common.ApiErrorT(c, "No permission to update users of same or higher permission level")
		case errors.Is(err, gorm.ErrRecordNotFound):
			params["failure_reason"] = "target_not_found"
			common.ApiErrorT(c, "User does not exist")
		case errors.Is(err, model.ErrWalletQuotaLimitExceeded):
			params["failure_reason"] = "quota_limit_exceeded"
			common.ApiError(c, err)
		default:
			params["failure_reason"] = "database_error"
			common.ApiError(c, err)
		}
		return
	}

	params["target_username"] = adjustment.Username
	params["from"] = adjustment.Before
	params["to"] = adjustment.After
	if req.Mode != "override" {
		params["quota"] = req.Value
	}
	success = true
	operation := model.AuditOperation{Action: action, Params: params}
	model.RecordLogWithAdminInfo(adjustment.UserID, model.LogTypeTopup,
		auditContentEN(action, params), auditOperatorInfo(c), &operation, c)
	c.JSON(http.StatusOK, gin.H{"success": true, "message": ""})
}

func manageUserCashback(c *gin.Context, req ManageRequest) {
	params := model.AuditFields{"target_user_id": req.Id}
	action := "user.cashback_adjust"
	if req.Action == "set_promoter" {
		action = "user.promoter_set"
	}
	success := false
	defer func() {
		model.RecordOperationAuditLog(c.GetInt("id"), c.GetInt("role"), action, c.ClientIP(), action, params,
			auditOperatorInfo(c), &model.AuditRequestInfo{
				Method: c.Request.Method, Route: c.FullPath(), Status: c.Writer.Status(), Success: success,
			}, c)
		markAuditLogged(c)
	}()
	if req.Action == "set_promoter" {
		if c.GetInt("role") != common.RoleRootUser {
			common.ApiErrorT(c, "No permission to update users of same or higher permission level")
			return
		}
		if req.Enabled == nil {
			common.ApiErrorT(c, "Invalid parameters")
			return
		}
		user, err := model.SetUserPromoter(req.Id, c.GetInt("role"), *req.Enabled)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		params["target_username"] = user.Username
		params["from"] = user.IsPromoter
		params["to"] = *req.Enabled
	} else {
		params["mode"], params["requested_quota"] = req.Mode, req.Value
		adjustment, err := model.AdjustUserCashback(req.Id, c.GetInt("role"), req.Mode, req.Value)
		if err != nil {
			if errors.Is(err, model.ErrUserQuotaPermission) {
				common.ApiErrorT(c, "No permission to update users of same or higher permission level")
			} else {
				common.ApiError(c, err)
			}
			return
		}
		params["target_username"] = adjustment.Username
		params["from"], params["to"] = adjustment.Before, adjustment.After
	}
	success = true
	c.JSON(http.StatusOK, gin.H{"success": true, "message": ""})
}
