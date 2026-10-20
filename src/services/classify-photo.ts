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
import {
  CLASSIFY_PATH,
  DEFAULT_TIMEOUT_MS,
  TidyApiError,
  base64Length,
  blobToBase64,
  mimeTypeOf,
  requestJson,
} from './tidy-api'

/**
 * Сетевые детали воркера (базовый URL, заголовок `x-tidy-client`, таймаут,
 * разбор `{error:{code,message}}`) живут в `tidy-api.ts` — здесь остаётся только
 * подготовка изображения и проверка ответа по таксономии. Экспорты ниже
 * сохранены ради обратной совместимости с вызывающим кодом и тестами.
 */
export { DEFAULT_API_URL, apiBaseUrl, clientTokenFromEnv } from './tidy-api'
/** Ошибка распознавания — тот же класс, что и у клиента воркера (T10). */
export { TidyApiError as ClassifyError } from './tidy-api'
export type { TidyApiErrorCode as ClassifyErrorCode } from './tidy-api'

/**
 * Кодировка base64 и MIME одна на всё общение с воркером — живут в tidy-api,
 * отсюда реэкспортируются старым именам ради совместимости.
 */
export {
  base64Length,
  bytesToBase64,
  blobToBase64,
  blobToArrayBuffer,
  mimeTypeOf,
} from './tidy-api'

/**
 * Лимит воркера на тело запроса — 4 МБ (`MAX_CLASSIFY_BODY_BYTES`). Считаем в
 * символах JSON, как это делает сам воркер, поэтому в лимит входит и base64,
 * и обвязка. base64 раздувает картинку примерно на треть, так что реальный
 * предел файла — около 3 МБ.
 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Длинная сторона, до которой сжимаем фото перед отправкой (как у vision-провайдера). */
export const MAX_IMAGE_SIDE = 2000

/** MIME, которые принимает воркер. */
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])

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
// Размер и base64
// ---------------------------------------------------------------------------

/** Запас на `{"imageBase64":"...","mimeType":"image/jpeg"}` вокруг строки. */
const JSON_OVERHEAD_BYTES = 128

/** Оценка размера JSON-тела до его сборки — чтобы не держать в памяти копию зря. */
export function estimateBodyBytes(byteLength: number, overhead = JSON_OVERHEAD_BYTES): number {
  return base64Length(byteLength) + overhead
}

// ---------------------------------------------------------------------------
// Сжатие (canvas)
// ---------------------------------------------------------------------------

/**
 * Ужимает изображение до `maxSide` по большей стороне и перекодирует в JPEG.
 * Нужна для фото с телефона: 12 Мп HEIC не влезет в лимит воркера, а для vision
 * 2000 px по длинной стороне достаточно. Требует `createImageBitmap` и canvas.
 *
 * Публичный с D13: тем же способом digitize сжимает Оригинал для i2i-генерации.
 */
export async function canvasResize(blob: Blob, maxSide: number): Promise<Blob> {
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
    throw new TidyApiError('aborted', 'Распознавание отменено')
  }

  let prepared = blob
  if (estimateBodyBytes(prepared.size) > maxBodyBytes) {
    if (!resize) {
      throw new TidyApiError('image_too_large', 'Фото слишком большое для распознавания')
    }
    try {
      prepared = await resize(blob, MAX_IMAGE_SIDE)
    } catch (cause) {
      throw new TidyApiError(
        'image_too_large',
        'Фото слишком большое, а сжать его не удалось. Попробуйте другое изображение.',
        { cause },
      )
    }
  }
  if (estimateBodyBytes(prepared.size) > maxBodyBytes) {
    throw new TidyApiError(
      'image_too_large',
      'Даже после сжатия фото больше лимита распознавания. Попробуйте другое изображение.',
    )
  }

  const mimeType = mimeTypeOf(prepared)
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new TidyApiError('unsupported_media', `Формат ${mimeType} не поддерживается распознаванием`)
  }

  const imageBase64 = await blobToBase64(prepared)
  const body = JSON.stringify({ imageBase64, mimeType })
  if (body.length > maxBodyBytes) {
    throw new TidyApiError('image_too_large', 'Фото слишком большое для распознавания')
  }

  const payload = await requestJson<unknown>(CLASSIFY_PATH, {
    fetchImpl,
    baseUrl: options.baseUrl,
    signal: options.signal,
    timeoutMs,
    clientToken: options.clientToken,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  return normalizeClassification(payload)
}
