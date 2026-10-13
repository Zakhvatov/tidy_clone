import 'fake-indexeddb/auto'

import { deleteDB, openDB, type IDBPDatabase } from 'idb'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import type { ImageRole, Изображение, Образ, Season, Вещь } from '../domain/types'
import { DB_NAME, DB_VERSION, closeDb, upgrade, type WardrobeDB } from './db'
import { ОшибкаВещьВОбразе, ОшибкаОригиналНеизменяем } from './errors'
import * as images from './images'
import * as items from './items'
import * as outfits from './outfits'

function makeItem(overrides: Partial<Вещь> = {}): Вещь {
  const now = new Date().toISOString()
  return {
    id: 'вещь-1',
    название: 'Худи тестовое',
    категория: 'Второй слой',
    подкатегория: 'худи',
    цвета: ['чёрный'],
    состав: ['хлопок'],
    сезон: ['демисезон'],
    бренд: 'Тестовый бренд',
    источник: 'фото',
    датаСоздания: now,
    датаОбновления: now,
    idИзображений: [],
    ...overrides,
  }
}

function makeImage(
  id: string,
  idВещи: string,
  роль: ImageRole,
  датаСоздания: string,
): Изображение {
  return {
    id,
    idВещи,
    роль,
    blob: new Blob(['изображение'], { type: 'image/png' }),
    ширина: 512,
    высота: 512,
    mime: 'image/png',
    датаСоздания,
  }
}

function makeOutfit(
  id: string,
  сезон: Season,
  idВещей: string[],
  overrides: Partial<Образ> = {},
): Образ {
  return {
    id,
    название: 'Тестовый образ',
    сезон,
    элементы: idВещей.map((idВещи, index) => ({
      idВещи,
      позиция: { x: index * 10, y: index * 10 },
      масштаб: 1,
      zПорядок: index,
    })),
    датаСоздания: new Date().toISOString(),
    ...overrides,
  }
}

/** Схема теста версии 2: к домену добавляется служебный стор `meta`. */
interface TestWardrobeDB extends WardrobeDB {
  meta: { key: string; value: { ключ: string } }
}

describe('Хранилище гардероба', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  afterAll(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('сохраняет вещь и находит её после закрытия и повторного открытия БД', async () => {
    const вещь = makeItem()
    await items.create(вещь)
    expect(await items.count()).toBe(1)

    await closeDb()

    const found = await items.get(вещь.id)
    expect(found?.название).toBe('Худи тестовое')
    expect(await items.list()).toHaveLength(1)
  })

  it('каскадно удаляет изображения вещи, не трогая изображения других вещей', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await items.create(makeItem({ id: 'вещь-2' }))
    await images.addOriginal(makeImage('изобр-1', 'вещь-1', 'оригинал', '2024-01-01T00:00:00.000Z'))
    await images.addAiVersion(makeImage('изобр-2', 'вещь-1', 'ai', '2024-01-02T00:00:00.000Z'))
    await images.addOriginal(makeImage('изобр-3', 'вещь-2', 'оригинал', '2024-01-03T00:00:00.000Z'))

    await items.remove('вещь-1')

    expect(await items.get('вещь-1')).toBeUndefined()
    expect(await images.get('изобр-1')).toBeUndefined()
    expect(await images.get('изобр-2')).toBeUndefined()
    expect(await images.get('изобр-3')).toBeDefined()
  })

  it('запрещает удалять и перезаписывать оригинал, но позволяет удалить AI-версию', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    const оригинал = makeImage('изобр-1', 'вещь-1', 'оригинал', '2024-01-01T00:00:00.000Z')
    await images.addOriginal(оригинал)

    // Повторная запись с тем же id не перезаписывает оригинал.
    await expect(images.addOriginal(оригинал)).rejects.toBeDefined()

    // Удаление оригинала запрещено отдельным методом.
    await expect(images.removeNonOriginal('изобр-1')).rejects.toBeInstanceOf(
      ОшибкаОригиналНеизменяем,
    )

    // AI-версию удалить можно, оригинал при этом остаётся.
    await images.addAiVersion(makeImage('изобр-2', 'вещь-1', 'ai', '2024-01-02T00:00:00.000Z'))
    await images.removeNonOriginal('изобр-2')

    expect(await images.get('изобр-2')).toBeUndefined()
    const сохранённый = await images.get('изобр-1')
    expect(сохранённый?.роль).toBe('оригинал')
  })

  it('не удаляет вещь, входящую в образ, и возвращает понятную ошибку', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await outfits.create(makeOutfit('образ-1', 'зима', ['вещь-1']))

    await expect(items.remove('вещь-1')).rejects.toBeInstanceOf(ОшибкаВещьВОбразе)
    expect(await items.get('вещь-1')).toBeDefined()
  })

  it('переживает миграцию схемы на версию 2 без потери данных', async () => {
    await items.create(makeItem({ id: 'вещь-1', название: 'До миграции' }))
    await closeDb()

    // Ветка версии 2 живёт в тесте: в рабочем коде она появится такой же одной
    // ветвью внутри `switch` в upgrade(), а прошлые шаги не изменятся.
    const db2 = await openDB<TestWardrobeDB>(DB_NAME, 2, {
      upgrade(database, oldVersion, newVersion) {
        upgrade(
          database as unknown as IDBPDatabase<WardrobeDB>,
          oldVersion,
          Math.min(newVersion ?? DB_VERSION, DB_VERSION),
        )
        if (oldVersion < 2 && !database.objectStoreNames.contains('meta')) {
          database.createObjectStore('meta', { keyPath: 'ключ' })
        }
      },
    })

    const afterMigration = await db2.get('items', 'вещь-1')
    expect(afterMigration?.название).toBe('До миграции')
    expect(db2.objectStoreNames.contains('meta')).toBe(true)
    db2.close()
  })

  it('находит образы по сезону через индекс', async () => {
    await outfits.create(makeOutfit('образ-1', 'зима', []))
    await outfits.create(makeOutfit('образ-2', 'лето', []))
    await outfits.create(makeOutfit('образ-3', 'зима', []))

    const зимние = await outfits.listBySeason('зима')
    expect(зимние.map((образ) => образ.id).sort()).toEqual(['образ-1', 'образ-3'])
  })

  it('обновляет вещь частично и проставляет дату обновления', async () => {
    const вещь = makeItem({ датаОбновления: '2020-01-01T00:00:00.000Z' })
    await items.create(вещь)

    const updated = await items.update('вещь-1', { название: 'Новое имя' })

    expect(updated.название).toBe('Новое имя')
    expect(updated.категория).toBe(вещь.категория)
    expect(updated.датаСоздания).toBe(вещь.датаСоздания)
    expect(updated.датаОбновления).not.toBe('2020-01-01T00:00:00.000Z')
  })
})
