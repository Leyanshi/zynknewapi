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
  transfer_enabled: z.boolean(),
  first_enabled: z.boolean(),
  first_percent: z.number().min(0).max(100),
  regular_enabled: z.boolean(),
  regular_percent: z.number().min(0).max(100),
  online_enabled: z.boolean(),
  code_enabled: z.boolean(),
  admin_enabled: z.boolean(),
})

export function CashbackSettingsSection(props: { value: string }) {
  const { t } = useTranslation()
  const isRoot = useAuthStore((state) => state.auth.user?.role === 100)
  const updateOption = useUpdateOption()
  let defaults: z.infer<typeof schema> = {
    transfer_enabled: true,
    first_enabled: false,
    first_percent: 0,
    regular_enabled: false,
    regular_percent: 0,
    online_enabled: false,
    code_enabled: false,
    admin_enabled: false,
  }
  try {
    const parsed = schema.safeParse(JSON.parse(props.value))
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
          'Cashback goes to the inviter. First recharge requires zero balance and zero usage before crediting; first and regular cashback never stack.'
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
          {(
            [
              ['transfer_enabled', t('Allow cashback transfer to balance')],
              ['first_enabled', t('Enable first recharge cashback')],
              ['regular_enabled', t('Enable regular recharge cashback')],
              ['online_enabled', t('Cashback on online payments')],
              ['code_enabled', t('Cashback on redemption codes')],
              [
                'admin_enabled',
                t('Cashback on administrator balance additions'),
              ],
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
          {(
            [
              ['first_percent', t('First recharge cashback (%)')],
              ['regular_percent', t('Regular recharge cashback (%)')],
            ] as const
          ).map(([name, label]) => (
            <FormField
              key={name}
              control={form.control}
              name={name}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{label}</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={0}
                      max={100}
                      step='any'
                      value={field.value}
                      onChange={(event) =>
                        field.onChange(
                          event.target.value === ''
                            ? Number.NaN
                            : Number(event.target.value)
                        )
                      }
                      disabled={!isRoot || updateOption.isPending}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          ))}
        </SettingsForm>
      </Form>
    </SettingsSection>
  )
}
