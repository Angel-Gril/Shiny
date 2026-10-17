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
export type UserInsightSection =
  | 'overview'
  | 'topups'
  | 'redemptions'
  | 'checkins'
  | 'logs'

export interface UserInsightOverview {
  user: {
    id: number
    username: string
    display_name: string
    email: string
    role: number
    status: number
    group: string
    remark: string
    created_at: number
    last_login_at: number
    inviter_id: number
    inviter_username: string
    quota: number
    used_quota: number
    request_count: number
  }
  stats: {
    successful_topups: number
    redemptions: number
    checkins?: number
    log_count: number
    consume_count: number
    refund_count: number
  }
  limitations: {
    wallet_provenance_complete: boolean
    payment_currency_recorded: boolean
  }
}

export interface UserInsightTopup {
  id: number
  trade_no: string
  amount: number
  credited_quota?: number | null
  money: number
  payment_method: string
  payment_provider: string
  create_time: number
  complete_time: number
  status: string
}

export interface UserInsightRedemption {
  id: number
  name: string
  quota: number
  redeemed_time: number
}

export interface UserInsightCheckin {
  id: number
  checkin_date: string
  quota_awarded: number
  created_at: number
}

export interface UserInsightLog {
  id: number
  created_at: number
  type: number
  content: string
  model_name: string
  quota: number
  prompt_tokens: number
  completion_tokens: number
  use_time: number
  is_stream: boolean
  channel_id: number
  token_name: string
  request_id: string
}

export interface UserInsightPage<T> {
  items: T[]
  total: number
  p: number
  page_size: number
}

export interface UserInsightData {
  overview: UserInsightOverview
  topups: UserInsightPage<UserInsightTopup>
  redemptions: UserInsightPage<UserInsightRedemption>
  checkins: UserInsightPage<UserInsightCheckin>
  logs: UserInsightPage<UserInsightLog>
}

export type UserInsightRecordsSection = Exclude<UserInsightSection, 'overview'>
