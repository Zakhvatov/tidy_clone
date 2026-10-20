import 'fake-indexeddb/auto'

import { fireEvent, render, screen, within } from '@testing-library/react'
import { deleteDB } from 'idb'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_SUB, subcategoriesOf, topCategories } from '../../domain/taxonomy'
import type { ImageRole, Изображение, Вещь } from '../../domain/types'
import { loadWardrobe } from '../../services/wardrobe'
import { DB_NAME, closeDb } from '../../storage/db'
import * as images from '../../storage/images'
import * as items from '../../storage/items'
import { AppRoutes } from '../App'

// `loadWardrobe` подменяется на наблюдаемый мок: тесту ошибки нужно один раз
// отклонить чтение, а остальные тесты должны работать с настоящей реализацией.
vi.mock('../../services/wardrobe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/wardrobe')>()
  return { ...actual, loadWardrobe: vi.fn(actual.loadWardrobe) }
})

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
  tag: string,
): Изображение {
  const blob = new Blob([tag], { type: 'image/png' }) as Blob & { __tag?: string }
  blob.__tag = tag
  return { id, idВещи, роль, blob, ширина: 512, высота: 512, mime: 'image/png', датаСоздания }
}

/** Canvas-заглушка: `getContext` не реализован в jsdom, анализ честно падает. */
class FakeOffscreenCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  getContext(): null {
    return null
  }
}

