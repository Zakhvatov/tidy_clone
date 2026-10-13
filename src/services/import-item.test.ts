import { describe, expect, it, vi } from 'vitest'

import { FALLBACK_SUB, FALLBACK_TOP } from '../domain/taxonomy'
import type { PhotoAnalyzer } from './wb/packshot'
import {
  MAX_ORIGINAL_BYTES,
  ОшибкаИмпортаВещи,
  createDraftFromLink,
  createDraftFromPhoto,
  fetchPhotoBlob,
  measureImage,
  собратьВещь,
  type ItemDraft,
} from './import-item'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function карточка(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nm_id: 111,
    imt_name: 'Платье тестовое',
    subj_name: 'Платья',
    subj_root_name: 'Одежда',
    nm_colors_names: 'синий',
    selling: { brand_name: 'Бренд' },
    media: { photo_count: 2 },
    ...overrides,
  }
}

const noPackshot: PhotoAnalyzer = async () => ({
  isPackshot: false,
  whiteness: 0,
  uniformity: 0,
  reason: 'не пакшот',
})

describe('import-item: вход «ссылка»', () => {
  it('выбирает пакшот по анализу и переносит атрибуты карточки', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('card.json')) return jsonResponse(200, карточка())
      if (url.includes('sellers.json')) return jsonResponse(200, {})
      if (url.endsWith('2.webp')) return new Response(new Uint8Array([0x32]), { headers: { 'content-type': 'image/webp' } })
      if (url.endsWith('1.webp')) return new Response(new Uint8Array([0x31]), { headers: { 'content-type': 'image/webp' } })
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch

    const analyze: PhotoAnalyzer = async (url) =>
      url.endsWith('2.webp')
        ? { isPackshot: true, whiteness: 0.9, uniformity: 0.9, reason: 'пакшот' }
        : { isPackshot: false, whiteness: 0, uniformity: 0, reason: 'нет' }

    const draft = await createDraftFromLink('https://www.wildberries.ru/catalog/111/detail.aspx', {
      fetchImpl,
      analyze,
      measure: async () => ({ ширина: 900, высота: 1200 }),
    })

    expect(draft.источник).toBe('ссылка')
    expect(draft.wbNmId).toBe(111)
    expect(draft.категория).toBe('Платья')
    expect(draft.подкатегория).toBe('платье')
    expect(draft.needsReview).toBe(false)
    expect(draft.packshot).toBe(true)
    expect(draft.название).toBe('Платье тестовое')
    expect(draft.бренд).toBe('Бренд')
    expect(draft.цвета).toEqual(['синий'])
    expect(draft.ширина).toBe(900)
    expect(draft.высота).toBe(1200)
    expect(draft.фото.size).toBeGreaterThan(0)
  })

  it('без пакшота честно берёт первое фото и помечает это', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('card.json')) return jsonResponse(200, карточка())
      if (url.includes('sellers.json')) return jsonResponse(200, {})
      return new Response(new Uint8Array([0x70]), { headers: { 'content-type': 'image/webp' } })
    }) as unknown as typeof fetch

    const draft = await createDraftFromLink('https://www.wildberries.ru/catalog/111/detail.aspx', {
      fetchImpl,
      analyze: noPackshot,
    })

    expect(draft.packshot).toBe(false)
    expect(draft.подкатегория).toBe('платье')
  })

  it('офлайн и мусорная ссылка дают понятные ошибки', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'onLine')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    try {
      const offline = await createDraftFromLink(
        'https://www.wildberries.ru/catalog/111/detail.aspx',
        { fetchImpl: vi.fn() as unknown as typeof fetch },
      ).catch((error: unknown) => error)
      expect(offline).toBeInstanceOf(ОшибкаИмпортаВещи)
      expect((offline as ОшибкаИмпортаВещи).code).toBe('network')
    } finally {
      if (original === undefined) {
        delete (navigator as { onLine?: unknown }).onLine
      } else {
        Object.defineProperty(navigator, 'onLine', original)
      }
    }

    const garbage = await createDraftFromLink('https://example.com/catalog/111/detail.aspx', {
      fetchImpl: vi.fn() as unknown as typeof fetch,
    }).catch((error: unknown) => error)
    expect(garbage).toBeInstanceOf(ОшибкаИмпортаВещи)
    expect((garbage as ОшибкаИмпортаВещи).code).toBe('link')
  })

  it('карточка без фото — понятная ошибка', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('card.json')) return jsonResponse(200, карточка({ media: { photo_count: 0 } }))
      if (url.includes('sellers.json')) return jsonResponse(200, {})
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch

    const error = await createDraftFromLink('https://www.wildberries.ru/catalog/111/detail.aspx', {
      fetchImpl,
      analyze: noPackshot,
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ОшибкаИмпортаВещи)
    expect((error as ОшибкаИмпортаВещи).code).toBe('photo')
  })
})

