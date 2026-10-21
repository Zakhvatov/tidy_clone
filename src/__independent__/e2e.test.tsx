/**
 * НЕЗАВИСИМЫЕ тесты (не переиспользуют тесты проекта).
 *
 * Цель — не подтвердить, а сломать: сквозной путь через публичные API сервисов
 * и хранилища, негативные кейсы, проверка заявлений из docs/evidence по коду,
 * производительность. Сеть WB, vision-классификация и воркер генерации замоканы:
 * живая генерация недоступна по квоте (D6), локальная сеть режет тела (D4/D5) —
 * это ограничения среды, а не приложения.
 */

import 'fake-indexeddb/auto'

import { fireEvent, render, screen } from '@testing-library/react'
import { deleteDB, openDB } from 'idb'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '../app/App'
import { FALLBACK_SUB, FALLBACK_TOP, subcategoriesOf, TAXONOMY, topCategories } from '../domain/taxonomy'
import type { ImageRole, Изображение, Образ, Season, Вещь } from '../domain/types'
import { isDictionaryConsistent, knownPairs, mapWbCategory } from '../domain/wb-taxonomy'
import { digitizeItem, digitizePackshot } from '../services/digitize'
import {
  MAX_ORIGINAL_BYTES,
  createDraftFromLink,
  createDraftFromPhoto,
  собратьВещь,
  type ItemDraft,
} from '../services/import-item'
import { TidyApiError } from '../services/tidy-api'
import { groupByTopCategory, loadWardrobe, preferredImage } from '../services/wardrobe'
import { analyzeFrame, pickBestPhoto, type FrameData, type PackshotAnalysis } from '../services/wb/packshot'
import { MAX_BASKET } from '../services/wb/card'
import { closeDb, DB_NAME, DB_VERSION, getDb, upgrade, type WardrobeDB } from '../storage/db'
import { ОшибкаВещьВОбразе, ОшибкаОригиналНеизменяем } from '../storage/errors'
import * as images from '../storage/images'
import * as items from '../storage/items'
import * as outfits from '../storage/outfits'

// ---------------------------------------------------------------------------
// Фикстуры и моки (полностью свои)
// ---------------------------------------------------------------------------

const PACKSHOT: PackshotAnalysis = { isPackshot: true, whiteness: 0.9, uniformity: 0.9, reason: 'pack' }
const MODEL: PackshotAnalysis = { isPackshot: false, whiteness: 0, uniformity: 0.2, reason: 'model' }

function iso(offsetSeconds = 0): string {
  return new Date(Date.UTC(2024, 0, 1, 0, 0, offsetSeconds)).toISOString()
}

function makeItem(overrides: Partial<Вещь> = {}): Вещь {
  return {
    id: 'вещь-1',
    название: 'Худи',
    категория: 'Второй слой',
    подкатегория: 'худи',
    цвета: [],
    состав: [],
    сезон: [],
    бренд: '',
    источник: 'фото',
    датаСоздания: iso(),
    датаОбновления: iso(),
    idИзображений: [],
    ...overrides,
  }
}

function makeImage(
  id: string,
  idВещи: string,
  роль: ImageRole,
  tag: string,
  датаСоздания = iso(),
): Изображение {
  const blob = new Blob([tag], { type: 'image/png' }) as Blob & { __tag?: string }
  blob.__tag = tag
  return { id, idВещи, роль, blob, ширина: 4, высота: 4, mime: 'image/png', датаСоздания }
}

