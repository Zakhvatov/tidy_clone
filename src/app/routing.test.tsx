import 'fake-indexeddb/auto'

import { render, screen } from '@testing-library/react'
import { deleteDB } from 'idb'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DB_NAME, closeDb } from '../storage/db'
import { AppRoutes } from './App'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

describe('Маршрутизация', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  afterEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('открывает экран гардероба на /', async () => {
    renderAt('/')
    expect(screen.getByRole('heading', { name: 'Гардероб' })).toBeInTheDocument()
    // Гардероб теперь читается из IndexedDB асинхронно (T13).
    expect(await screen.findByText('Гардероб пуст')).toBeInTheDocument()
  })

  it('открывает экран добавления на /add с полем ссылки', () => {
    renderAt('/add')
    expect(screen.getByRole('heading', { name: 'Добавить вещь' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Ссылка на товар' })).toBeInTheDocument()
  })

  it('открывает экран образов на /outfits', async () => {
    renderAt('/outfits')
    expect(screen.getByRole('heading', { name: 'Образы' })).toBeInTheDocument()
    // Список читается из IndexedDB асинхронно (T18).
    expect(await screen.findByText('Образов пока нет')).toBeInTheDocument()
  })

  it('неизвестный путь уводит на гардероб', () => {
    renderAt('/nothing-here')
    expect(screen.getByRole('heading', { name: 'Гардероб' })).toBeInTheDocument()
  })
})
