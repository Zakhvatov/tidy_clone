/**
 * Единый клиент воркера-посредника `tidy-api` (T10).
 *
 * Зачем отдельный модуль: заголовок `x-tidy-client`, базовый URL, таймаут,
 * отмена и разбор `{error:{code,message}}` нужны и распознаванию фото (T7),
 * и генерации AI-версии (T10). Две реализации одного и того же заголовка
 * расходятся молча, поэтому все сетевые детали воркера живут здесь, а
 * `classify-photo.ts` и `digitize.ts` ходят только через этот клиент.
 *
 * Контракт воркера (ADR-0003, `workers/api`):
 *   GET  /models                              → {models:[{slug,title,priceRub}], defaultSlug}
 *   POST /generate  {prompt, model?, width?, height?} → image/* байтами
 *   POST /classify  {imageBase64, mimeType}   → {category, subcategory, confidence}
 *   GET  /health                              → {ok, generate, classify}
 *   ошибка:                                   → {error:{code,message}}
 *
 * Секреты воркера (ключ генерации, ключ vision-провайдера) на клиент не попадают.
 * Клиентский токен — не секрет доступа к данным, а барьер от посторонних:
 * он лежит в сборке (`VITE_TIDY_CLIENT_TOKEN`) и уходит заголовком.
 */

/** Базовый URL воркера по умолчанию. Переопределяется `VITE_TIDY_API_URL`. */
export const DEFAULT_API_URL = 'https://tidy-api.megabaff2011.workers.dev'

/** Таймаут обычного запроса (классификация, служебные). */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Таймаут генерации. Провайдер асинхронный: воркер ставит задачу, опрашивает
 * статус и скачивает файл. Держим больше воркерского предела (75 с), чтобы
 * получить его 504 с текстом, а не оборванное соединение.
 */
export const GENERATE_TIMEOUT_MS = 90_000

/** Путь генерации AI-версии. */
export const GENERATE_PATH = '/generate'

/** Путь каталога моделей генерации. */
export const MODELS_PATH = '/models'

/** Путь распознавания категории по фото. */
export const CLASSIFY_PATH = '/classify'

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
   * Клиентский токен воркера. По умолчанию берётся из `VITE_TIDY_CLIENT_TOKEN`.
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
 * Клиентский токен воркера. Если `VITE_TIDY_CLIENT_TOKEN` не задан, возвращается
 * `null` и запрос уйдёт без заголовка — воркер ответит 401, и это будет видно.
 */
export function clientTokenFromEnv(explicit?: string | null): string | null {
  const value = explicit === undefined ? import.meta.env?.VITE_TIDY_CLIENT_TOKEN : explicit
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
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
  const clientToken = clientTokenFromEnv(options.clientToken)
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
// Генерация AI-версии
// ---------------------------------------------------------------------------

/** Опции генерации: размер валидируется, но провайдер всегда рисует 1:1 / 1K. */
export interface GenerateImageOptions extends TidyRequestOptions {
  width?: number
  height?: number
  /** Slug модели из `GET /models`. Без него воркер берёт модель по умолчанию. */
  model?: string
}

/**
 * Просит воркер сгенерировать каталожное изображение по промпту. Возвращает
 * `Blob` (квадратный кадр 1K; формат — тот, что отдал провайдер). Промпт строит
 * вызывающий: доменное знание о вещи не должно утекать в транспорт.
 */
export async function generateImage(
  prompt: string,
  options: GenerateImageOptions = {},
): Promise<Blob> {
  const { width, height, model, headers, timeoutMs, ...rest } = options
  const payload: Record<string, unknown> = { prompt }
  if (width !== undefined) payload.width = width
  if (height !== undefined) payload.height = height
  if (model !== undefined && model.trim() !== '') payload.model = model.trim()

  return requestBlob(GENERATE_PATH, {
    ...rest,
    timeoutMs: timeoutMs ?? GENERATE_TIMEOUT_MS,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(payload),
  })
}
