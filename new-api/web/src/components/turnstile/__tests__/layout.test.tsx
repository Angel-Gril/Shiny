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
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { Turnstile } from '@/components/turnstile'

let width = 416
let resize: ResizeObserverCallback
const renderWidget = vi.fn(
  (_element: HTMLElement, _options: Record<string, unknown>) => 'challenge-id'
)
const removeWidget = vi.fn()

beforeEach(() => {
  width = 416
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({
      width,
      height: 65,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 65,
      toJSON: () => ({}),
    })
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  window.turnstile = { render: renderWidget, remove: removeWidget }
})

afterEach(() => {
  delete window.turnstile
  document.querySelector('#cf-turnstile')?.remove()
  vi.unstubAllGlobals()
})

test('widgets mounted while the shared script loads both become ready', () => {
  delete window.turnstile
  const first = render(
    <Turnstile siteKey='public-test-site' onVerify={vi.fn()} />
  )
  const second = render(
    <Turnstile siteKey='public-test-site' onVerify={vi.fn()} />
  )
  expect(document.querySelectorAll('#cf-turnstile')).toHaveLength(1)
  window.turnstile = { render: renderWidget, remove: removeWidget }
  act(() =>
    document.querySelector('#cf-turnstile')?.dispatchEvent(new Event('load'))
  )
  expect(renderWidget).toHaveBeenCalledTimes(2)
  first.unmount()
  second.unmount()
})

test('a 300px form uses flexible sizing without forcing the form to stay wide', () => {
  width = 300
  render(<Turnstile siteKey='public-test-site' onVerify={vi.fn()} />)
  expect(renderWidget).toHaveBeenCalledWith(
    expect.any(HTMLDivElement),
    expect.objectContaining({ size: 'flexible' })
  )
  expect(renderWidget.mock.calls[0]?.[0]).toHaveClass(
    'w-full',
    'min-w-0',
    '[contain:inline-size]',
    'justify-center'
  )
})

test('a form narrower than 300px uses a centered compact challenge and resizes cleanly', () => {
  width = 294
  const onExpire = vi.fn()
  const view = render(
    <Turnstile
      siteKey='public-test-site'
      onVerify={vi.fn()}
      onExpire={onExpire}
    />
  )
  expect(renderWidget).toHaveBeenLastCalledWith(
    expect.any(HTMLDivElement),
    expect.objectContaining({ size: 'compact' })
  )
  width = 416
  act(() => resize([], {} as ResizeObserver))
  expect(removeWidget).toHaveBeenCalledWith('challenge-id')
  expect(onExpire).toHaveBeenCalledOnce()
  expect(renderWidget).toHaveBeenLastCalledWith(
    expect.any(HTMLDivElement),
    expect.objectContaining({ size: 'flexible' })
  )
  view.unmount()
  expect(removeWidget).toHaveBeenCalledTimes(2)
})

test('verification and expiry use the latest callbacks without recreating the challenge', () => {
  const firstVerify = vi.fn()
  const onVerify = vi.fn()
  const onExpire = vi.fn()
  const view = render(
    <Turnstile siteKey='public-test-site' onVerify={firstVerify} />
  )
  view.rerender(
    <Turnstile
      siteKey='public-test-site'
      onVerify={onVerify}
      onExpire={onExpire}
    />
  )
  expect(renderWidget).toHaveBeenCalledOnce()
  const options = renderWidget.mock.calls[0]?.[1] as Record<
    string,
    (token?: string) => void
  >
  act(() => options.callback('test-challenge-token'))
  expect(onVerify).toHaveBeenCalledWith('test-challenge-token')
  expect(firstVerify).not.toHaveBeenCalled()
  act(() => options['expired-callback']())
  act(() => options['error-callback']())
  expect(onExpire).toHaveBeenCalledTimes(2)
})
