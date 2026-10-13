import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ItemImage } from './ItemImage'

/** Возвращает подставной blob с меткой, чтобы различать картинки в тестах. */
function blob(tag: string): Blob {
  return new Blob([tag], { type: 'image/png' })
}

describe('ItemImage (T13)', () => {
  let созданные: string[]
  let освобождённые: string[]
  let счётчик: number

  beforeEach(() => {
    созданные = []
    освобождённые = []
    счётчик = 0
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => {
        const url = `blob:тест-${(счётчик += 1)}`
        созданные.push(url)
        return url
      }),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn((url: string) => {
        освобождённые.push(url)
      }),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('грузит изображение лениво и декодирует асинхронно', () => {
    render(<ItemImage blob={blob('оригинал')} alt="Худи" />)

    const image = screen.getByAltText('Худи')
    expect(image).toHaveAttribute('loading', 'lazy')
    expect(image).toHaveAttribute('decoding', 'async')
    expect(image.getAttribute('src')).toBe('blob:тест-1')
  })

  it('без blob не создаёт URL и не рендерит картинку', () => {
    render(<ItemImage alt="Худи" />)

    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(screen.queryByAltText('Худи')).toBeNull()
  })

  it('освобождает object URL при размонтировании', () => {
    const { unmount } = render(<ItemImage blob={blob('оригинал')} alt="Худи" />)
    const url = screen.getByAltText('Худи').getAttribute('src')

    unmount()

    expect(освобождённые).toEqual([url])
  })

  it('освобождает старый URL и создаёт новый при смене blob', () => {
    const { rerender, unmount } = render(<ItemImage blob={blob('оригинал')} alt="Оригинал" />)
    const первый = screen.getByAltText('Оригинал').getAttribute('src')

    rerender(<ItemImage blob={blob('ai')} alt="AI-версия" />)

    const второй = screen.getByAltText('AI-версия').getAttribute('src')
    expect(второй).not.toBe(первый)
    expect(освобождённые).toContain(первый)

    unmount()
    expect(освобождённые).toContain(второй)
  })
})
