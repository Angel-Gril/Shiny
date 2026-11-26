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
import { t, type TFunction } from 'i18next'

const ACTION_LABELS: Record<string, string> = {
  'abuse.multi_ip': 'Multiple network exits observed',
  'abuse.model_switch': 'Model changes observed',
  'abuse.long_stream': 'Long stream observed',
  'abuse.keyword_signal': 'Keyword signal',
  'abuse.failure_burst': 'Repeated request failures',
  'abuse.provider_error': 'Provider error',
  'abuse.token_churn': 'Frequent API key changes',
  'abuse.long_request': 'Long request observed',
  'abuse.content_audit': 'Content audit signal',
  'abuse.keyword_match': 'High-risk keyword signal',
}
const CATEGORY_LABELS: Record<string, string> = {
  cyber_abuse: 'Cyber abuse',
  credential_theft: 'Credential theft',
  security_bypass: 'Security bypass',
  provider_policy_evasion: 'Provider policy evasion',
  bulk_account_key_rotation: 'Bulk account or key rotation',
  bulk_registration_evasion: 'Bulk registration evasion',
  quota_billing_evasion: 'Quota or billing evasion',
  bulk_account_abuse: 'Bulk account abuse',
  cost_abuse: 'Billing abuse',
  none: 'No abuse category',
}
const REASON_LABELS: Record<string, string> = {
  third_party_attack: 'Intent to attack a third-party system',
  bulk_account_key_rotation: 'Bulk account or key rotation to evade detection',
  bulk_registration_evasion: 'Bulk registration to evade detection',
  quota_billing_evasion: 'Intent to evade quota or billing',
  sensitive_keyword: 'High-risk keyword rule matched',
}
const VALUE_LABELS: Record<string, string> = {
  direct_request: 'Direct request',
  defensive: 'Defensive context',
  quoted: 'Quoted content',
  ambiguous: 'Ambiguous context',
  review: 'Manual review',
  allow: 'Allow and record',
  shadow: 'Shadow audit',
  preflight: 'Preflight audit',
  deepseek: 'DeepSeek',
  typesafe: 'TypeSafe / Jev',
  chat_completions: 'Chat Completions',
}
const FIELD_LABELS: Record<string, string> = {
  category_scores: 'Category signals',
  categories: 'Category flags',
  coverage_complete: 'Complete coverage',
  context: 'Request context',
  audit_model: 'Audit model',
  audit_model_version: 'Audit model version',
  source: 'Signal source',
  mode: 'Audit mode',
  keyword_signal: 'Keyword signal',
  distinct_count: 'Distinct count',
  model: 'Model',
  severity: 'Severity',
  failure_count: 'Failure count',
  status: 'Upstream HTTP status',
  token_id: 'Token ID',
  user_id: 'User ID',
  window_seconds: 'Observation window',
  duration_ms: 'Request duration',
  category: 'Audit category',
  confidence: 'Audit score',
  reason_code: 'Audit reason',
  model_name: 'Audit model',
  input_length: 'Input length',
  match_count: 'Matched rule count',
  rule_source: 'Rule source',
  action: 'Recommended action',
}

function translatedValue(
  value: unknown,
  labels: Record<string, string>,
  translate: TFunction
): string {
  const text = String(value ?? '')
  return labels[text] ? translate(labels[text]) : text
}

function formatValue(
  key: string,
  value: unknown,
  translate: TFunction
): string {
  if (
    (key === 'category_scores' || key === 'categories') &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  ) {
    return (
      Object.entries(value)
        .filter(([, item]) =>
          key === 'category_scores'
            ? typeof item === 'number' && Number.isFinite(item) && item > 0
            : item === true
        )
        .map(([category, item]) => {
          const label = translatedValue(category, CATEGORY_LABELS, translate)
          if (key === 'categories') return label
          return `${label} ${Math.round(Number(item) * 100)}%`
        })
        .join(' · ') || '—'
    )
  }
  if (key === 'category') {
    return translatedValue(value, CATEGORY_LABELS, translate)
  }
  if (key === 'reason_code') {
    return translatedValue(value, REASON_LABELS, translate)
  }
  if (key === 'confidence' && typeof value === 'number') {
    return `${Math.round(value * 100)}%`
  }
  if (typeof value === 'boolean') {
    return value ? translate('Yes') : translate('No')
  }
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return translatedValue(value, VALUE_LABELS, translate)
}

