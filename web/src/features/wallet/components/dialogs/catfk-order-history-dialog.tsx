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
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { toIntlLocale } from '@/i18n/languages'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { formatTimestampToDate } from '@/lib/format'

import { getCatfkOrders } from '../../catfk-api'

const ordersKey = ['wallet', 'catfk', 'orders']
const statusLabels = {
  pending: 'Pending',
  redeemed: 'Redeemed',
  manual: 'Manual',
} as const

interface CatfkOrderHistoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CatfkOrderHistoryDialog({
  open,
  onOpenChange,
}: CatfkOrderHistoryDialogProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const orders = useQuery({
    queryKey: ordersKey,
    queryFn: getCatfkOrders,
    enabled: open,
    refetchOnMount: 'always',
  })

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('Order History')}
      description={t('View your CatFK orders')}
      contentClassName='max-h-(--dialog-available-height) max-sm:w-screen max-sm:max-w-none max-sm:rounded-none max-sm:p-4 sm:max-w-2xl'
      contentHeight='auto'
      bodyClassName='max-h-[min(60vh,560px)] overflow-y-auto'
    >
      {orders.isPending && (
        <div className='space-y-3'>
          {['first', 'second', 'third'].map((item) => (
            <div key={item} className='space-y-2 rounded-lg border p-3'>
              <Skeleton className='h-4 w-48' />
              <Skeleton className='h-3 w-64' />
              <Skeleton className='h-3 w-32' />
            </div>
          ))}
        </div>
      )}
      {orders.isError && <ErrorState onRetry={() => void orders.refetch()} />}
      {orders.isSuccess && orders.data.length === 0 && <EmptyState />}
      {orders.isSuccess && orders.data.length > 0 && (
        <div className='space-y-3'>
          {orders.data.map((order) => (
            <div key={order.id} className='space-y-2 rounded-lg border p-3'>
              <div className='flex items-start justify-between gap-3'>
                <div className='min-w-0'>
                  <p className='font-medium break-words'>{order.name}</p>
                  <div className='mt-1 flex items-center gap-1'>
                    <code className='text-muted-foreground min-w-0 truncate text-xs'>
                      {order.trade_no}
                    </code>
                    <CopyButton
                      value={order.trade_no}
                      variant='ghost'
                      className='size-6 shrink-0'
                      iconClassName='size-3'
                      tooltip={t('Copy')}
                      aria-label={t('Copy')}
                    />
                  </div>
                </div>
                <span className='text-muted-foreground shrink-0 text-xs'>
                  {t(statusLabels[order.status])}
                </span>
              </div>
              <div className='text-muted-foreground grid grid-cols-2 gap-2 text-xs'>
                <span>{formatTimestampToDate(order.created_time)}</span>
                <span className='text-right font-medium'>
                  {formatQuotaWithCurrency(order.quota, {
                    locale,
                    abbreviate: false,
                  })}
                </span>
              </div>
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
              {order.status === 'pending' && (
                <p className='text-muted-foreground text-sm'>
                  {t('Waiting for payment or card delivery')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  )
}
