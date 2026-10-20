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
 * С D13 перерисовка — image-to-image: Оригинал (сжатый) уходит референсом в
 * `/generate` вместе с redraw-промптом, поэтому AI-версия повторяет дизайн,
 * цвет и принты Оригинала, а не среднестатистическую вещь категории.
 *
 * С ADR-0006 генерация асинхронная: `digitizeItem` ставит задачу
 * (`src/services/generation.ts` — `Idempotency-Key`, `taskId` в IndexedDB,
 * опрос каждые ~3 с, сеанс 5 минут) и только потом сохраняет картинку. Пока
 * задача живёт, её видно и правится с экрана статуса; закрытие вкладки её не
 * теряет — см. «Забрать готовое» в очереди.
 *
 * Инвариант «Оригинал не трогается» действует до успешной генерации: он только
 * читается. После успеха загруженный снимок-сырьё удаляется — сознательное
 * исключение ADR-0006 §4 (только для `источник: 'фото'`; маркетплейсовые
 * Оригиналы остаются). Производные изображения добавляются через
 * `storage/images` (`add`), поэтому повторная оцифровка не перезаписывает уже
 * сохранённое, а проверка наличия роли делает повторный запуск идемпотентным.
 *
 * Сеть и canvas внедряются через {@link DigitizeDeps}: тесты не ходят в воркер
 * и не требуют canvas, а очередь (T12) подставляет туда свой `AbortSignal`.
 */

import type { ImageRole, Изображение, Вещь } from '../domain/types'
// Промпт строится доменным модулем T11: шаблоны по категориям и перевод
// атрибутов живут там, а не в сервисе — у промпта один источник истины.
// С D13 оцифровка шлёт redraw-промпт: модель получает Оригинал референсом.
import { buildRedrawPrompt } from '../domain/prompt-templates'
import { MAX_GENERATE_INPUT_BYTES } from './tidy-api'
import { runGeneration } from './generation'
import { canvasResize, MAX_IMAGE_SIDE } from './classify-photo'
import { cutoutBlob, type CutoutBlobResult } from './cutout'
import { analyzeImage, type PackshotAnalysis } from './wb/packshot'
import { measureImage } from './import-item'
import { loadWardrobe } from './wardrobe'
import * as images from '../storage/images'
import * as items from '../storage/items'
import { removeJob } from '../storage/jobs'
import type { ЗадачаГенерации } from '../storage/jobs'

/** Размер кадра AI-версии: воркер отдаёт JPEG 1024×1024. */
export const AI_FRAME_SIZE = 1024

/** Роль, которую создаёт каждый способ оцифровки. */
export type СпособОцифровки = Extract<ImageRole, 'ai' | 'вырез'>

