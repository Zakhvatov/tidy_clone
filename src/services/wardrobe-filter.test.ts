import { describe, expect, it } from 'vitest'

import { FALLBACK_TOP } from '../domain/taxonomy'
import type { Season, Вещь } from '../domain/types'
import {
  availableColors,
  availableSeasons,
  availableSubcategories,
  filterAndSearch,
  filterItems,
  hasActiveFilter,
  searchItems,
} from './wardrobe-filter'

function makeItem(overrides: Partial<Вещь> = {}): Вещь {
  const дата = '2024-01-01T00:00:00.000Z'
  return {
    id: 'вещь-1',
    название: 'Худи тестовое',
    категория: 'Второй слой',
    подкатегория: 'худи',
    цвета: [],
    состав: [],
    сезон: [],
    бренд: '',
    источник: 'фото',
    датаСоздания: дата,
    датаОбновления: дата,
    idИзображений: [],
    ...overrides,
  }
}

describe('Фильтры и поиск (T14)', () => {
  const вещи: Вещь[] = [
    makeItem({
      id: 'в-худи',
      название: 'Худи тёплое',
      категория: 'Второй слой',
      подкатегория: 'худи',
      цвета: ['чёрный', 'серый'],
      сезон: ['зима', 'демисезон'],
    }),
    makeItem({
      id: 'в-кардиган',
      название: 'Кардиган офисный',
      категория: 'Второй слой',
      подкатегория: 'кардиган',
      цвета: ['белый'],
      сезон: ['демисезон'],
    }),
    makeItem({
      id: 'в-кроссовки',
      название: 'Кроссовки для бега',
      категория: 'Обувь',
      подкатегория: 'кроссовки',
      цвета: ['чёрный', 'белый'],
      сезон: ['лето'],
    }),
    makeItem({
      id: 'в-футболка',
      название: 'Футболка Ёлочка',
      категория: 'Верх',
      подкатегория: 'футболка',
      цвета: ['зелёный'],
      сезон: [],
    }),
    makeItem({
      id: 'в-чужое',
      название: 'Странная вещь',
      категория: 'Неизвестная категория',
      подкатегория: 'что-то',
      цвета: ['красный'],
      сезон: ['зима'],
    }),
  ]

  it('пустой фильтр возвращает все вещи', () => {
    expect(filterItems(вещи, {})).toHaveLength(вещи.length)
    expect(filterItems(вещи, { цвета: [], сезоны: [] })).toHaveLength(вещи.length)
    expect(filterItems(вещи, { top: '', sub: '' })).toHaveLength(вещи.length)
  })

  it('фильтр по верхней категории; неизвестная категория попадает в «Разное»', () => {
    const обувь = filterItems(вещи, { top: 'Обувь' })
    expect(обувь.map((вещь) => вещь.id)).toEqual(['в-кроссовки'])

    const разное = filterItems(вещи, { top: FALLBACK_TOP })
    expect(разное.map((вещь) => вещь.id)).toEqual(['в-чужое'])
  })

  it('фильтр по подкатегории', () => {
    const кардиганы = filterItems(вещи, { sub: 'кардиган' })
    expect(кардиганы.map((вещь) => вещь.id)).toEqual(['в-кардиган'])
  })

  it('фильтр по цвету: достаточно одного из выбранных', () => {
    const чёрнобелые = filterItems(вещи, { цвета: ['белый'] })
    expect(чёрнобелые.map((вещь) => вещь.id).sort()).toEqual(['в-кардиган', 'в-кроссовки'])
  })

  it('фильтр по сезону: достаточно одного из выбранных', () => {
    const зимаЛето = filterItems(вещи, { сезоны: ['зима', 'лето'] })
    expect(зимаЛето.map((вещь) => вещь.id).sort()).toEqual([
      'в-кроссовки',
      'в-худи',
      'в-чужое',
    ])
  })

  it('комбинация фильтров соединяется по «И»', () => {
    const комбо = filterItems(вещи, {
      top: 'Второй слой',
      sub: 'худи',
      цвета: ['чёрный'],
      сезоны: ['зима'],
    })
    expect(комбо.map((вещь) => вещь.id)).toEqual(['в-худи'])

    // Каждое условие сужает: несовместимая комбинация даёт пусто.
    expect(filterItems(вещи, { top: 'Обувь', сезоны: ['зима'] })).toEqual([])
  })

  it('поиск по названию: регистр, «ё → е» и подстрока', () => {
    expect(searchItems(вещи, 'худи').map((в) => в.id)).toEqual(['в-худи'])
    expect(searchItems(вещи, 'ХУДИ').map((в) => в.id)).toEqual(['в-худи'])
    expect(searchItems(вещи, 'елочка').map((в) => в.id)).toEqual(['в-футболка'])
    expect(searchItems(вещи, 'ЁЛОЧКА').map((в) => в.id)).toEqual(['в-футболка'])
    expect(searchItems(вещи, 'для бега').map((в) => в.id)).toEqual(['в-кроссовки'])
    expect(searchItems(вещи, 'такого нет')).toEqual([])
    expect(searchItems(вещи, '')).toHaveLength(вещи.length)
  })

  it('поиск не учитывает бренд и состав', () => {
    const брендованная = makeItem({
      id: 'в-бренд',
      название: 'Платье',
      бренд: 'УникальныйБренд',
      состав: ['кашемир'],
    })
    expect(searchItems([брендованная], 'УникальныйБренд')).toEqual([])
    expect(searchItems([брендованная], 'кашемир')).toEqual([])
    expect(searchItems([брендованная], 'платье')).toEqual([брендованная])
  })

  it('filterAndSearch применяет фильтр и поиск вместе', () => {
    const найдено = filterAndSearch(вещи, { top: 'Второй слой', цвета: ['белый'] }, 'кардиган')
    expect(найдено.map((вещь) => вещь.id)).toEqual(['в-кардиган'])

    const неНайдено = filterAndSearch(вещи, { top: 'Второй слой' }, 'кроссовки')
    expect(неНайдено).toEqual([])
  })

  it('availableColors и availableSeasons показывают только то, что есть в гардеробе', () => {
    expect(availableColors(вещи)).toEqual(['белый', 'зелёный', 'красный', 'серый', 'чёрный'])
    expect(availableSeasons(вещи)).toEqual(['зима', 'лето', 'демисезон'])

    expect(availableColors([])).toEqual([])
    expect(availableSeasons([])).toEqual([])
    // Пустые цвета не превращаются в пустой чип.
    expect(availableColors([makeItem({ цвета: ['', '  '] })])).toEqual([])
  })

  it('availableSubcategories зависит от верхней категории и не показывает лишнего', () => {
    expect(availableSubcategories(вещи, 'Второй слой')).toEqual(['кардиган', 'худи'])
    expect(availableSubcategories(вещи, 'Обувь')).toEqual(['кроссовки'])
    expect(availableSubcategories(вещи, FALLBACK_TOP)).toEqual(['что-то'])
    expect(availableSubcategories(вещи, '')).toEqual([])
  })

  it('hasActiveFilter различает пустой и заданный фильтр', () => {
    expect(hasActiveFilter({})).toBe(false)
    expect(hasActiveFilter({ top: '  ' })).toBe(false)
    expect(hasActiveFilter({ цвета: [] })).toBe(false)
    expect(hasActiveFilter({ сезоны: ['зима'] })).toBe(true)
    expect(hasActiveFilter({ top: 'Обувь' })).toBe(true)
  })

  it('50 вещей: filterAndSearch укладывается в порог', () => {
    const много: Вещь[] = []
    for (let index = 0; index < 50; index += 1) {
      const сезон: Season[] = index % 3 === 0 ? ['зима'] : index % 3 === 1 ? ['лето'] : ['демисезон']
      много.push(
        makeItem({
          id: `вещь-${index}`,
          название: `Вещь ${index} тестовая`,
          категория: index % 2 === 0 ? 'Верх' : 'Обувь',
          подкатегория: index % 2 === 0 ? 'футболка' : 'кроссовки',
          цвета: index % 2 === 0 ? ['белый'] : ['чёрный'],
          сезон,
        }),
      )
    }

    const начало = performance.now()
    const найдено = filterAndSearch(много, { top: 'Верх', цвета: ['белый'] }, 'тестовая')
    const прошло = performance.now() - начало

    console.log(`[T14 perf] filterAndSearch на 50 вещах: ${прошло.toFixed(2)} мс`)

    expect(найдено).toHaveLength(25)
    // Порог с запасом: защита от случайного N+1/обращения к хранилищу на ввод.
    expect(прошло).toBeLessThan(50)
  })
})
