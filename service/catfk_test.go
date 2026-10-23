package service

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type catfkTestTransport func(*http.Request) (*http.Response, error)

func (f catfkTestTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func resetCatfkCatalogCache() { catfkCatalog = catfkCatalogCacheEntry{} }

func TestCatfkShopRequiresExplicitHTTPSShopConfiguration(t *testing.T) {
	old := common.TopUpLink
	t.Cleanup(func() { common.TopUpLink = old })
	for _, tc := range []struct{ link, want string }{
		{"https://catfk.com/shop/zynk", "zynk"},
		{"https://catfk.com/shop/zynk/", "zynk"},
		{"http://catfk.com/shop/zynk", ""}, {"https://catfk.com.attacker.test/shop/zynk", ""},
		{"https://user@catfk.com/shop/zynk", ""}, {"https://catfk.com/shop/", ""},
		{"https://catfk.com/shop/zynk/unexpected", ""}, {"", ""},
	} {
		common.TopUpLink = tc.link
		assert.Equal(t, tc.want, CatfkShopToken())
	}
}

func TestCatfkCatalogReadsNativeGoodsAndPaymentMethods(t *testing.T) {
	old := catfkClient
	t.Cleanup(func() { catfkClient = old })
	catfkClient = &http.Client{Transport: catfkTestTransport(func(req *http.Request) (*http.Response, error) {
		assert.Equal(t, "catfk.com", req.URL.Host)
		assert.Equal(t, http.MethodPost, req.Method)
		var body map[string]any
		require.NoError(t, common.DecodeJson(req.Body, &body))
		assert.Equal(t, "zynk", body["token"])
		data := `{"code":1,"data":[{"id":1,"show_name":"Alipay"}]}`
		if strings.HasSuffix(req.URL.Path, "goodsList") {
			assert.Equal(t, "card", body["goods_type"])
			data = `{"code":1,"data":{"list":[{"goods_key":"credit","name":"Wallet credit","price":1,"contact_format":"any","extend":{"stock_count":5,"limit_count":1}}]}}`
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(data)), Header: http.Header{}}, nil
	})}
	goods, channels, err := GetCatfkCatalog(context.Background(), "zynk")
	require.NoError(t, err)
	require.Len(t, goods, 1)
	assert.Equal(t, "credit", goods[0].Key)
	assert.Equal(t, 5, goods[0].Extend.Stock)
	require.Len(t, channels, 1)
	assert.Equal(t, 1, channels[0].ID)
}

func TestCatfkCatalogCachesRequestsPerToken(t *testing.T) {
	old := catfkClient
	oldCatalog := catfkCatalog
	t.Cleanup(func() {
		catfkClient = old
		catfkCatalog = oldCatalog
	})
	requests := 0
	catfkClient = &http.Client{Transport: catfkTestTransport(func(req *http.Request) (*http.Response, error) {
		requests++
		assert.Equal(t, "catfk.com", req.URL.Host)
		data := `{"code":1,"data":[{"id":1,"show_name":"Alipay"}]}`
		if strings.HasSuffix(req.URL.Path, "goodsList") {
			data = `{"code":1,"data":{"list":[{"goods_key":"credit","name":"Wallet credit","price":1,"contact_format":"any","extend":{"stock_count":5,"limit_count":1}}]}}`
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(data)), Header: http.Header{}}, nil
	})}
	resetCatfkCatalogCache()
	goods, channels, err := GetCatfkCatalog(context.Background(), "zynk")
	require.NoError(t, err)
	require.Len(t, goods, 1)
	require.Len(t, channels, 1)
	assert.Equal(t, 2, requests, "one catalog fetch posts goodsList once plus one channel request")

	again, cachedChannels, err := GetCatfkCatalog(context.Background(), "zynk")
	require.NoError(t, err)
	assert.Equal(t, goods, again)
	assert.Equal(t, channels, cachedChannels)
	assert.Equal(t, 2, requests, "the cached catalog must not re-request the terminal")

	_, _, err = GetCatfkCatalog(context.Background(), "other")
	require.NoError(t, err)
	assert.Equal(t, 4, requests, "a different shop token must fetch its own catalog")
}

