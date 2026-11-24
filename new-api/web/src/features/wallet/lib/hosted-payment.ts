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

import type {
  ApiResponse,
  AmountResponse,
  PaymentResponse,
  TopupRecord,
} from '../types'

export function isHostedPayment(type: string): boolean {
  return ['cispay', 'lianlian', 'nowpayments', 'paypal', 'zpay'].includes(type)
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

export const paymentCheckLabels: Record<string, string> = {
  pending: 'Payment is not completed yet',
  paid: 'Payment verified and credited',
  needs_reference: 'Payment needs support verification',
  configuration_unavailable: 'Payment needs support verification',
  verification_failed: 'Payment verification unavailable; try again later',
}

export async function checkHostedPayment(
  record: TopupRecord
): Promise<ApiResponse<{ status: string; payment_check_status: string }>> {
  const provider = record.payment_provider || record.payment_method
  if (!isHostedPayment(provider)) {
    throw new Error('Unsupported payment provider')
  }
  const response = await api.post<
    ApiResponse<{ status: string; payment_check_status: string }>
  >(`/api/user/payments/${provider}/check`, { trade_no: record.trade_no })
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
