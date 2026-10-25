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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { SeoSection } from '../seo-section'

type SeoDefaults = {
  homePageTitle: string
  customHeadHTML: string
}

function Fixture(props: SeoDefaults) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <SeoSection
          defaultHomePageTitle={props.homePageTitle}
          defaultCustomHeadHTML={props.customHeadHTML}
        />
      </SettingsPageProvider>
    </>
  )
}

async function renderSeo(defaults: SeoDefaults) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <Fixture {...defaults} />,
    }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return {
    titleInput: await screen.findByRole('textbox', {
      name: 'Home Page Title',
    }),
    headInput: await screen.findByRole('textbox', {
      name: 'Custom Head HTML',
    }),
  }
}

beforeEach(() => {
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
})

test('loads the saved home page title and custom head HTML', async () => {
  const { titleInput, headInput } = await renderSeo({
    homePageTitle: 'Acme AI Gateway',
    customHeadHTML: '<meta name="description" content="Existing">',
  })

  expect(titleInput).toHaveValue('Acme AI Gateway')
  expect(headInput).toHaveValue('<meta name="description" content="Existing">')
})

test('saves edited home page title and custom head HTML', async () => {
  const user = userEvent.setup()
  const { titleInput, headInput } = await renderSeo({
    homePageTitle: '',
    customHeadHTML: '',
  })

  await user.type(titleInput, 'Acme AI Gateway')
  await user.type(headInput, '<meta name="robots" content="noindex">')
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))

  await waitFor(() => {
    expect(api.put).toHaveBeenCalledWith('/api/option/', {
      key: 'site_setting.home_page_title',
      value: 'Acme AI Gateway',
    })
    expect(api.put).toHaveBeenCalledWith('/api/option/', {
      key: 'site_setting.custom_head_html',
      value: '<meta name="robots" content="noindex">',
    })
  })
})
