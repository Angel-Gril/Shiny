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
import calendar from '../../../../../../pkg/billingexpr/data/deepseek-calendar.json'

// Same public, versioned data as the backend; no network or guessed calendar.
export function deepSeekPeakAt(now: Date): boolean {
  const local = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const year = String(local.getUTCFullYear())
  const entry = calendar.years[year as keyof typeof calendar.years]
  if (!entry || !entry.version || entry.holidays.length === 0) {
    return false
  }
  const weekday = local.getUTCDay()
  if (weekday === 0 || weekday === 6) {
    return false
  }
  const date = local.toISOString().slice(0, 10)
  if (entry.holidays.some(([start, end]) => date >= start && date <= end)) {
    return false
  }
  const hour = local.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}