function readEvidence(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null
    }
    const fields = parsed as Record<string, unknown>
    if (
      typeof fields.root_info === 'object' &&
      fields.root_info !== null &&
      !Array.isArray(fields.root_info)
    ) {
      return { ...(fields.root_info as Record<string, unknown>), ...fields }
    }
    return fields
  } catch {
    return null
  }
}

function reasonFor(
  action: string,
  fields: Record<string, unknown>,
  translate: TFunction
): string {
  if (action === 'abuse.failure_burst' && fields.failure_count !== undefined) {
    return translate(
      'Repeated failures within the observation window: {{count}}',
      { count: Number(fields.failure_count) }
    )
  }
  if (action === 'abuse.provider_error' && fields.status !== undefined) {
    return translate('The upstream provider returned HTTP {{status}}', {
      status: fields.status,
    })
  }
  if (action === 'abuse.token_churn') {
    return translate('The user created or changed API keys frequently.')
  }
  if (
    (action === 'abuse.long_request' || action === 'abuse.long_stream') &&
    fields.duration_ms !== undefined
  ) {
    return translate(
      'Request duration exceeded the observation threshold: {{duration}} ms',
      { duration: fields.duration_ms }
    )
  }
  if (action === 'abuse.content_audit') {
    const category = translatedValue(
      fields.category,
      CATEGORY_LABELS,
      translate
    )
    const reason = translatedValue(fields.reason_code, REASON_LABELS, translate)
    return (
      [category, reason].filter(Boolean).join(' · ') ||
      translate('Content audit signal')
    )
  }
  if (action === 'abuse.keyword_match') {
    return translate('High-risk keyword rule matched')
  }
  if (action === 'abuse.multi_ip') {
    return translate(
      'Network exits changed; this does not prove account sharing.'
    )
  }
  if (action === 'abuse.model_switch') {
    return translate('Models changed; normal model selection is allowed.')
  }
  return translate('Observation only; abuse is not established.')
}

export function formatAbuseAction(
  action: string,
  translate: TFunction = t
): string {
  return ACTION_LABELS[action] ? translate(ACTION_LABELS[action]) : action
}

export function summarizeAbuseEvidence(
  action: string,
  raw: string,
  translate: TFunction = t
): string {
  const fields = readEvidence(raw)
  const summary = fields ? reasonFor(action, fields, translate) : raw
  if (!summary) return translate('No structured evidence')
  return summary.length > 180 ? `${summary.slice(0, 180)}…` : summary
}

export function formatAbuseEvidence(
  action: string,
  raw: string,
  translate: TFunction = t
): string {
  if (!raw) return translate('No structured evidence')
  const fields = readEvidence(raw)
  if (!fields) return raw
  const lines = [
    `${translate('Reason')}: ${reasonFor(action, fields, translate)}`,
  ]
  for (const [key, value] of Object.entries(fields)) {
    if (
      key === 'root_info' ||
      (key === 'action' && action === 'abuse.content_audit')
    ) {
      continue
    }
    if (
      action === 'abuse.content_audit' &&
      (key === 'category' || key === 'reason_code')
    ) {
      continue
    }
    // Category flags repeat the scores; retain historical flags only if no scores exist.
    if (key === 'categories' && fields.category_scores) continue
    const label = FIELD_LABELS[key] ? translate(FIELD_LABELS[key]) : key
    lines.push(`${label}: ${formatValue(key, value, translate)}`)
  }
  return lines.join('\n')
}
