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
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement, options: Record<string, unknown>) => string
      remove: (widgetId: string) => void
    }
  }
}

interface TurnstileProps {
  siteKey: string
  action: 'login' | 'signup' | 'password_reset' | 'checkin'
  onVerify: (token: string) => void
  onExpire?: () => void
  className?: string
}

export function Turnstile({
  siteKey,
  action,
  onVerify,
  onExpire,
  className,
}: TurnstileProps) {
  const { t } = useTranslation()
  const [loadError, setLoadError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const ref = useRef<HTMLDivElement | null>(null)
  const verify = useEffectEvent((token: string) => onVerify(token))
  const expire = useEffectEvent(() => {
    onVerify('')
    onExpire?.()
  })

  useEffect(() => {
    const element = ref.current
    if (!element) return
    let widgetId: string | undefined
    let widgetSize: 'compact' | 'flexible' | undefined
    let disposed = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const fail = () => {
      if (!disposed) {
        setLoadError(true)
        expire()
      }
    }
    const render = () => {
      if (disposed || !window.turnstile) return
      clearTimeout(timeout)
      const width = element.getBoundingClientRect().width
      if (width === 0) return
      const size = width < 300 ? 'compact' : 'flexible'
      if (widgetId !== undefined && widgetSize === size) return
      try {
        if (widgetId !== undefined) {
          window.turnstile.remove(widgetId)
          widgetId = undefined
          expire()
        }
        widgetId = window.turnstile.render(element, {
          sitekey: siteKey,
          action,
          size,
          callback: (token: string) => {
            if (!disposed) {
              setLoadError(false)
              verify(token)
            }
          },
          'error-callback': () => {
            fail()
            return true
          },
          'expired-callback': () => {
            if (!disposed) expire()
          },
          'timeout-callback': () => {
            if (!disposed) expire()
          },
        })
        widgetSize = size
      } catch {
        fail()
      }
    }

    const observer = new ResizeObserver(render)
    observer.observe(element)
    const scriptId = 'cf-turnstile'
    let script = document.querySelector<HTMLScriptElement>(`#${scriptId}`)
    if (!window.turnstile) {
      if (!script) {
        script = document.createElement('script')
        script.id = scriptId
        script.src =
          'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
        script.async = true
        script.defer = true
        document.head.appendChild(script)
      }
      script.addEventListener('load', render)
      script.addEventListener('error', fail)
      timeout = setTimeout(fail, 15000)
    }
    render()
    return () => {
      disposed = true
      clearTimeout(timeout)
      observer.disconnect()
      script?.removeEventListener('load', render)
      script?.removeEventListener('error', fail)
      if (widgetId !== undefined) window.turnstile?.remove(widgetId)
    }
  }, [siteKey, action, attempt])

  return (
    <div className='w-full min-w-0'>
      <div
        ref={ref}
        className={cn(
          'flex w-full min-w-0 justify-center [contain:inline-size]',
          className
        )}
      />
      {loadError && (
        <div
          role='alert'
          className='text-muted-foreground mt-2 space-y-2 text-sm'
        >
          <p>
            {t(
              'Human verification could not load. Check your connection and retry.'
            )}
          </p>
          <Button
            type='button'
            variant='outline'
            onClick={() => {
              if (!window.turnstile) {
                document.querySelector('#cf-turnstile')?.remove()
              }
              setLoadError(false)
              setAttempt((value) => value + 1)
            }}
          >
            {t('Retry verification')}
          </Button>
        </div>
      )}
    </div>
  )
}
