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
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { requestPaymentAmount } from '../../hooks/use-payment'
import {
  hostedCheckoutURL,
  isHostedPayment,
  requestHostedPayment,
} from '../hosted-payment'

afterEach(() => vi.restoreAllMocks())

describe('native hosted payment routing', () => {
  it('quotes the chosen provider without using the Epay price', async () => {
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValue({ data: { message: 'success', data: '10.25' } })
    expect(await requestPaymentAmount(10, 'lianlian')).toBe(10.25)
    expect(post).toHaveBeenCalledWith('/api/user/payments/lianlian/amount', {
      amount: 10,
    })
  })

  it('creates a provider checkout through the same RU origin', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: {
        message: 'success',
        data: { checkout_url: 'https://nowpayments.io/payment/fixture' },
      },
    })
    const result = await requestHostedPayment(10, 'nowpayments')
    expect(result.data?.checkout_url).toBe(
      'https://nowpayments.io/payment/fixture'
    )
    expect(post).toHaveBeenCalledWith('/api/user/payments/nowpayments/pay', {
      amount: 10,
    })
  })

  it('rejects non-HTTPS and credential-bearing checkout locations', () => {
    expect(hostedCheckoutURL('javascript:alert(1)')).toBeNull()
    expect(
      hostedCheckoutURL('http://nowpayments.io/payment/fixture')
    ).toBeNull()
    expect(
      hostedCheckoutURL('https://user:pass@nowpayments.io/payment/fixture')
    ).toBeNull()
    expect(hostedCheckoutURL('https://nowpayments.io/payment/fixture')).toBe(
      'https://nowpayments.io/payment/fixture'
    )
    expect(isHostedPayment('paypal')).toBe(true)
    expect(isHostedPayment('cispay')).toBe(true)
    expect(isHostedPayment('zpay')).toBe(true)
    expect(isHostedPayment('alipay')).toBe(false)
  })
})
