import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { AppRoutes } from './App'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

describe('Маршрутизация', () => {
  it('открывает экран гардероба на /', () => {
    renderAt('/')
    expect(screen.getByRole('heading', { name: 'Гардероб' })).toBeInTheDocument()
    expect(screen.getByText('Гардероб пуст')).toBeInTheDocument()
  })

  it('открывает экран добавления на /add с полем ссылки', () => {
    renderAt('/add')
    expect(screen.getByRole('heading', { name: 'Добавить вещь' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Ссылка на товар' })).toBeInTheDocument()
  })

  it('открывает экран образов на /outfits', () => {
    renderAt('/outfits')
    expect(screen.getByRole('heading', { name: 'Образы' })).toBeInTheDocument()
    expect(screen.getByText('Образов пока нет')).toBeInTheDocument()
  })

  it('неизвестный путь уводит на гардероб', () => {
    renderAt('/nothing-here')
    expect(screen.getByRole('heading', { name: 'Гардероб' })).toBeInTheDocument()
  })
})
