package service

import (
	"context"
	"errors"
	"net/url"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
)

// Only the explicitly configured catfk.com shop is eligible; never proxy an
// arbitrary administrator/client URL or silently enable purchases by default.
func CatfkShopToken() string {
	u, err := url.Parse(common.TopUpLink)
	if err != nil || u.Scheme != "https" || u.Host != "catfk.com" || u.User != nil {
		return ""
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 2 || parts[0] != "shop" || len(parts[1]) > 100 {
		return ""
	}
	return parts[1]
}

func CreateCatfkOrder(ctx context.Context, userID int, goodsKey string, channelID int) (*model.CatfkOrder, error) {
	token := CatfkShopToken()
	if token == "" || !operation_setting.IsPaymentComplianceConfirmed() {
		return nil, errors.New("管理员尚未启用此充值方式或确认支付合规条款")
	}
	if goodsKey == "" || len(goodsKey) > 100 || channelID <= 0 {
		return nil, errors.New("无效的商品或支付方式")
	}
	// Only reserve an owner-bound local order and per-order query credential.
	// Goods, stock, channel and price validation belongs to Catfk's browser-side
	// checkout; none of those client values can determine local wallet credit.
	order := &model.CatfkOrder{
		ID: common.GetUUID(), UserID: userID, ShopToken: token, GoodsKey: goodsKey,
		Name: goodsKey, QueryPassword: common.GetUUID(), Status: "creating", CreatedTime: common.GetTimestamp(),
	}
	order.TradeNo = "creating-" + order.ID
	if err := model.DB.WithContext(ctx).Create(order).Error; err != nil {
		return nil, err
	}
	return order, nil
}

type CatfkOrderBinding struct {
	TradeNo      string `json:"trade_no" binding:"required,max=100"`
	PayURL       string `json:"pay_url" binding:"required,max=2048"`
	Name         string `json:"name" binding:"max=200"`
	Instructions string `json:"instructions" binding:"max=32768"`
}

func BindCatfkOrder(ctx context.Context, userID int, id string, binding CatfkOrderBinding) (*model.CatfkOrder, error) {
	if !operation_setting.IsPaymentComplianceConfirmed() {
		return nil, errors.New("管理员尚未确认支付合规条款")
	}
	u, parseErr := url.Parse(binding.PayURL)
	if parseErr != nil || u.Scheme != "https" || u.Host != "catfk.com" || u.User != nil || u.Path != "/shopApi/Pay/payment" || u.Query().Get("trade_no") != binding.TradeNo || binding.TradeNo == "" || len(binding.TradeNo) > 100 {
		return nil, errors.New("发卡平台返回了无效的付款地址")
	}
	var order model.CatfkOrder
	if err := model.DB.WithContext(ctx).Where("id = ? AND user_id = ?", id, userID).First(&order).Error; err != nil {
		return nil, err
	}
	if order.Status != "creating" {
		if order.TradeNo == binding.TradeNo && order.PayURL == binding.PayURL {
			return &order, nil
		}
		return nil, errors.New("订单已绑定，不能更换付款信息")
	}
	if binding.Name == "" {
		binding.Name = order.GoodsKey
	}
	result := model.DB.WithContext(ctx).Model(&model.CatfkOrder{}).Where("id = ? AND user_id = ? AND status = ?", id, userID, "creating").
		Updates(map[string]any{"trade_no": binding.TradeNo, "pay_url": binding.PayURL, "name": binding.Name, "instructions": binding.Instructions, "status": "pending"})
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected != 1 {
		return nil, errors.New("订单状态已更改，请刷新后重试")
	}
	if err := model.DB.WithContext(ctx).Where("id = ? AND user_id = ?", id, userID).First(&order).Error; err != nil {
		return nil, err
	}
	return &order, nil
}

// RedeemCatfkOrder treats browser delivery as untrusted bearer-card input.
// CompleteCatfkOrder obtains the amount solely from a valid local redemption
// and atomically consumes it once. A fabricated paid status/price/card cannot
// mint wallet credit. Non-local cards remain manual and receive zero credit.
func RedeemCatfkOrder(ctx context.Context, userID int, id string, cards []string, instructions string) (*model.CatfkOrder, error) {
	if !operation_setting.IsPaymentComplianceConfirmed() {
		return nil, errors.New("管理员尚未确认支付合规条款")
	}
	if len(cards) == 0 || len(cards) > 20 || len(instructions) > 32768 {
		return nil, errors.New("无效的卡密交付数据")
	}
	for _, card := range cards {
		if card == "" || len(card) > 4096 {
			return nil, errors.New("无效的卡密交付数据")
		}
	}
	var order model.CatfkOrder
	if err := model.DB.WithContext(ctx).Where("id = ? AND user_id = ?", id, userID).First(&order).Error; err != nil {
		return nil, err
	}
	if order.Status == "creating" {
		return nil, errors.New("订单尚未绑定付款信息")
	}
	if err := model.CompleteCatfkOrder(id, cards, instructions); err != nil {
		return nil, err
	}
	if err := model.DB.WithContext(ctx).Where("id = ? AND user_id = ?", id, userID).First(&order).Error; err != nil {
		return nil, err
	}
	return &order, nil
}
