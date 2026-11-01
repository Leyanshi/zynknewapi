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
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from 'recharts'

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
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
import { toIntlLocale } from '@/i18n/languages'
import { formatCompactNumber, formatNumber, formatQuota } from '@/lib/format'
import { requireServerSuccess } from '@/lib/server-error-message'
import { computeTimeRange, formatChartTime } from '@/lib/time'
import { useChartTheme } from '@/lib/use-chart-theme'

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
    const value = metric === 'tokens' ? Number(row.token_used) || 0 : actualCost
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
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const chartId = useId().replace(/:/g, '')
  const data = useMemo(
    () =>
      props.rows.map((row) => ({
        ...row,
        cacheHitRate:
          row.input_tokens > 0
            ? (row.cache_read_tokens / row.input_tokens) * 100
            : 0,
      })),
    [props.rows]
  )
  const config = {
    input_tokens: { label: props.labels.input, color: props.colors[0] },
    output_tokens: { label: props.labels.output, color: props.colors[1] },
    cache_creation_tokens: {
      label: props.labels.cacheCreation,
      color: props.colors[2],
    },
    cache_read_tokens: { label: props.labels.cacheHit, color: props.colors[3] },
    cacheHitRate: { label: props.labels.cacheHitRate, color: '#94a3b8' },
  } satisfies ChartConfig
  const tokenKeys = [
    'input_tokens',
    'output_tokens',
    'cache_creation_tokens',
    'cache_read_tokens',
  ] as const

  if (data.length === 0) {
    return (
      <div className='text-muted-foreground flex h-full items-center justify-center text-sm'>
        {props.labels.empty}
      </div>
    )
  }

  return (
    <ChartContainer
      config={config}
      className='aspect-auto h-full w-full min-w-0'
      aria-label={t('Token usage trend')}
    >
      <ComposedChart
        data={data}
        margin={{ top: 12, right: 0, bottom: 0, left: 0 }}
      >
        <defs>
          {tokenKeys.map((key) => (
            <linearGradient
              key={key}
              id={chartId + key}
              x1='0'
              y1='0'
              x2='0'
              y2='1'
            >
              <stop
                offset='0%'
                stopColor={config[key].color}
                stopOpacity={0.2}
              />
              <stop
                offset='100%'
                stopColor={config[key].color}
                stopOpacity={0.02}
              />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid
          vertical={false}
          stroke='var(--border)'
          strokeOpacity={0.5}
        />
        <XAxis
          dataKey='bucket'
          axisLine={false}
          tickLine={false}
          minTickGap={32}
          tickMargin={10}
          tickFormatter={(bucket) =>
            formatChartTime(Number(bucket), props.granularity)
          }
        />
        <YAxis
          yAxisId='tokens'
          axisLine={false}
          tickLine={false}
          width={56}
          domain={[0, 'auto']}
          tickFormatter={(value) => formatCompactNumber(Number(value), locale)}
        />
        <YAxis
          yAxisId='rate'
          orientation='right'
          axisLine={false}
          tickLine={false}
          width={44}
          domain={[0, 100]}
          ticks={[0, 25, 50, 75, 100]}
          tickFormatter={(value) => formatNumber(Number(value), locale) + '%'}
        />
        <ChartTooltip
          isAnimationActive={false}
          content={
            <ChartTooltipContent
              className='min-w-52'
              labelFormatter={(_label, payload) =>
                formatChartTime(
                  Number(payload[0]?.payload.bucket),
                  props.granularity
                )
              }
              formatter={(value, name, item) => (
                <>
                  <span
                    className='size-2.5 shrink-0 rounded-sm'
                    style={{ backgroundColor: item.color }}
                  />
                  <span className='text-muted-foreground flex-1'>
                    {config[String(name) as keyof typeof config]?.label ??
                      String(name)}
                  </span>
                  <span className='font-mono font-medium tabular-nums'>
                    {name === 'cacheHitRate'
                      ? formatNumber(Number(Number(value).toFixed(2)), locale) +
                        '%'
                      : formatNumber(Number(value), locale)}
                  </span>
                </>
              )}
            />
          }
        />
        <ChartLegend
          content={<ChartLegendContent className='flex-wrap gap-x-4 gap-y-1' />}
        />
        {tokenKeys.map((key) => (
          <Area
            key={key}
            yAxisId='tokens'
            type='monotone'
            dataKey={key}
            stroke={config[key].color}
            strokeWidth={2}
            fill={'url(#' + chartId + key + ')'}
            dot={data.length === 1 ? { r: 3 } : false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        ))}
        <Line
          yAxisId='rate'
          type='monotone'
          dataKey='cacheHitRate'
          stroke={config.cacheHitRate.color}
          strokeWidth={2}
          dot={data.length === 1 ? { r: 3 } : false}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ChartContainer>
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
      pieSpec(props.values, props.metric, props.emptyLabel, props.otherLabel),
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
            <div
              key={row.name}
              className='grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 py-1.5 text-xs'
            >
              <span className='truncate' title={row.name}>
                {row.name}
              </span>
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
      requireServerSuccess(await getUserQuotaDates(queryParams, false)).data ??
      [],
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
      requireServerSuccess(await getUserDashboardTokenTrend(queryParams))
        .data ?? [],
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
    <section
      className='space-y-3 sm:space-y-4'
      aria-label={t('Usage analytics')}
    >
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