function makeOutfit(id: string, сезон: Season, idВещей: string[]): Образ {
  return {
    id,
    название: `Образ ${id}`,
    сезон,
    элементы: idВещей.map((idВещи, index) => ({
      idВещи,
      позиция: { x: index, y: index },
      масштаб: 1,
      zПорядок: index,
    })),
    датаСоздания: iso(),
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function photoResponse(bytes: number[]): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/webp' } })
}

interface WbNetConfig {
  /** null — 404 (карточки нет). */
  card?: (nm: number) => Record<string, unknown> | null
  photo?: (nm: number, index: number) => Response
  onCardRequest?: () => void
}

/** Мок сети WB: разбирает URL и отдаёт card/sellers/фото как реальный лоадер. */
function wbNet(config: WbNetConfig): typeof fetch {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const card = url.match(/\/(\d+)\/info\/ru\/card\.json$/)
    if (card !== null) {
      config.onCardRequest?.()
      const body = config.card?.(Number(card[1])) ?? null
      return body === null ? new Response('no card', { status: 404 }) : jsonResponse(200, body)
    }
    const photo = url.match(/\/(\d+)\/images\/big\/(\d+)\.webp$/)
    if (photo !== null) {
      return config.photo?.(Number(photo[1]), Number(photo[2])) ?? new Response('no photo', { status: 404 })
    }
    if (url.endsWith('/info/sellers.json')) {
      return jsonResponse(200, { supplierName: 'ООО Тест' })
    }
    return new Response('not found', { status: 404 })
  })
  return impl as unknown as typeof fetch
}

function cardJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nm_id: 16020837,
    imt_name: 'Футболка тестовая',
    subj_name: 'Футболки',
    subj_root_name: 'Одежда',
    nm_colors_names: 'белый, синий',
    selling: { brand_name: 'Тестовый бренд' },
    media: { photo_count: 2 },
    options: [{ name: 'Состав', value: 'хлопок 100%' }],
    ...overrides,
  }
}

const measure = async (): Promise<{ ширина: number; высота: number }> => ({ ширина: 1200, высота: 1600 })

async function persistDraft(draft: ItemDraft): Promise<{ вещь: Вещь; оригинал: Изображение }> {
  const собранное = собратьВещь(draft)
  await items.create(собранное.вещь)
  await images.addOriginal(собранное.оригинал)
  return собранное
}

/** Вещь с оригиналом — минимальная заготовка для оцифровки. */
async function seedItem(id: string, название = id): Promise<Вещь> {
  const вещь = makeItem({ id, название })
  await items.create(вещь)
  await images.addOriginal(makeImage(`${id}-orig`, id, 'оригинал', `orig-${id}`))
  return вещь
}

function uniqueAiIds(): () => string {
  let n = 0
  return () => `ai-${++n}`
}

const okGenerate = async (): Promise<Blob> => new Blob(['ai-bytes'], { type: 'image/jpeg' })

/** Сборка синтетического кадра RGBA для детектора пакшота. */
function frame(
  width: number,
  height: number,
  at: (x: number, y: number) => readonly [number, number, number],
): FrameData {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = at(x, y)
      const i = (y * width + x) * 4
      pixels[i] = r
      pixels[i + 1] = g
      pixels[i + 2] = b
      pixels[i + 3] = 255
    }
  }
  return { width, height, pixels }
}

// ---------------------------------------------------------------------------
// Сквозной путь
// ---------------------------------------------------------------------------

