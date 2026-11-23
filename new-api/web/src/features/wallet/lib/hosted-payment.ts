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
import { api } from '@/lib/api'

import type { AmountResponse, PaymentResponse } from '../types'

export function isHostedPayment(type: string): boolean {
  return ['lianlian', 'nowpayments', 'paypal'].includes(type)
}

export async function calculateHostedAmount(
  amount: number,
  provider: string
): Promise<AmountResponse> {
  const response = await api.post<AmountResponse>(
    `/api/user/payments/${provider}/amount`,
    { amount }
  )
  return response.data
}

export async function requestHostedPayment(
  amount: number,
  provider: string
): Promise<PaymentResponse> {
  const response = await api.post<PaymentResponse>(
    `/api/user/payments/${provider}/pay`,
    { amount }
  )
  return response.data
}

export function hostedCheckoutURL(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}
