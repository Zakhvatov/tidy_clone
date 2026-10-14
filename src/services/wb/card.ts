/**
 * Загрузка данных товара Wildberries по `nmId`.
 *
 * Всё лежит на статике `basket-{NN}.wbbasket.ru` с CORS `*`:
 *   vol  = nmId / 100000
 *   part = nmId / 1000
 *   base = https://basket-{NN}.wbbasket.ru/vol{vol}/part{part}/{nmId}
 *   base/info/ru/card.json, base/info/sellers.json
 * Номер лоадера подбирается честным перебором: сначала расчётный по таблице
 * (быстрый путь) и его соседи, затем — ограниченный параллельный перебор
 * остальных существующих лоадеров `01..MAX_BASKET`. Таблица диапазонов
 * ненадёжна для больших `vol` (рост числа лоадеров не линеен), поэтому
 * полагаться на неё как на истину нельзя. Найденный лоадер запоминается для
 * `vol` в `basket-cache`, чтобы повторные товары открывались одним запросом.
 * Сети и React здесь нет, только `fetch` (внедряемый, чтобы тесты шли на моках).
 */

import { readCachedBasket, writeCachedBasket } from './basket-cache'
import { ОшибкаЗагрузкиКарточки } from './errors'
import type { WbCard } from './types'

/** Общий таймаут загрузки карточки, ~10 с (AbortSignal). */
const CARD_TIMEOUT_MS = 10_000

/**
 * Таймаут одного запроса JSON, ~3 с. Нужен, чтобы один подвисший хост не съел
 * общий бюджет: тогда перебор перейдёт к следующему лоадеру, а не встанет.
 */
const REQUEST_TIMEOUT_MS = 3_000

/** Сколько лоадеров максимум пробуем последовательно на быстром пути. */
const MAX_BASKET_ATTEMPTS = 4

/** Сколько запросов к лоадерам идёт одновременно на этапе полного перебора. */
const SWEEP_CONCURRENCY = 6

/**
 * Максимальный существующий лоадер. `basket-66` и выше не резолвятся вообще
 * (NXDOMAIN), поэтому предлагать их нельзя: DNS-провал выдавался за сетевую
 * ошибку и прерывал перебор.
 */
export const MAX_BASKET = 65

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

/** Приводит произвольное число к существующему лоадеру `1..MAX_BASKET`. */
function clampBasket(value: number): number {
  if (!Number.isFinite(value)) return LAST_RANGE.basket
  return Math.min(MAX_BASKET, Math.max(1, Math.trunc(value)))
}

/**
 * Расчётный лоадер для `vol`. За пределами таблицы продолжаем её шаг, но
 * результат всё равно ограничен `MAX_BASKET`: несуществующие хосты (66+)
 * предлагать нельзя, а для больших `vol` экстраполяция всё равно ненадёжна —
 * её подстрахует полный перебор в `loadWbCard`.
 */
export function basketForVol(vol: number): number {
  for (const range of BASKET_RANGES) {
    if (vol >= range.from && vol <= range.to) return range.basket
  }
  return clampBasket(
    LAST_RANGE.basket + Math.ceil((vol - LAST_RANGE.to) / LAST_RANGE_WIDTH),
  )
}

function volOf(nmId: number): number {
  return Math.floor(nmId / 100000)
}

function partOf(nmId: number): number {
  return Math.floor(nmId / 1000)
}

/**
 * Быстрый путь: расчётный лоадер и ближние соседи. Не больше
 * {@link MAX_BASKET_ATTEMPTS} уникальных номеров, все в `1..MAX_BASKET`.
 */
export function basketCandidates(nmId: number): number[] {
  const predicted = basketForVol(volOf(nmId))
  const ordered = [predicted, predicted - 1, predicted + 1, predicted + 2]
  const unique: number[] = []
  for (const basket of ordered) {
    if (basket >= 1 && basket <= MAX_BASKET && !unique.includes(basket)) unique.push(basket)
    if (unique.length >= MAX_BASKET_ATTEMPTS) break
  }
  return unique
}

/**
 * Полный перебор: все существующие лоадеры `1..MAX_BASKET`, которых нет в
 * `exclude`, в порядке возрастания расстояния от `pivot`. Так вероятные
 * «соседние склады» проверяются раньше, но ни один существующий не пропущен.
 */
export function remainingBaskets(exclude: readonly number[], pivot: number): number[] {
  const excluded = new Set(exclude)
  const result: number[] = []
  for (let distance = 0; distance <= MAX_BASKET; distance++) {
    const row = distance === 0 ? [pivot] : [pivot - distance, pivot + distance]
    for (const basket of row) {
      if (basket >= 1 && basket <= MAX_BASKET && !excluded.has(basket)) {
        excluded.add(basket)
        result.push(basket)
      }
    }
  }
  return result
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
 * `missing` — лоадер ответил 404 или хост не существует (DNS): этого товара на
 * нём нет, перебор продолжается.
 * `network` — fetch бросил не-DNS ошибкой, истёк таймаут или лоадер ответил
 * 5xx/иным не-404 статусом. Это сбой связи, но не приговор: перебор
 * продолжается, и лишь если ни один лоадер не ответил, пользователь получает
 * сообщение про соединение.
 */
type JsonFetch =
  | { kind: 'ok'; data: unknown }
  | { kind: 'missing' }
  | { kind: 'network'; cause: unknown }

/** Коды, которыми `fetch` сообщает, что хост не резолвится (его нет). */
const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ERR_NAME_NOT_RESOLVED'])

/**
 * Хост не существует (NXDOMAIN) — это «этого лоадера нет», а не сбой сети.
 * Смотрим и `code`, и текст: браузер и Node (undici) сообщают по-разному.
 */
function isDnsFailure(cause: unknown): boolean {
  let current: unknown = cause
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth++) {
    if (typeof current !== 'object') break
    const node = current as { code?: unknown; message?: unknown; cause?: unknown }
    if (typeof node.code === 'string' && DNS_ERROR_CODES.has(node.code)) return true
    if (typeof node.message === 'string' && /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(node.message)) {
      return true
    }
    current = node.cause
  }
  return false
}

