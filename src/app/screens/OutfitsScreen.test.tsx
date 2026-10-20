import 'fake-indexeddb/auto'

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { deleteDB } from 'idb'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ImageRole, Изображение, Образ, ЭлементОбраза, Вещь } from '../../domain/types'
import { DB_NAME, closeDb } from '../../storage/db'
import * as images from '../../storage/images'
import * as items from '../../storage/items'
import * as outfits from '../../storage/outfits'
import { AppRoutes } from '../App'

// Рендер коллажа в jsdom без canvas невозможен. Прибиваем отказ намертво, чтобы
// доказать: карточка списка переживает исключение `renderOutfitCover` и показывает
// первую вещь вместо коллажа.
vi.mock('../../services/outfit-render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/outfit-render')>()
  return {
    ...actual,
    renderOutfitCover: vi.fn(() => Promise.reject(new Error('canvas недоступен в тесте'))),
  }
})

function makeItem(overrides: Partial<Вещь> = {}): Вещь {
  const дата = '2024-03-05T10:00:00.000Z'
  return {
    id: 'вещь-1',
    название: 'Худи тестовое',
    категория: 'Второй слой',
    подкатегория: 'худи',
    цвета: ['чёрный'],
    состав: ['хлопок'],
    сезон: [],
    бренд: 'Тестовый бренд',
    источник: 'фото',
    датаСоздания: дата,
    датаОбновления: дата,
    idИзображений: [],
    ...overrides,
  }
}

function makeImage(
  id: string,
  idВещи: string,
  роль: ImageRole,
  датаСоздания: string,
  tag: string,
): Изображение {
  const blob = new Blob([tag], { type: 'image/png' }) as Blob & { __tag?: string }
  blob.__tag = tag
  return { id, idВещи, роль, blob, ширина: 512, высота: 512, mime: 'image/png', датаСоздания }
}

function элемент(idВещи: string, zПорядок: number): ЭлементОбраза {
  return { idВещи, позиция: { x: 500, y: 600 }, масштаб: 1, zПорядок }
}

