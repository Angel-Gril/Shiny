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
import { describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import {
  HostedPaymentOperations,
  HostedPendingPayments,
} from '../hosted-payment-operations'

const operations = {
  auto_reconcile_enabled: false,
  interval_minutes: 5,
  batch_size: 20,
  pending_alert_minutes: 30,
}

describe('payment operations', () => {
  it('starts paused and saves explicitly enabled reconciliation with bounded batch settings', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: operations },
    })
    const put = vi.spyOn(api, 'put').mockResolvedValue({
      data: {
        success: true,
        data: { ...operations, auto_reconcile_enabled: true, batch_size: 10 },
      },
    })
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    render(
      <QueryClientProvider client={client}>
        <HostedPaymentOperations />
      </QueryClientProvider>
    )
    const toggle = await screen.findByRole('switch', {
      name: 'Automatic payment reconciliation',
    })
    expect(toggle).not.toBeChecked()
    await user.click(toggle)
    const batch = screen.getByRole('spinbutton', {
      name: 'Orders per reconciliation run',
    })
    await user.clear(batch)
    await user.type(batch, '10')
    await user.click(
      screen.getByRole('button', { name: 'Save reconciliation settings' })
    )
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/option/payments/operations', {
        ...operations,
        auto_reconcile_enabled: true,
        batch_size: 10,
      })
    )
    expect(toggle).toBeChecked()
    client.clear()
  })

  it('keeps invalid batches editable and does not submit them', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: operations },
    })
    const put = vi.spyOn(api, 'put')
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <HostedPaymentOperations />
      </QueryClientProvider>
    )
    const batch = await screen.findByRole('spinbutton', {
      name: 'Orders per reconciliation run',
    })
    await user.clear(batch)
    await user.type(batch, '101')
    // Native range validity and schema validity both protect this form.
    expect(batch).toBeInvalid()
    await user.click(
      screen.getByRole('button', { name: 'Save reconciliation settings' })
    )
    expect(put).not.toHaveBeenCalled()
    expect(batch).toBeEnabled()
    client.clear()
  })

  it('shows exact pending payment amounts and removes an order only after provider verification', async () => {
    const user = userEvent.setup()
    let paid = false
    vi.spyOn(api, 'get').mockImplementation(async () => ({
      data: {
        success: true,
        data: {
          total: paid ? 0 : 1,
          overdue: paid ? 0 : 1,
          items: paid
            ? []
            : [
                {
                  trade_no: 'HP-candidate-pending',
                  provider: 'cispay',
                  currency: 'RUB',
                  payment_amount: '950.00',
                  payment_state: 'pending',
                  created_at: 1,
                  last_checked_at: 0,
                  check_status: 'needs_reference',
                },
              ],
        },
      },
    }))
    const post = vi.spyOn(api, 'post').mockImplementation(async () => {
      paid = true
      return { data: { success: true, data: { paid: true } } }
    })
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <HostedPendingPayments provider='cispay' />
      </QueryClientProvider>
    )
    expect(await screen.findByText('RUB 950.00')).toBeVisible()
    expect(screen.getByText('Payment needs support verification')).toBeVisible()
    expect(screen.getByText('Not checked yet')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Verify payment' }))
    expect(post).toHaveBeenCalledWith('/api/option/payments/cispay/reconcile', {
      trade_no: 'HP-candidate-pending',
      remote_id: '',
      payment_id: '',
    })
    expect(await screen.findByText('No pending payments')).toBeVisible()
    client.clear()
  })

  it('retains the pending order on failed verification and shows loading and retry states for a failed queue', async () => {
    const user = userEvent.setup()
    let retry = false
    vi.spyOn(api, 'get').mockImplementation(async () => {
      if (!retry) throw new Error('network unavailable')
      return {
        data: {
          success: true,
          data: {
            total: 1,
            overdue: 0,
            items: [
              {
                trade_no: 'HP-still-pending',
                provider: 'paypal',
                currency: 'USD',
                payment_amount: '10.00',
                payment_state: 'pending',
                created_at: 1,
                last_checked_at: 1,
                check_status: 'pending',
              },
            ],
          },
        },
      }
    })
    vi.spyOn(api, 'post').mockRejectedValue(new Error('provider unavailable'))
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    render(
      <QueryClientProvider client={client}>
        <HostedPendingPayments provider='paypal' />
      </QueryClientProvider>
    )
    retry = true
    await user.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('HP-still-pending')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Verify payment' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Verify payment' })
      ).toBeEnabled()
    )
    expect(screen.getByText('HP-still-pending')).toBeVisible()
    client.clear()
  })
})
