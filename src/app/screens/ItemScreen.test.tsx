import 'fake-indexeddb/auto'

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { deleteDB } from 'idb'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ImageRole, Изображение, Образ, Season, Вещь } from '../../domain/types'
import { DB_NAME, closeDb } from '../../storage/db'
import * as images from '../../storage/images'
import * as items from '../../storage/items'
import * as outfits from '../../storage/outfits'
import { AppRoutes } from '../App'
import { digitizeItem } from './digitizeBridge'

// Воркер/сервис оцифровки в тестах карточки заменяется моком: проверяем саму
// карточку, а не генерацию (её тесты живут в T10).
vi.mock('./digitizeBridge', () => ({ digitizeItem: vi.fn() }))

const mockedDigitize = vi.mocked(digitizeItem)

function makeItem(overrides: Partial<Вещь> = {}): Вещь {
  const дата = '2024-03-05T10:00:00.000Z'
  return {
    id: 'вещь-1',
    название: 'Худи тестовое',
    категория: 'Второй слой',
    подкатегория: 'худи',
    цвета: ['чёрный', 'белый'],
    состав: ['хлопок', 'полиэстер'],
    сезон: [],
    бренд: 'Тестовый бренд',
    источник: 'ссылка',
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

function makeOutfit(id: string, сезон: Season, idВещей: string[]): Образ {
  return {
    id,
    название: 'Летний образ',
    сезон,
    элементы: idВещей.map((idВещи, index) => ({
      idВещи,
      позиция: { x: index * 10, y: index * 10 },
      масштаб: 1,
      zПорядок: index,
    })),
    датаСоздания: '2024-04-01T00:00:00.000Z',
  }
}

function renderItem(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/item/${id}`]}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

describe('Карточка вещи (T15)', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
    mockedDigitize.mockReset()
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
  })

  it('по id показывает данные вещи: название, атрибуты, источник и категорию', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await images.addOriginal(
      makeImage('о-1', 'вещь-1', 'оригинал', '2024-03-05T10:00:00.000Z', 'orig'),
    )

    renderItem('вещь-1')

    expect(await screen.findByRole('heading', { name: 'Худи тестовое' })).toBeInTheDocument()
    const цвета = screen.getByRole('group', { name: 'Цвета вещи' })
    expect(within(цвета).getByRole('button', { name: 'чёрный' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(цвета).getByRole('button', { name: 'белый' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByText('хлопок, полиэстер')).toBeInTheDocument()
    expect(screen.getByText('Тестовый бренд')).toBeInTheDocument()
    expect(screen.getByText('Ссылка')).toBeInTheDocument()
    expect(screen.getByLabelText('Раздел')).toHaveValue('Второй слой')
    expect(screen.getByLabelText('Подкатегория')).toHaveValue('худи')

    const ожидаемаяДата = new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date('2024-03-05T10:00:00.000Z'))
    expect(screen.getByText(ожидаемаяДата)).toBeInTheDocument()
  })

  it('без AI-версии переключателя нет, показывается только оригинал', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await images.addOriginal(
      makeImage('о-1', 'вещь-1', 'оригинал', '2024-03-05T10:00:00.000Z', 'orig'),
    )

    renderItem('вещь-1')

    expect(await screen.findByRole('heading', { name: 'Худи тестовое' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Изображение' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Сделать AI-версию' })).toBeInTheDocument()
    expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:orig')
  })

  it('при наличии AI-версии переключатель меняет изображение, пометка «AI-версия» видна', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await images.addOriginal(
      makeImage('о-1', 'вещь-1', 'оригинал', '2024-03-05T10:00:00.000Z', 'orig'),
    )
    await images.addAiVersion(makeImage('а-1', 'вещь-1', 'ai', '2024-03-06T10:00:00.000Z', 'ai'))
    await images.addCutout(
      makeImage('в-1', 'вещь-1', 'вырез', '2024-03-07T10:00:00.000Z', 'cut'),
    )

    renderItem('вещь-1')

    const группа = await screen.findByRole('group', { name: 'Изображение' })
    expect(within(группа).getByRole('button', { name: 'Оригинал' })).toBeInTheDocument()
    expect(within(группа).getByRole('button', { name: 'AI-версия' })).toBeInTheDocument()
    expect(within(группа).getByRole('button', { name: 'Вырез' })).toBeInTheDocument()

    // По решению «Какое изображение где» по умолчанию показывается AI-версия.
    expect(await screen.findByRole('note')).toHaveTextContent('AI-версия')
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:ai')

    fireEvent.click(within(группа).getByRole('button', { name: 'Оригинал' }))
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:orig'))
    expect(screen.queryByRole('note')).toBeNull()

    fireEvent.click(within(группа).getByRole('button', { name: 'Вырез' }))
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:cut'))
    expect(screen.queryByRole('note')).toBeNull()

    fireEvent.click(within(группа).getByRole('button', { name: 'AI-версия' }))
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:ai'))
    expect(await screen.findByRole('note')).toHaveTextContent('AI-версия')
  })

  it('при наличии только выреза переключатель даёт выбрать Оригинал или Вырез, без AI', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await images.addOriginal(
      makeImage('о-1', 'вещь-1', 'оригинал', '2024-03-05T10:00:00.000Z', 'orig'),
    )
    await images.addCutout(
      makeImage('в-1', 'вещь-1', 'вырез', '2024-03-07T10:00:00.000Z', 'cut'),
    )

    renderItem('вещь-1')

    const группа = await screen.findByRole('group', { name: 'Изображение' })
    expect(within(группа).getByRole('button', { name: 'Оригинал' })).toBeInTheDocument()
    expect(within(группа).getByRole('button', { name: 'Вырез' })).toBeInTheDocument()
    expect(within(группа).queryByRole('button', { name: 'AI-версия' })).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()

    // Без AI-версии по умолчанию показывается оригинал.
    expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:orig')

    fireEvent.click(within(группа).getByRole('button', { name: 'Вырез' }))
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:cut'))
  })

  it('смена категории сохраняется в IndexedDB и переживает перезапуск', async () => {
    await items.create(
      makeItem({ id: 'вещь-1', категория: 'Верх', подкатегория: 'футболка' }),
    )
    await images.addOriginal(
      makeImage('о-1', 'вещь-1', 'оригинал', '2024-03-05T10:00:00.000Z', 'orig'),
    )

    renderItem('вещь-1')

    fireEvent.change(await screen.findByLabelText('Раздел'), { target: { value: 'Обувь' } })

    await waitFor(async () => {
      const сохранённая = await items.get('вещь-1')
      expect(сохранённая?.категория).toBe('Обувь')
      expect(сохранённая?.подкатегория).toBe('кроссовки')
    })

    // «Перезапуск»: закрываем и заново открываем БД — правка на месте.
    await closeDb()
    const послеПерезапуска = await items.get('вещь-1')
    expect(послеПерезапуска?.категория).toBe('Обувь')
    expect(послеПерезапуска?.подкатегория).toBe('кроссовки')
  })

  it('вещь из образа не удаляется: понятная ошибка, вещь на месте', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await images.addOriginal(
      makeImage('о-1', 'вещь-1', 'оригинал', '2024-03-05T10:00:00.000Z', 'orig'),
    )
    await outfits.create(makeOutfit('образ-1', 'лето', ['вещь-1']))

    renderItem('вещь-1')

    fireEvent.click(await screen.findByRole('button', { name: 'Удалить вещь' }))
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))

    const сообщение = await screen.findByRole('alert')
    expect(сообщение).toHaveTextContent(/входит в образ «Летний образ»/)
    expect(await items.get('вещь-1')).toBeDefined()
  })

  it('свободная вещь удаляется каскадом вместе с оригиналом и AI-версией', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await images.addOriginal(
      makeImage('о-1', 'вещь-1', 'оригинал', '2024-03-05T10:00:00.000Z', 'orig'),
    )
    await images.addAiVersion(makeImage('а-1', 'вещь-1', 'ai', '2024-03-06T10:00:00.000Z', 'ai'))

    renderItem('вещь-1')

    fireEvent.click(await screen.findByRole('button', { name: 'Удалить вещь' }))
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))

    expect(await screen.findByRole('heading', { name: 'Гардероб' })).toBeInTheDocument()
    expect(await items.get('вещь-1')).toBeUndefined()
    expect(await images.get('о-1')).toBeUndefined()
    expect(await images.get('а-1')).toBeUndefined()
  })

  it('несуществующий id: состояние «Вещь не найдена» и возврат в гардероб', async () => {
    renderItem('нет-такой-вещи')

    expect(await screen.findByRole('heading', { name: 'Вещь не найдена' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
    expect(await screen.findByRole('heading', { name: 'Гардероб' })).toBeInTheDocument()
  })

  it('AI-версия создаётся только по кнопке и появляется после оцифровки', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await images.addOriginal(
      makeImage('о-1', 'вещь-1', 'оригинал', '2024-03-05T10:00:00.000Z', 'orig'),
    )
    mockedDigitize.mockImplementation(async (idВещи) => {
      await images.addAiVersion(
        makeImage('а-1', idВещи, 'ai', '2024-03-06T10:00:00.000Z', 'ai'),
      )
    })

    renderItem('вещь-1')

    // Ничего не нажимали — генерации нет.
    expect(await screen.findByRole('heading', { name: 'Худи тестовое' })).toBeInTheDocument()
    expect(mockedDigitize).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Сделать AI-версию' }))

    await waitFor(() => expect(mockedDigitize).toHaveBeenCalledWith('вещь-1'))
    expect(await screen.findByRole('note')).toHaveTextContent('AI-версия')
    expect(await screen.findByRole('button', { name: 'Перегенерировать' })).toBeInTheDocument()
  })

  it('кнопка «Перегенерировать» вызывает принудительный режим force', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await images.addOriginal(
      makeImage('о-1', 'вещь-1', 'оригинал', '2024-03-05T10:00:00.000Z', 'orig'),
    )
    await images.addAiVersion(
      makeImage('а-старая', 'вещь-1', 'ai', '2024-03-06T10:00:00.000Z', 'ai-old'),
    )
    mockedDigitize.mockImplementation(async (idВещи: string) => {
      await images.addAiVersion(
        makeImage('а-новая', idВещи, 'ai', '2024-03-07T10:00:00.000Z', 'ai-new'),
      )
    })

    renderItem('вещь-1')
    fireEvent.click(await screen.findByRole('button', { name: 'Перегенерировать' }))

    // Именно force: иначе сервис T10 вернул бы «уже есть» и запрос бы не ушёл.
    await waitFor(() => expect(mockedDigitize).toHaveBeenCalledWith('вещь-1', { force: true }))
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:ai-new'))
  })

  it('ошибка лимита (429) и авторизации (401) показывается человеческим текстом', async () => {
    await items.create(makeItem({ id: 'вещь-1' }))
    await images.addOriginal(
      makeImage('о-1', 'вещь-1', 'оригинал', '2024-03-05T10:00:00.000Z', 'orig'),
    )
    mockedDigitize.mockRejectedValueOnce(Object.assign(new Error('лимит'), { code: 'rate_limited' }))

    renderItem('вещь-1')
    fireEvent.click(await screen.findByRole('button', { name: 'Сделать AI-версию' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Слишком много запросов на оцифровку (429)')

    mockedDigitize.mockRejectedValueOnce(Object.assign(new Error('нет доступа'), { code: 'unauthorized' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сделать AI-версию' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Сервис оцифровки отклонил запрос (401)',
    )
  })

  it('правка сезона в карточке сохраняется в IndexedDB и переживает перезапуск', async () => {
    await items.create(makeItem({ id: 'вещь-1', сезон: [] }))
    await images.addOriginal(
      makeImage('о-1', 'вещь-1', 'оригинал', '2024-03-05T10:00:00.000Z', 'orig'),
    )

    renderItem('вещь-1')

    const сезоны = await screen.findByRole('group', { name: 'Сезон вещи' })
    fireEvent.click(within(сезоны).getByRole('button', { name: 'лето' }))

    await waitFor(async () => {
      expect((await items.get('вещь-1'))?.сезон).toEqual(['лето'])
    })

    fireEvent.click(within(сезоны).getByRole('button', { name: 'демисезон' }))

    await waitFor(async () => {
      expect((await items.get('вещь-1'))?.сезон).toEqual(['лето', 'демисезон'])
    })

    // Повторное нажатие снимает сезон.
    fireEvent.click(within(сезоны).getByRole('button', { name: 'лето' }))
    await waitFor(async () => {
      expect((await items.get('вещь-1'))?.сезон).toEqual(['демисезон'])
    })

    // «Перезапуск»: закрываем и заново открываем БД — правка на месте.
    await closeDb()
    expect((await items.get('вещь-1'))?.сезон).toEqual(['демисезон'])
  })

  it('правка цветов в карточке сохраняется в IndexedDB и переживает перезапуск', async () => {
    await items.create(makeItem({ id: 'вещь-1', цвета: [] }))
    await images.addOriginal(
      makeImage('о-1', 'вещь-1', 'оригинал', '2024-03-05T10:00:00.000Z', 'orig'),
    )

    renderItem('вещь-1')

    const цвета = await screen.findByRole('group', { name: 'Цвета вещи' })
    fireEvent.click(within(цвета).getByRole('button', { name: 'синий' }))

    await waitFor(async () => {
      expect((await items.get('вещь-1'))?.цвета).toEqual(['синий'])
    })

    fireEvent.click(within(цвета).getByRole('button', { name: 'синий' }))
    await waitFor(async () => {
      expect((await items.get('вещь-1'))?.цвета).toEqual([])
    })

    await closeDb()
    expect((await items.get('вещь-1'))?.цвета).toEqual([])
  })
})
