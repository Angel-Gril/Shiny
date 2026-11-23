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
import { z } from 'zod'

import type { HostedProvider } from './hosted-payment-api'

export const hostedConfigSchema = z.object({
  enabled: z.boolean(),
  accept_new: z.boolean(),
  environment: z.string(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Enter a three-letter currency code'),
  unit_price: z.string().regex(/^\d+(\.\d+)?$/, 'Enter a positive price'),
  min_topup: z.number().int().min(1),
  account_id: z.string(),
  api_key: z.string(),
  api_secret: z.string(),
  webhook_secret: z.string(),
  signature_type: z.string(),
  private_key: z.string(),
  platform_public_key: z.string(),
  store_id: z.string(),
  user_id: z.string(),
  developer_user_id: z.string(),
  on_behalf_of: z.string(),
  country_code: z.string(),
  checkout_hosts: z.array(z.string()),
  goods_url: z.string(),
  shipping_provider: z.string(),
  pay_currency: z.string(),
  client_id: z.string(),
  client_secret: z.string(),
  merchant_id: z.string(),
  webhook_id: z.string(),
})

export type HostedConfigValues = z.infer<typeof hostedConfigSchema>
export type HostedTextField = {
  key: keyof Omit<
    HostedConfigValues,
    'enabled' | 'accept_new' | 'min_topup' | 'checkout_hosts'
  >
  label: string
  secret?: boolean
  multiline?: boolean
}

export const hostedProviderNames: Record<HostedProvider, string> = {
  lianlian: 'LianLian',
  nowpayments: 'NOWPayments',
  paypal: 'PayPal',
}
export const hostedProviderFields: Record<HostedProvider, HostedTextField[]> = {
  lianlian: [
    { key: 'api_key', label: 'API Key', secret: true },
    { key: 'api_secret', label: 'API Secret (Base64)', secret: true },
    { key: 'webhook_secret', label: 'Webhook signing secret', secret: true },
    { key: 'store_id', label: 'Store ID' },
    { key: 'user_id', label: 'Merchant user ID' },
    { key: 'developer_user_id', label: 'Developer user ID' },
    { key: 'country_code', label: 'Acquiring country code' },
    { key: 'on_behalf_of', label: 'On behalf of (optional)' },
    { key: 'goods_url', label: 'Approved product URL' },
    { key: 'shipping_provider', label: 'Approved shipping provider code' },
    {
      key: 'private_key',
      label: 'Merchant private key (RSA)',
      secret: true,
      multiline: true,
    },
    {
      key: 'platform_public_key',
      label: 'Platform public key (RSA)',
      multiline: true,
    },
  ],
  nowpayments: [
    { key: 'account_id', label: 'Merchant account reference' },
    { key: 'api_key', label: 'API Key', secret: true },
    { key: 'webhook_secret', label: 'IPN secret', secret: true },
    { key: 'pay_currency', label: 'Coin and network code (optional)' },
  ],
  paypal: [
    { key: 'client_id', label: 'Client ID', secret: true },
    { key: 'client_secret', label: 'Client secret', secret: true },
    { key: 'merchant_id', label: 'Merchant ID' },
    { key: 'webhook_id', label: 'Webhook ID' },
  ],
}
