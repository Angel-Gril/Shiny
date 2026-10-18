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
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { RichContent } from '@/components/rich-content'
import { Button } from '@/components/ui/button'
import { getNotice } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'
import { markNoticeRead } from '@/lib/site-notice-policy'

import { useSiteNotice } from './hooks/use-site-notice'

function hasBlockingOverlay(): boolean {
  return [
    ...document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], dialog[open], [data-slot="popover-content"][data-open], [data-slot="drawer-content"][data-open]'
    ),
  ].some(
    (element) =>
      !element.querySelector('[data-site-notice]') &&
      !element.closest('[data-site-notice]') &&
      !element.hasAttribute('data-closed') &&
      !element.hasAttribute('hidden')
  )
}

export function SiteNoticePopup() {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['notice'],
    queryFn: async () => requireServerSuccess(await getNotice()),
    staleTime: 1000 * 60 * 5,
    meta: { errorToast: false },
  })
  const notice = useSiteNotice(query.data?.data)
  const [openVersion, setOpenVersion] = useState<string | null>(null)

  useEffect(() => {
    const version = notice.version
    if (!version || notice.read || query.isError) return

    const tryOpen = (): void => {
      const blocked =
        document.visibilityState === 'hidden' || hasBlockingOverlay()
      setOpenVersion(blocked ? null : version)
    }
    const observer = new MutationObserver(tryOpen)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open', 'data-open', 'data-closed', 'hidden'],
    })
    document.addEventListener('visibilitychange', tryOpen)
    tryOpen()
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', tryOpen)
    }
  }, [notice.version, notice.read, query.isError])

  const open = Boolean(
    notice.version &&
    notice.version === openVersion &&
    !notice.read &&
    !query.isError
  )

  const dismiss = (): void => {
    if (notice.version) markNoticeRead(notice.version)
    setOpenVersion(null)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss()
      }}
      title={t('System Announcements')}
      description={t('Latest platform updates and notices')}
      contentClassName='sm:max-w-xl'
      bodyClassName='break-words'
      footer={
        <>
          <Button
            variant='outline'
            role='link'
            render={<a href='/announcements/system-notice' />}
            onClick={dismiss}
            data-notice-details
          >
            {t('View details')}
          </Button>
          <Button onClick={dismiss} data-notice-dismiss>
            {t('Got it')}
          </Button>
        </>
      }
    >
      <div data-site-notice data-notice-body>
        <RichContent breaks content={notice.content} />
      </div>
    </Dialog>
  )
}
