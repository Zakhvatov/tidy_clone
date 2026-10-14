/**
 * Дрейф таксономии корень ↔ воркер (замечание финального ревью).
 *
 * `src/domain/taxonomy.ts` и `workers/api/src/taxonomy.ts` продублированы
 * намеренно: у воркера своя среда и свой `package.json`. Но синхронизируются они
 * вручную, и раньше это ловилось только глазами. Здесь обе стороны сравниваются
 * через импорт словаря — нормализованные списки строк, без парсинга текста.
 */

import { describe, expect, it } from 'vitest'

import { FALLBACK_SUB, FALLBACK_TOP, TAXONOMY, subcategoriesOf, topCategories } from './taxonomy'

/** Отсортированные пары «верхняя категория → её подкатегории» для сравнения. */
function нормализовать(словарь: Record<string, readonly string[]>): [string, string[]][] {
  return Object.entries(словарь)
    .map(([верх, под]) => [верх, [...под]] as [string, string[]])
    .sort((a, b) => a[0].localeCompare(b[0]))
}

describe('Дрейф таксономии ADR-0004: корень ↔ воркер', () => {
  it('верхние категории и подкатегории совпадают у клиента и воркера', async () => {
    const воркер = await import('../../workers/api/src/taxonomy')

    expect(нормализовать(воркер.TAXONOMY)).toEqual(нормализовать(TAXONOMY))
    expect(воркер.topCategories()).toEqual([...topCategories()])
    expect(воркер.FALLBACK_CATEGORY).toBe(FALLBACK_TOP)
    expect(воркер.FALLBACK_SUBCATEGORY).toBe(FALLBACK_SUB)

    for (const верх of topCategories()) {
      expect(воркер.subcategoriesOf(верх)).toEqual([...subcategoriesOf(верх)])
    }
  })
})