/** Зависимости оцифровки: в приложении — реальные, в тестах — подставные. */
export interface DigitizeDeps {
  /**
   * Генерация AI-версии. По умолчанию — асинхронный прогон через воркер
   * (ADR-0006: `POST /generate` → опрос → скачивание). Подставной вариант
   * получает референс вместо Оригинала: сырьевой снимок мог быть уже удалён.
   */
  generate?: (вещь: Вещь, reference: Blob, prompt: string, signal?: AbortSignal) => Promise<Blob>
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
  /**
   * Slug модели генерации из каталога (`GET /models`). Не задан — воркер
   * использует модель по умолчанию из своего конфига.
   */
  model?: string
  /** Отмена (кнопка «Остановить», уход с экрана). */
  signal?: AbortSignal
  /**
   * Принудительная перегенерация AI-версии (кнопка «Перегенерировать»).
   * При `true` уже существующая AI-версия заменяется новой; Оригинал при этом
   * не трогается. По умолчанию `false` — повторный вызов идемпотентен, а
   * массовая оцифровка (очередь, `digitizeMissing`) ничего не перегенерирует.
   */
  force?: boolean
  /**
   * Каждое изменение задачи генерации (ADR-0006) — для экрана статуса:
   * создаётся → ждёт → просрочена/не удалось. Сюда же приходит `taskId`
   * сразу после `202`.
   */
  onJobChange?: (job: ЗадачаГенерации) => void
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

/**
 * Референс для перерисовки: Оригинал, ужатый до лимита воркера (D13).
 * Большие фото с телефона (3–30 МБ) сжимаются тем же способом, что и для
 * распознавания — до 2000 px по длинной стороне, JPEG.
 *
 * Неизвестный размер (старые webview, тестовые клоны хранилища) не считается
 * превышением: генерация сама проверит и ответит `image_too_large`, а мы не
 * отнимаем сжатие у сред, где его нет.
 */
async function referenceForGeneration(blob: Blob): Promise<Blob> {
  if (!(blob.size > MAX_GENERATE_INPUT_BYTES)) return blob
  return await canvasResize(blob, MAX_IMAGE_SIDE)
}

/** Вещь вместе с её изображениями. */
interface LoadedItem {
  вещь: Вещь
  изображения: Изображение[]
  /**
   * Оригинал может отсутствовать: после успешной генерации сырьевой снимок
   * удаляется (ADR-0006 §4), а у вещи остаётся AI-версия. Где Оригинал
   * обязателен (вырез, анализ), вызывающий проверяет это сам.
   */
  оригинал?: Изображение
  /** Существующая AI-версия — замена при перегенерации и референс после потери снимка. */
  ai?: Изображение
  /** Существующий точный вырез пакшота. */
  вырез?: Изображение
}

/**
 * Читает вещь и её изображения. Отсутствие вещи — понятная ошибка: оцифровывать
 * нечего, и это не должно выглядеть как сбой сети. Отсутствие Оригинала здесь
 * не ошибка — см. {@link LoadedItem}.
 */
async function loadItem(itemId: string): Promise<LoadedItem> {
  const вещь = await items.get(itemId)
  if (вещь === undefined) {
    throw new ОшибкаОцифровки('not_found', 'Вещь не найдена')
  }
  const изображения = await images.listByItem(itemId)
  return {
    вещь,
    изображения,
    оригинал: изображения.find((изображение) => изображение.роль === 'оригинал'),
    ai: изображения.find((изображение) => изображение.роль === 'ai'),
    вырез: изображения.find((изображение) => изображение.роль === 'вырез'),
  }
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
 * Явное действие «Сделать AI-версию»: строит redraw-промпт, ставит асинхронную
 * задачу генерации (ADR-0006) и сохраняет результат с ролью `ai`.
 *
 * Референс image-to-image — Оригинал, а после его удаления (ADR-0006 §4) или
 * у маркетплейсной вещи без снимка — уже существующая AI-версия: каталожный
 * вид с белым фоном годится как референс. Если нечем генерировать вообще —
 * понятная ошибка `no_original`.
 *
 * Идемпотентность: если AI-версия уже есть и `force` не задан, новая не
 * создаётся — возвращается существующая с `status: 'уже есть'`. При
 * `force: true` (кнопка «Перегенерировать») старая AI-версия удаляется, а её
 * место занимает свежая. Задача генерации после сохранения снимается
 * (`storage/jobs`), а при неудаче остаётся — её можно допросить или забрать.
 */
export async function digitizeItem(
  itemId: string,
  deps: DigitizeDeps = {},
): Promise<DigitizeOutcome> {
  const { вещь, ai, оригинал } = await loadItem(itemId)
  if (ai !== undefined && deps.force !== true) {
    return { itemId, way: 'ai', status: 'уже есть', image: ai }
  }

  const референс = оригинал ?? ai
  if (референс === undefined) {
    throw new ОшибкаОцифровки('no_original', 'У вещи нет Оригинала — оцифровать её нельзя')
  }

  const prompt = buildRedrawPrompt(вещь)
  const generate = deps.generate
  let blob: Blob
  if (generate !== undefined) {
    blob = await generate(вещь, референс.blob, prompt, deps.signal)
  } else {
    const run = runGeneration(itemId, {
      prompt,
      width: AI_FRAME_SIZE,
      height: AI_FRAME_SIZE,
      model: deps.model,
      image: await referenceForGeneration(референс.blob),
      force: deps.force,
      signal: deps.signal,
      ...(deps.onJobChange === undefined ? {} : { onJobChange: deps.onJobChange }),
    })
    blob = await run.promise
  }

  return await saveGeneratedResult(itemId, blob, deps)
}

/**
 * Сохраняет готовую картинку генерации: кладёт AI-версию (заменяя старую при
 * перегенерации), удаляет сырьевой снимок по правилу ADR-0006 §4 и снимает
 * задачу генерации из `storage/jobs`.
 *
 * Общая для {@link digitizeItem} и кнопки «Забрать готовое»: обе дороги ведут
 * к одному и тому же сохранению, двойная AI-версия невозможна.
 */
export async function saveGeneratedResult(
  itemId: string,
  blob: Blob,
  deps: DigitizeDeps = {},
): Promise<DigitizeOutcome> {
  const { вещь, ai, оригинал } = await loadItem(itemId)
  if (ai !== undefined && deps.force !== true) {
    await removeJob(itemId)
    return { itemId, way: 'ai', status: 'уже есть', image: ai }
  }

  const image = await saveDerived(вещь, 'ai', blob, deps, ai?.id)
  await removeUploadedSnapshot(вещь, оригинал)
  await removeJob(itemId)
  return { itemId, way: 'ai', status: 'создано', image }
}

/**
 * Удаляет загруженный снимок-сырьё после успешной генерации (ADR-0006 §4) и
 * убирает его id из списка изображений вещи. Снимки с маркетплейса
 * (`источник: 'ссылка'`) не трогаются: для них правило «Оригинал не удаляется»
 * остаётся в силе.
 */
async function removeUploadedSnapshot(вещь: Вещь, оригинал?: Изображение): Promise<void> {
  if (оригинал === undefined || вещь.источник !== 'фото') return
  await images.removeUploadedOriginal(оригинал.id)
  const актуальная = await items.get(вещь.id)
  if (актуальная === undefined) return
  const idИзображений = актуальная.idИзображений.filter((id) => id !== оригинал.id)
  if (idИзображений.length !== актуальная.idИзображений.length) {
    await items.update(вещь.id, { idИзображений })
  }
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
  if (оригинал === undefined) {
    throw new ОшибкаОцифровки('no_original', 'У вещи нет Оригинала — вырезать нечего')
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
  if (оригинал === undefined) {
    // Ни выреза, ни AI-версии, а снимок удалён — генерировать и вырезать нечего.
    throw new ОшибкаОцифровки('no_original', 'У вещи нет Оригинала — оцифровать её нельзя')
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
