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
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { useStatus } from '@/hooks/use-status'

import { ApiKeyCell } from './api-keys-cells'
import { useApiKeys } from './api-keys-provider'

export function ApiKeyCreatedDialog() {
  const { t } = useTranslation()
  const { open, setOpen, currentRow } = useApiKeys()
  const { status } = useStatus()
  if (open !== 'created' || !currentRow) return null
  const origin =
    typeof status?.server_address === 'string' && status.server_address.trim()
      ? status.server_address.trim()
      : window.location.origin
  const apiBase = `${origin.replace(/\/+$/, '')}/v1`

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && setOpen(null)}
      title={t('Your API key is ready')}
      description={t(
        'One key works with all available providers and models for your account. No group selection is needed.'
      )}
      footer={
        <>
          <Button variant='outline' onClick={() => setOpen('update')}>
            {t('Edit key settings')}
          </Button>
          <Button onClick={() => setOpen(null)}>{t('Done')}</Button>
        </>
      }
    >
      <div className='space-y-4'>
        <div className='min-w-0 space-y-2 rounded-lg border p-3'>
          <p className='text-sm font-medium'>{t('API Key')}</p>
          <ApiKeyCell apiKey={currentRow} />
        </div>
        <div className='min-w-0 space-y-2 rounded-lg border p-3'>
          <p className='text-sm font-medium'>{t('API address')}</p>
          <div className='flex min-w-0 items-center gap-2'>
            <code className='min-w-0 flex-1 text-sm break-all'>{apiBase}</code>
            <CopyButton value={apiBase} aria-label={t('Copy API address')} />
          </div>
        </div>
        <p className='text-muted-foreground text-sm'>
          {t(
            'Uses your account balance and stays valid until revoked. You can set an expiry, budget, model or IP restrictions in key settings.'
          )}
        </p>
      </div>
    </Dialog>
  )
}
