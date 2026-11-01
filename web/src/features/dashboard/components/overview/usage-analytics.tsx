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
type DistributionValue = {
  name: string
  value: number
  cost: number
  actualCost: number
}

function aggregateDistribution(
  rows: Array<QuotaDataItem | FlowQuotaDataItem>,
  nameOf: (row: QuotaDataItem | FlowQuotaDataItem) => string,
  metric: UsageMetric
): DistributionValue[] {
  const totals = new Map<string, DistributionValue>()
  for (const row of rows) {
    const name = nameOf(row).trim() || 'Unknown'
    const actualCost = Number(row.quota) || 0
    const groupRatio = Number(row.group_ratio) > 0 ? Number(row.group_ratio) : 1
    const cost = actualCost / groupRatio
    const value = metric === 'tokens'
      ? Number(row.token_used) || 0
      : actualCost
    const previous = totals.get(name) ?? {
      name,
      value: 0,
      cost: 0,
      actualCost: 0,
    }
    totals.set(name, {
      name,
      value: previous.value + value,
      cost: previous.cost + cost,
      actualCost: previous.actualCost + actualCost,
    })
  }
  return [...totals.values()]
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
      cost: overflow.reduce((total, item) => total + item.cost, 0),
      actualCost: overflow.reduce((total, item) => total + item.actualCost, 0),
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
              if (metric === 'quota') return formatQuota(value)
              return formatNumber(value)
            },
          },
        ],
      },
    },
  }
}

