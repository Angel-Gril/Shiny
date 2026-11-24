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

import type { HostedPaymentConfig } from '../hosted-payment-api'
import { HostedPaymentSettingsSection } from '../hosted-payment-settings-section'
import { HostedProviderForm } from '../hosted-provider-form'

function fixtureConfig(): HostedPaymentConfig {
  return {
    enabled: false,
    accept_new: false,
    environment: 'live',
    currency: 'USD',
    unit_price: '1',
    min_topup: 1,
    account_id: 'merchant-fixture',
    api_key: '',
    api_secret: '',
    webhook_secret: '',
    signature_type: 'HMAC-SHA256',
    private_key: '',
    platform_public_key: '',
    store_id: '',
    user_id: '',
    developer_user_id: '',
    on_behalf_of: '',
    country_code: '',
    checkout_hosts: [],
    goods_url: '',
    shipping_provider: '',
    pay_currency: '',
    payment_method: '',
    client_id: '',
    client_secret: '',
    merchant_id: '',
    webhook_id: '',
    secrets_configured: ['api_key'],
  }
}

afterEach(() => vi.restoreAllMocks())

describe('hosted payment admin form', () => {
  it('saves a pause while keeping blank secret fields and shows the RU callback', async () => {
    const user = userEvent.setup()
    const config = fixtureConfig()
    config.enabled = true
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true, data: config } })
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <HostedProviderForm
          provider='nowpayments'
          config={config}
          serverAddress='https://ru.shinyapi.com'
        />
      </QueryClientProvider>
    )
    expect(
      screen.getByText(
        'https://ru.shinyapi.com/api/payments/nowpayments/webhook/live'
      )
    ).toBeVisible()
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    await user.click(
      screen.getByRole('button', { name: 'Save payment integration' })
    )
    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(put.mock.calls[0][1]).toMatchObject({
      provider: 'nowpayments',
      config: { enabled: true, accept_new: false, api_key: '' },
    })
    client.clear()
  })

  it('rejects an invalid price locally and keeps the form editable', async () => {
    const user = userEvent.setup()
    const put = vi.spyOn(api, 'put')
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <HostedProviderForm
          provider='nowpayments'
          config={fixtureConfig()}
          serverAddress='https://ru.shinyapi.com'
        />
      </QueryClientProvider>
    )
    await user.clear(
      screen.getByLabelText('Payment currency units per USD credit')
    )
    await user.type(
      screen.getByLabelText('Payment currency units per USD credit'),
      '-5'
    )
    await user.click(
      screen.getByRole('button', { name: 'Save payment integration' })
    )
    expect(await screen.findByText('Enter a positive price')).toBeVisible()
    expect(put).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'Save payment integration' })
    ).toBeEnabled()
    client.clear()
  })

  it('offers a retry when payment settings fail to load', async () => {
    const user = userEvent.setup()
    let firstLoad = true
    const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/api/option/payments/operations') {
        return {
          data: {
            success: true,
            data: {
              auto_reconcile_enabled: false,
              interval_minutes: 5,
              batch_size: 20,
              pending_alert_minutes: 30,
            },
          },
        }
      }
      if (url.endsWith('/pending')) {
        return {
          data: { success: true, data: { items: [], total: 0, overdue: 0 } },
        }
      }
      if (firstLoad) {
        firstLoad = false
        throw new Error('provider unavailable')
      }
      return {
        data: {
          success: true,
          data: {
            cispay: fixtureConfig(),
            lianlian: fixtureConfig(),
            nowpayments: fixtureConfig(),
            paypal: fixtureConfig(),
            zpay: fixtureConfig(),
          },
        },
      }
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <HostedPaymentSettingsSection serverAddress='https://ru.shinyapi.com' />
      </QueryClientProvider>
    )
    await user.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('tab', { name: 'LianLian' })).toBeVisible()
    expect(get).toHaveBeenCalledWith('/api/option/payments/hosted')
    client.clear()
  })

  it('opens the first deployment-selected provider and keeps removed callbacks configurable', async () => {
    const user = userEvent.setup()
    const removed = {
      ...fixtureConfig(),
      enabled: true,
      accept_new: true,
      deployment_selected: false,
    }
    const put = vi.spyOn(api, 'put').mockResolvedValue({
      data: { success: true, data: { ...removed, accept_new: false } },
    })
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/api/option/payments/operations') {
        return {
          data: {
            success: true,
            data: {
              auto_reconcile_enabled: false,
              interval_minutes: 5,
              batch_size: 20,
              pending_alert_minutes: 30,
            },
          },
        }
      }
      if (url.endsWith('/pending')) {
        return {
          data: { success: true, data: { items: [], total: 0, overdue: 0 } },
        }
      }
      return {
        data: {
          success: true,
          data: {
            cispay: removed,
            lianlian: removed,
            nowpayments: { ...fixtureConfig(), deployment_selected: true },
            paypal: removed,
            zpay: removed,
          },
        },
      }
    })
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <HostedPaymentSettingsSection serverAddress='https://ru.shinyapi.com' />
      </QueryClientProvider>
    )
    expect(
      await screen.findByRole('tab', { name: 'NOWPayments' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tablist')).toHaveClass(
      'max-w-full',
      'overflow-x-auto'
    )
    await user.click(screen.getByRole('tab', { name: 'ZPAY' }))
    expect(screen.getByLabelText('ZPAY merchant key')).toHaveAttribute(
      'type',
      'password'
    )
    expect(
      screen.getByRole('switch', { name: 'Accept new payments' })
    ).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByRole('switch', { name: 'Accept new payments' })
    ).not.toBeChecked()
    expect(
      screen.getByRole('switch', { name: 'Enable payment integration' })
    ).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Verify payment' })).toBeEnabled()
    expect(
      screen.getByText('https://ru.shinyapi.com/api/payments/zpay/webhook/live')
    ).toBeVisible()
    await user.click(
      screen.getByRole('button', { name: 'Save payment integration' })
    )
    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(put.mock.calls[0][1]).toMatchObject({
      provider: 'zpay',
      config: { enabled: true, accept_new: false },
    })
    client.clear()
  })

  it('prevents cisPay sandbox creation while keeping sandbox notification setup available', () => {
    const config = { ...fixtureConfig(), environment: 'test', currency: 'RUB' }
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <HostedProviderForm
          provider='cispay'
          config={config}
          serverAddress='https://test.example.com'
        />
      </QueryClientProvider>
    )
    expect(
      screen.getByRole('switch', { name: 'Accept new payments' })
    ).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByRole('switch', { name: 'Enable payment integration' })
    ).not.toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByText(
        'https://test.example.com/api/payments/cispay/webhook/test'
      )
    ).toBeVisible()
    client.clear()
  })
})
