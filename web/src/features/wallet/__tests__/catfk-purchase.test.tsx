import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import en from '@/i18n/locales/en.json'
import { api } from '@/lib/api'

import type { CatfkOrder } from '../catfk-api'
import { CatfkShop } from '../components/catfk-shop'

const i18n = createInstance()
const key = ['wallet', 'catfk', 'orders']
const order: CatfkOrder = {
  id: 'order-one',
  name: 'Wallet credit',
  trade_no: 'CATremote-one',
  pay_url: 'https://catfk.com/shopApi/Pay/payment?trade_no=remote-one',
  status: 'pending',
  quota: 0,
  cards: [],
  instructions: '',
  query_password: 'per-order-query-credential',
  created_time: Math.floor(Date.now() / 1000),
}

beforeEach(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en },
    nsSeparator: false,
    interpolation: { escapeValue: false },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  focusManager.setFocused(undefined)
})

function setup(
  options: {
    blocked?: boolean
    empty?: boolean
    fail?: boolean
    orders?: (typeof order)[]
    ordersResponse?: Promise<CatfkOrder[]>
    syncOrders?: (typeof order)[]
    syncFail?: boolean
    directFail?: boolean
  } = {}
) {
  const popup = {
    opener: {},
    closed: false,
    close: vi.fn(),
    location: { replace: vi.fn() },
  }
  vi.spyOn(window, 'open').mockReturnValue(
    options.blocked ? null : (popup as unknown as Window)
  )
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (options.fail && String(url).endsWith('/catalog')) {
      throw new Error('network unavailable')
    }
    if (String(url).endsWith('/catalog')) {
      return {
        data: {
          success: true,
          data: {
            enabled: true,
            goods: options.empty
              ? []
              : [
                  {
                    goods_key: 'credit',
                    name: 'Wallet credit',
                    price: 1,
                    description: '<p>Help</p>',
                    contact_format: 'any',
                    extend: { stock_count: 5, limit_count: 1 },
                  },
                  {
                    goods_key: 'empty',
                    name: 'Sold out',
                    price: 2,
                    description: '',
                    contact_format: 'any',
                    extend: { stock_count: 0, limit_count: 1 },
                  },
                ],
            channels: [{ id: 1, show_name: 'Alipay' }],
          },
        },
      }
    }
    return {
      data: {
        success: true,
        data: options.ordersResponse
          ? await options.ordersResponse
          : (options.orders ?? []),
      },
    }
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (String(url).endsWith('/redeem')) {
      if (options.syncFail) throw new Error('sync unavailable')
      return { data: { success: true, data: options.syncOrders?.[0] ?? order } }
    }
    return { data: { success: true, data: order } }
  })
  const direct = vi.fn().mockImplementation(async () => {
    if (options.directFail) throw new TypeError('Failed to fetch')
    return {
      ok: true,
      json: async () => ({
        code: 1,
        data: {
          trade_no: order.trade_no,
          status: options.syncOrders || options.syncFail ? 1 : 0,
          quantity: 1,
          goods: { goods_key: 'credit' },
          response: { cards: ['delivered card'] },
        },
      }),
    }
  })
  vi.stubGlobal('fetch', direct)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <CatfkShop />
      </I18nextProvider>
    </QueryClientProvider>
  )
  return { client, post, popup, direct }
}

