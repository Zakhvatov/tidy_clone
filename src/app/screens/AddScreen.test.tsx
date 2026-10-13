import 'fake-indexeddb/auto'

import { fireEvent, render, screen } from '@testing-library/react'
import { deleteDB } from 'idb'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DB_NAME, closeDb } from '../../storage/db'
import * as images from '../../storage/images'
import * as items from '../../storage/items'
import { AppRoutes } from '../App'

/** Фикстура карточки WB: поля повторяют `info/ru/card.json`. */
interface CardFixture {
  nm_id: number
  imt_name: string
  subj_name: string
  subj_root_name: string
  nm_colors_names?: string
  selling?: { brand_name?: string }
  media?: { photo_count?: number }
  options?: Array<{ name: string; value: string }>
}

const BASE_CARD: CardFixture = {
  nm_id: 16020837,
  imt_name: 'Худи тестовое',
  subj_name: 'Худи',
  subj_root_name: 'Одежда',
  nm_colors_names: 'чёрный, серый',
  selling: { brand_name: 'Тестовый бренд' },
  media: { photo_count: 1 },
  options: [{ name: 'Состав', value: 'хлопок 80%, полиэстер 20%' }],
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Мок сети: отдаёт card.json/sellers.json, фото и ответ воркера классификации.
 * Номер `nm` берётся из URL карточки, чтобы одна и та же подготовка работала
 * и на повторе, и на нескольких разных ссылках.
 */
function makeFetch(options: {
  card?: CardFixture | ((nm: number) => CardFixture)
  classify?: () => Response
}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const cardMatch = url.match(/(\d+)\/info\/ru\/card\.json$/)
    if (cardMatch) {
      const nm = Number(cardMatch[1])
      const card =
        typeof options.card === 'function'
          ? options.card(nm)
          : (options.card ?? { ...BASE_CARD, nm_id: nm })
      return jsonResponse(200, card)
    }
    if (url.includes('/info/sellers.json')) {
      return jsonResponse(200, { supplierName: 'ООО Тест' })
    }
    if (url.includes('/images/big/')) {
      return new Response(new Uint8Array([0x70, 0x68, 0x6f, 0x74, 0x6f]), {
        headers: { 'content-type': 'image/webp' },
      })
    }
    if (url.endsWith('/classify')) {
      if (options.classify) return options.classify()
      return jsonResponse(200, { category: 'Обувь', subcategory: 'кроссовки', confidence: 0.9 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

/** Canvas в jsdom недоступен: анализ пакшота честно не срабатывает, но не шумит. */
class FakeOffscreenCanvas {
  width: number
  height: number

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  getContext(): null {
    return null
  }
}

function renderAdd() {
  return render(
    <MemoryRouter initialEntries={['/add']}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

async function вставитьСсылку(link: string, name: string) {
  fireEvent.change(screen.getByLabelText('Ссылка на товар'), { target: { value: link } })
  fireEvent.click(screen.getByRole('button', { name: 'Найти вещь' }))
  expect(await screen.findByRole('heading', { name })).toBeInTheDocument()
}

async function загрузитьФото(file: File) {
  const input = screen.getByLabelText('Загрузить фото') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

function фото(): File {
  return new File(['image-bytes'], 'фото.jpg', { type: 'image/jpeg' })
}

describe('Экран добавления вещи (T8)', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:test'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    })
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('сохраняет вещь по ссылке с Оригиналом и категорией из словаря', async () => {
    vi.stubGlobal('fetch', makeFetch({}))
    renderAdd()

    await вставитьСсылку('https://www.wildberries.ru/catalog/16020837/detail.aspx', 'Худи тестовое')
    expect(screen.getByText('Тестовый бренд')).toBeInTheDocument()
    expect(screen.getByText('чёрный, серый')).toBeInTheDocument()
    expect(screen.getByText('пакшот: нет')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Добавить в гардероб' }))
    expect(await screen.findByRole('heading', { name: 'Гардероб' })).toBeInTheDocument()

    const вещи = await items.list()
    expect(вещи).toHaveLength(1)
    const вещь = вещи[0]
    expect(вещь.категория).toBe('Второй слой')
    expect(вещь.подкатегория).toBe('худи')
    expect(вещь.источник).toBe('ссылка')
    expect(вещь.wbNmId).toBe(16020837)
    expect(вещь.цвета).toEqual(['чёрный', 'серый'])
    expect(вещь.состав).toEqual(['хлопок 80%, полиэстер 20%'])

    const сохранённые = await images.listByItem(вещь.id)
    expect(сохранённые).toHaveLength(1)
    expect(сохранённые[0]?.роль).toBe('оригинал')
    expect(сохранённые[0]?.blob.size).toBeGreaterThan(0)
  })

  it('неизвестную категорию WB кладёт в «Разное», но вещь сохраняет', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({ card: { ...BASE_CARD, subj_name: 'Носороги', subj_root_name: 'Прочее' } }),
    )
    renderAdd()

    await вставитьСсылку('https://www.wildberries.ru/catalog/16020837/detail.aspx', 'Худи тестовое')
    expect(screen.getByText(/выберите вручную/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Добавить в гардероб' }))
    expect(await screen.findByRole('heading', { name: 'Гардероб' })).toBeInTheDocument()

    const [вещь] = await items.list()
    expect(вещь?.категория).toBe('Разное')
    expect(вещь?.подкатегория).toBe('Разное')
  })

  it('по фото берёт категорию у vision и сохраняет вещь', async () => {
    vi.stubGlobal('fetch', makeFetch({}))
    renderAdd()

    await загрузитьФото(фото())
    expect(await screen.findByRole('heading', { name: 'Без названия' })).toBeInTheDocument()
    expect(screen.getByText('Обувь')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Добавить в гардероб' }))
    expect(await screen.findByRole('heading', { name: 'Гардероб' })).toBeInTheDocument()

    const [вещь] = await items.list()
    expect(вещь?.источник).toBe('фото')
    expect(вещь?.категория).toBe('Обувь')
    expect(вещь?.подкатегория).toBe('кроссовки')
    const сохранённые = await images.listByItem(вещь!.id)
    expect(сохранённые[0]?.роль).toBe('оригинал')
  })

  it('при ошибке классификации фото вещь всё равно сохраняется', async () => {
    vi.stubGlobal('fetch', makeFetch({ classify: () => new Response('boom', { status: 500 }) }))
    renderAdd()

    await загрузитьФото(фото())
    expect(await screen.findByRole('heading', { name: 'Без названия' })).toBeInTheDocument()
    expect(screen.getByText(/выберите вручную/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Добавить в гардероб' }))
    expect(await screen.findByRole('heading', { name: 'Гардероб' })).toBeInTheDocument()

    const [вещь] = await items.list()
    expect(вещь?.источник).toBe('фото')
    expect(вещь?.категория).toBe('Разное')
    expect(await items.count()).toBe(1)
  })

  it('мусорная ссылка даёт понятную ошибку и ничего не сохраняет', async () => {
    vi.stubGlobal('fetch', makeFetch({}))
    renderAdd()

    fireEvent.change(screen.getByLabelText('Ссылка на товар'), {
      target: { value: 'https://example.com/catalog/123/detail.aspx' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Найти вещь' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Это не похоже на ссылку Wildberries')
    expect(screen.queryByRole('button', { name: 'Добавить в гардероб' })).toBeNull()
    expect(await items.count()).toBe(0)
  })

  it('повторное добавление не ломает уже сохранённые вещи', async () => {
    const cardFor = (nm: number): CardFixture => ({ ...BASE_CARD, nm_id: nm, imt_name: `Худи ${nm}` })
    vi.stubGlobal('fetch', makeFetch({ card: cardFor }))
    renderAdd()

    await вставитьСсылку('https://www.wildberries.ru/catalog/16020837/detail.aspx', 'Худи 16020837')
    fireEvent.click(screen.getByRole('button', { name: 'Добавить в гардероб' }))
    expect(await screen.findByRole('heading', { name: 'Гардероб' })).toBeInTheDocument()

    // Возврат на экран добавления: форма снова пустая и готова к следующей ссылке.
    fireEvent.click(screen.getByRole('link', { name: 'Добавить' }))
    expect(await screen.findByRole('heading', { name: 'Добавить вещь' })).toBeInTheDocument()

    await вставитьСсылку('https://www.wildberries.ru/catalog/14058746/detail.aspx', 'Худи 14058746')
    fireEvent.click(screen.getByRole('button', { name: 'Добавить в гардероб' }))
    expect(await screen.findByRole('heading', { name: 'Гардероб' })).toBeInTheDocument()

    const вещи = await items.list()
    expect(вещи).toHaveLength(2)
    expect(new Set(вещи.map((вещь) => вещь.id)).size).toBe(2)
    expect(вещи.map((вещь) => вещь.название).sort()).toEqual(['Худи 14058746', 'Худи 16020837'])
  })
})
