/**
 * Жизненный цикл асинхронной генерации AI-версии (ADR-0006).
 *
 * Здесь живёт всё, что связывает три коротких вызова воркера (`POST /generate`
 * → опрос `GET /generate/{id}` → скачивание `GET /generate/{id}/image`) с
 * долгоживущей задачей в IndexedDB (`storage/jobs`):
 *
 * - **потерянный ответ не стоит второй оплаты.** `Idempotency-Key` создаётся и
 *   сохраняется до первого `POST`; если ответ потерялся (обрыв сети, закрытая
 *   вкладка), повторный `POST` с тем же ключом вернёт уже существующую задачу;
 * - **закрытие вкладки не теряет оплаченную задачу.** После `202` в IndexedDB
 *   лежит `taskId`: при следующем открытии опрос продолжается с допроса той же
 *   задачи, а не с новой оплаты;
 * - **потолок 5 минут — потолок живого сеанса, а не отказ.** По его истечении
 *   статус становится `просрочена` (задача у провайдера продолжает работать),
 *   а «Повторить» начинает новый сеанс допроса той же задачи. Терминальный
 *   отказ провайдера (`FAILED`) — другой случай: там «Повторить» делает новую
 *   попытку с новым ключом;
 * - **опрос идёт только на видимой вкладке.** Скрытое время не расходует
 *   сеансовый бюджет, при возврате — немедленный опрос.
 *
 * Один запуск на вещь: повторный {@link runGeneration} возвращает уже идущий
 * прогон ({@link activeGenerationRun}), поэтому параллельных опросов одной
 * задачи и двойных скачиваний не бывает.
 */

import type { ЗадачаГенерации } from '../storage/jobs'
import { loadJob, removeJob, saveJob } from '../storage/jobs'
import {
  TidyApiError,
  createGeneration,
  downloadGeneration,
  getGenerationStatus,
} from './tidy-api'

/** Потолок живого сеанса ожидания генерации (ADR-0006). */
export const GENERATION_SESSION_MS = 5 * 60_000

/** Пауза между опросами статуса — каждые ~3 с. */
export const GENERATION_POLL_MS = 3_000

/** Терминальные отказы провайдера: деньги за задачу возвращены самим провайдером. */
const FAILED_STATUSES = new Set(['FAILED', 'CANCELLED', 'REFUNDED', 'ENQUEUE_FAILED'])

const TEXT_TIMEOUT =
  'Не удалось дождаться генерацию за 5 минут. Задача продолжает выполняться — картинку можно забрать позже'

const TEXT_FAILED =
  'Сервис не смог сгенерировать изображение. Попробуйте ещё раз — списание за эту задачу вернётся автоматически'

const TEXT_NO_TASK = 'Нет задачи генерации — забирать нечего'

/** Причина, по которой генерация не завершилась. */
export type GenerationErrorCode = 'timeout' | 'failed' | 'no_task'

/**
 * Понятная ошибка генерации. От {@link TidyApiError} (сбой транспорта) её
 * отличает смысл: запросы прошли, но картинки нет — по таймауту сеанса или по
 * отказу провайдера. Очередь и UI различают причины по `code`.
 */
export class ОшибкаГенерации extends Error {
  readonly code: GenerationErrorCode

  constructor(code: GenerationErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ОшибкаГенерации'
    this.code = code
  }
}

