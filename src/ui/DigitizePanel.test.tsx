import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { QueueProgress } from '../services/digitize-queue'
import { DigitizePanel } from './DigitizePanel'
import { useDigitizeQueue, type DigitizeQueueApi } from './useDigitizeQueue'

// Панель проверяется отдельно от очереди: хук подменяется, поэтому тест не
// трогает IndexedDB и не зависит от таймингов движка.
vi.mock('./useDigitizeQueue', () => ({ useDigitizeQueue: vi.fn() }))

const mocked = vi.mocked(useDigitizeQueue)

function makeProgress(overrides: Partial<QueueProgress> = {}): QueueProgress {
  return {
    статус: 'пусто',
    всего: 0,
    обработано: 0,
    успехов: 0,
    ошибок: 0,
    осталось: 0,
    ...overrides,
  }
}

function setup(overrides: Partial<DigitizeQueueApi> = {}) {
  const api: DigitizeQueueApi = {
    progress: makeProgress(),
    busy: false,
    resumable: false,
    startError: null,
    start: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    stop: vi.fn(),
    ...overrides,
  }
  mocked.mockReturnValue(api)
  return api
}

describe('Панель оцифровки (T12)', () => {
  beforeEach(() => {
    mocked.mockReset()
  })

  it('до запуска показывает кнопку массовой оцифровки и зовёт start', () => {
    const api = setup()
    render(<DigitizePanel />)

    const button = screen.getByRole('button', { name: 'Оцифровать всё, где нет пакшота' })
    fireEvent.click(button)
    expect(api.start).toHaveBeenCalledTimes(1)
  })

  it('во время работы показывает прогресс, текущую вещь и кнопку «Остановить»', () => {
    const api = setup({
      busy: true,
      progress: makeProgress({
        статус: 'выполняется',
        всего: 5,
        обработано: 2,
        успехов: 2,
        ошибок: 0,
        осталось: 3,
        текущая: 'Худи',
      }),
    })
    render(<DigitizePanel />)

    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '2')
    expect(bar).toHaveAttribute('aria-valuemax', '5')
    expect(screen.getByText(/Обработано 2 из 5/)).toBeInTheDocument()
    expect(screen.getByText(/Сейчас: Худи/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Остановить' }))
    expect(api.stop).toHaveBeenCalledTimes(1)
  })

  it('прерванную очередь предлагает продолжить и зовёт resume', () => {
    const api = setup({
      resumable: true,
      progress: makeProgress({
        статус: 'остановлена',
        всего: 4,
        обработано: 1,
        успехов: 1,
        осталось: 3,
      }),
    })
    render(<DigitizePanel />)

    const button = screen.getByRole('button', { name: 'Продолжить оцифровку' })
    fireEvent.click(button)
    expect(api.resume).toHaveBeenCalledTimes(1)
  })

  it('показывает последнюю ошибку очереди и ошибку запуска', () => {
    setup({
      progress: makeProgress({
        статус: 'остановлена',
        всего: 2,
        обработано: 1,
        успехов: 1,
        осталось: 1,
        последняяОшибка: 'Сервис отклонил запрос: неверный клиентский токен',
      }),
    })
    const { unmount } = render(<DigitizePanel />)
    expect(screen.getByText(/неверный клиентский токен/)).toBeInTheDocument()
    unmount()

    setup({ startError: 'Не удалось запустить оцифровку. Попробуйте ещё раз' })
    render(<DigitizePanel />)
    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось запустить оцифровку')
  })

  it('когда оцифровывать нечего — сообщает об этом', () => {
    setup({ progress: makeProgress({ статус: 'завершена', всего: 0 }) })
    render(<DigitizePanel />)
    expect(screen.getByText('Всё уже оцифровано')).toBeInTheDocument()
  })
})
