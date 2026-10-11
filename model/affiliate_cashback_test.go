package model

import (
	"errors"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestRechargeCashback(t *testing.T) {
	require.NoError(t, DB.AutoMigrate(&User{}))
	payment := operation_setting.GetPaymentSetting()
	previousPayment := *payment
	payment.ComplianceConfirmed = true
	payment.ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
	common.OptionMapRWMutex.Lock()
	if common.OptionMap == nil {
		common.OptionMap = make(map[string]string)
	}
	previousRules := common.OptionMap[AffiliateCashbackOption]
	common.OptionMap[AffiliateCashbackOption] = `{"transfer_enabled":false,"first_enabled":true,"first_percent":20,"regular_enabled":true,"regular_percent":5,"online_enabled":true,"code_enabled":true,"admin_enabled":true}`
	common.OptionMapRWMutex.Unlock()
	t.Cleanup(func() {
		*payment = previousPayment
		common.OptionMapRWMutex.Lock()
		common.OptionMap[AffiliateCashbackOption] = previousRules
		common.OptionMapRWMutex.Unlock()
	})
	for _, tc := range []struct {
		name, source            string
		balance, used, expected int
	}{
		{"first online", "online", 0, 0, 200},
		{"first code", "code", 0, 0, 200},
		{"nonzero balance", "online", 1, 0, 50},
		{"nonzero usage", "code", 0, 1, 50},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inviter := User{Username: common.GetUUID(), AffCode: common.GetUUID()}
			require.NoError(t, DB.Create(&inviter).Error)
			buyer := User{Username: common.GetUUID(), AffCode: common.GetUUID(), InviterId: inviter.Id, Quota: tc.balance, UsedQuota: tc.used}
			require.NoError(t, DB.Create(&buyer).Error)
			t.Cleanup(func() {
				require.NoError(t, DB.Unscoped().Where("id IN ?", []int{buyer.Id, inviter.Id}).Delete(&User{}).Error)
			})
			require.NoError(t, DB.Transaction(func(tx *gorm.DB) error { return creditRechargeQuota(tx, buyer.Id, 1000, nil, tc.source) }))
			require.NoError(t, DB.First(&inviter, inviter.Id).Error)
			assert.Equal(t, tc.expected, inviter.AffQuota)
			assert.Equal(t, tc.expected, inviter.AffHistoryQuota)
			require.NoError(t, DB.First(&buyer, buyer.Id).Error)
			assert.Equal(t, tc.balance+1000, buyer.Quota)
			assert.Error(t, inviter.TransferAffQuotaToQuota(500000))
		})
	}
	inviter := User{Username: common.GetUUID(), AffCode: common.GetUUID()}
	require.NoError(t, DB.Create(&inviter).Error)
	buyer := User{Username: common.GetUUID(), AffCode: common.GetUUID(), InviterId: inviter.Id}
	require.NoError(t, DB.Create(&buyer).Error)
	t.Cleanup(func() {
		require.NoError(t, DB.Unscoped().Where("id IN ?", []int{buyer.Id, inviter.Id}).Delete(&User{}).Error)
	})
	_, err := AdjustUserQuota(buyer.Id, common.RoleRootUser, "add", 1000)
	require.NoError(t, err)
	require.NoError(t, DB.First(&inviter, inviter.Id).Error)
	assert.Equal(t, 200, inviter.AffQuota)
	common.OptionMapRWMutex.Lock()
	common.OptionMap[AffiliateCashbackOption] = `{"transfer_enabled":false,"first_enabled":true,"first_percent":20,"regular_enabled":true,"regular_percent":5,"online_enabled":false,"code_enabled":false,"admin_enabled":false}`
	common.OptionMapRWMutex.Unlock()
	require.NoError(t, DB.Transaction(func(tx *gorm.DB) error { return creditRechargeQuota(tx, buyer.Id, 1000, nil, "code") }))
	require.NoError(t, DB.First(&inviter, inviter.Id).Error)
	assert.Equal(t, 200, inviter.AffQuota, "disabled sources must not earn cashback")
	_, err = AdjustUserQuota(buyer.Id, common.RoleRootUser, "subtract", 100)
	require.NoError(t, err)
	require.NoError(t, DB.First(&inviter, inviter.Id).Error)
	assert.Equal(t, 200, inviter.AffQuota, "debits must never earn cashback")
	common.OptionMapRWMutex.Lock()
	common.OptionMap[AffiliateCashbackOption] = `{"transfer_enabled":true,"first_enabled":true,"first_percent":20,"regular_enabled":true,"regular_percent":5,"online_enabled":false,"code_enabled":true,"admin_enabled":false}`
	common.OptionMapRWMutex.Unlock()
	err = DB.Transaction(func(tx *gorm.DB) error {
		if err := creditRechargeQuota(tx, buyer.Id, 1000, nil, "code"); err != nil {
			return err
		}
		return errors.New("settlement rollback")
	})
	require.Error(t, err)
	require.NoError(t, DB.First(&inviter, inviter.Id).Error)
	assert.Equal(t, 200, inviter.AffQuota, "failed settlements must roll back cashback")
	require.NoError(t, DB.Model(&User{}).Where("id = ?", inviter.Id).Update("aff_quota", 500000).Error)
	require.NoError(t, inviter.TransferAffQuotaToQuota(500000))
	require.NoError(t, DB.First(&inviter, inviter.Id).Error)
	assert.Zero(t, inviter.AffQuota)
	assert.Equal(t, 500000, inviter.Quota)
	assert.Equal(t, 200, inviter.AffHistoryQuota, "transfers must not generate another reward")
}

func TestCashbackRulesRejectInvalidPercentages(t *testing.T) {
	for _, value := range []string{`{"first_percent":101}`, `{"regular_percent":-1}`, `invalid`} {
		_, err := ParseAffiliateCashbackRules(value)
		assert.Error(t, err)
	}
}
