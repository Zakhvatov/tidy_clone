/**
 * Загрузка данных товара Wildberries по `nmId`.
 *
 * Всё лежит на статике `basket-{NN}.wbbasket.ru` с CORS `*`:
 *   vol  = nmId / 100000
 *   part = nmId / 1000
 *   base = https://basket-{NN}.wbbasket.ru/vol{vol}/part{part}/{nmId}
 *   base/info/ru/card.json, base/info/sellers.json
 * Номер лоадера подбирается по диапазону `vol`; если расчётный не ответил —
 * перебираем соседние (не больше 4 попыток). Сети и React здесь нет, только
 * `fetch` (внедряемый, чтобы тесты шли на моках).
 */

import { ОшибкаЗагрузкиКарточки } from './errors'
import type { WbCard } from './types'

/** Общий таймаут загрузки карточки, ~10 с (AbortSignal). */
const CARD_TIMEOUT_MS = 10_000

/** Сколько лоадеров максимум пробуем, включая расчётный. */
const MAX_BASKET_ATTEMPTS = 4

/** Диапазон `vol`, который обслуживает один лоадер `basket-{NN}`. */
export interface BasketRange {
  basket: number
  from: number
  to: number
}

/**
 * Таблица диапазонов `vol → basket-{NN}`.
 *
 * Источник — общеизвестная раскладка лоадеров WB; для нас подтверждены вживую
 * `vol=160 → basket-02` и `vol=140 → basket-01` (см. `docs/evidence/T4-T6.md`).
 * Если реальный лоадер окажется соседним, его найдёт перебор в `loadWbCard`.
 */
export const BASKET_RANGES: readonly BasketRange[] = [
  { basket: 1, from: 0, to: 143 },
  { basket: 2, from: 144, to: 287 },
  { basket: 3, from: 288, to: 431 },
  { basket: 4, from: 432, to: 719 },
  { basket: 5, from: 720, to: 1007 },
  { basket: 6, from: 1008, to: 1061 },
  { basket: 7, from: 1062, to: 1115 },
  { basket: 8, from: 1116, to: 1169 },
  { basket: 9, from: 1170, to: 1313 },
  { basket: 10, from: 1314, to: 1601 },
  { basket: 11, from: 1602, to: 1655 },
  { basket: 12, from: 1656, to: 1919 },
  { basket: 13, from: 1920, to: 2045 },
  { basket: 14, from: 2046, to: 2189 },
  { basket: 15, from: 2190, to: 2405 },
  { basket: 16, from: 2406, to: 2621 },
  { basket: 17, from: 2622, to: 2837 },
  { basket: 18, from: 2838, to: 3053 },
  { basket: 19, from: 3054, to: 3269 },
  { basket: 20, from: 3270, to: 3485 },
  { basket: 21, from: 3486, to: 3701 },
  { basket: 22, from: 3702, to: 3917 },
  { basket: 23, from: 3918, to: 4133 },
  { basket: 24, from: 4134, to: 4349 },
  { basket: 25, from: 4350, to: 4565 },
]

const LAST_RANGE = BASKET_RANGES[BASKET_RANGES.length - 1]
const LAST_RANGE_WIDTH = LAST_RANGE.to - LAST_RANGE.from + 1

/** Расчётный лоадер для `vol`. За пределами таблицы — продолжаем её шаг. */
export function basketForVol(vol: number): number {
  for (const range of BASKET_RANGES) {
    if (vol >= range.from && vol <= range.to) return range.basket
  }
  return LAST_RANGE.basket + Math.ceil((vol - LAST_RANGE.to) / LAST_RANGE_WIDTH)
}

function volOf(nmId: number): number {
  return Math.floor(nmId / 100000)
}

function partOf(nmId: number): number {
  return Math.floor(nmId / 1000)
}

/**
 * Кандидаты-лоадеры для `nmId`: расчётный по диапазону, затем соседние.
 * Не больше {@link MAX_BASKET_ATTEMPTS} уникальных номеров, без нулевых/отрицательных.
 */
export function basketCandidates(nmId: number): number[] {
  const predicted = basketForVol(volOf(nmId))
  const ordered = [predicted, predicted - 1, predicted + 1, predicted + 2]
  const unique: number[] = []
  for (const basket of ordered) {
    if (basket >= 1 && !unique.includes(basket)) unique.push(basket)
    if (unique.length >= MAX_BASKET_ATTEMPTS) break
  }
  return unique
}

/**
 * Строит базовый URL товара. По умолчанию берётся расчётный лоадер, но
 * `loadWbCard` передаёт конкретный кандидат явно.
 */
