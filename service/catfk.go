package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
)

var catfkClient = &http.Client{
	Timeout:       20 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse },
}

type CatfkGoods struct {
	Key         string  `json:"goods_key"`
	Name        string  `json:"name"`
	Price       float64 `json:"price"`
	Description string  `json:"description"`
	Contact     string  `json:"contact_format"`
	Extend      struct {
		Stock int `json:"stock_count"`
		Limit int `json:"limit_count"`
	} `json:"extend"`
}

type CatfkChannel struct {
	ID   int    `json:"id"`
	Name string `json:"show_name"`
}

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

func catfkRequest(ctx context.Context, endpoint, visitor string, body any, target any) (bool, error) {
	data, err := common.Marshal(body)
	if err != nil {
		return false, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://catfk.com/shopApi/"+endpoint, bytes.NewReader(data))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Visitorid", visitor)
	resp, err := catfkClient.Do(req)
	if err != nil {
		return false, errors.New("发卡平台暂时无法连接，请稍后重试")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, errors.New("发卡平台暂时不可用，请稍后重试")
	}
	var envelope struct {
		Code int               `json:"code"`
		Data common.RawMessage `json:"data"`
	}
	if err := common.DecodeJson(io.LimitReader(resp.Body, 2<<20), &envelope); err != nil {
		return false, errors.New("发卡平台返回了无效数据")
	}
	if err := common.Unmarshal(envelope.Data, target); err != nil {
		return false, errors.New("发卡平台返回了无效数据")
	}
	return envelope.Code == 1, nil
}

func GetCatfkCatalog(ctx context.Context, token string) ([]CatfkGoods, []CatfkChannel, error) {
	goods := make([]CatfkGoods, 0)
	for page := 1; page <= 10; page++ {
		var result struct {
			List []CatfkGoods `json:"list"`
		}
		ok, err := catfkRequest(ctx, "Shop/goodsList", "new-api-catalog", map[string]any{
			"token": token, "goods_type": "card", "current": page, "pageSize": 100,
		}, &result)
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			return nil, nil, errors.New("无法读取店铺商品")
		}
		goods = append(goods, result.List...)
		if len(result.List) < 100 {
			break
		}
	}
	var channels []CatfkChannel
	ok, err := catfkRequest(ctx, "Shop/getUserChannel", "new-api-catalog", map[string]string{"token": token}, &channels)
	if err != nil {
		return nil, nil, err
	}
	if !ok {
		return nil, nil, errors.New("无法读取支付方式")
	}
	return goods, channels, nil
}

