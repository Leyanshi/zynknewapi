import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

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
}

export interface CatfkCatalog {
  enabled: boolean
  goods: CatfkGoods[]
  channels: { id: number; show_name: string }[]
}

export async function getCatfkCatalog(): Promise<CatfkCatalog> {
  const response = await api.get('/api/user/catfk/catalog')
  return requireServerSuccess(response.data).data
}

export async function getCatfkOrders(): Promise<CatfkOrder[]> {
  const response = await api.get('/api/user/catfk/orders')
  return requireServerSuccess(response.data).data
}

export async function createCatfkOrder(request: {
  goods_key: string
  channel_id: number
}): Promise<CatfkOrder> {
  const response = await api.post('/api/user/catfk/orders', request)
  return requireServerSuccess(response.data).data
}
