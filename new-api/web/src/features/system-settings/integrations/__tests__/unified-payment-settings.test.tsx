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
import { useState, type ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { getBillingSectionNavItems } from '../../billing/section-registry'
import { SettingsPageProvider } from '../../components/settings-page-context'
import {
  hostedProviders,
  type HostedPaymentConfig,
} from '../hosted-payment-api'
import { UnifiedPaymentSettingsSection } from '../unified-payment-settings-section'

const legacyDefaults = {
  PayAddress: '',
  EpayId: '',
  EpayKey: '',
  EpaySignType: 'MD5',
  EpayMerchantPrivateKey: '',
  EpayPlatformPublicKey: '',
  Price: 7.3,
  MinTopUp: 1,
  CustomCallbackAddress: '',
  PayMethods: '[]',
  AmountOptions: '[]',
  AmountDiscount: '{}',
  StripeApiSecret: '',
  StripeWebhookSecret: '',
  StripePriceId: '',
  StripeUnitPrice: 8,
  StripeMinTopUp: 1,
  StripePromotionCodesEnabled: false,
  CreemApiKey: '',
  CreemWebhookSecret: '',
  CreemTestMode: false,
  CreemProducts: '[]',
}
const config: HostedPaymentConfig = {
  enabled: false,
  accept_new: false,
  environment: 'live',
  currency: 'USD',
  unit_price: '1',
  min_topup: 1,
  account_id: '',
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
  product_id: '',
  tax_category: 'saas',
  api_variant: 'trybit',
}

function Fixture() {
  const [actions, setActions] = useState<HTMLDivElement | null>(null)
  const props: ComponentProps<typeof UnifiedPaymentSettingsSection> = {
    serverAddress: 'https://ru.example.com',
    defaultValues: legacyDefaults,
    waffoDefaultValues: {
      WaffoEnabled: false,
      WaffoApiKey: '',
      WaffoPrivateKey: '',
      WaffoPublicCert: '',
      WaffoSandboxPublicCert: '',
      WaffoSandboxApiKey: '',
      WaffoSandboxPrivateKey: '',
      WaffoSandbox: false,
      WaffoMerchantId: '',
      WaffoCurrency: 'USD',
      WaffoUnitPrice: 1,
      WaffoMinTopUp: 1,
      WaffoNotifyUrl: '',
      WaffoReturnUrl: '',
      WaffoPayMethods: '[]',
    },
    waffoPancakeDefaultValues: {
      WaffoPancakeMerchantID: '',
      WaffoPancakePrivateKey: '',
      WaffoPancakeReturnURL: '',
    },
    complianceDefaults: {
      confirmed: true,
      termsVersion: 'v1',
      confirmedAt: 1,
      confirmedBy: 1,
    },
  }
  return (
    <SettingsPageProvider actionsContainer={actions}>
      <div ref={setActions} />
      <UnifiedPaymentSettingsSection {...props} />
    </SettingsPageProvider>
  )
}

function setup() {
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
    return {
      data: {
        success: true,
        data: Object.fromEntries(hostedProviders.map((p) => [p, config])),
      },
    }
  })
  const put = vi.spyOn(api, 'put').mockImplementation(async (url, body) => {
    if (url === '/api/option/payments/hosted') {
      return {
        data: {
          success: true,
          data: (body as { config: HostedPaymentConfig }).config,
        },
      }
    }
    return { data: { success: true } }
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Fixture />
    </QueryClientProvider>
  )
  return { user: userEvent.setup(), get, put, client }
}

afterEach(() => vi.restoreAllMocks())

it('offers one payment navigation entry and one choice per provider', async () => {
  const nav = getBillingSectionNavItems(
    ((key: string) => key) as Parameters<typeof getBillingSectionNavItems>[0]
  )
  expect(nav.filter((item) => item.url.endsWith('/payment'))).toHaveLength(1)
  expect(nav.some((item) => item.url.endsWith('/international-payments'))).toBe(
    false
  )
  const { user, client } = setup()
  await user.click(screen.getByRole('combobox', { name: 'Payment provider' }))
  expect(screen.getAllByRole('option', { name: 'Waffo Pancake' })).toHaveLength(
    1
  )
  expect(screen.getAllByRole('option', { name: 'Creem' })).toHaveLength(1)
  client.clear()
})