export function buildCardUrl(nmId: number, basketNumber: number = basketCandidates(nmId)[0]): string {
  const nn = String(basketNumber).padStart(2, '0')
  return `https://basket-${nn}.wbbasket.ru/vol${volOf(nmId)}/part${partOf(nmId)}/${nmId}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Извлекает состав из опций «Состав …», иначе из блока `compositions`. */
function extractComposition(card: Record<string, unknown>): string[] {
  const fromOptions = asArray(card.options)
    .map(asRecord)
    .filter((option): option is Record<string, unknown> => option !== null)
    .filter((option) => (asString(option.name) ?? '').toLowerCase().includes('состав'))
    .map((option) => asString(option.value))
    .filter((value): value is string => value !== undefined)

  if (fromOptions.length > 0) return fromOptions

  return asArray(card.compositions)
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => asString(entry.name))
    .filter((value): value is string => value !== undefined)
}

/** Собирает `WbCard` из сырых JSON, не падая на отсутствующих полях. */
function buildWbCard(
  nmId: number,
  base: string,
  cardRaw: unknown,
  sellerRaw: unknown,
): WbCard {
  const card = asRecord(cardRaw) ?? {}
  const media = asRecord(card.media) ?? {}
  const selling = asRecord(card.selling) ?? {}
  const seller = asRecord(sellerRaw) ?? {}

  const photoCount = Math.max(0, Math.floor(asNumber(media.photo_count) ?? 0))
  const photoUrls = Array.from(
    { length: photoCount },
    (_, index) => `${base}/images/big/${index + 1}.webp`,
  )

  const colorsRaw = asString(card.nm_colors_names)
  const colors = colorsRaw
    ? colorsRaw.split(',').map((color) => color.trim()).filter(Boolean)
    : []

  return {
    nmId: asNumber(card.nm_id) ?? nmId,
    name: asString(card.imt_name),
    subjectName: asString(card.subj_name),
    rootSubjectName: asString(card.subj_root_name),
    brand: asString(selling.brand_name),
    colors,
    composition: extractComposition(card),
    contents: asString(card.contents),
    photoCount,
    photoUrls,
    sellerName: asString(seller.supplierName),
    trademark: asString(seller.trademark),
  }
}

/**
 * Итог одного запроса JSON.
 *
 * `missing` — лоадер ответил 404: этого товара на нём нет, перебор продолжается.
 * `network` — fetch бросил, истёк таймаут или лоадер ответил 5xx/иным не-404
 * статусом: это сбой связи, а не «товар не найден», и перебор надо прервать.
 */
type JsonFetch =
  | { kind: 'ok'; data: unknown }
  | { kind: 'missing' }
  | { kind: 'network'; cause: unknown }

/** Загружает JSON, различая «нет на этом лоадере» (404) и сетевой сбой. */
async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<JsonFetch> {
  try {
    const response = await fetchImpl(url, { signal })
    if (response.status === 404) return { kind: 'missing' }
    if (!response.ok) {
      return { kind: 'network', cause: new Error(`Wildberries ответил кодом ${response.status}`) }
    }
    return { kind: 'ok', data: await response.json() }
  } catch (cause) {
    return { kind: 'network', cause }
  }
}

/** Понятная ошибка связи: таймаут называем таймаутом, остальное — сетью. */
function networkError(timedOut: boolean, cause: unknown): ОшибкаЗагрузкиКарточки {
  return new ОшибкаЗагрузкиКарточки(
    timedOut
      ? 'Wildberries не ответил вовремя, попробуйте ещё раз'
      : 'Не удалось связаться с Wildberries. Проверьте соединение и попробуйте снова',
    { code: 'network', cause },
  )
}

/**
 * Загружает карточку товара Wildberries.
 *
 * @throws {ОшибкаЗагрузкиКарточки} если ни один лоадер не отдал данные или
 *   истёк таймаут (~10 с).
 */
export async function loadWbCard(nmId: number, fetchImpl: typeof fetch = fetch): Promise<WbCard> {
  if (!Number.isSafeInteger(nmId) || nmId <= 0) {
    throw new ОшибкаЗагрузкиКарточки('Некорректный номер товара Wildberries')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CARD_TIMEOUT_MS)

  try {
    for (const basket of basketCandidates(nmId)) {
      const base = buildCardUrl(nmId, basket)
      const cardRaw = await fetchJson(`${base}/info/ru/card.json`, fetchImpl, controller.signal)
      // Сетевой сбой не маскируем под «нет товара»: прекращаем перебор и
      // сообщаем о соединении. Дальше искать по соседним лоадерам бессмысленно.
      if (cardRaw.kind === 'network') {
        throw networkError(controller.signal.aborted, cardRaw.cause)
      }
      // 404 — товара нет именно на этом лоадере, пробуем следующий.
      if (cardRaw.kind === 'missing') continue

      // sellers.json необязателен: карточка уже найдена, и его сбой не должен
      // отменять загрузку — просто остаёмся без данных продавца.
      const sellerRaw = await fetchJson(`${base}/info/sellers.json`, fetchImpl, controller.signal)
      return buildWbCard(nmId, base, cardRaw.data, sellerRaw.kind === 'ok' ? sellerRaw.data : undefined)
    }

    if (controller.signal.aborted) {
      throw networkError(true, undefined)
    }
    throw new ОшибкаЗагрузкиКарточки('Товар не найден на складах Wildberries', { code: 'not_found' })
  } finally {
    clearTimeout(timer)
  }
}
