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
import { webcrypto } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  window.localStorage.clear()
  vi.stubGlobal('crypto', webcrypto)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('shared notice versions', () => {
  test('line endings and outer whitespace normalize to the same SHA-256 version', async () => {
    const policy = await import('@/lib/site-notice-policy')
    expect(await policy.noticeVersion('  abc\r\n ')).toBe(
      'notice-v1:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    expect(policy.normalizeNotice(' one\r\ntwo\rthree ')).toBe(
      'one\ntwo\nthree'
    )
    expect(policy.normalizeNotice({ content: 'not text' })).toBe('')
  })

  test('blank content and unavailable secure hashing skip the automatic notice', async () => {
    const policy = await import('@/lib/site-notice-policy')
    expect(await policy.noticeVersion(' \r\n\t')).toBeNull()
    vi.stubGlobal('crypto', {})
    expect(await policy.noticeVersion('A public announcement')).toBeNull()
  })

  test('read fingerprints survive reimport while edited content has a new unread version', async () => {
    let policy = await import('@/lib/site-notice-policy')
    const first = (await policy.noticeVersion('Available today')) ?? ''
    const edited = (await policy.noticeVersion('Available tomorrow')) ?? ''
    policy.markNoticeRead(first)
    vi.resetModules()
    policy = await import('@/lib/site-notice-policy')
    expect(policy.isNoticeRead(first)).toBe(true)
    expect(policy.isNoticeRead(edited)).toBe(false)
    const stored = JSON.parse(
      window.localStorage.getItem(policy.NOTICE_READ_KEY) ?? '{}'
    )
    expect(stored).toEqual({ schema: 1, versions: [first] })
    expect(JSON.stringify(stored)).not.toContain('Available')
  })

  test.each([
    '{invalid',
    JSON.stringify({ schema: 2, versions: [`notice-v1:${'a'.repeat(64)}`] }),
    JSON.stringify({ schema: 1, versions: ['not-a-fingerprint'] }),
    JSON.stringify({ schema: 1, versions: [42] }),
  ])(
    'malformed stored records are ignored without breaking read tracking: %s',
    async (record) => {
      const policy = await import('@/lib/site-notice-policy')
      const version = `notice-v1:${'a'.repeat(64)}`
      window.localStorage.setItem(policy.NOTICE_READ_KEY, record)
      expect(policy.isNoticeRead(version)).toBe(false)
      policy.markNoticeRead(version)
      expect(policy.isNoticeRead(version)).toBe(true)
    }
  )

  test('only the latest 100 unique fingerprints are retained', async () => {
    const policy = await import('@/lib/site-notice-policy')
    const versions = Array.from(
      { length: 101 },
      (_, index) => `notice-v1:${index.toString(16).padStart(64, '0')}`
    )
    versions.forEach(policy.markNoticeRead)
    expect(policy.isNoticeRead(versions[0])).toBe(false)
    expect(policy.isNoticeRead(versions[100])).toBe(true)
    policy.markNoticeRead(versions[100])
    const stored = JSON.parse(
      window.localStorage.getItem(policy.NOTICE_READ_KEY) ?? '{}'
    )
    expect(stored.versions).toHaveLength(100)
  })

  test.each(['getItem', 'setItem'] as const)(
    'when storage %s fails, read state remains available for the current page',
    async (operation) => {
      const policy = await import('@/lib/site-notice-policy')
      vi.spyOn(Storage.prototype, operation).mockImplementation(() => {
        throw new DOMException('Storage blocked', 'SecurityError')
      })
      const version = `notice-v1:${'b'.repeat(64)}`
      expect(() => policy.markNoticeRead(version)).not.toThrow()
      expect(policy.isNoticeRead(version)).toBe(true)
    }
  )

  test('same-page and matching cross-window events notify subscribers until unsubscribed', async () => {
    const policy = await import('@/lib/site-notice-policy')
    const listener = vi.fn()
    const unsubscribe = policy.subscribeNoticeRead(listener)
    policy.markNoticeRead(`notice-v1:${'c'.repeat(64)}`)
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }))
    expect(listener).toHaveBeenCalledTimes(1)
    window.dispatchEvent(
      new StorageEvent('storage', { key: policy.NOTICE_READ_KEY })
    )
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  test('the shared module can be imported without a browser window', async () => {
    vi.stubGlobal('window', undefined)
    const policy = await import('@/lib/site-notice-policy')
    expect(policy.normalizeNotice(' public text ')).toBe('public text')
    expect(policy.subscribeNoticeRead(() => undefined)).toBeTypeOf('function')
  })
})
