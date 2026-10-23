import { t } from 'i18next'

import { api } from '@/lib/api'
import {
  createServerError,
  requireServerSuccess,
} from '@/lib/server-error-message'

export interface CatfkGoods {
  goods_key: string
  name: string
  price: number
  description: string
  contact_format: string
  extend: { stock_count: number; limit_count: number }
}

export interface CatfkOrder {
  id: string
  name: string
  trade_no: string
  pay_url: string
  status: 'pending' | 'redeemed' | 'manual'
  quota: number
  cards: string[]
  instructions: string
  created_time: number
  query_password?: string
  goods_key?: string
}

export interface CatfkCatalog {
  enabled: boolean
  shop_token?: string
  goods: CatfkGoods[]
  channels: { id: number; show_name: string }[]
}

export async function getCatfkCatalog(): Promise<CatfkCatalog> {
  const response = await api.get('/api/user/catfk/catalog')
  const config: CatfkCatalog = requireServerSuccess(response.data).data
  if (!config.enabled) return { ...config, goods: [], channels: [] }
  // Old gateways may still return their cached catalog during a rolling deploy.
  if (!config.shop_token) return config
  const [goods, channels] = await Promise.all([
    (async () => {
      const items: CatfkGoods[] = []
      for (let current = 1; current <= 10; current++) {
        const page = await catfkRequest<{ list: CatfkGoods[] }>(
          'Shop/goodsList',
          'new-api-catalog',
          {
            token: config.shop_token,
            goods_type: 'card',
            current,
            pageSize: 100,
          }
        )
        items.push(...page.list)
        if (page.list.length < 100) break
      }
      return items
    })(),
    catfkRequest<CatfkCatalog['channels']>(
      'Shop/getUserChannel',
      'new-api-catalog',
      { token: config.shop_token }
    ),
  ])
  return { enabled: true, goods, channels }
}

export async function getCatfkOrders(): Promise<CatfkOrder[]> {
  const response = await api.get('/api/user/catfk/orders')
  return requireServerSuccess(response.data).data
}

// Display branding must never change the upstream order identifier or pay URL.
export function formatCatfkTradeNo(tradeNo: string): string {
  return tradeNo.replace(/^CAT/, 'ZYNK')
}

async function catfkRequest<T>(
  endpoint:
    | 'Shop/goodsList'
    | 'Shop/getUserChannel'
    | 'Pay/order'
    | 'Order/info',
  visitor: string,
  body: unknown,
  signal?: AbortSignal
): Promise<T> {
  const timeout = AbortSignal.timeout(20_000)
  const response = await fetch(`https://catfk.com/shopApi/${endpoint}`, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'Content-Type': 'application/json', Visitorid: visitor },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw createServerError(
      { status: response.status },
      t('Something went wrong!')
    )
  }
  const result = (await response.json()) as {
    code: number
    data: T
    msg?: string
  }
  if (result.code !== 1 || result.data == null) {
    throw createServerError({ message: result.msg }, t('Something went wrong!'))
  }
  return result.data
}

export interface CatfkDelivery {
  cards: string[]
  instructions: string
}

export async function getCatfkPaymentStatus(
  order: CatfkOrder,
  signal: AbortSignal
): Promise<CatfkDelivery | null> {
  if (!order.query_password) {
    throw createServerError({}, t('Something went wrong!'))
  }
  const result = await catfkRequest<{
    trade_no: string
    status: number
    quantity: number
    goods: { goods_key: string; extend?: { instructions?: string } }
    response?: { cards?: string[] }
  }>(
    'Order/info',
    order.id,
    { trade_no: order.trade_no, query_password: order.query_password, dump: 1 },
    signal
  )
  if (result.status !== 1) return null
  if (
    result.trade_no !== order.trade_no ||
    result.quantity !== 1 ||
    (order.goods_key && result.goods?.goods_key !== order.goods_key)
  ) {
    throw createServerError({}, t('Something went wrong!'))
  }
  if (!result.response?.cards?.length) return null
  return {
    cards: result.response.cards,
    instructions: result.goods?.extend?.instructions || order.instructions,
  }
}

export async function redeemCatfkOrder(
  id: string,
  delivery: CatfkDelivery
): Promise<CatfkOrder> {
  const response = await api.post(
    `/api/user/catfk/orders/${encodeURIComponent(id)}/redeem`,
    delivery
  )
  return requireServerSuccess(response.data).data
}

export async function createCatfkOrder(request: {
  goods_key: string
  channel_id: number
  name?: string
  instructions?: string
}): Promise<CatfkOrder> {
  const response = await api.post('/api/user/catfk/orders', {
    goods_key: request.goods_key,
    channel_id: request.channel_id,
  })
  const draft: { id: string; status: string; query_password: string } =
    requireServerSuccess(response.data).data
  // Compatibility with the previously deployed server-created checkout.
  if (draft.status !== 'creating') {
    return requireServerSuccess(response.data).data
  }
  const remote = await catfkRequest<{ trade_no: string; payurl: string }>(
    'Pay/order',
    draft.id,
    {
      goods_key: request.goods_key,
      quantity: 1,
      channel_id: request.channel_id,
      contact: draft.id,
      query_password: draft.query_password,
      coupon_code: '',
      select_cards_ids: [],
      extend: {},
    }
  )
  const payURL = new URL(remote.payurl)
  if (
    payURL.origin !== 'https://catfk.com' ||
    payURL.username ||
    payURL.password ||
    payURL.pathname !== '/shopApi/Pay/payment' ||
    !remote.trade_no ||
    payURL.searchParams.get('trade_no') !== remote.trade_no
  ) {
    throw createServerError({}, t('Something went wrong!'))
  }
  const bound = await api.post(
    `/api/user/catfk/orders/${encodeURIComponent(draft.id)}/bind`,
    {
      trade_no: remote.trade_no,
      pay_url: remote.payurl,
      name: request.name,
      instructions: request.instructions,
    }
  )
  return requireServerSuccess(bound.data).data
}
