/**
 * Модели генерации AI-версии и их цены (T22).
 *
 * Провайдер IskraGen отдаёт каталог моделей через воркер `GET /models`:
 * воркер фильтрует только text-to-image и подставляет живые цены. Клиент
 * кэширует ответ на сессию, а при недоступности сервиса остаётся со
 * статическим списком — выбор и генерация не должны зависеть от лишнего запроса.
 *
 * Цена — базовая за кадр 1:1 / 1K. Это то, что реально запрашивает воркер,
 * поэтому в интерфейсе честно писать «за кадр», а не «от».
 */

import { requestJson, type TidyRequestOptions } from './tidy-api'

/** Модель, которую видит и выбирает пользователь. */
export interface GenerationModel {
  slug: string
  title: string
  priceRub: number
}

/** Ответ воркера `GET /models`. */
export interface GenerationModelsResult {
  models: GenerationModel[]
  defaultSlug: string
  /** Цены пришли из живого каталога, а не из статического списка. */
  live: boolean
}

/** Путь каталога моделей в воркере. */
export const GENERATION_MODELS_PATH = '/models'

/** Модель по умолчанию, если сервер не подсказал другую. */
export const DEFAULT_GENERATION_MODEL_SLUG = 'gpt-image-2-text-to-image'

/** Ключ выбранной модели в localStorage: выбор переживает перезапуск. */
const STORAGE_KEY = 'tidy:generation-model'

/** Кэш каталога на сессию: не дёргаем воркер при каждом открытии карточки. */
const CACHE_TTL_MS = 30 * 60 * 1000

/**
 * Запасной список — цены из публичного каталога провайдера на момент D13.
 * Он нужен, если воркер или каталог недоступны; заказ модели при этом работает.
 * i2i-модели (D13) перечислены вместе с т2и — выбор и генерация по референсу
 * не зависят от живого каталога.
 */
export const FALLBACK_GENERATION_MODELS: readonly GenerationModel[] = [
  { slug: 'nano-banana-2-1', title: 'Nano Banana 2.1', priceRub: 4 },
  { slug: 'nano-banana-2-lite', title: 'Nano Banana 2 Lite', priceRub: 5 },
  { slug: 'grok-imagine-image-2-0-image-edit', title: 'Grok Imagine 2.0 Edit', priceRub: 5 },
  { slug: 'grok-imagine-image-2-0-text-to-image', title: 'Grok Imagine 2.0', priceRub: 5 },
  { slug: 'grok-imagine-text-to-image', title: 'Grok Imagine', priceRub: 5 },
  { slug: 'grok-imagine-image-to-image', title: 'Grok Imagine Image', priceRub: 5 },
  { slug: 'flux-2-pro-image-to-image', title: 'Flux 2 Pro Image', priceRub: 6 },
  { slug: 'qwen3-text-to-image', title: 'Qwen Image 3.0', priceRub: 7 },
  { slug: 'qwen3-image-to-image', title: 'Qwen Image 3.0 Image', priceRub: 7 },
  { slug: 'gpt-image-2-text-to-image', title: 'GPT Image 2', priceRub: 7 },
  { slug: 'gpt-image-2-image-to-image', title: 'GPT Image 2 Image', priceRub: 7 },
  { slug: 'gpt-image-2-5-flare-text-to-image', title: 'GPT Image 2.5 Flare', priceRub: 7 },
  { slug: 'gpt-image-2-5-flare-image-to-image', title: 'GPT Image 2.5 Flare Image', priceRub: 7 },
  { slug: 'nano-banana-2', title: 'Nano Banana 2', priceRub: 10 },
  { slug: 'midjourney-text-to-image', title: 'Midjourney', priceRub: 20 },
]

let cache: { at: number; result: GenerationModelsResult } | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Оставляет только валидные модели; мусор от сервиса не должен ломать выбор. */
function parseModels(value: unknown): GenerationModel[] {
  if (!isRecord(value) || !Array.isArray(value.models)) return []
  const models: GenerationModel[] = []
  for (const item of value.models) {
    if (!isRecord(item)) continue
    const slug = item.slug
    const title = item.title
    const priceRub = item.priceRub
    if (
      typeof slug === 'string' &&
      slug.trim() !== '' &&
      typeof title === 'string' &&
      title.trim() !== '' &&
      typeof priceRub === 'number' &&
      Number.isFinite(priceRub) &&
      priceRub >= 0
    ) {
      models.push({ slug: slug.trim(), title: title.trim(), priceRub })
    }
  }
  return models
}

function readDefaultSlug(value: unknown, models: readonly GenerationModel[]): string {
  const slug = isRecord(value) && typeof value.defaultSlug === 'string' ? value.defaultSlug : ''
  if (models.some((model) => model.slug === slug)) return slug
  const fallback = models.find((model) => model.slug === DEFAULT_GENERATION_MODEL_SLUG)
  return fallback?.slug ?? models[0]?.slug ?? DEFAULT_GENERATION_MODEL_SLUG
}

/**
 * Загружает каталог моделей. Сеть и таймаут настраиваются как у остальных
 * запросов к воркеру; сбой не бросается наружу — возвращается запасной список.
 */
export async function loadGenerationModels(
  options: TidyRequestOptions = {},
): Promise<GenerationModelsResult> {
  if (cache !== null && Date.now() - cache.at < CACHE_TTL_MS) return cache.result

  const fallback: GenerationModelsResult = {
    models: [...FALLBACK_GENERATION_MODELS],
    defaultSlug: DEFAULT_GENERATION_MODEL_SLUG,
    live: false,
  }

  try {
    const payload: unknown = await requestJson<unknown>(GENERATION_MODELS_PATH, {
      timeoutMs: 10_000,
      ...options,
    })
    const models = parseModels(payload)
    if (models.length === 0) return fallback
    const result: GenerationModelsResult = {
      models,
      defaultSlug: readDefaultSlug(payload, models),
      live: true,
    }
    cache = { at: Date.now(), result }
    return result
  } catch {
    return fallback
  }
}

/** Слагаемое сохранённого выбора; `null`, если его нет или хранилище недоступно. */
export function storedGenerationModelSlug(): string | null {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY)
    return value !== null && value !== undefined && value.trim() !== '' ? value.trim() : null
  } catch {
    return null
  }
}

/** Запоминает выбор. Сбой хранилища не должен мешать генерации. */
export function storeGenerationModelSlug(slug: string): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, slug)
  } catch {
    // приватный режим или переполненное хранилище — выбор проживёт до перезапуска
  }
}

/**
 * Какая модель выбрана: сохранённая, если она ещё есть в каталоге, иначе
 * серверная по умолчанию, иначе первая доступная.
 */
export function resolveGenerationModel(
  models: readonly GenerationModel[],
  storedSlug: string | null,
  defaultSlug: string,
): GenerationModel {
  return (
    models.find((model) => model.slug === storedSlug) ??
    models.find((model) => model.slug === defaultSlug) ??
    models[0] ?? { slug: DEFAULT_GENERATION_MODEL_SLUG, title: 'GPT Image 2', priceRub: 7 }
  )
}

/** Сбрасывает кэш каталога. Только для тестов. */
export function resetGenerationModelsCache(): void {
  cache = null
}
