import 'fake-indexeddb/auto'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { deleteDB } from 'idb'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DB_NAME, closeDb } from '../../storage/db'
import * as images from '../../storage/images'
import * as items from '../../storage/items'
import { saveAccessToken, clearAccessToken } from '../../storage/settings'
import { AppRoutes } from '../App'

/**
 * Мок воркера: `GET /generations` отдаёт список, `GET /generations/{id}/image`
 * — байты картинки (и превью, и восстановление берут их отсюда).
 */
function historyFetch(items: unknown[]) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    void init
    const u = String(url)
    if (u.endsWith('/image')) {
      return new Response(new Blob(['байты-картинки'], { type: 'image/jpeg' }), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    if (u.endsWith('/generations')) {
      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'нет' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function renderGenerations() {
  return render(
    <MemoryRouter initialEntries={['/generations']}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

function списокВызововСписка(fetchMock: ReturnType<typeof historyFetch>): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.endsWith('/generations'))
}

describe('Экран истории генераций (T23)', () => {
  let fetchMock: ReturnType<typeof historyFetch>

  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
    window.localStorage.clear()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn((blob: Blob) => `blob:превью-${blob.size}`),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    clearAccessToken()
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('без токена просит ввести его на /access и не ходит в сеть', () => {
    fetchMock = historyFetch([])
    vi.stubGlobal('fetch', fetchMock)
    renderGenerations()

    expect(screen.getByRole('heading', { name: 'Генерации' })).toBeInTheDocument()
    expect(screen.getByText(/введите токен доступа/i)).toBeInTheDocument()
    const ссылка = screen.getByRole('link', { name: 'Ввести токен' })
    expect(ссылка).toHaveAttribute('href', '/access')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('пустой список: «Пока нет сохранённых генераций»', async () => {
    saveAccessToken('test-token')
    fetchMock = historyFetch([])
    vi.stubGlobal('fetch', fetchMock)
    renderGenerations()

    expect(await screen.findByText('Пока нет сохранённых генераций')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Обновить/ })).toBeInTheDocument()
    expect(списокВызововСписка(fetchMock)).toHaveLength(1)
  })

  it('показывает список: превью, название, категорию, дату, модель и цену', async () => {
    saveAccessToken('test-token')
    fetchMock = historyFetch([
      {
        taskId: 'task-1',
        title: 'Худи тестовое',
        prompt: 'redraw',
        model: 'nano-banana-2-1',
        costRub: 7,
        createdAt: '2026-10-21T10:00:00.000Z',
        category: 'Второй слой',
        subcategory: 'худи',
      },
      {
        taskId: 'task-2',
        title: '   ',
        model: '',
        costRub: null,
        createdAt: 'не дата',
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    renderGenerations()

    expect(await screen.findByText('Худи тестовое')).toBeInTheDocument()
    expect(screen.getByText('Без названия')).toBeInTheDocument()
    expect(screen.getByText('Второй слой / худи')).toBeInTheDocument()
    expect(screen.getByText('Без категории')).toBeInTheDocument()
    // Битая дата не роняет карточку: показывается прочерк.
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(await screen.findByRole('img', { name: 'Худи тестовое' })).toHaveAttribute(
      'src',
      expect.stringMatching(/^blob:/),
    )

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/generations$/)
    expect((init.headers as Record<string, string>)['x-tidy-client']).toBe('test-token')
    const ожидаемаяДата = new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date('2026-10-21T10:00:00.000Z'))
    expect(screen.getAllByText(new RegExp(ожидаемаяДата.replace(/\./g, '\\.')))).toHaveLength(1)
  })

  it('«Забрать в гардероб» восстанавливает вещь и даёт ссылку «Открыть вещь»', async () => {
    saveAccessToken('test-token')
    fetchMock = historyFetch([
      { taskId: 'task-9', title: 'Худи из истории', model: 'nano-banana-2-1', costRub: 7 },
    ])
    vi.stubGlobal('fetch', fetchMock)
    renderGenerations()

    fireEvent.click(await screen.findByRole('button', { name: 'Забрать в гардероб' }))

    expect(await screen.findByText('Уже в гардеробе')).toBeInTheDocument()
    const ссылка = screen.getByRole('link', { name: 'Открыть вещь' })
    expect(ссылка).toHaveAttribute('href', '/item/restored-task-9')

    await waitFor(async () => {
      const вещь = await items.get('restored-task-9')
      expect(вещь).toBeDefined()
      expect(вещь?.idИзображений).toEqual(['ai-task-9'])
      expect(вещь?.источник).toBe('фото')
    })
    const ai = await images.get('ai-task-9')
    expect(ai?.роль).toBe('ai')
  })

  it('ошибка 401 объясняется человеческим текстом и ведёт на /access', async () => {
    saveAccessToken('test-token')
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Неверный токен' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderGenerations()

    expect(await screen.findByRole('alert')).toHaveTextContent(/токен не подошёл/i)
    const ссылка = screen.getByRole('link', { name: 'Ввести токен' })
    expect(ссылка).toHaveAttribute('href', '/access')
    expect(screen.queryByText('Пока нет сохранённых генераций')).toBeNull()
  })

  it('кнопка «Обновить» перечитывает список с сервера', async () => {    saveAccessToken('test-token')
    fetchMock = historyFetch([])
    vi.stubGlobal('fetch', fetchMock)
    renderGenerations()

    expect(await screen.findByText('Пока нет сохранённых генераций')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Обновить/ }))

    await waitFor(() => expect(списокВызововСписка(fetchMock)).toHaveLength(2))
    expect(await screen.findByText('Пока нет сохранённых генераций')).toBeInTheDocument()
  })
})
