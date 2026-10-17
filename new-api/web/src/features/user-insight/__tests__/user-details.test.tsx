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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { UserInsightDialog, UserInsightTrigger } from '..'
import type { UserInsightOverview, UserInsightTopup } from '../types'

function overview(id = 2): UserInsightOverview {
  return {
    user: {
      id,
      username: `member-${id}`,
      display_name: `Member ${id}`,
      email: '',
      role: 1,
      status: 1,
      group: 'default',
      remark: '',
      created_at: 0,
      last_login_at: 0,
      inviter_id: 0,
      inviter_username: '',
      quota: 500000,
      used_quota: 100000,
      request_count: 4,
    },
    stats: {
      successful_topups: 1,
      redemptions: 0,
      checkins: 1,
      log_count: 2,
      consume_count: 1,
      refund_count: 1,
    },
    limitations: {
      wallet_provenance_complete: false,
      payment_currency_recorded: false,
    },
  }
}

function Wrapper(props: { children: ReactNode }) {
  const [router] = useState(() =>
    createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: ['/users'] }),
    })
  )
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
  )
  return (
    <QueryClientProvider client={client}>
      <RouterContextProvider router={router}>
        {props.children}
      </RouterContextProvider>
    </QueryClientProvider>
  )
}

function requestParams(config: { params?: unknown } | undefined): {
  section?: string
  p?: number
  log_type?: number
} {
  return (config?.params ?? {}) as {
    section?: string
    p?: number
    log_type?: number
  }
}

function mockSections() {
  return vi.spyOn(api, 'get').mockImplementation(async (url, config) => {
    const section = requestParams(config).section
    if (section === 'overview') {
      const id = Number(String(url).split('/')[3])
      return { data: { success: true, data: overview(id) } }
    }
    return {
      data: {
        success: true,
        data: { items: [], total: 0, p: 1, page_size: 10 },
      },
    }
  })
}

afterEach(() => vi.restoreAllMocks())

it('opening details with the keyboard shows site credit and incomplete provenance without offering a cash refund', async () => {
  mockSections()
  render(<UserInsightTrigger userId={2}>Open member</UserInsightTrigger>, {
    wrapper: Wrapper,
  })
  const trigger = screen.getByRole('button', { name: 'Open member' })
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  const dialog = await screen.findByRole('dialog', { name: 'User details' })
  await within(dialog).findByText('member-2')
  expect(within(dialog).getByRole('tab', { name: 'Overview' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  expect(within(dialog).getByText('Available site quota')).toBeVisible()
  expect(within(dialog).getByText(/Unknown grants are not zero/)).toBeVisible()
  expect(
    within(dialog).getByText(/not cash or a refundable balance/)
  ).toBeVisible()
  expect(
    within(dialog).queryByRole('button', { name: /^Refund$/ })
  ).not.toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
})

it('changing the target user clears previous details while the next user is loading', async () => {
  let resolveNext: ((value: unknown) => void) | undefined
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/user/3/insight') {
      return (await new Promise((resolve) => {
        resolveNext = resolve
      })) as Awaited<ReturnType<typeof api.get>>
    }
    return { data: { success: true, data: overview(2) } }
  })
  const view = render(
    <UserInsightDialog open userId={2} onOpenChange={() => undefined} />,
    { wrapper: Wrapper }
  )
  await screen.findByText('member-2')
  view.rerender(
    <UserInsightDialog open userId={3} onOpenChange={() => undefined} />
  )
  expect(screen.queryByText('member-2')).not.toBeInTheDocument()
  expect(screen.getByText('Loading user details...')).toBeVisible()
  await waitFor(() => expect(resolveNext).toBeDefined())
  await act(async () =>
    resolveNext?.({ data: { success: true, data: overview(3) } })
  )
  expect(await screen.findByText('member-3')).toBeVisible()
  expect(screen.queryByText('member-2')).not.toBeInTheDocument()
})

it('orders keep stored payment amounts and unknown historical quota separate from a pending order quota snapshot', async () => {
  const order: UserInsightTopup = {
    id: 9,
    trade_no: 'review-order',
    amount: 10,
    credited_quota: 0,
    money: 73,
    payment_method: 'alipay',
    payment_provider: 'example',
    create_time: 1,
    complete_time: 2,
    status: 'success',
  }
  const get = mockSections()
  get.mockImplementation(async (_url, config) => ({
    data: {
      success: true,
      data:
        requestParams(config).section === 'overview'
          ? overview()
          : {
              items: [
                order,
                {
                  ...order,
                  id: 10,
                  trade_no: 'pending-order',
                  status: 'pending',
                  credited_quota: 5000000,
                },
              ],
              total: 2,
              p: 1,
              page_size: 10,
            },
    },
  }))
  render(<UserInsightDialog open userId={2} onOpenChange={() => undefined} />, {
    wrapper: Wrapper,
  })
  await screen.findByText('member-2')
  await userEvent.click(screen.getByRole('tab', { name: 'Top-up orders' }))
  const row = await screen.findByRole('row', { name: /review-order/ })
  expect(within(row).getByText('73')).toBeVisible()
  expect(within(row).getByText('Currency not recorded')).toBeVisible()
  expect(within(row).getByText('Not recorded')).toBeVisible()
  expect(within(row).queryByText(/\$73|¥73/)).not.toBeInTheDocument()
  const pending = screen.getByRole('row', { name: /pending-order/ })
  expect(within(pending).getByText('Not credited')).toBeVisible()
  expect(
    screen.getByRole('columnheader', { name: 'Order quota snapshot' })
  ).toBeVisible()
  expect(
    within(row).getByRole('button', { name: 'Copy order number' })
  ).toBeVisible()
})

