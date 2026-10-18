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
// Shared by the console and the independent portal. Keep this module dependency-free.
export const NOTICE_READ_KEY = 'shiny.notice-read.v1'
export const NOTICE_READ_EVENT = 'shiny:notice-read'

const versionPattern = /^notice-v1:[a-f0-9]{64}$/
const maxVersions = 100
let memoryVersions = new Set<string>()
let storageUnavailable = false

export function normalizeNotice(content: unknown): string {
  return typeof content === 'string'
    ? content.replaceAll(/\r\n?/g, '\n').trim()
    : ''
}

export async function noticeVersion(content: string): Promise<string | null> {
  const normalized = normalizeNotice(content)
  if (!normalized || !globalThis.crypto?.subtle) return null

  try {
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(normalized)
    )
    const hex = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, '0')
    ).join('')
    return `notice-v1:${hex}`
  } catch {
    return null
  }
}

function readVersions(): Set<string> {
  if (typeof window === 'undefined' || storageUnavailable) return memoryVersions
  let raw: string | null
  try {
    raw = window.localStorage.getItem(NOTICE_READ_KEY)
  } catch {
    storageUnavailable = true
    return memoryVersions
  }
  if (!raw) {
    memoryVersions = new Set()
    return memoryVersions
  }
  try {
    const stored: unknown = JSON.parse(raw)
    if (
      typeof stored !== 'object' ||
      stored === null ||
      !('schema' in stored) ||
      stored.schema !== 1 ||
      !('versions' in stored) ||
      !Array.isArray(stored.versions) ||
      stored.versions.length > maxVersions ||
      !stored.versions.every(
        (version: unknown) =>
          typeof version === 'string' && versionPattern.test(version)
      )
    ) {
      memoryVersions = new Set()
      return memoryVersions
    }
    memoryVersions = new Set(stored.versions as string[])
    return memoryVersions
  } catch {
    memoryVersions = new Set()
    return memoryVersions
  }
}

export function isNoticeRead(version: string): boolean {
  return versionPattern.test(version) && readVersions().has(version)
}

export function markNoticeRead(version: string): void {
  if (!versionPattern.test(version)) return
  const versions = readVersions()
  versions.delete(version)
  versions.add(version)
  const recent = [...versions].slice(-maxVersions)
  memoryVersions = new Set(recent)
  if (typeof window === 'undefined') return
  if (!storageUnavailable) {
    try {
      window.localStorage.setItem(
        NOTICE_READ_KEY,
        JSON.stringify({ schema: 1, versions: recent })
      )
    } catch {
      // Storage can be disabled or full. Current-page read state still works.
      storageUnavailable = true
    }
  }
  window.dispatchEvent(new Event(NOTICE_READ_EVENT))
}

export function subscribeNoticeRead(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const onStorage = (event: StorageEvent): void => {
    if (event.key === NOTICE_READ_KEY || event.key === null) listener()
  }
  window.addEventListener(NOTICE_READ_EVENT, listener)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(NOTICE_READ_EVENT, listener)
    window.removeEventListener('storage', onStorage)
  }
}
