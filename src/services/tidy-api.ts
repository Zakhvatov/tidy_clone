/**
 * Единый клиент воркера-посредника `tidy-api` (T10).
 *
 * Зачем отдельный модуль: заголовок `x-tidy-client`, базовый URL, таймаут,
 * отмена и разбор `{error:{code,message}}` нужны и распознаванию фото (T7),
 * и генерации AI-версии (T10). Две реализации одного и того же заголовка
 * расходятся молча, поэтому все сетевые детали воркера живут здесь, а
 * `classify-photo.ts` и `digitize.ts` ходят только через этот клиент.
 *
 * Контракт воркера (ADR-0003, ADR-0006, `workers/api`):
 *   GET  /models                              → {models:[{slug,title,priceRub}], defaultSlug}
 *   POST /generate  {prompt, model?, imageBase64?, mimeType?, idempotencyKey?}
 *                                          → 202 {taskId, status, costRub, model}
 *   GET  /generate/{taskId}                  → 200 {taskId, status, costRub}
 *   GET  /generate/{taskId}/image            → байты готовой картинки
 *   POST /classify  {imageBase64, mimeType}   → {category, subcategory, confidence}
 *   GET  /session                             → {ok} — дешёвая проверка токена
 *   GET  /health                              → {ok, generate, classify}
 *   ошибка:                                   → {error:{code,message}}
 *
 * Генерация асинхронная (ADR-0006): воркер ставит задачу и сразу отвечает 202,
 * картинку клиент забирает сам — сначала опросом статуса, затем отдельным
 * запросом файла. Поэтому у генерации здесь три вызова, а не один.
 *
 * Секреты воркера (ключ генерации, ключ vision-провайдера) на клиент не попадают.
 * Клиентский токен — не секрет доступа к данным, а барьер от посторонних:
 * пользователь вводит его один раз на экране `/access`, он хранится только на
 * устройстве (`storage/settings`) и уходит заголовком `x-tidy-client`.
 */

import { readAccessToken } from '../storage/settings'

/** Базовый URL воркера по умолчанию. Переопределяется `VITE_TIDY_API_URL`. */
export const DEFAULT_API_URL = 'https://tidy-api.megabaff2011.workers.dev'

/** Таймаут обычного запроса (классификация, служебные). */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Таймаут создания задачи генерации: воркер успевает загрузить референс и
 * ответить 202. Картинку этот вызов не ждёт (ADR-0006), поэтому держим больше
 * воркерских пределов, чтобы получить его 504 с текстом, а не обрыв соединения.
 */
export const GENERATE_TIMEOUT_MS = 120_000

/** Таймаут одного опроса статуса задачи — короткий служебный вызов. */
export const GENERATION_STATUS_TIMEOUT_MS = 15_000

/** Таймаут скачивания готового изображения (~250 КБ). */
export const GENERATION_IMAGE_TIMEOUT_MS = 60_000

/** Путь создания генерации. */
export const GENERATE_PATH = '/generate'

/** Путь статуса задачи генерации. */
export function generationStatusPath(taskId: string): string {
  return `${GENERATE_PATH}/${encodeURIComponent(taskId)}`
}

/** Путь скачивания готового изображения задачи. */
export function generationImagePath(taskId: string): string {
  return `${generationStatusPath(taskId)}/image`
}

/** Путь каталога моделей генерации. */
export const MODELS_PATH = '/models'

/** Путь распознавания категории по фото. */
export const CLASSIFY_PATH = '/classify'

/** Путь дешёвой проверки токена — `GET /session`. */
export const SESSION_PATH = '/session'

/**
 * Коды ошибок клиента. Часть приходит от воркера (`unauthorized`,
 * `rate_limited`, `billing`, `not_configured`, `bad_request`, `server`), часть — из
 * окружения браузера (`network`, `timeout`, `aborted`, `invalid_response`),
 * а `image_too_large`/`unsupported_media` проверяются на клиенте до отправки.
 *
 * `unauthorized`, `billing` и `rate_limited` выделены намеренно: у них разные
 * понятные тексты и разная тактика (401/402 — не ретраить, 429 — подождать).
 */
