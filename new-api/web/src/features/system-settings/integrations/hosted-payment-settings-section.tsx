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
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { SettingsForm } from '../components/settings-form-layout'
import { SettingsSection } from '../components/settings-section'
import {
  getHostedSettings,
  hostedProviders,
  reconcileHostedPayment,
  type HostedProvider,
} from './hosted-payment-api'
import { hostedProviderNames } from './hosted-payment-fields'
import { HostedProviderForm } from './hosted-provider-form'

const reconcileSchema = z.object({
  trade_no: z.string().min(1),
  remote_id: z.string(),
  payment_id: z.string(),
})

function HostedReconcileForm(props: { provider: HostedProvider }) {
  const { t } = useTranslation()
  const form = useForm<z.infer<typeof reconcileSchema>>({
    resolver: zodResolver(reconcileSchema),
    defaultValues: { trade_no: '', remote_id: '', payment_id: '' },
  })
  const reconcile = useMutation({
    mutationFn: (values: z.infer<typeof reconcileSchema>) =>
      reconcileHostedPayment(props.provider, values),
    onSuccess: (result) =>
      toast.success(
        t(
          result.paid
            ? 'Payment verified and credited'
            : 'Payment is not completed yet'
        )
      ),
  })
  const fields = [
    { key: 'trade_no', label: 'Shiny order number' },
    { key: 'remote_id', label: 'Provider order ID (optional)' },
    { key: 'payment_id', label: 'NOWPayments Payment ID (optional)' },
  ] as const
  return (
    <Form {...form}>
      <SettingsForm
        onSubmit={form.handleSubmit((values) => reconcile.mutate(values))}
        data-no-autosubmit='true'
      >
        <h4 className='font-medium'>{t('Verify and recover a payment')}</h4>
        {fields.map((item) => (
          <FormField
            key={item.key}
            control={form.control}
            name={item.key}
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t(item.label)}</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        ))}
        <p className='text-muted-foreground text-sm'>
          {t(
            'Recovery queries the provider and credits only a verified completed payment. An invoice ID is not a NOWPayments Payment ID.'
          )}
        </p>
        <Button
          className='w-fit'
          type='submit'
          variant='outline'
          disabled={reconcile.isPending}
        >
          {t(reconcile.isPending ? 'Verifying...' : 'Verify payment')}
        </Button>
      </SettingsForm>
    </Form>
  )
}

export function HostedPaymentSettingsSection(props: { serverAddress: string }) {
  const { t } = useTranslation()
  const [provider, setProvider] = useState<HostedProvider>('lianlian')
  const query = useQuery({
    queryKey: ['hosted-payments'],
    queryFn: getHostedSettings,
  })
  if (query.isPending) return <LoadingState />
  if (query.isError || !query.data) {
    return <ErrorState onRetry={() => void query.refetch()} />
  }
  return (
    <SettingsSection title={t('International payments')}>
      <Tabs
        value={provider}
        onValueChange={(value) => {
          if (hostedProviders.includes(value as HostedProvider)) {
            setProvider(value as HostedProvider)
          }
        }}
      >
        <TabsList>
          {hostedProviders.map((item) => (
            <TabsTrigger key={item} value={item}>
              {hostedProviderNames[item]}
            </TabsTrigger>
          ))}
        </TabsList>
        {hostedProviders.map((item) => (
          <TabsContent
            key={item}
            value={item}
            className='mt-6 min-w-0 space-y-6'
          >
            <HostedProviderForm
              provider={item}
              config={query.data[item]}
              serverAddress={props.serverAddress}
            />
            <Separator />
            <HostedReconcileForm provider={item} />
          </TabsContent>
        ))}
      </Tabs>
    </SettingsSection>
  )
}
