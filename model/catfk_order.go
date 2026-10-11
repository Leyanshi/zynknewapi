package model

import (
	"errors"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"gorm.io/gorm"
)

// CatfkOrder keeps the remote order bound to its purchaser across restarts.
// Query credentials and delivered cards must never appear in logs.
type CatfkOrder struct {
	ID            string `json:"id" gorm:"type:varchar(32);primaryKey"`
	UserID        int    `json:"-" gorm:"index"`
	ShopToken     string `json:"-" gorm:"type:varchar(100)"`
	GoodsKey      string `json:"-" gorm:"type:varchar(100)"`
	Name          string `json:"name" gorm:"type:text"`
	TradeNo       string `json:"trade_no" gorm:"type:varchar(100);uniqueIndex"`
	QueryPassword string `json:"-" gorm:"type:varchar(64)"`
	PayURL        string `json:"pay_url" gorm:"type:text"`
	Status        string `json:"status" gorm:"type:varchar(20);index"`
	Cards         string `json:"-" gorm:"type:text"`
	Instructions  string `json:"instructions" gorm:"type:text"`
	Quota         int    `json:"quota"`
	CreatedTime   int64  `json:"created_time" gorm:"index"`
	CheckedTime   int64  `json:"-" gorm:"index"`
}

// CatfkRedemptionKey accepts a bare code or a label followed by whitespace and
// a code. Never destroy the original card; non-redemption products need it.
func CatfkRedemptionKey(card string) string {
	parts := strings.Fields(card)
	if len(parts) == 0 {
		return ""
	}
	key := parts[len(parts)-1]
	if len(key) != 32 {
		return ""
	}
	for _, c := range key {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			return ""
		}
	}
	return key
}

// CompleteCatfkOrder records delivery and credits a local redemption in the
// same transaction. Both the order CAS and the redemption CAS prevent duplicate
// credits, including on SQLite and when multiple gateway instances poll.
func CompleteCatfkOrder(id string, cards []string, instructions string) error {
	encoded, err := common.Marshal(cards)
	if err != nil {
		return err
	}
	var credited *Redemption
	var order CatfkOrder
	err = DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ?", id).First(&order).Error; err != nil {
			return err
		}
		if order.Status != "pending" {
			return nil
		}
		result := tx.Model(&CatfkOrder{}).Where("id = ? AND status = ?", id, "pending").Updates(map[string]any{
			"status": "manual", "cards": string(encoded), "instructions": instructions,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		// Orders contain exactly one item. Unexpected delivery is preserved for
		// manual use rather than partially credited or silently discarded.
		if len(cards) != 1 {
			return nil
		}
		key := CatfkRedemptionKey(cards[0])
		if key == "" {
			return nil
		}
		var redemption Redemption
		err := lockForUpdate(tx).Where(commonKeyCol+" = ?", key).First(&redemption).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if redemption.Status != common.RedemptionCodeStatusEnabled ||
			(redemption.ExpiredTime != 0 && redemption.ExpiredTime < common.GetTimestamp()) {
			return nil
		}
		if err := tx.SavePoint("catfk_credit").Error; err != nil {
			return err
		}
		result = tx.Model(&Redemption{}).Where("id = ? AND status = ?", redemption.Id, common.RedemptionCodeStatusEnabled).
			Updates(map[string]any{"status": common.RedemptionCodeStatusUsed, "used_user_id": order.UserID, "redeemed_time": common.GetTimestamp()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		if err := creditRechargeQuota(tx, order.UserID, redemption.Quota, nil, "code"); err != nil {
			if errors.Is(err, ErrTopUpQuotaLimitExceeded) {
				// Preserve delivery for manual redemption after the wallet limit
				// is resolved, without consuming the code or losing the card.
				return tx.RollbackTo("catfk_credit").Error
			}
			return err
		}
		if err := tx.Model(&CatfkOrder{}).Where("id = ?", id).Updates(map[string]any{"status": "redeemed", "quota": redemption.Quota}).Error; err != nil {
			return err
		}
		credited = &redemption
		return nil
	})
	if err == nil && credited != nil {
		syncCreditUserQuotaCache(order.UserID, credited.Quota, "catfk redemption")
		RecordLog(order.UserID, LogTypeTopup, fmt.Sprintf("通过兑换码充值 %s，兑换码ID %d", logger.LogQuota(credited.Quota), credited.Id))
	}
	return err
}
