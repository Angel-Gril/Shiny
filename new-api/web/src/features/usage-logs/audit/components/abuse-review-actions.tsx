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
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

import {
  updateAbuseReview,
  type AbuseReview,
  type AbuseReviewStatus,
} from '../api'

export function AbuseReviewActions(props: { review: AbuseReview }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [note, setNote] = useState(props.review.review_note ?? '')
  const mutation = useMutation({
    mutationFn: (status: Exclude<AbuseReviewStatus, 'pending'>) =>
      updateAbuseReview(props.review.id, status, note),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['abuse-reviews'] })
      void queryClient.invalidateQueries({ queryKey: ['abuse-review-summary'] })
    },
  })
  if (props.review.status !== 'pending') {
    return (
      <div className='min-w-0 space-y-1 text-xs [overflow-wrap:anywhere] whitespace-normal'>
        <div>
          {t(
            props.review.status === 'resolved' ? 'Resolved' : 'False positive'
          )}
        </div>
        {props.review.review_note && (
          <div className='text-muted-foreground line-clamp-3'>
            {props.review.review_note}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className='w-full min-w-0 space-y-2 whitespace-normal'>
      <Textarea
        aria-label={`${t('Review note')} ${props.review.id}`}
        className='min-h-16 w-full min-w-0 text-xs'
        placeholder={t('Review note')}
        value={note}
        disabled={mutation.isPending}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          disabled={mutation.isPending}
          onClick={() => mutation.mutate('resolved')}
        >
          {t('Resolve')}
        </Button>
        <Button
          size='sm'
          variant='outline'
          disabled={mutation.isPending}
          onClick={() => mutation.mutate('false_positive')}
        >
          {t('False positive')}
        </Button>
      </div>
    </div>
  )
}
