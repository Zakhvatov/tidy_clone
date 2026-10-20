import 'fake-indexeddb/auto'

import { deleteDB } from 'idb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DB_NAME, closeDb } from '../storage/db'
import { loadJob, saveJob, type ЗадачаГенерации } from '../storage/jobs'
import {
  GENERATION_SESSION_MS,
  ОшибкаГенерации,
  activeGenerationRun,
  grabGeneration,
  runGeneration,
  type GenerationRun,
} from './generation'
import { TidyApiError, type GenerationStatus } from './tidy-api'

/** Контролируемые часы: `сеанс` в пройти сравнивается с эпохой из now(). */
function clock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
    set(ms: number) {
      t = ms
    },
  }
}

function apiTask(status: string): GenerationStatus {
  return { taskId: 'task-1', status, costRub: 4 }
}

/** Зависимости с записью вызовов: create → статусы по порядку → скачивание. */
function deps(options: {
  statuses?: string[]
  createError?: unknown
  download?: Blob
  clock?: ReturnType<typeof clock>
}) {
  const createCalls: Array<{ prompt: string; idempotencyKey?: string }> = []
  const statusCalls: string[] = []
  let poll = 0
  const statuses = options.statuses ?? ['SUCCEEDED']
  const create = vi.fn(async (prompt: string, opts?: { idempotencyKey?: string }) => {
    createCalls.push({ prompt, idempotencyKey: opts?.idempotencyKey })
    if (options.createError !== undefined) throw options.createError
    return { taskId: 'task-1', status: 'PENDING', costRub: 4, model: 'nano' }
  })
  const status = vi.fn(async (taskId: string) => {
    statusCalls.push(taskId)
    const next = statuses[Math.min(poll, statuses.length - 1)] ?? 'SUCCEEDED'
    poll += 1
    return apiTask(next)
  })
  const download = vi.fn(async () => options.download ?? new Blob(['ai'], { type: 'image/jpeg' }))
  return { create, status, download, createCalls, statusCalls }
}

function baseOptions(overrides: Partial<Parameters<typeof runGeneration>[1]> = {}) {
  const часы = clock()
  return {
    prompt: 'redraw garment',
    pollIntervalMs: 0,
    now: часы.now,
    ...overrides,
  }
}

async function settled(run: GenerationRun): Promise<unknown> {
  return run.promise.catch((e: unknown) => e)
}

