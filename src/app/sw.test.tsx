import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const { registerSWMock } = vi.hoisted(() => ({
  registerSWMock: vi.fn(() => vi.fn()),
}))

vi.mock('virtual:pwa-register', () => ({
  registerSW: registerSWMock,
}))

import { AppRoutes } from './App'
import { registerAppServiceWorker } from './sw'

describe('Регистрация service worker', () => {
  it('регистрирует SW и не ломает рендер приложения', () => {
    const update = registerAppServiceWorker()
    expect(registerSWMock).toHaveBeenCalledTimes(1)
    expect(typeof update).toBe('function')

    render(
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: 'Гардероб' })).toBeInTheDocument()
  })
})
