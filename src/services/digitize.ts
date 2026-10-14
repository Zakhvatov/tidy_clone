/**
 * Оцифровка вещи (T10): генерация AI-версии и точный вырез пакшота.
 *
 * Оцифровка запускается **только явным действием** (раздел «Решения» тикета,
 * ADR-0002): кнопка «Сделать AI-версию» в карточке вещи и массовое «Оцифровать
 * всё, где нет пакшота» на экране гардероба. Фоновой генерации без нажатия нет.
 *
 * Два способа из ADR-0002:
 * - **пакшот** → точный вырез `cutoutBlob` (роль `вырез`), бесплатно и без искажений;
 * - **всё прочее** → генеративная перерисовка через воркер (роль `ai`).
 *
 * Инвариант: **Оригинал не трогается никогда** — он только читается. Производные
 * изображения добавляются через `storage/images` (`add`), поэтому повторная
 * оцифровка не перезаписывает уже сохранённое, а проверка наличия роли делает
 * повторный запуск идемпотентным.
 *
 * Сеть и canvas внедряются через {@link DigitizeDeps}: тесты не ходят в воркер
 * и не требуют canvas, а очередь (T12) подставляет туда свой `AbortSignal`.
 */

import type { ImageRole, Изображение, Вещь } from '../domain/types'
// Промпт строится доменным модулем T11: шаблоны по категориям и перевод
// атрибутов живут там, а не в сервисе — у промпта один источник истины.
import { buildGenerationPrompt } from '../domain/prompt-templates'
import { generateImage } from './tidy-api'
import { cutoutBlob, type CutoutBlobResult } from './cutout'
import { analyzeImage, type PackshotAnalysis } from './wb/packshot'
import { measureImage } from './import-item'
import { loadWardrobe } from './wardrobe'
import * as images from '../storage/images'
import * as items from '../storage/items'

/** Размер кадра AI-версии: воркер отдаёт JPEG 1024×1024. */
export const AI_FRAME_SIZE = 1024

/** Роль, которую создаёт каждый способ оцифровки. */
export type СпособОцифровки = Extract<ImageRole, 'ai' | 'вырез'>

/** Зависимости оцифровки: в приложении — реальные, в тестах — подставные. */
export interface DigitizeDeps {
  /** Генерация AI-версии. По умолчанию — `POST /generate` в воркер. */
  generate?: (вещь: Вещь, оригинал: Blob, prompt: string, signal?: AbortSignal) => Promise<Blob>
  /** Точный вырез пакшота. По умолчанию — `cutoutBlob` (canvas). */
  cutout?: (blob: Blob) => Promise<CutoutBlobResult>
  /**
   * Проверка «пакшот ли Оригинал». По умолчанию — `analyzeImage` (canvas).
   * Второй параметр — сама вещь: тестам и будущим эвристикам нужен контекст
   * вещи, а не только пиксели.
   */
  analyze?: (blob: Blob, вещь: Вещь) => Promise<PackshotAnalysis>
  /** Размеры производного изображения. По умолчанию — `measureImage`. */
  measure?: (blob: Blob) => Promise<{ ширина: number; высота: number }>
  /** Текущее время, ISO-8601. Инжектируется для детерминированных тестов. */
  now?: () => string
  /** Генератор id. Инжектируется для детерминированных тестов. */
  id?: () => string
  /** Отмена (кнопка «Остановить», уход с экрана). */
  signal?: AbortSignal
  /**
   * Принудительная перегенерация AI-версии (кнопка «Перегенерировать»).
   * При `true` уже существующая AI-версия заменяется новой; Оригинал при этом
   * не трогается. По умолчанию `false` — повторный вызов идемпотентен, а
   * массовая оцифровка (очередь, `digitizeMissing`) ничего не перегенерирует.
   */
  force?: boolean
}

/** Причина, по которой вещь не удалось оцифровать. */
export type DigitizeErrorCode = 'not_found' | 'no_original' | 'cutout_failed'

/** Понятная ошибка оцифровки: UI показывает `message`, очередь смотрит на `code`. */
export class ОшибкаОцифровки extends Error {
  readonly code: DigitizeErrorCode

  constructor(code: DigitizeErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ОшибкаОцифровки'
    this.code = code
  }
}

/** Итог оцифровки одной вещи. `status: 'уже есть'` — идемпотентный повтор. */
export interface DigitizeOutcome {
  itemId: string
  way: СпособОцифровки
  status: 'создано' | 'уже есть'
  image: Изображение
}

