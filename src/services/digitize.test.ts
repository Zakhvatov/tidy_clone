import 'fake-indexeddb/auto'

import { deleteDB } from 'idb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ImageRole, Изображение, Вещь } from '../domain/types'
import { buildGenerationPrompt } from '../domain/prompt-templates'
import { DB_NAME, closeDb } from '../storage/db'
import * as images from '../storage/images'
import * as items from '../storage/items'
import {
  digitizeAuto,
  digitizeItem,
  digitizeMissing,
  digitizePackshot,
  itemsNeedingDigitization,
  type DigitizeDeps,
} from './digitize'

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

function makeImage(
  id: string,
  idВещи: string,
  роль: ImageRole,
  tag: string,
  датаСоздания = '2024-01-01T00:00:00.000Z',
): Изображение {
  return {
    id,
    idВещи,
    роль,
    blob: new Blob([tag], { type: 'image/png' }),
    ширина: 512,
    высота: 512,
    mime: 'image/png',
    датаСоздания,
  }
}

const PACKSHOT = { isPackshot: true, whiteness: 0.9, uniformity: 0.9, reason: 'пакшот' }
const MODEL = { isPackshot: false, whiteness: 0, uniformity: 0.2, reason: 'модель' }

function baseDeps(): DigitizeDeps {
  return {
    measure: async () => ({ ширина: 1024, высота: 1024 }),
    now: () => '2024-06-01T00:00:00.000Z',
  }
}

function cutoutResult(tag: string) {
  return { blob: new Blob([tag], { type: 'image/png' }), suspicious: false, transparentRatio: 0.4 }
}

