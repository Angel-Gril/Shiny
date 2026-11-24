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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { BillingHistoryDialog } from '../components/dialogs/billing-history-dialog'

const order = {
  id: 1,
  trade_no: 'HP-wallet-order',
  amount: 10,
  money: 950,
  payment_amount: '950.00',
  payment_currency: 'RUB',
  payment_provider: 'cispay',
  payment_method: 'cispay',
  payment_state: 'pending',
  payment_check_status: 'pending',
  status: 'pending',
  create_time: 1,
}

afterEach(() => useAuthStore.getState().auth.reset())

describe('wallet payment recovery', () => {
  it('checks the existing order without creating another payment and refreshes its verified status', async () => {
    const user = userEvent.setup()
    let paid = false
    const refresh = vi.fn()
    vi.spyOn(api, 'get').mockImplementation(async () => ({
      data: {
        success: true,
        data: {
          total: 1,
          items: [
            {
              ...order,
              status: paid ? 'success' : 'pending',
              payment_check_status: paid ? 'paid' : 'pending',
            },
          ],
        },
      },
    }))
    const post = vi.spyOn(api, 'post').mockImplementation(async () => {
      paid = true
      return {
        data: {
          success: true,
          data: { status: 'success', payment_check_status: 'paid' },
        },
      }
    })
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <BillingHistoryDialog
          open
          onOpenChange={vi.fn()}
          onDataRefresh={refresh}
        />
      </QueryClientProvider>
    )
    expect(await screen.findByText('RUB 950.00')).toBeVisible()
    await user.click(
      screen.getByRole('button', { name: 'Check payment status' })
    )
    expect(post).toHaveBeenCalledWith('/api/user/payments/cispay/check', {
      trade_no: order.trade_no,
    })
    expect(await screen.findByText('Success')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Check payment status' })
    ).not.toBeInTheDocument()
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    client.clear()
  })

  it('preserves the pending payment and allows a retry when the status query fails', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: { total: 1, items: [order] } },
    })
    vi.spyOn(api, 'post').mockRejectedValue(new Error('network unavailable'))
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <BillingHistoryDialog open onOpenChange={vi.fn()} />
      </QueryClientProvider>
    )
    await user.click(
      await screen.findByRole('button', { name: 'Check payment status' })
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Check payment status' })
      ).toBeEnabled()
    )
    expect(screen.getByText('RUB 950.00')).toBeVisible()
    expect(screen.getByText('Pending')).toBeVisible()
    client.clear()
  })

  it('routes administrators to verified recovery and never offers manual completion for native payments', async () => {
    useAuthStore
      .getState()
      .auth.setUser({ id: 1, username: 'fixture-admin', role: 100 })
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: { total: 1, items: [order] } },
    })
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <BillingHistoryDialog open onOpenChange={vi.fn()} />
      </QueryClientProvider>
    )
    expect(
      await screen.findByText(
        'Verify this order in International payments settings.'
      )
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Complete Order' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Check payment status' })
    ).not.toBeInTheDocument()
    client.clear()
  })
})
