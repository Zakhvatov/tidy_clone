import 'fake-indexeddb/auto'

import { deleteDB } from 'idb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ImageRole, Изображение, Вещь } from '../domain/types'
import { DB_NAME, closeDb } from '../storage/db'
import * as images from '../storage/images'
import * as items from '../storage/items'
import { loadQueue, saveQueue } from '../storage/queue'
import { loadWardrobe } from './wardrobe'
import { DigitizeQueue, progressOf, type DigitizeQueueOptions } from './digitize-queue'
import { TidyApiError } from './tidy-api'

function makeItem(overrides: Partial<Вещь> = {}): Вещь {
  const дата = '2024-01-01T00:00:00.000Z'
  return {
    id: 'вещь-1',
    название: 'Худи тестовое',
    категория: 'Второй слой',
    подкатегория: 'худи',
    цвета: [],
    состав: [],
    сезон: [],
    бренд: '',
    источник: 'фото',
    датаСоздания: дата,
    датаОбновления: дата,
    idИзображений: [],
    ...overrides,
  }
}

function makeImage(id: string, idВещи: string, роль: ImageRole): Изображение {
  return {
    id,
    idВещи,
    роль,
    blob: new Blob(['оригинал'], { type: 'image/png' }),
    ширина: 512,
    высота: 512,
    mime: 'image/png',
    датаСоздания: '2024-01-01T00:00:00.000Z',
  }
}

const MODEL = { isPackshot: false, whiteness: 0, uniformity: 0.2, reason: 'модель' }

/** Создаёт `count` вещей, у каждой — Оригинал. */
async function seed(count: number): Promise<void> {
  for (let n = 1; n <= count; n += 1) {
    await items.create(makeItem({ id: `вещь-${n}`, название: `Вещь ${n}` }))
    await images.addOriginal(makeImage(`ор-${n}`, `вещь-${n}`, 'оригинал'))
  }
}

function aiBlob(): Blob {
  return new Blob(['ai'], { type: 'image/jpeg' })
}

function idFactory(prefix: string): () => string {
  let n = 0
  return () => `${prefix}-${++n}`
}

