import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useAuthStore } from '@/stores/auth-store'

import {
  SettingsForm,
  SettingsSwitchItem,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'

const schema = z.object({
  description: z.string().max(500),
  transfer_enabled: z.boolean(),
})

export function CashbackSettingsSection(props: { value: string }) {
  const { t } = useTranslation()
  const isRoot = useAuthStore((state) => state.auth.user?.role === 100)
  const updateOption = useUpdateOption()
  let defaults: z.infer<typeof schema> = {
    description: '',
    transfer_enabled: true,
  }
  try {
    const parsed = schema.safeParse({ ...defaults, ...JSON.parse(props.value) })
    if (parsed.success) defaults = parsed.data
  } catch {
    // Legacy installations have no cashback configuration yet.
  }
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: defaults,
  })

  async function onSubmit(values: z.infer<typeof schema>) {
    await updateOption.mutateAsync({
      key: 'AffiliateCashback',
      value: JSON.stringify(values),
    })
    form.reset(values)
  }

  return (
    <SettingsSection title={t('Recharge Cashback')}>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Promoters earn a fixed CNY 2 when an invited user’s first recharge is at least CNY 10. All other recharges earn 8%. These rules apply to every recharge method.'
        )}
      </p>
      <Form {...form}>
        <SettingsForm onSubmit={form.handleSubmit(onSubmit)}>
          <SettingsPageFormActions
            onSave={form.handleSubmit(onSubmit)}
            isSaving={updateOption.isPending}
            isSaveDisabled={!isRoot || !form.formState.isDirty}
            saveLabel='Save Settings'
          />
          <FormField
            control={form.control}
            name='description'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('Description')}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    placeholder={t('Example:')}
                    disabled={!isRoot || updateOption.isPending}
                  />
                </FormControl>
                <p className='text-muted-foreground text-xs'>
                  {t('Supported variables')}:{' '}
                  {'{regular_percent}, {promoter_first_min_cny}, {promoter_first_reward_cny}'}
                </p>
                <FormMessage />
              </FormItem>
            )}
          />
          {(
            [
              ['transfer_enabled', t('Allow cashback transfer to balance')],
            ] as const
          ).map(([name, label]) => (
            <FormField
              key={name}
              control={form.control}
              name={name}
              render={({ field }) => (
                <SettingsSwitchItem>
                  <FormLabel>{label}</FormLabel>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      disabled={!isRoot || updateOption.isPending}
                    />
                  </FormControl>
                </SettingsSwitchItem>
              )}
            />
          ))}
        </SettingsForm>
      </Form>
    </SettingsSection>
  )
}
