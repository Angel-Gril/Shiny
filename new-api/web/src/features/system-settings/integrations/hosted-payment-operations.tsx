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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'

import { CopyButton } from '@/components/copy-button'
import { StaticDataTable } from '@/components/data-table'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { paymentCheckLabels } from '@/features/wallet/lib/hosted-payment'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber, formatTimestampToDate } from '@/lib/format'

import {
  SettingsForm,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '../components/settings-form-layout'
import {
  getPaymentOperations,
  getPendingPayments,
  reconcileHostedPayment,
  savePaymentOperations,
  type HostedProvider,
  type PaymentOperations,
} from './hosted-payment-api'

function PaymentOperationsForm(props: { values: PaymentOperations }) {
  const { t } = useTranslation()
  const operationsSchema = z.object({
    auto_reconcile_enabled: z.boolean(),
    interval_minutes: z
      .number()
      .int({
        error: t('Enter a whole number between {{min}} and {{max}}', {
          min: 1,
          max: 1440,
        }),
      })
      .min(1, {
        error: t('Enter a whole number between {{min}} and {{max}}', {
          min: 1,
          max: 1440,
        }),
      })
      .max(1440, {
        error: t('Enter a whole number between {{min}} and {{max}}', {
          min: 1,
          max: 1440,
        }),
      }),
    batch_size: z
      .number()
      .int({
        error: t('Enter a whole number between {{min}} and {{max}}', {
          min: 1,
          max: 100,
        }),
      })
      .min(1, {
        error: t('Enter a whole number between {{min}} and {{max}}', {
          min: 1,
          max: 100,
        }),
      })
      .max(100, {
        error: t('Enter a whole number between {{min}} and {{max}}', {
          min: 1,
          max: 100,
        }),
      }),
    pending_alert_minutes: z
      .number()
      .int({
        error: t('Enter a whole number between {{min}} and {{max}}', {
          min: 5,
          max: 10080,
        }),
      })
      .min(5, {
        error: t('Enter a whole number between {{min}} and {{max}}', {
          min: 5,
          max: 10080,
        }),
      })
      .max(10080, {
        error: t('Enter a whole number between {{min}} and {{max}}', {
          min: 5,
          max: 10080,
        }),
      }),
  })
  const client = useQueryClient()
  const form = useForm<PaymentOperations>({
    resolver: zodResolver(operationsSchema),
    defaultValues: props.values,
  })
  const save = useMutation({
    mutationFn: savePaymentOperations,
    onSuccess: (values) => {
      form.reset(values)
      client.setQueryData(['hosted-payment-operations'], values)
      void client.invalidateQueries({ queryKey: ['hosted-payment-pending'] })
      toast.success(t('Configuration saved'))
    },
  })
  const fields = [
    {
      name: 'interval_minutes',
      label: 'Reconciliation interval (minutes)',
      min: 1,
      max: 1440,
    },
    {
      name: 'batch_size',
      label: 'Orders per reconciliation run',
      min: 1,
      max: 100,
    },
    {
      name: 'pending_alert_minutes',
      label: 'Pending payment alert (minutes)',
      min: 5,
      max: 10080,
    },
  ] as const
  return (
    <Form {...form}>
      <SettingsForm
        data-no-autosubmit='true'
        onSubmit={form.handleSubmit((values) => save.mutate(values))}
      >
        <FormField
          control={form.control}
          name='auto_reconcile_enabled'
          render={({ field }) => (
            <SettingsSwitchItem>
              <SettingsSwitchContent>
                <FormLabel>{t('Automatic payment reconciliation')}</FormLabel>
                <FormDescription>
                  {t(
                    'Queries saved orders with the provider. Only verified completed payments are credited; new sales can remain paused.'
                  )}
                </FormDescription>
              </SettingsSwitchContent>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </SettingsSwitchItem>
          )}
        />
        <div className='grid gap-4 md:grid-cols-3'>
          {fields.map((item) => (
            <FormField
              key={item.name}
              name={item.name}
              control={form.control}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t(item.label)}</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={item.min}
                      max={item.max}
                      step={1}
                      {...field}
                      onChange={(event) =>
                        field.onChange(event.target.valueAsNumber)
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          ))}
        </div>
        <p className='text-muted-foreground text-sm'>
          {t(
            'Long-pending alerts use administrator channel notification preferences. Results appear in System Info tasks. Missing provider references require support recovery.'
          )}
        </p>
        <Button className='w-fit' type='submit' disabled={save.isPending}>
          {t('Save reconciliation settings')}
        </Button>
      </SettingsForm>
    </Form>
  )
}

export function HostedPaymentOperations() {
  const query = useQuery({
    queryKey: ['hosted-payment-operations'],
    queryFn: getPaymentOperations,
  })
  if (query.isPending) return <LoadingState />
  if (query.isError || !query.data) {
    return <ErrorState onRetry={() => void query.refetch()} />
  }
  return <PaymentOperationsForm values={query.data} />
}

export function HostedPendingPayments(props: { provider: HostedProvider }) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['hosted-payment-pending', props.provider],
    queryFn: () => getPendingPayments(props.provider),
    refetchInterval: 60000,
  })
  const verify = useMutation({
    mutationFn: (trade_no: string) =>
      reconcileHostedPayment(props.provider, {
        trade_no,
        remote_id: '',
        payment_id: '',
      }),
    onSuccess: (result) => {
      toast.success(
        t(
          result.paid
            ? 'Payment verified and credited'
            : 'Payment is not completed yet'
        )
      )
      void client.invalidateQueries({ queryKey: ['hosted-payment-pending'] })
    },
  })
  if (query.isPending) return <LoadingState />
  if (query.isError || !query.data) {
    return <ErrorState onRetry={() => void query.refetch()} />
  }
  return (
    <div className='min-w-0 space-y-3'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <h4 className='font-medium'>{t('Pending payments')}</h4>
        <Button
          variant='outline'
          size='sm'
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          {t('Refresh')}
        </Button>
      </div>
      <p className='text-muted-foreground text-sm'>
        {t('Pending')}: {formatNumber(query.data.total, locale)} ·{' '}
        {t('Overdue')}: {formatNumber(query.data.overdue, locale)}
      </p>
      <StaticDataTable
        data={query.data.items}
        getRowKey={(item) => item.trade_no}
        emptyContent={t('No pending payments')}
        columns={[
          {
            id: 'order',
            header: t('Shiny order number'),
            cell: (item) => (
              <div className='flex items-center gap-2'>
                <code className='max-w-56 truncate text-xs'>
                  {item.trade_no}
                </code>
                <CopyButton value={item.trade_no} size='sm' />
              </div>
            ),
          },
          {
            id: 'amount',
            header: t('Payment'),
            cell: (item) => `${item.currency} ${item.payment_amount}`,
          },
          {
            id: 'state',
            header: t('Status'),
            cell: (item) => (
              <div className='max-w-64 text-xs whitespace-normal'>
                <p>
                  {t(
                    paymentCheckLabels[item.check_status] ||
                      'After payment, check this order before paying again.'
                  )}
                </p>
                <p className='text-muted-foreground'>
                  {item.last_checked_at
                    ? formatTimestampToDate(item.last_checked_at)
                    : t('Not checked yet')}
                </p>
              </div>
            ),
          },
          {
            id: 'action',
            header: t('Actions'),
            cell: (item) => (
              <Button
                variant='outline'
                size='sm'
                disabled={verify.isPending}
                onClick={() => verify.mutate(item.trade_no)}
              >
                {t(
                  verify.isPending && verify.variables === item.trade_no
                    ? 'Verifying...'
                    : 'Verify payment'
                )}
              </Button>
            ),
          },
        ]}
      />
      <p className='text-muted-foreground text-xs'>
        {t(
          'Up to 100 pending orders are shown. For a missing reference, use the recovery form below after checking the provider dashboard.'
        )}
      </p>
    </div>
  )
}
