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
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'

import { SignOutDialog } from '@/components/sign-out-dialog'
import { AuthLayout } from '@/features/auth/auth-layout'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { NavLinkItem } from '../components/nav-link-item'

vi.mock('@/hooks/use-system-config', () => ({
  useSystemConfig: () => ({
    systemName: 'Test Gateway',
    logo: '/logo.png',
    loading: false,
  }),
}))

async function renderNavigation(content: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const root = createRootRoute({ component: Outlet })
  const entry = createRoute({
    getParentRoute: () => root,
    path: '/sign-in',
    component: () => content,
  })
  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <div>Built-in home</div>,
  })
  const pricing = createRoute({
    getParentRoute: () => root,
    path: '/pricing',
    component: () => <div>Model pricing</div>,
  })
  const router = createRouter({
    routeTree: root.addChildren([entry, home, pricing]),
    history: createMemoryHistory({ initialEntries: ['/sign-in'] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  await router.load()
  return { router, queryClient }
}

beforeEach(() => {
  useAuthStore.getState().auth.reset('complete')
})

it('clicking the sign-in brand loads the homepage document instead of the built-in home', async () => {
  const { router } = await renderNavigation(
    <AuthLayout>Sign in form</AuthLayout>
  )
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue()

  await userEvent.click(
    await screen.findByRole('link', { name: /Test Gateway/ })
  )

  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ to: '/', reloadDocument: true })
  )
})

it('clicking Home loads a document while other navigation remains within the app', async () => {
  const { router } = await renderNavigation(
    <>
      <NavLinkItem link={{ title: 'Home', href: '/' }} />
      <NavLinkItem link={{ title: 'Models', href: '/pricing' }} />
    </>
  )
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue()

  await userEvent.click(await screen.findByRole('link', { name: 'Home' }))
  expect(navigate).toHaveBeenLastCalledWith(
    expect.objectContaining({ to: '/', reloadDocument: true })
  )

  await userEvent.click(screen.getByRole('link', { name: 'Models' }))
  expect(navigate).toHaveBeenLastCalledWith(
    expect.objectContaining({ to: '/pricing', reloadDocument: false })
  )
})

it('successful sign-out clears account state and loads the homepage document', async () => {
  vi.spyOn(api, 'post').mockResolvedValue({ data: { success: true } })
  useAuthStore.getState().auth.setUser({
    id: 42,
    username: 'test-member',
    role: 1,
  })
  const { router, queryClient } = await renderNavigation(
    <SignOutDialog open onOpenChange={() => undefined} />
  )
  queryClient.setQueryData(['private-account'], { balance: 10 })
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue()

  await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))

  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/', replace: true, reloadDocument: true })
    )
  )
  expect(useAuthStore.getState().auth.user).toBeNull()
  expect(queryClient.getQueryData(['private-account'])).toBeUndefined()
})

it('rejected sign-out keeps account state and does not navigate to the homepage', async () => {
  vi.spyOn(api, 'post').mockResolvedValue({ data: { success: false } })
  useAuthStore.getState().auth.setUser({
    id: 42,
    username: 'test-member',
    role: 1,
  })
  const { router } = await renderNavigation(
    <SignOutDialog open onOpenChange={() => undefined} />
  )
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue()

  await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))

  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled()
  )
  expect(useAuthStore.getState().auth.user?.id).toBe(42)
  expect(navigate).not.toHaveBeenCalled()
})
