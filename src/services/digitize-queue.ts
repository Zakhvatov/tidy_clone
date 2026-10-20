/**
 * Очередь оцифровки (T12): прогресс, ретраи, остановка и возобновление.
 *
 * Зачем очередь, а не простой цикл: у Tidy массовая оцифровка падала на 96% и
 * теряла вещи. Здесь каждая вещь — отдельная задача, состояние которой пишется
 * в IndexedDB после каждого шага. Закрытие приложения не теряет ни прогресс, ни
 * уже оцифрованные вещи: при следующем открытии очередь можно продолжить.
 *
 * Правила, которые обеспечивает движок:
 * - **сбой одной вещи не рушит остальные** — ошибка пишется в задачу, очередь
 *   идёт дальше (кроме ошибок, которые не пройдут никогда: нет токена или нет
 *   Оригинала — тогда очередь останавливается, а вещь остаётся в очереди);
 * - **до 3 попыток на вещь с паузой** — попытки накопительные, между запусками
 *   тоже; исчерпали — задача помечается «не удалось», очередь идёт дальше;
 * - **идемпотентность** — `digitizeAuto` проверяет наличие роли, поэтому
 *   повторный проход не создаёт вторую AI-версию;
 * - **фоновая генерация без нажатия запрещена** — движок ничего не запускает
 *   сам: `start()` вызывает кнопка массовой оцифровки, `resume()` — кнопка
 *   «Продолжить оцифровку».
 *
 * Движок не знает о React: он уведомляет подписчиков прогрессом, а панель в
 * `src/ui/*` рисует его.
 */

import {
  ОшибкаОцифровки,
  digitizeAuto,
  itemsNeedingDigitization,
  saveGeneratedResult,
  type DigitizeDeps,
  type ПлановаяВещь,
} from './digitize'
import { ОшибкаГенерации, activeGenerationRun, grabGeneration } from './generation'
import { TidyApiError } from './tidy-api'
import { loadJobs, removeJob } from '../storage/jobs'
import {
  QUEUE_ID,
  clearQueue,
  loadQueue,
  saveQueue,
  type ЗадачаОчереди,
  type СостояниеОчереди,
  type СтатусОчереди,
} from '../storage/queue'

/** Сколько раз пробуем одну вещь, прежде чем пометить «не удалось». */
export const DEFAULT_MAX_ATTEMPTS = 3

/** Пауза между попытками одной вещи. */
export const DEFAULT_RETRY_DELAY_MS = 1_000

/** Прогресс очереди — то, что показывает панель на экране гардероба. */
export interface QueueProgress {
  /** `пусто` — очереди ещё не было; остальные значения — статус очереди. */
  статус: СтатусОчереди | 'пусто'
  всего: number
  обработано: number
  успехов: number
  ошибок: number
  осталось: number
  /** Название вещи, которая обрабатывается прямо сейчас. */
  текущая?: string
  /** Последняя понятная ошибка — показывается в панели. */
  последняяОшибка?: string
}

/** Настройки очереди: зависимости оцифровки плюс тайминг ретраев. */
export interface DigitizeQueueOptions extends DigitizeDeps {
  maxAttempts?: number
  retryDelayMs?: number
  /** Пауза между попытками. В тестах подменяется на мгновенную. */
  sleep?: (ms: number) => Promise<void>
}

/** Итог «Забрать готовое» по всем висящим задачам генерации. */
export interface GrabSummary {
  /** Сохранённые AI-версии. */
  сохранено: number
  /** Задачи, которые ещё работают (или чей прогон идёт прямо сейчас). */
  ждут: number
  /** Терминально неудачные: их перезапускают кнопкой в карточке вещи. */
  неудачно: number
  /** Сбой забора (сеть, хранилище), если он был. */
  последняяОшибка?: string
}

interface QueueFailure {
  message: string
  /** `true` — повтор не поможет: нет токена, нет Оригинала, вещь удалена. */
  fatal: boolean
}

function nowIso(): string {
  return new Date().toISOString()
}

