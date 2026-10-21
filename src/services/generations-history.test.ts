import 'fake-indexeddb/auto'

import { deleteDB } from 'idb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Изображение } from '../domain/types'
import { DB_NAME, closeDb } from '../storage/db'
import * as images from '../storage/images'
import * as items from '../storage/items'
import { clearAccessToken, saveAccessToken } from '../storage/settings'
import {
  downloadHistoryImage,
  listGenerationHistory,
  restoreGeneration,
  type GenerationRecord,
  type RestoreGenerationDeps,
} from './generations-history'
import { TidyApiError } from './tidy-api'

/**
 * Подмена хранилища изображений с рычагом сбоя: тест отката включает
 * `failAddAi`, и `addAiVersion` падает, как при переполненной базе.
 */
const imagesState = vi.hoisted(() => ({ failAddAi: false }))

vi.mock('../storage/images', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage/images')>()
  return {
    ...actual,
    addAiVersion: vi.fn(async (изображение: Изображение) => {
      if (imagesState.failAddAi) throw new Error('Хранилище переполнено')
      return actual.addAiVersion(изображение)
    }),
  }
})

function makeRecord(overrides: Partial<GenerationRecord> = {}): GenerationRecord {
  return {
    taskId: 'task-1',
    title: 'Худи тестовое',
    prompt: 'redraw',
    model: 'nano-banana-2-1',
    costRub: 7,
    createdAt: '2026-10-21T10:00:00.000Z',
    ...overrides,
  }
}