function makeOutfit(overrides: Partial<Образ> = {}): Образ {
  return {
    id: 'образ-1',
    название: 'Осенний',
    сезон: 'демисезон',
    элементы: [],
    датаСоздания: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function renderOutfits() {
  return render(
    <MemoryRouter initialEntries={['/outfits']}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

describe('Список образов (T18)', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
    localStorage.clear()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn((blob: Blob) => `blob:${(blob as Blob & { __tag?: string }).__tag ?? 'нет'}`),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await closeDb()
    await deleteDB(DB_NAME)
    localStorage.clear()
  })

  it('пустой экран: «Образов пока нет» и кнопка «Собрать образ» ведёт на /outfit/new', async () => {
    renderOutfits()

    expect(await screen.findByText('Образов пока нет')).toBeInTheDocument()
    const кнопка = screen.getByRole('button', { name: 'Собрать образ' })
    fireEvent.click(кнопка)

    expect(await screen.findByRole('heading', { name: 'Новый образ' })).toBeInTheDocument()
  })

  it('показывает название, сезон и число вещей; новые образы первыми', async () => {
    await outfits.create(
      makeOutfit({
        id: 'образ-старый',
        название: 'Осенний',
        сезон: 'демисезон',
        элементы: [элемент('в-1', 0), элемент('в-2', 1)],
        датаСоздания: '2024-01-01T00:00:00.000Z',
      }),
    )
    await outfits.create(
      makeOutfit({
        id: 'образ-новый',
        название: 'Летний',
        сезон: 'лето',
        элементы: [элемент('в-1', 0)],
        датаСоздания: '2024-06-01T00:00:00.000Z',
      }),
    )

    renderOutfits()
    const список = await screen.findByRole('list')

    expect(within(список).getByText('Осенний')).toBeInTheDocument()
    expect(within(список).getByText('Летний')).toBeInTheDocument()
    expect(within(список).getByText('демисезон')).toBeInTheDocument()
    expect(within(список).getByText('лето')).toBeInTheDocument()
    expect(within(список).getByText('2 вещи')).toBeInTheDocument()
    expect(within(список).getByText('1 вещь')).toBeInTheDocument()

    const открыть = within(список).getAllByRole('button', { name: /^Открыть образ / })
    expect(открыть.map((кнопка) => кнопка.getAttribute('aria-label'))).toEqual([
      'Открыть образ Летний',
      'Открыть образ Осенний',
    ])
  })

  it('фильтр по сезону прячет чужие образы и возвращает их по «Все»', async () => {
    await outfits.create(makeOutfit({ id: 'з', название: 'Зимний', сезон: 'зима' }))
    await outfits.create(makeOutfit({ id: 'л', название: 'Летний', сезон: 'лето' }))

    renderOutfits()
    const список = await screen.findByRole('list')
    expect(within(список).getByText('Зимний')).toBeInTheDocument()
    expect(within(список).getByText('Летний')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'зима' }))

    await waitFor(() => expect(screen.queryByText('Летний')).toBeNull())
    expect(within(await screen.findByRole('list')).getByText('Зимний')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Все' }))

    await waitFor(async () => {
      const вернувшийся = await screen.findByRole('list')
      expect(within(вернувшийся).getByText('Зимний')).toBeInTheDocument()
      expect(within(вернувшийся).getByText('Летний')).toBeInTheDocument()
    })
  })

  it('сезон без образов: фильтр не теряет данные и показывает понятное сообщение', async () => {
    await outfits.create(makeOutfit({ id: 'л', название: 'Летний', сезон: 'лето' }))

    renderOutfits()
    await screen.findByRole('list')

    fireEvent.click(screen.getByRole('button', { name: 'зима' }))

    expect(await screen.findByText('Образов с таким сезоном нет')).toBeInTheDocument()
    // Образ не удалён — он снова виден после сброса фильтра.
    fireEvent.click(screen.getByRole('button', { name: 'Все' }))
    expect(await screen.findByText('Летний')).toBeInTheDocument()
  })

  it('переименование сохраняется в IndexedDB и видно в списке', async () => {
    await outfits.create(makeOutfit({ id: 'образ-1', название: 'Осенний' }))

    renderOutfits()
    await screen.findByRole('list')

    fireEvent.click(screen.getByRole('button', { name: 'Переименовать Осенний' }))
    const поле = await screen.findByRole('textbox', { name: 'Название образа' })
    fireEvent.change(поле, { target: { value: 'Вечерний' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    const список = await screen.findByRole('list')
    expect(await within(список).findByText('Вечерний')).toBeInTheDocument()
    await waitFor(async () => {
      expect((await outfits.get('образ-1'))?.название).toBe('Вечерний')
    })
  })

  it('удаление убирает образ, но не удаляет вещи', async () => {
    await items.create(makeItem({ id: 'в-1', название: 'Худи' }))
    await outfits.create(
      makeOutfit({ id: 'образ-1', название: 'Осенний', элементы: [элемент('в-1', 0)] }),
    )
    renderOutfits()
    await screen.findByRole('list')

    fireEvent.click(screen.getByRole('button', { name: 'Удалить Осенний' }))
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))

    expect(await screen.findByText('Образов пока нет')).toBeInTheDocument()
    await waitFor(async () => {
      expect(await outfits.get('образ-1')).toBeUndefined()
    })
    expect(await items.get('в-1')).toBeDefined()
  })

  it('удаление образа убирает его подложку из localStorage', async () => {
    await outfits.create(makeOutfit({ id: 'образ-1', название: 'Осенний' }))
    localStorage.setItem('tidy.outfit.background.образ-1', '#EDEDEA')

    renderOutfits()
    await screen.findByRole('list')

    fireEvent.click(screen.getByRole('button', { name: 'Удалить Осенний' }))
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))

    await waitFor(() => {
      expect(localStorage.getItem('tidy.outfit.background.образ-1')).toBeNull()
    })
  })

  it('отмена подтверждения оставляет образ на месте и возвращает фокус на «Удалить»', async () => {
    await outfits.create(makeOutfit({ id: 'образ-1', название: 'Осенний' }))

    renderOutfits()
    await screen.findByRole('list')

    fireEvent.click(screen.getByRole('button', { name: 'Удалить Осенний' }))

    const диалог = await screen.findByRole('alertdialog', { name: 'Подтверждение удаления' })
    expect(диалог).toHaveAttribute('aria-modal', 'true')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Отмена' })).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Удалить Осенний' })).toHaveFocus(),
    )
    expect(await screen.findByText('Осенний')).toBeInTheDocument()
    expect(await outfits.get('образ-1')).toBeDefined()
  })

  it('Escape закрывает подтверждение удаления и не трогает образ', async () => {
    await outfits.create(makeOutfit({ id: 'образ-1', название: 'Осенний' }))

    renderOutfits()
    await screen.findByRole('list')

    fireEvent.click(screen.getByRole('button', { name: 'Удалить Осенний' }))
    const диалог = await screen.findByRole('alertdialog', { name: 'Подтверждение удаления' })
    fireEvent.keyDown(диалог, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Подтверждение удаления' })).toBeNull(),
    )
    expect(await screen.findByText('Осенний')).toBeInTheDocument()
    expect(await outfits.get('образ-1')).toBeDefined()
  })

  it('открытие образа ведёт на /outfit/:id', async () => {
    await items.create(makeItem({ id: 'в-1', название: 'Худи' }))
    await outfits.create(
      makeOutfit({ id: 'образ-1', название: 'Осенний', элементы: [элемент('в-1', 0)] }),
    )

    renderOutfits()
    await screen.findByRole('list')

    fireEvent.click(screen.getByRole('button', { name: 'Открыть образ Осенний' }))

    expect(await screen.findByRole('heading', { name: 'Образ' })).toBeInTheDocument()
    expect(await screen.findByDisplayValue('Осенний')).toBeInTheDocument()
  })

  it('если рендер обложки падает, карточка всё равно рисуется с первой вещью', async () => {
    await items.create(makeItem({ id: 'в-1', название: 'Худи' }))
    await images.addOriginal(
      makeImage('и-1', 'в-1', 'оригинал', '2024-01-01T00:00:00.000Z', 'orig'),
    )
    await outfits.create(
      makeOutfit({ id: 'образ-1', название: 'Осенний', элементы: [элемент('в-1', 0)] }),
    )

    renderOutfits()

    const кнопка = await screen.findByRole('button', { name: 'Открыть образ Осенний' })
    expect(within(кнопка).getByText('демисезон')).toBeInTheDocument()
    expect(within(кнопка).getByText('1 вещь')).toBeInTheDocument()
    // Коллаж не собрался — на месте обложки первая вещь (её blob).
    await waitFor(() => expect(кнопка.querySelector('img')?.getAttribute('src')).toBe('blob:orig'))
  })
})
