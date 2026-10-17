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
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import {
  getServerErrorMessage,
  getServerErrorStatus,
} from '@/lib/server-error-message'

export function InsightQueryState(props: {
  pending: boolean
  error: unknown
  retry: () => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  if (props.pending) {
    return <LoadingState message={t('Loading user details...')} />
  }
  if (props.error) {
    const forbidden = getServerErrorStatus(props.error) === 403
    return (
      <ErrorState
        title={t('Failed to load user details')}
        description={
          forbidden
            ? t('You do not have permission to view this user.')
            : getServerErrorMessage(props.error, t('Please try again later.'))
        }
        onRetry={forbidden ? undefined : props.retry}
      />
    )
  }
  return props.children
}
