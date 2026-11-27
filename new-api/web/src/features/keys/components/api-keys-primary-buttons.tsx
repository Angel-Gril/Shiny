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
import { ChevronDown, Globe, Plus } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useApiInfo } from '@/features/dashboard/hooks/use-status-data'
import { useStatus } from '@/hooks/use-status'
import { handleServerError } from '@/lib/handle-server-error'

import { createUniversalApiKey } from '../api'
import { useApiKeys } from './api-keys-provider'

export function ApiKeysPrimaryButtons() {
  const { t } = useTranslation()
  const { setOpen, setCurrentRow, triggerRefresh } = useApiKeys()
  const { status, loading } = useStatus()
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const { items } = useApiInfo()

  const createKey = async () => {
    if (status?.site_profile !== 'ru' || status.ru_universal_keys !== true) {
      setCurrentRow(null)
      setOpen('create')
      return
    }
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    try {
      const created = await createUniversalApiKey(t('Universal API key'))
      setCurrentRow(created)
      triggerRefresh()
      setOpen('created')
    } catch (error) {
      handleServerError(error, t('Failed to create API key'))
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }
  const serverAddress =
    (typeof status?.server_address === 'string' &&
      status.server_address.trim()) ||
    ''
  const addresses = items.length
    ? items
    : [
        {
          url: serverAddress || window.location.origin,
          route: serverAddress ? t('Default API address') : t('Current domain'),
          description: '',
        },
      ]

  return (
    <div className='flex flex-wrap gap-2'>
      <Popover>
        <PopoverTrigger render={<Button variant='outline' size='sm' />}>
          <Globe aria-hidden='true' />
          {t('API Addresses')}
          <ChevronDown aria-hidden='true' />
        </PopoverTrigger>
        <PopoverContent
          align='end'
          className='max-h-[min(28rem,var(--available-height))] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto'
        >
          <PopoverTitle>{t('API Addresses')}</PopoverTitle>
          {loading ? (
            <LoadingState inline size='sm' message={t('Loading...')} />
          ) : (
            <ItemGroup>
              {addresses.map((address) => (
                <Item
                  key={address.url}
                  role='listitem'
                  variant='muted'
                  size='xs'
                  className='flex-nowrap items-start'
                >
                  <ItemContent className='min-w-0 gap-1'>
                    <ItemTitle className='line-clamp-none break-all'>
                      {address.route}
                    </ItemTitle>
                    <code className='text-xs break-all select-text'>
                      {address.url}
                    </code>
                    {address.description && (
                      <ItemDescription className='line-clamp-none break-words'>
                        {address.description}
                      </ItemDescription>
                    )}
                  </ItemContent>
                  <ItemActions>
                    <CopyButton
                      value={address.url}
                      size='sm'
                      tooltip={t('Copy API URL')}
                      aria-label={`${t('Copy API URL')}: ${address.url}`}
                    />
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
        </PopoverContent>
      </Popover>
      <Button
        size='sm'
        onClick={createKey}
        disabled={creating || (loading && !status)}
        aria-busy={creating}
      >
        <Plus className='h-4 w-4' />
        {t(creating ? 'Creating API key...' : 'Create API Key')}
      </Button>
    </div>
  )
}
