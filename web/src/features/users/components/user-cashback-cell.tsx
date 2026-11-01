import { Pencil } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { formatQuota } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { useAuthStore } from '@/stores/auth-store'

import { setUserPromoter } from '../api'
import { isUserDeleted } from '../constants'
import type { User } from '../types'
import { UserQuotaDialog } from './user-quota-dialog'
import { useUsers } from './users-provider'

export function UserCashbackCell(props: { user: User; isRoot: boolean }) {
  const { t } = useTranslation()
  const { triggerRefresh } = useUsers()
  const operatorRole = useAuthStore((state) => state.auth.user?.role ?? 0)
  const [saving, setSaving] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const deleted = isUserDeleted(props.user)
  const canAdjust = !deleted && (props.isRoot || operatorRole > props.user.role)

  async function changePromoter(enabled: boolean) {
    setSaving(true)
    try {
      const response = await setUserPromoter(props.user.id, enabled)
      if (!response.success) {
        handleServerError(response)
        return
      }
      toast.success(t('Promoter eligibility updated'))
      triggerRefresh()
    } catch (error) {
      handleServerError(error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='space-y-1 text-xs'>
      <div className='flex items-center gap-2'>
        <span>{t('Promoter')}</span>
        <Switch
          size='sm'
          checked={props.user.is_promoter ?? false}
          disabled={!props.isRoot || deleted || saving}
          onCheckedChange={changePromoter}
          aria-label={t('Promoter eligibility for {{username}}', { username: props.user.username })}
        />
      </div>
      <div className='flex items-center gap-1'>
        <span>{t('Pending')}: <span className='tabular-nums'>{formatQuota(props.user.aff_quota ?? 0)}</span></span>
        {canAdjust && (
          <Button
            variant='ghost'
            size='icon-sm'
            onClick={() => setDialogOpen(true)}
            aria-label={t('Adjust pending cashback for {{username}}', { username: props.user.username })}
          >
            <Pencil className='size-3' />
          </Button>
        )}
      </div>
      <div className='text-muted-foreground'>
        {t('Total Earned')}: <span className='tabular-nums'>{formatQuota(props.user.aff_history_quota ?? 0)}</span>
      </div>
      <UserQuotaDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        userId={props.user.id}
        currentQuota={props.user.aff_quota ?? 0}
        target='cashback'
        onSuccess={triggerRefresh}
      />
    </div>
  )
}
