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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { RateLimitSection } from '../rate-limit-section'

const defaults = {
  ModelRequestRateLimitEnabled: false,
  ModelRequestRateLimitDurationMinutes: 1,
  ModelRequestRateLimitCount: 0,
  ModelRequestRateLimitSuccessCount: 1000,
  ModelRequestConcurrencyPerUser: 5,
  ModelRequestConcurrencyGlobal: 32,
  ModelRequestConcurrencyUserOverrides: '{}',
  ModelRequestRateLimitGroup: '{}',
}
let client: QueryClient
let actions: HTMLDivElement

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  actions = document.createElement('div')
  document.body.appendChild(actions)
})

afterEach(() => {
  actions.remove()
  client.clear()
})

function renderLimits(overrides = '{}') {
  render(
    <QueryClientProvider client={client}>
      <SettingsPageProvider actionsContainer={actions}>
        <RateLimitSection
          defaultValues={{
            ...defaults,
            ModelRequestConcurrencyUserOverrides: overrides,
          }}
        />
      </SettingsPageProvider>
    </QueryClientProvider>
  )
}

it('saving a service-account override writes only that option and retains ordinary and global limits', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  renderLimits()
  fireEvent.change(
    screen.getByRole('textbox', { name: 'User concurrency overrides' }),
    { target: { value: '{"42":20}' } }
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Save rate limits' })
  )
  await waitFor(() =>
    expect(put).toHaveBeenCalledExactlyOnceWith('/api/option/', {
      key: 'ModelRequestConcurrencyUserOverrides',
      value: '{"42":20}',
    })
  )
  expect(
    screen.getByRole('spinbutton', { name: 'Max concurrent requests per user' })
  ).toHaveValue(5)
  expect(
    screen.getByRole('spinbutton', { name: 'Max global concurrent requests' })
  ).toHaveValue(32)
})

it.each(['[]', '{"042":20}', '{"42":0}', '{"42":100001}', '{"42":1.5}'])(
  'an invalid override %s is explained and remains editable without being saved',
  async (value) => {
    const put = vi.spyOn(api, 'put')
    renderLimits()
    const field = screen.getByRole('textbox', {
      name: 'User concurrency overrides',
    })
    fireEvent.change(field, { target: { value } })
    await userEvent.click(
      screen.getByRole('button', { name: 'Save rate limits' })
    )
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(
      screen.getByText(
        'Enter a JSON object of user IDs and concurrency limits (1–100000)'
      )
    ).toBeVisible()
    expect(field).toBeEnabled()
    expect(put).not.toHaveBeenCalled()
  }
)

it('a rejected override save keeps the draft and supports an explicit retry', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValueOnce({
      data: { success: false, message: 'Save rejected' },
    })
    .mockResolvedValueOnce({ data: { success: true } })
  renderLimits('{"42":20}')
  const field = screen.getByRole('textbox', {
    name: 'User concurrency overrides',
  })
  fireEvent.change(field, { target: { value: '{}' } })
  await userEvent.click(
    screen.getByRole('button', { name: 'Save rate limits' })
  )
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save rate limits' })
    ).toBeEnabled()
  )
  expect(field).toHaveValue('{}')
  await userEvent.click(
    screen.getByRole('button', { name: 'Save rate limits' })
  )
  await waitFor(() => expect(put).toHaveBeenCalledTimes(2))
})
