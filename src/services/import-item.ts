/**
 * Подготовка вещи к добавлению: два входа T8 без оцифровки.
 *
 * Вход «ссылка»: `parseWbLink` → `loadWbCard` → `pickBestPhoto` → скачивание
 * выбранного фото как `Blob`. Вход «фото»: файл пользователя → `classifyPhoto`
 * (vision определяет категорию из нашей таксономии).
 *
 * Модуль ничего не пишет в хранилище: по правилу зависимостей (architecture.md)
 * `services` знают только `domain`. Он возвращает черновик (`ItemDraft`) и умеет
 * собрать из него доменные сущности; запись в IndexedDB делает экран.
 *
 * Сети и React здесь нет как сущностей: `fetch` и функции анализа/классификации
 * внедряются, чтобы тесты шли без реальной сети и без canvas.
 */

import { FALLBACK_SUB, FALLBACK_TOP } from '../domain/taxonomy'
import type { ImageRole, Изображение, ItemSource, Вещь } from '../domain/types'
import { mapWbCategory } from '../domain/wb-taxonomy'
import { classifyPhoto, type PhotoClassification } from './classify-photo'
import { parseWbLink } from './wb/parse-link'
import { loadWbCard } from './wb/card'
import { analyzeImage, pickBestPhoto, type PackshotAnalysis, type PhotoAnalyzer } from './wb/packshot'
import { ОшибкаЗагрузкиКарточки, ОшибкаСсылкиWildberries } from './wb/errors'
import type { WbCard } from './wb/types'

/**
 * Верхняя граница размера оригинала, который кладём в IndexedDB.
 * iPhone отдаёт 3–6 МБ, панорамы и тяжёлые PNG бывают крупнее; 30 МБ — заведомо
 * «слишком большое фото», которое лучше отклонить с понятным текстом.
 */
export const MAX_ORIGINAL_BYTES = 30 * 1024 * 1024

/** Причина, по которой вещь не удалось подготовить. */
export type ImportErrorCode =
  | 'link'
  | 'not_found'
  | 'network'
  | 'photo'
  | 'photo_too_large'
  | 'unknown'

/** Понятная ошибка импорта: `message` показывается пользователю как есть. */
export class ОшибкаИмпортаВещи extends Error {
  readonly code: ImportErrorCode

  constructor(code: ImportErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ОшибкаИмпортаВещи'
    this.code = code
  }
}

/**
 * Черновик вещи для превью и правки категории. `фото` — будущий **Оригинал**
 * (неизменяемое исходное изображение). Ни одно поле, кроме фото, не обязательно.
 */
export interface ItemDraft {
  источник: ItemSource
  /** `nmId` карточки, если вещь пришла по ссылке. */
  wbNmId?: number
  название: string
  категория: string
  подкатегория: string
  /** Категория определена неуверенно — предложить выбрать вручную. */
  needsReview: boolean
  бренд: string
  цвета: string[]
  состав: string[]
  /** Пакшот ли выбранное фото. `undefined` для входа «фото»: там эвристика не считалась. */
  packshot?: boolean
  фото: Blob
  ширина: number
  высота: number
  mime: string
}

/** Зависимости импорта: внедряются тестами, в приложении берутся по умолчанию. */
export interface ImportOptions {
  /** Подмена сети. */
  fetchImpl?: typeof fetch
  /** Анализ «пакшот ли фото» — по умолчанию реальный canvas через `analyzeImage`. */
  analyze?: PhotoAnalyzer
  /** Классификация фото — по умолчанию `classifyPhoto`. */
  classify?: (blob: Blob) => Promise<PhotoClassification>
  /** Измерение размеров изображения — по умолчанию `measureImage`. */
  measure?: (blob: Blob) => Promise<{ ширина: number; высота: number }>
}

// ---------------------------------------------------------------------------
// Идентификаторы и размеры
// ---------------------------------------------------------------------------

/** id для доменных сущностей: `crypto.randomUUID`, иначе устойчивый запасной вариант. */
function newId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Размеры изображения. `createImageBitmap` есть во всех целевых браузерах; там,
 * где его нет (jsdom, старые webview), размеры неизвестны и возвращаем нули —
 * это честнее выдуманных чисел, а `ширина`/`высота` домена допускают 0.
 */
