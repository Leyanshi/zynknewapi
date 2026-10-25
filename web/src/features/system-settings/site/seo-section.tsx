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
import { zodResolver } from '@hookform/resolvers/zod'
import type { Resolver } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import * as z from 'zod'

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

import { FormDirtyIndicator } from '../components/form-dirty-indicator'
import { FormNavigationGuard } from '../components/form-navigation-guard'
import { SettingsForm } from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useSettingsForm } from '../hooks/use-settings-form'
import { useUpdateOption } from '../hooks/use-update-option'

const seoSchema = z.object({
  site_setting: z.object({
    home_page_title: z.string(),
    custom_head_html: z.string(),
  }),
})

type SeoFormValues = z.infer<typeof seoSchema>

type SeoSectionProps = {
  defaultHomePageTitle: string
  defaultCustomHeadHTML: string
}

export function SeoSection(props: SeoSectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()

  const { form, handleSubmit, handleReset, isDirty, isSubmitting } =
    useSettingsForm<SeoFormValues>({
      resolver: zodResolver(seoSchema) as Resolver<
        SeoFormValues,
        unknown,
        SeoFormValues
      >,
      defaultValues: {
        site_setting: {
          home_page_title: props.defaultHomePageTitle ?? '',
          custom_head_html: props.defaultCustomHeadHTML ?? '',
        },
      },
      onSubmit: async (_data, changedFields) => {
        for (const [key, value] of Object.entries(changedFields)) {
          await updateOption.mutateAsync({
            key,
            value: String(value ?? ''),
          })
        }
      },
    })

  return (
    <>
      <FormNavigationGuard when={isDirty} />

      <SettingsSection title={t('SEO')}>
        <Form {...form}>
          <SettingsForm onSubmit={handleSubmit}>
            <SettingsPageFormActions
              onSave={handleSubmit}
              onReset={handleReset}
              isSaving={isSubmitting || updateOption.isPending}
              isResetDisabled={!isDirty}
            />
            <FormDirtyIndicator isDirty={isDirty} />
            <FormField
              control={form.control}
              name='site_setting.home_page_title'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Home Page Title')}</FormLabel>
                  <FormControl>
                    <Input placeholder='New API' {...field} />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Custom title for the homepage only. Leave empty to use the system name.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='site_setting.custom_head_html'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Custom Head HTML')}</FormLabel>
                  <FormControl>
                    <Textarea
                      className='min-h-48 font-mono text-xs'
                      placeholder='<meta name="description" content="Your site description" />'
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'HTML inserted before the closing </head> tag on every frontend page. API responses are not affected. Injected as-is, so only add trusted code.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </SettingsForm>
        </Form>
      </SettingsSection>
    </>
  )
}
