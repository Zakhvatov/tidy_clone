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
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('пустой гардероб: пустое состояние и кнопка «Добавить вещь» ведёт на /add', async () => {
    renderWardrobe()

    expect(await screen.findByText('Гардероб пуст')).toBeInTheDocument()
    expect(screen.queryByRole('region')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Добавить вещь' }))
    expect(await screen.findByRole('heading', { name: 'Добавить вещь' })).toBeInTheDocument()
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

    expect(screen.getAllByRole('button')).toHaveLength(50)
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
})
