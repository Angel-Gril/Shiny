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
import { Link } from '@tanstack/react-router'
import { BookOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { useStatus } from '@/hooks/use-status'

function RUServiceLinks() {
  const { t } = useTranslation()
  return (
    <div className='mt-3 flex flex-wrap gap-2'>
      <Button
        size='sm'
        variant='outline'
        role='link'
        render={<Link to='/pricing' />}
      >
        {t('Pricing')}
      </Button>
      <Button
        size='sm'
        variant='outline'
        role='link'
        render={<Link to='/wallet' />}
      >
        {t('Wallet')}
      </Button>
      <Button
        size='sm'
        variant='outline'
        role='link'
        render={<Link to='/keys' />}
      >
        {t('API Keys')}
      </Button>
      <Button
        size='sm'
        variant='outline'
        role='link'
        render={
          <Link to='/usage-logs/$section' params={{ section: 'common' }} />
        }
      >
        {t('Usage Logs')}
      </Button>
      <Button
        size='sm'
        variant='ghost'
        role='link'
        render={<a href='/docs/' />}
      >
        {t('Connection guide')}
      </Button>
      <Button
        size='sm'
        variant='ghost'
        role='link'
        render={<a href='/status/' />}
      >
        {t('Model status')}
      </Button>
    </div>
  )
}

// Public navigation across the RU customer journey. Never loads a usable key.
export function RUServiceGuide(props: {
  context: 'overview' | 'keys' | 'wallet' | 'logs'
}) {
  const { t } = useTranslation()
  const { status } = useStatus()
  if (status?.site_profile !== 'ru') return null
  const compact = props.context === 'keys' || props.context === 'logs'
  const apiBase = `${window.location.origin}/v1`
  const descriptions = {
    overview:
      'Choose a model, add funds, create a key, then review your usage.',
    keys: 'Create your key here and use it with this API address. Keep keys in server environment variables.',
    wallet:
      'Your wallet credit is measured in USD. Checkout shows the payment currency and exact amount. Verify a pending order before paying again.',
    logs: 'Review the model, token usage, charge and request ID for each call. Include the request ID when contacting support.',
  }
  return (
    <section
      aria-label={t('Shiny RU connection guide')}
      className='via-card to-card mb-3 min-w-0 rounded-xl border bg-linear-to-br from-lime-500/8 p-3 sm:p-4'
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <p className='text-xs font-medium tracking-wider text-lime-700 uppercase dark:text-lime-300'>
          SHINY / RU
        </p>
        {compact && (
          <Dialog
            title={t('Connection guide')}
            description={t(descriptions[props.context])}
            trigger={
              <Button
                variant='ghost'
                size='sm'
                aria-label={t('Connection guide')}
                title={t('Connection guide')}
              >
                <BookOpen aria-hidden='true' className='size-3.5' />
                <span className='hidden min-w-0 truncate sm:inline'>
                  {t('Connection guide')}
                </span>
              </Button>
            }
          >
            <RUServiceLinks />
          </Dialog>
        )}
      </div>
      <div className='bg-background mt-2 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md border px-3 py-1'>
        <code className='min-w-0 text-xs break-all'>{apiBase}</code>
        <CopyButton
          value={apiBase}
          size='sm'
          aria-label={t('Copy API address')}
        />
      </div>
      {!compact && (
        <>
          <p className='text-muted-foreground mt-2 max-w-3xl text-sm'>
            {t(descriptions[props.context])}
          </p>
          <RUServiceLinks />
        </>
      )}
    </section>
  )
}
