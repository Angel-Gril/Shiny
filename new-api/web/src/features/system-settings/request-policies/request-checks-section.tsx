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
import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import * as z from 'zod'

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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { handleServerError } from '@/lib/handle-server-error'

import {
  SettingsForm,
  SettingsControlGroup,
  SettingsControlChildren,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { getContentAuditModels } from './api'
import { useSavePolicy } from './use-save-policy'

const sensitiveSchema = z.object({
  CheckSensitiveEnabled: z.boolean(),
  CheckSensitiveOnPromptEnabled: z.boolean(),
  SensitiveWords: z.string().optional(),
  SensitiveWordSignals: z.string().optional(),
})

const contentAuditSchema = z.object({
  ContentAuditEnabled: z.boolean(),
  ContentAuditMode: z.enum(['off', 'shadow', 'preflight']),
  ContentAuditPreflightScope: z.enum(['signal', 'all']),
  ContentAuditEndpoint: z.string().max(512),
  ContentAuditModel: z.string().max(128),
  ContentAuditTimeoutMs: z.string().regex(/^\d+$/, 'Enter milliseconds'),
  ContentAuditSampleRate: z
    .string()
    .regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/, 'Enter a value from 0 to 1'),
  ContentAuditPrompt: z.string().max(20000),
  ContentAuditFlaggedThreshold: z
    .string()
    .regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/, 'Enter a value from 0 to 1'),
  ContentAuditReviewThreshold: z
    .string()
    .regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/, 'Enter a value from 0 to 1'),
})

type SensitiveFormValues = z.infer<typeof sensitiveSchema>
type ContentAuditFormValues = z.infer<typeof contentAuditSchema>

type RequestChecksSectionProps = {
  defaultValues: SensitiveFormValues & ContentAuditFormValues
}

