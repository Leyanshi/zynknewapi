/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { useQuery } from '@tanstack/react-query'
import { VChart } from '@visactor/react-vchart'
import { Activity, PieChart, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { IconBadge } from '@/components/ui/icon-badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  getFlowQuotaDates,
  getUserDashboardTokenTrend,
  getUserQuotaDates,
} from '@/features/dashboard/api'
import { getDefaultDays } from '@/features/dashboard/lib'
import { getDashboardChartColors } from '@/features/dashboard/lib/charts'
import type {
  DashboardTokenTrendItem,
  DashboardFilters,
  FlowQuotaDataItem,
  QuotaDataItem,
} from '@/features/dashboard/types'
import { useChartTheme } from '@/lib/use-chart-theme'
import { formatNumber, formatQuota } from '@/lib/format'
import { computeTimeRange, formatChartTime } from '@/lib/time'
import { requireServerSuccess } from '@/lib/server-error-message'

type UsageMetric = 'tokens' | 'quota'
type TimeGranularity = 'hour' | 'day' | 'week'
type DistributionValue = { name: string; value: number }

function aggregateDistribution(
  rows: Array<QuotaDataItem | FlowQuotaDataItem>,
  nameOf: (row: QuotaDataItem | FlowQuotaDataItem) => string,
  metric: UsageMetric
): DistributionValue[] {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const name = nameOf(row).trim() || 'Unknown'
    const value = Number(metric === 'tokens' ? row.token_used : row.quota) || 0
    totals.set(name, (totals.get(name) ?? 0) + value)
  }
  return [...totals].map(([name, value]) => ({ name, value }))
}

function pieSpec(
  values: DistributionValue[],
  metric: UsageMetric,
  emptyLabel: string,
  otherLabel: string
) {
  const usableValues = values.filter((item) => item.value > 0)
  const orderedValues = [...usableValues].sort((a, b) => b.value - a.value)
  const visibleValues = orderedValues.slice(0, 11)
  const overflow = orderedValues.slice(11)
  if (overflow.length > 0) {
    visibleValues.push({
      name: otherLabel,
      value: overflow.reduce((total, item) => total + item.value, 0),
    })
  }
  return {
    type: 'pie',
    data: [{ id: 'usage', values: visibleValues }],
    valueField: 'value',
    categoryField: 'name',
    outerRadius: 0.82,
    innerRadius: 0.48,
    padAngle: 0,
    legends: { visible: visibleValues.length > 0, orient: 'bottom' },
    label: { visible: false },
    title: {
      visible: usableValues.length === 0,
      text: emptyLabel,
    },
    color: {
      type: 'ordinal',
      domain: visibleValues.map((item) => item.name),
      range: getDashboardChartColors(visibleValues.length),
    },
    tooltip: {
      mark: {
        content: [
          {
            key: (datum: Record<string, unknown>) => datum?.name,
            value: (datum: Record<string, unknown>) => {
              const value = Number(datum?.value) || 0
              return metric === 'quota'
                ? formatQuota(value)
                : formatNumber(value)
            },
          },
        ],
      },
    },
  }
}

