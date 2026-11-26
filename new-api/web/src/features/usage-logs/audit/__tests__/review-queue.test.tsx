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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import type { AbuseReview } from '../api'
import { AbuseReviewQueue } from '../components/abuse-review-queue'

const reason = `unrecognized_reason_${'x'.repeat(600)}`
const review: AbuseReview = {
  id: 7,
  event_id: `event_${'a'.repeat(180)}`,
  user_id: 42,
  token_id: 13,
  action: 'abuse.content_audit',
  status: 'pending',
  risk_score: 5,
  disposition: 'review',
  score_version: 'v2',
  evidence_json: JSON.stringify({
    category: 'cyber_abuse',
    reason_code: reason,
    context: 'direct_request',
    category_scores: { cyber_abuse: 0.98, credential_theft: 0.02 },
    categories: { cyber_abuse: true, credential_theft: false },
    coverage_complete: false,
    audit_model: 'jev-1.14.0',
    source: 'typesafe',
  }),
  reviewer_id: 0,
  review_note: '',
  created_at: 1795600000,
  updated_at: 1795600000,
  resolved_at: 0,
}
const clients: QueryClient[] = []

afterEach(() => {
  cleanup()
  clients.forEach((client) => client.clear())
  clients.length = 0
  vi.restoreAllMocks()
})

function renderQueue(entry = review) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data:
        url === '/api/abuse_reviews/summary'
          ? {
              reviews: {
                review_priority: 1,
                resolved: 0,
                false_positive: 0,
                last_24_hours: 1,
                pending: 1,
                manual_priority: 0,
              },
              content_audit: {
                enabled: true,
                configured: true,
                mode: 'shadow',
                provider: 'typesafe',
                model: 'jev-1.14.0',
                input_tokens: 1234,
                output_tokens: 56,
                usage_unreported: 2,
                requests: 2,
                flagged: 1,
                errors: 0,
                dropped: 0,
                incomplete: 1,
              },
            }
          : { items: [entry], total: 1 },
    },
  }))
  return render(
    <QueryClientProvider client={client}>
      <AbuseReviewQueue />
    </QueryClientProvider>
  )
}

it('keeps long evidence in a bounded summary and opens complete evidence in a dialog', async () => {
  renderQueue()
  await screen.findByRole('button', { name: 'View evidence' })
  expect(screen.getByText(/Audit input tokens 1,234/)).toBeVisible()
  expect(screen.getByText(/Audit output tokens 56/)).toBeVisible()
  expect(screen.getByText(/Usage unreported 2/)).toBeVisible()
  expect(screen.queryByText(reason, { exact: false })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Resolve' })).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'View evidence' }))
  const dialog = await screen.findByRole('dialog', { name: 'Audit evidence' })
  expect(within(dialog).getByText(reason, { exact: false })).toBeVisible()
  expect(dialog.textContent?.split(reason).length).toBe(2)
  expect(
    within(dialog).getByRole('button', { name: 'Copy evidence' })
  ).toBeVisible()
  expect(
    within(dialog).getByText(review.event_id, { exact: false })
  ).toBeVisible()
  expect(
    within(dialog).queryByText('{"cyber_abuse":true', { exact: false })
  ).not.toBeInTheDocument()
})

it('submits the review note with the selected resolution without altering evidence', async () => {
  renderQueue()
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({
    data: { success: true, data: { ...review, status: 'false_positive' } },
  })
  const note = await screen.findByRole('textbox', { name: 'Review note 7' })
  await userEvent.type(note, 'Quoted security analysis; no actionable abuse.')
  await userEvent.click(screen.getByRole('button', { name: 'False positive' }))
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith('/api/abuse_reviews/7', {
      status: 'false_positive',
      note: 'Quoted security analysis; no actionable abuse.',
    })
  )
})

it('opens malformed historical evidence as plain text without rendering HTML', async () => {
  const historical = '<script>unsupported_old_evidence</script>'
  renderQueue({ ...review, evidence_json: historical })
  await userEvent.click(
    await screen.findByRole('button', { name: 'View evidence' })
  )
  const dialog = await screen.findByRole('dialog', { name: 'Audit evidence' })
  expect(within(dialog).getByText(historical)).toBeVisible()
  expect(dialog.querySelector('script')).toBeNull()
})
