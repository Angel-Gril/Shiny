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

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { Dialog } from '@/components/dialog'
import { api } from '@/lib/api'
import {
  NOTICE_READ_KEY,
  isNoticeRead,
  noticeVersion,
} from '@/lib/site-notice-policy'

import { NoticeBoundary } from '../notice-boundary'
import { SiteNoticePopup } from '../notice-popup'

const clients: QueryClient[] = []

function renderNotice(content?: string, blocked = false) {
  if (content !== undefined) {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: content },
    })
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  const view = render(
    <QueryClientProvider client={client}>
      <p>Console remains usable</p>
      {blocked ? (
        <Dialog open title='Payment confirmation'>
          <p>Existing operation</p>
        </Dialog>
      ) : null}
      <NoticeBoundary>
        <SiteNoticePopup />
      </NoticeBoundary>
    </QueryClientProvider>
  )
  return { client, view }
}

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('crypto', webcrypto)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('first-read notice popup', () => {
  test('new content opens an accessible dialog and renders sanitized complete Markdown', async () => {
    renderNotice(
      '## Platform update\n\n**New tools** are ready.\n\n[Read guide](/docs/)\n\n<img src="x" onerror="alert(1)"><script>alert(2)</script>'
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'System Announcements',
    })
    expect(
      within(dialog).getByRole('heading', { name: 'Platform update' })
    ).toBeVisible()
    expect(within(dialog).getByText('New tools')).toHaveProperty(
      'tagName',
      'STRONG'
    )
    expect(
      within(dialog).getByRole('link', { name: 'Read guide' })
    ).toHaveAttribute('href', '/docs/')
    expect(dialog.querySelector('script')).toBeNull()
    expect(dialog.querySelector('[onerror]')).toBeNull()
    expect(
      within(dialog).getByRole('link', { name: 'View details' })
    ).toHaveAttribute('href', '/announcements/system-notice')
  })

  test.each(['Got it', 'Close', 'Escape', 'Backdrop'])(
    'dismissal using %s records the version and prevents another popup on remount',
    async (method) => {
      const content = `Notice closed through ${method}`
      const { view } = renderNotice(content)
      await screen.findByRole('dialog', { name: 'System Announcements' })
      if (method === 'Escape') await userEvent.keyboard('{Escape}')
      else if (method === 'Backdrop') {
        const overlay = document.querySelector<HTMLElement>(
          '[data-slot="dialog-overlay"]'
        )
        if (!overlay) throw new Error('Expected the visible dialog backdrop')
        await userEvent.click(overlay)
      } else await userEvent.click(screen.getByRole('button', { name: method }))
      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      )
      expect(isNoticeRead((await noticeVersion(content)) ?? '')).toBe(true)
      view.unmount()
      const next = renderNotice(content)
      await waitFor(() =>
        expect(next.client.getQueryState(['notice'])?.status).toBe('success')
      )
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    }
  )

  test('opening full details records the currently displayed notice before full-page navigation', async () => {
    const content = 'Notice with full details'
    renderNotice(content)
    await screen.findByRole('dialog', { name: 'System Announcements' })
    const details = screen.getByRole('link', { name: 'View details' })
    // jsdom has no full-page navigation; only that external boundary is suppressed.
    details.addEventListener('click', (event) => event.preventDefault(), {
      once: true,
    })
    await userEvent.click(details)
    expect(isNoticeRead((await noticeVersion(content)) ?? '')).toBe(true)
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
  })

  test('an updated body displays again after the preceding version was acknowledged', async () => {
    const { client } = renderNotice('Version one')
    await screen.findByRole('dialog', { name: 'System Announcements' })
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    act(() =>
      client.setQueryData(['notice'], { success: true, data: 'Version two' })
    )
    expect(await screen.findByText('Version two')).toBeVisible()
  })

  test('blank content finishes loading without interrupting the console', async () => {
    const { client } = renderNotice(' \r\n ')
    await waitFor(() =>
      expect(client.getQueryState(['notice'])?.status).toBe('success')
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('Console remains usable')).toBeVisible()
  })

  test('a failing notice request leaves the console usable without an empty modal', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('Network unavailable'))
    const { client } = renderNotice()
    await waitFor(() =>
      expect(client.getQueryState(['notice'])?.status).toBe('error')
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('Console remains usable')).toBeVisible()
  })

  test('reading the same version in another window closes the visible popup', async () => {
    const content = 'Shared browser announcement'
    renderNotice(content)
    await screen.findByRole('dialog', { name: 'System Announcements' })
    const version = (await noticeVersion(content)) ?? ''
    act(() => {
      window.localStorage.setItem(
        NOTICE_READ_KEY,
        JSON.stringify({ schema: 1, versions: [version] })
      )
      window.dispatchEvent(
        new StorageEvent('storage', { key: NOTICE_READ_KEY })
      )
    })
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
  })

  test('an existing confirmation dialog is never covered by an automatic announcement', async () => {
    const { client } = renderNotice(
      'Notice waiting for another operation',
      true
    )
    await waitFor(() =>
      expect(client.getQueryState(['notice'])?.status).toBe('success')
    )
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(
      screen.getByRole('dialog', { name: 'Payment confirmation' })
    ).toBeVisible()
    expect(
      screen.queryByRole('dialog', { name: 'System Announcements' })
    ).not.toBeInTheDocument()
  })

  test('a response completed after leaving the dashboard cannot open a popup or mark it read', async () => {
    let complete: (response: {
      data: { success: boolean; data: string }
    }) => void = () => {
      throw new Error('Notice request has not started')
    }
    const response = new Promise<{ data: { success: boolean; data: string } }>(
      (resolve) => {
        complete = resolve
      }
    )
    vi.spyOn(api, 'get').mockReturnValue(response)
    const { view } = renderNotice()
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    view.unmount()
    await act(async () => {
      complete({ data: { success: true, data: 'Abandoned response' } })
      await response
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(NOTICE_READ_KEY)).toBeNull()
  })

  test('an older delayed fingerprint cannot replace a newer notice after content changes', async () => {
    let finishFirst: (digest: ArrayBuffer) => void = () => {
      throw new Error('Notice hashing has not started')
    }
    const firstDigest = new Promise<ArrayBuffer>((resolve) => {
      finishFirst = resolve
    })
    const originalDigest = globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle
    )
    const digest = vi
      .spyOn(globalThis.crypto.subtle, 'digest')
      .mockImplementationOnce(() => firstDigest)
    const { client } = renderNotice('Outdated content')
    await waitFor(() => expect(digest).toHaveBeenCalledOnce())
    act(() =>
      client.setQueryData(['notice'], {
        success: true,
        data: 'Updated content',
      })
    )
    expect(await screen.findByText('Updated content')).toBeVisible()
    await act(async () => {
      finishFirst(
        await originalDigest(
          'SHA-256',
          new TextEncoder().encode('Outdated content')
        )
      )
      await firstDigest
    })
    expect(screen.queryByText('Outdated content')).not.toBeInTheDocument()
    expect(screen.getByText('Updated content')).toBeVisible()
  })
})
