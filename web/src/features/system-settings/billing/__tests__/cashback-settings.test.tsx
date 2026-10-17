import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { CashbackSettingsSection } from '../cashback-settings-section'

const rules = {
  description: 'First: {first_percent}%, regular: {regular_percent}%',
  transfer_enabled: true,
  first_enabled: false,
  first_percent: 20,
  regular_enabled: false,
  regular_percent: 5,
  online_enabled: false,
  code_enabled: false,
  admin_enabled: false,
}

beforeEach(() => {
  useAuthStore.getState().auth.setUser({ id: 1, username: 'root', role: 100 })
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
})

afterEach(() => {
  vi.restoreAllMocks()
  useAuthStore.getState().auth.setUser(null)
})

function renderSettings() {
  const actions = document.createElement('div')
  document.body.append(actions)
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <SettingsPageProvider actionsContainer={actions}>
        <CashbackSettingsSection value={JSON.stringify(rules)} />
      </SettingsPageProvider>
    </QueryClientProvider>
  )
  return () => {
    view.unmount()
    actions.remove()
    client.clear()
  }
}

test('root can enable all recharge sources and both non-stacking reward types', async () => {
  const dispose = renderSettings()
  try {
    for (const label of [
      'Enable first recharge cashback',
      'Enable regular recharge cashback',
      'Cashback on online payments',
      'Cashback on redemption codes',
      'Cashback on administrator balance additions',
    ]) {
      fireEvent.click(screen.getByRole('switch', { name: label }))
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/api/option/', {
        key: 'AffiliateCashback',
        value: JSON.stringify({
          ...rules,
          first_enabled: true,
          regular_enabled: true,
          online_enabled: true,
          code_enabled: true,
          admin_enabled: true,
        }),
      })
    )
  } finally {
    dispose()
  }
})

test('non-root cannot change cashback rules', () => {
  useAuthStore.getState().auth.setUser({ id: 2, username: 'admin', role: 10 })
  const dispose = renderSettings()
  try {
    expect(screen.getByRole('button', { name: 'Save Settings' })).toBeDisabled()
    expect(
      screen.getByRole('switch', { name: 'Allow cashback transfer to balance' })
    ).toHaveAttribute('aria-disabled', 'true')
  } finally {
    dispose()
  }
})

test('root can edit the dynamic cashback description', async () => {
  const dispose = renderSettings()
  try {
    const input = screen.getByLabelText('Description')
    fireEvent.change(input, {
      target: { value: 'Invite cashback: {regular_percent}%' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/api/option/', {
        key: 'AffiliateCashback',
        value: JSON.stringify({
          ...rules,
          description: 'Invite cashback: {regular_percent}%',
        }),
      })
    )
  } finally {
    dispose()
  }
})
