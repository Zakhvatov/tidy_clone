import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * ADR-0005: «Анимации минимальные: 150–200 ms, ease-out, только как отклик на
 * действие. Ничего декоративного». Бесконечная анимация — по определению
 * декоративная: она крутится сама по себе, а не отвечает на действие.
 *
 * Тест читает CSS-модули под `src/` и падает на любом `infinite`, кроме файлов
 * из явного allowlist. Пустой allowlist — это и есть решение: исключений нет.
 * Если когда-нибудь понадобится осознанное исключение (например, индикатор
 * активной загрузки), оно добавляется сюда вместе с пунктом в
 * `docs/decisions-log.md`.
 */
const ALLOWED_INFINITE: Record<string, string> = {}

// Vitest запускается из корня проекта; тест работает и в jsdom, где `import.meta.url`
// не file-URL, поэтому путь к `src/` берём от рабочего каталога.
const SRC_ROOT = join(process.cwd(), 'src')

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return cssFiles(full)
    return entry.endsWith('.css') ? [full] : []
  })
}

describe('Анимации по ADR-0005', () => {
  it('в CSS нет бесконечных анимаций вне явного решения (D8)', () => {
    const offenders = cssFiles(SRC_ROOT)
      .map((file) => ({ file, name: relative(SRC_ROOT, file) }))
      .filter(({ name }) => ALLOWED_INFINITE[name] === undefined)
      .filter(({ file }) => /infinite/i.test(readFileSync(file, 'utf8')))
      .map(({ name }) => name)

    expect(offenders, `Бесконечные анимации запрещены ADR-0005: ${offenders.join(', ')}`).toEqual([])
  })
})
