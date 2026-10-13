/**
 * Классификация фото через воркер (T7, вход «фото»).
 *
 * Ссылки WB классифицируются детерминированным словарём (`src/domain/wb-taxonomy.ts`).
 * Для фото данных продавца нет, поэтому категорию определяет vision-модель — но не
 * свободным текстом, а выбором из нашей фиксированной таксономии. Модель зовётся
 * только через воркер: браузер не может ходить в AI-API напрямую (CORS), а ключи не
 * должны попадать на устройство (ADR-0003).
 *
 * Контракт воркера `POST /classify`:
 *   запрос:  { imageBase64: string, mimeType: string }
 *   ответ:   { category: string, subcategory: string, confidence: number }
 *   ошибка:  { error: { code: string, message: string } }
 *
 * Ответ обязательно перепроверяется нашей таксономией: что бы ни ответила модель,
 * наружу выходит только пара из ADR-0004 либо «Разное»/«Разное» с `needsReview`.
 */

import {
  FALLBACK_SUB,
  FALLBACK_TOP,
  TAXONOMY,
  isKnownSub,
  isKnownTop,
  type TopCategory,
} from '../domain/taxonomy'

/** Базовый URL воркера по умолчанию. Переопределяется `VITE_TIDY_API_URL`. */
export const DEFAULT_API_URL = 'https://tidy-api.megabaff2011.workers.dev'

/**
 * Лимит воркера на тело запроса — 4 МБ (`MAX_CLASSIFY_BODY_BYTES`). Считаем в
 * символах JSON, как это делает сам воркер, поэтому в лимит входит и base64,
 * и обвязка. base64 раздувает картинку примерно на треть, так что реальный
 * предел файла — около 3 МБ.
 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Длинная сторона, до которой сжимаем фото перед отправкой (как у vision-провайдера). */
export const MAX_IMAGE_SIDE = 2000

const DEFAULT_TIMEOUT_MS = 30_000

/** Запас на `{"imageBase64":"...","mimeType":"image/jpeg"}` вокруг строки. */
const JSON_OVERHEAD_BYTES = 128

/** MIME, которые принимает воркер. */
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])

/** Коды ошибок клиента. `not_configured` приходит от воркера (нет секрета). */
export type ClassifyErrorCode =
  | 'not_configured'
  | 'unauthorized'
  | 'rate_limited'
  | 'image_too_large'
  | 'unsupported_media'
  | 'bad_request'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'server'
  | 'invalid_response'

/** Понятная ошибка распознавания: UI показывает `message`, логика смотрит на `code`. */
export class ClassifyError extends Error {
  readonly code: ClassifyErrorCode
  readonly status?: number

  constructor(code: ClassifyErrorCode, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ClassifyError'
    this.code = code
    this.status = options.status
  }
}

/** Результат классификации фото — та же форма, что и у словаря WB. */
export interface PhotoClassification {
  top: string
  sub: string
  confidence: number
  needsReview: boolean
}

/** Функция сжатия изображения. Инжектируется, чтобы тесты обходились без canvas. */
export type ImageResizer = (blob: Blob, maxSide: number) => Promise<Blob>

