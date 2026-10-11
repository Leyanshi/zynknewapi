package model

import (
	"errors"
	"math"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
)

const AffiliateCashbackOption = "AffiliateCashback"

type AffiliateCashbackRules struct {
	TransferEnabled bool    `json:"transfer_enabled"`
	FirstEnabled    bool    `json:"first_enabled"`
	FirstPercent    float64 `json:"first_percent"`
	RegularEnabled  bool    `json:"regular_enabled"`
	RegularPercent  float64 `json:"regular_percent"`
	OnlineEnabled   bool    `json:"online_enabled"`
	CodeEnabled     bool    `json:"code_enabled"`
	AdminEnabled    bool    `json:"admin_enabled"`
}

func ParseAffiliateCashbackRules(value string) (AffiliateCashbackRules, error) {
	var rules AffiliateCashbackRules
	if err := common.UnmarshalJsonStr(value, &rules); err != nil {
		return rules, err
	}
	for _, percent := range []float64{rules.FirstPercent, rules.RegularPercent} {
		if math.IsNaN(percent) || math.IsInf(percent, 0) || percent < 0 || percent > 100 {
			return rules, errors.New("cashback percentage must be between 0 and 100")
		}
	}
	return rules, nil
}

func GetAffiliateCashbackRules() AffiliateCashbackRules {
	common.OptionMapRWMutex.RLock()
	value := common.OptionMap[AffiliateCashbackOption]
	common.OptionMapRWMutex.RUnlock()
	if value == "" {
		return AffiliateCashbackRules{TransferEnabled: true}
	}
	rules, err := ParseAffiliateCashbackRules(value)
	if err != nil {
		common.SysError("invalid affiliate cashback settings: " + err.Error())
		return AffiliateCashbackRules{}
	}
	return rules
}

// awardRechargeCashback runs inside the recharge transaction, using the locked
// pre-credit snapshot. Refunds, gifts and transfers never call this function.
func awardRechargeCashback(tx *gorm.DB, user User, creditedQuota int, source string) error {
	if source != "online" && source != "code" && source != "admin" {
		return errors.New("unsupported recharge cashback source")
	}
	rules := GetAffiliateCashbackRules()
	if !operation_setting.IsPaymentComplianceConfirmed() || user.InviterId <= 0 || user.InviterId == user.Id {
		return nil
	}
	if (source == "online" && !rules.OnlineEnabled) || (source == "code" && !rules.CodeEnabled) || (source == "admin" && !rules.AdminEnabled) {
		return nil
	}
	percent := rules.RegularPercent
	if user.Quota == 0 && user.UsedQuota == 0 && rules.FirstEnabled {
		percent = rules.FirstPercent
	} else if !rules.RegularEnabled {
		return nil
	}
	reward, err := common.WalletQuotaFromDecimalStrict(decimal.NewFromInt(int64(creditedQuota)).Mul(decimal.NewFromFloat(percent)).Div(decimal.NewFromInt(100)).Truncate(0))
	if err != nil {
		return err
	}
	if reward <= 0 {
		return nil
	}
	result := tx.Model(&User{}).
		Where("id = ? AND aff_quota <= ? AND aff_history <= ?", user.InviterId, common.MaxWalletQuota-reward, common.MaxWalletQuota-reward).
		Updates(map[string]any{"aff_quota": gorm.Expr("aff_quota + ?", reward), "aff_history": gorm.Expr("aff_history + ?", reward)})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return errors.New("inviter cashback account unavailable or quota limit exceeded")
	}
	return nil
}