export async function measureImage(blob: Blob): Promise<{ ширина: number; высота: number }> {
  if (typeof createImageBitmap !== 'function') return { ширина: 0, высота: 0 }
  try {
    const bitmap = await createImageBitmap(blob)
    try {
      return { ширина: bitmap.width, высота: bitmap.height }
    } finally {
      bitmap.close?.()
    }
  } catch {
    return { ширина: 0, высота: 0 }
  }
}

// ---------------------------------------------------------------------------
// Сеть
// ---------------------------------------------------------------------------

function assertOnline(): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ОшибкаИмпортаВещи('network', 'Нет подключения к сети. Проверьте интернет и попробуйте снова')
  }
}

function assertOriginalSize(blob: Blob): void {
  if (blob.size > MAX_ORIGINAL_BYTES) {
    throw new ОшибкаИмпортаВещи(
      'photo_too_large',
      `Фото слишком большое (${Math.round(blob.size / 1024 / 1024)} МБ). Выберите фото до 30 МБ`,
    )
  }
}

/** Скачивает фото товара как Blob будущего Оригинала. */
export async function fetchPhotoBlob(url: string, fetchImpl: typeof fetch = fetch): Promise<Blob> {
  let response: Response
  try {
    response = await fetchImpl(url)
  } catch (cause) {
    throw new ОшибкаИмпортаВещи(
      'network',
      'Не удалось загрузить фото товара. Проверьте соединение и попробуйте снова',
      { cause },
    )
  }
  if (!response.ok) {
    throw new ОшибкаИмпортаВещи('photo', `Не удалось загрузить фото товара (код ${response.status})`)
  }
  const blob = await response.blob()
  if (blob.size === 0) {
    throw new ОшибкаИмпортаВещи('photo', 'Wildberries вернул пустое фото — попробуйте другую ссылку')
  }
  return blob
}

// ---------------------------------------------------------------------------
// Сборка доменных сущностей
// ---------------------------------------------------------------------------

/** Готовая к записи пара «Вещь + её Оригинал». */
export interface СобраннаяВещь {
  вещь: Вещь
  оригинал: Изображение
}

/**
 * Собирает доменную **Вещь** и **Оригинал** из черновика.
 * Оригинал получает роль `оригинал` и никогда не изменяется (ADR-0002).
 */
export function собратьВещь(черновик: ItemDraft, id: () => string = newId): СобраннаяВещь {
  const idВещи = id()
  const idИзображения = id()
  const дата = new Date().toISOString()

  const вещь: Вещь = {
    id: idВещи,
    название: черновик.название.trim(),
    категория: черновик.категория,
    подкатегория: черновик.подкатегория,
    цвета: [...черновик.цвета],
    состав: [...черновик.состав],
    сезон: [],
    бренд: черновик.бренд.trim(),
    источник: черновик.источник,
    ...(черновик.wbNmId === undefined ? {} : { wbNmId: черновик.wbNmId }),
    датаСоздания: дата,
    датаОбновления: дата,
    idИзображений: [idИзображения],
  }

  const оригинал: Изображение = {
    id: idИзображения,
    idВещи,
    роль: 'оригинал' satisfies ImageRole,
    blob: черновик.фото,
    ширина: черновик.ширина,
    высота: черновик.высота,
    mime: черновик.mime,
    датаСоздания: дата,
  }

  return { вещь, оригинал }
}

// ---------------------------------------------------------------------------
// Вход «ссылка»
// ---------------------------------------------------------------------------

/** Переводит ошибки WB в понятную ошибку импорта с сохранением текста. */
function какОшибкаИмпорта(cause: unknown, stage: 'link' | 'card'): ОшибкаИмпортаВещи {
  if (cause instanceof ОшибкаИмпортаВещи) return cause
  if (cause instanceof ОшибкаСсылкиWildberries) {
    return new ОшибкаИмпортаВещи('link', cause.message, { cause })
  }
  const message = cause instanceof ОшибкаЗагрузкиКарточки ? cause.message : ''
  if (message.includes('вовремя')) return new ОшибкаИмпортаВещи('network', message, { cause })
  if (message.includes('не найден')) return new ОшибкаИмпортаВещи('not_found', message, { cause })
  if (stage === 'link') {
    return new ОшибкаИмпортаВещи('link', message || 'Это не похоже на ссылку Wildberries', { cause })
  }
  return new ОшибкаИмпортаВещи(
    'not_found',
    message || 'Товар не найден на складах Wildberries. Проверьте ссылку',
    { cause },
  )
}

