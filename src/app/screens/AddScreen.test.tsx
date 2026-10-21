import 'fake-indexeddb/auto'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { deleteDB } from 'idb'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DB_NAME, closeDb } from '../../storage/db'
import { ОшибкаХранилища } from '../../storage/errors'
import * as images from '../../storage/images'
import * as items from '../../storage/items'
import { AppRoutes } from '../App'

// `create` — наблюдаемый мок: тесту повтора нужно один раз отклонить запись,
// остальные тесты работают с настоящей реализацией.
vi.mock('../../storage/items', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../storage/items')>()
  return { ...actual, create: vi.fn(actual.create) }
})

/**
 * Мок сети: только классификация фото. Ссылочный вход из формы убран
 * (ADR-0006 §1), WB-сеть здесь больше не нужна.
 */
function makeFetch(options: { classify?: () => Response } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/classify')) {
      if (options.classify) return options.classify()
      return jsonResponse(200, { category: 'Обувь', subcategory: 'кроссовки', confidence: 0.9 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Мок асинхронного воркера генерации (ADR-0006): `POST /generate` → 202 с
 * `taskId`, статус → сразу `SUCCEEDED`, скачивание → байты.
 */
function makeGenerationFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/generate') && init?.method === 'POST') {
      return jsonResponse(202, { taskId: 'task-add', status: 'PENDING', costRub: 7, model: 'nano' })
    }
    if (url.includes('/generate/task-add/image')) {
      return new Response(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    if (url.includes('/classify')) {
      return jsonResponse(200, { category: 'Обувь', subcategory: 'кроссовки', confidence: 0.9 })
    }
    return jsonResponse(200, { taskId: 'task-add', status: 'SUCCEEDED', costRub: 7 })
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

async function загрузитьФото(file: File) {
  const input = screen.getByLabelText('Загрузить фото') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
  await screen.findByRole('heading', { name: 'Без названия' })
}

function фото(имя = 'фото.jpg'): File {
  return new File(['image-bytes'], имя, { type: 'image/jpeg' })
}

/** «Добавить в гардероб» из превью: вещь сохранена, открылось подтверждение. */
async function сохранитьИзПревью() {
  fireEvent.click(screen.getByRole('button', { name: 'Добавить в гардероб' }))
  await screen.findByText('Вещь сохранена. Сделать AI-версию?')
}

/** Проходит путь «фото → превью → Добавить в гардероб» до фазы подтверждения. */
async function добавитьДоПодтверждения(file: File = фото()) {
  await загрузитьФото(file)
  await сохранитьИзПревью()
}

/** Отвечает на подтверждение: «Добавить без AI-версии» → уходим в гардероб. */
async function добавитьБезAi() {
  fireEvent.click(screen.getByRole('button', { name: 'Добавить без AI-версии' }))
  await screen.findByRole('heading', { name: 'Гардероб' })
}

describe('Экран добавления вещи (T8 + ADR-0006)', () => {
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
    window.localStorage.setItem('tidy.accessToken', 'test-token')
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('форма входа по ссылке убрана — только загрузка своего фото', async () => {
    vi.stubGlobal('fetch', makeFetch({}))
    renderAdd()

    expect(screen.getByText('Загрузить фото')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Ссылка на товар' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Найти вещь' })).toBeNull()
  })

  it('пока идёт распознавание, загрузка фото недоступна и показывает прогресс', async () => {
    let ответить: ((response: Response) => void) | undefined
    const классификация = new Promise<Response>((resolve) => {
      ответить = resolve
    })
    vi.stubGlobal('fetch', vi.fn(() => классификация) as unknown as typeof fetch)
    renderAdd()

    const input = screen.getByLabelText('Загрузить фото') as HTMLInputElement
    fireEvent.change(input, { target: { files: [фото()] } })

    expect(input).toBeDisabled()
    expect(input.closest('label')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Загружаем и распознаём фото…')).toBeInTheDocument()

    await waitFor(() => expect(ответить).toBeTypeOf('function'))
    ответить!(jsonResponse(200, { category: 'Обувь', subcategory: 'кроссовки', confidence: 0.9 }))
    await screen.findByRole('heading', { name: 'Без названия' })

    expect(input).not.toBeDisabled()
  })

  it('по фото берёт категорию у vision; вещь сохраняется до генерации', async () => {
    vi.stubGlobal('fetch', makeFetch({}))
    renderAdd()

    await загрузитьФото(фото())
    expect(screen.getByText('Обувь')).toBeInTheDocument()

    await сохранитьИзПревью()

    // Вещь уже в гардеробе, даже если AI-версию делать не будут.
    expect(await items.count()).toBe(1)
    const [вещь] = await items.list()
    expect(вещь?.источник).toBe('фото')
    expect(вещь?.категория).toBe('Обувь')
    expect(вещь?.подкатегория).toBe('кроссовки')
    const сохранённые = await images.listByItem(вещь!.id)
    expect(сохранённые[0]?.роль).toBe('оригинал')

    await добавитьБезAi()
  })

  it('подтверждение показывает пикер и кнопку с ценой; «без AI-версии» заканчивает добавление', async () => {
    vi.stubGlobal('fetch', makeFetch({}))
    renderAdd()

    await добавитьДоПодтверждения()

    // Пикер моделей доступен прямо в подтверждении (ADR-0006).
    expect(screen.getByRole('group', { name: 'Модель' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Сделать AI-версию · \d+ ₽$/ })).toBeInTheDocument()

    await добавитьБезAi()
    expect(await items.count()).toBe(1)
  })

  it('кнопка с ценой реально генерирует AI-версию и завершает добавление', async () => {
    vi.stubGlobal('fetch', makeGenerationFetch())
    renderAdd()

    await добавитьДоПодтверждения()

    fireEvent.click(screen.getByRole('button', { name: /^Сделать AI-версию · \d+ ₽$/ }))
    await screen.findByRole('heading', { name: 'Гардероб' })

    const [вещь] = await items.list()
    const роли = (await images.listByItem(вещь!.id)).map((i) => i.роль)
    expect(роли).toContain('ai')
  })

  it('без токена генерация объясняет, что его нужно ввести в «Данных»', async () => {
    vi.stubGlobal('fetch', makeGenerationFetch())
    renderAdd()

    await добавитьДоПодтверждения()
    window.localStorage.clear()
    fireEvent.click(screen.getByRole('button', { name: /^Сделать AI-версию · \d+ ₽$/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Нужен токен доступа. Введите его в разделе «Данные».',
    )
  })

  it('при ошибке классификации фото вещь всё равно сохраняется', async () => {
    vi.stubGlobal('fetch', makeFetch({ classify: () => new Response('boom', { status: 500 }) }))
    renderAdd()

    await загрузитьФото(фото())
    expect(screen.getByText(/выберите вручную/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Добавить в гардероб' }))
    await screen.findByText('Вещь сохранена. Сделать AI-версию?')
    await добавитьБезAi()

    const [вещь] = await items.list()
    expect(вещь?.источник).toBe('фото')
    expect(вещь?.категория).toBe('Разное')
    expect(await items.count()).toBe(1)
  })

  it('при ошибке сохранения «Повторить» повторяет именно сохранение, а не загрузку', async () => {
    const fetchMock = makeFetch({})
    vi.stubGlobal('fetch', fetchMock)
    renderAdd()

    await загрузитьФото(фото())
    const классификаций = vi.mocked(fetchMock).mock.calls.length

    vi.mocked(items.create).mockRejectedValueOnce(new ОшибкаХранилища('диск занят'))
    fireEvent.click(screen.getByRole('button', { name: 'Добавить в гардероб' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('диск занят')

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))

    await screen.findByText('Вещь сохранена. Сделать AI-версию?')
    // Фото повторно не тянулось: повтор — это именно сохранение.
    expect(vi.mocked(fetchMock).mock.calls.length).toBe(классификаций)
    expect(await items.count()).toBe(1)
  })

  it('повторное добавление не ломает уже сохранённые вещи', async () => {
    vi.stubGlobal('fetch', makeFetch({}))
    renderAdd()

    await добавитьДоПодтверждения(фото('первое.jpg'))
    await добавитьБезAi()

    // Возврат на экран добавления: форма снова пустая и готова к следующему фото.
    fireEvent.click(screen.getByRole('link', { name: 'Добавить' }))
    expect(await screen.findByRole('heading', { name: 'Добавить вещь' })).toBeInTheDocument()

    await добавитьДоПодтверждения(фото('второе.jpg'))
    await добавитьБезAi()

    const вещи = await items.list()
    expect(вещи).toHaveLength(2)
    expect(new Set(вещи.map((вещь) => вещь.id)).size).toBe(2)
  })
})
