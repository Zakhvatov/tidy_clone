// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { manifest } from './manifest'

describe('Веб-манифест', () => {
  it('содержит обязательные поля для установки на iPhone', () => {
    expect(manifest.name).toBe('Гардероб')
    expect(manifest.short_name).toBe('Гардероб')
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.lang).toBe('ru')
    expect(manifest.background_color).toBe('#FFFFFF')
    expect(manifest.theme_color).toBe('#FFFFFF')
  })

  it('описывает добавление по фото и не обещает импорт по ссылке', () => {
    expect(manifest.description).toContain('фото')
    expect(manifest.description).not.toContain('по ссылке')
  })

  it('объявляет обычные, apple-touch и maskable иконки', () => {
    const icons = manifest.icons ?? []
    const sizes = icons.map((icon) => icon.sizes)
    const purposes = icons.map((icon) => icon.purpose)

    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
    expect(purposes).toContain('maskable')
  })

  it('все объявленные иконки существуют в public/', () => {
    const publicDir = fileURLToPath(new URL('../../public/', import.meta.url))

    for (const icon of manifest.icons ?? []) {
      const file = `${publicDir}${String(icon.src).replace(/^\//, '')}`
      expect(() => readFileSync(file)).not.toThrow()
    }

    expect(() => readFileSync(`${publicDir}apple-touch-icon.png`)).not.toThrow()
  })

  it('оставляет SPA-fallback для Cloudflare Pages', () => {
    const redirects = fileURLToPath(new URL('../../public/_redirects', import.meta.url))
    const contents = readFileSync(redirects, 'utf8').trim()
    expect(contents).toBe('/* /index.html 200')
  })
})
