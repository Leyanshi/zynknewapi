package service

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

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

func TestCatfkBrowserCheckoutOnlyCreditsValidLocalCardsOnce(t *testing.T) {
	oldDB, oldLogDB, oldLink := model.DB, model.LOG_DB, common.TopUpLink
	oldRedis := common.RedisEnabled
	setting := operation_setting.GetPaymentSetting()
	oldCompliance, oldVersion := setting.ComplianceConfirmed, setting.ComplianceTermsVersion
	t.Cleanup(func() {
		model.DB, model.LOG_DB, common.TopUpLink = oldDB, oldLogDB, oldLink
		common.RedisEnabled = oldRedis
		setting.ComplianceConfirmed, setting.ComplianceTermsVersion = oldCompliance, oldVersion
	})
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "catfk.db")), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	t.Cleanup(func() { _ = sqlDB.Close() })
	require.NoError(t, db.AutoMigrate(&model.CatfkOrder{}, &model.Redemption{}, &model.User{}, &model.Log{}))
	model.DB, model.LOG_DB = db, db
	// Initialize the model's dialect-specific column names through its normal
	// log setup, without triggering unrelated production migrations.
	t.Setenv("LOG_SQL_DSN", "")
	master := common.IsMasterNode
	common.IsMasterNode = false
	err = model.InitLogDB()
	common.IsMasterNode = master
	require.NoError(t, err)
	common.TopUpLink, common.RedisEnabled = "https://catfk.com/shop/zynk", false
	setting.ComplianceConfirmed, setting.ComplianceTermsVersion = true, operation_setting.CurrentComplianceTermsVersion
	user := model.User{Id: 7, Username: "catfk-purchaser", Quota: 10}
	require.NoError(t, db.Create(&user).Error)
	ctx := context.Background()

	order, err := CreateCatfkOrder(ctx, user.Id, "credit", 1)
	require.NoError(t, err)
	assert.Equal(t, "creating", order.Status)
	assert.NotEmpty(t, order.QueryPassword)
	binding := CatfkOrderBinding{TradeNo: "CAT123", PayURL: "https://catfk.com/shopApi/Pay/payment?trade_no=CAT123", Name: "Wallet credit"}
	_, err = BindCatfkOrder(ctx, 8, order.ID, binding)
	require.Error(t, err, "another purchaser cannot bind this order")
	badBinding := binding
	badBinding.PayURL = "https://attacker.test/shopApi/Pay/payment?trade_no=CAT123"
	_, err = BindCatfkOrder(ctx, user.Id, order.ID, badBinding)
	require.Error(t, err)
	order, err = BindCatfkOrder(ctx, user.Id, order.ID, binding)
	require.NoError(t, err)
	assert.Equal(t, "pending", order.Status)
	_, err = BindCatfkOrder(ctx, user.Id, order.ID, binding)
	require.NoError(t, err, "binding retries must be idempotent")
	_, err = RedeemCatfkOrder(ctx, 8, order.ID, []string{"untrusted-card"}, "")
	require.Error(t, err, "another purchaser cannot redeem this order")

	card := model.Redemption{Key: "abcdefghijklmnopqrstuvwxyz123456", Status: common.RedemptionCodeStatusEnabled, Quota: 100}
	require.NoError(t, db.Create(&card).Error)
	settled, err := RedeemCatfkOrder(ctx, user.Id, order.ID, []string{card.Key}, "")
	require.NoError(t, err)
	assert.Equal(t, "redeemed", settled.Status)
	assert.Equal(t, 100, settled.Quota)
	_, err = RedeemCatfkOrder(ctx, user.Id, order.ID, []string{card.Key}, "")
	require.NoError(t, err)
	require.NoError(t, db.First(&user, user.Id).Error)
	assert.Equal(t, 110, user.Quota, "replaying delivery cannot mint additional quota")
	require.NoError(t, db.First(&card, card.Id).Error)
	assert.Equal(t, common.RedemptionCodeStatusUsed, card.Status)
	assert.Equal(t, user.Id, card.UsedUserId)

	for _, tc := range []struct{ name, key string }{
		{"fabricated", "123456abcdefghijklmnopqrstuvwxyz"},
		{"used", card.Key},
		{"non-local", "external card content"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pending := model.CatfkOrder{ID: tc.name, UserID: user.Id, TradeNo: "CAT-" + tc.name, Status: "pending"}
			require.NoError(t, db.Create(&pending).Error)
			result, err := RedeemCatfkOrder(ctx, user.Id, pending.ID, []string{tc.key}, "original instructions")
			require.NoError(t, err)
			assert.Equal(t, "manual", result.Status)
			assert.Zero(t, result.Quota)
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, 110, user.Quota)
		})
	}
}