/** Мок сети классификации фото (ссылочный вход убран, ADR-0006). */
function classifyFetch(категория: string, подкатегория: string): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/classify')) {
      return new Response(
        JSON.stringify({ category: категория, subcategory: подкатегория, confidence: 0.9 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

/** jsdom не даёт input.files напрямую — подсовываем File через change-событие. */
function uploadPhoto(input: HTMLInputElement, имя: string) {
  fireEvent.change(input, { target: { files: [new File(['image-bytes'], имя, { type: 'image/jpeg' })] } })
}

function renderWardrobe() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

/** Создаёт по `counts[c]` вещей в каждой верхней категории ADR-0004. */
async function seedByCounts(counts: readonly number[]): Promise<void> {
  const tops = topCategories()
  let index = 0
  for (let c = 0; c < tops.length; c += 1) {
    const top = tops[c]
    const подкатегория = subcategoriesOf(top)[0] ?? FALLBACK_SUB
    for (let n = 0; n < (counts[c] ?? 0); n += 1) {
      const дата = new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString()
      await items.create(
        makeItem({
          id: `вещь-${index}`,
          название: `Вещь ${index}`,
          категория: top,
          подкатегория,
          датаСоздания: дата,
          датаОбновления: дата,
        }),
      )
      index += 1
    }
  }
}

describe('Экран гардероба (T13)', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn((blob: Blob) => `blob:${(blob as Blob & { __tag?: string }).__tag ?? 'нет'}`),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('пустой гардероб: на / сама форма добавления (O7), фото кладёт вещь в сетку', async () => {
    // ADR-0006: вход по ссылке убран — на / только загрузка своего фото.
    vi.stubGlobal('fetch', classifyFetch('Второй слой', 'худи'))
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    renderWardrobe()

    expect(await screen.findByText('Гардероб пуст')).toBeInTheDocument()
    expect(screen.queryByRole('region')).toBeNull()
    const фото = screen.getByLabelText('Загрузить фото') as HTMLInputElement

    uploadPhoto(фото, 'фото.jpg')
    await screen.findByRole('heading', { name: 'Без названия' })

    fireEvent.click(screen.getByRole('button', { name: 'Добавить в гардероб' }))
    await screen.findByText('Вещь сохранена. Сделать AI-версию?')
    fireEvent.click(screen.getByRole('button', { name: 'Добавить без AI-версии' }))

    expect(await screen.findByRole('region', { name: 'Второй слой' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Без названия' })).toBeInTheDocument()
    // Сетка заменила форму: поля ссылки на первом экране больше нет.
    expect(screen.queryByLabelText('Ссылка на товар')).toBeNull()
  })


  it('непустой гардероб: на / нет поля ссылки, есть сетка', async () => {
    await items.create(
      makeItem({ id: 'вещь-1', название: 'Худи', категория: 'Второй слой', подкатегория: 'худи' }),
    )
    renderWardrobe()

    expect(await screen.findByRole('region', { name: 'Второй слой' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Ссылка на товар')).toBeNull()
  })

  it('50 вещей: 8+1 секция, счётчики и порядок секций по ADR-0004', async () => {
    const counts = [7, 6, 6, 5, 5, 5, 5, 5, 6]
    await seedByCounts(counts)
    renderWardrobe()

    const regions = await screen.findAllByRole('region')
    expect(regions).toHaveLength(9)
    expect(regions.map((region) => region.getAttribute('aria-label'))).toEqual([
      ...topCategories(),
    ])

    regions.forEach((region, index) => {
      expect(within(region).getByText(String(counts[index]))).toBeInTheDocument()
      expect(within(region).getAllByRole('button')).toHaveLength(counts[index])
    })

    const кнопкиСетки = regions.flatMap((region) => within(region).getAllByRole('button'))
    expect(кнопкиСетки).toHaveLength(50)
  })

  it('вещь с AI-версией показывает AI, без неё — Оригинал (подставлен нужный blob)', async () => {
    await items.create(
      makeItem({ id: 'вещь-ai', название: 'С AI', категория: 'Обувь', подкатегория: 'кроссовки' }),
    )
    await items.create(
      makeItem({
        id: 'вещь-ориг',
        название: 'Только оригинал',
        категория: 'Обувь',
        подкатегория: 'ботинки',
      }),
    )
    await images.addOriginal(makeImage('и-1', 'вещь-ai', 'оригинал', '2024-01-01T00:00:00.000Z', 'orig-ai'))
    await images.addAiVersion(makeImage('и-2', 'вещь-ai', 'ai', '2024-01-02T00:00:00.000Z', 'ai'))
    await images.addOriginal(
      makeImage('и-3', 'вещь-ориг', 'оригинал', '2024-01-03T00:00:00.000Z', 'orig'),
    )

    renderWardrobe()

    expect(await screen.findByAltText('С AI')).toHaveAttribute('src', 'blob:ai')
    expect(screen.getByAltText('Только оригинал')).toHaveAttribute('src', 'blob:orig')
  })

  it('пакшот с вырезом и без AI: в сетке показывается вырез (D9)', async () => {
    await items.create(
      makeItem({ id: 'вещь-вырез', название: 'Пакшот', категория: 'Обувь', подкатегория: 'кроссовки' }),
    )
    await items.create(
      makeItem({ id: 'вещь-ai', название: 'С AI и вырезом', категория: 'Обувь', подкатегория: 'ботинки' }),
    )
    await images.addOriginal(makeImage('и-1', 'вещь-вырез', 'оригинал', '2024-01-01T00:00:00.000Z', 'orig-cut'))
    await images.addCutout(makeImage('и-2', 'вещь-вырез', 'вырез', '2024-01-02T00:00:00.000Z', 'cut'))
    await images.addOriginal(makeImage('и-3', 'вещь-ai', 'оригинал', '2024-01-03T00:00:00.000Z', 'orig-both'))
    await images.addCutout(makeImage('и-4', 'вещь-ai', 'вырез', '2024-01-04T00:00:00.000Z', 'cut-both'))
    await images.addAiVersion(makeImage('и-5', 'вещь-ai', 'ai', '2024-01-05T00:00:00.000Z', 'ai-both'))

    renderWardrobe()

    // Вырез подставляется только тогда, когда AI-версии нет.
    expect(await screen.findByAltText('Пакшот')).toHaveAttribute('src', 'blob:cut')
    expect(screen.getByAltText('С AI и вырезом')).toHaveAttribute('src', 'blob:ai-both')
  })

  it('в сетке нет слова «AI» и пометок об AI', async () => {
    await items.create(
      makeItem({ id: 'вещь-1', название: 'Кроссовки', категория: 'Обувь', подкатегория: 'кроссовки' }),
    )
    await images.addOriginal(makeImage('и-1', 'вещь-1', 'оригинал', '2024-01-01T00:00:00.000Z', 'orig'))
    await images.addAiVersion(makeImage('и-2', 'вещь-1', 'ai', '2024-01-02T00:00:00.000Z', 'ai'))

    renderWardrobe()

    expect(await screen.findByAltText('Кроссовки')).toBeInTheDocument()
    expect(screen.queryByText(/ai/i)).toBeNull()
  })

  it('внутри секции новые вещи идут первыми', async () => {
    await items.create(
      makeItem({
        id: 'старая',
        название: 'Старая',
        категория: 'Верх',
        подкатегория: 'футболка',
        датаСоздания: '2024-01-01T00:00:00.000Z',
      }),
    )
    await items.create(
      makeItem({
        id: 'новая',
        название: 'Новая',
        категория: 'Верх',
        подкатегория: 'топ',
        датаСоздания: '2024-06-01T00:00:00.000Z',
      }),
    )

    renderWardrobe()

    const region = await screen.findByRole('region', { name: 'Верх' })
    expect(within(region).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Новая',
      'Старая',
    ])
  })

  it('ошибка чтения из IndexedDB: понятное сообщение и повтор', async () => {
    await items.create(
      makeItem({ id: 'вещь-1', название: 'Худи', категория: 'Второй слой', подкатегория: 'худи' }),
    )
    vi.mocked(loadWardrobe).mockRejectedValueOnce(new Error('IndexedDB недоступен'))

    renderWardrobe()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось прочитать гардероб. Попробуйте ещё раз',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))

    expect(await screen.findByRole('region', { name: 'Второй слой' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Худи' })).toBeInTheDocument()
  })

  it('фильтр по верхней категории даёт плоский результат со счётчиком, сброс возвращает полки', async () => {
    await items.create(
      makeItem({ id: 'в-худи', название: 'Худи', категория: 'Второй слой', подкатегория: 'худи' }),
    )
    await items.create(
      makeItem({
        id: 'в-кроссовки',
        название: 'Кроссовки',
        категория: 'Обувь',
        подкатегория: 'кроссовки',
      }),
    )

    renderWardrobe()

    expect(await screen.findByRole('region', { name: 'Второй слой' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Обувь' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Обувь' }))

    expect(await screen.findByText('Найдено 1')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Результаты' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Второй слой' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Кроссовки' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Худи' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Сбросить фильтры' }))

    expect(await screen.findByRole('region', { name: 'Второй слой' })).toBeInTheDocument()
    expect(screen.queryByText('Найдено 1')).toBeNull()
  })

  it('чипы подкатегорий зависят от выбранной верхней категории', async () => {
    await items.create(
      makeItem({ id: 'в-худи', название: 'Худи', категория: 'Второй слой', подкатегория: 'худи' }),
    )
    await items.create(
      makeItem({ id: 'в-футболка', название: 'Футболка', категория: 'Верх', подкатегория: 'футболка' }),
    )

    renderWardrobe()

    expect(screen.queryByRole('group', { name: 'Подкатегории' })).toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: 'Верх' }))

    const под = await screen.findByRole('group', { name: 'Подкатегории' })
    expect(within(под).getByRole('button', { name: 'футболка' })).toBeInTheDocument()
    expect(within(под).queryByRole('button', { name: 'худи' })).toBeNull()

    fireEvent.click(within(под).getByRole('button', { name: 'футболка' }))

    expect(await screen.findByText('Найдено 1')).toBeInTheDocument()
  })

  it('фильтры по цвету и сезону комбинируются по «И»', async () => {
    await items.create(
      makeItem({
        id: 'в-пальто',
        название: 'Пальто',
        категория: 'Верхняя одежда',
        подкатегория: 'пальто',
        цвета: ['чёрный'],
        сезон: ['зима'],
      }),
    )
    await items.create(
      makeItem({
        id: 'в-футболка',
        название: 'Футболка',
        категория: 'Верх',
        подкатегория: 'футболка',
        цвета: ['чёрный'],
        сезон: ['лето'],
      }),
    )
    await items.create(
      makeItem({
        id: 'в-топ',
        название: 'Топ',
        категория: 'Верх',
        подкатегория: 'топ',
        цвета: ['белый'],
        сезон: ['зима'],
      }),
    )

    renderWardrobe()

    fireEvent.click(await screen.findByRole('button', { name: 'чёрный' }))
    expect(await screen.findByText('Найдено 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'зима' }))
    expect(await screen.findByText('Найдено 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Пальто' })).toBeInTheDocument()
  })

  it('поиск по названию: регистр и «ё» не важны, список сужается', async () => {
    await items.create(
      makeItem({ id: 'в-ёлочка', название: 'Платье Ёлочка', категория: 'Платья', подкатегория: 'платье' }),
    )
    await items.create(
      makeItem({ id: 'в-джинсы', название: 'Джинсы синие', категория: 'Низ', подкатегория: 'джинсы' }),
    )

    renderWardrobe()

    fireEvent.change(await screen.findByLabelText('Поиск по названию'), {
      target: { value: 'ЕЛОЧКА' },
    })

    expect(await screen.findByText('Найдено 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Платье Ёлочка' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Джинсы синие' })).toBeNull()
  })

  it('ничего не найдено: состояние с предложением сбросить фильтры и возврат к полкам', async () => {
    await items.create(
      makeItem({ id: 'в-худи', название: 'Худи', категория: 'Второй слой', подкатегория: 'худи' }),
    )

    renderWardrobe()

    fireEvent.change(await screen.findByLabelText('Поиск по названию'), {
      target: { value: 'такого нет' },
    })

    expect(await screen.findByText('Ничего не найдено')).toBeInTheDocument()
    expect(
      screen.getByText('Попробуйте изменить запрос или сбросить фильтры'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Сбросить фильтры' }))

    expect(await screen.findByRole('region', { name: 'Второй слой' })).toBeInTheDocument()
  })

  it('ввод в поиск не перечитывает IndexedDB: данные читаются один раз, фильтрация — в памяти', async () => {
    await items.create(
      makeItem({ id: 'в-худи', название: 'Худи', категория: 'Второй слой', подкатегория: 'худи' }),
    )
    vi.mocked(loadWardrobe).mockClear()

    renderWardrobe()
    await screen.findByRole('region', { name: 'Второй слой' })
    expect(vi.mocked(loadWardrobe)).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByLabelText('Поиск по названию'), { target: { value: 'худ' } })
    expect(await screen.findByText('Найдено 1')).toBeInTheDocument()
    expect(vi.mocked(loadWardrobe)).toHaveBeenCalledTimes(1)
  })
})