/** jsdom не даёт Blob.text(); читаем байты через FileReader. */
function blobText(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

/** Скрытое/видимое состояние вкладки (jsdom не даёт писать напрямую). */
function setHidden(flag: boolean): () => void {
  let hidden = flag
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  return () => {
    hidden = false
  }
}

describe('Асинхронная генерация (ADR-0006)', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  afterEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('старт: POST с ключом вещи, задача в IndexedDB, картинка после скачивания', async () => {
    const d = deps({})
    const события: string[] = []
    const run = runGeneration(
      'вещь-1',
      baseOptions({
        create: d.create,
        status: d.status,
        download: d.download,
        onJobChange: (job) => события.push(job.статус),
      }),
    )

    const blob = await run.promise
    expect(await blobText(blob)).toBe('ai')

    expect(d.create).toHaveBeenCalledTimes(1)
    expect(d.createCalls[0]?.idempotencyKey).toBe('вещь-1')
    expect(d.statusCalls).toEqual(['task-1'])
    expect(d.download).toHaveBeenCalledWith('task-1', expect.anything())

    // Хвостовые статусы: задача долетела до «ждёт», а после успеха из
    // активных ушла — прогон одноразовый.
    expect(события).toContain('ждёт')
    expect(await loadJob('вещь-1')).toBeUndefined()
    expect(activeGenerationRun('вещь-1')).toBeUndefined()
  })

  it('повторный запуск возвращает тот же прогон — второй опрос не заводится', async () => {
    const d = deps({ statuses: ['PENDING', 'SUCCEEDED'] })
    const options = baseOptions({
      create: d.create,
      status: d.status,
      download: d.download,
      pollIntervalMs: 20,
    })
    const первый = runGeneration('вещь-1', options)
    const второй = runGeneration('вещь-1', options)
    expect(второй).toBe(первый)

    await первый.promise
    expect(d.create).toHaveBeenCalledTimes(1)
  })

  it('возобновление по taskId: после «закрытия вкладки» create не вызывается', async () => {
    // Задача уже стоит: 202 прошёл, вкладка закрылась.
    const сохранённая: ЗадачаГенерации = {
      id: 'вещь-1',
      idВещи: 'вещь-1',
      ключ: 'вещь-1',
      попытка: 1,
      force: false,
      статус: 'ждёт',
      taskId: 'task-1',
      модель: 'nano',
      датаСеанса: new Date(0).toISOString(),
      датаСоздания: new Date(0).toISOString(),
      датаОбновления: new Date(0).toISOString(),
    }
    await saveJob(сохранённая)

    const d = deps({ statuses: ['SUCCEEDED'] })
    const часы = clock(GENERATION_SESSION_MS + 1)
    const run = runGeneration(
      'вещь-1',
      baseOptions({
        create: d.create,
        status: d.status,
        download: d.download,
        now: часы.now,
      }),
    )

    const blob = await run.promise
    expect(await blobText(blob)).toBe('ai')
    expect(d.create).not.toHaveBeenCalled()
    expect(d.statusCalls).toEqual(['task-1'])
    expect(await loadJob('вещь-1')).toBeUndefined()
  })

  it('потерянный ответ POST: повтор шлёт тот же Idempotency-Key, вторая оплата не идёт', async () => {
    const d = deps({ createError: new TidyApiError('network', 'обрыв') })
    const первый = await settled(runGeneration('вещь-1', baseOptions({ create: d.create })))
    expect(первый).toMatchObject({ code: 'network' })

    // Ключ и «создаётся» пережили обрыв: задача ждёт повторного POST.
    const job = await loadJob('вещь-1')
    expect(job).toMatchObject({ статус: 'создаётся', ключ: 'вещь-1', попытка: 1 })
    expect(job?.taskId).toBeUndefined()

    const d2 = deps({ statuses: ['SUCCEEDED'] })
    const второй = await settled(
      runGeneration('вещь-1', baseOptions({ create: d2.create, status: d2.status, download: d2.download })),
    )
    expect(второй).toBeInstanceOf(Blob)
    expect(d2.createCalls[0]?.idempotencyKey).toBe('вещь-1')
  })

  it('отказ провайдера: «не удалось», повтор — новая попытка с новым ключом', async () => {
    const d = deps({ statuses: ['FAILED'] })
    const первый = await settled(
      runGeneration('вещь-1', baseOptions({ create: d.create, status: d.status })),
    )
    expect(первый).toBeInstanceOf(ОшибкаГенерации)
    expect((первый as ОшибкаГенерации).code).toBe('failed')
    const job = await loadJob('вещь-1')
    expect(job).toMatchObject({ статус: 'не удалось', taskId: 'task-1' })
    expect(job?.последняяОшибка).toContain('не смог')

    const d2 = deps({ statuses: ['SUCCEEDED'] })
    const второй = await settled(
      runGeneration('вещь-1', baseOptions({ create: d2.create, status: d2.status, download: d2.download })),
    )
    expect(второй).toBeInstanceOf(Blob)
    // Ключ второй попытки суффиксирован: провайдер не вернёт старую неудачу.
    expect(d2.createCalls[0]?.idempotencyKey).toBe('вещь-1:2')
  })

  it('таймаут сеанса: «просрочена», повтор допрашивает ту же задачу без create', async () => {
    const часы = clock()
    const d = deps({ statuses: ['PENDING', 'SUCCEEDED'] })
    // После первого PENDING сеанс перепрыгивает потолок — цикл ставит «просрочена».
    const status = vi.fn(async (taskId: string) => {
      const ответ = await d.status(taskId)
      if (d.status.mock.calls.length === 1) часы.set(GENERATION_SESSION_MS + 1)
      return ответ
    })

    const первый = await settled(
      runGeneration('вещь-1', baseOptions({ create: d.create, status, now: часы.now })),
    )
    expect(первый).toBeInstanceOf(ОшибкаГенерации)
    expect((первый as ОшибкаГенерации).code).toBe('timeout')
    expect((первый as Error).message).toContain('5 минут')
    expect(await loadJob('вещь-1')).toMatchObject({ статус: 'просрочена', taskId: 'task-1' })

    // «Повторить» = новый сеанс допроса той же задачи, а не новая оплата.
    const второй = await settled(
      runGeneration('вещь-1', baseOptions({ create: d.create, status: d.status, download: d.download, now: часы.now })),
    )
    expect(второй).toBeInstanceOf(Blob)
    expect(d.create).toHaveBeenCalledTimes(1)
  })

  it('скрытая вкладка: пауза не сжигает сеансовый бюджет', async () => {
    const часы = clock()
    const d = deps({ statuses: ['PENDING', 'SUCCEEDED'] })
    let первая = true
    const status = vi.fn(async (taskId: string) => {
      const ответ = await d.status(taskId)
      if (первая) {
        первая = false
        // Вкладка ушла в фон; часы едут уже в скрытом состоянии.
        setHidden(true)
        setTimeout(() => {
          часы.set(GENERATION_SESSION_MS * 2)
          setHidden(false)
          document.dispatchEvent(new Event('visibilitychange'))
        }, 10)
      }
      return ответ
    })

    const run = runGeneration(
      'вещь-1',
      baseOptions({ create: d.create, status, download: d.download, now: часы.now }),
    )
    const blob = await run.promise
    expect(await blobText(blob)).toBe('ai')
  })

  it('обрыв по abort: TidyApiError aborted, статус «ждёт» переживает уход', async () => {
    const контроллер = new AbortController()
    const d = deps({ statuses: ['PENDING'] })
    const run = runGeneration(
      'вещь-1',
      baseOptions({
        create: d.create,
        status: d.status,
        signal: контроллер.signal,
        pollIntervalMs: 60_000,
      }),
    )

    // Дождаться «ждёт», затем отменить — кнопка «Остановить» или уход со экрана.
    await vi.waitFor(() => expect(run.job()?.статус).toBe('ждёт'))
    run.abort()
    const ошибка = await settled(run)
    expect(ошибка).toBeInstanceOf(TidyApiError)
    expect((ошибка as TidyApiError).code).toBe('aborted')
    // Задача у провайдера продолжает работать: taskId на месте.
    expect(await loadJob('вещь-1')).toMatchObject({ статус: 'ждёт', taskId: 'task-1' })
  })

  it('refresh будит опрос досрочно — «Обновить» не ждёт паузу', async () => {
    const d = deps({ statuses: ['PENDING', 'SUCCEEDED'] })
    const started = Date.now()
    const run = runGeneration(
      'вещь-1',
      baseOptions({
        create: d.create,
        status: d.status,
        download: d.download,
        pollIntervalMs: 120_000,
      }),
    )

    await vi.waitFor(() => expect(d.status).toHaveBeenCalledTimes(1))
    run.refresh()
    const blob = await run.promise
    expect(await blobText(blob)).toBe('ai')
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('Забрать готовое (grabGeneration)', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  afterEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  async function saveГотовуюЗадачу(статус: ЗадачаГенерации['статус'] = 'ждёт'): Promise<void> {
    await saveJob({
      id: 'вещь-1',
      idВещи: 'вещь-1',
      ключ: 'вещь-1',
      попытка: 1,
      force: false,
      статус,
      taskId: 'task-1',
      датаСеанса: new Date(0).toISOString(),
      датаСоздания: new Date(0).toISOString(),
      датаОбновления: new Date(0).toISOString(),
    })
  }

  it('без задачи — «нет», без лишних запросов', async () => {
    const d = deps({})
    const результат = await grabGeneration('вещь-1', { status: d.status, download: d.download })
    expect(результат).toEqual({ state: 'нет' })
    expect(d.status).not.toHaveBeenCalled()
  })

  it('SUCCEEDED у провайдера — скачивание и готовая картинка', async () => {
    await saveГотовуюЗадачу()
    const d = deps({ statuses: ['SUCCEEDED'] })
    const результат = await grabGeneration('вещь-1', { status: d.status, download: d.download })
    expect(результат.state).toBe('готово')
    if (результат.state === 'готово') expect(await blobText(результат.blob)).toBe('ai')
    expect(d.download).toHaveBeenCalledWith('task-1', expect.anything())
    // Забор не опрашивает задачу повторно и не заводит опрос: он разовый.
    expect(activeGenerationRun('вещь-1')).toBeUndefined()
  })

  it('задача ещё работает — «ждёт», картинку не качает', async () => {
    await saveГотовуюЗадачу()
    const d = deps({ statuses: ['PROCESSING'] })
    const результат = await grabGeneration('вещь-1', { status: d.status, download: d.download })
    expect(результат).toEqual({ state: 'ждёт' })
    expect(d.download).not.toHaveBeenCalled()
  })

  it('FAILED у провайдера — «не удалось», задача помечена в IndexedDB', async () => {
    await saveГотовуюЗадачу()
    const d = deps({ statuses: ['FAILED'] })
    const результат = await grabGeneration('вещь-1', { status: d.status, download: d.download })
    expect(результат.state).toBe('не удалось')
    if (результат.state === 'не удалось') expect(результат.message).toContain('не смог')
    expect(await loadJob('вещь-1')).toMatchObject({ статус: 'не удалось' })
  })

  it('задача уже в «не удалось» — ответ сразу, без запросов к провайдеру', async () => {
    await saveГотовуюЗадачу('не удалось')
    const d = deps({})
    const результат = await grabGeneration('вещь-1', { status: d.status, download: d.download })
    expect(результат.state).toBe('не удалось')
    expect(d.status).not.toHaveBeenCalled()
  })

  it('идущий прогон той же вещи сам всё доведёт — забор отвечает «ждёт»', async () => {
    // PENDING без завершения и длинная пауза: прогон живёт, пока тест не отменит его.
    const d = deps({ statuses: ['PENDING'] })
    const run = runGeneration(
      'вещь-1',
      baseOptions({ create: d.create, status: d.status, download: d.download, pollIntervalMs: 60_000 }),
    )
    await vi.waitFor(() => expect(run.job()?.статус).toBe('ждёт'))

    const результат = await grabGeneration('вещь-1', { status: d.status, download: d.download })
    expect(результат).toEqual({ state: 'ждёт' })
    expect(d.download).not.toHaveBeenCalled()

    run.abort()
    await settled(run)
  })
})