func TestCatfkSyncReconcilesOneDueOrderAndReturnsActiveOrders(t *testing.T) {
	oldDB := model.DB
	t.Cleanup(func() { model.DB = oldDB })
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.CatfkOrder{}))
	model.DB = db

	setting := operation_setting.GetPaymentSetting()
	oldCompliance, oldVersion := setting.ComplianceConfirmed, setting.ComplianceTermsVersion
	setting.ComplianceConfirmed, setting.ComplianceTermsVersion = true, operation_setting.CurrentComplianceTermsVersion
	t.Cleanup(func() { setting.ComplianceConfirmed, setting.ComplianceTermsVersion = oldCompliance, oldVersion })

	oldClient := catfkClient
	t.Cleanup(func() { catfkClient = oldClient })
	remoteCalls := 0
	catfkClient = &http.Client{Transport: catfkTestTransport(func(req *http.Request) (*http.Response, error) {
		remoteCalls++
		var body map[string]any
		require.NoError(t, common.DecodeJson(req.Body, &body))
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(
			`{"code":1,"data":{"status":1,"trade_no":"trade-one","quantity":1,"goods":{"goods_key":"credit"},"response":{"cards":["stored 32-char card elsewhere"]}}}`,
		))}, nil
	})}

	now := common.GetTimestamp()
	due := model.CatfkOrder{ID: "due", UserID: 7, GoodsKey: "credit", Name: "Wallet credit", TradeNo: "trade-one",
		Status: "pending", CreatedTime: now, CheckedTime: 0}
	fresh := model.CatfkOrder{ID: "fresh", UserID: 7, GoodsKey: "credit", Name: "Wallet credit", TradeNo: "trade-two",
		Status: "pending", CreatedTime: now, CheckedTime: now}
	other := model.CatfkOrder{ID: "other", UserID: 8, GoodsKey: "credit", Name: "Wallet credit", TradeNo: "trade-three",
		Status: "pending", CreatedTime: now, CheckedTime: 0}
	for _, seeded := range []model.CatfkOrder{due, fresh, other} {
		require.NoError(t, model.DB.Create(&seeded).Error)
	}

	// A fresh sync must reconcile only the due order; the order checked a
	// moment ago waits for the next interval instead of re-hitting upstream.
	orders, err := SyncCatfkUserOrders(context.Background(), 7)
	require.NoError(t, err)
	assert.Equal(t, 1, remoteCalls, "one sync reconciles at most one due order")
	require.Len(t, orders, 2)
	assert.Equal(t, "due", orders[0].ID)
	assert.Equal(t, "manual", orders[0].Status)
	assert.Equal(t, "pending", orders[1].Status)

	remoteCalls = 0
	_, err = SyncCatfkUserOrders(context.Background(), 8)
	require.NoError(t, err)
	assert.Equal(t, 0, remoteCalls, "the just-reconciled due order stays inside the sync interval and must not be rechecked remotely")
}

func TestCatfkOrderDoesNotSettleUnpaidUndeliveredOrMismatchedResponses(t *testing.T) {
	oldClient := catfkClient
	t.Cleanup(func() { catfkClient = oldClient })
	// The compliance setting must be explicitly initialized like production.
	setting := operation_setting.GetPaymentSetting()
	oldCompliance, oldVersion := setting.ComplianceConfirmed, setting.ComplianceTermsVersion
	setting.ComplianceConfirmed, setting.ComplianceTermsVersion = true, operation_setting.CurrentComplianceTermsVersion
	t.Cleanup(func() { setting.ComplianceConfirmed, setting.ComplianceTermsVersion = oldCompliance, oldVersion })
	for _, tc := range []struct {
		name, response string
		fail           bool
	}{
		{"unpaid", `{"code":1,"data":{"status":2}}`, false},
		{"paid waiting for delivery", `{"code":1,"data":{"status":1,"trade_no":"trade-one","quantity":1,"goods":{"goods_key":"credit"},"response":{"cards":[]}}}`, false},
		{"mismatched order", `{"code":1,"data":{"status":1,"trade_no":"someone-elses-order","quantity":1,"goods":{"goods_key":"credit"},"response":{"cards":["secret"]}}}`, true},
		{"mismatched goods", `{"code":1,"data":{"status":1,"trade_no":"trade-one","quantity":1,"goods":{"goods_key":"other"},"response":{"cards":["secret"]}}}`, true},
		{"invalid response", `not json`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			catfkClient = &http.Client{Transport: catfkTestTransport(func(req *http.Request) (*http.Response, error) {
				var body map[string]any
				require.NoError(t, common.DecodeJson(req.Body, &body))
				assert.Equal(t, "private-order-password", body["query_password"])
				assert.Equal(t, "trade-one", body["trade_no"])
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(tc.response)), Header: http.Header{}}, nil
			})}
			err := ReconcileCatfkOrder(context.Background(), &model.CatfkOrder{ID: "one", TradeNo: "trade-one", GoodsKey: "credit", QueryPassword: "private-order-password", Status: "pending"})
			if tc.fail {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}
