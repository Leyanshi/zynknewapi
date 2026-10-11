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
)

type catfkTestTransport func(*http.Request) (*http.Response, error)

func (f catfkTestTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

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
