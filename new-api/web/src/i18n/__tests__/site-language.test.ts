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
import i18next, { createInstance } from 'i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { formatAbuseEvidence } from '@/features/usage-logs/audit/abuse-evidence'

import { INTERFACE_LANGUAGE_OPTIONS } from '../languages'
import ru from '../locales/ru.json'
import {
  createSiteLanguageDetector,
  siteLanguageDetection,
} from '../site-language'

async function detectLanguage() {
  const instance = createInstance()
  const supported = INTERFACE_LANGUAGE_OPTIONS.map((language) => language.code)
  await instance.use(createSiteLanguageDetector()).init({
    resources: Object.fromEntries(
      supported.map((language) => [
        language,
        { translation: { label: 'Interface label' } },
      ])
    ),
    supportedLngs: supported,
    fallbackLng: 'en',
    load: 'currentOnly',
    detection: siteLanguageDetection,
  })
  return instance.resolvedLanguage
}

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.defaultLanguage
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US')
})

afterEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.defaultLanguage
})

it('a first visit to the RU console selects Russian even when the browser uses English', async () => {
  document.documentElement.dataset.defaultLanguage = 'ru'
  expect(await detectLanguage()).toBe('ru')
  expect(localStorage.getItem('i18nextLng')).toBe('ru')
})

it.each(['en', 'zhCN', 'zhTW', 'fr', 'ja', 'ru', 'vi'])(
  'a saved %s preference takes precedence over the RU site default',
  async (language) => {
    document.documentElement.dataset.defaultLanguage = 'ru'
    localStorage.setItem('i18nextLng', language)
    expect(await detectLanguage()).toBe(language)
  }
)

it('a site without its own default continues to use the browser language', async () => {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR'])
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('fr-FR')
  expect(await detectLanguage()).toBe('fr')
})

it('unsupported site and browser languages fall back to English', async () => {
  document.documentElement.dataset.defaultLanguage = 'invalid-language'
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE'])
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('de-DE')
  expect(await detectLanguage()).toBe('en')
})

it('Russian account and audit copy has translated labels and preserves interpolation', () => {
  const values = ru.translation as Record<string, string>
  for (const key of [
    'Password strength empty',
    'Password requirement',
    'For a stronger password',
    '8–128 characters',
    '15 or more characters',
    'Uppercase and lowercase letters',
    'A number',
    'A symbol',
    'Show password',
    'Review threshold',
    'Default price',
    'Legacy Shiny audit',
  ]) {
    expect(values[key], key).toMatch(/[А-Яа-яЁё]/)
    expect(values[key], key).not.toMatch(/[\u3400-\u9fff]/)
  }
  for (const key of [
    'Characters needed: {{count}}',
    'Request processing: {{names}}',
  ]) {
    expect(values[key], key).not.toBe(key)
    expect(values[key].match(/\{\{[^}]+\}\}/g)).toEqual(
      key.match(/\{\{[^}]+\}\}/g)
    )
  }
})

it('Russian audit evidence translates reason, category and units rather than embedding Chinese', async () => {
  i18next.addResourceBundle('ru', 'translation', ru.translation)
  await i18next.changeLanguage('ru')
  try {
    const text = formatAbuseEvidence(
      'abuse.content_audit',
      JSON.stringify({
        category: 'credential_theft',
        reason_code: 'sensitive_keyword',
        duration_ms: 1000,
        input_length: 128,
        action: 'review',
      })
    )
    expect(text).toContain('Кража учётных данных')
    expect(text).toContain('1000 мс')
    expect(text).not.toMatch(/[\u3400-\u9fff]/)
  } finally {
    await i18next.changeLanguage('en')
    i18next.removeResourceBundle('ru', 'translation')
  }
})