it('log pagination remains user scoped and changing the type resets to page one while quota returns are labeled separately from cash', async () => {
  const get = mockSections()
  get.mockImplementation(async (_url, config) => {
    if (requestParams(config).section === 'overview') {
      return { data: { success: true, data: overview() } }
    }
    const p = Number(requestParams(config).p ?? 1)
    const type = Number(requestParams(config).log_type || 6)
    return {
      data: {
        success: true,
        data: {
          items: [
            {
              id: p,
              created_at: 1,
              type,
              content: `page-${p}`,
              model_name: '',
              quota: 100,
              prompt_tokens: 0,
              completion_tokens: 0,
              use_time: 0,
              is_stream: false,
              channel_id: 0,
              token_name: '',
              request_id: '',
            },
          ],
          total: 21,
          p,
          page_size: 10,
        },
      },
    }
  })
  render(<UserInsightDialog open userId={2} onOpenChange={() => undefined} />, {
    wrapper: Wrapper,
  })
  await screen.findByText('member-2')
  await userEvent.click(
    screen.getByRole('tab', { name: 'Usage and quota logs' })
  )
  await screen.findByText('page-1')
  expect(
    screen.getByRole('cell', { name: 'Usage quota return (not cash)' })
  ).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Go to next page' }))
  await screen.findByText('page-2')
  await userEvent.click(screen.getByRole('combobox', { name: 'Log Type' }))
  await userEvent.click(screen.getByRole('option', { name: /^Manage$/ }))
  await screen.findByText('page-1')
  expect(get).toHaveBeenLastCalledWith(
    '/api/user/2/insight',
    expect.objectContaining({
      params: { section: 'logs', p: 1, page_size: 10, log_type: 3 },
    })
  )
  expect(screen.getByRole('cell', { name: 'Manage' })).toBeVisible()
})

it('permission denial shows an inline explanation and never reveals user details', async () => {
  vi.spyOn(api, 'get').mockRejectedValue({
    response: { status: 403, data: { success: false } },
  })
  render(<UserInsightDialog open userId={2} onOpenChange={() => undefined} />, {
    wrapper: Wrapper,
  })
  expect(
    await screen.findByText('You do not have permission to view this user.')
  ).toBeVisible()
  expect(screen.queryByText('member-2')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Retry' })
  ).not.toBeInTheDocument()
})

it('a system grant log without a structured quota does not show zero quota or infer a grant from its content', async () => {
  const get = mockSections()
  get.mockImplementation(async (_url, config) => ({
    data: {
      success: true,
      data:
        requestParams(config).section === 'overview'
          ? overview()
          : {
              items: [
                {
                  id: 7,
                  created_at: 1,
                  type: 4,
                  content: 'Registration grant: $3',
                  model_name: '',
                  quota: 0,
                  prompt_tokens: 0,
                  completion_tokens: 0,
                  use_time: 0,
                  is_stream: false,
                  channel_id: 0,
                  token_name: '',
                  request_id: '',
                },
              ],
              total: 1,
              p: 1,
              page_size: 10,
            },
    },
  }))
  render(<UserInsightDialog open userId={2} onOpenChange={() => undefined} />, {
    wrapper: Wrapper,
  })
  await screen.findByText('member-2')
  await userEvent.click(
    screen.getByRole('tab', { name: 'Usage and quota logs' })
  )
  const row = await screen.findByRole('row', {
    name: /Registration grant: \$3/,
  })
  expect(within(row).getByText('Not recorded')).toBeVisible()
  expect(within(row).queryByText('$0')).not.toBeInTheDocument()
})

it('a failed details request can be retried and replaces the error with the selected user', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockRejectedValueOnce({
      response: { status: 503, data: { message: 'Temporarily unavailable' } },
    })
    .mockResolvedValue({ data: { success: true, data: overview() } })
  render(<UserInsightDialog open userId={2} onOpenChange={() => undefined} />, {
    wrapper: Wrapper,
  })
  expect(await screen.findByText('Temporarily unavailable')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('member-2')).toBeVisible()
  expect(get).toHaveBeenCalledTimes(2)
})

it('empty redemptions and recorded check-in grants have distinct views without exposing redemption keys', async () => {
  const get = mockSections()
  get.mockImplementation(async (_url, config) => {
    const section = requestParams(config).section
    if (section === 'overview') {
      return { data: { success: true, data: overview() } }
    }
    const items =
      section === 'checkins'
        ? [
            {
              id: 1,
              checkin_date: '2026-10-17',
              quota_awarded: 500,
              created_at: 1,
            },
          ]
        : []
    return {
      data: {
        success: true,
        data: { items, total: items.length, p: 1, page_size: 10 },
      },
    }
  })
  render(<UserInsightDialog open userId={2} onOpenChange={() => undefined} />, {
    wrapper: Wrapper,
  })
  await screen.findByText('member-2')
  await userEvent.click(screen.getByRole('tab', { name: 'Redemption records' }))
  expect(await screen.findByText('No records found')).toBeVisible()
  expect(screen.getByText(/not proof of a cash payment/)).toBeVisible()
  await userEvent.click(screen.getByRole('tab', { name: 'Check-in grants' }))
  expect(await screen.findByText('2026-10-17')).toBeVisible()
  expect(
    screen.getByRole('columnheader', { name: 'Granted site quota' })
  ).toBeVisible()
})