function queueOptions(overrides: Partial<DigitizeQueueOptions> = {}): DigitizeQueueOptions {
  return {
    measure: async () => ({ ширина: 1024, высота: 1024 }),
    now: () => new Date().toISOString(),
    analyze: async () => MODEL,
    sleep: async () => undefined,
    retryDelayMs: 0,
    ...overrides,
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('таймаут ожидания условия')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

async function countByRole(роль: ImageRole): Promise<number> {
  const entries = await loadWardrobe()
  return entries.flatMap((entry) => entry.изображения).filter((image) => image.роль === роль).length
}

describe('Очередь оцифровки (T12)', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  afterEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('20 вещей подряд оцифровываются без потерь', async () => {
    await seed(20)
    const generate = vi.fn(async () => aiBlob())
    const queue = new DigitizeQueue(queueOptions({ generate, id: idFactory('ai') }))

    await queue.start()

    expect(queue.progress).toMatchObject({
      статус: 'завершена',
      всего: 20,
      обработано: 20,
      успехов: 20,
      ошибок: 0,
      осталось: 0,
    })
    expect(generate).toHaveBeenCalledTimes(20)
    expect(await countByRole('ai')).toBe(20)
    // Сырьевые снимки удалены после успеха (ADR-0006 §4) — для вещей «фото».
    expect(await countByRole('оригинал')).toBe(0)

    // Состояние очереди действительно персистится.
    const persisted = await loadQueue()
    expect(persisted?.статус).toBe('завершена')
    expect(persisted?.задачи).toHaveLength(20)
  })

  it('когда оцифровывать нечего, повторный запуск очищает сохранённую очередь', async () => {
    await seed(2)
    const queue = new DigitizeQueue(queueOptions({ generate: async () => aiBlob(), id: idFactory('ai') }))
    await queue.start()
    expect(await loadQueue()).toBeDefined()

    await queue.start()

    expect(queue.progress.статус).toBe('завершена')
    expect(queue.progress.всего).toBe(0)
    // Старая очередь из хранилища убрана — продолжать больше нечего.
    expect(await loadQueue()).toBeUndefined()
  })

  it('событие onDigitized летит после каждой успешной оцифровки', async () => {
    await seed(3)
    const queue = new DigitizeQueue(queueOptions({ generate: async () => aiBlob(), id: idFactory('ai') }))
    const событие = vi.fn()
    queue.onDigitized(событие)

    await queue.start()

    expect(событие).toHaveBeenCalledTimes(3)
    expect(new Set(событие.mock.calls.map(([id]) => id))).toEqual(
      new Set(['вещь-1', 'вещь-2', 'вещь-3']),
    )

    // Отписанный слушатель больше не получает событий.
    await items.create(makeItem({ id: 'вещь-4', название: 'Вещь 4' }))
    await images.addOriginal(makeImage('ор-4', 'вещь-4', 'оригинал'))
    const queue2 = new DigitizeQueue(queueOptions({ generate: async () => aiBlob(), id: idFactory('b') }))
    const событие2 = vi.fn()
    queue2.onDigitized(событие2)()
    await queue2.start()
    expect(событие2).not.toHaveBeenCalled()
  })

  it('сбой одной вещи не рушит остальные', async () => {
    await seed(5)
    const generate = vi.fn(async (вещь: Вещь) => {
      if (вещь.id === 'вещь-3') throw new Error('модель упала')
      return aiBlob()
    })
    const queue = new DigitizeQueue(queueOptions({ generate, maxAttempts: 1, id: idFactory('ai') }))

    await queue.start()

    expect(queue.progress.успехов).toBe(4)
    expect(queue.progress.ошибок).toBe(1)
    expect(queue.progress.осталось).toBe(0)
    expect(queue.progress.последняяОшибка).toBe('модель упала')
    expect(await countByRole('ai')).toBe(4)

    // Провалившаяся вещь не потеряна: Оригинал на месте, вещь в хранилище.
    const сбойная = await loadWardrobe()
    const entry = сбойная.find((e) => e.вещь.id === 'вещь-3')
    expect(entry?.изображения.some((i) => i.роль === 'оригинал')).toBe(true)
    expect(entry?.изображения.some((i) => i.роль === 'ai')).toBe(false)
  })

  it('до 3 попыток на вещь с паузой, затем успех', async () => {
    await seed(1)
    let calls = 0
    const generate = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw new Error('временная сеть')
      return aiBlob()
    })
    const sleep = vi.fn(async () => undefined)
    const queue = new DigitizeQueue(
      queueOptions({ generate, maxAttempts: 3, sleep, id: idFactory('ai') }),
    )

    await queue.start()

    expect(generate).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(queue.progress.успехов).toBe(1)
    expect(queue.progress.ошибок).toBe(0)
  })

  it('исчерпание попыток помечает вещь «не удалось», очередь идёт дальше', async () => {
    await seed(3)
    const generate = vi.fn(async (вещь: Вещь) => {
      if (вещь.id === 'вещь-2') throw new Error('всегда падает')
      return aiBlob()
    })
    const queue = new DigitizeQueue(queueOptions({ generate, maxAttempts: 3, id: idFactory('ai') }))

    await queue.start()

    expect(generate).toHaveBeenCalledTimes(5) // 1 + 3 (повторы) + 1
    expect(queue.progress.успехов).toBe(2)
    expect(queue.progress.ошибок).toBe(1)
    expect(queue.progress.статус).toBe('завершена')
  })

  it('dismiss забывает завершённую очередь: сводка не висит, хранилище чистое', async () => {
    await seed(1)
    const generate = vi.fn(async () => {
      throw new Error('Не удалось связаться с сервисом')
    })
    const queue = new DigitizeQueue(queueOptions({ generate, maxAttempts: 1, id: idFactory('ai') }))

    await queue.start()
    expect(queue.progress.статус).toBe('завершена')
    expect(queue.progress.последняяОшибка).toBe('Не удалось связаться с сервисом')

    await queue.dismiss()

    expect(queue.progress.статус).toBe('пусто')
    expect(queue.progress.всего).toBe(0)
    expect(await loadQueue()).toBeUndefined()
  })

  it('429 rate_limited — повторяемая ошибка: вещь доходит до успеха', async () => {
    await seed(1)
    let calls = 0
    const generate = vi.fn(async () => {
      calls += 1
      if (calls <= 2) {
        throw new TidyApiError('rate_limited', 'Слишком много запросов к сервису. Подождите минуту.')
      }
      return aiBlob()
    })
    const queue = new DigitizeQueue(queueOptions({ generate, maxAttempts: 3, id: idFactory('ai') }))

    await queue.start()

    expect(calls).toBe(3)
    expect(queue.progress.успехов).toBe(1)
    expect(queue.progress.ошибок).toBe(0)
  })

  it('401 unauthorized — понятная ошибка, очередь останавливается, вещь не теряется', async () => {
    await seed(3)
    const generate = vi.fn(async () => {
      throw new TidyApiError('unauthorized', 'Сервис отклонил запрос: неверный или отсутствующий клиентский токен')
    })
    const queue = new DigitizeQueue(queueOptions({ generate, id: idFactory('ai') }))

    await queue.start()

    expect(generate).toHaveBeenCalledTimes(1) // токен не лечится повтором
    expect(queue.progress.статус).toBe('остановлена')
    expect(queue.progress.последняяОшибка).toMatch(/клиентский токен/)
    expect(queue.progress.успехов).toBe(0)
    expect(queue.progress.ошибок).toBe(0) // не «не удалось»: токен можно починить и продолжить
    expect(queue.progress.осталось).toBe(3)

    // Ни одна вещь не потеряна, у всех на месте Оригинал.
    expect(await countByRole('оригинал')).toBe(3)
    expect(await items.count()).toBe(3)
  })

  it('402 billing — очередь останавливается, повтор не тратит деньги', async () => {
    await seed(3)
    const generate = vi.fn(async () => {
      throw new TidyApiError('billing', 'Закончился баланс генерации. Пополните кошелёк сервиса.')
    })
    const queue = new DigitizeQueue(queueOptions({ generate, id: idFactory('ai') }))

    await queue.start()

    expect(generate).toHaveBeenCalledTimes(1)
    expect(queue.progress.статус).toBe('остановлена')
    expect(queue.progress.последняяОшибка).toMatch(/баланс/i)
    expect(queue.progress.осталось).toBe(3)
  })

  it('возобновление после «перезапуска» продолжает с того же места', async () => {
    await seed(6)
    let callsA = 0
    const generateA = vi.fn(async () => {
      callsA += 1
      if (callsA > 3) throw new TidyApiError('unauthorized', 'нет токена')
      return aiBlob()
    })
    const queueA = new DigitizeQueue(queueOptions({ generate: generateA, id: idFactory('aiA') }))
    await queueA.start()

    expect(queueA.progress.успехов).toBe(3)
    expect(queueA.progress.осталось).toBe(3)
    expect(queueA.progress.статус).toBe('остановлена')

    // «Закрыли приложение»: соединение с БД разорвано, движок потерян.
    await closeDb()

    const generateB = vi.fn(async () => aiBlob())
    const queueB = new DigitizeQueue(queueOptions({ generate: generateB, id: idFactory('aiB') }))
    await queueB.refresh()
    // Экран при открытии видит незавершённую очередь и предлагает продолжить.
    expect(queueB.progress.статус).toBe('остановлена')
    expect(queueB.progress.осталось).toBe(3)

    await queueB.resume()

    expect(queueB.progress.статус).toBe('завершена')
    expect(queueB.progress.успехов).toBe(6)
    expect(queueB.progress.ошибок).toBe(0)
    expect(generateB).toHaveBeenCalledTimes(3) // только оставшиеся три вещи
    expect(await countByRole('ai')).toBe(6)
  })

  it('повторный запуск идемпотентен: второй AI-версии не появляется', async () => {
    await seed(2)
    const generate = vi.fn(async () => aiBlob())
    const queue = new DigitizeQueue(queueOptions({ generate, id: idFactory('ai') }))

    await queue.start()
    expect(queue.progress.успехов).toBe(2)

    await queue.start()
    expect(queue.progress.всего).toBe(0)
    expect(generate).toHaveBeenCalledTimes(2)
    expect(await countByRole('ai')).toBe(2)
  })

  it('остановка по кнопке возвращает текущую вещь в очередь и сохраняет прогресс', async () => {
    await seed(5)
    let releaseGate: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const generate = vi.fn(async (_вещь: Вещь, _ориг: Blob, _prompt: string, signal?: AbortSignal) => {
      await gate
      if (signal?.aborted) throw new TidyApiError('aborted', 'Запрос отменён')
      return aiBlob()
    })
    const queue = new DigitizeQueue(queueOptions({ generate, id: idFactory('ai') }))

    const running = queue.start()
    await waitUntil(() => queue.running && generate.mock.calls.length === 1)

    queue.stop()
    releaseGate()
    await running

    expect(queue.progress.статус).toBe('остановлена')
    expect(queue.progress.успехов).toBe(0)
    expect(queue.progress.осталось).toBe(5)
    expect(await countByRole('ai')).toBe(0)

    // Возобновление после остановки доводит очередь до конца.
    const queue2 = new DigitizeQueue(queueOptions({ generate: vi.fn(async () => aiBlob()), id: idFactory('b') }))
    await queue2.resume()
    expect(queue2.progress.успехов).toBe(5)
  })

  it('refresh после закрытия приложения показывает прерванную очередь как остановленную', async () => {
    const now = '2024-01-01T00:00:00.000Z'
    await saveQueue({
      id: 'active',
      статус: 'выполняется',
      задачи: [
        {
          id: 'вещь-1',
          idВещи: 'вещь-1',
          название: 'Вещь 1',
          способ: 'ai',
          статус: 'готово',
          попытки: 1,
          датаСоздания: now,
          датаОбновления: now,
        },
        {
          id: 'вещь-2',
          idВещи: 'вещь-2',
          название: 'Вещь 2',
          способ: null,
          статус: 'в работе',
          попытки: 1,
          датаСоздания: now,
          датаОбновления: now,
        },
      ],
      текущая: 'вещь-2',
      датаНачала: now,
      датаОбновления: now,
    })

    const queue = new DigitizeQueue(queueOptions())
    await queue.refresh()

    // Движка уже нет, поэтому «выполняется» превращается в «остановлена»,
    // а прерванная задача возвращается в очередь — её можно продолжить.
    expect(queue.progress.статус).toBe('остановлена')
    expect(queue.progress.успехов).toBe(1)
    expect(queue.progress.осталось).toBe(1)
    expect(queue.progress.текущая).toBeUndefined()
  })

  it('progressOf сводит состояние в счётчики', () => {
    const now = '2024-01-01T00:00:00.000Z'
    const progress = progressOf({
      id: 'active',
      статус: 'остановлена',
      задачи: [
        { id: 'a', idВещи: 'a', название: 'A', способ: 'ai', статус: 'готово', попытки: 1, датаСоздания: now, датаОбновления: now },
        { id: 'b', idВещи: 'b', название: 'B', способ: null, статус: 'не удалось', попытки: 3, датаСоздания: now, датаОбновления: now },
        { id: 'c', idВещи: 'c', название: 'C', способ: null, статус: 'ожидает', попытки: 0, датаСоздания: now, датаОбновления: now },
      ],
      текущая: 'c',
      датаНачала: now,
      датаОбновления: now,
    })
    expect(progress).toMatchObject({ всего: 3, обработано: 2, успехов: 1, ошибок: 1, осталось: 1, текущая: 'C' })
    expect(progressOf(null)).toMatchObject({ статус: 'пусто', всего: 0 })
  })
})
