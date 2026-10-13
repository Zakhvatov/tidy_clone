/**
 * Точный вырез пакшота (T9): белый-key на пикселях.
 *
 * Пакшот — это вещь на однородном почти-белом фоне (ADR-0002). Такой фон
 * вырезается детерминированно, бесплатно и без искажений, поэтому именно он —
 * «точный вырез», а всё остальное уходит в генеративную AI-версию.
 *
 * Ядро {@link makeCutout} — чистая функция без DOM: принимает RGBA-пиксели,
 * возвращает новые пиксели со изменённой только альфой. DOM-обёртка
 * {@link cutoutBlob} рисует картинку в offscreen canvas, зовёт ядро и отдаёт PNG.
 *
 * Как определяется фон:
 * 1. **Связность, а не порог.** Фон — это почти-белые пиксели, связанные с
 *    рамкой изображения (обход в ширину от краёв). Поэтому белый рисунок
 *    *внутри* вещи (не связанный с рамкой) остаётся непрозрачным.
 * 2. **Мягкая кромка.** Альфа — не ступенька: в переходной зоне яркости
 *    `[whiteThreshold − transitionWidth, whiteThreshold]` она плавно едет от 1
 *    к 0. Плюс сама зона заходит на `edgeRadius` пикселей внутрь вещи.
 * 3. **Однородность локального фона.** На непрозрачность влияет то, насколько
 *    локальное окружение фонового пикселя одного цвета: однородный фон
 *    вырезается смелее, шумный/градиентный — консервативнее.
 * 4. **Цвет не трогается.** Меняется только канал альфы, RGB остаётся байт-в-байт.
 *    Никакого умножения RGB на альфу: иначе вещь темнеет по кромке и меняет оттенок.
 *
 * Защита от катастрофы: если после выреза «выживших» (альфа ≥ 128) осталось
 * меньше {@link CutoutOptions.minSurvivorRatio} (по умолчанию 2%), значит мы
 * едва не стёрли светлую вещь целиком — возвращается исходное изображение и
 * флаг `suspicious: true`.
 */

/** Пиксели изображения в формате RGBA, по 4 байта на пиксель. */
export interface CutoutInput {
  width: number
  height: number
  pixels: Uint8ClampedArray
}

/** Результат выреза. */
export interface CutoutResult {
  width: number
  height: number
  /** Новые пиксели: RGB те же, что на входе, изменена только альфа. */
  pixels: Uint8ClampedArray
  /** Доля прозрачных пикселей (альфа < 128) в `pixels`, 0..1. */
  transparentRatio: number
  /** `true`, если вырез уничтожил бы картинку; тогда `pixels` — исходные. */
  suspicious: boolean
}

/**
 * Параметры выреза.
 *
 * - `whiteThreshold` — порог белизны по min-каналу (0..255). Пиксель с
 *   `min(r,g,b) ≥ whiteThreshold` считается фоном и становится прозрачным.
 *   По умолчанию 240 — тот же порог, что в детекторе пакшота (T6).
 * - `transitionWidth` — ширина мягкой переходной зоны в уровнях яркости.
 *   Альфа едет от 0 при `whiteThreshold` до 1 при `whiteThreshold − transitionWidth`.
 *   По умолчанию 40: кромка получает несколько промежуточных уровней, а не ступеньку.
 * - `edgeRadius` — на сколько пикселей мягкая кромка заходит внутрь вещи от границы
 *   найденного фона. По умолчанию 2.
 * - `aggressiveness` — 0..1: 1 вырезает фон полностью, меньше — оставляет фон
 *   полупрозрачным (консервативный режим). По умолчанию 1.
 * - `uniformityTolerance` — допуск однородности локального фона в уровнях
 *   min-канала для окна 3×3. По умолчанию 8.
 * - `minSurvivorRatio` — минимальная доля выживших (альфа ≥ 128) пикселей; ниже
 *   неё результат отменяется и помечается `suspicious`. По умолчанию 0.02.
 */
export interface CutoutOptions {
  whiteThreshold: number
  transitionWidth: number
  edgeRadius: number
  aggressiveness: number
  uniformityTolerance: number
  minSurvivorRatio: number
}

/** Значения по умолчанию для {@link CutoutOptions}. */
export const DEFAULT_CUTOUT_OPTIONS: CutoutOptions = {
  whiteThreshold: 240,
  transitionWidth: 40,
  edgeRadius: 2,
  aggressiveness: 1,
  uniformityTolerance: 8,
  minSurvivorRatio: 0.02,
}

