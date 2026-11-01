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
	Description            string  `json:"description"`
	TransferEnabled        bool    `json:"transfer_enabled"`
	FirstEnabled           bool    `json:"first_enabled"`
	FirstPercent           float64 `json:"first_percent"`
	RegularEnabled         bool    `json:"regular_enabled"`
	RegularPercent         float64 `json:"regular_percent"`
	OnlineEnabled          bool    `json:"online_enabled"`
	CodeEnabled            bool    `json:"code_enabled"`
	AdminEnabled           bool    `json:"admin_enabled"`
	PromoterFirstMinCNY    float64 `json:"promoter_first_min_cny"`
	PromoterFirstRewardCNY float64 `json:"promoter_first_reward_cny"`
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
	// Retain the legacy fields in the API, but all recharge sources now use
	// the same fixed policy. Existing percentage settings cannot override it.
	rules.FirstEnabled, rules.RegularEnabled = true, true
	rules.FirstPercent, rules.RegularPercent = 8, 8
	rules.OnlineEnabled, rules.CodeEnabled, rules.AdminEnabled = true, true, true
	rules.PromoterFirstMinCNY, rules.PromoterFirstRewardCNY = 10, 2
	return rules, nil
}

func GetAffiliateCashbackRules() AffiliateCashbackRules {
	common.OptionMapRWMutex.RLock()
	value := common.OptionMap[AffiliateCashbackOption]
	common.OptionMapRWMutex.RUnlock()
	if value == "" {
		value = `{"transfer_enabled":true}`
	}
	rules, err := ParseAffiliateCashbackRules(value)
	if err != nil {
		common.SysError("invalid affiliate cashback settings: " + err.Error())
		rules, _ = ParseAffiliateCashbackRules(`{}`)
	}
	return rules
}

// awardRechargeCashback runs inside the recharge transaction, using the locked
// pre-credit snapshot. Refunds, gifts and transfers never call this function.
func awardRechargeCashback(tx *gorm.DB, user User, creditedQuota int, source string) error {
	if source != "online" && source != "code" && source != "admin" {
		return errors.New("unsupported recharge cashback source")
	}
	if creditedQuota <= 0 || creditedQuota > common.MaxWalletQuota {
		return ErrInvalidTopUpQuota
	}
	// Record the first successful recharge even without an inviter or while
	// payments are disabled. A transaction rollback also rolls this back.
	if !user.HasRecharged {
		if err := tx.Model(&User{}).Where("id = ?", user.Id).Update("has_recharged", true).Error; err != nil {
			return err
		}
	}
	if !operation_setting.IsPaymentComplianceConfirmed() || user.InviterId <= 0 || user.InviterId == user.Id {
		return nil
	}
	var inviter User
	if err := lockForUpdate(tx).First(&inviter, user.InviterId).Error; err != nil {
		return err
	}
	rewardQuota := decimal.NewFromInt(int64(creditedQuota)).Mul(decimal.NewFromInt(8)).Div(decimal.NewFromInt(100))
	if inviter.IsPromoter && !user.HasRecharged {
		rate := operation_setting.USDExchangeRate
		if rate <= 0 || math.IsNaN(rate) || math.IsInf(rate, 0) || common.QuotaPerUnit <= 0 || math.IsNaN(common.QuotaPerUnit) || math.IsInf(common.QuotaPerUnit, 0) {
			return errors.New("invalid CNY exchange rate or quota unit")
		}
		quotaPerCNY := decimal.NewFromFloat(common.QuotaPerUnit).Div(decimal.NewFromFloat(rate))
		// Compare without dividing the credited quota to preserve the exact
		// threshold, regardless of the interface's display currency.
		if decimal.NewFromInt(int64(creditedQuota)).Mul(decimal.NewFromFloat(rate)).GreaterThanOrEqual(decimal.NewFromInt(10).Mul(decimal.NewFromFloat(common.QuotaPerUnit))) {
			rewardQuota = quotaPerCNY.Mul(decimal.NewFromInt(2))
		}
	}
	reward, err := common.WalletQuotaFromDecimalStrict(rewardQuota.Truncate(0))
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

// migrateRechargeHistory initializes the new marker once on legacy databases.
// Recorded online/code recharges survive balance resets. For older manual
// credits without an order, nonzero balance or usage preserves the old rule.
func migrateRechargeHistory(db *gorm.DB) error {
	if !db.Migrator().HasTable(&User{}) || db.Migrator().HasColumn(&User{}, "has_recharged") {
		return nil
	}
	if err := db.Migrator().AddColumn(&User{}, "HasRecharged"); err != nil {
		return err
	}
	query := db.Unscoped().Model(&User{}).Where("quota <> 0 OR used_quota <> 0")
	if db.Migrator().HasTable(&TopUp{}) {
		query = query.Or("id IN (?)", db.Model(&TopUp{}).Select("user_id").Where("status = ?", common.TopUpStatusSuccess))
	}
	if db.Migrator().HasTable(&Redemption{}) {
		query = query.Or("id IN (?)", db.Unscoped().Model(&Redemption{}).Select("used_user_id").Where("used_user_id > 0"))
	}
	return query.Update("has_recharged", true).Error
}

func SetUserPromoter(userID, operatorRole int, enabled bool) (*User, error) {
	if operatorRole != common.RoleRootUser {
		return nil, ErrUserQuotaPermission
	}
	if userID <= 0 {
		return nil, ErrInvalidUserQuotaAdjustment
	}
	var user User
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).First(&user, userID).Error; err != nil {
			return err
		}
		return tx.Model(&User{}).Where("id = ?", userID).Update("is_promoter", enabled).Error
	})
	return &user, err
}

// AdjustUserCashback changes only the remaining reward balance. It neither
// credits wallet quota nor rewrites the historical amount earned.
func AdjustUserCashback(userID, operatorRole int, mode string, value int) (*UserQuotaAdjustment, error) {
	if operatorRole != common.RoleAdminUser && operatorRole != common.RoleRootUser {
		return nil, ErrUserQuotaPermission
	}
	if userID <= 0 || (mode != "add" && mode != "subtract") || value <= 0 {
		return nil, ErrInvalidUserQuotaAdjustment
	}
	if value > common.MaxWalletQuota {
		return nil, ErrWalletQuotaLimitExceeded
	}
	var adjustment UserQuotaAdjustment
	err := DB.Transaction(func(tx *gorm.DB) error {
		var user User
		if err := lockForUpdate(tx).First(&user, userID).Error; err != nil {
			return err
		}
		if operatorRole != common.RoleRootUser && operatorRole <= user.Role {
			return ErrUserQuotaPermission
		}
		if user.AffQuota < 0 || user.AffQuota > common.MaxWalletQuota {
			return ErrWalletQuotaLimitExceeded
		}
		after := user.AffQuota
		if mode == "add" {
			if value > common.MaxWalletQuota-after {
				return ErrWalletQuotaLimitExceeded
			}
			after += value
		} else {
			if value > after {
				return errors.New("insufficient pending cashback")
			}
			after -= value
		}
		// The predicate also protects SQLite, where FOR UPDATE is unavailable.
		result := tx.Model(&User{}).Where("id = ? AND aff_quota = ?", userID, user.AffQuota).Update("aff_quota", after)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return errors.New("pending cashback changed; please retry")
		}
		adjustment = UserQuotaAdjustment{UserID: user.Id, Username: user.Username, Before: user.AffQuota, After: after}
		return nil
	})
	return &adjustment, err
}
