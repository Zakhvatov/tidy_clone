import 'fake-indexeddb/auto'

import { Blob as NodeBlob } from 'node:buffer'

import { deleteDB } from 'idb'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ImageRole, Изображение, Образ, Season, Вещь } from '../domain/types'
import { DB_NAME, closeDb, getDb } from '../storage/db'
import * as images from '../storage/images'
import * as items from '../storage/items'
import * as outfits from '../storage/outfits'
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  ОшибкаРезервнойКопии,
  buildBackup,
  exportWardrobe,
  importWardrobe,
  имяФайлаКопии,
  prepareImport,
  разобратьКопию,
} from './backup'

function makeItem(overrides: Partial<Вещь> = {}): Вещь {
  const дата = '2024-03-05T10:00:00.000Z'
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
  байты: number[],
  датаСоздания = '2024-03-05T10:00:01.000Z',
): Изображение {
  return {
    id,
    idВещи,
    роль,
    blob: new Blob([new Uint8Array(байты)], { type: 'image/png' }),
    ширина: 512,
    высота: 512,
    mime: 'image/png',
    датаСоздания,
  }
}

function makeOutfit(id: string, сезон: Season, idВещей: string[]): Образ {
  return {
    id,
    название: 'Летний образ',
    сезон,
    элементы: idВещей.map((idВещи, index) => ({
      idВещи,
      позиция: { x: index * 10, y: index * 10 },
      масштаб: 1,
      zПорядок: index,
    })),
    датаСоздания: '2024-04-01T00:00:00.000Z',
  }
}

async function текст(blob: Blob): Promise<string> {
  return blob.text()
}

async function байты(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())]
}

/** Один файл-фикстура: вещь с оригиналом и AI-версией плюс образ из неё. */
async function засеятьГардероб(): Promise<{ вещь: Вещь; оригинал: Изображение; ai: Изображение }> {
  const оригинал = makeImage('изобр-1', 'вещь-1', 'оригинал', [1, 2, 3, 4])
  const ai = makeImage('изобр-2', 'вещь-1', 'ai', [9, 8, 7], '2024-03-05T10:00:02.000Z')
  const вещь = makeItem({ idИзображений: ['изобр-1', 'изобр-2'] })
  await items.create(вещь)
  await images.addOriginal(оригинал)
  await images.addAiVersion(ai)
  await outfits.create(makeOutfit('образ-1', 'демисезон', ['вещь-1']))
  return { вещь, оригинал, ai }
}

function файлИз(копия: unknown): Blob {
  return new Blob([JSON.stringify(копия)], { type: 'application/json' })
}

async function очиститьБазовыйГардероб(): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['items', 'images', 'outfits'], 'readwrite')
  await Promise.all([
    tx.objectStore('items').clear(),
    tx.objectStore('images').clear(),
    tx.objectStore('outfits').clear(),
  ])
  await tx.done
}