describe('import-item: вход «фото»', () => {
  it('при ошибке классификации отдаёт «Разное» и сохраняет возможность продолжить', async () => {
    const draft = await createDraftFromPhoto(new Blob(['x'], { type: 'image/jpeg' }), {
      classify: async () => {
        throw new Error('vision недоступен')
      },
      measure: async () => ({ ширина: 10, высота: 20 }),
    })

    expect(draft.источник).toBe('фото')
    expect(draft.категория).toBe(FALLBACK_TOP)
    expect(draft.подкатегория).toBe(FALLBACK_SUB)
    expect(draft.needsReview).toBe(true)
    expect(draft.фото.size).toBe(1)
  })

  it('отклоняет не изображение и слишком большой файл', async () => {
    const notImage = await createDraftFromPhoto(new Blob(['x'], { type: 'application/pdf' })).catch(
      (error: unknown) => error,
    )
    expect((notImage as ОшибкаИмпортаВещи).code).toBe('photo')

    const big = new Blob(['x'], { type: 'image/jpeg' })
    Object.defineProperty(big, 'size', { value: MAX_ORIGINAL_BYTES + 1 })
    const tooLarge = await createDraftFromPhoto(big).catch((error: unknown) => error)
    expect((tooLarge as ОшибкаИмпортаВещи).code).toBe('photo_too_large')
  })
})

describe('import-item: сеть и сборка домена', () => {
  it('fetchPhotoBlob различает сеть, HTTP-ошибку и пустое фото', async () => {
    const networkFail = (async () => {
      throw new TypeError('fail')
    }) as unknown as typeof fetch
    await expect(fetchPhotoBlob('https://x/1.webp', networkFail)).rejects.toMatchObject({
      code: 'network',
    })
    await expect(
      fetchPhotoBlob('https://x/1.webp', (async () => new Response('', { status: 500 })) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'photo' })
    await expect(
      fetchPhotoBlob(
        'https://x/1.webp',
        (async () => new Response(new Uint8Array(0))) as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'photo' })
  })

  it('без canvas размеры честно неизвестны (нули), а не выдуманы', async () => {
    expect(await measureImage(new Blob(['x'], { type: 'image/jpeg' }))).toEqual({
      ширина: 0,
      высота: 0,
    })
  })

  it('собирает Вещь с неизменяемым Оригиналом и пустым сезоном', () => {
    let counter = 0
    const id = () => `id-${(counter += 1)}`
    const черновик: ItemDraft = {
      источник: 'фото',
      название: '  Худи  ',
      категория: 'Второй слой',
      подкатегория: 'худи',
      needsReview: false,
      бренд: '',
      цвета: ['чёрный'],
      состав: [],
      фото: new Blob(['x'], { type: 'image/jpeg' }),
      ширина: 100,
      высота: 200,
      mime: 'image/jpeg',
    }

    const { вещь, оригинал } = собратьВещь(черновик, id)

    expect(вещь.id).toBe('id-1')
    expect(вещь.название).toBe('Худи')
    expect(вещь.сезон).toEqual([])
    expect(вещь.источник).toBe('фото')
    expect(вещь.idИзображений).toEqual(['id-2'])
    expect(оригинал.роль).toBe('оригинал')
    expect(оригинал.idВещи).toBe('id-1')
    expect(оригинал.ширина).toBe(100)
    expect(оригинал.датаСоздания).toBe(вещь.датаСоздания)
  })
})
