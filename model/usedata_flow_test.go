package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func seedFlowQuotaData(t *testing.T, quotaData QuotaData) {
	t.Helper()
	require.NoError(t, DB.Create(&quotaData).Error)
}

func seedFlowLookupData(t *testing.T) {
	t.Helper()
	require.NoError(t, DB.Create(&Channel{Id: 1, Name: "east"}).Error)
	require.NoError(t, DB.Create(&Channel{Id: 2, Name: "west"}).Error)
	require.NoError(t, DB.Create(&Token{Id: 11, UserId: 1, Key: "sk-primary", Name: "primary"}).Error)
	require.NoError(t, DB.Create(&Token{Id: 22, UserId: 2, Key: "sk-backup", Name: "backup"}).Error)
	require.NoError(t, DB.Delete(&Token{Id: 11}).Error)
}

func TestGetFlowQuotaDataUsesQuotaDataRoleSpecificDimensions(t *testing.T) {
	truncateTables(t)
	seedFlowLookupData(t)

	seedFlowQuotaData(t, QuotaData{
		UserID:    1,
		Username:  "alice",
		NodeName:  "node-a",
		TokenID:   11,
		UseGroup:  "vip",
		ModelName: "gpt-a",
		ChannelID: 1,
		CreatedAt: 1000,
		Count:     2,
		Quota:     100,
		TokenUsed: 40,
	})
	seedFlowQuotaData(t, QuotaData{
		UserID:    1,
		Username:  "alice",
		NodeName:  "node-a",
		TokenID:   11,
		UseGroup:  "vip",
		ModelName: "gpt-a",
		ChannelID: 1,
		CreatedAt: 1100,
		Count:     1,
		Quota:     50,
		TokenUsed: 20,
	})
	seedFlowQuotaData(t, QuotaData{
		UserID:    1,
		Username:  "alice",
		NodeName:  "node-a",
		TokenID:   11,
		UseGroup:  "vip",
		ModelName: "gpt-a",
		ChannelID: 2,
		CreatedAt: 1200,
		Count:     1,
		Quota:     25,
		TokenUsed: 10,
	})
	seedFlowQuotaData(t, QuotaData{
		UserID:    2,
		Username:  "bob",
		NodeName:  "node-b",
		TokenID:   22,
		UseGroup:  "default",
		ModelName: "gpt-b",
		ChannelID: 1,
		CreatedAt: 1300,
		Count:     3,
		Quota:     70,
		TokenUsed: 30,
	})
	seedFlowQuotaData(t, QuotaData{
		UserID:    1,
		Username:  "alice",
		ModelName: "legacy",
		CreatedAt: 1400,
		Count:     99,
		Quota:     999,
		TokenUsed: 999,
	})

	rootRows, err := GetFlowQuotaData(900, 2000, "", 0, common.RoleRootUser)
	require.NoError(t, err)
	require.Len(t, rootRows, 3)
	// Token 11 was soft-deleted, so its name is intentionally left empty for the
	// frontend to render a localized "deleted (id)" label instead.
	require.Equal(t, FlowQuotaData{
		UserID:      1,
		Username:    "alice",
		NodeName:    "node-a",
		TokenID:     11,
		TokenName:   "",
		UseGroup:    "vip",
		ChannelID:   1,
		ChannelName: "east",
		ModelName:   "gpt-a",
		TokenUsed:   60,
		Count:       3,
		Quota:       150,
		GroupRatio:  1,
	}, *rootRows[0])
	// A token that still exists resolves to its current name.
	require.Equal(t, 22, rootRows[1].TokenID)
	require.Equal(t, "backup", rootRows[1].TokenName)

	adminRows, err := GetFlowQuotaData(900, 2000, "alice", 0, common.RoleAdminUser)
	require.NoError(t, err)
	require.Len(t, adminRows, 2)
	require.Equal(t, 0, adminRows[0].TokenID)
	require.Empty(t, adminRows[0].TokenName)
	require.Empty(t, adminRows[0].NodeName)
	require.Equal(t, "alice", adminRows[0].Username)
	require.Equal(t, "vip", adminRows[0].UseGroup)
	require.Equal(t, "east", adminRows[0].ChannelName)
	require.Equal(t, 150, adminRows[0].Quota)
	require.Equal(t, float64(1), adminRows[0].GroupRatio)

	selfRows, err := GetFlowQuotaData(900, 2000, "", 1, common.RoleCommonUser)
	require.NoError(t, err)
	require.Len(t, selfRows, 1)
	require.Empty(t, selfRows[0].Username)
	require.Equal(t, 0, selfRows[0].ChannelID)
	require.Empty(t, selfRows[0].ChannelName)
	require.Empty(t, selfRows[0].TokenName)
	require.Equal(t, "vip", selfRows[0].UseGroup)
	require.Equal(t, 175, selfRows[0].Quota)
}