it('blocks sold-out products and does not create an order when the browser blocks the popup', async () => {
  const { post } = setup({ blocked: true })
  expect(await screen.findByRole('button', { name: /Sold out/ })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: /Wallet credit/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Buy and Pay' }))
  expect(post).not.toHaveBeenCalled()
})

it.each(['manual', 'redeemed'])(
  'closes payment immediately after server-confirmed %s completion',
  async (status) => {
    const { client, post, popup } = setup()
    fireEvent.click(
      await screen.findByRole('button', { name: /Wallet credit/ })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Buy and Pay' }))
    await waitFor(() =>
      expect(popup.location.replace).toHaveBeenCalledWith(order.pay_url)
    )
    expect(post).toHaveBeenCalledWith('/api/user/catfk/orders', {
      goods_key: 'credit',
      channel_id: 1,
    })
    expect(popup.opener).toBeNull()
    act(() => client.setQueryData(key, [order]))
    expect(popup.close).not.toHaveBeenCalled()
    vi.useFakeTimers()
    try {
      act(() =>
        client.setQueryData(key, [
          {
            ...order,
            status,
            cards: ['original delivered card'],
            instructions: '<p>Use this card elsewhere</p>',
          },
        ])
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(popup.close).toHaveBeenCalledOnce()
      if (status === 'manual') {
        expect(screen.getByText('original delivered card')).toBeVisible()
        expect(
          screen.getByRole('button', { name: 'Copy to clipboard' })
        ).toBeVisible()
        expect(screen.getByText('Use this card elsewhere')).toBeVisible()
      }
    } finally {
      vi.useRealTimers()
    }
  }
)

it('hides a dismissed order from the shop list', async () => {
  const { client } = setup({
    orders: [
      { ...order, created_time: Math.floor(Date.now() / 1000) },
      {
        ...order,
        id: 'old-order',
        trade_no: 'old-trade-no',
        created_time: Math.floor(Date.now() / 1000) - 24 * 60 * 60,
      },
    ],
  })
  fireEvent.click(await screen.findByRole('button', { name: /Wallet credit/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Buy and Pay' }))
  await waitFor(() =>
    expect(window.open).toHaveBeenCalledWith(
      '',
      '_blank',
      'popup,width=960,height=760'
    )
  )
  await waitFor(() =>
    expect(client.getQueryData(key)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ trade_no: order.trade_no }),
      ])
    )
  )
  await waitFor(() => expect(screen.getByText(/remote-one/)).toBeVisible())
  expect(screen.queryByText(/old-trade-no/)).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

  expect(screen.queryByText(/remote-one/)).not.toBeInTheDocument()
})

it('renders an empty state when the shop has no products', async () => {
  setup({ empty: true })
  expect(await screen.findByText('No Data')).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Buy and Pay' })
  ).not.toBeInTheDocument()
})

it('offers retry when the shop catalog request fails', async () => {
  setup({ fail: true })
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeVisible()
})

it.each(['manual', 'redeemed'] as const)(
  'submits browser-delivered cards and closes the popup after local %s confirmation',
  async (status) => {
    const { post, popup } = setup({
      syncOrders: [{ ...order, status, cards: ['delivered card'] }],
    })
    fireEvent.click(
      await screen.findByRole('button', { name: /Wallet credit/ })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Buy and Pay' }))

    await waitFor(() => expect(popup.close).toHaveBeenCalledOnce())
    expect(post).toHaveBeenCalledWith(
      '/api/user/catfk/orders/order-one/redeem',
      {
        cards: ['delivered card'],
        instructions: '',
      }
    )
    expect(screen.getByRole('button', { name: 'Buy and Pay' })).toBeEnabled()
    if (status === 'redeemed') {
      expect(screen.queryByText('delivered card')).not.toBeInTheDocument()
    }
  }
)

it('does not sync idle history and displays the branded order number', async () => {
  const { post } = setup({ orders: [order] })
  expect(await screen.findByText(/ZYNKremote-one/)).toBeVisible()
  expect(screen.queryByText(/CATremote-one/)).not.toBeInTheDocument()
  expect(post).not.toHaveBeenCalled()
})

it('keeps the new payment available when an older order-list request finishes late', async () => {
  let resolveOrders!: (orders: CatfkOrder[]) => void
  const ordersResponse = new Promise<CatfkOrder[]>((resolve) => {
    resolveOrders = resolve
  })
  const { client, popup } = setup({ ordersResponse })
  fireEvent.click(await screen.findByRole('button', { name: /Wallet credit/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Buy and Pay' }))
  await waitFor(() =>
    expect(popup.location.replace).toHaveBeenCalledWith(order.pay_url)
  )

  await act(async () => {
    resolveOrders([])
    await ordersResponse
  })
  expect(screen.getByText(/ZYNKremote-one/)).toBeVisible()

  await act(async () => {
    client.setQueryData(key, [{ ...order, status: 'redeemed' }])
  })
  await waitFor(() => expect(popup.close).toHaveBeenCalledOnce())
})

it('keeps an unconfirmed payment open when sync fails and allows retry', async () => {
  const { post, popup } = setup({ syncFail: true })
  fireEvent.click(await screen.findByRole('button', { name: /Wallet credit/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Buy and Pay' }))
  const retry = await screen.findByRole('button', { name: 'Retry' })
  expect(popup.close).not.toHaveBeenCalled()
  post.mockResolvedValue({
    data: { success: true, data: { ...order, status: 'redeemed' } },
  })
  fireEvent.click(retry)
  await waitFor(() => expect(popup.close).toHaveBeenCalledOnce())
})

it('does not close or credit the payment when only the browser reports paid', async () => {
  const { post, popup } = setup({ syncOrders: [order] })
  fireEvent.click(await screen.findByRole('button', { name: /Wallet credit/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Buy and Pay' }))
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/api/user/catfk/orders/order-one/redeem',
      expect.anything()
    )
  )
  expect(popup.close).not.toHaveBeenCalled()
  expect(screen.getByText('Waiting for payment or card delivery')).toBeVisible()
})

it('resumes an existing order without creating another order and closes after server confirmation', async () => {
  const { post, popup } = setup({
    orders: [order],
    syncOrders: [{ ...order, status: 'redeemed' }],
  })
  fireEvent.click(
    await screen.findByRole('button', { name: 'Continue Payment' })
  )
  await waitFor(() => expect(popup.close).toHaveBeenCalledOnce())
  expect(post).not.toHaveBeenCalledWith(
    '/api/user/catfk/orders',
    expect.anything()
  )
  expect(window.open).toHaveBeenCalledWith(
    order.pay_url,
    '_blank',
    'popup,width=960,height=760'
  )
})

it('polls CatFK directly behind the popup, redeems locally, then stops polling', async () => {
  const { direct, post, popup } = setup()
  fireEvent.click(await screen.findByRole('button', { name: /Wallet credit/ }))
  vi.useFakeTimers()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Buy and Pay' }))
    await vi.advanceTimersByTimeAsync(0)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(direct).toHaveBeenCalledOnce()
  expect(direct).toHaveBeenCalledWith(
    'https://catfk.com/shopApi/Order/info',
    expect.objectContaining({
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Visitorid: order.id },
      body: JSON.stringify({
        trade_no: order.trade_no,
        query_password: order.query_password,
        dump: 1,
      }),
    })
  )
  expect(post).toHaveBeenCalledTimes(1)
  expect(popup.close).not.toHaveBeenCalled()
  focusManager.setFocused(false)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(direct).toHaveBeenCalledTimes(2)
  expect(post).toHaveBeenCalledTimes(1)
  direct.mockResolvedValue({
    ok: true,
    json: async () => ({
      code: 1,
      data: {
        trade_no: order.trade_no,
        status: 1,
        quantity: 1,
        goods: { goods_key: 'credit' },
        response: { cards: ['delivered card'] },
      },
    }),
  })
  post.mockResolvedValue({
    data: {
      success: true,
      data: { ...order, status: 'redeemed', quota: 100 },
    },
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(popup.close).toHaveBeenCalledOnce()
  expect(post).toHaveBeenCalledWith(
    '/api/user/catfk/orders/order-one/redeem',
    expect.anything()
  )
  const calls = direct.mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(direct).toHaveBeenCalledTimes(calls)
})

it('retries only from the browser once a minute when direct requests are blocked', async () => {
  const { direct, post, popup } = setup({ directFail: true })
  fireEvent.click(await screen.findByRole('button', { name: /Wallet credit/ }))
  vi.useFakeTimers()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Buy and Pay' }))
    await vi.advanceTimersByTimeAsync(0)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(post).toHaveBeenCalledTimes(1)
  expect(popup.close).not.toHaveBeenCalled()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(direct).toHaveBeenCalledOnce()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(direct).toHaveBeenCalledTimes(2)
  expect(post).toHaveBeenCalledTimes(1)
  expect(popup.close).not.toHaveBeenCalled()
})
