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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { PaymentConfirmDialog } from '../components/dialogs/payment-confirm-dialog'
import { RechargeFormCard } from '../components/recharge-form-card'
import { SubscriptionPlansCard } from '../components/subscription-plans-card'
import type { TopupInfo } from '../types'

describe('native payment wallet controls', () => {
  it('keeps wallet-only native methods out of subscription checkout', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/api/subscription/plans') {
        return {
          data: {
            success: true,
            data: [
              {
                plan: {
                  id: 1,
                  title: 'Fixture plan',
                  price_amount: 10,
                  duration_unit: 'month',
                  duration_value: 1,
                  quota_reset_period: 'never',
                  enabled: true,
                  sort_order: 0,
                  allow_balance_pay: true,
                  allow_wallet_overflow: true,
                  max_purchase_per_user: 0,
                  total_amount: 500000,
                },
              },
            ],
          },
        }
      }
      return {
        data: {
          success: true,
          data: { subscriptions: [], all_subscriptions: [] },
        },
      }
    })
    render(
      <QueryClientProvider client={queryClient}>
        <SubscriptionPlansCard
          topupInfo={{
            enable_online_topup: true,
            enable_stripe_topup: false,
            min_topup: 1,
            stripe_min_topup: 1,
            amount_options: [],
            discount: {},
            pay_methods: [
              { type: 'nowpayments', name: 'Crypto', min_topup: 1 },
            ],
          }}
        />
      </QueryClientProvider>
    )
    await user.click(
      await screen.findByRole('button', { name: 'Subscribe Now' })
    )
    expect(
      await screen.findByRole('button', { name: 'Pay with Balance' })
    ).toBeVisible()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^Pay$/ })
    ).not.toBeInTheDocument()
    queryClient.clear()
  })
  it.each([false, true])(
    'allows the native minimum when Epay is enabled=%s',
    async (enableEpay) => {
      const user = userEvent.setup()
      const select = vi.fn()
      const topupInfo: TopupInfo = {
        enable_online_topup: enableEpay,
        enable_stripe_topup: false,
        min_topup: 100,
        stripe_min_topup: 100,
        pay_methods: [
          {
            type: 'nowpayments',
            name: 'Crypto',
            min_topup: 1,
            currency: 'USD',
          },
        ],
        amount_options: [],
        discount: {},
      }
      render(
        <RechargeFormCard
          topupInfo={topupInfo}
          presetAmounts={[]}
          selectedPreset={null}
          onSelectPreset={vi.fn()}
          topupAmount={10}
          onTopupAmountChange={vi.fn()}
          paymentAmount={10}
          calculating={false}
          onPaymentMethodSelect={select}
          paymentLoading={null}
          redemptionCode=''
          onRedemptionCodeChange={vi.fn()}
          onRedeem={vi.fn()}
          redeeming={false}
          paymentCurrencySymbol='USD '
        />
      )
      const button = screen.getByRole('button', { name: 'Crypto' })
      expect(button).toBeEnabled()
      expect(
        screen.getByRole('spinbutton', { name: 'Custom Amount' })
      ).toHaveAttribute('min', '1')
      expect(screen.getByText('USD 10')).toBeVisible()
      await user.click(button)
      expect(select).toHaveBeenCalledWith(topupInfo.pay_methods[0])
    }
  )

  it.each([
    { calculating: true, amount: 10 },
    { calculating: false, amount: 0 },
  ])(
    'prevents confirming while calculating=$calculating and amount=$amount',
    (fixture) => {
      render(
        <PaymentConfirmDialog
          open
          onOpenChange={vi.fn()}
          onConfirm={vi.fn()}
          topupAmount={10}
          paymentAmount={fixture.amount}
          paymentMethod={{ type: 'paypal', name: 'PayPal' }}
          calculating={fixture.calculating}
          processing={false}
          paymentCurrencySymbol='USD '
        />
      )
      expect(
        screen.getByRole('button', { name: 'Confirm Payment' })
      ).toBeDisabled()
      expect(
        screen.getByRole('button', { name: 'Confirm Payment' })
      ).toHaveClass('whitespace-normal')
    }
  )
})