export interface ClassifyPhotoOptions {
  /** Для тестов и для окружений с подменённым fetch. */
  fetchImpl?: typeof fetch
  /** Базовый URL воркера; по умолчанию `VITE_TIDY_API_URL` или `DEFAULT_API_URL`. */
  baseUrl?: string
  /** Отмена извне (например, пользователь ушёл с экрана). */
  signal?: AbortSignal
  timeoutMs?: number
  maxBodyBytes?: number
  /** `null` отключает сжатие (среда без canvas): тогда слишком большой файл — ошибка. */
  resize?: ImageResizer | null
  /**
   * Клиентский токен воркера. По умолчанию берётся из `VITE_TIDY_CLIENT_TOKEN`.
   * `null` или пустая строка — запрос без заголовка `x-tidy-client` (воркер ответит 401).
   */
  clientToken?: string | null
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
 * Клиентский токен воркера. Если `VITE_TIDY_CLIENT_TOKEN` не задан, возвращается `null`
 * и запрос уйдёт без заголовка — это явно «не настроено», а не тихий обход защиты
 * (воркер ответит 401 `unauthorized`).
 */
export function clientTokenFromEnv(explicit?: string | null): string | null {
  const value = explicit === undefined ? import.meta.env?.VITE_TIDY_CLIENT_TOKEN : explicit
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

// ---------------------------------------------------------------------------
// Размер и base64
// ---------------------------------------------------------------------------

/** Длина base64-строки без её построения. */
export function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}

/** Оценка размера JSON-тела до его сборки — чтобы не держать в памяти копию зря. */
export function estimateBodyBytes(byteLength: number, overhead = JSON_OVERHEAD_BYTES): number {
  return base64Length(byteLength) + overhead
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
async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
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
// Сжатие (canvas)
// ---------------------------------------------------------------------------

/**
 * Ужимает изображение до `maxSide` по большей стороне и перекодирует в JPEG.
 * Нужна для фото с телефона: 12 Мп HEIC не влезет в лимит воркера, а для vision
 * 2000 px по длинной стороне достаточно. Требует `createImageBitmap` и canvas.
 */
async function canvasResize(blob: Blob, maxSide: number): Promise<Blob> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    throw new Error('canvas недоступен в этой среде')
  }
  const bitmap = await createImageBitmap(blob)
  try {
    const longest = Math.max(bitmap.width, bitmap.height)
    const scale = longest > maxSide ? maxSide / longest : 1
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2D-контекст canvas недоступен')
    context.drawImage(bitmap, 0, 0, width, height)

    const resized = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    if (!resized) throw new Error('canvas не смог перекодировать изображение')
    return resized
  } finally {
    bitmap.close?.()
  }
}

// ---------------------------------------------------------------------------
// Валидация ответа
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeConfidence(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.min(1, Math.max(0, numeric))
}

function ownerOf(sub: string): TopCategory | null {
  for (const top of Object.keys(TAXONOMY) as TopCategory[]) {
    if ((TAXONOMY[top] as readonly string[]).includes(sub)) return top
  }
  return null
}

/**
 * Приводит ответ модели к нашей таксономии. Принимается только полная валидная пара
 * (или подкатегория, у которой однозначно находится владелец). Всё остальное —
 * «Разное»/«Разное» + `needsReview`, чтобы вещь не потерялась и не легла в чужую полку.
 */
export function normalizeClassification(payload: unknown): PhotoClassification {
  const fallback: PhotoClassification = {
    top: FALLBACK_TOP,
    sub: FALLBACK_SUB,
    confidence: 0,
    needsReview: true,
  }
  if (!isRecord(payload)) return fallback

  const confidence = normalizeConfidence(payload.confidence)
  const category = typeof payload.category === 'string' ? payload.category.trim() : ''
  const subcategory = typeof payload.subcategory === 'string' ? payload.subcategory.trim() : ''

  if (category !== '' && subcategory !== '' && isKnownTop(category) && isKnownSub(category, subcategory)) {
    return { top: category, sub: subcategory, confidence, needsReview: false }
  }

  // Модель ошиблась верхним уровнем, но подкатегория однозначно чья-то — восстанавливаем.
  if (subcategory !== '') {
    const owner = ownerOf(subcategory)
    if (owner) return { top: owner, sub: subcategory, confidence, needsReview: false }
  }

  return { ...fallback, confidence }
}

// ---------------------------------------------------------------------------
// Клиент
// ---------------------------------------------------------------------------

