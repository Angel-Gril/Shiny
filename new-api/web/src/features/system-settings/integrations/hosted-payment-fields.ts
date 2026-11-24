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
  payment_method: z.string(),
  client_id: z.string(),
  client_secret: z.string(),
  merchant_id: z.string(),
  webhook_id: z.string(),
  product_id: z.string(),
  tax_category: z.string(),
  api_variant: z.string(),
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
  cispay: 'cisPay',
  lianlian: 'LianLian',
  nowpayments: 'NOWPayments',
  paypal: 'PayPal',
  zpay: 'ZPAY',
  creem_native: 'Creem',
  waffo_pancake_native: 'Waffo Pancake',
  platega: 'Platega',
  freekassa: 'FreeKassa',
  lava: 'Lava.top',
  cryptocloud: 'CryptoCloud / Trybit',
  oxapay: 'OxaPay',
  apirone: 'Apirone',
}

export const hostedLiveOnlyProviders: HostedProvider[] = [
  'nowpayments',
  'zpay',
  'platega',
  'freekassa',
  'lava',
  'apirone',
]

export const hostedApprovedHostProviders: HostedProvider[] = [
  'cispay',
  'lianlian',
  'zpay',
  'freekassa',
  'lava',
  'cryptocloud',
]

export const hostedProviderGuides: Partial<Record<HostedProvider, string>> = {
  creem_native:
    'Use an active one-time Creem product with inclusive tax and business net pricing disabled. Custom top-ups require 1.00 to 999999.99 in the product currency.',
  waffo_pancake_native:
    'Use a one-time Waffo Pancake product and the matching merchant key. Checkout opens in Russian with inclusive tax. Existing package and subscription settings remain separate.',
  platega:
    'Leave the payment method blank for the Platega V2 checkout, or choose a documented method ID. A valid account email is required for buyer identification.',
  freekassa:
    'The FreeKassa API key and Secret Word 2 are different credentials. Set the notification and return URLs in the merchant dashboard. Confirm that the chosen method needs only email and IP.',
  lava: 'Publish a one-time Lava.top offer with Price on request via API enabled. Configure webhook authentication with a separate service API key. Lost invoice IDs require support recovery.',
  cryptocloud:
    'CryptoCloud documentation now uses Trybit. Select the endpoint matching your project credentials and exact checkout hosts. Only a fully paid invoice credits the saved USD amount.',
  oxapay:
    'Use an OxaPay Merchant API key. The hosted invoice uses USD, no underpayment tolerance, and the coins enabled in your merchant account. The same key verifies webhook signatures.',
  apirone:
    'Use an Apirone account and transfer key with an exact coin and network. Each invoice saves its USD exchange rate and coin amount. Credit requires a completed invoice verified through the private account API.',
}

export const hostedProviderDocs: Record<HostedProvider, string> = {
  cispay: 'https://cispay.app/developers',
  lianlian: 'https://global.lianlianpay.com/docs/api_docs',
  nowpayments: 'https://documenter.getpostman.com/view/7907941/S1a32n38',
  paypal: 'https://developer.paypal.com/docs/api/orders/v2/',
  zpay: 'https://z-pay.cn/doc.html',
  creem_native: 'https://docs.creem.io/api-reference/endpoint/create-checkout',
  waffo_pancake_native:
    'https://docs.waffo.ai/api-reference/endpoints/checkout/create-session',
  platega: 'https://docs.platega.io/',
  freekassa: 'https://docs.freekassa.net/',
  lava: 'https://developers.lava.top/en',
  cryptocloud: 'https://docs.trybit.com/api-reference-v2/create-invoice',
  oxapay: 'https://docs.oxapay.com/api-reference/payment/generate-invoice',
  apirone: 'https://apirone.com/docs/invoices/',
}
export const hostedProviderFields: Record<HostedProvider, HostedTextField[]> = {
  cispay: [
    { key: 'store_id', label: 'cisPay Shop ID' },
    { key: 'api_key', label: 'cisPay API Key', secret: true },
    {
      key: 'payment_method',
      label: 'cisPay payment method (CARD, SBP, CRYPTO)',
    },
  ],
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
  zpay: [
    { key: 'merchant_id', label: 'ZPAY merchant ID' },
    { key: 'api_secret', label: 'ZPAY merchant key', secret: true },
    { key: 'payment_method', label: 'ZPAY payment method (alipay, wxpay)' },
  ],
  creem_native: [
    { key: 'account_id', label: 'Merchant account reference' },
    { key: 'api_key', label: 'API Key', secret: true },
    { key: 'webhook_secret', label: 'Webhook signing secret', secret: true },
    { key: 'product_id', label: 'Creem one-time product ID' },
  ],
  waffo_pancake_native: [
    { key: 'merchant_id', label: 'Merchant ID' },
    { key: 'store_id', label: 'Store ID' },
    { key: 'product_id', label: 'Waffo Pancake one-time product ID' },
    {
      key: 'tax_category',
      label: 'Product tax category (saas, digital_goods, software)',
    },
    {
      key: 'private_key',
      label: 'Merchant private key (RSA)',
      secret: true,
      multiline: true,
    },
    {
      key: 'platform_public_key',
      label: 'Webhook public key (optional)',
      multiline: true,
    },
  ],
  platega: [
    { key: 'merchant_id', label: 'Merchant ID' },
    { key: 'api_secret', label: 'Platega X-Secret', secret: true },
    {
      key: 'payment_method',
      label: 'Platega method ID (2, 3, 11, 12, 13, 14; optional)',
    },
  ],
  freekassa: [
    { key: 'merchant_id', label: 'FreeKassa Shop ID' },
    { key: 'api_key', label: 'API Key', secret: true },
    { key: 'webhook_secret', label: 'FreeKassa Secret Word 2', secret: true },
    { key: 'payment_method', label: 'FreeKassa payment method ID' },
  ],
  lava: [
    { key: 'account_id', label: 'Merchant account reference' },
    { key: 'api_key', label: 'API Key', secret: true },
    { key: 'webhook_secret', label: 'Webhook service API key', secret: true },
    { key: 'product_id', label: 'Lava.top offer ID' },
    { key: 'payment_method', label: 'Lava.top payment provider (optional)' },
  ],
  cryptocloud: [
    { key: 'account_id', label: 'CryptoCloud Shop ID' },
    { key: 'api_key', label: 'API Key', secret: true },
    { key: 'webhook_secret', label: 'Project JWT secret', secret: true },
    { key: 'pay_currency', label: 'Coin and network code (optional)' },
  ],
  oxapay: [
    { key: 'account_id', label: 'Merchant account reference' },
    { key: 'api_key', label: 'OxaPay Merchant API key', secret: true },
  ],
  apirone: [
    { key: 'account_id', label: 'Apirone account ID' },
    { key: 'api_key', label: 'Apirone transfer key', secret: true },
    {
      key: 'webhook_secret',
      label: 'Apirone callback secret (at least 32 characters)',
      secret: true,
    },
    { key: 'pay_currency', label: 'Apirone coin and network code' },
  ],
}