export function RequestChecksSection({
  defaultValues,
}: RequestChecksSectionProps) {
  const { t } = useTranslation()
  const updateOption = useSavePolicy()
  const form = useForm<SensitiveFormValues>({
    resolver: zodResolver(sensitiveSchema),
    defaultValues,
  })

  useEffect(() => {
    form.reset(defaultValues)
  }, [defaultValues, form])

  const onSubmit = async (values: SensitiveFormValues) => {
    const updates = Object.entries(values).filter(
      ([key, value]) =>
        value !== defaultValues[key as keyof SensitiveFormValues]
    )

    try {
      if (updates.length > 0) {
        await updateOption.mutateAsync(
          Object.fromEntries(
            updates.map(([key, value]) => [key, String(value ?? '')])
          )
        )
      }
    } catch (error) {
      handleServerError(error)
    }
  }

  return (
    <>
      <SettingsSection title={t('Request checks')}>
        <p className='text-muted-foreground text-sm'>
          {t('Source: global settings. Changes take effect after saving.')}
        </p>
        <h3 className='text-sm font-medium'>{t('Request text filtering')}</h3>
        <p className='text-muted-foreground text-sm'>
          {t(
            'Checks text extracted from supported requests against keywords, ignoring case. A match rejects the request before upstream processing and does not affect channel health. Images, audio and generated responses are not checked.'
          )}
        </p>
        <Form {...form}>
          <SettingsForm onSubmit={form.handleSubmit(onSubmit)}>
            <SettingsPageFormActions
              onSave={form.handleSubmit(onSubmit)}
              isSaving={form.formState.isSubmitting}
              saveLabel='Save sensitive words'
            />
            <Alert>
              <AlertDescription>
                {form.watch('CheckSensitiveEnabled') &&
                form.watch('CheckSensitiveOnPromptEnabled') &&
                form.watch('SensitiveWords')?.trim()
                  ? t(
                      'Prompt text filtering is active with the current form values.'
                    )
                  : t(
                      'Prompt text filtering needs both switches enabled and a non-empty keyword list.'
                    )}
              </AlertDescription>
            </Alert>
            <SettingsControlGroup>
              <FormField
                control={form.control}
                name='CheckSensitiveEnabled'
                render={({ field }) => (
                  <SettingsSwitchItem>
                    <SettingsSwitchContent>
                      <FormLabel>{t('Enable filtering')}</FormLabel>
                      <FormDescription>
                        {t(
                          'Blocks messages when sensitive keywords are detected.'
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

              <SettingsControlChildren>
                <FormField
                  control={form.control}
                  name='CheckSensitiveOnPromptEnabled'
                  render={({ field }) => (
                    <SettingsSwitchItem>
                      <SettingsSwitchContent>
                        <FormLabel>{t('Inspect user prompts')}</FormLabel>
                        <FormDescription>
                          {t(
                            'When enabled, prompts are scanned before reaching upstream models.'
                          )}
                        </FormDescription>
                      </SettingsSwitchContent>
                      <FormControl>
                        <Switch
                          disabled={!form.watch('CheckSensitiveEnabled')}
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </SettingsSwitchItem>
                  )}
                />
              </SettingsControlChildren>
            </SettingsControlGroup>

            <FormField
              control={form.control}
              name='SensitiveWords'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Blocked keywords')}</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={12}
                      placeholder={t('Enter one keyword per line')}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Each line represents one keyword. Leave blank to disable the list but keep the switch states.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='SensitiveWordSignals'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Signal keywords')}</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={10}
                      placeholder={t('Enter one keyword per line')}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Signal matches are sent to content audit and do not reject a request by themselves.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </SettingsForm>
        </Form>
      </SettingsSection>
      <ContentAuditSection defaultValues={defaultValues} />
    </>
  )
}

function ContentAuditSection({ defaultValues }: RequestChecksSectionProps) {
  const { t } = useTranslation()
  const updateOption = useSavePolicy()
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [modelFetchError, setModelFetchError] = useState('')
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const form = useForm<ContentAuditFormValues>({
    resolver: zodResolver(contentAuditSchema),
    defaultValues,
  })

  useEffect(() => {
    form.reset(defaultValues)
  }, [defaultValues, form])

  const fetchModels = async () => {
    setIsFetchingModels(true)
    setModelFetchError('')
    try {
      const models = await getContentAuditModels(
        form.getValues('ContentAuditEndpoint')
      )
      setModelOptions(models)
      if (!form.getValues('ContentAuditModel')) {
        form.setValue('ContentAuditModel', models[0] ?? '')
      }
    } catch (error) {
      setModelFetchError(
        error instanceof Error ? error.message : t('Failed to fetch models')
      )
    } finally {
      setIsFetchingModels(false)
    }
  }

  const onSubmit = async (values: ContentAuditFormValues) => {
    const updates = Object.entries(values).filter(
      ([key, value]) =>
        value !== defaultValues[key as keyof ContentAuditFormValues]
    )
    if (updates.length === 0) return
    await updateOption.mutateAsync(
      Object.fromEntries(updates.map(([key, value]) => [key, String(value)]))
    )
  }

  const auditMode = form.watch('ContentAuditMode')
  let auditModeMessage = t(
    'Content audit is disabled; no external audit request will be sent.'
  )
  if (auditMode === 'shadow') {
    auditModeMessage = t(
      'Shadow audit is enabled; requests continue normally and results are queued for review.'
    )
  } else if (auditMode === 'preflight') {
    auditModeMessage = t(
      'Preflight audit is enabled; requests wait for review before upstream submission.'
    )
  }

  return (
    <SettingsSection title={t('Content audit')}>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Audit mode is independent of keyword filtering. Shadow reviews in the background; preflight can reject a request before billing and upstream submission.'
        )}
      </p>
      <Alert>
        <AlertDescription>
          {t(
            'The audit API key is never stored in New API options or shown here. Configure it in the server secret environment.'
          )}
        </AlertDescription>
      </Alert>
      <Form {...form}>
        <SettingsForm onSubmit={form.handleSubmit(onSubmit)}>
          <SettingsPageFormActions
            onSave={form.handleSubmit(onSubmit)}
            isSaving={form.formState.isSubmitting}
            saveLabel='Save audit settings'
          />
          <SettingsControlGroup>
            <FormField
              control={form.control}
              name='ContentAuditMode'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Content audit mode')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger aria-label={t('Content audit mode')}>
                        <SelectValue>{t(field.value)}</SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value='off'>{t('Off')}</SelectItem>
                      <SelectItem value='shadow'>{t('Shadow')}</SelectItem>
                      <SelectItem value='preflight'>
                        {t('Preflight')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {t(
                      'Shadow records results asynchronously. Preflight waits before upstream submission and fails closed on audit errors.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </SettingsControlGroup>
          {auditMode === 'preflight' && (
            <FormField
              control={form.control}
              name='ContentAuditPreflightScope'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Preflight scope')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger aria-label={t('Preflight scope')}>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value='signal'>
                        {t('Signal matches only')}
                      </SelectItem>
                      <SelectItem value='all'>{t('All requests')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {t(
                      'Start with signal matches. All requests adds audit latency to every request. Unmatched requests can still be sampled in the background.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
          <Alert>
            <AlertDescription>{auditModeMessage}</AlertDescription>
          </Alert>

          <div className='grid gap-4 md:grid-cols-2'>
            <FormField
              control={form.control}
              name='ContentAuditEndpoint'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Audit endpoint')}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder='https://provider.example/v1/chat/completions'
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Use a direct external endpoint, not this New API gateway.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='ContentAuditModel'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Audit model')}</FormLabel>
                  <div className='flex gap-2'>
                    <FormControl>
                      <Input
                        list='content-audit-models'
                        placeholder='audit-model'
                        {...field}
                      />
                    </FormControl>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      aria-label={t('Fetch models')}
                      title={t('Fetch models')}
                      disabled={isFetchingModels}
                      onClick={() => void fetchModels()}
                    >
                      <RefreshCw
                        className={isFetchingModels ? 'animate-spin' : ''}
                      />
                      <span>{t('Fetch models')}</span>
                    </Button>
                  </div>
                  <datalist id='content-audit-models'>
                    {modelOptions.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                  <FormDescription>
                    {t('Use a low-cost model with reliable JSON output.')}
                  </FormDescription>
                  {modelFetchError && (
                    <p className='text-destructive text-xs'>
                      {modelFetchError}
                    </p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='ContentAuditTimeoutMs'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Timeout (ms)')}</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={100}
                      max={30000}
                      step={100}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Shadow failures are recorded without affecting the request. Preflight failures return 503 before billing or forwarding.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='ContentAuditSampleRate'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Sample rate')}</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={0}
                      max={1}
                      step={0.01}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Background sample rate from 0 to 1. Current signal matches always trigger audit; preflight requests are not sampled.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='ContentAuditReviewThreshold'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Review threshold')}</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={0}
                      max={1}
                      step={0.05}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Flagged results below this confidence stay out of the review queue.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='ContentAuditFlaggedThreshold'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Preflight rejection threshold')}</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={0}
                      max={1}
                      step={0.05}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Only direct abusive requests at or above this score can be rejected in preflight mode. Shadow never blocks.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name='ContentAuditPrompt'
            render={({ field }) => (
              <FormItem>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <FormLabel>{t('Additional audit instructions')}</FormLabel>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() => form.setValue('ContentAuditPrompt', '')}
                  >
                    {t('Restore default policy')}
                  </Button>
                </div>
                <FormControl>
                  <Textarea
                    rows={10}
                    placeholder={t(
                      'Optional additive instructions for the auditor'
                    )}
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  {t(
                    'Keep the category-score JSON protocol. Mode and server policy decide rejection; model results never change account balances or permissions.'
                  )}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </SettingsForm>
      </Form>
    </SettingsSection>
  )
}
