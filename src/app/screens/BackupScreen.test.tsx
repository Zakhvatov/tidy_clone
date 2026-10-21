import 'fake-indexeddb/auto'

import { Blob as NodeBlob } from 'node:buffer'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { deleteDB } from 'idb'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Изображение, Образ, Вещь } from '../../domain/types'
import { buildBackup } from '../../services/backup'
import { DB_NAME, closeDb, getDb } from '../../storage/db'
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
    сезон: ['демисезон'],
    бренд: '',
    источник: 'фото',
    датаСоздания: дата,
    датаОбновления: дата,
    idИзображений: [],
    ...overrides,
  }
}

function makeImage(id: string, idВещи: string, байты: number[]): Изображение {
  return {
    id,
    idВещи,
    роль: 'оригинал',
    blob: new Blob([new Uint8Array(байты)], { type: 'image/png' }),
    ширина: 512,
    высота: 512,
    mime: 'image/png',
    датаСоздания: '2024-03-05T10:00:01.000Z',
  }
}

function makeOutfit(): Образ {
  return {
    id: 'образ-1',
    название: 'Образ',
    сезон: 'демисезон',
    элементы: [{ idВещи: 'вещь-1', позиция: { x: 0, y: 0 }, масштаб: 1, zПорядок: 0 }],
    датаСоздания: '2024-04-01T00:00:00.000Z',
  }
}

async function засеять(): Promise<void> {
  await items.create(makeItem({ idИзображений: ['изобр-1'] }))
  await images.addOriginal(makeImage('изобр-1', 'вещь-1', [1, 2, 3, 4]))
  await outfits.create(makeOutfit())
}

async function очистить(): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['items', 'images', 'outfits'], 'readwrite')
  await Promise.all([
    tx.objectStore('items').clear(),
    tx.objectStore('images').clear(),
    tx.objectStore('outfits').clear(),
  ])
  await tx.done
}

function renderBackup() {
  return render(
    <MemoryRouter initialEntries={['/backup']}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

function выбратьФайл(содержимое: string): void {
  const input = screen.getByLabelText(/Выбрать файл резервной копии/i)
  const file = new File([содержимое], 'backup.json', { type: 'application/json' })
  fireEvent.change(input, { target: { files: [file] } })
}

describe('Экран резервной копии (T19)', () => {
  // См. пояснение в `backup.test.ts`: fake-indexeddb не клонирует jsdom-Blob.
  beforeAll(() => {
    vi.stubGlobal('Blob', NodeBlob)
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
    window.localStorage.clear()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:backup'),
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

  it('доступен из навигации и по адресу /backup', () => {
    renderBackup()
    expect(screen.getByRole('heading', { name: 'Резервная копия' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Данные' })).toBeInTheDocument()
  })

  it('карточка доступа показывает маскированный токен и ведёт на /access', () => {
    window.localStorage.setItem('tidy.accessToken', 'abcdef12345649f6')
    renderBackup()

    expect(screen.getByRole('heading', { name: 'Доступ к генерации' })).toBeInTheDocument()
    expect(screen.getByText('••••••••49f6')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Изменить токен' })).toHaveAttribute('href', '/access')
  })

  it('без токена предлагает его ввести', () => {
    renderBackup()

    expect(screen.getByText(/Токен не задан/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ввести токен' })).toHaveAttribute('href', '/access')
  })

  it('экспортирует гардероб одним файлом и сообщает итог', async () => {
    await засеять()
    renderBackup()

    fireEvent.click(screen.getByRole('button', { name: 'Экспортировать гардероб' }))

    expect(await screen.findByText(/Файл сохранён: 1 вещь, 1 изображение, 1 образ/)).toBeInTheDocument()
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)

    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as unknown as Blob
    const копия = JSON.parse(await blob.text()) as { вещи: unknown[]; изображения: unknown[] }
    expect(копия.вещи).toHaveLength(1)
    expect(копия.изображения).toHaveLength(1)
  })

  it('показывает план и восстанавливает гардероб после подтверждения', async () => {
    await засеять()
    const копия = await buildBackup()
    const содержимое = JSON.stringify(копия)
    await очистить()

    renderBackup()
    выбратьФайл(содержимое)

    expect(await screen.findByText(/В файле: 1 вещь, 1 изображение, 1 образ/)).toBeInTheDocument()
    expect(screen.getByText(/Будет добавлено: 1 вещь, 1 изображение, 1 образ/)).toBeInTheDocument()
    // До подтверждения база ещё пуста.
    expect(await items.count()).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Импортировать' }))

    expect(await screen.findByText(/Импорт завершён/)).toBeInTheDocument()
    expect(await items.count()).toBe(1)
    const восстановленный = await images.get('изобр-1')
    expect(восстановленный?.blob.size).toBe(4)
  })

  it('битый файл показывает понятную ошибку и не трогает базу', async () => {
    await засеять()
    renderBackup()

    выбратьФайл('<html>это не резервная копия</html>')

    expect(await screen.findByRole('alert')).toHaveTextContent('не удалось прочитать JSON')
    expect(await items.count()).toBe(1)
  })

  it('файл более новой версии показывает понятную ошибку', async () => {
    await засеять()
    renderBackup()

    выбратьФайл(JSON.stringify({ format: 'tidy-clone-wardrobe', formatVersion: 99 }))

    expect(await screen.findByRole('alert')).toHaveTextContent('более новой версией')
    await waitFor(async () => expect(await items.count()).toBe(1))
  })
})