describe('Оцифровка (T10)', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  afterEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('успешная оцифровка создаёт роль ai и не меняет Оригинал', async () => {
    await items.create(makeItem({ id: 'вещь-1', idИзображений: ['ор-1'] }))
    await images.addOriginal(makeImage('ор-1', 'вещь-1', 'оригинал', 'оригинал-байты'))
    const оригиналДо = await images.get('ор-1')

    const generate = vi.fn(async () => new Blob(['ai-байты'], { type: 'image/jpeg' }))
    const outcome = await digitizeItem('вещь-1', {
      ...baseDeps(),
      generate,
      id: () => 'ai-1',
    })

    expect(outcome).toMatchObject({ way: 'ai', status: 'создано' })
    const ai = await images.get('ai-1')
    expect(ai?.роль).toBe('ai')
    expect(ai?.ширина).toBe(1024)

    // Оригинал не перезаписан и не удалён: та же запись, тот же id и роль.
    const оригинал = await images.get('ор-1')
    expect(оригинал).toEqual(оригиналДо)
    expect(оригинал?.роль).toBe('оригинал')
    expect((await images.listByItem('вещь-1')).filter((i) => i.роль === 'оригинал')).toHaveLength(1)

    // Производное изображение дописано в вещь, но сама вещь не потеряна.
    const вещь = await items.get('вещь-1')
    expect(вещь?.idИзображений).toEqual(['ор-1', 'ai-1'])
  })

  it('промпт строится из подкатегории вещи (T11)', async () => {
    const prompt = buildGenerationPrompt(makeItem({ подкатегория: 'худи', категория: 'Второй слой' }))
    expect(prompt).toContain('hoodie')
    expect(prompt).toContain('full garment')
    expect(buildGenerationPrompt(makeItem({ подкатегория: '', категория: 'Разное' }))).toContain(
      'clothing item',
    )
  })

  it('пакшот оцифровывается вырезом, генерация не вызывается', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await images.addOriginal(makeImage('ор-1', 'вещь-1', 'оригинал', 'pack'))

    const generate = vi.fn(async () => new Blob(['ai'], { type: 'image/jpeg' }))
    const cutout = vi.fn(async () => cutoutResult('вырез-байты'))
    const analyze = vi.fn(async () => PACKSHOT)

    const outcome = await digitizeAuto('вещь-1', {
      ...baseDeps(),
      generate,
      cutout,
      analyze,
      id: () => 'вырез-1',
    })

    expect(outcome).toMatchObject({ way: 'вырез', status: 'создано' })
    expect(generate).not.toHaveBeenCalled()
    expect(cutout).toHaveBeenCalledTimes(1)
    expect((await images.get('вырез-1'))?.роль).toBe('вырез')
  })

  it('digitizePackshot вырезает без генерации, digitizeItem — генерирует', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await images.addOriginal(makeImage('ор-1', 'вещь-1', 'оригинал', 'pack'))

    const generate = vi.fn(async () => new Blob(['ai'], { type: 'image/jpeg' }))
    const cutout = vi.fn(async () => cutoutResult('cut'))

    const pack = await digitizePackshot('вещь-1', { ...baseDeps(), generate, cutout, id: () => 'вырез-1' })
    expect(pack.way).toBe('вырез')
    expect(generate).not.toHaveBeenCalled()

    const ai = await digitizeItem('вещь-1', { ...baseDeps(), generate, cutout, id: () => 'ai-1' })
    expect(ai.way).toBe('ai')
    expect(generate).toHaveBeenCalledTimes(1)
    expect(cutout).toHaveBeenCalledTimes(1)
  })

  it('повторный запуск идемпотентен: второй AI-версии не появляется', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await images.addOriginal(makeImage('ор-1', 'вещь-1', 'оригинал', 'orig'))
    const generate = vi.fn(async () => new Blob(['ai'], { type: 'image/jpeg' }))

    const первый = await digitizeItem('вещь-1', { ...baseDeps(), generate, id: () => 'ai-1' })
    const второй = await digitizeItem('вещь-1', { ...baseDeps(), generate, id: () => 'ai-2' })

    expect(первый.status).toBe('создано')
    expect(второй.status).toBe('уже есть')
    expect(второй.image.id).toBe('ai-1')
    expect(generate).toHaveBeenCalledTimes(1)
    expect((await images.listByItem('вещь-1')).filter((i) => i.роль === 'ai')).toHaveLength(1)
  })

  it('digitizeMissing: пакшот → вырез, модельное → AI, вещь с вырезом не трогается', async () => {
    await items.create(makeItem({ id: 'пакшот' }))
    await items.create(makeItem({ id: 'модель' }))
    await items.create(makeItem({ id: 'уже-вырез' }))
    await images.addOriginal(makeImage('ор-п', 'пакшот', 'оригинал', 'pack'))
    await images.addOriginal(makeImage('ор-м', 'модель', 'оригинал', 'model'))
    await images.addOriginal(makeImage('ор-в', 'уже-вырез', 'оригинал', 'pack'))
    await images.addCutout(makeImage('вырез-готов', 'уже-вырез', 'вырез', 'cut'))

    const generate = vi.fn(async () => new Blob(['ai'], { type: 'image/jpeg' }))
    const cutout = vi.fn(async () => cutoutResult('cut'))
    const analyze = async (_blob: Blob, вещь: Вещь) => (вещь.id === 'пакшот' ? PACKSHOT : MODEL)

    let nextId = 0
    const результаты = await digitizeMissing({
      ...baseDeps(),
      generate,
      cutout,
      analyze,
      id: () => `new-${++nextId}`,
    })

    expect(результаты.map((r) => r.itemId).sort()).toEqual(['модель', 'пакшот'])
    expect(результаты.every((r) => r.error === undefined)).toBe(true)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(cutout).toHaveBeenCalledTimes(1)

    const пакшот = await images.listByItem('пакшот')
    expect(пакшот.map((i) => i.роль)).toContain('вырез')
    const модель = await images.listByItem('модель')
    expect(модель.map((i) => i.роль)).toContain('ai')
    // Вещь с готовым вырезом в план не попала и второго изображения не получила.
    expect(await images.listByItem('уже-вырез')).toHaveLength(2)
  })

  it('itemsNeedingDigitization возвращает только вещи без выреза и без AI', async () => {
    await items.create(makeItem({ id: 'нужна' }))
    await items.create(makeItem({ id: 'с-ai' }))
    await items.create(makeItem({ id: 'с-вырезом' }))
    await images.addOriginal(makeImage('ор-1', 'нужна', 'оригинал', 'x'))
    await images.addAiVersion(makeImage('ai-1', 'с-ai', 'ai', 'x'))
    await images.addCutout(makeImage('в-1', 'с-вырезом', 'вырез', 'x'))

    const план = await itemsNeedingDigitization()
    expect(план.map((p) => p.id)).toEqual(['нужна'])
  })

  it('вещь без Оригинала даёт понятную ошибку, а не тихий сбой', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    const error = await digitizeItem('вещь-1', baseDeps()).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'no_original' })
    expect((error as Error).message).toMatch(/Оригинал/)
  })

  it('не найдена вещь → not_found', async () => {
    const error = await digitizeItem('нет-такой', baseDeps()).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'not_found' })
  })
})