/** Понятная ошибка и тактика: ретраить или нет. */
function describeFailure(error: unknown): QueueFailure {
  if (error instanceof TidyApiError) {
    return {
      message: error.message,
      fatal:
        error.code === 'unauthorized' ||
        error.code === 'not_configured' ||
        error.code === 'billing',
    }
  }
  if (error instanceof ОшибкаГенерации) {
    // `timeout` — новый сеанс допроса той же задачи, `failed` — новая попытка
    // (провайдер уже вернул деньги). Обе причины повторяемы.
    return { message: error.message, fatal: false }
  }
  if (error instanceof ОшибкаОцифровки) {
    return {
      message: error.message,
      fatal: error.code === 'not_found' || error.code === 'no_original',
    }
  }
  return {
    message: error instanceof Error ? error.message : 'Не удалось оцифровать вещь',
    fatal: false,
  }
}

/** Есть ли в очереди незавершённые задачи. */
function hasPending(state: СостояниеОчереди): boolean {
  return state.задачи.some((task) => task.статус === 'ожидает' || task.статус === 'в работе')
}

/**
 * Задачи, прерванные закрытием приложения, при возобновлении снова «ожидают»:
 * их частичная работа не потеряна, а идемпотентность не даст создать дубль.
 */
function normalizeInterrupted(state: СостояниеОчереди): СостояниеОчереди {
  return {
    ...state,
    текущая: undefined,
    задачи: state.задачи.map((task) =>
      task.статус === 'в работе' ? { ...task, статус: 'ожидает' as const } : task,
    ),
  }
}

function createState(план: readonly ПлановаяВещь[], now: string): СостояниеОчереди {
  return {
    id: QUEUE_ID,
    статус: 'ожидает',
    задачи: план.map(({ id, название }) => ({
      id,
      idВещи: id,
      название,
      способ: null,
      статус: 'ожидает' as const,
      попытки: 0,
      датаСоздания: now,
      датаОбновления: now,
    })),
    датаНачала: now,
    датаОбновления: now,
  }
}

/** Сводит состояние очереди в прогресс для панели. */
export function progressOf(state: СостояниеОчереди | null): QueueProgress {
  if (state === null) {
    return { статус: 'пусто', всего: 0, обработано: 0, успехов: 0, ошибок: 0, осталось: 0 }
  }
  let успехов = 0
  let ошибок = 0
  let осталось = 0
  for (const task of state.задачи) {
    if (task.статус === 'готово') успехов += 1
    else if (task.статус === 'не удалось') ошибок += 1
    else осталось += 1
  }
  const текущая =
    state.текущая === undefined
      ? undefined
      : state.задачи.find((task) => task.idВещи === state.текущая)?.название

  return {
    статус: state.статус,
    всего: state.задачи.length,
    обработано: успехов + ошибок,
    успехов,
    ошибок,
    осталось,
    ...(текущая === undefined ? {} : { текущая }),
    ...(state.последняяОшибка === undefined ? {} : { последняяОшибка: state.последняяОшибка }),
  }
}

/**
 * Очередь оцифровки. Один экземпляр на приложение ({@link appDigitizeQueue}),
 * но класс не зависит от React и легко создаётся в тестах со своими зависимостями.
 */
export class DigitizeQueue {
  readonly #deps: DigitizeQueueOptions
  readonly #maxAttempts: number
  readonly #retryDelayMs: number
  readonly #sleep: (ms: number) => Promise<void>
  readonly #listeners = new Set<(progress: QueueProgress) => void>()
  /**
   * Подписка на успешную оцифровку вещи. Нужна сетке: она читает данные один
   * раз при монтировании, поэтому после очереди обязана перечитать изображения
   * и показать свежие вырезы/AI-версии (остаточный риск 5 финального ревью).
   */
  readonly #digitizedListeners = new Set<(itemId: string) => void>()

  #state: СостояниеОчереди | null = null
  #running = false
  #stopRequested = false
  #controller: AbortController | null = null

