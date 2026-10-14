import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Изображение, Образ, ЭлементОбраза, Вещь } from '../domain/types'
import {
  BASE_ELEMENT_RATIO,
  COLLAGE_HEIGHT,
  COLLAGE_WIDTH,
  COVER_MAX_SIDE,
  MAX_SCALE,
  MIN_SCALE,
  coverSize,
  layoutElements,
  позицияПоУмолчанию,
  изменитьСлой,
  ограничитьМасштаб,
  renderOutfit,
} from './outfit-render'

/** Сторона квадрата элемента при масштабе 1 на каноническом холсте. */
const СТОРОНА = Math.min(COLLAGE_WIDTH, COLLAGE_HEIGHT) * BASE_ELEMENT_RATIO

function элемент(overrides: Partial<ЭлементОбраза> & { idВещи: string }): ЭлементОбраза {
  return { позиция: { x: 500, y: 625 }, масштаб: 1, zПорядок: 0, ...overrides }
}

describe('Раскладка коллажа (T16)', () => {
  it('возвращает элементы в порядке z-порядка — от нижнего слоя к верхнему', () => {
    const раскладка = layoutElements([
      элемент({ idВещи: 'в', zПорядок: 2 }),
      элемент({ idВещи: 'а', zПорядок: 0 }),
      элемент({ idВещи: 'б', zПорядок: 1 }),
    ])

    expect(раскладка.map((прямоугольник) => прямоугольник.idВещи)).toEqual(['а', 'б', 'в'])
  })

  it('центрирует элемент по позиции и задаёт квадрат по масштабу', () => {
    const [прямоугольник] = layoutElements([элемент({ idВещи: 'а' })])

    expect(прямоугольник.width).toBe(СТОРОНА)
    expect(прямоугольник.height).toBe(СТОРОНА)
    expect(прямоугольник.left).toBe(500 - СТОРОНА / 2)
    expect(прямоугольник.top).toBe(625 - СТОРОНА / 2)
  })

  it('умножает сторону на масштаб', () => {
    const [половинный] = layoutElements([элемент({ idВещи: 'а', масштаб: 0.5 })])
    expect(половинный.width).toBe(СТОРОНА * 0.5)

    const [двойной] = layoutElements([элемент({ idВещи: 'а', масштаб: 2 })])
    expect(двойной.width).toBe(СТОРОНА * 2)
  })

  it('зажимает масштаб в допустимый диапазон', () => {
    expect(ограничитьМасштаб(99)).toBe(MAX_SCALE)
    expect(ограничитьМасштаб(0.01)).toBe(MIN_SCALE)
    expect(ограничитьМасштаб(Number.NaN)).toBe(1)

    const [огромный] = layoutElements([элемент({ idВещи: 'а', масштаб: 99 })])
    // Даже при максимальном масштабе элемент не выходит за холст.
    expect(огромный.width).toBeLessThanOrEqual(COLLAGE_WIDTH)
    expect(огромный.height).toBeLessThanOrEqual(COLLAGE_HEIGHT)
  })

  it('не выпускает элемент за границы холста', () => {
    const [левый] = layoutElements([элемент({ idВещи: 'а', позиция: { x: -1000, y: -1000 } })])
    expect(левый.left).toBe(0)
    expect(левый.top).toBe(0)

    const [правый] = layoutElements([
      элемент({ idВещи: 'б', позиция: { x: 100000, y: 100000 } }),
    ])
    expect(правый.left).toBe(COLLAGE_WIDTH - правый.width)
    expect(правый.top).toBe(COLLAGE_HEIGHT - правый.height)
  })

  it('переставляет слои и перенормирует z-порядок в 0…n−1', () => {
    const базовые = [
      элемент({ idВещи: 'а', zПорядок: 0 }),
      элемент({ idВещи: 'б', zПорядок: 1 }),
      элемент({ idВещи: 'в', zПорядок: 2 }),
    ]
    const пары = (элементы: ЭлементОбраза[]) =>
      элементы.map((пункт) => [пункт.idВещи, пункт.zПорядок])

    expect(пары(изменитьСлой(базовые, 'а', 'выше'))).toEqual([
      ['б', 0],
      ['а', 1],
      ['в', 2],
    ])
    expect(пары(изменитьСлой(базовые, 'в', 'ниже'))).toEqual([
      ['а', 0],
      ['в', 1],
      ['б', 2],
    ])
    expect(пары(изменитьСлой(базовые, 'а', 'наверх'))).toEqual([
      ['б', 0],
      ['в', 1],
      ['а', 2],
    ])
    expect(пары(изменитьСлой(базовые, 'в', 'вниз'))).toEqual([
      ['в', 0],
      ['а', 1],
      ['б', 2],
    ])

    // Неизвестная вещь ничего не меняет.
    expect(изменитьСлой(базовые, 'нет-такой', 'наверх')).toEqual(базовые)
  })

  it('даёт новым вещам разные места внутри холста', () => {
    const позиции = [0, 1, 2, 3, 4].map((index) => позицияПоУмолчанию(index))
    const уникальные = new Set(позиции.map((позиция) => `${позиция.x},${позиция.y}`))
    expect(уникальные.size).toBe(5)

    for (const позиция of позиции) {
      expect(позиция.x).toBeGreaterThan(0)
      expect(позиция.x).toBeLessThan(COLLAGE_WIDTH)
      expect(позиция.y).toBeGreaterThan(0)
      expect(позиция.y).toBeLessThan(COLLAGE_HEIGHT)
    }
  })

  it('делает обложку с большой стороной 600 и пропорциями коллажа', () => {
    const размер = coverSize()

    expect(Math.max(размер.width, размер.height)).toBe(COVER_MAX_SIDE)
    expect(размер.width / размер.height).toBeCloseTo(COLLAGE_WIDTH / COLLAGE_HEIGHT, 2)
  })
})

