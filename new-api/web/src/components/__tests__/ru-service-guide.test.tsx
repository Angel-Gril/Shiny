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
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import ru from '@/i18n/locales/ru.json'
import { api } from '@/lib/api'

import { RUServiceGuide } from '../ru-service-guide'

let client: QueryClient

async function renderGuide(
  profile: string,
  context: 'overview' | 'keys' | 'wallet' | 'logs' = 'overview'
) {
  client.setQueryData(['status'], { site_profile: profile })
  const root = createRootRoute()
  const entry = createRoute({
    getParentRoute: () => root,
    path: '/dashboard',
    component: () => <RUServiceGuide context={context} />,
  })
  const wallet = createRoute({
    getParentRoute: () => root,
    path: '/wallet',
    component: () => <h1>Wallet destination</h1>,
  })
  const router = createRouter({
    routeTree: root.addChildren([entry, wallet]),
    history: createMemoryHistory({ initialEntries: ['/dashboard'] }),
  })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  await act(() => router.load())
  return router
}

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(async () => {
  client.clear()
  localStorage.clear()
  await act(() => i18next.changeLanguage('en'))
  i18next.removeResourceBundle('ru', 'translation')
})

it('a domestic site has no RU connection guide or extra account requests', async () => {
  const get = vi.spyOn(api, 'get')
  await renderGuide('default')
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  expect(get).not.toHaveBeenCalled()
})

it('RU customers can copy their current API origin and navigate to their wallet without loading any key', async () => {
  const user = userEvent.setup()
  const get = vi.spyOn(api, 'get')
  const router = await renderGuide('ru')
  const guide = screen.getByRole('region', {
    name: 'Shiny RU connection guide',
  })
  const base = `${window.location.origin}/v1`
  expect(within(guide).getByText(base)).toBeVisible()
  await user.click(
    within(guide).getByRole('button', { name: 'Copy API address' })
  )
  expect(await navigator.clipboard.readText()).toBe(base)
  expect(within(guide).getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(
    within(guide).getByRole('link', { name: 'Usage Logs' })
  ).toHaveAttribute('href', '/usage-logs/common')
  expect(
    within(guide).getByRole('link', { name: 'Connection guide' })
  ).toHaveAttribute('href', '/docs/')
  expect(
    within(guide).getByRole('link', { name: 'Model status' })
  ).toHaveAttribute('href', '/status/')
  await user.click(within(guide).getByRole('link', { name: 'Wallet' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/wallet'))
  expect(
    screen.getByRole('heading', { name: 'Wallet destination' })
  ).toBeVisible()
  expect(get).not.toHaveBeenCalled()
})

it('changing the interface language updates connection instructions and accessible copy labels', async () => {
  i18next.addResourceBundle('ru', 'translation', ru.translation)
  await act(() => i18next.changeLanguage('ru'))
  await renderGuide('ru')
  expect(
    screen.getByRole('region', {
      name: ru.translation['Shiny RU connection guide'],
    })
  ).toBeVisible()
  expect(
    screen.getByRole('button', { name: ru.translation['Copy API address'] })
  ).toBeVisible()
  await act(() => i18next.changeLanguage('en'))
  expect(screen.getByRole('button', { name: 'Copy API address' })).toBeVisible()
  expect(
    screen.getByText(
      'Choose a model, add funds, create a key, then review your usage.'
    )
  ).toBeVisible()
})

it.each(['keys', 'logs'] as const)(
  'the %s list keeps its API address visible while keyboard-opened instructions use a dialog and restore focus',
  async (context) => {
    const user = userEvent.setup()
    await renderGuide('ru', context)
    const guide = screen.getByRole('region', {
      name: 'Shiny RU connection guide',
    })
    expect(
      within(guide).getByText(`${window.location.origin}/v1`)
    ).toBeVisible()
    const toggle = within(guide).getByRole('button', {
      name: 'Connection guide',
    })
    expect(toggle).toHaveAttribute('aria-haspopup', 'dialog')
    expect(
      within(guide).queryByRole('link', { name: 'Wallet' })
    ).not.toBeInTheDocument()

    toggle.focus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog', {
      name: 'Connection guide',
    })
    expect(within(dialog).getByRole('link', { name: 'Wallet' })).toBeVisible()
    expect(
      within(dialog).getByRole('link', { name: 'Usage Logs' })
    ).toHaveAttribute('href', '/usage-logs/common')
    expect(guide.querySelector('[data-slot="collapsible-content"]')).toBeNull()

    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(toggle).toHaveFocus()
    expect(
      within(guide).getByRole('button', { name: 'Copy API address' })
    ).toBeVisible()
  }
)
