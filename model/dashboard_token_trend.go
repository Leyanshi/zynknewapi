package model

import (
	"errors"

	"github.com/QuantumNous/new-api/common"
)

type DashboardTokenTrend struct {
	Bucket        int64 `json:"bucket" gorm:"column:bucket"`
	InputTokens   int64 `json:"input_tokens" gorm:"column:input_tokens"`
	OutputTokens  int64 `json:"output_tokens" gorm:"column:output_tokens"`
	CacheCreation int64 `json:"cache_creation_tokens" gorm:"column:cache_creation_tokens"`
	CacheRead     int64 `json:"cache_read_tokens" gorm:"column:cache_read_tokens"`
}

func dashboardLogJSONInt(column, key string) string {
	switch common.LogDatabaseType() {
	case common.DatabaseTypeMySQL:
		return "CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(" + column + ", '$." + key + "')), '0') AS SIGNED)"
	case common.DatabaseTypePostgreSQL:
		return "COALESCE(NULLIF((" + column + "::jsonb ->> '" + key + "'), '')::bigint, 0)"
	case common.DatabaseTypeClickHouse:
		return "JSONExtractInt(" + column + ", '" + key + "')"
	default:
		return "CAST(COALESCE(json_extract(" + column + ", '$." + key + "'), 0) AS INTEGER)"
	}
}

func GetDashboardTokenTrend(userID int, startTime, endTime int64, granularity string) ([]DashboardTokenTrend, error) {
	if userID <= 0 || startTime <= 0 || endTime < startTime {
		return nil, errors.New("invalid dashboard token trend range")
	}
	interval := int64(3600)
	switch granularity {
	case "hour":
	case "day":
		interval = 86400
	case "week":
		interval = 604800
	default:
		return nil, errors.New("invalid dashboard token trend granularity")
	}
	bucketExpr := "CAST(created_at / ? AS INTEGER) * ?"
	if common.UsingLogDatabase(common.DatabaseTypeMySQL) {
		bucketExpr = "FLOOR(created_at / ?) * ?"
	}
	if common.UsingLogDatabase(common.DatabaseTypeClickHouse) {
		bucketExpr = "intDiv(created_at, ?) * ?"
	}

	cacheCreation := dashboardLogJSONInt("other", "cache_creation_tokens")
	cacheCreationFallback := dashboardLogJSONInt("other", "cache_creation_tokens_5m") + " + " + dashboardLogJSONInt("other", "cache_creation_tokens_1h")
	cacheRead := dashboardLogJSONInt("other", "cache_tokens")
	var rows []DashboardTokenTrend
	err := LOG_DB.Model(&Log{}).
		Select(bucketExpr+" AS bucket, COALESCE(SUM(prompt_tokens), 0) AS input_tokens, COALESCE(SUM(completion_tokens), 0) AS output_tokens, COALESCE(SUM(CASE WHEN "+cacheCreation+" > 0 THEN "+cacheCreation+" ELSE "+cacheCreationFallback+" END), 0) AS cache_creation_tokens, COALESCE(SUM("+cacheRead+"), 0) AS cache_read_tokens", interval, interval).
		Where("user_id = ? AND type = ? AND created_at >= ? AND created_at <= ?", userID, LogTypeConsume, startTime, endTime).
		Group("bucket").
		Order("bucket ASC").
		Find(&rows).Error
	return rows, err
}