it('keeps original drafts across provider switches and saves only on explicit action', async () => {
  const { user, put, client } = setup()
  const price = screen.getByLabelText('Price (local currency / USD)')
  await user.click(price)
  await user.keyboard('{Control>}a{/Control}8.5')
  await user.click(screen.getByRole('combobox', { name: 'Payment provider' }))
  await user.click(screen.getByRole('option', { name: 'Creem' }))
  expect(
    await screen.findByText(
      'https://ru.example.com/api/payments/creem_native/webhook/live'
    )
  ).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Save original gateway settings' })
  ).not.toBeInTheDocument()
  await user.click(screen.getByRole('radio', { name: 'Original integration' }))
  expect(screen.getByPlaceholderText('Enter Creem API key')).toBeVisible()
  expect(screen.getByPlaceholderText('Enter Creem API key')).toHaveValue('')
  expect(put).not.toHaveBeenCalled()
  await user.click(screen.getByRole('combobox', { name: 'Payment provider' }))
  await user.click(screen.getByRole('option', { name: 'General' }))
  expect(screen.getByLabelText('Price (local currency / USD)')).toHaveValue(8.5)
  await user.click(
    screen.getByRole('button', { name: 'Save original gateway settings' })
  )
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith('/api/option/', {
      key: 'Price',
      value: 8.5,
    })
  )
  client.clear()
})

it('saves wallet settings to their own endpoint and retains an unsaved wallet draft', async () => {
  const { user, put, client } = setup()
  await user.click(screen.getByRole('combobox', { name: 'Payment provider' }))
  await user.click(screen.getByRole('option', { name: 'Creem' }))
  await screen.findByText(
    'https://ru.example.com/api/payments/creem_native/webhook/live'
  )
  const amount = screen.getByRole('textbox', {
    name: 'Payment currency units per USD credit',
  })
  await user.clear(amount)
  await user.type(amount, '1.2')
  await user.click(screen.getByRole('radio', { name: 'Original integration' }))
  await user.click(screen.getByRole('radio', { name: 'Wallet top-up' }))
  expect(
    screen.getByRole('textbox', {
      name: 'Payment currency units per USD credit',
    })
  ).toHaveValue('1.2')
  await user.click(screen.getByRole('combobox', { name: 'Payment provider' }))
  await user.click(screen.getByRole('option', { name: 'NOWPayments' }))
  await screen.findByText(
    'https://ru.example.com/api/payments/nowpayments/webhook/live'
  )
  await user.click(screen.getByRole('combobox', { name: 'Payment provider' }))
  await user.click(screen.getByRole('option', { name: 'Creem' }))
  expect(
    screen.getByRole('textbox', {
      name: 'Payment currency units per USD credit',
    })
  ).toBeVisible()
  expect(
    screen.getByRole('textbox', {
      name: 'Payment currency units per USD credit',
    })
  ).toHaveValue('1.2')
  expect(put).not.toHaveBeenCalled()
  await user.click(
    screen.getByRole('button', { name: 'Save payment integration' })
  )
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith(
      '/api/option/payments/hosted',
      expect.objectContaining({
        provider: 'creem_native',
        config: expect.objectContaining({ unit_price: '1.2', api_key: '' }),
      })
    )
  )
  expect(
    put.mock.calls.every((call) => call[0] === '/api/option/payments/hosted')
  ).toBe(true)
  client.clear()
})

it('keeps keyboard selection accessible and exposes both Pancake integrations without saving', async () => {
  const { user, put, client } = setup()
  await user.click(screen.getByRole('combobox', { name: 'Payment provider' }))
  await user.click(screen.getByRole('option', { name: 'Waffo Pancake' }))
  await screen.findByText(
    'https://ru.example.com/api/payments/waffo_pancake_native/webhook/live'
  )
  const wallet = screen.getByRole('radio', { name: 'Wallet top-up' })
  wallet.focus()
  await user.keyboard('{ArrowRight}')
  expect(
    screen.getByRole('radio', { name: 'Original integration' })
  ).toBeChecked()
  expect(screen.getByText('Waffo Pancake MoR')).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Save payment integration' })
  ).not.toBeInTheDocument()
  expect(put).not.toHaveBeenCalled()
  client.clear()
})

it('shows a wallet loading failure and retries without losing original drafts', async () => {
  const { user, get, put, client } = setup()
  const fallback = get.getMockImplementation()
  if (!fallback) throw new Error('Missing fixture API')
  let failed = false
  get.mockImplementation(async (url, ...args) => {
    if (url === '/api/option/payments/hosted' && !failed) {
      failed = true
      throw new Error('fixture unavailable')
    }
    return fallback(url, ...args)
  })
  await user.click(screen.getByRole('combobox', { name: 'Payment provider' }))
  await user.click(screen.getByRole('option', { name: 'Creem' }))
  await user.click(await screen.findByRole('button', { name: 'Retry' }))
  expect(
    await screen.findByText(
      'https://ru.example.com/api/payments/creem_native/webhook/live'
    )
  ).toBeVisible()
  expect(put).not.toHaveBeenCalled()
  client.clear()
})
