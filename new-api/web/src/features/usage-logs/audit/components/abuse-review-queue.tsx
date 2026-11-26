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
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DataTablePage, useDataTable } from '@/components/data-table'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Combobox } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { formatNumber } from '@/lib/format'

import { formatAbuseAction } from '../abuse-evidence'
import {
  getAbuseReviews,
  getAbuseReviewSummary,
  type AbuseReview,
  type AbuseReviewStatus,
} from '../api'
import { AbuseEvidenceDialog } from './abuse-evidence-dialog'
import { AbuseReviewActions } from './abuse-review-actions'

const auditProviderLabels: Record<string, string> = {
  chat_completions: 'Chat Completions',
  typesafe: 'TypeSafe / Jev',
  subq: 'SubQ Decisions',
}

function formatReviewTime(timestamp: number) {
  if (!timestamp) return '-'
  return new Date(timestamp * 1000).toLocaleString()
}

export function AbuseReviewQueue() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<AbuseReviewStatus>('pending')
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [includeObservations, setIncludeObservations] = useState(false)
  const query = useQuery({
    queryKey: [
      'abuse-reviews',
      status,
      action,
      page,
      pageSize,
      includeObservations,
    ],
    queryFn: () =>
      getAbuseReviews({
        p: page,
        page_size: pageSize,
        status,
        action: action || undefined,
        minimum_priority: includeObservations ? 0 : 3,
      }),
    retry: false,
  })
  const summaryQuery = useQuery({
    queryKey: ['abuse-review-summary'],
    queryFn: getAbuseReviewSummary,
    retry: false,
    refetchInterval: 60_000,
  })

  const columns = useMemo(
    () => [
      {
        accessorKey: 'action',
        header: t('Signal'),
        size: 200,
        cell: ({ row }: { row: { original: AbuseReview } }) => (
          <div className='min-w-0 space-y-1 [overflow-wrap:anywhere] whitespace-normal'>
            <div className='font-medium'>
              {formatAbuseAction(row.original.action, t)}
            </div>
            <div className='text-muted-foreground line-clamp-2 text-xs'>
              {t('Event')} {row.original.event_id}
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'risk_score',
        header: t('Review priority score'),
        size: 140,
        cell: ({ row }: { row: { original: AbuseReview } }) => (
          <div className='min-w-0 space-y-1 [overflow-wrap:anywhere] whitespace-normal'>
            <div>{row.original.risk_score}</div>
            <div className='text-muted-foreground text-xs'>
              {t(row.original.disposition ?? 'observe')}
            </div>
            <div className='text-muted-foreground text-xs'>
              {row.original.score_version}
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'created_at',
        header: t('Created'),
        size: 175,
        cell: ({ row }: { row: { original: AbuseReview } }) => (
          <div className='min-w-0 space-y-1 [overflow-wrap:anywhere] whitespace-normal'>
            <div>{formatReviewTime(row.original.created_at)}</div>
            <div className='text-muted-foreground text-xs'>
              {t('User')} {row.original.user_id} / {t('Token')}{' '}
              {row.original.token_id}
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'evidence_json',
        header: t('Redacted evidence'),
        size: 290,
        cell: ({ row }: { row: { original: AbuseReview } }) => (
          <AbuseEvidenceDialog review={row.original} />
        ),
      },
      {
        id: 'review',
        header: t('Review'),
        size: 225,
        cell: ({ row }: { row: { original: AbuseReview } }) => (
          <AbuseReviewActions review={row.original} />
        ),
      },
    ],
    [t]
  )
  const { table } = useDataTable({
    columns,
    data: query.data?.items ?? [],
    getRowId: (entry) => String(entry.id),
    totalCount: query.data?.total ?? 0,
    pagination: { pageIndex: page - 1, pageSize },
    onPaginationChange: (updater) => {
      const current = { pageIndex: page - 1, pageSize }
      const next = typeof updater === 'function' ? updater(current) : updater
      setPage(next.pageIndex + 1)
    },
    enableRowSelection: false,
    enableSorting: false,
    manualPagination: true,
  })

  return (
    <div className='flex h-full min-h-0 min-w-0 flex-col'>
      <p className='text-muted-foreground mb-3 text-xs'>
        {t(
          'Review scores rank evidence for operators. They are not content probabilities or account charges. Successful long streams and provider failures alone do not establish abuse.'
        )}
      </p>
      {summaryQuery.data && (
        <div
          className='mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3'
          aria-label={t('Abuse review summary')}
        >
          {[
            [t('Pending review'), summaryQuery.data.reviews.review_priority],
            [t('Resolved'), summaryQuery.data.reviews.resolved],
            [t('False positive'), summaryQuery.data.reviews.false_positive],
            [t('Last 24 hours'), summaryQuery.data.reviews.last_24_hours],
            [
              t('Observation backlog'),
              Math.max(
                0,
                summaryQuery.data.reviews.pending -
                  summaryQuery.data.reviews.review_priority
              ),
            ],
            [t('Manual priority'), summaryQuery.data.reviews.manual_priority],
          ].map(([label, value]) => (
            <div
              key={String(label)}
              className='border-border bg-muted/20 rounded-md border px-3 py-2'
            >
              <div className='text-muted-foreground'>{label}</div>
              <div className='mt-1 text-lg font-semibold'>{value}</div>
            </div>
          ))}
          <div className='border-border bg-muted/20 col-span-2 min-w-0 rounded-md border px-3 py-2 [overflow-wrap:anywhere] sm:col-span-3'>
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <span className='text-muted-foreground'>
                {t('Content audit')} ·{' '}
                {t(summaryQuery.data.content_audit.mode ?? 'off')}
              </span>
              <span
                className={
                  summaryQuery.data.content_audit.enabled &&
                  summaryQuery.data.content_audit.configured
                    ? 'text-emerald-600'
                    : 'text-muted-foreground'
                }
              >
                {summaryQuery.data.content_audit.enabled &&
                summaryQuery.data.content_audit.configured
                  ? t('Configured')
                  : t('Disabled')}
              </span>
            </div>
            <div className='text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-1'>
              <span>
                {t('Requests')} {summaryQuery.data.content_audit.requests}
              </span>
              <span>
                {t('Flagged')} {summaryQuery.data.content_audit.flagged}
              </span>
              <span>
                {t('Errors')} {summaryQuery.data.content_audit.errors}
              </span>
              <span>
                {t('Dropped')} {summaryQuery.data.content_audit.dropped}
              </span>
              <span>
                {t('Incomplete coverage')}{' '}
                {summaryQuery.data.content_audit.incomplete ?? 0}
              </span>
              <span>
                429 {summaryQuery.data.content_audit.rate_limited ?? 0}
              </span>
              <span>
                P50 / P95{' '}
                {formatNumber(summaryQuery.data.content_audit.p50_ms ?? 0)} /{' '}
                {formatNumber(summaryQuery.data.content_audit.p95_ms ?? 0)} ms
              </span>
              {summaryQuery.data.content_audit.model && (
                <span>{summaryQuery.data.content_audit.model}</span>
              )}
              {summaryQuery.data.content_audit.provider && (
                <span>
                  {t('Signal source')}:{' '}
                  {t(
                    auditProviderLabels[
                      summaryQuery.data.content_audit.provider
                    ] ?? summaryQuery.data.content_audit.provider
                  )}
                </span>
              )}
              {summaryQuery.data.content_audit.input_tokens !== undefined && (
                <span>
                  {t('Audit input tokens')}{' '}
                  {formatNumber(summaryQuery.data.content_audit.input_tokens)}
                </span>
              )}
              {summaryQuery.data.content_audit.output_tokens !== undefined && (
                <span>
                  {t('Audit output tokens')}{' '}
                  {formatNumber(summaryQuery.data.content_audit.output_tokens)}
                </span>
              )}
              {summaryQuery.data.content_audit.usage_unreported !==
                undefined && (
                <span>
                  {t('Usage unreported')}{' '}
                  {summaryQuery.data.content_audit.usage_unreported}
                </span>
              )}
            </div>
            <p className='text-muted-foreground mt-2'>
              {t(
                'Incomplete coverage means only part of a request was evaluated; it does not indicate a clean result.'
              )}
            </p>
            <p className='text-muted-foreground mt-1'>
              {t(
                'Audit token totals are cumulative external review usage in this process; they are not customer inference tokens.'
              )}
            </p>
          </div>
        </div>
      )}
      {query.isError && (
        <Alert variant='destructive' className='mb-3'>
          <AlertDescription>
            {t('Failed to load abuse reviews')}
          </AlertDescription>
        </Alert>
      )}
      {summaryQuery.isError && (
        <Alert variant='destructive' className='mb-3'>
          <AlertDescription>
            {t('Failed to load abuse review summary')}
          </AlertDescription>
        </Alert>
      )}
      <div className='mb-3 flex max-w-xl flex-wrap items-center gap-2'>
        <div className='flex items-center gap-2'>
          <Switch
            id='include-audit-observations'
            checked={includeObservations}
            onCheckedChange={(checked) => {
              setIncludeObservations(checked)
              setPage(1)
            }}
          />
          <Label htmlFor='include-audit-observations'>
            {t('Include observations and previous score versions')}
          </Label>
        </div>
        <Combobox
          aria-label={t('Review status')}
          value={status}
          options={[
            { value: 'pending', label: t('Pending') },
            { value: 'resolved', label: t('Resolved') },
            { value: 'false_positive', label: t('False positive') },
          ]}
          onValueChange={(value) => {
            if (
              value === 'pending' ||
              value === 'resolved' ||
              value === 'false_positive'
            ) {
              setStatus(value)
              setPage(1)
            }
          }}
        />
        <Input
          aria-label={t('Signal filter')}
          className='w-64'
          placeholder={t('Filter action, e.g. abuse.content_audit')}
          value={action}
          onChange={(event) => {
            setAction(event.target.value)
            setPage(1)
          }}
        />
      </div>
      <DataTablePage
        table={table}
        columns={columns}
        isLoading={query.isPending}
        isFetching={query.isFetching}
        emptyTitle={t('No abuse reviews')}
        className='min-h-0 min-w-0 flex-1'
        applyHeaderSize
        getColumnClassName={() => 'py-3 align-top whitespace-normal'}
        tableClassName='min-w-0 [&_[data-slot=table]]:table-fixed! [&_[data-slot=table]]:text-[13px] [&_[data-slot=table]_th]:whitespace-normal'
      />
    </div>
  )
}
