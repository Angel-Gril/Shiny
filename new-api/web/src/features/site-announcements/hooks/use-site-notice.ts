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
import { useEffect, useState } from 'react'

import {
  isNoticeRead,
  normalizeNotice,
  noticeVersion,
  subscribeNoticeRead,
} from '@/lib/site-notice-policy'

export function useSiteNotice(content: unknown): {
  content: string
  version: string | null
  read: boolean
} {
  const normalized = normalizeNotice(content)
  const [fingerprint, setFingerprint] = useState<{
    content: string
    version: string | null
  } | null>(null)
  const [, setReadRevision] = useState(0)

  useEffect(() => {
    let active = true
    void noticeVersion(normalized)
      .then((version) => {
        if (active) setFingerprint({ content: normalized, version })
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [normalized])

  useEffect(
    () => subscribeNoticeRead(() => setReadRevision((value) => value + 1)),
    []
  )

  const version =
    fingerprint?.content === normalized ? fingerprint.version : null
  return {
    content: normalized,
    version,
    read: version ? isNoticeRead(version) : false,
  }
}
