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
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

import { InsightOverview } from './components/insight-overview'
import { InsightRecords } from './components/insight-records'

export interface UserInsightDialogProps {
  userId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function UserInsightDialog(props: UserInsightDialogProps) {
  const { t } = useTranslation()
  const validId =
    props.userId != null &&
    Number.isSafeInteger(props.userId) &&
    props.userId > 0
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('User details')}
      description={t(
        'Read-only account details and records for manual refund review.'
      )}
      contentClassName='max-h-(--dialog-available-height) sm:max-w-5xl'
      bodyClassName='min-w-0'
    >
      {props.open && validId && props.userId !== null && (
        <UserInsightContent key={props.userId} userId={props.userId} />
      )}
      {props.open && !validId && (
        <p className='text-muted-foreground text-sm'>{t('No user selected')}</p>
      )}
    </Dialog>
  )
}

function UserInsightContent(props: { userId: number }) {
  const { t } = useTranslation()
  return (
    <Tabs defaultValue='overview' className='min-w-0 gap-4'>
      <div className='max-w-full overflow-x-auto pb-1'>
        <TabsList
          aria-label={t('User detail sections')}
          className='w-max min-w-full'
        >
          <TabsTrigger value='overview'>{t('Overview')}</TabsTrigger>
          <TabsTrigger value='topups'>{t('Top-up orders')}</TabsTrigger>
          <TabsTrigger value='redemptions'>
            {t('Redemption records')}
          </TabsTrigger>
          <TabsTrigger value='checkins'>{t('Check-in grants')}</TabsTrigger>
          <TabsTrigger value='logs'>{t('Usage and quota logs')}</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value='overview'>
        <InsightOverview userId={props.userId} />
      </TabsContent>
      <TabsContent value='topups'>
        <InsightRecords key='topups' userId={props.userId} section='topups' />
      </TabsContent>
      <TabsContent value='redemptions'>
        <InsightRecords
          key='redemptions'
          userId={props.userId}
          section='redemptions'
        />
      </TabsContent>
      <TabsContent value='checkins'>
        <InsightRecords
          key='checkins'
          userId={props.userId}
          section='checkins'
        />
      </TabsContent>
      <TabsContent value='logs'>
        <InsightRecords key='logs' userId={props.userId} section='logs' />
      </TabsContent>
    </Tabs>
  )
}

export function UserInsightTrigger(props: {
  userId: number
  children?: ReactNode
  className?: string
  label?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant='link'
        size='sm'
        className={cn(
          'h-auto min-w-0 justify-start p-0 text-left font-normal whitespace-normal',
          props.className
        )}
        aria-label={props.label}
        onClick={() => setOpen(true)}
      >
        {props.children ?? t('User details')}
      </Button>
      <UserInsightDialog
        userId={props.userId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  )
}
