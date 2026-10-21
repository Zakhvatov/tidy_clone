import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ACCESS_TOKEN_KEY, readAccessToken, saveAccessToken } from '../../storage/settings'
import { AppRoutes } from '../App'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderAccess() {
  return render(
    <MemoryRouter initialEntries={['/access']}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

function ввестиТокен(значение: string) {
  fireEvent.change(screen.getByLabelText('Токен доступа'), { target: { value: значение } })
  fireEvent.click(screen.getByRole('button', { name: 'Проверить и сохранить' }))
}

describe('Экран доступа к генерации (T22)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('показывает, что токена нет, и объясняет, откуда он берётся', () => {
    renderAccess()

    expect(screen.getByRole('heading', { name: 'Доступ к генерации' })).toBeInTheDocument()
    expect(screen.getByText(/Токен не задан/)).toBeInTheDocument()
    expect(screen.getByText(/хранится только на этом устройстве/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Забыть токен' })).toBeNull()
  })

  it('проверяет токен через /session и сохраняет его на устройстве', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    renderAccess()

    ввестиТокен('  secret-token  ')

    expect(await screen.findByRole('status')).toHaveTextContent('Токен сохранён на этом устройстве.')
    expect(readAccessToken()).toBe('secret-token')
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('secret-token')
    expect(screen.getByText('••••••••oken')).toBeInTheDocument()

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/session$/)
    expect((init.headers as Record<string, string>)['x-tidy-client']).toBe('secret-token')
  })

  it('401 показывает «Токен не подошёл» и ничего не сохраняет', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(401, { error: { code: 'unauthorized', message: 'Неверный токен' } }),
      ),
    )
    renderAccess()

    ввестиТокен('wrong-token')

    expect(await screen.findByRole('alert')).toHaveTextContent('Токен не подошёл')
    expect(readAccessToken()).toBeNull()
    expect(screen.getByText(/Токен не задан/)).toBeInTheDocument()
  })

  it('503 not_configured и сетевой сбой объясняются понятными текстами', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(503, { error: { code: 'not_configured', message: 'нет токенов' } }),
      ),
    )
    const first = renderAccess()
    ввестиТокен('token')
    expect(await screen.findByRole('alert')).toHaveTextContent(/Сервис не настроен/)
    first.unmount()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    renderAccess()
    ввестиТокен('token')
    expect(await screen.findByRole('alert')).toHaveTextContent(/Не удалось связаться с сервисом/)
    expect(readAccessToken()).toBeNull()
  })

  it('«Забыть токен» стирает сохранённый токен', () => {
    saveAccessToken('secret-token')
    renderAccess()

    expect(screen.getByText('••••••••oken')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Забыть токен' }))

    expect(readAccessToken()).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Токен удалён с этого устройства.')
    expect(screen.getByText(/Токен не задан/)).toBeInTheDocument()
  })
})
