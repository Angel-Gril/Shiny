import { t } from 'i18next'

const ACTION_LABELS: Record<string, string> = {
  'abuse.multi_ip': 'Multiple network exits observed',
  'abuse.model_switch': 'Model changes observed',
  'abuse.long_stream': 'Long stream observed',
  'abuse.keyword_signal': 'Keyword signal',
  'abuse.failure_burst': 'Repeated failures',
  'abuse.provider_error': 'Upstream service error',
  'abuse.token_churn': 'Frequent key rotation',
  'abuse.long_request': 'Long request observed',
  'abuse.content_audit': 'Content audit signal',
  'abuse.keyword_match': 'Operator keyword match',
}

const CATEGORY_LABELS: Record<string, string> = {
  cyber_abuse: 'Cyber abuse',
  credential_theft: 'Credential theft',
  security_bypass: 'Security bypass',
  provider_policy_evasion: 'Provider policy evasion',
  bulk_account_key_rotation: 'Bulk account or key rotation',
  bulk_registration_evasion: 'Abusive bulk registration',
  quota_billing_evasion: 'Quota or billing evasion',
  bulk_account_abuse: 'Bulk account abuse',
  cost_abuse: 'Billing abuse',
  none: 'Unclassified',
}

const REASON_LABELS: Record<string, string> = {
  third_party_attack: 'Intent to attack a third-party system detected',
  bulk_account_key_rotation:
    'Bulk account or key rotation to evade detection observed',
  bulk_registration_evasion: 'Bulk registration to evade detection observed',
  quota_billing_evasion: 'Intent to evade quota or billing detected',
  sensitive_keyword: 'Operator risk rule matched',
}

const FIELD_LABELS: Record<string, string> = {
  category_scores: 'Category signals',
  categories: 'Category flags',
  coverage_complete: 'Complete coverage',
  context: 'Request context',
  audit_model: 'Audit model',
  source: 'Signal source',
  mode: 'Audit mode',
  keyword_signal: 'Keyword signal',
  distinct_count: 'Distinct count',
  model: 'Model',
  severity: 'Severity',
  failure_count: 'Failure count',
  status: 'Upstream HTTP status',
  token_id: 'Related key ID',
  user_id: 'Related user ID',
  window_seconds: 'Observation window',
  duration_ms: 'Request duration',
  category: 'Audit category',
  confidence: 'Audit confidence',
  reason_code: 'Audit reason',
  model_name: 'Requested model',
  input_length: 'Input length',
  match_count: 'Matched rule count',
  rule_source: 'Rule source',
  action: 'Suggested action',
}

function labelForValue(value: unknown, labels: Record<string, string>) {
  if (typeof value !== 'string') return value
  return labels[value] ? t(labels[value]) : value
}

function formatValue(key: string, value: unknown): string {
  if (
    key === 'category_scores' &&
    typeof value === 'object' &&
    value !== null
  ) {
    return (
      Object.entries(value)
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .map(
          ([k, v]) =>
            `${t(CATEGORY_LABELS[k] ?? k)} ${Math.round(Number(v) * 100)}%`
        )
        .join(' · ') || '—'
    )
  }
  if (key === 'category') return String(labelForValue(value, CATEGORY_LABELS))
  if (key === 'reason_code') return String(labelForValue(value, REASON_LABELS))
  if (key === 'action') {
    if (value === 'review') return t('Send for manual review')
    if (value === 'allow') return t('Allow and record')
    return String(value)
  }
  if (key === 'confidence' && typeof value === 'number') {
    return `${Math.round(value * 100)}%`
  }
  if (key === 'duration_ms' && typeof value === 'number') {
    return t('{{value}} ms', { value })
  }
  if (key === 'window_seconds' && typeof value === 'number') {
    return t('{{value}} seconds', { value })
  }
  if (key === 'input_length' && typeof value === 'number') {
    return t('{{value}} characters', { value })
  }
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

function reasonFor(action: string, fields: Record<string, unknown>): string {
  const failureCount = fields.failure_count
  const status = fields.status
  const duration = fields.duration_ms
  if (action === 'abuse.failure_burst' && failureCount !== undefined) {
    return t('Repeated failures within a short period: {{value}}', {
      value: failureCount,
    })
  }
  if (action === 'abuse.provider_error' && status !== undefined) {
    return t('The upstream returned HTTP {{status}}', { status })
  }
  if (action === 'abuse.token_churn') {
    return t(
      'The same user frequently created or rotated API keys within a short period'
    )
  }
  if (
    (action === 'abuse.long_request' || action === 'abuse.long_stream') &&
    duration !== undefined
  ) {
    return t(
      'The request lasted {{value}} ms, above the long-request alert threshold',
      { value: duration }
    )
  }
  if (action === 'abuse.content_audit') {
    const category = labelForValue(fields.category, CATEGORY_LABELS)
    const reason = labelForValue(fields.reason_code, REASON_LABELS)
    return (
      t('Content audit category: {{category}}', { category }) +
      (reason ? `: ${reason}` : '')
    )
  }
  if (action === 'abuse.keyword_match') {
    return t(
      'The request matched an operator keyword rule and was sent for review'
    )
  }
  if (action === 'abuse.multi_ip') {
    return t('Network exits changed; this does not prove account sharing.')
  }
  if (action === 'abuse.model_switch') {
    return t('Models changed; normal model selection is allowed.')
  }
  return t('Observation only; abuse is not established.')
}

export function formatAbuseAction(action: string): string {
  return t(ACTION_LABELS[action] ?? action)
}

export function formatAbuseEvidence(action: string, raw: string): string {
  if (!raw) return t('No structured evidence available')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return raw
  }
  const fields =
    parsed.root_info && typeof parsed.root_info === 'object'
      ? { ...(parsed.root_info as Record<string, unknown>), ...parsed }
      : parsed
  const lines = [`${t('Reason')}: ${reasonFor(action, fields)}`]
  for (const [key, value] of Object.entries(fields)) {
    if (
      key === 'root_info' ||
      (key === 'action' && action === 'abuse.content_audit')
    ) {
      continue
    }
    const label = t(FIELD_LABELS[key] ?? key)
    lines.push(`${label}: ${formatValue(key, value)}`)
  }
  return lines.join('\n')
}
