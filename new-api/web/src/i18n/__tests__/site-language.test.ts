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
import { createInstance } from 'i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { INTERFACE_LANGUAGE_OPTIONS } from '../languages'
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
