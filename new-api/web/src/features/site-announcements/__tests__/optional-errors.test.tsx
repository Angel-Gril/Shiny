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
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { createAppQueryClient } from '@/lib/query-client'

import { SiteNoticePopup } from '../notice-popup'

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

const failure = Object.assign(new Error('Optional notice API unavailable'), {
  isAxiosError: true,
  response: {
    status: 500,
    data: { message: 'Optional notice API unavailable' },
  },
})

test('a notice HTTP 500 keeps the dashboard usable with the real global query handler', async () => {
  vi.spyOn(api, 'get').mockRejectedValue(failure)
  const redirect = vi.fn()
  const client = createAppQueryClient(redirect)
  client.setDefaultOptions({ queries: { retry: false } })
  render(
    <QueryClientProvider client={client}>
      <h1>Dashboard remains available</h1>
      <SiteNoticePopup />
    </QueryClientProvider>
  )
  await waitFor(() =>
    expect(client.getQueryState(['notice'])?.status).toBe('error')
  )
  expect(
    screen.getByRole('heading', { name: 'Dashboard remains available' })
  ).toBeVisible()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(redirect).not.toHaveBeenCalled()
  client.clear()
})

test('ordinary API queries retain the existing HTTP 500 redirect behavior', async () => {
  const redirect = vi.fn()
  const client = createAppQueryClient(redirect)
  await expect(
    client.fetchQuery({
      queryKey: ['ordinary-api'],
      queryFn: () => Promise.reject(failure),
      retry: false,
      meta: { errorToast: false },
    })
  ).rejects.toBe(failure)
  expect(redirect).toHaveBeenCalledOnce()
  client.clear()
})