describe('НЕЗАВИСИМО: сквозной путь ссылка/фото → вырез → AI-версия → образ → перезапуск', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  afterEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('проходит весь путь; Оригинал ссылки хранится, сырые снимки уходят (ADR-0006)', async () => {
    // 1. Вещь по ссылке WB: 2 фото, пакшот — второе. Сеть замокана.
    const fetchImpl = wbNet({
      card: () => cardJson(),
      photo: (_nm, index) => photoResponse(index === 1 ? [1] : [1, 2, 3]),
    })
    const analyze = vi.fn(async (url: string) => (url.endsWith('2.webp') ? PACKSHOT : MODEL))
    const draftСсылка = await createDraftFromLink(
      'https://www.wildberries.ru/catalog/16020837/detail.aspx',
      { fetchImpl, analyze, measure },
    )

    expect(draftСсылка).toMatchObject({
      источник: 'ссылка',
      wbNmId: 16020837,
      категория: 'Верх',
      подкатегория: 'футболка',
      needsReview: false,
      packshot: true,
      бренд: 'Тестовый бренд',
      цвета: ['белый', 'синий'],
      состав: ['хлопок 100%'],
    })
    // Выбрано именно фото-пакшот (2-е), а не первое.
    expect(draftСсылка.фото.size).toBe(3)
    const A = await persistDraft(draftСсылка)
    expect(A.вещь.категория).toBe('Верх')
    expect(A.оригинал.роль).toBe('оригинал')

    // 2. Вещь по фото: категорию даёт vision (замокан).
    const classify = vi.fn(async () => ({
      top: 'Обувь',
      sub: 'кроссовки',
      confidence: 0.93,
      needsReview: false,
    }))
    const draftФото = await createDraftFromPhoto(new Blob(['photo'], { type: 'image/jpeg' }), {
      classify,
      measure,
    })
    expect(draftФото).toMatchObject({ источник: 'фото', категория: 'Обувь', подкатегория: 'кроссовки' })
    const B = await persistDraft(draftФото)

    // 3. Точный вырез пакшота для A. Оригинал обязан остаться прежним.
    const оригиналДо = await images.get(A.оригинал.id)
    const вырез = await digitizePackshot(A.вещь.id, {
      measure,
      now: () => iso(100),
      id: () => 'вырез-A',
      cutout: async () => ({
        blob: new Blob(['cut'], { type: 'image/png' }),
        suspicious: false,
        transparentRatio: 0.42,
      }),
    })
    expect(вырез).toMatchObject({ way: 'вырез', status: 'создано' })
    expect((await images.get('вырез-A'))?.роль).toBe('вырез')
    expect(await images.get(A.оригинал.id)).toEqual(оригиналДо)

    // 4. Ещё три вещи — чтобы получился образ из 5.
    const C = await persistDraft(
      await createDraftFromPhoto(new Blob(['c'], { type: 'image/jpeg' }), {
        classify: async () => ({ top: 'Низ', sub: 'джинсы', confidence: 0.8, needsReview: false }),
        measure,
      }),
    )
    const D = await persistDraft(
      await createDraftFromPhoto(new Blob(['d'], { type: 'image/jpeg' }), {
        classify: async () => ({ top: 'Аксессуары', sub: 'сумка', confidence: 0.7, needsReview: false }),
        measure,
      }),
    )
    const E = await persistDraft(
      await createDraftFromPhoto(new Blob(['e'], { type: 'image/jpeg' }), {
        classify: async () => ({ top: 'Платья', sub: 'платье', confidence: 0.7, needsReview: false }),
        measure,
      }),
    )
    const все = [A, B, C, D, E]

    // 5. AI-версии для B–E — явными действиями, как кнопка «Сделать AI-версию».
    // A уже с вырезом: её не трогаем.
    const снимкиДо = new Map<string, Изображение | undefined>()
    for (const { вещь, оригинал } of все) снимкиДо.set(вещь.id, await images.get(оригинал.id))

    const generate = vi.fn(okGenerate)
    const nextId = uniqueAiIds()
    for (const { вещь } of [B, C, D, E]) {
      await digitizeItem(вещь.id, {
        generate,
        measure,
        now: () => iso(200),
        id: nextId,
      })
    }
    expect(generate).toHaveBeenCalledTimes(4)

    // A — из ссылки: Оригинал хранится (ADR-0006 §4 касается только «фото»).
    expect(await images.get(A.оригинал.id)).toEqual(снимкиДо.get(A.вещь.id))
    // У B–E сырые снимки удалены после успеха — остались только AI-версии.
    for (const { вещь, оригинал } of [B, C, D, E]) {
      expect(await images.get(оригинал.id)).toBeUndefined()
      expect((await items.get(вещь.id))?.idИзображений).toHaveLength(1)
    }
    for (const { вещь } of [B, C, D, E]) {
      const роли = (await images.listByItem(вещь.id)).map((i) => i.роль)
      expect(роли).toContain('ai')
    }
    expect(new Set((await images.listByItem(A.вещь.id)).map((i) => i.роль))).toEqual(
      new Set(['оригинал', 'вырез']),
    )

    // 6. Образ из 5 вещей.
    await outfits.create(makeOutfit('образ-1', 'демисезон', все.map(({ вещь }) => вещь.id)))

    // 7. «Перезапуск приложения»: закрыть и заново открыть БД.
    await closeDb()

    expect(await items.count()).toBe(5)
    const записи = await loadWardrobe()
    expect(записи).toHaveLength(5)
    expect(await outfits.list()).toHaveLength(1)
    expect((await outfits.get('образ-1'))?.элементы).toHaveLength(5)

    // Правило сетки (D9): AI важнее выреза; вырез важнее оригинала.
    const поВещи = new Map(записи.map((entry) => [entry.вещь.id, entry]))
    for (const { вещь } of [B, C, D, E]) {
      const entry = поВещи.get(вещь.id)
      expect(preferredImage(вещь, entry?.изображения ?? [])?.роль).toBe('ai')
    }
    expect(preferredImage(A.вещь, поВещи.get(A.вещь.id)?.изображения ?? [])?.роль).toBe('вырез')

    // Секции ADR-0004 собираются и не теряют вещи.
    const секции = groupByTopCategory(записи)
    expect(секции.reduce((сумма, секция) => сумма + секция.количество, 0)).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Негативные кейсы
// ---------------------------------------------------------------------------

describe('НЕЗАВИСИМО: негативные кейсы', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  afterEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('мусорная ссылка и чужой домен отклоняются как «не ссылка»', async () => {
    const fetchImpl = wbNet({})
    for (const мусор of [
      '',
      'просто текст',
      'https://example.com/catalog/123/detail.aspx',
      'https://wildberries.ru.evil.com/catalog/123/detail.aspx',
      'https://www.wildberries.ru/catalog/detail.aspx',
    ]) {
      await expect(createDraftFromLink(мусор, { fetchImpl })).rejects.toMatchObject({ code: 'link' })
    }
  })

  it('несуществующий nmId: 404 на всех лоадерах → not_found, перебран весь диапазон 1..MAX_BASKET', async () => {
    let cardRequests = 0
    const fetchImpl = wbNet({ card: () => null, onCardRequest: () => (cardRequests += 1) })
    await expect(
      createDraftFromLink('https://www.wildberries.ru/catalog/99999999/detail.aspx', { fetchImpl }),
    ).rejects.toMatchObject({ code: 'not_found' })
    // Честный перебор: все существующие лоадеры 01..MAX_BASKET (T5-fix).
    expect(cardRequests).toBe(MAX_BASKET)
  })

  it('карточка без фото отклоняется понятной ошибкой', async () => {
    const fetchImpl = wbNet({ card: () => cardJson({ media: { photo_count: 0 } }) })
    await expect(
      createDraftFromLink('https://www.wildberries.ru/catalog/16020837/detail.aspx', {
        fetchImpl,
        measure,
      }),
    ).rejects.toMatchObject({ code: 'photo' })
  })

  it('карточка без subj_name не падает и уходит в «Разное»', async () => {
    const fetchImpl = wbNet({
      card: () => cardJson({ subj_name: undefined, subj_root_name: undefined, media: { photo_count: 1 } }),
      photo: () => photoResponse([1]),
    })
    const draft = await createDraftFromLink('https://www.wildberries.ru/catalog/16020837/detail.aspx', {
      fetchImpl,
      analyze: async () => MODEL,
      measure,
    })
    expect(draft).toMatchObject({ категория: FALLBACK_TOP, подкатегория: FALLBACK_SUB, needsReview: true })
  })

  it('фото больше 30 МБ отклоняется без сети и без классификации', async () => {
    const big = new File([new Uint8Array([1])], 'big.jpg', { type: 'image/jpeg' })
    Object.defineProperty(big, 'size', { value: MAX_ORIGINAL_BYTES + 1 })
    const classify = vi.fn()
    await expect(createDraftFromPhoto(big, { classify })).rejects.toMatchObject({
      code: 'photo_too_large',
    })
    expect(classify).not.toHaveBeenCalled()
  })

  it('скачанное по ссылке фото больше 30 МБ тоже отклоняется', async () => {
    const bigBlob = new Blob([new Uint8Array([1])], { type: 'image/webp' })
    Object.defineProperty(bigBlob, 'size', { value: MAX_ORIGINAL_BYTES + 1 })
    const fetchImpl = wbNet({
      card: () => cardJson({ media: { photo_count: 1 } }),
      photo: () => ({ ok: true, status: 200, blob: async () => bigBlob }) as unknown as Response,
    })
    await expect(
      createDraftFromLink('https://www.wildberries.ru/catalog/16020837/detail.aspx', {
        fetchImpl,
        analyze: async () => MODEL,
        measure,
      }),
    ).rejects.toMatchObject({ code: 'photo_too_large' })
  })

  it('нет сети (navigator.onLine=false) → понятная ошибка network', async () => {
    const оригинал = navigator.onLine
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    try {
      await expect(
        createDraftFromLink('https://www.wildberries.ru/catalog/16020837/detail.aspx'),
      ).rejects.toMatchObject({ code: 'network' })
    } finally {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: оригинал })
    }
  })

  it('сбой воркера во время оцифровки: 401/429/502 — Оригинал цел, AI не создан', async () => {
    for (const ошибка of [
      new TidyApiError('unauthorized', '401', { status: 401 }),
      new TidyApiError('rate_limited', '429', { status: 429 }),
      new TidyApiError('server', '502', { status: 502 }),
    ]) {
      await closeDb()
      await deleteDB(DB_NAME)
      const вещь = await seedItem(`фейл-${ошибка.code}`)
      const оригиналДо = await images.get(`${вещь.id}-orig`)
      await expect(
        digitizeItem(вещь.id, {
          generate: async () => {
            throw ошибка
          },
          measure,
        }),
      ).rejects.toBeTruthy()
      expect(await images.get(`${вещь.id}-orig`)).toEqual(оригиналДо)
      expect((await images.listByItem(вещь.id)).filter((i) => i.роль === 'ai')).toHaveLength(0)
    }
  })

  it('вещь из образа удалить нельзя — понятная ошибка, вещь на месте', async () => {
    await seedItem('в-образе')
    await outfits.create(makeOutfit('образ-1', 'зима', ['в-образе']))
    await expect(items.remove('в-образе')).rejects.toBeInstanceOf(ОшибкаВещьВОбразе)
    expect(await items.get('в-образе')).toBeDefined()
    expect((await images.listByItem('в-образе')).length).toBeGreaterThan(0)
  })

  it('Оригинал нельзя удалить и нельзя перезаписать', async () => {
    await seedItem('в')
    await expect(images.removeNonOriginal('в-orig')).rejects.toBeInstanceOf(ОшибкаОригиналНеизменяем)
    await expect(images.addOriginal(makeImage('в-orig', 'в', 'оригинал', 'orig'))).rejects.toBeTruthy()
    expect((await images.get('в-orig'))?.роль).toBe('оригинал')
    expect((await images.listByItem('в')).filter((i) => i.роль === 'оригинал')).toHaveLength(1)
  })

  it('повторный импорт той же ссылки создаёт отдельную вещь и не портит прежнюю', async () => {
    const fetchImpl = wbNet({ card: () => cardJson({ media: { photo_count: 1 } }), photo: () => photoResponse([1]) })
    const ссылка = 'https://www.wildberries.ru/catalog/16020837/detail.aspx'
    const первая = await persistDraft(await createDraftFromLink(ссылка, { fetchImpl, analyze: async () => MODEL, measure }))
    const вторая = await persistDraft(await createDraftFromLink(ссылка, { fetchImpl, analyze: async () => MODEL, measure }))

    expect(вторая.вещь.id).not.toBe(первая.вещь.id)
    expect(await items.count()).toBe(2)
    expect(await images.listByItem(первая.вещь.id)).toHaveLength(1)
    expect(await images.listByItem(вторая.вещь.id)).toHaveLength(1)
    expect((await items.get(первая.вещь.id))?.wbNmId).toBe(16020837)
  })

  it('ДЕФЕКТ 3 (исправлено): сетевой сбой при загрузке карточки — это network, а не «товар не найден»', async () => {
    // `fetch` всегда бросает, `navigator.onLine` при этом истинно (Wi-Fi есть, DNS/сервер нет).
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(
      createDraftFromLink('https://www.wildberries.ru/catalog/16020837/detail.aspx', { fetchImpl }),
    ).rejects.toMatchObject({ code: 'network' })
    // А несуществующий товар (404 на всех лоадерах) — по-прежнему not_found: см. тест выше.
  })

  it('пустой гардероб: чтение и секции пусты', async () => {
    expect(await loadWardrobe()).toEqual([])
    expect(groupByTopCategory([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Проверка заявлений из evidence по коду
// ---------------------------------------------------------------------------

describe('НЕЗАВИСИМО: проверка evidence-заявлений', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  afterEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('детектор пакшота различает белый фон, серый, градиент и текст', () => {
    const W = 100
    const H = 100
    const border = 6
    const наРамке = (x: number, y: number): boolean =>
      x < border || x >= W - border || y < border || y >= H - border

    const white = frame(W, H, (x, y) => (наРамке(x, y) ? [255, 255, 255] : [255, 0, 0]))
    expect(analyzeFrame(white).isPackshot).toBe(true)

    const gray = analyzeFrame(frame(W, H, () => [128, 128, 128]))
    expect(gray.isPackshot).toBe(false)
    expect(gray.whiteness).toBe(0)

    const gradient = analyzeFrame(
      frame(W, H, (x) => {
        const v = Math.round((255 * x) / (W - 1))
        return [v, v, v]
      }),
    )
    expect(gradient.isPackshot).toBe(false)

    const сТекстом = analyzeFrame(
      frame(W, H, (x, y) => (наРамке(x, y) && (x + y) % 5 < 2 ? [20, 20, 20] : [255, 255, 255])),
    )
    expect(сТекстом.whiteness).toBeLessThan(0.8)
    expect(сТекстом.isPackshot).toBe(false)

    // ~15% тёмного на рамке: белизна ~0.85 — детектор всё ещё считает это пакшотом.
    const почтиБелый = analyzeFrame(
      frame(W, H, (x, y) => (наРамке(x, y) && y < border && x < 56 ? [10, 10, 10] : [250, 250, 250])),
    )
    expect(почтиБелый.whiteness).toBeGreaterThanOrEqual(0.8)
    expect(почтиБелый.isPackshot).toBe(true)

    expect(analyzeFrame({ width: 0, height: 0, pixels: new Uint8ClampedArray(0) }).isPackshot).toBe(false)
  })

  it('pickBestPhoto берёт первое пакшотное фото, пропускает упавший анализ и честно сообщает об отсутствии', async () => {
    const выбранное = await pickBestPhoto(['a.webp', 'b.webp', 'c.webp'], async (url) => {
      if (url === 'a.webp') throw new Error('не декодировалось')
      return url === 'b.webp' ? PACKSHOT : MODEL
    })
    expect(выбранное).toMatchObject({ isPackshot: true, index: 1, url: 'b.webp' })

    const нет = await pickBestPhoto(['a.webp', 'b.webp'], async () => MODEL)
    expect(нет).toMatchObject({ isPackshot: false, index: -1, analyzed: 2 })
  })

  it('словарь таксономии согласован и переводит реальные строки WB', () => {
    expect(isDictionaryConsistent()).toBe(true)
    expect(knownPairs().length).toBeGreaterThan(100)

    expect(mapWbCategory('Одежда', 'Футболки')).toMatchObject({ top: 'Верх', sub: 'футболка' })
    expect(mapWbCategory('Одежда', 'Худи')).toMatchObject({ top: 'Второй слой', sub: 'худи' })
    expect(mapWbCategory('Обувь', 'Кроссовки')).toMatchObject({ top: 'Обувь', sub: 'кроссовки' })
    // Разговорный синоним.
    expect(mapWbCategory('Обувь', 'кроссы')).toMatchObject({ top: 'Обувь', sub: 'кроссовки' })
    // Неизвестное — «Разное» с предложением выбрать вручную.
    expect(mapWbCategory('Прочее', 'Носороги')).toMatchObject({
      top: FALLBACK_TOP,
      sub: FALLBACK_SUB,
      needsReview: true,
    })
    // Каждая пара словаря реально существует в таксономии.
    for (const pair of knownPairs()) {
      if (pair.top === FALLBACK_TOP) continue
      expect((TAXONOMY[pair.top as keyof typeof TAXONOMY] as readonly string[]).includes(pair.sub)).toBe(true)
    }
  })

  it('миграция с версии 1 сохраняет вещи, изображения и образы; стор queue убран (D16)', async () => {
    const db1 = await openDB<WardrobeDB>(DB_NAME, 1, { upgrade })
    await db1.add('items', makeItem({ id: 'v1', название: 'До миграции' }))
    await db1.add('images', makeImage('v1-orig', 'v1', 'оригинал', 'orig'))
    await db1.add('outfits', makeOutfit('v1-образ', 'зима', ['v1']))
    expect((db1.objectStoreNames as unknown as DOMStringList).contains('queue')).toBe(false)
    db1.close()

    const db2 = await getDb()
    expect(db2.version).toBe(DB_VERSION)
    // Очередь создавалась в v2 и удалена в v4; задачи генерации остаются.
    expect((db2.objectStoreNames as unknown as DOMStringList).contains('queue')).toBe(false)
    expect((db2.objectStoreNames as unknown as DOMStringList).contains('jobs')).toBe(true)
    expect((await db2.get('items', 'v1'))?.название).toBe('До миграции')
    expect(await db2.get('images', 'v1-orig')).toBeDefined()
    expect((await db2.get('outfits', 'v1-образ'))?.элементы).toHaveLength(1)
  })

  it('preferredImage: AI важнее выреза, вырез важнее оригинала, из AI — самая новая', () => {
    const вещь = makeItem({ id: 'в' })
    const оригинал = makeImage('о', 'в', 'оригинал', 'o', iso(0))
    const aiСтарая = makeImage('а1', 'в', 'ai', 'a1', iso(1))
    const aiНовая = makeImage('а2', 'в', 'ai', 'a2', iso(2))
    const вырез = makeImage('в1', 'в', 'вырез', 'c', iso(3))

    // Вырез пакшота виден в сетке и коллаже, когда AI-версии ещё нет.
    expect(preferredImage(вещь, [оригинал, вырез])?.роль).toBe('вырез')
    expect(preferredImage(вещь, [оригинал, aiСтарая, aiНовая, вырез])?.id).toBe('а2')
    expect(preferredImage(вещь, [оригинал])?.роль).toBe('оригинал')
    expect(preferredImage(вещь, [])).toBeUndefined()
    // Чужое изображение не подставляется.
    expect(preferredImage(вещь, [makeImage('ч', 'другая', 'ai', 'x')])).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// UI: правило изображения и отсутствие пометок об AI в сетке
// ---------------------------------------------------------------------------

describe('НЕЗАВИСИМО: сетка (UI) — AI-версия в карточке и нет пометок об AI', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn((blob: Blob) => `blob:${(blob as Blob & { __tag?: string }).__tag ?? 'нет'}`),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() })
  })

  afterEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('везде, где есть AI-версия, сетка показывает её и нигде не пишет «AI»', async () => {
    await items.create(makeItem({ id: 'в', название: 'Кроссовки', категория: 'Обувь', подкатегория: 'кроссовки' }))
    await images.addOriginal(makeImage('и-о', 'в', 'оригинал', 'orig'))
    await images.addAiVersion(makeImage('и-a', 'в', 'ai', 'ai-blob'))

    render(
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
      </MemoryRouter>,
    )

    const картинка = await screen.findByAltText('Кроссовки')
    expect(картинка).toHaveAttribute('src', 'blob:ai-blob')
    expect(screen.queryByText(/ai/i)).toBeNull()
  })

  it('пустой гардероб во всех экранах: подсказка и переход на добавление', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Гардероб пуст')).toBeInTheDocument()
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByText(/ai/i)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// НАЙДЕННЫЕ ДЕФЕКТЫ — эти тесты НАМЕРЕННО падают, доказывая дефект
// ---------------------------------------------------------------------------

describe('НАЙДЕННЫЕ ДЕФЕКТЫ (регресс-тесты: дефекты исправлены, поведение закреплено)', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn((blob: Blob) => `blob:${(blob as Blob & { __tag?: string }).__tag ?? 'нет'}`),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() })
    // Генерация в UI больше не ходит без токена: устройство уже настроено.
    window.localStorage.setItem('tidy.accessToken', 'test-token')
  })

  afterEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('ДЕФЕКТ 1: из сетки нельзя открыть карточку вещи (клик ведёт на «/»)', async () => {
    await items.create(makeItem({ id: 'в', название: 'Кроссовки', категория: 'Обувь', подкатегория: 'кроссовки' }))
    await images.addOriginal(makeImage('и-о', 'в', 'оригинал', 'orig'))

    render(
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
      </MemoryRouter>,
    )

    const карточкаСетки = await screen.findByRole('button', { name: 'Кроссовки' })
    fireEvent.click(карточкаСетки)

    // Ожидание: открылась карточка вещи (её уникальная кнопка).
    expect(await screen.findByRole('button', { name: /^Сделать AI-версию · \d+ ₽$/ })).toBeInTheDocument()
  })

  it('ДЕФЕКТ 2 (исправлено): «Перегенерировать» реально запрашивает новую AI-версию', async () => {
    await seedItem('в')
    await images.addAiVersion(makeImage('ai-старый', 'в', 'ai', 'old', iso(0)))

    // Асинхронный контракт воркера (ADR-0006): 202 → статус → скачивание.
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/generate') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ taskId: 'task-e2e', status: 'PENDING', costRub: 4, model: 'nano' }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        )
      }
      if (u.includes('/generate/task-e2e/image')) {
        return new Response(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      }
      return new Response(JSON.stringify({ taskId: 'task-e2e', status: 'SUCCEEDED', costRub: 4 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MemoryRouter initialEntries={['/item/в']}>
        <AppRoutes />
      </MemoryRouter>,
    )

    // В карточке при наличии AI кнопка называется «Перегенерировать».
    const кнопка = await screen.findByRole('button', { name: /^Перегенерировать · \d+ ₽$/ })
    fireEvent.click(кнопка)

    expect(screen.queryByText(/Оцифровка недоступна/)).toBeNull()

    // Исправление: принудительный режим реально зовёт воркер...
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    // ...и AI-версия заменяется (а не плодится): ровно одна, и она новая, а не старая.
    await vi.waitFor(async () => {
      const ai = (await images.listByItem('в')).filter((i) => i.роль === 'ai')
      expect(ai).toHaveLength(1)
      expect(ai[0].id).not.toBe('ai-старый')
    })
  })
})

// ---------------------------------------------------------------------------
// Производительность
// ---------------------------------------------------------------------------

describe('НЕЗАВИСИМО: производительность', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  afterEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('50 вещей: чтение и группировка быстрые (свой замер, не из T13)', async () => {
    const tops = topCategories()
    for (let i = 0; i < 50; i += 1) {
      const top = tops[i % tops.length]
      const sub = subcategoriesOf(top)[0] ?? FALLBACK_SUB
      await items.create(makeItem({ id: `в-${i}`, название: `Вещь ${i}`, категория: top, подкатегория: sub }))
      await images.addOriginal(makeImage(`и-${i}`, `в-${i}`, 'оригинал', `tag-${i}`))
    }

    const t0 = performance.now()
    const записи = await loadWardrobe()
    const t1 = performance.now()
    const секции = groupByTopCategory(записи)
    const t2 = performance.now()

    const чтениеМс = t1 - t0
    const группировкаМс = t2 - t1
    console.log(
      `[independent perf] loadWardrobe: ${чтениеМс.toFixed(2)} мс, группировка: ${группировкаМс.toFixed(2)} мс`,
    )

    expect(записи).toHaveLength(50)
    expect(секции.reduce((s, x) => s + x.количество, 0)).toBe(50)
    expect(чтениеМс).toBeLessThan(300)
    expect(группировкаМс).toBeLessThan(100)
  })


})
