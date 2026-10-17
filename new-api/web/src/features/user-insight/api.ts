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

import { api } from '@/lib/api'
import {
  createServerError,
  requireServerSuccess,
} from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import type { UserInsightData, UserInsightSection } from './types'

export function useUserInsight<T extends UserInsightSection>(
  userId: number,
  section: T,
  page = 1,
  logType = 0
) {
  const viewerId = useAuthStore((state) => state.auth.user?.id)
  return useQuery({
    queryKey: ['user-insight', viewerId, userId, section, page, logType],
    queryFn: async ({ signal }) => {
      const response = await api.get<{
        success: boolean
        data?: UserInsightData[T]
      }>(`/api/user/${userId}/insight`, {
        params: { section, p: page, page_size: 10, log_type: logType },
        signal,
      })
      const result = requireServerSuccess(response.data)
      if (!result.data) {
        throw createServerError(result, 'Failed to load user details')
      }
      return result.data
    },
    enabled: Number.isSafeInteger(userId) && userId > 0,
    retry: false,
    gcTime: 0,
    meta: { errorToast: false },
  })
}
