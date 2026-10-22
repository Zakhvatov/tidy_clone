/**
 * История генераций на сервере (T23).
 *
 * Воркер запоминает успешно скачанные картинки в KV (`gen:{taskId}`) и отдаёт
 * их списком (`GET /generations`) вместе с байтами каждой картинки
 * (`GET /generations/{taskId}/image`). Этот модуль — тонкий клиент тех двух
 * маршрутов плюс восстановление: «забрать генерацию обратно в гардероб».
 *
 * Восстановление умеет два исхода. Если вещь из генерации жива локально,
 * AI-версия дописывается к ней; если вещь удалена — создаётся заново, но уже
 * без Оригинала (у генерации его не было): единственное изображение такой
 * вещи — AI-версия. Оба идентификатора детерминированы `taskId`
 * (`ai-{taskId}`, `restored-{taskId}`), поэтому повторное «забрать» не плодит
 * дублей — картинка с тем же id находится в хранилище, и вызов возвращает её.
 *
 * Сеть берётся из `tidy-api` (заголовок `x-tidy-client`, разбор ошибок), хранилище
 * — из `storage`; зависимости внедряются, чтобы тесты не ходили в сеть.
 */

import { FALLBACK_SUB, FALLBACK_TOP, isKnownSub, isKnownTop } from '../domain/taxonomy'
import type { Изображение, Вещь } from '../domain/types'
import * as images from '../storage/images'
import * as items from '../storage/items'
import { measureImage } from './import-item'
import { ensureTransparentPng } from './transparent'
import {
  GENERATION_IMAGE_TIMEOUT_MS,
  TidyApiError,
  requestBlob,
  requestJson,
  type TidyRequestOptions,
} from './tidy-api'

/** Путь списка сохранённых генераций. */
export const GENERATIONS_PATH = '/generations'

/** Путь скачивания картинки сохранённой генерации. */
export function generationHistoryImagePath(taskId: string): string {
  return `${GENERATIONS_PATH}/${encodeURIComponent(taskId)}/image`
}

/**
 * Одна запись истории — метаданные KV воркера. Необязательные поля воркер
 * может не отдавать, если их не было в `POST /generate`.
 */
export interface GenerationRecord {
  taskId: string
  title: string
  prompt: string
  model: string
  costRub: number | null
  createdAt: string
  itemId?: string
  category?: string
  subcategory?: string
  contentType?: string
  size?: number
}

/** Итог «забрать в гардероб»: `created` — создана ли новая вещь. */
export interface RestoreGenerationResult {
  itemId: string
  imageId: string
  created: boolean
}

/**
 * Зависимости восстановления. `download` нужен тестам, чтобы не ходить в сеть;
 * `measure`, `now` и `id` инжектируются ради детерминизма. Сами идентификаторы
 * восстановления детерминированы контрактом (`ai-{taskId}`, `restored-{taskId}`),
 * поэтому `id` в приложении не используется — поле оставлено для тестов.
 */
export interface RestoreGenerationDeps {
  download?: (taskId: string) => Promise<Blob>
  /**
   * Нормализация прозрачного фона (ADR-0008). По умолчанию — `ensureTransparentPng`;
   * применяется до измерения и сохранения, MIME берётся из итогового blob.
   */
  transparentize?: (blob: Blob) => Promise<Blob>
  measure?: (blob: Blob) => Promise<{ ширина: number; высота: number }>
  now?: () => string
  id?: () => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Читает одну запись истории; битая запись даёт `undefined` и пропускается. */
function readRecord(value: unknown): GenerationRecord | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.taskId !== 'string' || value.taskId.trim() === '') return undefined

  const текст = (поле: string): string => {
    const raw = value[поле]
    return typeof raw === 'string' ? raw : ''
  }
  // Необязательные поля: пустая строка и отсутствие значения равнозначны.
  const опционально = (поле: string): string | undefined => {
    const raw = value[поле]
    return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined
  }
  const size = typeof value.size === 'number' && Number.isFinite(value.size) ? value.size : undefined

  return {
    taskId: value.taskId,
    title: текст('title'),
    prompt: текст('prompt'),
    model: текст('model'),
    costRub: typeof value.costRub === 'number' ? value.costRub : null,
    createdAt: текст('createdAt'),
    itemId: опционально('itemId'),
    category: опционально('category'),
    subcategory: опционально('subcategory'),
    contentType: опционально('contentType'),
    ...(size === undefined ? {} : { size }),
  }
}

/**
 * Список сохранённых на сервере генераций. Битые элементы (не объекты, без
 * `taskId`) пропускаются; если же `items` не массив вовсе — это уже не список,
 * а сбой контракта: `invalid_response`.
 */
