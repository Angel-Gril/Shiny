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
import { getChannels } from '@/features/channels/api'
import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

export type PolicyConfig = {
  options: Record<string, string>
  credentials?: {
    chat_completions?: AuditCredentialStatus
    typesafe?: AuditCredentialStatus
    subq?: AuditCredentialStatus
    store_ready?: boolean
  }
}
export type AuditCredentialStatus = {
  configured: boolean
  source: 'console' | 'environment' | ''
  error: boolean
}
export type SavePolicyRequest = {
  options: Record<string, string>
  credentials?: Record<string, string>
  clear_credentials?: string[]
}
export type PolicyDecision = { action: string; reason: string; source: string }
export type PolicyEvent = {
  attempt: number
  channel_id?: number
  group?: string
  rule?: string
  status?: number
  error_code?: string
  error_source?: string
  elapsed_ms: number
  decision: PolicyDecision
  health?: string
}
type Response<T> = { success: boolean; message?: string; data: T }

export async function getContentAuditChannels() {
  const channels: { label: string; value: string }[] = []
  for (let page = 1; ; page++) {
    const response = requireServerSuccess(
      await getChannels({ p: page, page_size: 100, tag_mode: false })
    )
    const data = response.data
    if (!data) throw new Error('Failed to load channels')
    channels.push(
      ...data.items.map((channel) => ({
        label: `#${channel.id} ${channel.name}`,
        value: String(channel.id),
      }))
    )
    if (channels.length >= data.total) return channels
    if (data.items.length === 0) throw new Error('Failed to load channels')
  }
}
export async function getPolicyConfig() {
  const response = await api.get<Response<PolicyConfig>>(
    '/api/option/request_policy'
  )
  return requireServerSuccess(response.data).data
}
export async function savePolicyConfig(request: SavePolicyRequest) {
  const response = await api.patch<Response<PolicyConfig>>(
    '/api/option/request_policy',
    request
  )
  return requireServerSuccess(response.data).data
}

export async function getContentAuditModels(
  endpoint: string,
  provider?: string,
  apiKey?: string
) {
  const response = await api.post<Response<{ models: string[] }>>(
    '/api/option/content_audit/models',
    {
      endpoint,
      ...(provider ? { provider } : {}),
      ...(apiKey ? { api_key: apiKey } : {}),
    }
  )
  return requireServerSuccess(response.data).data.models
}
