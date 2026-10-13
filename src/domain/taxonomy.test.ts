import { describe, expect, it } from 'vitest'

import {
  FALLBACK_SUB,
  FALLBACK_TOP,
  TAXONOMY,
  isKnownSub,
  isKnownTop,
  subcategoriesOf,
  topCategories,
} from './taxonomy'

describe('Таксономия ADR-0004', () => {
  it('содержит ровно 8 верхних категорий из ADR с их подкатегориями', () => {
    expect(TAXONOMY).toEqual({
      Верх: ['лонгслив', 'футболка', 'топ', 'кроп-топ', 'рубашка', 'свитер'],
      Низ: ['джинсы', 'брюки', 'шорты', 'юбка'],
      Платья: ['платье', 'сарафан'],
      'Верхняя одежда': ['куртка', 'пальто', 'пуховик', 'пиджак', 'тренч'],
      'Второй слой': ['кардиган', 'жилет', 'худи'],
      Обувь: ['кроссовки', 'ботинки', 'сапоги', 'туфли', 'сандалии'],
      Аксессуары: ['сумка', 'ремень', 'шапка', 'шарф', 'украшения', 'очки'],
      Бельё: ['бюстгальтер', 'трусы', 'носки', 'колготки'],
    })
  })

  it('отдаёт верхние категории вместе с «Разное»', () => {
    const categories = topCategories()
    expect(categories).toHaveLength(9)
    expect(categories).toContain(FALLBACK_TOP)
    expect(categories.slice(0, 8)).toEqual(Object.keys(TAXONOMY))
  })

  it('различает известные и неизвестные категории', () => {
    expect(isKnownTop('Обувь')).toBe(true)
    expect(isKnownTop(FALLBACK_TOP)).toBe(true)
    expect(isKnownTop('Носки')).toBe(false)
  })

  it('проверяет пару «категория — подкатегория»', () => {
    expect(isKnownSub('Обувь', 'сапоги')).toBe(true)
    expect(isKnownSub('Обувь', 'платье')).toBe(false)
    expect(isKnownSub(FALLBACK_TOP, FALLBACK_SUB)).toBe(true)
    expect(isKnownSub(FALLBACK_TOP, 'худи')).toBe(false)
  })

  it('отдаёт подкатегории и пустой список для неизвестной категории', () => {
    expect(subcategoriesOf('Платья')).toContain('сарафан')
    expect(subcategoriesOf(FALLBACK_TOP)).toEqual([FALLBACK_SUB])
    expect(subcategoriesOf('Неизвестно')).toEqual([])
  })
})