/** Альфа ниже этого значения считается «прозрачной» в статистике. */
const TRANSPARENT_ALPHA = 128

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function resolveOptions(options?: Partial<CutoutOptions>): CutoutOptions {
  const merged = { ...DEFAULT_CUTOUT_OPTIONS, ...options }
  return {
    whiteThreshold: Math.round(clamp(merged.whiteThreshold, 0, 255)),
    // transitionWidth ≥ 1, иначе переходная зона вырождается в ступеньку.
    transitionWidth: Math.max(1, Math.round(merged.transitionWidth)),
    edgeRadius: Math.max(0, Math.round(merged.edgeRadius)),
    aggressiveness: clamp(merged.aggressiveness, 0, 1),
    uniformityTolerance: Math.max(0, Math.round(merged.uniformityTolerance)),
    minSurvivorRatio: clamp(merged.minSurvivorRatio, 0, 1),
  }
}

/** Близость пикселя к белому: 1 у порога белизны и выше, 0 за переходной зоной. */
function whiteScore(value: number, opaqueAt: number, whiteThreshold: number): number {
  if (value >= whiteThreshold) return 1
  if (value <= opaqueAt) return 0
  return (value - opaqueAt) / (whiteThreshold - opaqueAt)
}

function countTransparent(pixels: Uint8ClampedArray, pixelCount: number): number {
  let count = 0
  for (let p = 0; p < pixelCount; p++) {
    if (pixels[p * 4 + 3] < TRANSPARENT_ALPHA) count++
  }
  return count
}

/**
 * Фон — почти-белые пиксели, связанные с рамкой (обход в ширину от краёв).
 * Функция не зависит от DOM.
 */
function backgroundMask(
  minChannel: Uint8Array,
  width: number,
  height: number,
  threshold: number,
): Uint8Array {
  const pixelCount = width * height
  const mask = new Uint8Array(pixelCount)
  const queue = new Int32Array(pixelCount)
  let tail = 0

  const seed = (p: number): void => {
    if (mask[p] === 0 && minChannel[p] >= threshold) {
      mask[p] = 1
      queue[tail++] = p
    }
  }

  for (let x = 0; x < width; x++) {
    seed(x)
    seed((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    seed(y * width)
    seed(y * width + width - 1)
  }

  let head = 0
  while (head < tail) {
    const p = queue[head++]
    const x = p % width
    const y = (p - x) / width
    if (x > 0) seed(p - 1)
    if (x + 1 < width) seed(p + 1)
    if (y > 0) seed(p - width)
    if (y + 1 < height) seed(p + width)
  }
  return mask
}

/** Расширяет маску фона на `radius` пикселей — зона, где возможна мягкая кромка. */
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const near = new Uint8Array(mask)
  if (radius <= 0) return near

  let frontier: number[] = []
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] === 1) frontier.push(p)
  }

  for (let step = 0; step < radius; step++) {
    const next: number[] = []
    for (const p of frontier) {
      const x = p % width
      const y = (p - x) / width
      if (x > 0 && near[p - 1] === 0) {
        near[p - 1] = 1
        next.push(p - 1)
      }
      if (x + 1 < width && near[p + 1] === 0) {
        near[p + 1] = 1
        next.push(p + 1)
      }
      if (y > 0 && near[p - width] === 0) {
        near[p - width] = 1
        next.push(p - width)
      }
      if (y + 1 < height && near[p + width] === 0) {
        near[p + width] = 1
        next.push(p + width)
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return near
}

/**
 * Однородность локального фона, 0..1: доля соседей по окну 3×3, попавших в
 * допуск по min-каналу. Считаем только соседей, которые сами принадлежат фону,
 * чтобы не штрафовать фон рядом с вещью (иначе вокруг вещи был бы серый ореол).
 */
function localHomogeneity(
  mask: Uint8Array,
  minChannel: Uint8Array,
  width: number,
  height: number,
  tolerance: number,
): Float32Array {
  const homogeneity = new Float32Array(mask.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (mask[p] === 0) continue
      const value = minChannel[p]
      let similar = 1
      let considered = 1
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          const q = ny * width + nx
          if (mask[q] === 0) continue
          considered++
          if (Math.abs(minChannel[q] - value) <= tolerance) similar++
        }
      }
      homogeneity[p] = similar / considered
    }
  }
  return homogeneity
}

/**
 * Точный вырез пакшота. Чистая функция: ни DOM, ни сети, ни мутации входа.
 * Возвращает новые пиксели (вход не изменяется).
 */
