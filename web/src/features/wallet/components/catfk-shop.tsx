import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import dayjs from 'dayjs'
import { Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { CopyButton } from '@/components/copy-button'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { HtmlContent } from '@/components/html-content'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toIntlLocale } from '@/i18n/languages'
import { getSelf } from '@/lib/api'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { handleServerError } from '@/lib/handle-server-error'

import {
  createCatfkOrder,
  formatCatfkTradeNo,
  getCatfkCatalog,
  getCatfkOrders,
  getCatfkPaymentStatus,
  redeemCatfkOrder,
  type CatfkGoods,
  type CatfkOrder,
} from '../catfk-api'
import { formatCurrency } from '../lib/format'

const catalogKey = ['wallet', 'catfk', 'catalog']
const ordersKey = ['wallet', 'catfk', 'orders']

export function CatfkShop() {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const client = useQueryClient()
  const [selected, setSelected] = useState<CatfkGoods | null>(null)
  const [channel, setChannel] = useState<string | null>(null)
  const popup = useRef<Window | null>(null)
  const [activeOrder, setActiveOrder] = useState<string | null>(null)
  const [hiddenOrderIds, setHiddenOrderIds] = useState<string[]>([])
  const catalog = useQuery({
    queryKey: catalogKey,
    queryFn: getCatfkCatalog,
    staleTime: 5 * 60_000,
  })
  const orders = useQuery({
    queryKey: ordersKey,
    queryFn: getCatfkOrders,
  })
  const paymentSync = useQuery({
    queryKey: ['wallet', 'catfk', 'sync', activeOrder],
    enabled: !!activeOrder,
    queryFn: async ({ signal }) => {
      const currentOrders = client.getQueryData<CatfkOrder[]>(ordersKey) ?? []
      const order = currentOrders.find((item) => item.id === activeOrder)
      if (!order || order.status !== 'pending') return null
      const delivery = await getCatfkPaymentStatus(order, signal)
      if (!delivery || signal.aborted) return null
      // The server verifies the bearer code against its own redemption table,
      // not a browser-reported paid flag, price, quota or upstream response.
      const redeemed = await redeemCatfkOrder(order.id, delivery)
      if (!signal.aborted) {
        await client.cancelQueries({ queryKey: ordersKey })
        client.setQueryData<CatfkOrder[]>(ordersKey, (current = []) =>
          current.map((item) => (item.id === redeemed.id ? redeemed : item))
        )
      }
      return redeemed
    },
    retry: false,
    staleTime: 10_000,
    refetchInterval: (query) =>
      query.state.status === 'error' ? 60_000 : 10_000,
    // The wallet is often hidden behind the payment popup. Pausing here
    // prevents paid windows from closing until the user returns to the wallet.
    refetchIntervalInBackground: true,
  })
  const paymentChannel = channel ?? String(catalog.data?.channels[0]?.id ?? '')
  const visibleOrders = orders.data?.filter(
    (order) =>
      dayjs(order.created_time * 1000).isSame(dayjs(), 'day') &&
      !hiddenOrderIds.includes(order.id)
  )
  const purchase = useMutation({
    mutationFn: createCatfkOrder,
    retry: false,
    onSuccess: (order) => {
      client.setQueryData<CatfkOrder[]>(ordersKey, (current = []) => [
        order,
        ...current.filter((item) => item.id !== order.id),
      ])
      setActiveOrder(order.id)
      if (popup.current && !popup.current.closed) {
        popup.current.location.replace(order.pay_url)
      }
    },
    onError: (error) => {
      popup.current?.close()
      handleServerError(error)
    },
  })

  useEffect(() => {
    const paid = orders.data?.find(
      (order) => order.id === activeOrder && order.status !== 'pending'
    )
    if (!paid) return
    setActiveOrder(null)
    const paidPopup = popup.current
    // Close immediately after server-confirmed delivery, never based on the
    // cross-origin URL or the user manually closing the payment window.
    try {
      paidPopup?.close()
    } catch {
      /* Browser may require manual closure. */
    }
    if (popup.current === paidPopup) popup.current = null
    if (paid.status === 'redeemed') {
      toast.success(
        t('Successfully recharged {{amount}}', {
          amount: formatQuotaWithCurrency(paid.quota, {
            locale,
            abbreviate: false,
          }),
        })
      )
      void getSelf().catch(handleServerError)
    }
  }, [orders.data, activeOrder, locale, t])

  function buy() {
    if (!selected || !paymentChannel || purchase.isPending || activeOrder) {
      return
    }
    const paymentWindow = window.open(
      '',
      '_blank',
      'popup,width=960,height=760'
    )
    if (!paymentWindow) {
      toast.error(t('Please allow popups to pay'))
      return
    }
    // Keep the WindowProxy for closure, but prevent the external payment site
    // from navigating/accessing the wallet through window.opener.
    paymentWindow.opener = null
    popup.current = paymentWindow
    purchase.mutate({
      goods_key: selected.goods_key,
      channel_id: Number(paymentChannel),
      name: selected.name,
      instructions: selected.description,
    })
  }

  if (catalog.isPending) return <LoadingState />
  if (catalog.isError) {
    return <ErrorState onRetry={() => void catalog.refetch()} />
  }
  if (!catalog.data.enabled) return null

  return (
    <section className='space-y-4' aria-label={t('Online Recharge')}>
      <Label>{t('Online Recharge')}</Label>
      {catalog.data.goods.length === 0 ? (
        <EmptyState />
      ) : (
        <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
          {catalog.data.goods.map((goods) => (
            <Button
              key={goods.goods_key}
              variant={
                selected?.goods_key === goods.goods_key ? 'default' : 'outline'
              }
              className='h-auto min-w-0 flex-col items-start p-3 text-left whitespace-normal'
              disabled={
                goods.extend.stock_count <= 0 ||
                goods.extend.limit_count > 1 ||
                goods.contact_format !== 'any'
              }
              aria-pressed={selected?.goods_key === goods.goods_key}
              onClick={() => setSelected(goods)}
            >
              <span className='break-words'>{goods.name}</span>
              <span>¥{formatCurrency(goods.price)}</span>
            </Button>
          ))}
        </div>
      )}
      {selected && (
        <div className='space-y-3 rounded-lg border p-3'>
          <HtmlContent content={selected.description} />
          <Label htmlFor='catfk-channel'>{t('Payment Method')}</Label>
          <Select value={paymentChannel} onValueChange={setChannel}>
            <SelectTrigger id='catfk-channel'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {catalog.data.channels.map((method) => (
                <SelectItem key={method.id} value={String(method.id)}>
                  {method.show_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Payment fees may be added by the card shop. Confirm the final amount in the payment window.'
            )}
          </p>
          <Button
            onClick={buy}
            disabled={purchase.isPending || !paymentChannel || !!activeOrder}
          >
            {purchase.isPending ? t('Loading...') : t('Buy and Pay')}
          </Button>
        </div>
      )}
      {orders.isError && <ErrorState onRetry={() => void orders.refetch()} />}
      {activeOrder && paymentSync.isError && (
        <ErrorState onRetry={() => void paymentSync.refetch()} />
      )}
      <div className='space-y-3' aria-live='polite'>
        {visibleOrders?.map((order) => (
          <div key={order.id} className='space-y-2 rounded-lg border p-3'>
            <div className='flex items-start justify-between gap-2'>
              <p className='min-w-0 text-sm font-medium break-words'>
                {order.name} · {formatCatfkTradeNo(order.trade_no)}
              </p>
              <Button
                variant='ghost'
                size='icon'
                className='size-7 shrink-0'
                aria-label={t('Delete')}
                title={t('Delete')}
                onClick={() => setHiddenOrderIds((ids) => [...ids, order.id])}
              >
                <Trash2 aria-hidden='true' />
              </Button>
            </div>
            {order.status === 'pending' && (
              <>
                <p className='text-muted-foreground text-sm'>
                  {t('Waiting for payment or card delivery')}
                </p>
                <Button
                  variant='outline'
                  disabled={
                    purchase.isPending ||
                    (!!activeOrder && activeOrder !== order.id)
                  }
                  onClick={() => {
                    if (
                      activeOrder === order.id &&
                      popup.current &&
                      !popup.current.closed
                    ) {
                      popup.current.focus()
                      return
                    }
                    const paymentWindow = window.open(
                      order.pay_url,
                      '_blank',
                      'popup,width=960,height=760'
                    )
                    if (paymentWindow) {
                      paymentWindow.opener = null
                      popup.current = paymentWindow
                      setActiveOrder(order.id)
                    } else toast.error(t('Please allow popups to pay'))
                  }}
                >
                  {t('Continue Payment')}
                </Button>
              </>
            )}
            {order.status === 'redeemed' && (
              <p className='text-success text-sm'>
                {t('Successfully recharged {{amount}}', {
                  amount: formatQuotaWithCurrency(order.quota, {
                    locale,
                    abbreviate: false,
                  }),
                })}
              </p>
            )}
            {order.status === 'manual' && (
              <>
                <Alert>
                  <AlertDescription>
                    {t(
                      'Automatic redemption was unsuccessful. Copy your card and follow the instructions below.'
                    )}
                  </AlertDescription>
                </Alert>
                {order.cards.map((card) => (
                  <div key={card} className='flex items-start gap-2'>
                    <pre className='min-w-0 flex-1 text-sm break-all whitespace-pre-wrap'>
                      {card}
                    </pre>
                    <CopyButton value={card} />
                  </div>
                ))}
                <HtmlContent content={order.instructions} />
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
