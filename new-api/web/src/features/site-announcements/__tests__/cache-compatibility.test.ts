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
import { beforeEach, expect, test } from 'vitest'

import { initializeFrontendCache } from '@/lib/frontend-cache'
import { markNoticeRead, NOTICE_READ_KEY } from '@/lib/site-notice-policy'

beforeEach(() => {
  window.localStorage.clear()
})

test('first console boot preserves notice acknowledgement written by the portal', () => {
  const version = `notice-v1:${'a'.repeat(64)}`
  markNoticeRead(version)
  window.localStorage.setItem('obsolete-ui-cache', 'old')
  initializeFrontendCache()
  expect(
    JSON.parse(window.localStorage.getItem(NOTICE_READ_KEY) ?? '{}')
  ).toEqual({
    schema: 1,
    versions: [version],
  })
  expect(window.localStorage.getItem('obsolete-ui-cache')).toBeNull()
})
