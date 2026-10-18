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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { lazy, Suspense } from 'react'
import { expect, test, vi } from 'vitest'

import { Button } from '@/components/ui/button'

import { NoticeBoundary } from '../notice-boundary'

test('an optional notice chunk failure keeps the surrounding dashboard visible and usable', async () => {
  const UnavailableNotice = lazy(async () => {
    throw new Error('Optional notice chunk could not be loaded')
  })
  const onCaughtError = vi.fn()
  const onDashboardAction = vi.fn()
  render(
    <>
      <main>
        <h1>Dashboard overview</h1>
        <Button onClick={onDashboardAction}>Inspect usage</Button>
      </main>
      <NoticeBoundary>
        <Suspense fallback={null}>
          <UnavailableNotice />
        </Suspense>
      </NoticeBoundary>
    </>,
    { onCaughtError }
  )

  await waitFor(() => expect(onCaughtError).toHaveBeenCalled())
  expect(
    screen.getByRole('heading', { name: 'Dashboard overview' })
  ).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Inspect usage' }))
  expect(onDashboardAction).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
