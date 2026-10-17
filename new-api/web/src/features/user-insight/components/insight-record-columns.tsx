import { Link } from '@tanstack/react-router'
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
import type { ColumnDef } from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { StatusBadge } from '@/components/status-badge'
import {
  STATUS_CONFIG,
  getPaymentMethodName,
} from '@/features/wallet/lib/billing'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber, formatQuota, formatTimestamp } from '@/lib/format'
import { translateServerText } from '@/lib/server-error-message'

import type {
  UserInsightCheckin,
  UserInsightLog,
  UserInsightRedemption,
  UserInsightRecordsSection,
  UserInsightTopup,
} from '../types'

export type InsightRecord =
  | UserInsightTopup
  | UserInsightRedemption
  | UserInsightCheckin
  | UserInsightLog

export function useInsightRecordColumns(
  section: UserInsightRecordsSection,
  logTypes: { value: string; label: string }[]
): ColumnDef<InsightRecord>[] {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)

  if (section === 'topups') {
    return [
      {
        id: 'order',
        header: t('Order'),
        cell: ({ row }) => {
          const record = row.original as UserInsightTopup
          return (
            <div className='min-w-40 space-y-1'>
              <div className='flex items-start gap-1'>
                <p className='max-w-72 break-all whitespace-normal'>
                  {record.trade_no}
                </p>
                <CopyButton
                  value={record.trade_no}
                  className='size-6'
                  aria-label={t('Copy order number')}
                />
              </div>
              <p className='text-muted-foreground text-xs'>
                #{record.id} · {record.payment_provider || '—'} ·{' '}
                {t(getPaymentMethodName(record.payment_method))}
              </p>
            </div>
          )
        },
      },
      {
        id: 'status',
        header: t('Status'),
        cell: ({ row }) => {
          const status = (row.original as UserInsightTopup).status
          const config = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]
          return (
            <StatusBadge
              label={config ? t(config.label) : t('Unknown')}
              variant={config?.variant ?? 'neutral'}
              copyable={false}
            />
          )
        },
      },
      {
        id: 'payment',
        header: t('Recorded payment amount'),
        cell: ({ row }) => (
          <div className='space-y-1'>
            <p className='tabular-nums'>
              {formatNumber((row.original as UserInsightTopup).money, locale)}
            </p>
            <p className='text-muted-foreground text-xs'>
              {t('Currency not recorded')}
            </p>
          </div>
        ),
      },
      {
        id: 'amount',
        header: t('Order amount (recorded)'),
        cell: ({ row }) =>
          formatNumber((row.original as UserInsightTopup).amount, locale),
      },
      {
        id: 'credited',
        header: t('Order quota snapshot'),
        cell: ({ row }) => {
          const record = row.original as UserInsightTopup
          const quota = record.credited_quota
          return (
            <div className='space-y-1'>
              <p>
                {quota != null && quota > 0
                  ? formatQuota(quota)
                  : t('Not recorded')}
              </p>
              {record.status !== 'success' && (
                <p className='text-muted-foreground text-xs'>
                  {t('Not credited')}
                </p>
              )}
            </div>
          )
        },
      },
      {
        id: 'time',
        header: t('Time'),
        cell: ({ row }) => {
          const record = row.original as UserInsightTopup
          return (
            <div className='space-y-1 text-xs'>
              <p>
                {t('Created')}: {formatTimestamp(record.create_time)}
              </p>
              <p className='text-muted-foreground'>
                {t('Completed')}:{' '}
                {record.complete_time > 0
                  ? formatTimestamp(record.complete_time)
                  : t('Not recorded')}
              </p>
            </div>
          )
        },
      },
    ]
  }
  if (section === 'redemptions') {
    return [
      { id: 'id', header: t('ID'), cell: ({ row }) => row.original.id },
      {
        id: 'name',
        header: t('Name'),
        cell: ({ row }) => (
          <p className='max-w-72 [overflow-wrap:anywhere] whitespace-normal'>
            {(row.original as UserInsightRedemption).name || '—'}
          </p>
        ),
      },
      {
        id: 'quota',
        header: t('Credited site quota'),
        cell: ({ row }) =>
          formatQuota((row.original as UserInsightRedemption).quota),
      },
      {
        id: 'time',
        header: t('Redeemed at'),
        cell: ({ row }) =>
          formatTimestamp(
            (row.original as UserInsightRedemption).redeemed_time
          ),
      },
    ]
  }
  if (section === 'checkins') {
    return [
      { id: 'id', header: t('ID'), cell: ({ row }) => row.original.id },
      {
        id: 'date',
        header: t('Check-in date'),
        cell: ({ row }) => (row.original as UserInsightCheckin).checkin_date,
      },
      {
        id: 'quota',
        header: t('Granted site quota'),
        cell: ({ row }) =>
          formatQuota((row.original as UserInsightCheckin).quota_awarded),
      },
      {
        id: 'time',
        header: t('Created'),
        cell: ({ row }) =>
          formatTimestamp((row.original as UserInsightCheckin).created_at),
      },
    ]
  }
  return [
    {
      id: 'time',
      header: t('Time'),
      cell: ({ row }) => (
        <div className='space-y-1'>
          <p>{formatTimestamp((row.original as UserInsightLog).created_at)}</p>
          <p className='text-muted-foreground text-xs'>#{row.original.id}</p>
        </div>
      ),
    },
    {
      id: 'type',
      header: t('Type'),
      cell: ({ row }) => {
        const type = (row.original as UserInsightLog).type
        return (
          <span className='inline-block max-w-44 whitespace-normal'>
            {logTypes.find((item) => Number(item.value) === type && type !== 0)
              ?.label ?? t('Unknown')}
          </span>
        )
      },
    },
    {
      id: 'content',
      header: t('Content'),
      cell: ({ row }) => {
        const log = row.original as UserInsightLog
        return (
          <div className='max-w-96 min-w-52 space-y-1'>
            <p className='[overflow-wrap:anywhere] whitespace-pre-wrap'>
              {translateServerText(t, log.content) || '—'}
            </p>
            {log.request_id && (
              <p className='text-muted-foreground text-xs break-all whitespace-normal'>
                {t('Request ID')}:{' '}
                <Link
                  to='/usage-logs/$section'
                  params={{ section: 'common' }}
                  search={{ requestId: log.request_id, type: ['0'] }}
                  target='_blank'
                  rel='noopener noreferrer'
                  className='text-primary underline underline-offset-4'
                >
                  {log.request_id}
                </Link>
              </p>
            )}
          </div>
        )
      },
    },
    {
      id: 'quota',
      header: t('Site quota'),
      cell: ({ row }) => {
        const log = row.original as UserInsightLog
        return log.type === 2 || log.type === 6
          ? formatQuota(log.quota)
          : t('Not recorded')
      },
    },
    {
      id: 'request',
      header: t('Request'),
      cell: ({ row }) => {
        const log = row.original as UserInsightLog
        return (
          <div className='max-w-60 space-y-1 [overflow-wrap:anywhere] whitespace-normal'>
            <p>{log.model_name || '—'}</p>
            <p className='text-muted-foreground text-xs'>
              {t('Channel')}: {log.channel_id || '—'} · {log.token_name || '—'}
            </p>
            <p className='text-muted-foreground text-xs'>
              {t('Input Tokens')}: {formatNumber(log.prompt_tokens, locale)} ·{' '}
              {t('Output Tokens')}:{' '}
              {formatNumber(log.completion_tokens, locale)}
            </p>
            <p className='text-muted-foreground text-xs'>
              {t('Time')}: {formatNumber(log.use_time, locale)} s ·{' '}
              {log.is_stream ? t('Stream') : t('Non-stream')}
            </p>
          </div>
        )
      },
    },
  ]
}
