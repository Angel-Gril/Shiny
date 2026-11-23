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
    const get = vi
      .spyOn(api, 'get')
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValue({
        data: {
          success: true,
          data: {
            lianlian: fixtureConfig(),
            nowpayments: fixtureConfig(),
            paypal: fixtureConfig(),
          },
        },
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
    expect(get).toHaveBeenCalledTimes(2)
    client.clear()
  })
})
