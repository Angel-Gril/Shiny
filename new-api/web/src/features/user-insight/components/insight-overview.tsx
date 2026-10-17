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
import { useTranslation } from 'react-i18next'

import { GroupBadge } from '@/components/group-badge'
import { StatusBadge } from '@/components/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { USER_ROLES, USER_STATUSES } from '@/features/users/constants'
import { toIntlLocale } from '@/i18n/languages'
import { getCurrencyLabel } from '@/lib/currency'
import { formatNumber, formatQuota, formatTimestamp } from '@/lib/format'
import { useSystemConfigStore } from '@/stores/system-config-store'

import { useUserInsight } from '../api'
import { InsightQueryState } from './insight-query-state'

export function InsightOverview(props: { userId: number }) {
  const { t, i18n } = useTranslation()
  useSystemConfigStore((state) => state.config.currency)
  const query = useUserInsight(props.userId, 'overview')
  const data = query.data
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const role = data && USER_ROLES[data.user.role as keyof typeof USER_ROLES]
  const status =
    data && USER_STATUSES[data.user.status as keyof typeof USER_STATUSES]

  return (
    <InsightQueryState
      pending={query.isPending}
      error={query.error}
      retry={() => void query.refetch()}
    >
      {data && (
        <div className='space-y-5'>
          <dl className='grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2'>
            {[
              [t('User ID'), formatNumber(data.user.id, locale)],
              [t('Username'), data.user.username],
              [t('Display Name'), data.user.display_name || '—'],
              [t('Email'), data.user.email || t('Not recorded')],
              [t('Role'), role ? t(role.labelKey) : t('Unknown')],
              [
                t('User Group'),
                <GroupBadge key='group' group={data.user.group} />,
              ],
              [
                t('Status'),
                status ? (
                  <StatusBadge
                    key='status'
                    label={t(status.labelKey)}
                    variant={status.variant}
                    copyable={false}
                  />
                ) : (
                  t('Unknown')
                ),
              ],
              [
                t('Registered'),
                data.user.created_at > 0
                  ? formatTimestamp(data.user.created_at)
                  : t('Not recorded'),
              ],
              [
                t('Last Login'),
                data.user.last_login_at > 0
                  ? formatTimestamp(data.user.last_login_at)
                  : t('Not recorded'),
              ],
              [
                t('Inviter'),
                data.user.inviter_id > 0
                  ? `${data.user.inviter_username || t('Unknown')} (#${data.user.inviter_id})`
                  : t('Not recorded'),
              ],
            ].map(([label, value]) => (
              <div key={String(label)} className='min-w-0 space-y-1'>
                <dt className='text-muted-foreground text-xs'>{label}</dt>
                <dd className='text-sm [overflow-wrap:anywhere] break-words'>
                  {value}
                </dd>
              </div>
            ))}
            <div className='min-w-0 space-y-1 sm:col-span-2'>
              <dt className='text-muted-foreground text-xs'>{t('Remark')}</dt>
              <dd className='text-sm [overflow-wrap:anywhere] whitespace-pre-wrap'>
                {data.user.remark || '—'}
              </dd>
            </div>
          </dl>

          <section
            className='space-y-3 border-t pt-4'
            aria-label={t('Site quota')}
          >
            <h3 className='text-sm font-medium'>
              {t('Site quota ({{unit}})', { unit: getCurrencyLabel() })}
            </h3>
            <dl className='grid grid-cols-1 gap-4 sm:grid-cols-3'>
              {[
                [t('Available site quota'), formatQuota(data.user.quota)],
                [
                  t('Cumulative usage quota'),
                  formatQuota(data.user.used_quota),
                ],
                [t('Requests'), formatNumber(data.user.request_count, locale)],
              ].map(([label, value]) => (
                <div key={label} className='space-y-1'>
                  <dt className='text-muted-foreground text-xs'>{label}</dt>
                  <dd className='text-lg font-semibold tabular-nums'>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <p className='text-muted-foreground text-xs'>
              {t(
                'Displayed quota is site credit at current display settings, not cash or a refundable balance.'
              )}
            </p>
          </section>

          <section
            className='space-y-3 border-t pt-4'
            aria-label={t('Recorded activity')}
          >
            <h3 className='text-sm font-medium'>{t('Recorded activity')}</h3>
            <dl className='grid grid-cols-2 gap-4 sm:grid-cols-3'>
              {[
                [t('Successful top-up orders'), data.stats.successful_topups],
                [t('Redeemed codes'), data.stats.redemptions],
                [t('Check-in records'), data.stats.checkins ?? 0],
                [t('Log records'), data.stats.log_count],
                [t('Consumption records'), data.stats.consume_count],
                [t('Usage quota return records'), data.stats.refund_count],
              ].map(([label, value]) => (
                <div key={String(label)} className='space-y-1'>
                  <dt className='text-muted-foreground text-xs'>{label}</dt>
                  <dd className='text-sm tabular-nums'>
                    {formatNumber(Number(value), locale)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <Alert>
            <AlertTitle>{t('Manual refund review')}</AlertTitle>
            <AlertDescription className='space-y-2'>
              <p>
                {t(
                  'Review payment receipts, usage, grants and refund policy together. No cash refund or quota adjustment is performed here.'
                )}
              </p>
              {!data.limitations.wallet_provenance_complete && (
                <p>
                  {t(
                    'Historical wallet sources are incomplete. Registration grants, invitations, redemptions and adjustments cannot be separated from the current balance. Unknown grants are not zero.'
                  )}
                </p>
              )}
              {!data.limitations.payment_currency_recorded && (
                <p>
                  {t(
                    'Historical payment currency was not recorded. Amounts are shown as stored; verify the original gateway receipt before calculating a cash refund.'
                  )}
                </p>
              )}
            </AlertDescription>
          </Alert>
          <Link
            to='/usage-logs/$section'
            params={{ section: 'common' }}
            search={{ username: data.user.username, type: ['0'] }}
            target='_blank'
            rel='noopener noreferrer'
            className='text-primary text-sm underline underline-offset-4'
          >
            {t('View Logs')}
          </Link>
        </div>
      )}
    </InsightQueryState>
  )
}