/** Мок воркера: список генераций и байты картинок по `{taskId}`. */
function historyFetch(items: unknown[], imageTag = 'ai-байты') {
  return vi.fn(async (url: string | URL | Request): Promise<Response> => {
    const u = String(url)
    if (u.endsWith('/image')) {
      return new Response(new Blob([imageTag], { type: 'image/jpeg' }), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    if (u.endsWith('/generations')) {
      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'нет' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function baseDeps(): RestoreGenerationDeps {
  return {
    measure: async () => ({ ширина: 1024, высота: 1024 }),
    now: () => '2026-10-21T12:00:00.000Z',
  }
}

describe('История генераций (T23)', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
    window.localStorage.clear()
    saveAccessToken('test-token')
  })

  afterEach(async () => {
    clearAccessToken()
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('читает список: поля разбираются, битые записи пропускаются, токен уходит', async () => {
    const fetchImpl = historyFetch([
      makeRecord({
        itemId: 'вещь-1',
        category: 'Второй слой',
        subcategory: 'худи',
        contentType: 'image/png',
        size: 2048,
      }),
      'не объект',
      { title: 'Без taskId' },
      { taskId: '   ' },
      makeRecord({ taskId: 'task-2', title: '', prompt: '', model: '', costRub: null, createdAt: '' }),
    ])
    vi.stubGlobal('fetch', fetchImpl)

    const записи = await listGenerationHistory()

    expect(записи).toHaveLength(2)
    expect(записи[0]).toMatchObject({
      taskId: 'task-1',
      title: 'Худи тестовое',
      model: 'nano-banana-2-1',
      costRub: 7,
      createdAt: '2026-10-21T10:00:00.000Z',
      itemId: 'вещь-1',
      category: 'Второй слой',
      subcategory: 'худи',
      contentType: 'image/png',
      size: 2048,
    })
    // Пустые необязательные поля не приезжают как undefined-мусор.
    expect(записи[1]).toEqual({
      taskId: 'task-2',
      title: '',
      prompt: '',
      model: '',
      costRub: null,
      createdAt: '',
    })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/generations$/)
    expect((init.headers as Record<string, string>)['x-tidy-client']).toBe('test-token')
  })

  it('items не массив — invalid_response, а не тихий пустой список', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ items: 'не массив' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchImpl)

    const error = await listGenerationHistory().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TidyApiError)
    expect(error).toMatchObject({ code: 'invalid_response' })
  })

  it('401 от воркера приходит как unauthorized с понятным текстом', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { code: 'unauthorized', message: 'Неверный токен' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      ) as unknown as typeof fetch,
    )

    const error = await listGenerationHistory().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TidyApiError)
    expect(error).toMatchObject({ code: 'unauthorized' })
    expect((error as TidyApiError).message).toContain('токен')
  })

  it('картинка скачивается по /generations/{taskId}/image с кодировкой taskId', async () => {
    const fetchImpl = historyFetch([])
    vi.stubGlobal('fetch', fetchImpl)

    const blob = await downloadHistoryImage('task/1')

    expect(blob.size).toBeGreaterThan(0)
    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url).toMatch(/\/generations\/task%2F1\/image$/)
  })

  it('восстановление к существующей вещи: AI-версия дописывается, новой вещи нет', async () => {
    await items.create({
      id: 'вещь-1',
      название: 'Худи',
      категория: 'Второй слой',
      подкатегория: 'худи',
      цвета: [],
      состав: [],
      сезон: [],
      бренд: '',
      источник: 'фото',
      датаСоздания: '2026-10-01T00:00:00.000Z',
      датаОбновления: '2026-10-01T00:00:00.000Z',
      idИзображений: ['ор-1'],
    })
    const fetchImpl = historyFetch([])
    vi.stubGlobal('fetch', fetchImpl)

    const итог = await restoreGeneration(makeRecord({ itemId: 'вещь-1' }), {
      ...baseDeps(),
      download: async () => new Blob(['ai-байты'], { type: 'image/png' }),
    })

    expect(итог).toEqual({ itemId: 'вещь-1', imageId: 'ai-task-1', created: false })
    const ai = await images.get('ai-task-1')
    expect(ai).toMatchObject({
      id: 'ai-task-1',
      idВещи: 'вещь-1',
      роль: 'ai',
      mime: 'image/png',
      ширина: 1024,
      высота: 1024,
    })
    expect((await items.get('вещь-1'))?.idИзображений).toEqual(['ор-1', 'ai-task-1'])
    expect(await items.get('restored-task-1')).toBeUndefined()
  })

  it('восстановление без вещи создаёт новую: id, название, таксономия, источник', async () => {
    const fetchImpl = historyFetch([])
    vi.stubGlobal('fetch', fetchImpl)

    const итог = await restoreGeneration(
      makeRecord({ taskId: 'task-2', title: '  ', category: 'Такой нет', subcategory: 'хз' }),
      {
        ...baseDeps(),
        download: async () => new Blob(['байты'], { type: '' }),
        measure: async () => ({ ширина: 0, высота: 0 }),
      },
    )

    expect(итог).toEqual({ itemId: 'restored-task-2', imageId: 'ai-task-2', created: true })
    const вещь = await items.get('restored-task-2')
    expect(вещь).toMatchObject({
      название: 'AI-версия',
      категория: 'Разное',
      подкатегория: 'Разное',
      цвета: [],
      состав: [],
      сезон: [],
      бренд: '',
      источник: 'фото',
      idИзображений: ['ai-task-2'],
    })
    // Mime берётся из записи, когда у Blob тип не проставлен.
    expect(await images.get('ai-task-2')).toMatchObject({ роль: 'ai', mime: 'image/jpeg' })

    // Известная пара «категория — подкатегория» сохраняется как есть.
    const вторая = await restoreGeneration(
      makeRecord({ taskId: 'task-3', title: 'Юбка', category: 'Низ', subcategory: 'юбка' }),
      baseDeps(),
    )
    expect(вторая).toMatchObject({ itemId: 'restored-task-3', created: true })
    expect(await items.get('restored-task-3')).toMatchObject({
      категория: 'Низ',
      подкатегория: 'юбка',
      название: 'Юбка',
    })
  })

  it('повторное восстановление идемпотентно: скачиваний и дублей нет', async () => {
    const скачать = vi.fn(async () => new Blob(['байты'], { type: 'image/jpeg' }))
    const запись = makeRecord({ itemId: 'вещь-1', category: 'Второй слой', subcategory: 'худи' })

    await items.create({
      id: 'вещь-1',
      название: 'Худи',
      категория: 'Второй слой',
      подкатегория: 'худи',
      цвета: [],
      состав: [],
      сезон: [],
      бренд: '',
      источник: 'фото',
      датаСоздания: '2026-10-01T00:00:00.000Z',
      датаОбновления: '2026-10-01T00:00:00.000Z',
      idИзображений: [],
    })

    const первый = await restoreGeneration(запись, { ...baseDeps(), download: скачать })
    const второй = await restoreGeneration(запись, { ...baseDeps(), download: скачать })

    expect(первый.created).toBe(false)
    expect(второй).toEqual({ itemId: 'вещь-1', imageId: 'ai-task-1', created: false })
    expect(скачать).toHaveBeenCalledTimes(1)
    expect((await images.listByItem('вещь-1')).map((i) => i.id)).toEqual(['ai-task-1'])
    expect((await items.get('вещь-1'))?.idИзображений).toEqual(['ai-task-1'])
  })

  it('сбой сохранения картинки у новой вещи откатывает вещь', async () => {
    const fetchImpl = historyFetch([])
    vi.stubGlobal('fetch', fetchImpl)
    imagesState.failAddAi = true

    const error = await restoreGeneration(
      makeRecord({ taskId: 'task-4', itemId: undefined }),
      baseDeps(),
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Хранилище переполнено')
    expect(await items.get('restored-task-4')).toBeUndefined()
    expect(await images.get('ai-task-4')).toBeUndefined()

    // После сбоя гардероб чист: повторное восстановление проходит целиком.
    imagesState.failAddAi = false
    const повтор = await restoreGeneration(makeRecord({ taskId: 'task-4' }), baseDeps())
    expect(повтор).toMatchObject({ itemId: 'restored-task-4', created: true })
  })
})
