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
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { Button } from '@/components/ui/button'
import { useNotifications } from '@/hooks/use-notifications'
import { api } from '@/lib/api'
import {
  isNoticeRead,
  markNoticeRead,
  noticeVersion,
} from '@/lib/site-notice-policy'
import { useNotificationStore } from '@/stores/notification-store'

function NotificationActions() {
  const notifications = useNotifications()
  return (
    <>
      <output aria-label='Unread notices'>
        {notifications.unreadNoticeCount}
      </output>
      <Button onClick={() => notifications.openPopover('notice')}>
        Read notice
      </Button>
      <Button onClick={() => notifications.openPopover('announcements')}>
        Read timeline
      </Button>
    </>
  )
}

let client: QueryClient

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('crypto', webcrypto)
  useNotificationStore.setState({
    lastReadNotice: '',
    readAnnouncementKeys: [],
    closedUntilDate: null,
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['status'], { announcements_enabled: false })
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: url === '/api/notice' ? 'Current system notice' : {},
    },
  }))
})

afterEach(() => {
  client.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('viewing the notice through the manual bell shares its read fingerprint with the portal', async () => {
  render(
    <QueryClientProvider client={client}>
      <NotificationActions />
    </QueryClientProvider>
  )
  await waitFor(() =>
    expect(screen.getByLabelText('Unread notices')).toHaveTextContent('1')
  )
  await userEvent.click(screen.getByRole('button', { name: 'Read notice' }))
  const version = (await noticeVersion('Current system notice')) ?? ''
  await waitFor(() => expect(isNoticeRead(version)).toBe(true))
  expect(screen.getByLabelText('Unread notices')).toHaveTextContent('0')
})

test('opening only the history tab does not mark an unseen system notice as read', async () => {
  render(
    <QueryClientProvider client={client}>
      <NotificationActions />
    </QueryClientProvider>
  )
  await waitFor(() =>
    expect(screen.getByLabelText('Unread notices')).toHaveTextContent('1')
  )
  await userEvent.click(screen.getByRole('button', { name: 'Read timeline' }))
  expect(
    isNoticeRead((await noticeVersion('Current system notice')) ?? '')
  ).toBe(false)
  expect(screen.getByLabelText('Unread notices')).toHaveTextContent('1')
})

test('acknowledging the popup removes the unread bell count through the shared same-page event', async () => {
  render(
    <QueryClientProvider client={client}>
      <NotificationActions />
    </QueryClientProvider>
  )
  await waitFor(() =>
    expect(screen.getByLabelText('Unread notices')).toHaveTextContent('1')
  )
  const version = (await noticeVersion('Current system notice')) ?? ''
  act(() => markNoticeRead(version))
  await waitFor(() =>
    expect(screen.getByLabelText('Unread notices')).toHaveTextContent('0')
  )
})

test('a notice read using the previous bell format is migrated without showing it again', async () => {
  useNotificationStore.setState({ lastReadNotice: 'Current system notice' })
  render(
    <QueryClientProvider client={client}>
      <NotificationActions />
    </QueryClientProvider>
  )
  const version = (await noticeVersion('Current system notice')) ?? ''
  await waitFor(() => expect(isNoticeRead(version)).toBe(true))
  expect(screen.getByLabelText('Unread notices')).toHaveTextContent('0')
})