async function errorFromResponse(response: Response): Promise<ClassifyError> {
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
    return new ClassifyError(
      'not_configured',
      message || 'Распознавание недоступно: сервис не настроен',
      { status: response.status },
    )
  }
  if (response.status === 401 || code === 'unauthorized') {
    return new ClassifyError('unauthorized', message || 'Распознавание недоступно: неверный клиентский токен', {
      status: response.status,
    })
  }
  if (response.status === 429 || code === 'rate_limited') {
    return new ClassifyError(
      'rate_limited',
      message || 'Слишком много запросов на распознавание. Подождите минуту и попробуйте снова.',
      { status: response.status },
    )
  }
  if (response.status === 413 || code === 'payload_too_large') {
    return new ClassifyError('image_too_large', message || 'Фото слишком большое для распознавания', {
      status: response.status,
    })
  }
  if (response.status >= 400 && response.status < 500) {
    return new ClassifyError('bad_request', message || `Некорректный запрос к сервису (${response.status})`, {
      status: response.status,
    })
  }
  return new ClassifyError('server', message || `Сервис распознавания вернул ошибку (${response.status})`, {
    status: response.status,
  })
}

/**
 * Отправляет фото в воркер и возвращает категорию из нашей таксономии.
 *
 * Размер проверяется до отправки. Если фото больше лимита и доступен canvas,
 * оно ужимается до `MAX_IMAGE_SIDE`; если сжать нельзя — понятная ошибка
 * `image_too_large`, а не молчаливый 413 от воркера.
 *
 * Приоритет ошибок: отмена извне → таймаут → сеть, затем HTTP-коды.
 */
export async function classifyPhoto(
  blob: Blob,
  options: ClassifyPhotoOptions = {},
): Promise<PhotoClassification> {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const resize = options.resize === undefined ? canvasResize : options.resize
  const fetchImpl = options.fetchImpl ?? fetch

  if (options.signal?.aborted) {
    throw new ClassifyError('aborted', 'Распознавание отменено')
  }

  let prepared = blob
  if (estimateBodyBytes(prepared.size) > maxBodyBytes) {
    if (!resize) {
      throw new ClassifyError('image_too_large', 'Фото слишком большое для распознавания')
    }
    try {
      prepared = await resize(blob, MAX_IMAGE_SIDE)
    } catch (cause) {
      throw new ClassifyError(
        'image_too_large',
        'Фото слишком большое, а сжать его не удалось. Попробуйте другое изображение.',
        { cause },
      )
    }
  }
  if (estimateBodyBytes(prepared.size) > maxBodyBytes) {
    throw new ClassifyError(
      'image_too_large',
      'Даже после сжатия фото больше лимита распознавания. Попробуйте другое изображение.',
    )
  }

  const mimeType = mimeTypeOf(prepared)
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new ClassifyError('unsupported_media', `Формат ${mimeType} не поддерживается распознаванием`)
  }

  const imageBase64 = await blobToBase64(prepared)
  const body = JSON.stringify({ imageBase64, mimeType })
  if (body.length > maxBodyBytes) {
    throw new ClassifyError('image_too_large', 'Фото слишком большое для распознавания')
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const forwardAbort = () => controller.abort()
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  // Сигнал мог сработать, пока читали и кодировали файл: повторного события не будет.
  if (options.signal?.aborted) controller.abort()

  const clientToken = clientTokenFromEnv(options.clientToken)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (clientToken !== null) headers['x-tidy-client'] = clientToken

  let response: Response
  try {
    response = await fetchImpl(`${apiBaseUrl(options.baseUrl)}/classify`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })
  } catch (cause) {
    if (options.signal?.aborted) {
      throw new ClassifyError('aborted', 'Распознавание отменено', { cause })
    }
    if (timedOut) {
      throw new ClassifyError('timeout', 'Сервис распознавания не ответил вовремя', { cause })
    }
    throw new ClassifyError('network', 'Не удалось связаться с сервисом распознавания', { cause })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardAbort)
  }

  if (!response.ok) throw await errorFromResponse(response)

  let payload: unknown
  try {
    payload = await response.json()
  } catch (cause) {
    throw new ClassifyError('invalid_response', 'Сервис распознавания вернул некорректный ответ', { cause })
  }
  return normalizeClassification(payload)
}
