import 'fake-indexeddb/auto'

import { deleteDB } from 'idb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ImageRole, Изображение, Вещь } from '../domain/types'
import { buildGenerationPrompt } from '../domain/prompt-templates'
import { DB_NAME, closeDb } from '../storage/db'
import * as images from '../storage/images'
import * as items from '../storage/items'
import { loadJob } from '../storage/jobs'
import { clearAccessToken, saveAccessToken } from '../storage/settings'
import {
  digitizeItem,
  digitizePackshot,
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
    window.localStorage.clear()
    saveAccessToken('test-token')
  })

  afterEach(async () => {
    clearAccessToken()
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('успешная оцифровка создаёт роль ai и удаляет сырьевой снимок (ADR-0006)', async () => {
    await items.create(makeItem({ id: 'вещь-1', idИзображений: ['ор-1'] }))
    await images.addOriginal(makeImage('ор-1', 'вещь-1', 'оригинал', 'оригинал-байты'))

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

    // Загруженный снимок — сырьё: после успеха он удаляется (ADR-0006 §4),
    // в галерее вещи остаётся одна AI-версия.
    expect(await images.get('ор-1')).toBeUndefined()
    expect((await images.listByItem('вещь-1')).filter((i) => i.роль === 'оригинал')).toHaveLength(0)

    // Список изображений вещи ведёт себя честно: только новая AI-версия.
    const вещь = await items.get('вещь-1')
    expect(вещь?.idИзображений).toEqual(['ai-1'])
  })

  it('вещь из маркетплейса хранит Оригинал: удаляется только загруженный снимок', async () => {
    await items.create(makeItem({ id: 'с-листа', источник: 'ссылка', idИзображений: ['ор-1'] }))
    await images.addOriginal(makeImage('ор-1', 'с-листа', 'оригинал', 'wb-фото'))

    const generate = vi.fn(async () => new Blob(['ai'], { type: 'image/jpeg' }))
    await digitizeItem('с-листа', { ...baseDeps(), generate, id: () => 'ai-1' })

    // Для источника «ссылка» правило «Оригинал не удаляется» остаётся в силе.
    expect(await images.get('ор-1')).toBeDefined()
    expect((await items.get('с-листа'))?.idИзображений).toEqual(['ор-1', 'ai-1'])
  })

  it('промпт строится из подкатегории вещи (T11)', async () => {
    const prompt = buildGenerationPrompt(makeItem({ подкатегория: 'худи', категория: 'Второй слой' }))
    expect(prompt).toContain('hoodie')
    expect(prompt).toContain('full garment')
    expect(buildGenerationPrompt(makeItem({ подкатегория: '', категория: 'Разное' }))).toContain(
      'clothing item',
    )
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

  it('force: true перегенерирует: старая AI-версия заменяется, снимок уходит (ADR-0006)', async () => {
    await items.create(makeItem({ id: 'вещь-1', idИзображений: ['ор-1', 'ai-old'] }))
    await images.addOriginal(makeImage('ор-1', 'вещь-1', 'оригинал', 'оригинал-байты'))
    await images.addAiVersion(
      makeImage('ai-old', 'вещь-1', 'ai', 'старая-ai', '2024-02-01T00:00:00.000Z'),
    )

    const generate = vi.fn(async () => new Blob(['новая-ai'], { type: 'image/jpeg' }))
    const outcome = await digitizeItem('вещь-1', {
      ...baseDeps(),
      generate,
      id: () => 'ai-new',
      force: true,
    })

    expect(outcome).toMatchObject({ way: 'ai', status: 'создано' })
    expect(generate).toHaveBeenCalledTimes(1)

    // Старая AI-версия заменена новой: ни двух AI-версий, ни осиротевшего id.
    const aiVersions = (await images.listByItem('вещь-1')).filter((i) => i.роль === 'ai')
    expect(aiVersions.map((i) => i.id)).toEqual(['ai-new'])
    expect(await images.get('ai-old')).toBeUndefined()

    // Перегенерация удаляет сырьевой снимок (источник «фото»), список изображений
    // вещи указывает только на свежую AI-версию.
    expect(await images.get('ор-1')).toBeUndefined()
    expect((await items.get('вещь-1'))?.idИзображений).toEqual(['ai-new'])
  })

  it('force: true создаёт AI-версию, даже если её ещё не было', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await images.addOriginal(makeImage('ор-1', 'вещь-1', 'оригинал', 'orig'))
    const generate = vi.fn(async () => new Blob(['ai'], { type: 'image/jpeg' }))

    const outcome = await digitizeItem('вещь-1', {
      ...baseDeps(),
      generate,
      id: () => 'ai-1',
      force: true,
    })

    expect(outcome).toMatchObject({ way: 'ai', status: 'создано' })
    expect(generate).toHaveBeenCalledTimes(1)
    expect(await images.get('ai-1')).toBeDefined()
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

describe('i2i-оцифровка (D13)', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
    window.localStorage.clear()
    saveAccessToken('test-token')
  })

  afterEach(async () => {
    clearAccessToken()
    await closeDb()
    await deleteDB(DB_NAME)
  })

  /**
   * Мок асинхронного контракта воркера (ADR-0006): `POST /generate` → 202 с
   * `taskId`, `GET /generate/{id}` → сразу `SUCCEEDED`, скачивание → байты.
   * Первый вызов в цепочке — всегда создание, по нему и судят тесты.
   */
  function asyncGenerationFetch() {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      calls.push({ url: u, init })
      if (u.endsWith('/generate') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ taskId: 'task-1', status: 'PENDING', costRub: 4, model: 'nano' }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        )
      }
      if (u.includes('/generate/task-1/image')) {
        return new Response(new Blob(['ai'], { type: 'image/jpeg' }), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      }
      return new Response(JSON.stringify({ taskId: 'task-1', status: 'SUCCEEDED', costRub: 4 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  it('среда без читаемого Blob деградирует в текстовую генерацию с предупреждением', async () => {
    await items.create(makeItem({ id: 'i2i-мёртвый' }))
    await images.addOriginal(makeImage('ор-2', 'i2i-мёртвый', 'оригинал', 'pack'))

    const { impl, calls } = asyncGenerationFetch()
    vi.stubGlobal('fetch', vi.fn(impl))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await digitizeItem('i2i-мёртвый', { id: () => 'ai-new' })
      const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
      expect(body.imageBase64).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('нечитаем'))
    } finally {
      warn.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('дефолтный путь шлёт redraw-промпт и сохраняет картинку после скачивания', async () => {
    await items.create(makeItem({ id: 'i2i-вещь', категория: 'Второй слой', подкатегория: 'худи' }))
    await images.addOriginal(makeImage('ор-1', 'i2i-вещь', 'оригинал', 'pack'))

    const { impl, calls } = asyncGenerationFetch()
    vi.stubGlobal('fetch', vi.fn(impl))
    try {
      const outcome = await digitizeItem('i2i-вещь', { id: () => 'ai-new' })
      expect(outcome.status).toBe('создано')
      expect(outcome.way).toBe('ai')

      const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
      expect(body.prompt).toContain('redraw')
      expect(body.prompt).toContain('hoodie')
      expect(body.prompt).toContain('full garment')
      expect(body.prompt).not.toContain('colors:')
      // Метаданные вещи уходят воркеру для истории генераций (T22).
      expect(body).toMatchObject({
        itemId: 'i2i-вещь',
        title: 'Худи тестовое',
        category: 'Второй слой',
        subcategory: 'худи',
      })

      // Цепочка ADR-0006: создание → статус → скачивание отдельным запросом.
      expect(calls.map((c) => c.url)).toEqual([
        expect.stringContaining('/generate'),
        expect.stringContaining('/generate/task-1'),
        expect.stringContaining('/generate/task-1/image'),
      ])
      expect(await images.get('ai-new')).toBeDefined()
      // Задача генерации после сохранения снята — висеть нечему.
      expect(await loadJob('i2i-вещь')).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('обрыв после 202 не теряет задачу: taskId и ключ остаются в IndexedDB', async () => {
    await items.create(makeItem({ id: 'обрыв' }))
    await images.addOriginal(makeImage('ор-о', 'обрыв', 'оригинал', 'pack'))

    const { impl, calls } = asyncGenerationFetch()
    // Статус падает сетью: прогон рвётся, но задача уже сохранена.
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (!u.endsWith('/generate') || init?.method !== 'POST') {
        throw new TypeError('Failed to fetch')
      }
      return impl(url, init)
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', vi.fn(flaky))

    try {
      const error = await digitizeItem('обрыв', { id: () => 'ai-1' }).catch((e: unknown) => e)
      expect(error).toMatchObject({ code: 'network' })

      const job = await loadJob('обрыв')
      expect(job).toMatchObject({ idВещи: 'обрыв', статус: 'ждёт', попытка: 1 })
      expect(job?.taskId).toBe('task-1')
      expect((job?.ключ ?? '').length).toBeGreaterThan(0)
      expect(calls).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
