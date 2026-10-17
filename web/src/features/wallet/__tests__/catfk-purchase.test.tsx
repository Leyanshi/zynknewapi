import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeEach, expect, it, vi } from 'vitest'

import en from '@/i18n/locales/en.json'
import { api } from '@/lib/api'

import { CatfkShop } from '../components/catfk-shop'

const i18n = createInstance()
const key = ['wallet', 'catfk', 'orders']
const order = {
  id: 'order-one',
  name: 'Wallet credit',
  trade_no: 'remote-one',
  pay_url: 'https://catfk.com/shopApi/Pay/payment?trade_no=remote-one',
  status: 'pending',
  quota: 0,
  cards: [],
  instructions: '',
  created_time: 1,
}

beforeEach(async () => {
  await i18n
    .use(initReactI18next)
    .init({
      lng: 'en',
      resources: { en },
      nsSeparator: false,
      interpolation: { escapeValue: false },
    })
})

function setup(
  options: { blocked?: boolean; empty?: boolean; fail?: boolean } = {}
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
    if (options.fail && String(url).endsWith('/catalog'))
      {throw new Error('network unavailable')}
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
    return { data: { success: true, data: [] } }
  })
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true, data: order } })
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
  return { client, post, popup }
}

it('blocks sold-out products and does not create an order when the browser blocks the popup', async () => {
  const { post } = setup({ blocked: true })
  expect(await screen.findByRole('button', { name: /Sold out/ })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: /Wallet credit/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Buy and Pay' }))
  expect(post).not.toHaveBeenCalled()
})

it.each(['manual', 'redeemed'])('closes payment immediately after server-confirmed %s completion', async (status) => {
  const { client, post, popup } = setup()
  fireEvent.click(await screen.findByRole('button', { name: /Wallet credit/ }))
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
