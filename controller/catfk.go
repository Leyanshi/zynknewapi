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
	goods, channels, err := service.GetCatfkCatalog(c.Request.Context(), token)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"enabled": true, "goods": goods, "channels": channels}})
}

func CreateCatfkOrder(c *gin.Context) {
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
	c.JSON(http.StatusOK, gin.H{"success": true, "data": order})
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
		items = append(items, gin.H{"id": order.ID, "name": order.Name, "trade_no": order.TradeNo,
			"pay_url": order.PayURL, "status": order.Status, "quota": order.Quota, "cards": cards,
			"instructions": order.Instructions, "created_time": order.CreatedTime})
	}
	return items, nil
}

func GetCatfkOrders(c *gin.Context) {
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

// CatfkSync lets the client wallet drive reconciliation while a payment is
// active: it settles at most one due order and returns the user's active
// orders, so the wallet closes its payment window as soon as the server
// confirms delivery.
func CatfkSync(c *gin.Context) {
	orders, err := service.SyncCatfkUserOrders(c.Request.Context(), c.GetInt("id"))
	if err != nil {
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
