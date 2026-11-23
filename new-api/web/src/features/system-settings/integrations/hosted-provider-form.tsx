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
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { CopyButton } from '@/components/copy-button'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

import {
  SettingsForm,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '../components/settings-form-layout'
import {
  saveHostedSettings,
  type HostedPaymentConfig,
  type HostedProvider,
} from './hosted-payment-api'
import {
  hostedConfigSchema,
  hostedProviderFields,
  type HostedConfigValues,
  type HostedTextField,
} from './hosted-payment-fields'

export function HostedProviderForm(props: {
  provider: HostedProvider
  config: HostedPaymentConfig
  serverAddress: string
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const form = useForm<HostedConfigValues>({
    resolver: zodResolver(hostedConfigSchema),
    defaultValues: props.config,
  })
  const save = useMutation({
    mutationFn: (values: HostedConfigValues) =>
      saveHostedSettings(props.provider, values),
    onSuccess: (config) => {
      form.reset(config)
      queryClient.setQueryData<Record<HostedProvider, HostedPaymentConfig>>(
        ['hosted-payments'],
        (previous) =>
          previous ? { ...previous, [props.provider]: config } : previous
      )
      toast.success(t('Configuration saved'))
    },
  })
  const environment = form.watch('environment')
  const webhook = `${props.serverAddress.replace(/\/$/, '')}/api/payments/${props.provider}/webhook/${environment}`
  const commonFields: HostedTextField[] = [
    { key: 'currency', label: 'Settlement currency' },
    { key: 'unit_price', label: 'Payment currency units per USD credit' },
  ]
  return (
    <Form {...form}>
      <SettingsForm
        onSubmit={form.handleSubmit((values) => save.mutate(values))}
        data-no-autosubmit='true'
      >
        <Alert>
          <AlertDescription>
            {t(
              'Use the provider hosted checkout. Pause new payments to keep callbacks working for existing orders.'
            )}
          </AlertDescription>
        </Alert>
        {props.provider === 'nowpayments' && (
          <Alert>
            <AlertDescription>
              {t(
                'NOWPayments uses the live USD invoice API. Select an exact coin and network code, or leave it blank for checkout selection.'
              )}
            </AlertDescription>
          </Alert>
        )}
        {props.provider === 'paypal' && (
          <Alert>
            <AlertDescription>
              {t(
                'PayPal is an additional option for supported countries. Confirm merchant and payer availability before enabling it.'
              )}
            </AlertDescription>
          </Alert>
        )}
        <FormField
          control={form.control}
          name='enabled'
          render={({ field }) => (
            <SettingsSwitchItem>
              <SettingsSwitchContent>
                <FormLabel>{t('Enable payment integration')}</FormLabel>
                <FormDescription>
                  {t('Keep enabled while unpaid orders need notifications.')}
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
        <FormField
          control={form.control}
          name='accept_new'
          render={({ field }) => (
            <SettingsSwitchItem>
              <SettingsSwitchContent>
                <FormLabel>{t('Accept new payments')}</FormLabel>
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
        <FormField
          control={form.control}
          name='environment'
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('Environment')}</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value='test'>{t('Test')}</SelectItem>
                    <SelectItem value='live'>{t('Live')}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name='min_topup'
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('Minimum top-up (USD)')}</FormLabel>
              <FormControl>
                <Input
                  type='number'
                  min={1}
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
        {[...commonFields, ...hostedProviderFields[props.provider]].map(
          (item) => (
            <FormField
              key={item.key}
              control={form.control}
              name={item.key}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t(item.label)}</FormLabel>
                  <FormControl>
                    {item.multiline ? (
                      <Textarea {...field} autoComplete='off' rows={4} />
                    ) : (
                      <Input
                        {...field}
                        type={item.secret ? 'password' : 'text'}
                        autoComplete={item.secret ? 'new-password' : 'off'}
                      />
                    )}
                  </FormControl>
                  {item.secret && (
                    <FormDescription>
                      {t('Leave blank to keep the saved credential.')}
                      {props.config.secrets_configured?.includes(item.key) &&
                        ` ${t('Configured')}`}
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
          )
        )}
        {props.provider === 'lianlian' && (
          <>
            <FormField
              control={form.control}
              name='signature_type'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Signature type')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value='HMAC-SHA256'>HMAC-SHA256</SelectItem>
                        <SelectItem value='RSA'>RSA</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='checkout_hosts'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Approved checkout hosts')}</FormLabel>
                  <FormControl>
                    <Textarea
                      value={field.value.join('\n')}
                      onChange={(event) =>
                        field.onChange(event.target.value.split('\n'))
                      }
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'One exact host per line, as confirmed by the provider.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </>
        )}
        <div className='min-w-0 space-y-2'>
          <p className='text-sm font-medium'>{t('Webhook URL')}</p>
          <div className='flex items-center gap-2'>
            <code className='min-w-0 flex-1 text-sm break-all'>{webhook}</code>
            <CopyButton value={webhook} />
          </div>
          <p className='text-muted-foreground text-sm'>
            {t(
              'Register this URL in the matching merchant environment. Set this instance Server Address to the RU domain.'
            )}
          </p>
          {environment === 'test' && (
            <p className='text-muted-foreground text-sm'>
              {t(
                'Use a separate test instance and database for sandbox payments.'
              )}
            </p>
          )}
        </div>
        <Button className='w-fit' type='submit' disabled={save.isPending}>
          {t(save.isPending ? 'Saving...' : 'Save payment integration')}
        </Button>
      </SettingsForm>
    </Form>
  )
}
