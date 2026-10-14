import 'fake-indexeddb/auto'

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { AppRoutes } from '../App'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

/**
 * T20: инструкция «Поделиться → На экран Домой» должна жить в интерфейсе,
 * а не только в README. Проверяем отдельный экран `/help` и наличие входа
 * в нижней навигации.
 */
describe('Экран «Установка и помощь» (T20)', () => {
  it('открывается по /help и содержит шаги для iPhone', () => {
    renderAt('/help')

    expect(screen.getByRole('heading', { name: 'Установка и помощь' })).toBeInTheDocument()

    const шаги = screen.getAllByRole('listitem')
    expect(шаги.length).toBeGreaterThanOrEqual(3)
    expect(шпаргалка()).toContain('Поделиться')
    expect(шпаргалка()).toContain('На экран Домой')
    expect(шпаргалка()).toContain('Safari')
  })

  it('на него ведёт пункт «Помощь» в навигации', () => {
    renderAt('/')
    expect(screen.getByRole('link', { name: 'Помощь' })).toHaveAttribute('href', '/help')
  })
})

/** Весь видимый текст экрана — так шаги читаются независимо от разметки. */
function шпаргалка(): string {
  return document.body.textContent ?? ''
}
