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

import { formatAbuseEvidence, summarizeAbuseEvidence } from '../abuse-evidence'
import type { AbuseReview } from '../api'

export function AbuseEvidenceDialog(props: { review: AbuseReview }) {
  const { t } = useTranslation()
  const formatted = formatAbuseEvidence(
    props.review.action,
    props.review.evidence_json,
    t
  )
  return (
    <div className='min-w-0 space-y-2 whitespace-normal'>
      <p className='line-clamp-3 text-xs leading-relaxed [overflow-wrap:anywhere]'>
        {summarizeAbuseEvidence(
          props.review.action,
          props.review.evidence_json,
          t
        )}
      </p>
      <Dialog
        title={t('Audit evidence')}
        description={t(
          'Evidence contains redacted metadata, not the complete user request.'
        )}
        trigger={
          <Button size='sm' variant='outline'>
            {t('View evidence')}
          </Button>
        }
        footer={
          <CopyButton
            value={formatted}
            size='sm'
            variant='outline'
            aria-label={t('Copy evidence')}
          >
            {t('Copy evidence')}
          </CopyButton>
        }
      >
        <div className='min-w-0 space-y-3 text-sm [overflow-wrap:anywhere]'>
          <div className='text-muted-foreground text-xs'>
            {t('Event')}: {props.review.event_id}
          </div>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Category scores are model signals, not calibrated proof of abuse. Incomplete coverage means only part of the input was evaluated.'
            )}
          </p>
          <pre className='bg-muted/40 max-w-full rounded-md border p-3 font-sans text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap'>
            {formatted}
          </pre>
        </div>
      </Dialog>
    </div>
  )
}
