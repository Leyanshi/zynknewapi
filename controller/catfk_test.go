package controller

import (
	"testing"

	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCatfkOrderItemsScopesBrowserQueryCredentialsToPendingOrders(t *testing.T) {
	for _, status := range []string{"creating", "pending", "redeemed", "manual"} {
		t.Run(status, func(t *testing.T) {
			items, err := catfkOrderItems([]model.CatfkOrder{{
				ID: "order-one", Status: status, TradeNo: "CAT123",
				QueryPassword: "per-order-query-password", ShopToken: "private-shop-token",
				Cards: `["delivered-card"]`,
			}})
			require.NoError(t, err)
			require.Len(t, items, 1)
			assert.Equal(t, "CAT123", items[0]["trade_no"])
			assert.Equal(t, []string{"delivered-card"}, items[0]["cards"])
			assert.NotContains(t, items[0], "shop_token")
			if status == "pending" || status == "creating" {
				assert.Equal(t, "per-order-query-password", items[0]["query_password"])
			} else {
				assert.NotContains(t, items[0], "query_password")
			}
		})
	}
}