/** Зависимости одного прогона генерации: по умолчанию — реальные вызовы воркера. */
export interface GenerationRunOptions {
  /** Redraw-промпт (строит вызывающий код из вещи). */
  prompt: string
  /** Вещь, для которой идёт генерация: метаданные истории генераций. */
  itemId?: string
  /** Название вещи для списка генераций. */
  title?: string
  /** Категория вещи (верхний уровень таксономии). */
  category?: string
  /** Подкатегория вещи. */
  subcategory?: string
  /** Slug модели из каталога. Без него воркер берёт модель по умолчанию. */
  model?: string
  /** Референс image-to-image: сжатый Оригинал или существующая AI-версия. */
  image?: Blob
  /** Кадр 1:1: провайдер рисует 1024×1024, размер передаём для симметрии. */
  width?: number
  height?: number
  /** Принудительная перегенерация (замена существующей AI-версии при сохранении). */
  force?: boolean
  /** Отмена прогона (уход с экрана, кнопка «Остановить»). */
  signal?: AbortSignal
  /** Каждое изменение задачи — для экрана статуса. */
  onJobChange?: (job: ЗадачаГенерации) => void
  create?: typeof createGeneration
  status?: typeof getGenerationStatus
  download?: typeof downloadGeneration
  /** Текущее время, мс. Инжектируется для детерминированных тестов. */
  now?: () => number
  pollIntervalMs?: number
  sessionMs?: number
}

/** Управляемый прогон генерации: обещание картинки плюс ручные кнопки. */
export interface GenerationRun {
  /** Готовая картинка либо {@link ОшибкаГенерации} / {@link TidyApiError}. */
  promise: Promise<Blob>
  /** Немедленный опрос — кнопка «Обновить» на экране статуса. */
  refresh(): void
  /** Прервать опрос, не отменяя задачу у провайдера. */
  abort(): void
  /** Последнее известное состояние задачи для UI. */
  job(): ЗадачаГенерации | undefined
  /** Подписка на изменения задачи. Возвращает функцию отписки. */
  on(listener: (job: ЗадачаГенерации) => void): () => void
}

// ---------------------------------------------------------------------------
// Служебное
// ---------------------------------------------------------------------------

/**
 * `Idempotency-Key` детерминирован от вещи и номера попытки: первый POST по
 * вещи всегда уходит с тем же ключом (потерянный ответ не станет второй
 * оплатой), а новая попытка после терминального отказа провайдера получает
 * новый ключ — иначе провайдер вернул бы ту же неудачную задачу.
 */
function keyFor(idВещи: string, попытка: number): string {
  const base = idВещи.length <= 60 ? idВещи : idВещи.slice(0, 60)
  return попытка <= 1 ? base : `${base}:${попытка}`
}

function makeJob(idВещи: string, options: GenerationRunOptions, iso: string): ЗадачаГенерации {
  return {
    id: idВещи,
    idВещи,
    ключ: keyFor(idВещи, 1),
    попытка: 1,
    force: options.force === true,
    статус: 'создаётся',
    ...(options.model !== undefined && options.model !== '' ? { модель: options.model } : {}),
    датаСоздания: iso,
    датаОбновления: iso,
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) {
    throw new TidyApiError('aborted', 'Генерация прервана')
  }
}

/**
 * Ждёт, пока вкладка снова станет видимой (ADR-0006: опрос на скрытой вкладке
 * стоит на паузе). Возвращает `true`, если пришлось ждать, — вызывающий
 * возвращает скрытое время в сеансовый бюджет.
 *
 * Среда без `document` (сервер, воркерские тесты) считается видимой.
 */
function waitForVisible(signal: AbortSignal | undefined): Promise<boolean> {
  const doc = (globalThis as { document?: Document }).document
  if (doc === undefined || !doc.hidden) return Promise.resolve(false)
  const документ: Document = doc
  return new Promise<boolean>((resolve, reject) => {
    const onVisible = () => {
      if (документ.hidden) return
      cleanup()
      resolve(true)
    }
    const onAbort = () => {
      cleanup()
      reject(new TidyApiError('aborted', 'Генерация прервана'))
    }
    function cleanup(): void {
      документ.removeEventListener('visibilitychange', onVisible)
      signal?.removeEventListener('abort', onAbort)
    }
    документ.addEventListener('visibilitychange', onVisible)
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort)
    }
  })
}

