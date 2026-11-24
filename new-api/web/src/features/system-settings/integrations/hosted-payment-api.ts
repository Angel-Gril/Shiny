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
import { requireServerSuccess } from '@/lib/server-error-message'

export const hostedProviders = [
  'cispay',
  'lianlian',
  'nowpayments',
  'paypal',
  'zpay',
] as const
export type HostedProvider = (typeof hostedProviders)[number]

export interface HostedPaymentConfig {
  enabled: boolean
  accept_new: boolean
  environment: string
  currency: string
  unit_price: string
  min_topup: number
  account_id: string
  api_key: string
  api_secret: string
  webhook_secret: string
  signature_type: string
  private_key: string
  platform_public_key: string
  store_id: string
  user_id: string
  developer_user_id: string
  on_behalf_of: string
  country_code: string
  checkout_hosts: string[]
  goods_url: string
  shipping_provider: string
  pay_currency: string
  payment_method: string
  client_id: string
  client_secret: string
  merchant_id: string
  webhook_id: string
  secrets_configured?: string[]
  deployment_selected?: boolean
}

interface HostedResponse<T> {
  success: boolean
  data: T
}

export async function getHostedSettings(): Promise<
  Record<HostedProvider, HostedPaymentConfig>
> {
  const response = await api.get<
    HostedResponse<Record<HostedProvider, HostedPaymentConfig>>
  >('/api/option/payments/hosted')
  return requireServerSuccess(response.data).data
}

export async function saveHostedSettings(
  provider: HostedProvider,
  config: HostedPaymentConfig
): Promise<HostedPaymentConfig> {
  const response = await api.put<HostedResponse<HostedPaymentConfig>>(
    '/api/option/payments/hosted',
    { provider, config }
  )
  return requireServerSuccess(response.data).data
}

export async function reconcileHostedPayment(
  provider: HostedProvider,
  values: { trade_no: string; remote_id: string; payment_id: string }
): Promise<{ paid: boolean }> {
  const response = await api.post<HostedResponse<{ paid: boolean }>>(
    `/api/option/payments/${provider}/reconcile`,
    values
  )
  return requireServerSuccess(response.data).data
}
