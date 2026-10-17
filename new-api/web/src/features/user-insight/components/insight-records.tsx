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
import type { PaginationState } from '@tanstack/react-table'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  DataTablePagination,
  DataTableView,
  useDataTable,
} from '@/components/data-table'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSystemConfigStore } from '@/stores/system-config-store'

import { useUserInsight } from '../api'
import type { UserInsightPage, UserInsightRecordsSection } from '../types'
import { InsightQueryState } from './insight-query-state'
import {
  useInsightRecordColumns,
  type InsightRecord,
} from './insight-record-columns'

export function InsightRecords(props: {
  userId: number
  section: UserInsightRecordsSection
}) {
  const { t } = useTranslation()
  useSystemConfigStore((state) => state.config.currency)
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  })
  const [logType, setLogType] = useState('0')
  const query = useUserInsight(
    props.userId,
    props.section,
    pagination.pageIndex + 1,
    Number(logType)
  )
  const page: UserInsightPage<InsightRecord> | undefined = query.data
  const logTypes = [
    { value: '0', label: t('All types') },
    { value: '1', label: t('Top-up') },
    { value: '2', label: t('Consume') },
    { value: '3', label: t('Manage') },
    { value: '4', label: t('System') },
    { value: '5', label: t('Error') },
    { value: '6', label: t('Usage quota return (not cash)') },
    { value: '7', label: t('Login') },
  ]

  const columns = useInsightRecordColumns(props.section, logTypes)

  const { table } = useDataTable({
    data: page?.items ?? [],
    columns,
    pagination,
    onPaginationChange: setPagination,
    manualPagination: true,
    manualSorting: true,
    enableSorting: false,
    enableRowSelection: false,
    totalCount: page?.total ?? 0,
    columnVisibilityStorageKey: false,
    columnSizingStorageKey: false,
  })

  return (
    <div className='space-y-3'>
      {props.section === 'logs' && (
        <div className='flex flex-wrap items-center gap-2'>
          <Label htmlFor='user-insight-log-type'>{t('Log Type')}</Label>
          <Select
            items={logTypes}
            value={logType}
            onValueChange={(value) => {
              if (value === null) return
              setLogType(value)
              setPagination({ pageIndex: 0, pageSize: 10 })
            }}
          >
            <SelectTrigger id='user-insight-log-type' className='min-w-44'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {logTypes.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {props.section === 'topups' && (
        <p className='text-muted-foreground text-xs'>
          {t(
            'Historical payment currency was not recorded. Amounts are shown as stored; verify the original gateway receipt before calculating a cash refund.'
          )}
        </p>
      )}
      {props.section === 'redemptions' && (
        <p className='text-muted-foreground text-xs'>
          {t(
            'Redemptions are credited quota, not proof of a cash payment. Usable redemption codes are never shown here.'
          )}
        </p>
      )}
      {props.section === 'checkins' && (
        <p className='text-muted-foreground text-xs'>
          {t(
            'Check-in grants come from recorded rewards. Current reward settings are not used to reconstruct historical grants.'
          )}
        </p>
      )}
      {props.section === 'logs' && (
        <p className='text-muted-foreground text-xs'>
          {t(
            'Usage quota returns are not cash refunds. Filter System, Manage or Top-up to review grant and adjustment records; missing history does not prove no grant was issued.'
          )}
        </p>
      )}
      <InsightQueryState
        pending={query.isPending}
        error={query.error}
        retry={() => void query.refetch()}
      >
        <DataTableView
          table={table}
          tableClassName='min-w-[640px]'
          emptyTitle={t('No records found')}
          emptyDescription={t(
            'No records were found for this user and filter.'
          )}
        />
        <DataTablePagination table={table} compact />
      </InsightQueryState>
    </div>
  )
}