/** Пауза между опросами; будится досрочно по {@link GenerationRun.refresh} или отмене. */
function waitPoll(
  ms: number,
  signal: AbortSignal | undefined,
  wakers: Set<() => void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Отмена, пришедшая до установки слушателя, не должна ждать всю паузу.
    if (signal?.aborted) {
      reject(new TidyApiError('aborted', 'Генерация прервана'))
      return
    }
    const finish = () => {
      clearTimeout(timer)
      wakers.delete(finish)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = () => {
      clearTimeout(timer)
      wakers.delete(finish)
      signal?.removeEventListener('abort', onAbort)
      reject(new TidyApiError('aborted', 'Генерация прервана'))
    }
    const timer = setTimeout(finish, ms)
    wakers.add(finish)
    signal?.addEventListener('abort', onAbort)
  })
}

function normalizeStatus(status: string): string {
  return status.trim().toUpperCase()
}

// ---------------------------------------------------------------------------
// Прогон генерации
// ---------------------------------------------------------------------------

/** Идущие прямо сейчас прогоны: один на вещь. */
const активные = new Map<string, GenerationRun>()

/**
 * Ставит задачу генерации (или подхватывает уже поставленную) и доводит её до
 * готовой картинки. Возвращает управляемый прогон; повторный вызов для той же
 * вещи отдаёт уже идущий прогон, а не создаёт второй опрос.
 */
export function runGeneration(idВещи: string, options: GenerationRunOptions): GenerationRun {
  const уже = активные.get(idВещи)
  if (уже !== undefined) return уже

  const контроллер = new AbortController()
  const слушатели = new Set<(job: ЗадачаГенерации) => void>()
  const будильники = new Set<() => void>()
  const signal = контроллер.signal
  let текущая: ЗадачаГенерации | undefined

  // Экран статуса живёт на этих уведомлениях — подписываем сразу.
  if (options.onJobChange !== undefined) слушатели.add(options.onJobChange)

  if (options.signal !== undefined) {
    if (options.signal.aborted) контроллер.abort()
    else options.signal.addEventListener('abort', () => контроллер.abort(), { once: true })
  }

  const пробудить = (): void => {
    for (const б of [...будильники]) б()
  }
  const остановить = (): void => {
    контроллер.abort()
    пробудить()
  }

  async function перезаписать(next: ЗадачаГенерации): Promise<void> {
    текущая = next
    await saveJob(next)
    for (const слушатель of слушатели) слушатель(next)
  }

  const promise = пройти(idВещи, options, { signal, перезаписать, будильники })

  const run: GenerationRun = {
    promise,
    refresh: пробудить,
    abort: остановить,
    job: () => текущая,
    on(слушатель) {
      слушатели.add(слушатель)
      if (текущая !== undefined) слушатель(текущая)
      return () => {
        слушатели.delete(слушатель)
      }
    },
  }
  активные.set(idВещи, run)
  void promise.catch(() => undefined).finally(() => {
    if (активные.get(idВещи) === run) активные.delete(idВещи)
  })
  return run
}

/** Идущий прямо сейчас прогон генерации вещи, если он есть. */
export function activeGenerationRun(idВещи: string): GenerationRun | undefined {
  return активные.get(idВещи)
}

interface ПрогонКонтекста {
  signal: AbortSignal
  перезаписать: (job: ЗадачаГенерации) => Promise<void>
  будильники: Set<() => void>
}

