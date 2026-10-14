import 'fake-indexeddb/auto'

import { deleteDB } from 'idb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FALLBACK_SUB, FALLBACK_TOP, subcategoriesOf, topCategories } from '../domain/taxonomy'
import type { ImageRole, Изображение, Вещь } from '../domain/types'
import { DB_NAME, closeDb } from '../storage/db'
import * as images from '../storage/images'
import * as items from '../storage/items'
import { groupByTopCategory, loadWardrobe, preferredImage } from './wardrobe'

function makeItem(overrides: Partial<Вещь> = {}): Вещь {
  const дата = new Date().toISOString()
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

function makeImage(
  id: string,
  idВещи: string,
  роль: ImageRole,
  датаСоздания: string,
  tag = '',
): Изображение {
  const blob = new Blob([`изображение-${tag || id}`], { type: 'image/png' }) as Blob & {
    __tag?: string
  }
  blob.__tag = tag || id
  return { id, idВещи, роль, blob, ширина: 512, высота: 512, mime: 'image/png', датаСоздания }
}

/**
 * Раскладывает `count` вещей по всем верхним категориям ADR-0004 «по кругу».
 * Возвращает фактическое число вещей в каждой категории — чтобы тест проверял
 * счётчики независимо от группировки.
 */
async function seedItems(count: number): Promise<{ top: string; count: number }[]> {
  const tops = topCategories()
  const создано = new Map<string, number>(tops.map((top) => [top, 0]))

  for (let index = 0; index < count; index += 1) {
    const top = tops[index % tops.length]
    const подкатегория = subcategoriesOf(top)[0] ?? FALLBACK_SUB
    const дата = new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString()
    const вещь = makeItem({
      id: `вещь-${index}`,
      название: `Вещь ${index}`,
      категория: top,
      подкатегория,
      датаСоздания: дата,
      датаОбновления: дата,
    })
    await items.create(вещь)
    await images.addOriginal(makeImage(`изобр-${index}`, вещь.id, 'оригинал', дата))
    создано.set(top, (создано.get(top) ?? 0) + 1)
  }

  return tops
    .map((top) => ({ top, count: создано.get(top) ?? 0 }))
    .filter((entry) => entry.count > 0)
}

describe('Чтение гардероба (T13)', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  afterEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('loadWardrobe отдаёт вещи вместе с их изображениями', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await items.create(makeItem({ id: 'вещь-2' }))
    await images.addOriginal(makeImage('изобр-1', 'вещь-1', 'оригинал', '2024-01-01T00:00:00.000Z'))
    await images.addAiVersion(makeImage('изобр-2', 'вещь-1', 'ai', '2024-01-02T00:00:00.000Z'))

    const данные = await loadWardrobe()

    expect(данные).toHaveLength(2)
    const первая = данные.find((entry) => entry.вещь.id === 'вещь-1')
    const вторая = данные.find((entry) => entry.вещь.id === 'вещь-2')
    expect(первая?.изображения.map((и) => и.id).sort()).toEqual(['изобр-1', 'изобр-2'])
    expect(вторая?.изображения).toEqual([])
  })

  it('preferredImage: AI важнее выреза, вырез важнее Оригинала (D9)', async () => {
    const вещь = makeItem({ id: 'вещь-1' })
    const оригинал = makeImage('изобр-1', 'вещь-1', 'оригинал', '2024-01-01T00:00:00.000Z')
    const вырез = makeImage('изобр-3', 'вещь-1', 'вырез', '2024-01-03T00:00:00.000Z')

    // Без AI-версии показывается вырез пакшота — он и нужен для коллажа.
    expect(preferredImage(вещь, [оригинал, вырез])?.id).toBe('изобр-3')

    // С AI-версией — именно она, даже при наличии выреза.
    const ai = makeImage('изобр-2', 'вещь-1', 'ai', '2024-01-02T00:00:00.000Z')
    expect(preferredImage(вещь, [оригинал, вырез, ai])?.id).toBe('изобр-2')

    // Из нескольких AI-версий берётся самая новая.
    const aiСтарее = makeImage('изобр-4', 'вещь-1', 'ai', '2024-01-01T12:00:00.000Z')
    expect(preferredImage(вещь, [ai, aiСтарее])?.id).toBe('изобр-2')

    // Из нескольких вырезов берётся самый новый.
    const вырезСтарее = makeImage('изобр-5', 'вещь-1', 'вырез', '2024-01-02T12:00:00.000Z')
    expect(preferredImage(вещь, [вырезСтарее, вырез])?.id).toBe('изобр-3')

    // Только Оригинал — последний в порядке предпочтения.
    expect(preferredImage(вещь, [оригинал])?.id).toBe('изобр-1')

    // Изображений нет — карточка покажет только подложку.
    expect(preferredImage(вещь, [])).toBeUndefined()
  })

  it('preferredImage не подставляет изображение чужой вещи', async () => {
    const вещь = makeItem({ id: 'вещь-1' })
    const чужоеAi = makeImage('изобр-2', 'вещь-2', 'ai', '2024-01-02T00:00:00.000Z')
    expect(preferredImage(вещь, [чужоеAi])).toBeUndefined()
  })

  it('groupByTopCategory: порядок секций ADR-0004, «Разное» последней, неизвестное не теряется', async () => {
    await items.create(makeItem({ id: 'в-обувь', категория: 'Обувь', подкатегория: 'кроссовки' }))
    await items.create(makeItem({ id: 'в-верх', категория: 'Верх', подкатегория: 'футболка' }))
    await items.create(makeItem({ id: 'в-разное', категория: FALLBACK_TOP, подкатегория: FALLBACK_SUB }))
    await items.create(makeItem({ id: 'в-чужое', категория: 'Нет такой', подкатегория: 'что-то' }))

    const секции = groupByTopCategory(await loadWardrobe())

    expect(секции.map((секция) => секция.категория)).toEqual([
      'Верх',
      'Обувь',
      FALLBACK_TOP,
    ])
    // «Разное» собрало и явную вещь, и вещь с неизвестной категорией.
    const разное = секции.at(-1)
    expect(разное?.количество).toBe(2)
    expect(разное?.вещи.map((entry) => entry.вещь.id).sort()).toEqual(['в-разное', 'в-чужое'])
  })

  it('groupByTopCategory: внутри секции новые вещи первыми', async () => {
    await items.create(
      makeItem({
        id: 'старая',
        категория: 'Верх',
        подкатегория: 'футболка',
        датаСоздания: '2024-01-01T00:00:00.000Z',
      }),
    )
    await items.create(
      makeItem({
        id: 'новая',
        категория: 'Верх',
        подкатегория: 'топ',
        датаСоздания: '2024-06-01T00:00:00.000Z',
      }),
    )

    const [секция] = groupByTopCategory(await loadWardrobe())
    expect(секция?.вещи.map((entry) => entry.вещь.id)).toEqual(['новая', 'старая'])
  })

  it('50 вещей: чтение и группировка укладываются в порог', async () => {
    const ожидаемые = await seedItems(50)

    const началоЧтения = performance.now()
    const данные = await loadWardrobe()
    const времяЧтения = performance.now() - началоЧтения

    const началоГруппировки = performance.now()
    const секции = groupByTopCategory(данные)
    const времяГруппировки = performance.now() - началоГруппировки

     
    console.log(
      `[T13 perf] loadWardrobe: ${времяЧтения.toFixed(1)} мс, ` +
        `группировка: ${времяГруппировки.toFixed(1)} мс, вещей: ${данные.length}`,
    )

    expect(данные).toHaveLength(50)
    expect(секции).toHaveLength(9)
    expect(секции.map((секция) => секция.категория)).toEqual(ожидаемые.map((entry) => entry.top))
    expect(секции.map((секция) => секция.количество)).toEqual(
      ожидаемые.map((entry) => entry.count),
    )
    expect(секции.reduce((сумма, секция) => сумма + секция.количество, 0)).toBe(50)

    // Пороги зафиксированы в тесте: чтение данных и группировка должны быть
    // заметно быстрее кадра, иначе сетка из 50 вещей ощущается тяжёлой.
    expect(времяЧтения).toBeLessThan(300)
    expect(времяГруппировки).toBeLessThan(100)
  })
})