function tokenTrendSpec(
  rows: DashboardTokenTrendItem[],
  granularity: TimeGranularity,
  labels: {
    input: string
    output: string
    cacheCreation: string
    cacheHit: string
    cacheHitRate: string
    tokens: string
    empty: string
  }
) {
  const values = rows.flatMap((row) => {
    const time = formatChartTime(row.bucket, granularity)
    const series = [
      [labels.input, row.input_tokens],
      [labels.output, row.output_tokens],
      [labels.cacheCreation, row.cache_creation_tokens],
      [labels.cacheHit, row.cache_read_tokens],
    ] as const
    return series.map(([name, value]) => ({
      time,
      series: name,
      value: Number(value) || 0,
    }))
  })
  const hitRateValues = rows.map((row) => {
    const input = Number(row.input_tokens) || 0
    const cacheHit = Number(row.cache_read_tokens) || 0
    return {
      time: formatChartTime(row.bucket, granularity),
      series: labels.cacheHitRate,
      value: input > 0 ? (cacheHit / input) * 100 : 0,
    }
  })
  const colors = getDashboardChartColors(5)
  return {
    type: 'line',
    data: [{ id: 'token-usage', values: [...values, ...hitRateValues] }],
    xField: 'time',
    yField: 'value',
    seriesField: 'series',
    legends: { visible: rows.length > 0, orient: 'bottom' },
    point: { visible: false },
    line: { style: { curveType: 'monotone' } },
    axes: [
      {
        orient: 'left',
        type: 'linear',
        seriesId: [
          labels.input,
          labels.output,
          labels.cacheCreation,
          labels.cacheHit,
        ],
        title: { visible: true, text: labels.tokens },
      },
      {
        orient: 'right',
        type: 'linear',
        seriesId: [labels.cacheHitRate],
        min: 0,
        max: 100,
        title: { visible: true, text: `${labels.cacheHitRate} (%)` },
      },
      { orient: 'bottom', type: 'band', label: { visible: true } },
    ],
    color: {
      type: 'ordinal',
      domain: [
        labels.input,
        labels.output,
        labels.cacheCreation,
        labels.cacheHit,
        labels.cacheHitRate,
      ],
      range: colors,
    },
    title: {
      visible: values.length === 0,
      text: labels.empty,
    },
    tooltip: { mark: { content: [] } },
  }
}

function DistributionPanel(props: {
  title: string
  values: DistributionValue[]
  metric: UsageMetric
  loading: boolean
  emptyLabel: string
  otherLabel: string
  resolvedTheme: 'light' | 'dark'
}) {
  const spec = useMemo(
    () =>
      pieSpec(
        props.values,
        props.metric,
        props.emptyLabel,
        props.otherLabel
      ),
    [props.emptyLabel, props.metric, props.otherLabel, props.values]
  )
  return (
    <div className='min-w-0 overflow-hidden rounded-lg border'>
      <div className='flex items-center gap-2 border-b px-4 py-3'>
        <IconBadge tone='chart-2' size='sm'>
          <PieChart />
        </IconBadge>
        <h3 className='text-sm font-semibold'>{props.title}</h3>
      </div>
      <div className='h-72 p-2'>
        {!props.loading && (
          <VChart
            key={`${props.title}-${props.resolvedTheme}-${props.values.length}`}
            spec={{
              ...spec,
              theme: props.resolvedTheme,
              background: 'transparent',
            }}
          />
        )}
      </div>
    </div>
  )
}

