// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

/**
 * T20 · Установочные критерии iPhone.
 *
 * Тест читает **собранные** артефакты (`dist/manifest.webmanifest` и
 * `dist/index.html`), а не исходники: проверять надо то, что реально уедет на
 * Pages. Если `dist` устарел, тест сам собирает проект.
 */

const root = fileURLToPath(new URL('../../', import.meta.url))
const distDir = join(root, 'dist')

interface ИконкаМанифеста {
  src: string
  sizes?: string
  type?: string
  purpose?: string
}

interface Манифест {
  name?: string
  short_name?: string
  display?: string
  start_url?: string
  scope?: string
  lang?: string
  background_color?: string
  theme_color?: string
  icons?: ИконкаМанифеста[]
}

let indexHtml = ''
let манифест: Манифест = {}

/** Собирает проект, если `dist` отсутствует или старше исходников. */
function собратьЕслиУстарело(): void {
  const собранныйIndex = join(distDir, 'index.html')
  const источники = [
    join(root, 'index.html'),
    join(root, 'vite.config.ts'),
    join(root, 'src/app/manifest.ts'),
    join(root, 'src/app/pwa.ts'),
    ...readdirSync(join(root, 'public')).map((имя) => join(root, 'public', имя)),
  ]
  const самаяСвежая = Math.max(...источники.map((файл) => statSync(файл).mtimeMs))
  const устарело = !existsSync(собранныйIndex) || самаяСвежая > statSync(собранныйIndex).mtimeMs
  if (!устарело) return

  execFileSync(
    process.execPath,
    [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'error'],
    { cwd: root, stdio: 'pipe', timeout: 180_000 },
  )
}

/** Размеры берём из заголовка PNG, а не из имени файла. */
function размерPng(путь: string): { width: number; height: number } {
  const байты = readFileSync(путь)
  expect(байты.subarray(0, 8).toString('hex'), `${путь}: не PNG`).toBe('89504e470d0a1a0a')
  return { width: байты.readUInt32BE(16), height: байты.readUInt32BE(20) }
}

/** Значение `<meta name="..." content="...">` независимо от порядка атрибутов. */
function содержимоеМета(html: string, name: string): string | undefined {
  const тег = new RegExp(`<meta\\b[^>]*\\bname=["']${name}["'][^>]*>`, 'i').exec(html)
  if (тег === null) return undefined
  return new RegExp(`content=["']([^"']*)["']`, 'i').exec(тег[0])?.[1]
}

/** Значение атрибута у `<link rel="...">`. */
function атрибутСсылки(html: string, rel: string, attr: string): string | undefined {
  const тег = new RegExp(`<link\\b[^>]*\\brel=["']${rel}["'][^>]*>`, 'i').exec(html)
  if (тег === null) return undefined
  return new RegExp(`${attr}=["']([^"']*)["']`, 'i').exec(тег[0])?.[1]
}

beforeAll(() => {
  собратьЕслиУстарело()
  indexHtml = readFileSync(join(distDir, 'index.html'), 'utf8')
  манифест = JSON.parse(readFileSync(join(distDir, 'manifest.webmanifest'), 'utf8')) as Манифест
})

describe('Установка на iPhone: собранный манифест (T20)', () => {
  it('содержит обязательные поля', () => {
    expect(манифест.name).toBeTruthy()
    expect(манифест.short_name).toBeTruthy()
    expect(манифест.display).toBe('standalone')
    // База зависит от площадки: `/` на Cloudflare Pages, `/tidy_clone/` на
    // GitHub Pages. Критерий — согласованность, а не конкретная строка.
    expect(манифест.start_url).toMatch(/^\/$|^\/[^/]+\/$/)
    expect(манифест.scope).toBe(манифест.start_url)
    expect(манифест.lang).toBe('ru')
    expect(манифест.background_color).toBe('#FFFFFF')
    expect(манифест.theme_color).toBe('#FFFFFF')
  })

  it('объявляет иконки 192/512 + maskable, и все они реально существуют', () => {
    const иконки = манифест.icons ?? []
    expect(иконки.length).toBeGreaterThanOrEqual(3)

    const обычная192 = иконки.find(
      (и) => и.sizes === '192x192' && (и.purpose ?? 'any').includes('any'),
    )
    const обычная512 = иконки.find(
      (и) => и.sizes === '512x512' && (и.purpose ?? 'any').includes('any'),
    )
    const maskable = иконки.find((и) => (и.purpose ?? '').includes('maskable'))
    expect(обычная192, 'нет обычной иконки 192x192').toBeDefined()
    expect(обычная512, 'нет обычной иконки 512x512').toBeDefined()
    expect(maskable, 'нет maskable-иконки').toBeDefined()

    // `src` в собранном манифесте может нести базовый путь площадки —
    // отрезаем его, чтобы проверить сам файл в dist.
    const base = манифест.start_url ?? '/'
    for (const иконка of иконки) {
      const src = String(иконка.src)
      const относительноДист = src.startsWith(base) ? src.slice(base.length) : src.replace(/^\//, '')
      const файл = join(distDir, относительноДист)
      expect(existsSync(файл), `нет файла ${иконка.src}`).toBe(true)
      if (иконка.sizes === undefined) continue
      const [width, height] = иконка.sizes.split('x').map(Number)
      expect(размерPng(файл), `${иконка.src}: размер не совпадает с размером в манифесте`).toEqual({
        width,
        height,
      })
    }
  })
})

describe('Установка на iPhone: собранный index.html (T20)', () => {
  it('подключает манифест', () => {
    const base = манифест.start_url ?? '/'
    expect(атрибутСсылки(indexHtml, 'manifest', 'href')).toBe(`${base}manifest.webmanifest`)
  })

  it('содержит метатеги iOS', () => {
    expect(содержимоеМета(indexHtml, 'apple-mobile-web-app-capable')).toBe('yes')
    expect(содержимоеМета(indexHtml, 'apple-mobile-web-app-status-bar-style')).toBeTruthy()
    expect(содержимоеМета(indexHtml, 'apple-mobile-web-app-title')).toBe('Гардероб')
    expect(содержимоеМета(indexHtml, 'theme-color')).toBe('#FFFFFF')
  })

  it('подключает apple-touch-icon 180×180', () => {
    const base = манифест.start_url ?? '/'
    expect(атрибутСсылки(indexHtml, 'apple-touch-icon', 'href')).toBe(`${base}apple-touch-icon.png`)
    const файл = join(distDir, 'apple-touch-icon.png')
    expect(existsSync(файл)).toBe(true)
    expect(размерPng(файл)).toEqual({ width: 180, height: 180 })
  })

  it('не запрещает пинч-зум и учитывает safe-area (viewport-fit=cover)', () => {
    const viewport = содержимоеМета(indexHtml, 'viewport') ?? ''
    expect(viewport).toContain('width=device-width')
    expect(viewport).toContain('viewport-fit=cover')
    expect(viewport).not.toMatch(/user-scalable\s*=\s*no/i)
  })
})
