import 'fake-indexeddb/auto'

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'

import { AppRoutes } from './App'

/** Подменяет `navigator.onLine` — jsdom не умеет отключать сеть сам. */
function установитьСеть(значение: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: значение })
}

const МАРШРУТЫ = ['/', '/add', '/outfits', '/backup', '/help']

/**
 * Офлайн-режим T19: данные локальные, поэтому ни один экран не должен падать
 * без сети. Здесь проверяется рендер экранов при `navigator.onLine === false`.
 */
describe('Офлайн-режим (T19)', () => {
  afterEach(() => {
    установитьСеть(true)
  })

  it.each(МАРШРУТЫ)('экран %s открывается без сети', async (маршрут) => {
    установитьСеть(false)
    render(
      <MemoryRouter initialEntries={[маршрут]}>
        <AppRoutes />
      </MemoryRouter>,
    )
    const заголовки = await screen.findAllByRole('heading')
    expect(заголовки.length).toBeGreaterThan(0)
  })

  it('на экране добавления виден понятный индикатор отсутствия сети', async () => {
    установитьСеть(false)
    render(
      <MemoryRouter initialEntries={['/add']}>
        <AppRoutes />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/Нет сети/)).toBeInTheDocument()
  })
})