export function UsageAnalytics(props: { filters?: DashboardFilters }) {
  const { t } = useTranslation()
  const { resolvedTheme, themeReady } = useChartTheme()
  const granularity = props.filters?.time_granularity ?? 'hour'
  const [metric, setMetric] = useState<UsageMetric>('tokens')
  const timeRange = useMemo(
    () =>
      computeTimeRange(
        getDefaultDays(granularity),
        props.filters?.start_timestamp,
        props.filters?.end_timestamp
      ),
    [props.filters?.end_timestamp, props.filters?.start_timestamp, granularity]
  )
  const queryParams = useMemo(
    () => ({
      ...timeRange,
      default_time: granularity,
      granularity,
    }),
    [granularity, timeRange]
  )

  const modelQuery = useQuery({
    queryKey: ['dashboard', 'overview', 'model-distribution', queryParams],
    queryFn: async () =>
      requireServerSuccess(
        await getUserQuotaDates(queryParams, false)
      ).data ?? [],
    staleTime: 60_000,
  })
  const groupQuery = useQuery({
    queryKey: ['dashboard', 'overview', 'group-distribution', queryParams],
    queryFn: async () =>
      requireServerSuccess(
        await getFlowQuotaDates(
          {
            start_timestamp: timeRange.start_timestamp,
            end_timestamp: timeRange.end_timestamp,
            default_time: granularity,
          },
          false
        )
      ).data ?? [],
    staleTime: 60_000,
  })
  const trendQuery = useQuery({
    queryKey: ['dashboard', 'overview', 'token-trend', queryParams],
    queryFn: async () =>
      requireServerSuccess(await getUserDashboardTokenTrend(queryParams)).data ?? [],
    staleTime: 60_000,
  })

  const modelValues = useMemo(
    () =>
      aggregateDistribution(
        modelQuery.data ?? [],
        (row) => (row as QuotaDataItem).model_name ?? '',
        metric
      ),
    [metric, modelQuery.data]
  )
  const groupValues = useMemo(
    () =>
      aggregateDistribution(
        groupQuery.data ?? [],
        (row) => (row as FlowQuotaDataItem).use_group ?? '',
        metric
      ),
    [groupQuery.data, metric]
  )
  const trendSpec = useMemo(
    () =>
      tokenTrendSpec(
        trendQuery.data ?? [],
        granularity,
        {
          input: t('Input'),
          output: t('Output'),
          cacheCreation: t('Cache Creation'),
          cacheHit: t('Cache Hit'),
          cacheHitRate: t('Cache Hit Rate'),
          tokens: t('Tokens'),
          empty: t('No data available'),
        }
      ),
    [granularity, t, trendQuery.data]
  )

  return (
    <section className='space-y-3 sm:space-y-4' aria-label={t('Usage analytics')}>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='flex items-center gap-2'>
          <IconBadge tone='chart-1' size='sm'>
            <Activity />
          </IconBadge>
          <h2 className='text-base font-semibold'>{t('Usage analytics')}</h2>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <Tabs
            value={metric}
            onValueChange={(value) => setMetric(value as UsageMetric)}
          >
            <TabsList>
              <TabsTrigger value='tokens'>{t('By tokens')}</TabsTrigger>
              <TabsTrigger value='quota'>{t('By actual usage')}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div className='grid grid-cols-1 gap-3 lg:grid-cols-2'>
        <DistributionPanel
          title={t('Model usage distribution')}
          values={modelValues}
          metric={metric}
          loading={modelQuery.isLoading || !themeReady}
          emptyLabel={t('No data available')}
          otherLabel={t('Other')}
          resolvedTheme={resolvedTheme === 'dark' ? 'dark' : 'light'}
        />
        <DistributionPanel
          title={t('Group usage distribution')}
          values={groupValues}
          metric={metric}
          loading={groupQuery.isLoading || !themeReady}
          emptyLabel={t('No data available')}
          otherLabel={t('Other')}
          resolvedTheme={resolvedTheme === 'dark' ? 'dark' : 'light'}
        />
      </div>

      <div className='overflow-hidden rounded-lg border'>
        <div className='flex items-center gap-2 border-b px-4 py-3'>
          <IconBadge tone='chart-3' size='sm'>
            <Activity />
          </IconBadge>
          <h3 className='text-sm font-semibold'>{t('Token usage trend')}</h3>
        </div>
        <div className='h-80 p-2 sm:h-96'>
          {themeReady && !trendQuery.isLoading && (
            <VChart
              key={`token-trend-${granularity}-${trendQuery.data?.length ?? 0}-${resolvedTheme}`}
              spec={{
                ...trendSpec,
                theme: resolvedTheme === 'dark' ? 'dark' : 'light',
                background: 'transparent',
              }}
            />
          )}
        </div>
        {trendQuery.isError && (
          <p className='text-muted-foreground flex items-center gap-2 border-t px-4 py-2 text-xs'>
            <RefreshCw className='size-3.5' aria-hidden='true' />
            {t('Unable to load usage analytics')}
          </p>
        )}
      </div>
    </section>
  )
}