export function makeCutout(input: CutoutInput, options?: Partial<CutoutOptions>): CutoutResult {
  const { width, height } = input
  const pixelCount = width * height
  const source = input.pixels

  if (width < 1 || height < 1 || source.length < pixelCount * 4) {
    return { width, height, pixels: source, transparentRatio: 0, suspicious: true }
  }

  const resolved = resolveOptions(options)
  const out = new Uint8ClampedArray(source.length)
  out.set(source)

  const minChannel = new Uint8Array(pixelCount)
  for (let p = 0; p < pixelCount; p++) {
    const i = p * 4
    const r = source[i]
    const g = source[i + 1]
    const b = source[i + 2]
    minChannel[p] = Math.min(r, g, b)
  }

  const background = backgroundMask(minChannel, width, height, resolved.whiteThreshold)
  let hasBackground = false
  for (let p = 0; p < pixelCount; p++) {
    if (background[p] === 1) {
      hasBackground = true
      break
    }
  }

  // Фона не нашли (например, серый фон) — честно ничего не вырезаем.
  if (!hasBackground) {
    return {
      width,
      height,
      pixels: out,
      transparentRatio: countTransparent(out, pixelCount) / pixelCount,
      suspicious: false,
    }
  }

  const near = dilate(background, width, height, resolved.edgeRadius)
  const homogeneity = localHomogeneity(
    background,
    minChannel,
    width,
    height,
    resolved.uniformityTolerance,
  )
  const opaqueAt = Math.max(0, resolved.whiteThreshold - resolved.transitionWidth)

  for (let p = 0; p < pixelCount; p++) {
    let alpha = 1
    if (background[p] === 1) {
      // Чем ближе к белому и чем однороднее локальный фон, тем прозрачнее.
      alpha = 1 - whiteScore(minChannel[p], opaqueAt, resolved.whiteThreshold) * homogeneity[p]
    } else if (near[p] === 1) {
      // Мягкая кромка: только переходная зона, без учёта однородности,
      // чтобы не «замыливать» край вещи.
      alpha = 1 - whiteScore(minChannel[p], opaqueAt, resolved.whiteThreshold)
    }
    // Агрессивность < 1 оставляет фон полупрозрачным (консервативный режим).
    alpha = 1 - resolved.aggressiveness * (1 - alpha)
    if (alpha >= 1) continue
    const i = p * 4
    out[i + 3] = Math.round(source[i + 3] * alpha)
  }

  const transparent = countTransparent(out, pixelCount)
  const survivorRatio = 1 - transparent / pixelCount
  if (survivorRatio < resolved.minSurvivorRatio) {
    // Вырез уничтожил бы почти всю картинку (вещь была светлой) — отменяем.
    const original = new Uint8ClampedArray(source)
    return {
      width,
      height,
      pixels: original,
      transparentRatio: countTransparent(original, pixelCount) / pixelCount,
      suspicious: true,
    }
  }

  return { width, height, pixels: out, transparentRatio: transparent / pixelCount, suspicious: false }
}

/** Итог DOM-обёртки {@link cutoutBlob}. */
export interface CutoutBlobResult {
  /** PNG с прозрачным фоном. */
  blob: Blob
  suspicious: boolean
  transparentRatio: number
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function toPngBlob(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: 'image/png' })
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) {
    throw new Error('Не удалось сохранить вырез в PNG: canvas.toBlob вернул null')
  }
  return blob
}

/**
 * Вырезает фон из картинки в браузере и отдаёт прозрачный PNG.
 *
 * Если canvas или декодирование недоступны (например, jsdom без `canvas`),
 * бросает понятную ошибку — тихого сбоя с необрезанным изображением нет.
 */
export async function cutoutBlob(
  blob: Blob,
  options?: Partial<CutoutOptions>,
): Promise<CutoutBlobResult> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('Вырез недоступен: среда не поддерживает createImageBitmap')
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch (error) {
    throw new Error(`Не удалось декодировать изображение для выреза: ${messageOf(error)}`)
  }

  try {
    const { width, height } = bitmap
    const canvas = createCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) {
      throw new Error('Вырез недоступен: не удалось получить 2D-контекст canvas')
    }
    context.drawImage(bitmap, 0, 0)
    const imageData = context.getImageData(0, 0, width, height)
    const result = makeCutout({ width, height, pixels: imageData.data }, options)
    const output = context.createImageData(width, height)
    output.data.set(result.pixels)
    context.putImageData(output, 0, 0)
    return {
      blob: await toPngBlob(canvas),
      suspicious: result.suspicious,
      transparentRatio: result.transparentRatio,
    }
  } finally {
    bitmap.close()
  }
}