/**
 * Загружает JSON с отдельным коротким таймаутом, различая «нет на этом
 * лоадере» (404 или несуществующий хост) и сетевой сбой. Общий `deadline`
 * отменяет запрос вместе со всей загрузкой.
 */
async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  deadline: AbortSignal,
  timeoutMs: number,
): Promise<JsonFetch> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  deadline.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (response.status === 404) return { kind: 'missing' }
    if (!response.ok) {
      return { kind: 'network', cause: new Error(`Wildberries ответил кодом ${response.status}`) }
    }
    return { kind: 'ok', data: await response.json() }
  } catch (cause) {
    if (isDnsFailure(cause)) return { kind: 'missing' }
    return { kind: 'network', cause }
  } finally {
    clearTimeout(timer)
    deadline.removeEventListener('abort', abort)
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
 * Параллельный перебор лоадеров: не больше `concurrency` запросов
 * одновременно, остановка на первом `ok`. При находке отменяет хвост, чтобы
 * не ждать подвисшие запросы.
 */
async function sweepBaskets(
  baskets: readonly number[],
  attempt: (basket: number) => Promise<WbCard | undefined>,
  controller: AbortController,
): Promise<{ basket: number; card: WbCard } | undefined> {
  let next = 0
  let hit: { basket: number; card: WbCard } | undefined
  const worker = async (): Promise<void> => {
    while (hit === undefined && !controller.signal.aborted && next < baskets.length) {
      const basket = baskets[next++]
      const card = await attempt(basket)
      if (card !== undefined && hit === undefined) {
        hit = { basket, card }
        controller.abort()
      }
    }
  }
  const workerCount = Math.min(SWEEP_CONCURRENCY, baskets.length)
  const workers: Promise<void>[] = []
  for (let i = 0; i < workerCount; i++) workers.push(worker())
  await Promise.all(workers)
  return hit
}

/**
 * Загружает карточку товара Wildberries.
 *
 * Сначала быстрый путь (кэш → расчётный лоадер → соседи), затем полный перебор
 * существующих лоадеров `01..MAX_BASKET`. Ошибка `network` только тогда, когда
 * реально ни один лоадер не ответил; 404 на всех — `not_found`.
 *
 * @throws {ОшибкаЗагрузкиКарточки} если ни один лоадер не отдал данные или
 *   истёк общий таймаут (~10 с).
 */
export async function loadWbCard(nmId: number, fetchImpl: typeof fetch = fetch): Promise<WbCard> {
  if (!Number.isSafeInteger(nmId) || nmId <= 0) {
    throw new ОшибкаЗагрузкиКарточки('Некорректный номер товара Wildberries')
  }

  const vol = volOf(nmId)
  const predicted = basketForVol(vol)

  // Порядок кандидатов: найденный ранее лоадер (кэш) → расчётный → соседи.
  const priority: number[] = []
  const cached = readCachedBasket(vol)
  if (cached !== undefined && cached >= 1 && cached <= MAX_BASKET) priority.push(cached)
  for (const basket of basketCandidates(nmId)) {
    if (!priority.includes(basket)) priority.push(basket)
  }
  const rest = remainingBaskets(priority, predicted)

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, CARD_TIMEOUT_MS)

  // Ответил ли хоть один лоадер по существу (200 или 404). Если нет — это сеть.
  let sawAnswer = false
  let firstNetworkCause: unknown

  const attempt = async (basket: number): Promise<WbCard | undefined> => {
    const base = buildCardUrl(nmId, basket)
    const cardRaw = await fetchJson(
      `${base}/info/ru/card.json`,
      fetchImpl,
      controller.signal,
      REQUEST_TIMEOUT_MS,
    )
    if (cardRaw.kind === 'network') {
      firstNetworkCause ??= cardRaw.cause
      return undefined
    }
    sawAnswer = true
    if (cardRaw.kind === 'missing') return undefined

    // sellers.json необязателен: карточка уже найдена, и его сбой не должен
    // отменять загрузку — просто остаёмся без данных продавца.
    const sellerRaw = await fetchJson(
      `${base}/info/sellers.json`,
      fetchImpl,
      controller.signal,
      REQUEST_TIMEOUT_MS,
    )
    return buildWbCard(nmId, base, cardRaw.data, sellerRaw.kind === 'ok' ? sellerRaw.data : undefined)
  }

  try {
    for (const basket of priority) {
      if (controller.signal.aborted) break
      const card = await attempt(basket)
      if (card !== undefined) {
        writeCachedBasket(vol, basket)
        return card
      }
    }

    const found = await sweepBaskets(rest, attempt, controller)
    if (found !== undefined) {
      writeCachedBasket(vol, found.basket)
      return found.card
    }
  } finally {
    clearTimeout(timer)
  }

  // Если хоть один лоадер ответил по существу (200/404), это не «сеть»: товара
  // на складах WB нет. Сеть — только когда ни один не ответил вообще.
  if (sawAnswer) {
    throw new ОшибкаЗагрузкиКарточки('Товар не найден на складах Wildberries', { code: 'not_found' })
  }
  throw networkError(timedOut, firstNetworkCause)
}