// ---------------------------------------------------------------------------
// Служебное
// ---------------------------------------------------------------------------

function newId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function nowOf(deps: DigitizeDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))()
}

function idOf(deps: DigitizeDeps): string {
  return (deps.id ?? newId)()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Вещь вместе с её изображениями; `оригинал` уже найден и обязателен. */
interface LoadedItem {
  вещь: Вещь
  изображения: Изображение[]
  оригинал: Изображение
}

/**
 * Читает вещь и её изображения. Отсутствие вещи или Оригинала — понятная
 * ошибка: оцифровывать нечего, и это не должно выглядеть как сбой сети.
 */
async function loadItem(itemId: string): Promise<LoadedItem> {
  const вещь = await items.get(itemId)
  if (вещь === undefined) {
    throw new ОшибкаОцифровки('not_found', 'Вещь не найдена')
  }
  const изображения = await images.listByItem(itemId)
  const оригинал = изображения.find((изображение) => изображение.роль === 'оригинал')
  if (оригинал === undefined) {
    throw new ОшибкаОцифровки('no_original', 'У вещи нет Оригинала — оцифровать её нельзя')
  }
  return { вещь, изображения, оригинал }
}

/**
 * Сохраняет производное изображение и дописывает его id в вещь.
 *
 * Если передан `заменяемыйId`, старый производный id убирается из вещи и само
 * изображение удаляется из хранилища: это режим перегенерации. Оригинал не
 * затрагивается ни при каком раскладе — он остаётся той же записью.
 */
async function saveDerived(
  вещь: Вещь,
  роль: СпособОцифровки,
  blob: Blob,
  deps: DigitizeDeps,
  заменяемыйId?: string,
): Promise<Изображение> {
  const measure = deps.measure ?? measureImage
  const { ширина, высота } = await measure(blob)
  const изображение: Изображение = {
    id: idOf(deps),
    idВещи: вещь.id,
    роль,
    blob,
    ширина,
    высота,
    mime: blob.type || (роль === 'вырез' ? 'image/png' : 'image/jpeg'),
    датаСоздания: nowOf(deps),
  }
  if (роль === 'ai') {
    await images.addAiVersion(изображение)
  } else {
    await images.addCutout(изображение)
  }
  // `idИзображений` — часть домена; держим её в актуальном виде. Оригинал при
  // этом не меняется: список лишь дополняется новым производным id (а при
  // перегенерации — теряет старый id AI-версии).
  const idИзображений = вещь.idИзображений.filter((id) => id !== заменяемыйId)
  await items.update(вещь.id, { idИзображений: [...idИзображений, изображение.id] })
  if (заменяемыйId !== undefined) {
    // Новое изображение уже сохранено и записано в вещь: если удаление старого
    // сорвётся, пользователь всё равно увидит свежую AI-версию, а в хранилище
    // останется лишь осиротевшая старая запись.
    await images.removeNonOriginal(заменяемыйId)
  }
  return изображение
}

/** Находит производное изображение нужной роли, если оно уже есть. */
function findRole(изображения: readonly Изображение[], роль: ImageRole): Изображение | undefined {
  return изображения.find((изображение) => изображение.роль === роль)
}

// ---------------------------------------------------------------------------
// Оцифровка одной вещи
// ---------------------------------------------------------------------------

/**
 * Явное действие «Сделать AI-версию»: строит промпт, зовёт `/generate` и
 * сохраняет результат с ролью `ai`. Оригинал только читается.
 *
 * Идемпотентность: если AI-версия уже есть и `force` не задан, новая не
 * создаётся — возвращается существующая с `status: 'уже есть'`. При
 * `force: true` (кнопка «Перегенерировать») старая AI-версия удаляется, а её
 * место занимает свежая; Оригинал не меняется.
 */
export async function digitizeItem(
  itemId: string,
  deps: DigitizeDeps = {},
): Promise<DigitizeOutcome> {
  const { вещь, изображения, оригинал } = await loadItem(itemId)
  const существующая = findRole(изображения, 'ai')
  if (существующая !== undefined && deps.force !== true) {
    return { itemId, way: 'ai', status: 'уже есть', image: существующая }
  }

  const prompt = buildGenerationPrompt(вещь)
  const generate = deps.generate
  const blob =
    generate === undefined
      ? await generateImage(prompt, {
          width: AI_FRAME_SIZE,
          height: AI_FRAME_SIZE,
          signal: deps.signal,
        })
      : await generate(вещь, оригинал.blob, prompt, deps.signal)

  const image = await saveDerived(вещь, 'ai', blob, deps, существующая?.id)
  return { itemId, way: 'ai', status: 'создано', image }
}

/**
 * Оцифровка пакшота: точный вырез через `cutoutBlob`, роль `вырез`, без
 * обращения к генерации. Если вырез «подозрительный» (вещь светлая, фон не
 * распознан) — понятная ошибка, а не сохранение невырезанного PNG под видом выреза.
 */
export async function digitizePackshot(
  itemId: string,
  deps: DigitizeDeps = {},
): Promise<DigitizeOutcome> {
  const { вещь, изображения, оригинал } = await loadItem(itemId)
  const существующий = findRole(изображения, 'вырез')
  if (существующий !== undefined) {
    return { itemId, way: 'вырез', status: 'уже есть', image: существующий }
  }

  const cutout = deps.cutout ?? cutoutBlob
  const result = await cutout(оригинал.blob)
  if (result.suspicious) {
    throw new ОшибкаОцифровки(
      'cutout_failed',
      'Точный вырез не удался: фон не распознан или вещь слишком светлая',
    )
  }

  const image = await saveDerived(вещь, 'вырез', result.blob, deps)
  return { itemId, way: 'вырез', status: 'создано', image }
}

/**
 * Автоматический выбор способа: пакшот → вырез, всё прочее → генерация
 * (правило T10/T12). Если вырез пакшота оказался подозрительным, честно
 * откатываемся на генерацию — вещь важнее сэкономленного запроса.
 */
export async function digitizeAuto(
  itemId: string,
  deps: DigitizeDeps = {},
): Promise<DigitizeOutcome> {
  const { вещь, изображения, оригинал } = await loadItem(itemId)

  const вырез = findRole(изображения, 'вырез')
  if (вырез !== undefined) {
    return { itemId, way: 'вырез', status: 'уже есть', image: вырез }
  }
  const ai = findRole(изображения, 'ai')
  if (ai !== undefined) {
    return { itemId, way: 'ai', status: 'уже есть', image: ai }
  }

  const analyze = deps.analyze ?? analyzeImage
  const analysis = await analyze(оригинал.blob, вещь)
  if (analysis.isPackshot) {
    try {
      return await digitizePackshot(itemId, deps)
    } catch (error) {
      if (error instanceof ОшибкаОцифровки && error.code === 'cutout_failed') {
        return await digitizeItem(itemId, deps)
      }
      throw error
    }
  }
  return await digitizeItem(itemId, deps)
}

// ---------------------------------------------------------------------------
// Массовая оцифровка
// ---------------------------------------------------------------------------

/** Вещь, которой нужна оцифровка: у неё нет ни выреза, ни AI-версии. */
export interface ПлановаяВещь {
  id: string
  название: string
}

/**
 * Список вещей для массовой оцифровки: без `вырез` и без `ai`. Вещь с вырезом
 * уже пригодна для коллажа, а с AI-версией — уже оцифрована; повторять нечего.
 */
export async function itemsNeedingDigitization(): Promise<ПлановаяВещь[]> {
  const entries = await loadWardrobe()
  return entries
    .filter(
      ({ изображения }) =>
        findRole(изображения, 'вырез') === undefined && findRole(изображения, 'ai') === undefined,
    )
    .map(({ вещь }) => ({ id: вещь.id, название: вещь.название.trim() || 'Без названия' }))
}

/** Итог по одной вещи в массовом прогоне: успех или понятная ошибка. */
export interface MassDigitizeOutcome {
  itemId: string
  outcome?: DigitizeOutcome
  error?: string
}

/**
 * Массовое действие «Оцифровать всё, где нет пакшота»: последовательный проход
 * по вещам без выреза и без AI-версии. Сбой одной вещи не прерывает остальные —
 * ошибка собирается в результат, а не бросается наружу.
 *
 * Это stateless-примитив: без ретраев, прогресса и персистентности. Массовая
 * кнопка в UI использует очередь T12 (`digitize-queue.ts`), которая делает то же
 * самое, но переживает закрытие приложения. Обе опираются на {@link digitizeAuto}.
 */
export async function digitizeMissing(deps: DigitizeDeps = {}): Promise<MassDigitizeOutcome[]> {
  const план = await itemsNeedingDigitization()
  const результаты: MassDigitizeOutcome[] = []
  for (const { id } of план) {
    if (deps.signal?.aborted) break
    try {
      результаты.push({ itemId: id, outcome: await digitizeAuto(id, deps) })
    } catch (error) {
      результаты.push({ itemId: id, error: messageOf(error) })
    }
  }
  return результаты
}
