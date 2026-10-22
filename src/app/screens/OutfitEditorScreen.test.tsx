import 'fake-indexeddb/auto'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { deleteDB } from 'idb'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ImageRole, Изображение, Образ, Вещь } from '../../domain/types'
import { позицияПоУмолчанию } from '../../services/outfit-render'
import { DB_NAME, closeDb } from '../../storage/db'
import * as images from '../../storage/images'
import * as items from '../../storage/items'
import * as outfits from '../../storage/outfits'
import { AppRoutes } from '../App'

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

function renderEditor(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/outfit/${id}`]}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

/** Добавляет вещь в коллаж одним нажатием и возвращает её узел на холсте. */
async function добавитьЧерезПикер(название: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: `Добавить ${название}` }))
  return await screen.findByRole('button', { name: `Элемент: ${название}` })
}

describe('Редактор коллажа (T16) и пикер вещей (T17)', () => {
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
    await closeDb()
    await deleteDB(DB_NAME)
    localStorage.clear()
  })

  it('добавляет вещь из пикера в коллаж одним нажатием', async () => {
    await items.create(makeItem({ id: 'в-1', название: 'Худи' }))
    await images.addOriginal(
      makeImage('о-1', 'в-1', 'оригинал', '2024-01-01T00:00:00.000Z', 'orig'),
    )

    renderEditor('new')

    expect(await screen.findByRole('heading', { name: 'Новый образ' })).toBeInTheDocument()
    await добавитьЧерезПикер('Худи')

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить образ' }))

    await waitFor(async () => {
      const список = await outfits.list()
      expect(список).toHaveLength(1)
      expect(список[0]?.элементы.map((элемент) => элемент.idВещи)).toEqual(['в-1'])
    })
  })

  it('перетаскивание меняет позицию и сохраняется', async () => {
    await items.create(makeItem({ id: 'в-1', название: 'Худи' }))
    await images.addOriginal(
      makeImage('о-1', 'в-1', 'оригинал', '2024-01-01T00:00:00.000Z', 'orig'),
    )

    renderEditor('new')
    const элемент = await добавитьЧерезПикер('Худи')

    fireEvent.pointerDown(элемент, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(элемент, { clientX: 180, clientY: 140 })
    fireEvent.pointerUp(элемент, { clientX: 180, clientY: 140 })

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить образ' }))

    await waitFor(async () => {
      const список = await outfits.list()
      const позиция = список[0]?.элементы[0]?.позиция
      expect(позиция).toBeDefined()
      expect(позиция).not.toEqual(позицияПоУмолчанию(0))
    })
  })

  it('масштаб меняется щипком двумя пальцами на вещи', async () => {
    await items.create(makeItem({ id: 'в-1', название: 'Худи' }))
    await images.addOriginal(
      makeImage('о-1', 'в-1', 'оригинал', '2024-01-01T00:00:00.000Z', 'orig'),
    )

    renderEditor('new')
    const элемент = await добавитьЧерезПикер('Худи')

    expect(await screen.findByRole('slider', { name: 'Масштаб' })).toHaveValue('100')

    fireEvent.pointerDown(элемент, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerDown(элемент, { pointerId: 2, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(элемент, { pointerId: 2, clientX: 300, clientY: 100 })

    expect(screen.getByRole('slider', { name: 'Масштаб' })).toHaveValue('200')

    fireEvent.pointerUp(элемент, { pointerId: 2, clientX: 300, clientY: 100 })
    fireEvent.pointerUp(элемент, { pointerId: 1, clientX: 100, clientY: 100 })

    expect(screen.getByRole('slider', { name: 'Масштаб' })).toHaveValue('200')

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить образ' }))

    await waitFor(async () => {
      const [сохранённый] = await outfits.list()
      const элементОбраза = сохранённый?.элементы.find(
        (элементОбраза) => элементОбраза.idВещи === 'в-1',
      )
      expect(элементОбраза?.масштаб).toBe(2)
    })
  })

  it('щипок ограничен пределами; pointercancel и отпущенный палец не ломают жест', async () => {
    await items.create(makeItem({ id: 'в-1', название: 'Худи' }))
    await images.addOriginal(
      makeImage('о-1', 'в-1', 'оригинал', '2024-01-01T00:00:00.000Z', 'orig'),
    )

    renderEditor('new')
    const элемент = await добавитьЧерезПикер('Худи')

    fireEvent.pointerDown(элемент, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerDown(элемент, { pointerId: 2, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(элемент, { pointerId: 2, clientX: 900, clientY: 100 })
    expect(screen.getByRole('slider', { name: 'Масштаб' })).toHaveValue('250')

    fireEvent.pointerCancel(элемент, { pointerId: 2, clientX: 900, clientY: 100 })
    fireEvent.pointerMove(элемент, { pointerId: 1, clientX: 200, clientY: 200 })
    fireEvent.pointerCancel(элемент, { pointerId: 1, clientX: 200, clientY: 200 })

    fireEvent.pointerDown(элемент, { pointerId: 3, clientX: 100, clientY: 100 })
    fireEvent.pointerDown(элемент, { pointerId: 4, clientX: 300, clientY: 100 })
    fireEvent.pointerMove(элемент, { pointerId: 4, clientX: 100, clientY: 100 })
    expect(screen.getByRole('slider', { name: 'Масштаб' })).toHaveValue('30')

    fireEvent.pointerUp(элемент, { pointerId: 3, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(элемент, { pointerId: 4, clientX: 100, clientY: 100 })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить образ' }))

    await waitFor(async () => {
      const [сохранённый] = await outfits.list()
      const элементОбраза = сохранённый?.элементы.find(
        (элементОбраза) => элементОбраза.idВещи === 'в-1',
      )
      expect(элементОбраза?.масштаб).toBeCloseTo(0.3)
      expect(элементОбраза?.позиция).not.toEqual(позицияПоУмолчанию(0))
    })
  })

  it('изменение порядка слоёв и подложки сохраняется', async () => {
    await items.create(
      makeItem({ id: 'в-1', название: 'Платье', категория: 'Платья', подкатегория: 'платье' }),
    )
    await items.create(
      makeItem({ id: 'в-2', название: 'Кроссовки', категория: 'Обувь', подкатегория: 'кроссовки' }),
    )
    await images.addOriginal(
      makeImage('о-1', 'в-1', 'оригинал', '2024-01-01T00:00:00.000Z', 'o1'),
    )
    await images.addOriginal(
      makeImage('о-2', 'в-2', 'оригинал', '2024-01-02T00:00:00.000Z', 'o2'),
    )

    renderEditor('new')
    await добавитьЧерезПикер('Платье')
    fireEvent.click(await screen.findByRole('tab', { name: /Обувь/ }))
    await добавитьЧерезПикер('Кроссовки')

    // Платье поднимаем на самый верхний слой.
    fireEvent.click(await screen.findByRole('button', { name: 'Элемент: Платье' }))
    fireEvent.click(screen.getByRole('button', { name: 'Наверх' }))

    fireEvent.click(screen.getByRole('button', { name: 'Тёмный' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить образ' }))

    await waitFor(async () => {
      expect(await outfits.list()).toHaveLength(1)
    })

    const [сохранённый] = await outfits.list()
    const платье = сохранённый?.элементы.find((элемент) => элемент.idВещи === 'в-1')
    const кроссовки = сохранённый?.элементы.find((элемент) => элемент.idВещи === 'в-2')
    expect(платье?.zПорядок).toBeGreaterThan(кроссовки?.zПорядок ?? -1)

    // «Перезапуск»: закрываем и заново открываем БД.
    await closeDb()
    const перечитан = await outfits.get(сохранённый?.id ?? '')
    expect(
      перечитан?.элементы.find((элемент) => элемент.idВещи === 'в-1')?.zПорядок,
    ).toBeGreaterThan(
      перечитан?.элементы.find((элемент) => элемент.idВещи === 'в-2')?.zПорядок ?? -1,
    )

    // Подложка выбрана и сохранена рядом с устройством.
    expect(localStorage.getItem(`tidy.outfit.background.${сохранённый?.id ?? ''}`)).toBe('#1B1B1B')

    // Перезапуск интерфейса: подложка снова активна.
    renderEditor(сохранённый?.id ?? '')
    const тёмный = await screen.findByRole('button', { name: 'Тёмный' })
    expect(тёмный).toHaveAttribute('aria-pressed', 'true')
  })

  it('образ из 5 вещей собирается через UI, сохраняется и перечитывается после перезапуска', async () => {
    for (let index = 0; index < 5; index += 1) {
      await items.create(
        makeItem({
          id: `в-${index}`,
          название: `Вещь ${index}`,
          категория: 'Верх',
          подкатегория: 'футболка',
        }),
      )
      await images.addOriginal(
        makeImage(
          `о-${index}`,
          `в-${index}`,
          'оригинал',
          `2024-01-0${index + 1}T00:00:00.000Z`,
          `o${index}`,
        ),
      )
    }

    renderEditor('new')
    for (let index = 0; index < 5; index += 1) {
      await добавитьЧерезПикер(`Вещь ${index}`)
    }

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить образ' }))
    await waitFor(async () => {
      expect(await outfits.list()).toHaveLength(1)
    })

    await closeDb()
    const [сохранённый] = await outfits.list()
    expect(сохранённый?.элементы).toHaveLength(5)
    expect(сохранённый?.элементы.map((элемент) => элемент.zПорядок).sort()).toEqual([0, 1, 2, 3, 4])
  })

  it('образ из 5 вещей, собранный программно, переживает закрытие и открытие БД', async () => {
    for (let index = 0; index < 5; index += 1) {
      await items.create(makeItem({ id: `в-${index}`, название: `Вещь ${index}` }))
    }
    const образ: Образ = {
      id: 'образ-ручной',
      название: 'Собран вручную',
      сезон: 'лето',
      элементы: [0, 1, 2, 3, 4].map((index) => ({
        idВещи: `в-${index}`,
        позиция: { x: 100 + index * 20, y: 200 + index * 20 },
        масштаб: 1,
        zПорядок: index,
      })),
      датаСоздания: '2024-05-01T00:00:00.000Z',
    }
    await outfits.create(образ)

    await closeDb()

    const перечитан = await outfits.get('образ-ручной')
    expect(перечитан?.элементы).toHaveLength(5)
    expect(перечитан?.сезон).toBe('лето')
  })

  it('удаление элемента из коллажа не удаляет саму вещь', async () => {
    await items.create(makeItem({ id: 'в-1', название: 'Худи' }))
    await images.addOriginal(
      makeImage('о-1', 'в-1', 'оригинал', '2024-01-01T00:00:00.000Z', 'orig'),
    )

    renderEditor('new')
    await добавитьЧерезПикер('Худи')

    fireEvent.click(screen.getByRole('button', { name: 'Убрать из образа' }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Элемент: Худи' })).toBeNull(),
    )
    expect(await items.get('в-1')).toBeDefined()
  })

  it('пустой гардероб: в пикере понятное пустое состояние со ссылкой на /add', async () => {
    renderEditor('new')

    expect(await screen.findByText('В гардеробе пока нет вещей')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Добавить вещь' })).toHaveAttribute('href', '/add')
  })

  it('несуществующий образ: состояние «Образ не найден»', async () => {
    renderEditor('нет-такого')

    expect(await screen.findByRole('heading', { name: 'Образ не найден' })).toBeInTheDocument()
  })

  it('«Назад» без правок ведёт в список образов, а не в гардероб', async () => {
    renderEditor('new')

    expect(await screen.findByRole('heading', { name: 'Новый образ' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }))

    expect(await screen.findByRole('heading', { name: 'Образы' })).toBeInTheDocument()
  })

  it('несохранённые правки перехватывают «Назад»; Escape оставляет в редакторе', async () => {
    renderEditor('new')
    const поле = await screen.findByRole('textbox', { name: 'Название образа' })
    fireEvent.change(поле, { target: { value: 'Вечерний' } })

    fireEvent.click(screen.getByRole('button', { name: 'Назад' }))

    const диалог = await screen.findByRole('alertdialog', { name: 'Несохранённые изменения' })
    expect(диалог).toHaveAttribute('aria-modal', 'true')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Остаться' })).toHaveFocus())

    fireEvent.keyDown(диалог, { key: 'Escape' })

    await waitFor(() =>
      expect(
        screen.queryByRole('alertdialog', { name: 'Несохранённые изменения' }),
      ).toBeNull(),
    )
    expect(screen.getByRole('heading', { name: 'Новый образ' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Назад' })).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Выйти без сохранения' }))

    expect(await screen.findByRole('heading', { name: 'Образы' })).toBeInTheDocument()
  })

  it('несохранённые правки включают beforeunload, а после сохранения — нет', async () => {
    renderEditor('new')
    const поле = await screen.findByRole('textbox', { name: 'Название образа' })

    const событиеДо = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(событиеДо)
    expect(событиеДо.defaultPrevented).toBe(false)

    fireEvent.change(поле, { target: { value: 'Вечерний' } })
    const событиеПосле = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(событиеПосле)
    expect(событиеПосле.defaultPrevented).toBe(true)
  })

  it('«Сохранено» сменяется нейтральным индикатором после любой правки', async () => {
    await outfits.create({
      id: 'образ-1',
      название: 'Осенний',
      сезон: 'демисезон',
      элементы: [],
      датаСоздания: '2024-04-01T00:00:00.000Z',
    })

    renderEditor('образ-1')

    fireEvent.click(await screen.findByRole('button', { name: 'Сохранить образ' }))
    expect(await screen.findByText('Сохранено')).toBeInTheDocument()

    const поле = screen.getByRole('textbox', { name: 'Название образа' })
    fireEvent.change(поле, { target: { value: 'Зимний' } })

    expect(screen.queryByText('Сохранено')).toBeNull()
    expect(screen.getByText('Есть несохранённые изменения')).toBeInTheDocument()
  })

  it('пикер связывает табы с панелью через aria-controls и aria-labelledby', async () => {
    await items.create(makeItem({ id: 'в-1', название: 'Худи' }))

    renderEditor('new')

    const табы = await screen.findAllByRole('tab')
    const активный = табы.find((таб) => таб.getAttribute('aria-selected') === 'true')
    expect(активный).toBeDefined()
    expect(активный?.getAttribute('aria-controls')).toBeTruthy()

    const панель = await screen.findByRole('tabpanel')
    expect(панель.getAttribute('id')).toBe(активный?.getAttribute('aria-controls'))
    expect(панель.getAttribute('aria-labelledby')).toBe(активный?.getAttribute('id'))
  })

  it('существующий образ открывается с названием, сезоном и элементами', async () => {
    await items.create(makeItem({ id: 'в-1', название: 'Худи' }))
    await images.addOriginal(
      makeImage('о-1', 'в-1', 'оригинал', '2024-01-01T00:00:00.000Z', 'orig'),
    )
    await outfits.create({
      id: 'образ-1',
      название: 'Осенний',
      сезон: 'демисезон',
      элементы: [
        { idВещи: 'в-1', позиция: { x: 400, y: 500 }, масштаб: 1.5, zПорядок: 0 },
      ],
      датаСоздания: '2024-04-01T00:00:00.000Z',
    })

    renderEditor('образ-1')

    expect(await screen.findByDisplayValue('Осенний')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'демисезон' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Элемент: Худи' }))
    expect(await screen.findByRole('slider', { name: 'Масштаб' })).toHaveValue('150')
  })
})
