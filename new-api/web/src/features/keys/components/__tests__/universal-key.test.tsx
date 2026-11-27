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
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { STATUS_QUERY_KEY } from '@/lib/status-query'

import type { ApiKey } from '../../types'
import { ApiKeyCreatedDialog } from '../api-key-created-dialog'
import { ApiKeysPrimaryButtons } from '../api-keys-primary-buttons'
import { ApiKeysProvider, useApiKeys } from '../api-keys-provider'

const key: ApiKey = {
  id: 42,
  name: 'Universal API key',
  key: 'abcd**********wxyz',
  status: 1,
  created_time: 1,
  accessed_time: 1,
  expired_time: -1,
  remain_quota: 0,
  used_quota: 0,
  unlimited_quota: true,
  group: '',
  auto_groups: null,
  cross_group_retry: false,
  model_limits_enabled: false,
  model_limits: '',
  allow_ips: '',
  allow_user_quota_query: true,
}
let client: QueryClient

function OpenState() {
  const state = useApiKeys()
  return <output aria-label='Key action'>{state.open}</output>
}

function renderButtons(profile = 'ru', capability = true) {
  client.setQueryData(STATUS_QUERY_KEY, {
    site_profile: profile,
    ru_universal_keys: capability,
    server_address: 'https://ru.example.test/',
  })
  render(
    <QueryClientProvider client={client}>
      <ApiKeysProvider>
        <ApiKeysPrimaryButtons />
        <ApiKeyCreatedDialog />
        <OpenState />
      </ApiKeysProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  })
})
afterEach(() => {
  client.clear()
  localStorage.clear()
})

it('RU creates a ready-to-copy key with one click, then allows optional editing', async () => {
  const user = userEvent.setup()
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText')
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/api/token/') return { data: { success: true, data: key } }
    if (url === '/api/token/42/key') {
      return {
        data: { success: true, data: { key: 'synthetic-key-for-copy' } },
      }
    }
    throw new Error('Unexpected endpoint')
  })
  renderButtons()
  await user.click(screen.getByRole('button', { name: 'Create API Key' }))
  const dialog = await screen.findByRole('dialog', {
    name: 'Your API key is ready',
  })
  expect(post).toHaveBeenCalledWith('/api/token/', {
    preset: 'ru_universal',
    name: 'Universal API key',
  })
  expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument()
  expect(within(dialog).getByText('https://ru.example.test/v1')).toBeVisible()
  await user.click(within(dialog).getByRole('button', { name: 'Copy API key' }))
  await waitFor(() =>
    expect(clipboard).toHaveBeenCalledWith('sk-synthetic-key-for-copy')
  )
  expect(localStorage.getItem('synthetic-key-for-copy')).toBeNull()
  expect(localStorage.getItem('api_key')).toBeNull()
  await user.click(
    within(dialog).getByRole('button', { name: 'Edit key settings' })
  )
  expect(screen.getByLabelText('Key action')).toHaveTextContent('update')
  expect(post.mock.calls.filter(([url]) => url === '/api/token/')).toHaveLength(
    1
  )
})

it('a domestic site retains the create form and sends no quick-create request', async () => {
  const user = userEvent.setup()
  const post = vi.spyOn(api, 'post')
  renderButtons('default')
  await user.click(screen.getByRole('button', { name: 'Create API Key' }))
  expect(screen.getByLabelText('Key action')).toHaveTextContent('create')
  expect(post).not.toHaveBeenCalled()
  expect(
    screen.queryByRole('dialog', { name: 'Your API key is ready' })
  ).not.toBeInTheDocument()
})

it('an older RU backend without the capability keeps the existing form', async () => {
  const user = userEvent.setup()
  const post = vi.spyOn(api, 'post')
  renderButtons('ru', false)
  await user.click(screen.getByRole('button', { name: 'Create API Key' }))
  expect(screen.getByLabelText('Key action')).toHaveTextContent('create')
  expect(post).not.toHaveBeenCalled()
})

it('rapid clicks while creation is pending send one request and cannot create duplicates', async () => {
  const user = userEvent.setup()
  let finish!: (value: { data: { success: boolean; data: ApiKey } }) => void
  const post = vi.spyOn(api, 'post').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  renderButtons()
  await user.dblClick(screen.getByRole('button', { name: 'Create API Key' }))
  expect(post).toHaveBeenCalledTimes(1)
  expect(
    screen.getByRole('button', { name: 'Creating API key...' })
  ).toBeDisabled()
  await act(async () => finish({ data: { success: true, data: key } }))
  expect(
    await screen.findByRole('dialog', { name: 'Your API key is ready' })
  ).toBeVisible()
})

it('a rejected creation stays on the list and shows the server error without retrying', async () => {
  const user = userEvent.setup()
  const error = vi.spyOn(toast, 'error')
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: false, message: 'Maximum number of tokens reached' },
  })
  renderButtons()
  await user.click(screen.getByRole('button', { name: 'Create API Key' }))
  await waitFor(() => expect(error).toHaveBeenCalled())
  expect(screen.getByRole('button', { name: 'Create API Key' })).toBeEnabled()
  expect(post).toHaveBeenCalledTimes(1)
  expect(
    screen.queryByRole('dialog', { name: 'Your API key is ready' })
  ).not.toBeInTheDocument()
})

it('a failed key reveal can be retried without creating another key', async () => {
  const user = userEvent.setup()
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText')
  let reveal = 0
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/api/token/') return { data: { success: true, data: key } }
    reveal++
    return reveal === 1
      ? { data: { success: false, message: 'Try again' } }
      : { data: { success: true, data: { key: 'synthetic-retry-key' } } }
  })
  renderButtons()
  await user.click(screen.getByRole('button', { name: 'Create API Key' }))
  const dialog = await screen.findByRole('dialog', {
    name: 'Your API key is ready',
  })
  await user.click(within(dialog).getByRole('button', { name: 'Copy API key' }))
  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', { name: 'Copy API key' })
    ).toBeEnabled()
  )
  await user.click(within(dialog).getByRole('button', { name: 'Copy API key' }))
  await waitFor(() =>
    expect(clipboard).toHaveBeenCalledWith('sk-synthetic-retry-key')
  )
  expect(post.mock.calls.filter(([url]) => url === '/api/token/')).toHaveLength(
    1
  )
})
