import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { createCatfkOrder, getCatfkCatalog } from '../catfk-api'

afterEach(() => vi.unstubAllGlobals())

it('loads goods and payment channels directly from CatFK using only the public shop token', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        enabled: true,
        shop_token: 'public-shop',
        goods: [],
        channels: [],
      },
    },
  })
  const direct = vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => ({
      code: 1,
      data: url.endsWith('goodsList')
        ? { list: [{ goods_key: 'credit' }] }
        : [{ id: 1, show_name: 'Alipay' }],
    }),
  }))
  vi.stubGlobal('fetch', direct)

  const catalog = await getCatfkCatalog()

  expect(catalog.goods).toEqual([{ goods_key: 'credit' }])
  expect(catalog.channels).toEqual([{ id: 1, show_name: 'Alipay' }])
  expect(direct).toHaveBeenCalledTimes(2)
  for (const [url, request] of direct.mock.calls) {
    expect(url).toMatch(/^https:\/\/catfk\.com\/shopApi\/Shop\//)
    expect(request.credentials).toBe('omit')
    expect(JSON.parse(request.body).token).toBe('public-shop')
    expect(request.headers).not.toHaveProperty('Authorization')
  }
})

it('creates the payable order in the browser and only binds its identity on the local server', async () => {
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: String(url).endsWith('/bind')
        ? {
            id: 'local-order',
            trade_no: 'CAT123',
            pay_url: 'https://catfk.com/shopApi/Pay/payment?trade_no=CAT123',
            status: 'pending',
          }
        : {
            id: 'local-order',
            query_password: 'order-query-secret',
            status: 'creating',
          },
    },
  }))
  const direct = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 1,
        data: {
          trade_no: 'CAT123',
          payurl: 'https://catfk.com/shopApi/Pay/payment?trade_no=CAT123',
        },
      }),
    })
  vi.stubGlobal('fetch', direct)

  const order = await createCatfkOrder({ goods_key: 'credit', channel_id: 1 })

  expect(order.status).toBe('pending')
  expect(direct).toHaveBeenCalledWith(
    'https://catfk.com/shopApi/Pay/order',
    expect.objectContaining({
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Visitorid: 'local-order' },
      body: expect.any(String),
    })
  )
  const body = JSON.parse(direct.mock.calls[0][1].body)
  expect(body).toMatchObject({
    goods_key: 'credit',
    channel_id: 1,
    quantity: 1,
    query_password: 'order-query-secret',
  })
  expect(post).toHaveBeenCalledWith(
    '/api/user/catfk/orders/local-order/bind',
    expect.objectContaining({ trade_no: 'CAT123' })
  )
})