func CreateCatfkOrder(ctx context.Context, userID int, goodsKey string, channelID int) (*model.CatfkOrder, error) {
	token := CatfkShopToken()
	if token == "" || !operation_setting.IsPaymentComplianceConfirmed() {
		return nil, errors.New("管理员尚未启用此充值方式或确认支付合规条款")
	}
	goods, channels, err := GetCatfkCatalog(ctx, token)
	if err != nil {
		return nil, err
	}
	var selected *CatfkGoods
	for i := range goods {
		if goods[i].Key == goodsKey {
			selected = &goods[i]
			break
		}
	}
	if selected == nil || selected.Extend.Stock <= 0 || selected.Extend.Limit > 1 {
		return nil, errors.New("商品不存在、缺货或不支持单件购买")
	}
	if selected.Contact != "any" {
		return nil, errors.New("此商品不支持使用用户ID作为联系方式")
	}
	validChannel := false
	for _, channel := range channels {
		if channel.ID == channelID {
			validChannel = true
			break
		}
	}
	if !validChannel {
		return nil, errors.New("无效的支付方式")
	}
	order := &model.CatfkOrder{
		ID: common.GetUUID(), UserID: userID, ShopToken: token, GoodsKey: goodsKey,
		Name: selected.Name, Instructions: selected.Description, QueryPassword: common.GetUUID(), Status: "creating", CreatedTime: common.GetTimestamp(),
	}
	order.TradeNo = "creating-" + order.ID
	// Persist before the remote request. An ambiguous timeout must NOT be
	// automatically retried: that could create an additional payable order.
	if err := model.DB.Create(order).Error; err != nil {
		return nil, err
	}
	var result struct {
		TradeNo string `json:"trade_no"`
		PayURL  string `json:"payurl"`
	}
	ok, err := catfkRequest(ctx, "Pay/order", order.ID, map[string]any{
		"goods_key": goodsKey, "quantity": 1, "channel_id": channelID,
		"contact": fmt.Sprintf("newapi-user-%d", userID), "query_password": order.QueryPassword,
		"coupon_code": "", "select_cards_ids": []int{}, "extend": map[string]any{},
	}, &result)
	if err != nil {
		return nil, err
	}
	if !ok || result.TradeNo == "" {
		return nil, errors.New("创建订单失败，请在发卡平台确认订单后重试")
	}
	u, parseErr := url.Parse(result.PayURL)
	if parseErr != nil || u.Scheme != "https" || u.Host != "catfk.com" || u.Path != "/shopApi/Pay/payment" || u.Query().Get("trade_no") != result.TradeNo {
		return nil, errors.New("发卡平台返回了无效的付款地址")
	}
	order.TradeNo, order.PayURL, order.Status = result.TradeNo, result.PayURL, "pending"
	if err := model.DB.Model(order).Updates(map[string]any{"trade_no": order.TradeNo, "pay_url": order.PayURL, "status": "pending"}).Error; err != nil {
		return nil, err
	}
	return order, nil
}

// ReconcileCatfkOrder only trusts server-fetched paid orders and delivered
// cards. Browser redirects, popup closure and client-supplied cards are ignored.
func ReconcileCatfkOrder(ctx context.Context, order *model.CatfkOrder) error {
	if order.Status != "pending" {
		return nil
	}
	if !operation_setting.IsPaymentComplianceConfirmed() {
		return nil
	}
	var result struct {
		TradeNo  string `json:"trade_no"`
		Status   int    `json:"status"`
		Quantity int    `json:"quantity"`
		Goods    struct {
			Key    string `json:"goods_key"`
			Extend struct {
				Instructions string `json:"instructions"`
			} `json:"extend"`
		} `json:"goods"`
		Response struct {
			Cards []string `json:"cards"`
		} `json:"response"`
	}
	ok, err := catfkRequest(ctx, "Order/info", order.ID, map[string]any{
		"trade_no": order.TradeNo, "query_password": order.QueryPassword, "dump": 1,
	}, &result)
	if err != nil {
		return err
	}
	if !ok || result.Status != 1 {
		return nil
	}
	if result.TradeNo != order.TradeNo || result.Goods.Key != order.GoodsKey || result.Quantity != 1 {
		return errors.New("发卡平台订单信息不匹配")
	}
	if len(result.Response.Cards) == 0 {
		return nil
	} // paid but awaiting delivery
	instructions := result.Goods.Extend.Instructions
	if instructions == "" {
		instructions = order.Instructions
	}
	return model.CompleteCatfkOrder(order.ID, result.Response.Cards, instructions)
}

// Pending orders are durable; purchases still settle after the wallet closes
// or the gateway restarts. CheckedTime provides fair scheduling of the queue.
func PollCatfkOrders() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if !operation_setting.IsPaymentComplianceConfirmed() {
			continue
		}
		var orders []model.CatfkOrder
		if err := model.DB.Where("status = ? AND created_time > ?", "pending", common.GetTimestamp()-7*86400).
			Order("checked_time asc").Limit(20).Find(&orders).Error; err != nil {
			continue
		}
		for i := range orders {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			err := ReconcileCatfkOrder(ctx, &orders[i])
			cancel()
			if err != nil {
				common.SysError("catfk order reconciliation failed for order " + orders[i].ID)
			}
			model.DB.Model(&model.CatfkOrder{}).Where("id = ?", orders[i].ID).Update("checked_time", common.GetTimestamp())
		}
	}
}