export async function listGenerationHistory(
  options: TidyRequestOptions = {},
): Promise<GenerationRecord[]> {
  const body = await requestJson<unknown>(GENERATIONS_PATH, { ...options, method: 'GET' })
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new TidyApiError('invalid_response', 'Сервис вернул некорректный список генераций')
  }
  const записи: GenerationRecord[] = []
  for (const элемент of body.items) {
    const запись = readRecord(элемент)
    if (запись !== undefined) записи.push(запись)
  }
  return записи
}

/** Скачивает картинку сохранённой генерации по её `taskId`. */
export async function downloadHistoryImage(
  taskId: string,
  options: TidyRequestOptions = {},
): Promise<Blob> {
  return await requestBlob(generationHistoryImagePath(taskId), {
    ...options,
    timeoutMs: options.timeoutMs ?? GENERATION_IMAGE_TIMEOUT_MS,
    method: 'GET',
  })
}

/**
 * «Забрать в гардероб»: сохраняет картинку генерации как AI-версию (роль `ai`).
 *
 * - картинка этой задачи уже в хранилище — возвращаем её и `itemId` без
 *   повторного скачивания и без дубля;
 * - вещь `record.itemId` жива — AI-версия дописывается к ней;
 * - вещи нет — создаётся новая: `restored-{taskId}`, без Оригинала,
 *   с категорией из записи (или «Разное», если таксономия её не узнала).
 *
 * Если сохранить изображение у только что созданной вещи не вышло, вещь
 * откатывается — в гардеробе не остаётся «пустой» карточки.
 */
export async function restoreGeneration(
  record: GenerationRecord,
  options: TidyRequestOptions & RestoreGenerationDeps = {},
): Promise<RestoreGenerationResult> {
  const imageId = `ai-${record.taskId}`

  // Идемпотентность: id изображения детерминирован taskId, поэтому повторное
  // «забрать» находит сохранённую картинку до всякой сети.
  const существующая = await images.get(imageId)
  if (существующая !== undefined) {
    return { itemId: существующая.idВещи, imageId, created: false }
  }

  const скачать = options.download ?? ((taskId: string) => downloadHistoryImage(taskId, options))
  const скачанный = await скачать(record.taskId)
  const blob = await (options.transparentize ?? ensureTransparentPng)(скачанный)

  const измерить = options.measure ?? measureImage
  // 0×0 допустимо: jsdom и старые webview не умеют мерить картинки.
  const { ширина, высота } = await измерить(blob)
  const дата = (options.now ?? (() => new Date().toISOString()))()
  const mime = blob.type || record.contentType || 'image/jpeg'

  // Вещь из генерации жива — просто дописываем ей AI-версию.
  const цель = record.itemId === undefined ? undefined : await items.get(record.itemId)
  if (цель !== undefined) {
    const изображение: Изображение = {
      id: imageId,
      idВещи: цель.id,
      роль: 'ai',
      blob,
      ширина,
      высота,
      mime,
      датаСоздания: дата,
    }
    await images.addAiVersion(изображение)
    await items.update(цель.id, {
      idИзображений: [...цель.idИзображений.filter((id) => id !== imageId), imageId],
    })
    return { itemId: цель.id, imageId, created: false }
  }

  // Вещи нет — восстанавливаем её по записи. Оригинала у генерации не было:
  // источник честно «фото», единственное изображение — AI-версия.
  const категория =
    record.category !== undefined && isKnownTop(record.category) ? record.category : FALLBACK_TOP
  const подкатегория =
    record.subcategory !== undefined && isKnownSub(категория, record.subcategory)
      ? record.subcategory
      : FALLBACK_SUB

  const вещь: Вещь = {
    id: `restored-${record.taskId}`,
    название: record.title.trim() !== '' ? record.title.trim() : 'AI-версия',
    категория,
    подкатегория,
    цвета: [],
    состав: [],
    сезон: [],
    бренд: '',
    источник: 'фото',
    датаСоздания: дата,
    датаОбновления: дата,
    idИзображений: [imageId],
  }
  await items.create(вещь)

  const изображение: Изображение = {
    id: imageId,
    idВещи: вещь.id,
    роль: 'ai',
    blob,
    ширина,
    высота,
    mime,
    датаСоздания: дата,
  }
  try {
    await images.addAiVersion(изображение)
  } catch (cause) {
    // Откат: вещь без изображений пользователю не нужна.
    try {
      await items.remove(вещь.id)
    } catch {
      // Откат не удался — важнее показать исходную ошибку хранилища.
    }
    throw cause
  }
  return { itemId: вещь.id, imageId, created: true }
}