/**
 * Готовит черновик вещи по ссылке Wildberries. Карточка загружается один раз,
 * затем выбирается пакшот (или честно первое фото) и скачивается как Blob.
 */
export async function createDraftFromLink(
  input: string,
  options: ImportOptions = {},
): Promise<ItemDraft> {
  const fetchImpl = options.fetchImpl ?? fetch
  const measure = options.measure ?? measureImage
  assertOnline()

  let nmId: number
  try {
    nmId = parseWbLink(input).nmId
  } catch (cause) {
    throw какОшибкаИмпорта(cause, 'link')
  }

  let card: WbCard
  try {
    card = await loadWbCard(nmId, fetchImpl)
  } catch (cause) {
    throw какОшибкаИмпорта(cause, 'card')
  }

  if (card.photoUrls.length === 0) {
    throw new ОшибкаИмпортаВещи('photo', 'В карточке товара нет ни одного фото')
  }

  const cache = new Map<string, Blob>()
  const loadBlob = async (url: string): Promise<Blob> => {
    const cached = cache.get(url)
    if (cached !== undefined) return cached
    const blob = await fetchPhotoBlob(url, fetchImpl)
    cache.set(url, blob)
    return blob
  }
  const analyze: PhotoAnalyzer =
    options.analyze ??
    (async (url: string): Promise<PackshotAnalysis> => analyzeImage(await loadBlob(url)))

  const best = await pickBestPhoto(card.photoUrls, analyze)
  // Пакшота нет — берём первое фото и честно помечаем это в превью.
  const chosenUrl = best.isPackshot ? best.url : card.photoUrls[0]
  const фото = await loadBlob(chosenUrl)
  assertOriginalSize(фото)

  const mapping = mapWbCategory(card.rootSubjectName, card.subjectName)
  const { ширина, высота } = await measure(фото)

  return {
    источник: 'ссылка',
    wbNmId: card.nmId,
    название: card.name ?? '',
    категория: mapping.top,
    подкатегория: mapping.sub,
    needsReview: mapping.needsReview,
    бренд: card.brand ?? '',
    цвета: [...card.colors],
    состав: [...card.composition],
    packshot: best.isPackshot,
    фото,
    ширина,
    высота,
    mime: фото.type || 'image/webp',
  }
}

// ---------------------------------------------------------------------------
// Вход «фото»
// ---------------------------------------------------------------------------

/**
 * Готовит черновик вещи по фото из галереи. Категорию определяет vision-модель
 * через воркер; если это не удалось — «Разное» с предложением выбрать вручную,
 * и сохранение всё равно остаётся доступным (ADR-0004).
 */
export async function createDraftFromPhoto(
  file: Blob,
  options: ImportOptions = {},
): Promise<ItemDraft> {
  const measure = options.measure ?? measureImage
  const classify = options.classify ?? ((blob: Blob) => classifyPhoto(blob))

  if (file.type !== '' && !file.type.startsWith('image/')) {
    throw new ОшибкаИмпортаВещи('photo', 'Это не изображение. Выберите фото вещи')
  }
  assertOriginalSize(file)

  let mapping: PhotoClassification
  try {
    mapping = await classify(file)
  } catch {
    // Классификация — подстраховка, а не условие сохранения: вещь не теряем,
    // даже если vision недоступен или фото ему не понравилось (ADR-0004).
    mapping = { top: FALLBACK_TOP, sub: FALLBACK_SUB, confidence: 0, needsReview: true }
  }

  const { ширина, высота } = await measure(file)

  return {
    источник: 'фото',
    название: '',
    категория: mapping.top,
    подкатегория: mapping.sub,
    needsReview: mapping.needsReview,
    бренд: '',
    цвета: [],
    состав: [],
    фото: file,
    ширина,
    высота,
    mime: file.type || 'image/jpeg',
  }
}
