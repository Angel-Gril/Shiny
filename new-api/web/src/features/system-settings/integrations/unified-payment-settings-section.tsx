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
import { useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { hostedProviders, type HostedProvider } from './hosted-payment-api'
import { hostedProviderNames } from './hosted-payment-fields'
import { HostedPaymentOperations } from './hosted-payment-operations'
import { HostedPaymentSettingsSection } from './hosted-payment-settings-section'
import { PaymentSettingsSection } from './payment-settings-section'

type UnifiedPaymentSettingsProps = Omit<
  ComponentProps<typeof PaymentSettingsSection>,
  'activeTab' | 'showTabs' | 'showGatewayForm' | 'children'
> & { serverAddress: string }
const originalProviders = ['epay', 'stripe', 'waffo'] as const
const originalProviderNames = { epay: 'Epay', stripe: 'Stripe', waffo: 'Waffo' }
const sharedProviders = {
  creem_native: 'creem',
  waffo_pancake_native: 'waffo-pancake',
} as const

export function UnifiedPaymentSettingsSection(
  props: UnifiedPaymentSettingsProps
) {
  const { t } = useTranslation()
  const [provider, setProvider] = useState('general')
  const [integration, setIntegration] = useState('wallet')
  const [lastHostedProvider, setLastHostedProvider] =
    useState<HostedProvider | null>(null)
  const [visitedOperations, setVisitedOperations] = useState(false)
  const isHosted = hostedProviders.includes(provider as HostedProvider)
  const shared =
    provider === 'creem_native' || provider === 'waffo_pancake_native'
  let originalTab = 'general'
  if (
    originalProviders.includes(provider as (typeof originalProviders)[number])
  ) {
    originalTab = provider
  }
  if (shared) originalTab = sharedProviders[provider]
  const showOriginal =
    provider === 'general' ||
    originalProviders.includes(
      provider as (typeof originalProviders)[number]
    ) ||
    (shared && integration === 'original')
  const items = [
    { value: 'general', label: t('General') },
    { value: 'operations', label: t('Payment reconciliation') },
    ...originalProviders.map((value) => ({
      value,
      label: originalProviderNames[value],
    })),
    ...hostedProviders.map((value) => ({
      value,
      label: hostedProviderNames[value],
    })),
  ]
  const selector = (
    <div className='space-y-4'>
      <div className='w-full space-y-2 sm:max-w-sm'>
        <Label htmlFor='payment-provider'>{t('Payment provider')}</Label>
        <Select
          items={items}
          value={provider}
          onValueChange={(value) => {
            if (!value) return
            setProvider(value)
            if (value === 'operations') setVisitedOperations(true)
            setIntegration('wallet')
            if (hostedProviders.includes(value as HostedProvider)) {
              setLastHostedProvider(value as HostedProvider)
            }
          }}
        >
          <SelectTrigger id='payment-provider' className='w-full'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      {shared && (
        <>
          <RadioGroup
            aria-label={t('Payment integration')}
            value={integration}
            onValueChange={(value) => setIntegration(String(value))}
            className='flex flex-wrap gap-x-6 gap-y-3'
          >
            <Label htmlFor='payment-wallet'>
              <RadioGroupItem id='payment-wallet' value='wallet' />
              {t('Wallet top-up')}
            </Label>
            <Label htmlFor='payment-original'>
              <RadioGroupItem id='payment-original' value='original' />
              {t('Original integration')}
            </Label>
          </RadioGroup>
          <Alert>
            <AlertDescription>
              {t(
                'Wallet top-ups and the original integration keep separate credentials and callbacks. The original integration also supports wallet payments and subscriptions. Choose one integration for the same merchant payment method; switching this view does not enable, disable or migrate payments.'
              )}
            </AlertDescription>
          </Alert>
        </>
      )}
      {showOriginal && (
        <p className='text-muted-foreground text-sm'>
          {t(
            'Save original gateway settings applies only to drafts in the original integration. Wallet integrations and reconciliation have their own save buttons.'
          )}
        </p>
      )}
    </div>
  )
  return (
    <div className='min-w-0 space-y-6'>
      <PaymentSettingsSection
        {...props}
        activeTab={showOriginal ? originalTab : 'general'}
        showTabs={false}
        showGatewayForm={showOriginal}
      >
        {selector}
      </PaymentSettingsSection>
      {lastHostedProvider && (
        <div hidden={!isHosted || (shared && integration === 'original')}>
          <HostedPaymentSettingsSection
            serverAddress={props.serverAddress}
            provider={lastHostedProvider}
          />
        </div>
      )}
      {visitedOperations && (
        <div hidden={provider !== 'operations'}>
          <HostedPaymentOperations />
        </div>
      )}
    </div>
  )
}