  constructor(options: DigitizeQueueOptions = {}) {
    this.#deps = options
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    this.#retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** Подписка на прогресс. Возвращает функцию отписки. */
  subscribe(listener: (progress: QueueProgress) => void): () => void {
    this.#listeners.add(listener)
    listener(this.progress)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Подписка на успешную оцифровку одной вещи. Событие летит до конца прохода,
   * чтобы сетка могла тихо перечитать изображения, не показывая скелетон.
   * Возвращает функцию отписки.
   */
  onDigitized(listener: (itemId: string) => void): () => void {
    this.#digitizedListeners.add(listener)
    return () => {
      this.#digitizedListeners.delete(listener)
    }
  }

  /** Текущий прогресс (в том числе после `refresh` из хранилища). */
  get progress(): QueueProgress {
    return progressOf(this.#state)
  }

  /** Идёт ли обработка прямо сейчас. */
  get running(): boolean {
    return this.#running
  }

  /**
   * Читает сохранённую очередь из IndexedDB, не запуская её. Нужно экрану,
   * чтобы при открытии приложения показать «Продолжить оцифровку».
   *
   * Если приложение закрыли на середине, в хранилище остался статус
   * `выполняется`, хотя движка уже нет. Такую очередь показываем как
   * `остановлена`, а прерванные задачи возвращаем в «ожидает» — иначе панель
   * решила бы, что работа идёт, и не предложила бы продолжить.
   */
  async refresh(): Promise<void> {
    if (this.#running) return
    let state: СостояниеОчереди | undefined
    try {
      state = await loadQueue()
    } catch {
      state = undefined
    }
    if (state === undefined) {
      this.#state = null
    } else {
      const restored = normalizeInterrupted(state)
      if (restored.статус === 'выполняется') restored.статус = 'остановлена'
      this.#state = restored
    }
    this.#emit()
  }

  /**
   * Новая массовая оцифровка: планирует все вещи без выреза и без AI-версии
   * и запускает очередь. Если оцифровывать нечего — ничего не пишет.
   */
  async start(): Promise<void> {
    if (this.#running) return
    const план = await itemsNeedingDigitization()
    const state = createState(план, nowIso())
    if (state.задачи.length === 0) {
      // Оцифровывать нечего: старая сохранённая очередь больше не нужна
      // (удалённые/уже оцифрованные вещи висели бы в ней мусором).
      await clearQueue().catch(() => undefined)
      this.#state = { ...state, статус: 'завершена' }
      this.#emit()
      return
    }
    await this.#run(state)
  }

  /**
   * Продолжает прерванную очередь с того же места. Запускается только кнопкой:
   * генерация без нажатия запрещена, поэтому возобновление не автоматическое.
   */
  async resume(): Promise<void> {
    if (this.#running) return
    const state = await loadQueue().catch(() => undefined)
    if (state === undefined || !hasPending(state)) return
    await this.#run(state)
  }

  /** Останавливает обработку: текущая вещь возвращается в очередь, прогресс сохраняется. */
  stop(): void {
    if (!this.#running) return
    this.#stopRequested = true
    this.#controller?.abort()
  }

  /**
   * «Забрать готовое» (ADR-0006): обходит задачи генерации, пережившие
   * закрытие вкладки, и сохраняет картинки, которые провайдер уже отдал.
   * Ничего не запускается и не оплачивается — только забор уже готового.
   * Подписчики `onDigitized` получают событие по каждой сохранённой вещи,
   * чтобы сетка перечитала изображения.
   */
  async grabReady(): Promise<GrabSummary> {
    const итог: GrabSummary = { сохранено: 0, ждут: 0, неудачно: 0 }

    let jobs
    try {
      jobs = await loadJobs()
    } catch (error) {
      итог.последняяОшибка =
        error instanceof Error ? error.message : 'Не удалось прочитать задачи генерации'
      return итог
    }

    for (const job of jobs) {
      if (job.taskId === undefined) continue
      if (activeGenerationRun(job.idВещи) !== undefined) {
        // Прогон той же вещи идёт прямо сейчас — он сам всё доведёт до конца.
        итог.ждут += 1
        continue
      }
      try {
        const результат = await grabGeneration(job.idВещи, {
          ...(this.#deps.signal === undefined ? {} : { signal: this.#deps.signal }),
        })
        if (результат.state === 'готово') {
          await saveGeneratedResult(job.idВещи, результат.blob, { ...this.#deps, force: job.force })
          итог.сохранено += 1
          for (const listener of this.#digitizedListeners) listener(job.idВещи)
        } else if (результат.state === 'ждёт') {
          итог.ждут += 1
        } else if (результат.state === 'не удалось') {
          итог.неудачно += 1
        }
        // `нет` — задача уже разрешилась сама (например, в другом прогоне).
      } catch (error) {
        if (error instanceof ОшибкаОцифровки && error.code === 'not_found') {
          // Вещь удалили — осиротевшая задача генерации не нужна.
          await removeJob(job.idВещи).catch(() => undefined)
          continue
        }
        // Моргнула сеть или упала IndexedDB: задача не потеряна, повтор кнопкой.
        итог.ждут += 1
        итог.последняяОшибка =
          error instanceof Error ? error.message : 'Не удалось забрать готовое'
      }
    }
    return итог
  }

  #emit(): void {
    const progress = this.progress
    for (const listener of this.#listeners) listener(progress)
  }

  async #run(initial: СостояниеОчереди): Promise<void> {
    const state = normalizeInterrupted(initial)
    state.статус = 'выполняется'
    state.текущая = undefined
    state.последняяОшибка = undefined
    state.датаОбновления = nowIso()

    this.#state = state
    this.#running = true
    this.#stopRequested = false
    this.#controller = new AbortController()

    await saveQueue(state)
    this.#emit()

    try {
      await this.#loop()
    } finally {
      this.#running = false
      this.#controller = null
      state.текущая = undefined
      state.статус = hasPending(state) ? 'остановлена' : 'завершена'
      state.датаОбновления = nowIso()
      await saveQueue(state)
      this.#emit()
    }
  }

  async #loop(): Promise<void> {
    const state = this.#state
    if (state === null) return

    for (const task of state.задачи) {
      if (this.#stopRequested) break
      if (task.статус !== 'ожидает') continue

      task.статус = 'в работе'
      task.датаОбновления = nowIso()
      state.текущая = task.idВещи
      await saveQueue(state)
      this.#emit()

      await this.#processTask(state, task)

      if (this.#stopRequested) {
        if (task.статус === 'в работе') {
          // Прервали на середине: вещь возвращается в очередь, чтобы её можно
          // было продолжить, а не потерять. Идемпотентность защитит от дубля.
          task.статус = 'ожидает'
          task.датаОбновления = nowIso()
          state.текущая = undefined
          await saveQueue(state)
          this.#emit()
        }
        break
      }
    }
  }

  async #processTask(state: СостояниеОчереди, task: ЗадачаОчереди): Promise<void> {
    while (task.попытки < this.#maxAttempts) {
      if (this.#stopRequested) return
      task.попытки += 1
      task.датаОбновления = nowIso()

      try {
        const outcome = await digitizeAuto(task.idВещи, {
          ...this.#deps,
          signal: this.#controller?.signal,
        })
        task.способ = outcome.way
        task.статус = 'готово'
        delete task.последняяОшибка
        task.датаОбновления = nowIso()
        await saveQueue(state)
        this.#emit()
        for (const listener of this.#digitizedListeners) listener(task.idВещи)
        return
      } catch (error) {
        const failure = describeFailure(error)
        task.последняяОшибка = failure.message
        task.датаОбновления = nowIso()
        state.последняяОшибка = failure.message
        await saveQueue(state)
        this.#emit()

        if (this.#stopRequested) return

        if (failure.fatal) {
          // Повтор не поможет (нет токена / нет Оригинала). Останавливаем очередь
          // целиком, вещь оставляем в очереди — она не потеряна.
          this.#stopRequested = true
          return
        }
        if (task.попытки >= this.#maxAttempts) {
          task.статус = 'не удалось'
          task.датаОбновления = nowIso()
          await saveQueue(state)
          this.#emit()
          return
        }
        await this.#sleep(this.#retryDelayMs)
      }
    }

    // Попытки были исчерпаны ещё до входа в цикл (например, после возобновления).
    if (!this.#stopRequested && task.статус === 'в работе') {
      task.статус = 'не удалось'
      task.датаОбновления = nowIso()
      await saveQueue(state)
      this.#emit()
    }
  }
}

/**
 * Очередь приложения. Одна на вкладку: движок держит состояние в IndexedDB,
 * поэтому повторное создание не нужно, а панель и экран смотрят на него же.
 */
export const appDigitizeQueue = new DigitizeQueue()