func TestGetDashboardTokenTrendAggregatesOwnedConsumeLogs(t *testing.T) {
	truncateTables(t)
	require.NoError(t, LOG_DB.Create(&[]Log{
		{
			UserId: 1, CreatedAt: 3601, Type: LogTypeConsume,
			PromptTokens: 100, CompletionTokens: 20,
			Other: `{"cache_tokens":30,"cache_creation_tokens":10}`,
		},
		{
			UserId: 1, CreatedAt: 3699, Type: LogTypeConsume,
			PromptTokens: 200, CompletionTokens: 40,
			Other: `{"cache_tokens":50,"cache_creation_tokens_5m":5,"cache_creation_tokens_1h":7}`,
		},
		{
			UserId: 2, CreatedAt: 3700, Type: LogTypeConsume,
			PromptTokens: 999, CompletionTokens: 999,
			Other: `{"cache_tokens":999,"cache_creation_tokens":999}`,
		},
		{
			UserId: 1, CreatedAt: 3700, Type: LogTypeTopup,
			PromptTokens: 999, CompletionTokens: 999,
			Other: `{"cache_tokens":999,"cache_creation_tokens":999}`,
		},
	}).Error)

	rows, err := GetDashboardTokenTrend(1, 3600, 7200, "hour")
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.EqualValues(t, 3600, rows[0].Bucket)
	require.EqualValues(t, 300, rows[0].InputTokens)
	require.EqualValues(t, 60, rows[0].OutputTokens)
	require.EqualValues(t, 22, rows[0].CacheCreation)
	require.EqualValues(t, 80, rows[0].CacheRead)
}

func TestDashboardQuotaQueriesPreserveGroupCostsAndCacheTotals(t *testing.T) {
	truncateTables(t)
	previousRatios := ratio_setting.GroupRatio2JSONString()
	t.Cleanup(func() {
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(previousRatios))
	})
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1,"vip":2}`))
	require.NoError(t, DB.Create(&User{Id: 1, Username: "dashboard-owner", Group: "default"}).Error)
	require.NoError(t, DB.Create(&[]QuotaData{
		{
			UserID: 1, Username: "dashboard-owner", ModelName: "same-model",
			UseGroup: "default", CreatedAt: 3600, Count: 1, Quota: 100,
			TokenUsed: 50, CacheReadTokens: 20, CacheCreationTokens: 5,
		},
		{
			UserID: 1, Username: "dashboard-owner", ModelName: "same-model",
			UseGroup: "default", CreatedAt: 3600, Count: 2, Quota: 200,
			TokenUsed: 100, CacheReadTokens: 40, CacheCreationTokens: 10,
		},
		{
			UserID: 1, Username: "dashboard-owner", ModelName: "same-model",
			UseGroup: "vip", CreatedAt: 3600, Count: 1, Quota: 400,
			TokenUsed: 200, CacheReadTokens: 80, CacheCreationTokens: 20,
		},
	}).Error)

	queries := map[string]func() ([]*QuotaData, error){
		"self":     func() ([]*QuotaData, error) { return GetQuotaDataByUserId(1, 3600, 7200) },
		"username": func() ([]*QuotaData, error) { return GetQuotaDataByUsername("dashboard-owner", 3600, 7200) },
		"all":      func() ([]*QuotaData, error) { return GetAllQuotaDates(3600, 7200, "") },
	}
	for name, query := range queries {
		t.Run(name, func(t *testing.T) {
			rows, err := query()
			require.NoError(t, err)
			require.Len(t, rows, 2)
			var actualCost, baseCost float64
			var cacheRead, cacheCreation int64
			for _, row := range rows {
				actualCost += float64(row.Quota)
				baseCost += float64(row.Quota) / row.GroupRatio
				cacheRead += row.CacheReadTokens
				cacheCreation += row.CacheCreationTokens
			}
			assert.Equal(t, float64(700), actualCost)
			assert.Equal(t, float64(500), baseCost)
			assert.EqualValues(t, 140, cacheRead)
			assert.EqualValues(t, 35, cacheCreation)
		})
	}
}

func TestLogQuotaDataSplitsRowsByUseGroupTokenChannelAndNode(t *testing.T) {
	truncateTables(t)
	CacheQuotaDataLock.Lock()
	CacheQuotaData = make(map[string]*QuotaData)
	CacheQuotaDataLock.Unlock()

	LogQuotaData(QuotaDataLogParams{
		UserID:    1,
		Username:  "alice",
		ModelName: "gpt-a",
		CreatedAt: 3661,
		UseGroup:  "vip",
		TokenID:   11,
		ChannelID: 1,
		NodeName:  "node-a",
		Quota:     100,
		TokenUsed: 40,
	})
	LogQuotaData(QuotaDataLogParams{
		UserID:    1,
		Username:  "alice",
		ModelName: "gpt-a",
		CreatedAt: 3700,
		UseGroup:  "vip",
		TokenID:   11,
		ChannelID: 1,
		NodeName:  "node-a",
		Quota:     50,
		TokenUsed: 20,
	})
	LogQuotaData(QuotaDataLogParams{
		UserID:    1,
		Username:  "alice",
		ModelName: "gpt-a",
		CreatedAt: 3700,
		UseGroup:  "default",
		TokenID:   11,
		ChannelID: 1,
		NodeName:  "node-a",
		Quota:     25,
		TokenUsed: 10,
	})

	SaveQuotaDataCache()

	var rows []QuotaData
	require.NoError(t, DB.Order("quota DESC").Find(&rows).Error)
	require.Len(t, rows, 2)
	require.Equal(t, int64(3600), rows[0].CreatedAt)
	require.Equal(t, "vip", rows[0].UseGroup)
	require.Equal(t, 11, rows[0].TokenID)
	require.Equal(t, 1, rows[0].ChannelID)
	require.Equal(t, "node-a", rows[0].NodeName)
	require.Equal(t, 2, rows[0].Count)
	require.Equal(t, 150, rows[0].Quota)
	require.Equal(t, 60, rows[0].TokenUsed)
	require.Equal(t, "default", rows[1].UseGroup)
	require.Equal(t, 25, rows[1].Quota)
}