function вещь(id: string): Вещь {
  const дата = '2024-01-01T00:00:00.000Z'
  return {
    id,
    название: id,
    категория: 'Верх',
    подкатегория: 'футболка',
    цвета: [],
    состав: [],
    сезон: [],
    бренд: '',
    источник: 'фото',
    датаСоздания: дата,
    датаОбновления: дата,
    idИзображений: [],
  }
}

function изображение(id: string, idВещи: string): Изображение {
  return {
    id,
    idВещи,
    роль: 'оригинал',
    blob: new Blob(['x'], { type: 'image/png' }),
    ширина: 100,
    высота: 100,
    mime: 'image/png',
    датаСоздания: '2024-01-01T00:00:00.000Z',
  }
}

describe('Рендер коллажа на canvas (T16)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('заливает подложку, рисует элементы в порядке слоёв и отдаёт PNG', async () => {
    const drawImage = vi.fn()
    const fillRect = vi.fn()
    const toBlob = vi.fn((callback: BlobCallback) => {
      callback(new Blob(['png'], { type: 'image/png' }))
    })
    const контекст = { fillStyle: '', fillRect, drawImage }
    const холст = { width: 0, height: 0, getContext: () => контекст, toBlob }
    vi.spyOn(document, 'createElement').mockReturnValue(холст as unknown as HTMLElement)
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() })),
    )

    const образ: Образ = {
      id: 'образ-рендер',
      название: 'Рендер',
      сезон: 'лето',
      элементы: [
        { idВещи: 'верх', позиция: { x: 800, y: 1000 }, масштаб: 1, zПорядок: 1 },
        { idВещи: 'низ', позиция: { x: 200, y: 200 }, масштаб: 1, zПорядок: 0 },
      ],
      датаСоздания: '2024-01-01T00:00:00.000Z',
    }

    const blob = await renderOutfit(
      образ,
      [вещь('низ'), вещь('верх')],
      [изображение('и-низ', 'низ'), изображение('и-верх', 'верх')],
      { background: '#F6F6F4' },
    )

    expect(контекст.fillStyle).toBe('#F6F6F4')
    expect(fillRect).toHaveBeenCalledWith(0, 0, COLLAGE_WIDTH, COLLAGE_HEIGHT)
    expect(drawImage).toHaveBeenCalledTimes(2)
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png')
    expect(blob.type).toBe('image/png')

    // Слой 0 рисуется раньше слоя 1: верхний элемент идёт вторым.
    const [первый, второй] = drawImage.mock.calls
    expect(первый?.[2]).toBeLessThan(второй?.[2] as number)
  })

  it('для пакшота без AI-версии в коллаж идёт вырез, а не оригинал (D9)', async () => {
    const drawImage = vi.fn()
    const toBlob = vi.fn((callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })))
    const контекст = { fillStyle: '', fillRect: vi.fn(), drawImage }
    const холст = { width: 0, height: 0, getContext: () => контекст, toBlob }
    vi.spyOn(document, 'createElement').mockReturnValue(холст as unknown as HTMLElement)

    const оригинал = {
      ...изображение('и-ориг', 'вещь-1'),
      blob: new Blob(['original-bytes'], { type: 'image/png' }),
    }
    const вырез = {
      ...изображение('и-вырез', 'вещь-1'),
      роль: 'вырез' as const,
      blob: new Blob(['cutout-bytes'], { type: 'image/png' }),
    }
    const загрузки = vi.fn(async (blob: Blob) => {
      void blob
      return { width: 100, height: 100, close: vi.fn() }
    })
    vi.stubGlobal('createImageBitmap', загрузки)

    const образ: Образ = {
      id: 'образ-вырез',
      название: 'Вырез',
      сезон: 'лето',
      элементы: [{ idВещи: 'вещь-1', позиция: { x: 500, y: 625 }, масштаб: 1, zПорядок: 0 }],
      датаСоздания: '2024-01-01T00:00:00.000Z',
    }

    await renderOutfit(образ, [вещь('вещь-1')], [оригинал, вырез])

    // В коллаж попал именно вырез — первый и единственный вызов создания bitmap.
    expect(загрузки).toHaveBeenCalledTimes(1)
    const источник = загрузки.mock.calls[0]?.[0]
    // В коллаж попал именно вырез — тот самый Blob, а не Оригинал.
    expect(источник).toBe(вырез.blob)
  })
})
