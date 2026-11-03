import { createInstance } from 'i18next'
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
import { describe, expect, test } from 'vitest'

import { parseTiersFromExpr, getCurrentTimePricingTiers } from '../billing-expr'
import { formatBillingCondition } from '../billing-expression/condition-display'
import { evaluateBillingExpression } from '../billing-expression/runtime'

const expression =
  'deepseekPeak() ? tier("peak", p * 2 + cr * 0.04 + c * 8) : tier("off_peak", p * 1 + cr * 0.02 + c * 4)'

describe('DeepSeek calendar pricing', () => {
  test.each([
    ['2026-11-04T08:59:59+08:00', 'off_peak', 1000],
    ['2026-11-04T09:00:00+08:00', 'peak', 2000],
    ['2026-11-04T12:00:00+08:00', 'off_peak', 1000],
    ['2026-11-04T14:00:00+08:00', 'peak', 2000],
    ['2026-11-04T18:00:00+08:00', 'off_peak', 1000],
    ['2026-10-01T10:00:00+08:00', 'off_peak', 1000],
    ['2026-10-10T10:00:00+08:00', 'off_peak', 1000],
    ['2027-01-04T10:00:00+08:00', 'off_peak', 1000],
  ])('simulates %s using %s calendar price', (date, tier, cost) => {
    expect(
      evaluateBillingExpression(expression, {
        tokens: { p: 1000, cr: 0, c: 0 },
        now: new Date(date),
      })
    ).toMatchObject({ status: 'success', matchedTier: tier, cost })
    expect(
      getCurrentTimePricingTiers(expression, new Date(date))?.map(
        (row) => row.label
      )
    ).toEqual([tier])
  })

  test('shows both price tiers and a readable holiday-aware condition', async () => {
    expect(parseTiersFromExpr(expression).map((row) => row.label)).toEqual([
      'peak',
      'off_peak',
    ])
    const i18n = createInstance()
    await i18n.init({ lng: 'en', resources: { en: { translation: {} } } })
    const text = formatBillingCondition('deepseekPeak()', i18n.t.bind(i18n))
    expect(text).toContain('Chinese public holidays')
  })
})