async function пройти(
  idВещи: string,
  options: GenerationRunOptions,
  ctx: ПрогонКонтекста,
): Promise<Blob> {
  const now = options.now ?? Date.now
  const sessionMs = options.sessionMs ?? GENERATION_SESSION_MS
  const pollMs = options.pollIntervalMs ?? GENERATION_POLL_MS
  const create = options.create ?? createGeneration
  const status = options.status ?? getGenerationStatus
  const download = options.download ?? downloadGeneration
  const iso = (): string => new Date(now()).toISOString()

  let задача = await loadJob(idВещи)

  if (задача === undefined) {
    задача = makeJob(idВещи, options, iso())
    await ctx.перезаписать(задача)
  } else if (задача.статус === 'не удалось') {
    // Терминальный отказ провайдера: возвращаться тем же ключом бессмысленно —
    // провайдер отдал бы ту же неудачную задачу. Считаем новую попытку.
    const новаяПопытка = задача.taskId !== undefined
    задача = {
      ...задача,
      статус: 'создаётся',
      ...(новаяПопытка
        ? { ключ: keyFor(idВещи, задача.попытка + 1), попытка: задача.попытка + 1, taskId: undefined }
        : {}),
      ...(options.force !== undefined ? { force: options.force } : {}),
      ...(options.model !== undefined && options.model !== '' ? { модель: options.model } : {}),
      последняяОшибка: undefined,
      датаСеанса: undefined,
      датаОбновления: iso(),
    }
    await ctx.перезаписать(задача)
  }

  throwIfAborted(ctx.signal)

  if (задача.taskId === undefined) {
    // Ключ и состояние «создаётся» переживают POST: если ответ потеряется,
    // повтор пойдёт с тем же `Idempotency-Key` и не оплатит вторую генерацию.
    if (задача.статус !== 'создаётся') {
      задача = { ...задача, статус: 'создаётся', датаОбновления: iso() }
      await ctx.перезаписать(задача)
    }
    const task = await create(options.prompt, {
      width: options.width,
      height: options.height,
      model: options.model,
      image: options.image,
      idempotencyKey: задача.ключ,
      itemId: options.itemId,
      title: options.title,
      category: options.category,
      subcategory: options.subcategory,
      signal: ctx.signal,
    })
    задача = {
      ...задача,
      taskId: task.taskId,
      статус: 'ждёт',
      ...(task.model !== '' ? { модель: task.model } : {}),
      датаСеанса: iso(),
      датаОбновления: iso(),
    }
  } else {
    // Подхват существующей задачи — новый сеанс допроса (ADR-0006).
    задача = { ...задача, статус: 'ждёт', датаСеанса: iso(), датаОбновления: iso() }
  }
  await ctx.перезаписать(задача)

  const taskId = задача.taskId
  if (taskId === undefined) {
    // Недостижимо: ветки выше гарантируют taskId. Защита для типов.
    throw new ОшибкаГенерации('no_task', TEXT_NO_TASK)
  }

  let сеанс = Date.parse(задача.датаСеанса ?? iso())
  let видимоНа = now()

  for (;;) {
    throwIfAborted(ctx.signal)
    const скрытоБыло = await waitForVisible(ctx.signal)
    if (скрытоБыло) {
      // Скрытое время не тратит бюджет живого сеанса: возвращаем его.
      сеанс += now() - видимоНа
      видимоНа = now()
    }
    if (now() - сеанс >= sessionMs) {
      задача = { ...задача, статус: 'просрочена', датаОбновления: iso() }
      await ctx.перезаписать(задача)
      throw new ОшибкаГенерации('timeout', TEXT_TIMEOUT)
    }

    const текущий = await status(taskId, { signal: ctx.signal })
    видимоНа = now()
    const верхний = normalizeStatus(текущий.status)

    if (верхний === 'SUCCEEDED') {
      const blob = await download(taskId, { signal: ctx.signal })
      // Задача дошла до конца: висеть в IndexedDB ей больше незачем — иначе
      // экран статуса показывал бы «ждёт» по давно забранной картинке.
      await removeJob(idВещи)
      return blob
    }
    if (FAILED_STATUSES.has(верхний)) {
      задача = { ...задача, статус: 'не удалось', последняяОшибка: TEXT_FAILED, датаОбновления: iso() }
      await ctx.перезаписать(задача)
      throw new ОшибкаГенерации('failed', TEXT_FAILED)
    }

    // PENDING / PROCESSING / неизвестный статус: ещё ждём.
    if (pollMs > 0) await waitPoll(pollMs, ctx.signal, ctx.будильники)
  }
}