export type TidyApiErrorCode =
  | 'not_configured'
  | 'unauthorized'
  | 'rate_limited'
  | 'billing'
  | 'image_too_large'
  | 'unsupported_media'
  | 'not_found'
  | 'not_ready'
  | 'bad_request'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'server'
  | 'invalid_response'

/**
 * Понятная ошибка клиента воркера: UI показывает `message`, логика смотрит
 * на `code`. `status` — HTTP-код, если ошибка пришла от сервера.
 */
export class TidyApiError extends Error {
  readonly code: TidyApiErrorCode
  readonly status?: number

  constructor(
    code: TidyApiErrorCode,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'TidyApiError'
    this.code = code
    this.status = options.status
  }
}

/** Опции одного запроса к воркеру. */
export interface TidyRequestOptions {
  /** Для тестов и для окружений с подменённым fetch. */
  fetchImpl?: typeof fetch
  /** Базовый URL воркера; по умолчанию `VITE_TIDY_API_URL` или `DEFAULT_API_URL`. */
  baseUrl?: string
  /** Отмена извне (кнопка «Остановить», уход с экрана). */
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * Клиентский токен воркера. По умолчанию берётся с устройства
   * (`storage/settings`); `VITE_TIDY_CLIENT_TOKEN` больше не читается.
   * `null` или пустая строка — запрос без заголовка `x-tidy-client`
   * (воркер ответит 401 `unauthorized`): это явно «не настроено», а не тихий обход.
   */
  clientToken?: string | null
  method?: string
  body?: BodyInit | null
  headers?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Конфигурация
// ---------------------------------------------------------------------------

/** Базовый URL воркера без завершающего слэша. */
export function apiBaseUrl(explicit?: string): string {
  const fromEnv = import.meta.env?.VITE_TIDY_API_URL
  const value = explicit ?? fromEnv ?? DEFAULT_API_URL
  return value.trim().replace(/\/+$/, '')
}

/**
 * Клиентский токен: явный параметр важнее сохранённого на устройстве.
 *
 * - `explicit !== undefined` — берём его (после `trim`) или `null` для пустого;
 * - `explicit === undefined` — читаем `storage/settings`.
 *
 * `VITE_TIDY_CLIENT_TOKEN` не читается: токен больше не попадает в публичный бандл.
 */
export function resolveClientToken(explicit?: string | null): string | null {
  const value = explicit === undefined ? readAccessToken() : explicit
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * Дешёвая проверка токена через `GET /session`. Успех — `resolved` без значения;
 * неверный токен приходит как {@link TidyApiError} с `code: 'unauthorized'`.
 */
export async function validateAccessToken(
  token: string,
  options: Omit<TidyRequestOptions, 'clientToken' | 'method' | 'body'> = {},
): Promise<void> {
  await requestJson<unknown>(SESSION_PATH, {
    ...options,
    clientToken: token,
    timeoutMs: options.timeoutMs ?? 10_000,
    method: 'GET',
  })
}

// ---------------------------------------------------------------------------
// Разбор ошибок воркера
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Достаёт `{error:{code,message}}` из ответа и переводит HTTP-код/код воркера
 * в наш `TidyApiErrorCode` с понятным русским текстом. Текст из тела имеет
 * приоритет: воркер знает причину точнее.
 */
export async function errorFromResponse(response: Response): Promise<TidyApiError> {
  let code = ''
  let message = ''
  try {
    const body: unknown = await response.json()
    if (isRecord(body) && isRecord(body.error)) {
      if (typeof body.error.code === 'string') code = body.error.code
      if (typeof body.error.message === 'string') message = body.error.message
    }
  } catch {
    // тело не JSON — остаётся только HTTP-статус
  }

  if (response.status === 503 && code === 'not_configured') {
    return new TidyApiError('not_configured', message || 'Сервис не настроен', {
      status: response.status,
    })
  }
  if (response.status === 401 || code === 'unauthorized') {
    return new TidyApiError(
      'unauthorized',
      message || 'Сервис отклонил запрос: неверный или отсутствующий клиентский токен',
      { status: response.status },
    )
  }
  if (response.status === 402 || code === 'billing') {
    return new TidyApiError(
      'billing',
      message || 'Закончился баланс генерации. Пополните кошелёк сервиса.',
      { status: response.status },
    )
  }
  if (response.status === 429 || code === 'rate_limited') {
    return new TidyApiError(
      'rate_limited',
      message || 'Слишком много запросов к сервису. Подождите минуту и попробуйте снова.',
      { status: response.status },
    )
  }
  if (response.status === 413 || code === 'payload_too_large') {
    return new TidyApiError('image_too_large', message || 'Изображение слишком большое для сервиса', {
      status: response.status,
    })
  }
  if (response.status === 404 || code === 'not_found') {
    return new TidyApiError('not_found', message || 'Сервис не нашёл запрошенный ресурс', {
      status: response.status,
    })
  }
  if (response.status === 409 || code === 'not_ready') {
    // 409 от воркера — картинку спросили раньше времени: это не сбой сервиса,
    // а сигнал «сейчас не готово», по нему клиент просто продолжает опрос.
    return new TidyApiError(
      'not_ready',
      message || 'Изображение ещё не готово — попробуйте чуть позже',
      { status: response.status },
    )
  }
  if (response.status === 504 || code === 'model_timeout') {
    return new TidyApiError('timeout', message || 'Сервис не ответил вовремя', {
      status: response.status,
    })
  }
  if (response.status >= 400 && response.status < 500) {
    return new TidyApiError(
      'bad_request',
      message || `Сервис отклонил запрос (${response.status})`,
      { status: response.status },
    )
  }
  return new TidyApiError('server', message || `Сервис вернул ошибку (${response.status})`, {
    status: response.status,
  })
}

// ---------------------------------------------------------------------------
// Транспорт
// ---------------------------------------------------------------------------

/**
 * Отправляет запрос к воркеру и возвращает `Response`, либо бросает
 * `TidyApiError`. Приоритет ошибок: отмена извне → таймаут → сеть, затем
 * HTTP-код. Таймаут и внешний сигнал объединяются в один `AbortController`.
 */
export async function send(path: string, options: TidyRequestOptions = {}): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const explicitToken = options.clientToken
  const clientToken = resolveClientToken(explicitToken)
  if (explicitToken === undefined && clientToken === null) {
    // Токен не задан ни явно, ни на устройстве: сеть не нужна, ответ воркера
    // всё равно был бы 401. Говорим об этом сразу и понятным текстом.
    throw new TidyApiError(
      'unauthorized',
      'Нужен токен доступа. Введите его в разделе «Данные».',
    )
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const forwardAbort = () => controller.abort()
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  // Сигнал мог сработать, пока готовили тело: повторного события не будет.
  if (options.signal?.aborted) controller.abort()

  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (clientToken !== null) headers['x-tidy-client'] = clientToken

  let response: Response
  try {
    response = await fetchImpl(`${apiBaseUrl(options.baseUrl)}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body ?? null,
      signal: controller.signal,
    })
  } catch (cause) {
    if (options.signal?.aborted) {
      throw new TidyApiError('aborted', 'Запрос отменён', { cause })
    }
    if (timedOut) {
      throw new TidyApiError('timeout', 'Сервис не ответил вовремя', { cause })
    }
    throw new TidyApiError('network', 'Не удалось связаться с сервисом', { cause })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardAbort)
  }

  if (!response.ok) throw await errorFromResponse(response)
  return response
}

/** Запрос, ответ которого — JSON. Нечитаемое тело → `invalid_response`. */
export async function requestJson<T>(
  path: string,
  options: TidyRequestOptions = {},
): Promise<T> {
  const response = await send(path, options)
  try {
    return (await response.json()) as T
  } catch (cause) {
    throw new TidyApiError('invalid_response', 'Сервис вернул некорректный ответ', {
      status: response.status,
      cause,
    })
  }
}

/**
 * Запрос, ответ которого — бинарное изображение. Пустой ответ и JSON вместо
 * картинки — `invalid_response`: молча сохранить мусор рядом с Оригиналом нельзя.
 */
export async function requestBlob(
  path: string,
  options: TidyRequestOptions = {},
): Promise<Blob> {
  const response = await send(path, options)
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (contentType.includes('application/json')) {
    throw new TidyApiError('invalid_response', 'Сервис вернул не изображение, а JSON', {
      status: response.status,
    })
  }
  const blob = await response.blob()
  if (blob.size === 0) {
    throw new TidyApiError('invalid_response', 'Сервис вернул пустое изображение', {
      status: response.status,
    })
  }
  return blob
}

// ---------------------------------------------------------------------------
// Base64 (общий для `/classify` и `/generate`, D13)
// ---------------------------------------------------------------------------

/**
 * Лимит воркера на тело запроса генерации — 12 МБ (`MAX_GENERATE_BODY_BYTES`).
 * Лимит входной картинки после декодирования — 8 МБ (`MAX_GENERATE_INPUT_BYTES`);
 * считаем в символах JSON, поэтому в лимит входит и base64, и обвязка.
 */
export const MAX_GENERATE_BODY_BYTES = 12 * 1024 * 1024
/** Потолок декодированных байтов входного изображения, синхронный с воркером. */
export const MAX_GENERATE_INPUT_BYTES = 8 * 1024 * 1024

/** Длина base64-строки без её построения. */
export function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}

/**
 * Кодирует байты в base64 без `String.fromCharCode(...bytes)`: спред всего массива
 * упирается в лимит аргументов и раздувает стек. Идём кусками по 32 КиБ.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

/**
 * Читает Blob в ArrayBuffer. `Blob.arrayBuffer()` есть в браузерах и Node, но не в
 * старых webview и в jsdom — там работает FileReader.
 */
export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return await blob.arrayBuffer()
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Не удалось прочитать изображение'))
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(blob)
  })
}

/** Blob → base64 без промежуточной data-строки. */
export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blobToArrayBuffer(blob)))
}

/** MIME для воркера: пустой тип у Blob означает JPEG, чужие типы не отправляем. */
export function mimeTypeOf(blob: Blob): string {
  const declared = (blob.type || '').toLowerCase().split(';')[0]?.trim() ?? ''
  return declared || 'image/jpeg'
}

// ---------------------------------------------------------------------------
// Генерация AI-версии
// ---------------------------------------------------------------------------

/** Опции создания задачи генерации: размер валидируется, но провайдер всегда рисует 1:1 / 1K. */
export interface CreateGenerationOptions extends TidyRequestOptions {
  width?: number
  height?: number
  /** Slug модели из `GET /models`. Без него воркер берёт модель по умолчанию. */
  model?: string
  /**
   * Референс для image-to-image перерисовки (D13) — Оригинал вещи. Размер
   * проверяется здесь до сборки base64; сжатие делает вызывающий код.
   */
  image?: Blob
  /**
   * `Idempotency-Key` (≤64 символов, `[A-Za-z0-9._:-]`): повторный `POST` с тем
   * же ключом возвращает уже существующую задачу у провайдера **без повторного
   * списания** (ADR-0006). Ключ генерируется и сохраняется на клиенте до отправки.
   */
  idempotencyKey?: string
  /** Вещь, для которой генерируется AI-версия: метаданные истории генераций. */
  itemId?: string
  /** Название вещи для списка генераций. */
  title?: string
  /** Категория вещи (верхний уровень таксономии). */
  category?: string
  /** Подкатегория вещи. */
  subcategory?: string
}

/** Форматы входного изображения, которые принимает воркер генерации. */
const GENERATE_INPUT_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/gif',
  'image/tiff',
])

/** Задача, поставленная воркером: ответ `POST /generate` со статусом 202. */
export interface GenerationTask {
  taskId: string
  /** Статус на момент постановки: обычно `PENDING`, возможен сразу `SUCCEEDED`. */
  status: string
  costRub: number | null
  /** Фактически выбранная воркером модель (может отличаться от запрошенной). */
  model: string
}

/** Текущий статус задачи: `PENDING` / `PROCESSING` / `SUCCEEDED` / `FAILED`. */
export interface GenerationStatus {
  taskId: string
  status: string
  costRub: number | null
}

/** Читает ответ `POST /generate`; пустой JSON — ошибка клиента, а не undefined. */
function readGenerationTask(body: unknown): GenerationTask {
  if (!isRecord(body) || typeof body.taskId !== 'string' || body.taskId.length === 0) {
    throw new TidyApiError('invalid_response', 'Сервис не вернул идентификатор задачи генерации')
  }
  return {
    taskId: body.taskId,
    status: typeof body.status === 'string' ? body.status : 'PENDING',
    costRub: typeof body.costRub === 'number' ? body.costRub : null,
    model: typeof body.model === 'string' ? body.model : '',
  }
}

/**
 * Ставит задачу генерации у воркера и возвращает её `taskId` (ADR-0006).
 * Картинка этим вызовом не ждётся: её забирают {@link getGenerationStatus} и
 * {@link downloadGeneration}. Промпт строит вызывающий: доменное знание о вещи
 * не должно утекать в транспорт.
 */
export async function createGeneration(
  prompt: string,
  options: CreateGenerationOptions = {},
): Promise<GenerationTask> {
  const {
    width,
    height,
    model,
    image,
    idempotencyKey,
    itemId,
    title,
    category,
    subcategory,
    headers,
    timeoutMs,
    ...rest
  } = options
  const payload: Record<string, unknown> = { prompt }
  if (width !== undefined) payload.width = width
  if (height !== undefined) payload.height = height
  if (model !== undefined && model.trim() !== '') payload.model = model.trim()
  if (idempotencyKey !== undefined && idempotencyKey.trim() !== '') {
    payload.idempotencyKey = idempotencyKey.trim()
  }
  if (itemId !== undefined && itemId.trim() !== '') payload.itemId = itemId.trim()
  if (title !== undefined && title.trim() !== '') payload.title = title.trim()
  if (category !== undefined && category.trim() !== '') payload.category = category.trim()
  if (subcategory !== undefined && subcategory.trim() !== '') {
    payload.subcategory = subcategory.trim()
  }

  if (image !== undefined) {
    // Формат и размер проверяем до base64: чужой или огромный Blob — ошибка
    // клиента, а не 413 от воркера.
    const mime = mimeTypeOf(image)
    if (!GENERATE_INPUT_MIME.has(mime)) {
      throw new TidyApiError('unsupported_media', `Формат ${mime} не поддерживается генерацией`)
    }
    if (image.size > MAX_GENERATE_INPUT_BYTES) {
      throw new TidyApiError(
        'image_too_large',
        'Изображение слишком большое для генерации. Сожмите его и попробуйте снова',
      )
    }
    let referenceBase64: string | null = null
    try {
      referenceBase64 = await blobToBase64(image)
    } catch {
      // Среда не умеет читать Blob (jsdom + fake-indexeddb отдают мёртвый клон
      // без arrayBuffer и не принимают его в FileReader). Честный запасной
      // сценарий — генерация без референса, а не сломанная оцифровка.
      referenceBase64 = null
    }
    if (referenceBase64 === null) {
      console.warn('[tidy-api] референс нечитаем — генерация без изображения')
    } else {
      payload.imageBase64 = referenceBase64
      payload.mimeType = mime
    }
  }

  const body = await requestJson<unknown>(GENERATE_PATH, {
    ...rest,
    timeoutMs: timeoutMs ?? GENERATE_TIMEOUT_MS,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(payload),
  })
  return readGenerationTask(body)
}

/**
 * Опрашивает статус задачи. Короткий вызов каждые ~3 с, поэтому таймаут у него
 * свой и небольшой: зависший опрос не должен держать экран статуса.
 */
export async function getGenerationStatus(
  taskId: string,
  options: TidyRequestOptions = {},
): Promise<GenerationStatus> {
  const body = await requestJson<unknown>(generationStatusPath(taskId), {
    ...options,
    timeoutMs: options.timeoutMs ?? GENERATION_STATUS_TIMEOUT_MS,
    method: 'GET',
  })
  if (!isRecord(body) || typeof body.status !== 'string') {
    throw new TidyApiError('invalid_response', 'Сервис вернул некорректный статус задачи')
  }
  return {
    taskId: typeof body.taskId === 'string' ? body.taskId : taskId,
    status: body.status,
    costRub: typeof body.costRub === 'number' ? body.costRub : null,
  }
}

/**
 * Скачивает готовую картинку задачи — отдельным запросом от статуса
 * (ADR-0006): файл не должен висеть в теле опроса.
 */
export async function downloadGeneration(
  taskId: string,
  options: TidyRequestOptions = {},
): Promise<Blob> {
  return await requestBlob(generationImagePath(taskId), {
    ...options,
    timeoutMs: options.timeoutMs ?? GENERATION_IMAGE_TIMEOUT_MS,
    method: 'GET',
  })
}