describe('Резервная копия (T19)', () => {
  // `fake-indexeddb` прогоняет значения через `structuredClone`, а jsdom-овый
  // `Blob` он не понимает и превращает в пустой объект. Node-овый `Blob`
  // клонируется корректно и ведёт себя как настоящий (есть `arrayBuffer`/`text`).
  beforeAll(() => {
    vi.stubGlobal('Blob', NodeBlob)
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  afterEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('экспортирует пустой гардероб в валидный файл', async () => {
    const { blob, имяФайла, счётчики } = await exportWardrobe(new Date('2026-10-14T09:30:00.000Z'))

    expect(имяФайла).toBe('wardrobe-backup-2026-10-14.json')
    expect(счётчики).toEqual({ вещи: 0, изображения: 0, образы: 0 })

    const копия = разобратьКопию(await текст(blob))
    expect(копия.format).toBe(BACKUP_FORMAT)
    expect(копия.formatVersion).toBe(BACKUP_FORMAT_VERSION)
    expect(копия.вещи).toEqual([])
    expect(копия.изображения).toEqual([])
    expect(копия.образы).toEqual([])
  })

  it('имя файла всегда содержит дату', () => {
    expect(имяФайлаКопии(new Date(2025, 0, 3))).toMatch(/^wardrobe-backup-\d{4}-\d{2}-\d{2}\.json$/)
  })

  it('экспорт ничего не теряет: счётчики совпадают с гардеробом', async () => {
    await засеятьГардероб()

    const копия = await buildBackup()
    expect(копия.вещи).toHaveLength(1)
    expect(копия.изображения).toHaveLength(2)
    expect(копия.образы).toHaveLength(1)

    const { счётчики } = await exportWardrobe()
    expect(счётчики).toEqual({ вещи: 1, изображения: 2, образы: 1 })
  })

  it('экспорт → импорт в пустую базу восстанавливает вещи, изображения и образы', async () => {
    await засеятьГардероб()
    const { blob } = await exportWardrobe()

    // «Новое устройство»: база пустая.
    await очиститьБазовыйГардероб()

    const итог = await importWardrobe(blob)
    expect(итог.добавлено).toEqual({ вещи: 1, изображения: 2, образы: 1 })
    expect(итог.обновлено).toEqual({ вещи: 0, изображения: 0, образы: 0 })
    expect(итог.пропущено).toEqual({ вещи: 0, изображения: 0, образы: 0 })

    const вещи = await items.list()
    expect(вещи).toHaveLength(1)
    expect(вещи[0]?.idИзображений).toEqual(['изобр-1', 'изобр-2'])

    const восстановленныйОригинал = await images.get('изобр-1')
    const восстановленныйAi = await images.get('изобр-2')
    expect(await байты(восстановленныйОригинал!.blob)).toEqual([1, 2, 3, 4])
    expect(восстановленныйОригинал!.blob.size).toBe(4)
    expect(восстановленныйОригинал!.роль).toBe('оригинал')
    expect(await байты(восстановленныйAi!.blob)).toEqual([9, 8, 7])
    expect(восстановленныйAi!.роль).toBe('ai')

    const образы = await outfits.list()
    expect(образы).toHaveLength(1)
    expect(образы[0]?.элементы[0]?.idВещи).toBe('вещь-1')
  })

  it('повторный импорт того же файла не создаёт дубликатов', async () => {
    await засеятьГардероб()
    const { blob } = await exportWardrobe()
    const содержимое = await текст(blob)

    await importWardrobe(new Blob([содержимое]))
    const итог = await importWardrobe(new Blob([содержимое]))

    expect(итог.добавлено).toEqual({ вещи: 0, изображения: 0, образы: 0 })
    expect(итог.пропущено).toEqual({ вещи: 1, изображения: 2, образы: 1 })
    expect(await items.count()).toBe(1)
    const всеИзображения = await images.listByItem('вещь-1')
    expect(всеИзображения).toHaveLength(2)
    expect(await outfits.list()).toHaveLength(1)
  })

  it('импорт поверх гардероба не теряет существующие данные', async () => {
    await засеятьГардероб()
    const { blob } = await exportWardrobe()
    const содержимое = await текст(blob)

    // В базе появилась более новая правка вещи и второй образ — их терять нельзя.
    await items.update('вещь-1', { название: 'Правка после копии' })
    await outfits.create(makeOutfit('образ-2', 'лето', ['вещь-1']))
    await items.create(makeItem({ id: 'вещь-2', название: 'Своя вещь' }))

    const итог = await importWardrobe(new Blob([содержимое]))

    expect(итог.обновлено.вещи).toBe(0)
    expect(итог.пропущено.вещи).toBe(1)
    expect(итог.пропущено.образы).toBe(1)

    const вещи = await items.list()
    expect(вещи.map((вещь) => вещь.id).sort()).toEqual(['вещь-1', 'вещь-2'])
    expect((await items.get('вещь-1'))?.название).toBe('Правка после копии')
    expect((await outfits.list()).map((образ) => образ.id).sort()).toEqual([
      'образ-1',
      'образ-2',
    ])
  })

  it('вещь из файла новее — обновляется, а не подменяется целиком', async () => {
    await засеятьГардероб()
    // В базе вещь от 2024 года, а в файле — правка 2026 года: файл новее.
    const копия = await buildBackup(new Date('2026-01-01T00:00:00.000Z'))
    копия.вещи[0] = {
      ...копия.вещи[0]!,
      название: 'Из резервной копии',
      датаОбновления: '2026-01-01T00:00:00.000Z',
    }

    const итог = await importWardrobe(файлИз(копия))

    expect(итог.обновлено.вещи).toBe(1)
    expect((await items.get('вещь-1'))?.название).toBe('Из резервной копии')
  })

  it('добавляет копию изображения, если id занят, а байты другие', async () => {
    await засеятьГардероб()
    const копия = await buildBackup()

    // Вещь из файла новее, поэтому она импортируется.
    копия.вещи[0] = { ...копия.вещи[0]!, датаОбновления: '2026-01-01T00:00:00.000Z' }
    // Подменяем байты изображения так, чтобы id совпал, а содержимое отличалось.
    const изображениеВКопии = копия.изображения.find((изображение) => изображение.id === 'изобр-1')!
    изображениеВКопии.base64 = btoa(String.fromCharCode(5, 5, 5, 5))
    изображениеВКопии.размер = 4

    const итог = await importWardrobe(файлИз(копия))

    expect(итог.добавлено.изображения).toBe(1)
    const всеИзображения = await images.listByItem('вещь-1')
    expect(всеИзображения).toHaveLength(3)

    const оригинал = всеИзображения.find((изображение) => изображение.id === 'изобр-1')!
    expect(await байты(оригинал.blob)).toEqual([1, 2, 3, 4])

    const копии = всеИзображения.filter((изображение) => изображение.id !== 'изобр-1' && изображение.роль === 'оригинал')
    expect(копии).toHaveLength(1)
    expect(await байты(копии[0]!.blob)).toEqual([5, 5, 5, 5])
    // Ссылка в вещи переставлена на копию, оригинал не потерян.
    const вещь = await items.get('вещь-1')
    expect(вещь?.idИзображений).toContain(копии[0]!.id)
  })

  it('не JSON → понятная ошибка, база не тронута', async () => {
    await засеятьГардероб()

    await expect(importWardrobe(new Blob(['<html>не json</html>']))).rejects.toMatchObject({
      name: 'ОшибкаРезервнойКопии',
      code: 'not_json',
    })
    expect(await items.count()).toBe(1)
    expect(await outfits.list()).toHaveLength(1)
  })

  it('чужой JSON → понятная ошибка «не файл резервной копии»', async () => {
    const ошибка = await importWardrobe(new Blob([JSON.stringify({ hello: 'world' })])).catch(
      (error: unknown) => error,
    )
    expect(ошибка).toBeInstanceOf(ОшибкаРезервнойКопии)
    expect((ошибка as ОшибкаРезервнойКопии).code).toBe('not_backup')
  })

  it('неизвестная версия формата → понятная ошибка, база не тронута', async () => {
    await засеятьГардероб()
    const копия = { ...(await buildBackup()), formatVersion: BACKUP_FORMAT_VERSION + 1 }

    const ошибка = await importWardrobe(файлИз(копия)).catch((error: unknown) => error)
    expect(ошибка).toBeInstanceOf(ОшибкаРезервнойКопии)
    expect((ошибка as ОшибкаРезервнойКопии).code).toBe('version')
    expect((ошибка as Error).message).toContain('более новой версией')
    expect(await items.count()).toBe(1)
  })

  it('битый base64 → ошибка с указанием изображения, база не тронута', async () => {
    await засеятьГардероб()
    const копия = await buildBackup()
    копия.изображения[0]!.base64 = 'это точно не base64!!!'

    const ошибка = await importWardrobe(файлИз(копия)).catch((error: unknown) => error)
    expect(ошибка).toBeInstanceOf(ОшибкаРезервнойКопии)
    expect((ошибка as ОшибкаРезервнойКопии).code).toBe('corrupt')
    expect((ошибка as Error).message).toContain(копия.изображения[0]!.id)
    expect(await items.count()).toBe(1)
    expect(await images.listByItem('вещь-1')).toHaveLength(2)
  })

  it('несовпадение размера и байтов → ошибка целостности', async () => {
    await засеятьГардероб()
    const копия = await buildBackup()
    копия.изображения[0]!.размер = 999

    await expect(importWardrobe(файлИз(копия))).rejects.toMatchObject({ code: 'corrupt' })
    expect(await items.count()).toBe(1)
  })

  it('вещь ссылается на отсутствующее изображение → ошибка «файл испорчен»', async () => {
    await засеятьГардероб()
    const копия = await buildBackup()
    копия.вещи[0]!.idИзображений = ['нет-такого']

    await expect(importWardrobe(файлИз(копия))).rejects.toMatchObject({ code: 'corrupt' })
    expect(await items.count()).toBe(1)
  })

  it('prepareImport показывает план, но ничего не пишет', async () => {
    await засеятьГардероб()
    const { blob } = await exportWardrobe()
    await очиститьБазовыйГардероб()

    const подготовленный = await prepareImport(blob)
    expect(подготовленный.вФайле).toEqual({ вещи: 1, изображения: 2, образы: 1 })
    expect(подготовленный.план.добавлено).toEqual({ вещи: 1, изображения: 2, образы: 1 })
    // До applyImport база пуста.
    expect(await items.count()).toBe(0)
  })
})
