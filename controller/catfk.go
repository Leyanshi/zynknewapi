package controller

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
)

func GetCatfkCatalog(c *gin.Context) {
	token := service.CatfkShopToken()
	if token == "" || !operation_setting.IsPaymentComplianceConfirmed() {
		c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"enabled": false, "goods": []any{}, "channels": []any{}}})
		return
	}
	// The token is already public in the configured shop URL. The browser
	// fetches the catalog; this endpoint must never contact Catfk.
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"enabled": true, "shop_token": token, "goods": []any{}, "channels": []any{}}})
}

func CreateCatfkOrder(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	var req struct {
		GoodsKey  string `json:"goods_key" binding:"required,max=100"`
		ChannelID int    `json:"channel_id" binding:"required,min=1"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiError(c, err)
		return
	}
	order, err := service.CreateCatfkOrder(c.Request.Context(), c.GetInt("id"), req.GoodsKey, req.ChannelID)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	items, err := catfkOrderItems([]model.CatfkOrder{*order})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": items[0]})
}

func catfkOrderItems(orders []model.CatfkOrder) ([]gin.H, error) {
	items := make([]gin.H, 0, len(orders))
	for _, order := range orders {
		cards := []string{}
		if order.Cards != "" {
			if err := common.UnmarshalJsonStr(order.Cards, &cards); err != nil {
				return nil, err
			}
		}
		item := gin.H{"id": order.ID, "name": order.Name, "trade_no": order.TradeNo,
			"pay_url": order.PayURL, "status": order.Status, "quota": order.Quota, "cards": cards,
			"instructions": order.Instructions, "created_time": order.CreatedTime}
		// These responses are scoped to the authenticated purchaser. Give only
		// unfinished orders their per-order query credential for direct browser
		// checkout/status checks. Browser payment flags never authorize credit.
		if order.Status == "pending" || order.Status == "creating" {
			item["query_password"] = order.QueryPassword
			item["goods_key"] = order.GoodsKey
		}
		items = append(items, item)
	}
	return items, nil
}

func GetCatfkOrders(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	var orders []model.CatfkOrder
	if err := model.DB.Where("user_id = ? AND status IN ?", c.GetInt("id"), []string{"pending", "redeemed", "manual"}).Order("created_time desc").Limit(20).Find(&orders).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	items, err := catfkOrderItems(orders)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": items})
}

// CatfkSync remains a read-only compatibility endpoint. Neither it nor the
// background worker may contact Catfk on behalf of browser-managed orders.
func CatfkSync(c *gin.Context) {
	GetCatfkOrders(c)
}

func BindCatfkOrder(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	var req service.CatfkOrderBinding
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiError(c, err)
		return
	}
	order, err := service.BindCatfkOrder(c.Request.Context(), c.GetInt("id"), c.Param("id"), req)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	items, err := catfkOrderItems([]model.CatfkOrder{*order})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": items[0]})
}

func RedeemCatfkOrder(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	var req struct {
		Cards        []string `json:"cards" binding:"required,min=1,max=20,dive,required,max=4096"`
		Instructions string   `json:"instructions" binding:"max=32768"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiError(c, err)
		return
	}
	order, err := service.RedeemCatfkOrder(c.Request.Context(), c.GetInt("id"), c.Param("id"), req.Cards, req.Instructions)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	items, err := catfkOrderItems([]model.CatfkOrder{*order})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": items[0]})
}