function buildSmoothPath(
  values: number[],
  width: number,
  height: number,
  maxValue: number
): string {
  if (values.length === 0) return ''
  const points = values.map((value, index) => ({
    x: values.length === 1 ? width / 2 : (index / (values.length - 1)) * width,
    y: height - (Math.max(0, value) / maxValue) * height,
  }))
  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`
  }
  return points
    .map((point, index) => {
      if (index === 0) return `M ${point.x} ${point.y}`
      const previous = points[index - 1]
      const midpoint = (previous.x + point.x) / 2
      return `C ${midpoint} ${previous.y}, ${midpoint} ${point.y}, ${point.x} ${point.y}`
    })
    .join(' ')
}

function TokenTrendChart(props: {
  rows: DashboardTokenTrendItem[]
  labels: {
    input: string
    output: string
    cacheCreation: string
    cacheHit: string
    cacheHitRate: string
    empty: string
  }
  granularity: TimeGranularity
  colors: string[]
}) {
  const width = 760
  const height = 260
  const rows = props.rows
  if (rows.length === 0) {
    return <div className='text-muted-foreground flex h-full items-center justify-center text-sm'>{props.labels.empty}</div>
  }
  const tokenSeries = [
    {
      name: props.labels.input,
      values: rows.map((row) => Number(row.input_tokens) || 0),
    },
    {
      name: props.labels.output,
      values: rows.map((row) => Number(row.output_tokens) || 0),
    },
    {
      name: props.labels.cacheCreation,
      values: rows.map((row) => Number(row.cache_creation_tokens) || 0),
    },
    {
      name: props.labels.cacheHit,
      values: rows.map((row) => Number(row.cache_read_tokens) || 0),
    },
  ]
  const hitRate = rows.map((row) => {
    const input = Number(row.input_tokens) || 0
    const cacheHit = Number(row.cache_read_tokens) || 0
    return input > 0 ? (cacheHit / input) * 100 : 0
  })
  const tokenMax = Math.max(
    ...tokenSeries.flatMap((series) => series.values),
    1
  )
  const chartSeries = [
    ...tokenSeries,
    { name: props.labels.cacheHitRate, values: hitRate },
  ]
  const chartColors = [...props.colors, '#94a3b8']
  const gradientIds = chartSeries.map((_, index) => `usage-area-${index}`)
  const xLabels = rows.map((row) => formatChartTime(row.bucket, props.granularity))
  const visibleXLabelIndices = new Set(
    xLabels.map((_, index) => index).filter(
      (index) =>
        index === 0 ||
        index === xLabels.length - 1 ||
        index % 2 === 0
    )
  )

  return (
    <div className='flex h-full min-w-0 flex-col'>
      <div className='min-h-0 flex-1'>
        <svg
          viewBox={`0 0 ${width} ${height + 24}`}
          className='h-full w-full'
          role='img'
          aria-label={props.labels.empty}
        >
          <defs>
            {chartSeries.map((series, index) => (
              <linearGradient
                key={series.name}
                id={gradientIds[index]}
                x1='0'
                x2='0'
                y1='0'
                y2='1'
              >
                <stop offset='0%' stopColor={chartColors[index]} stopOpacity='0.2' />
                <stop offset='100%' stopColor={chartColors[index]} stopOpacity='0' />
              </linearGradient>
            ))}
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = height - ratio * height
            return (
              <line
                key={ratio}
                x1='0'
                x2={width}
                y1={y}
                y2={y}
                stroke='currentColor'
                strokeOpacity='0.12'
              />
            )
          })}
          {chartSeries.map((series, index) => {
            const maxValue = index === chartSeries.length - 1 ? 100 : tokenMax
            const path = buildSmoothPath(series.values, width, height, maxValue)
            const areaPath = `${path} L ${width} ${height} L 0 ${height} Z`
            return (
              <g key={series.name}>
                <path d={areaPath} fill={`url(#${gradientIds[index]})`} />
                <path
                  d={path}
                  fill='none'
                  stroke={chartColors[index]}
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2'
                />
              </g>
            )
          })}
          {xLabels.map((label, index) => {
            if (!visibleXLabelIndices.has(index)) return null
            const x = xLabels.length === 1 ? width / 2 : (index / (xLabels.length - 1)) * width
            let textAnchor: 'start' | 'middle' | 'end' = 'middle'
            if (index === 0) textAnchor = 'start'
            else if (index === xLabels.length - 1) textAnchor = 'end'
            return (
              <text
                key={label}
                x={x}
                y={height + 17}
                fill='currentColor'
                fillOpacity='0.55'
                fontSize='10'
                textAnchor={textAnchor}
              >
                {label}
              </text>
            )
          })}
        </svg>
      </div>
      <div className='flex flex-wrap justify-center gap-x-4 gap-y-1 px-2 pb-2 text-xs'>
        {chartSeries.map((series, index) => (
          <span key={series.name} className='text-muted-foreground inline-flex items-center gap-1.5'>
            <span className='size-2 rounded-sm' style={{ backgroundColor: chartColors[index] }} />
            {series.name}
          </span>
        ))}
      </div>
    </div>
  )
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
  const { t } = useTranslation()
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
  const rows = [...props.values].sort((a, b) => b.value - a.value)
  return (
    <div className='min-w-0 overflow-hidden rounded-lg border'>
      <div className='flex items-center gap-2 border-b px-4 py-3'>
        <IconBadge tone='chart-2' size='sm'>
          <PieChart />
        </IconBadge>
        <h3 className='text-sm font-semibold'>{props.title}</h3>
      </div>
      <div className='grid min-h-72 grid-cols-1 gap-2 p-2 sm:grid-cols-[minmax(0,1fr)_15rem]'>
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
        <div className='border-border/60 divide-border/60 min-w-0 divide-y border-t sm:border-t-0 sm:border-l sm:pl-3'>
          <div className='text-muted-foreground grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 py-1 text-[10px] font-medium'>
            <span>{t('Name')}</span>
            <span>{t('Cost')}</span>
            <span>{t('Actual Cost')}</span>
          </div>
          {rows.map((row) => (
            <div key={row.name} className='grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 py-1.5 text-xs'>
              <span className='truncate' title={row.name}>{row.name}</span>
              <span className='text-muted-foreground tabular-nums'>
                {formatQuota(row.cost)}
              </span>
              <span className='text-sky-600 tabular-nums dark:text-sky-400'>
                {formatQuota(row.actualCost)}
              </span>
            </div>
          ))}
        </div>
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
  const trendLabels = useMemo(
    () => ({
      input: t('Input'),
      output: t('Output'),
      cacheCreation: t('Cache Creation'),
      cacheHit: t('Cache Hit'),
      cacheHitRate: t('Cache Hit Rate'),
      empty: t('No data available'),
    }),
    [t]
  )
  const trendColors = getDashboardChartColors(4)

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
            <TokenTrendChart
              rows={trendQuery.data ?? []}
              labels={trendLabels}
              granularity={granularity}
              colors={trendColors}
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
