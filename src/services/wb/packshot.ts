/**
 * Эвристика «пакшот ли это фото» по рамке изображения.
 *
 * Ядро — чистая функция {@link analyzeFrame} без DOM: принимает пиксели и
 * возвращает разбор. DOM-обёртка {@link analyzeImage} рисует картинку в canvas
 * и зовёт ядро. {@link pickBestPhoto} перебирает фото по порядку и берёт первое,
 * признанное пакшотом; если пакшота нет — честно об этом сообщает, а не
 * подсовывает первое фото.
 *
 * Идея: пакшот WB — вещь на однородном почти-белом фоне, поэтому рамка такого
 * фото почти вся белая и одного цвета. Фото на модели — серый фон, вшитый текст
 * или градиент: рамка либо не белая, либо неоднородная.
 */

/** Пиксели изображения в формате RGBA, по 4 байта на пиксель. */
export interface FrameData {
  width: number
  height: number
  pixels: Uint8ClampedArray
}

/** Результат анализа рамки. */
export interface PackshotAnalysis {
  isPackshot: boolean
  /** Доля почти-белых пикселей на рамке, 0..1. */
  whiteness: number
  /** Доля пикселей в доминирующем цвете рамки (с допуском), 0..1. */
  uniformity: number
  /** Понятное объяснение решения. */
  reason: string
}

/**
 * Пороги подобраны по реальным карточкам WB и синтетике (см. `docs/evidence/T4-T6.md`):
 * - рамка толщиной 6% от меньшей стороны;
 * - «почти белый» — все каналы ≥ 240;
 * - у настоящего пакшота 14058746 рамка даёт whiteness 0.87–0.89, uniformity 0.87–0.90
 *   (низ вещи заходит в кадр), а у фото на модели whiteness = 0. Порог 0.80 отделяет
 *   их с запасом, при этом серая однородная рамка (whiteness 0) и градиент
 *   (uniformity ~0.30) отсекаются.
 */
const FRAME_FRACTION = 0.06
const NEAR_WHITE_MIN = 240
const WHITENESS_MIN = 0.8
const UNIFORMITY_MIN = 0.75

/** Квантование цвета для поиска доминирующего: 4 бита на канал (16 ступеней). */
const QUANT_SHIFT = 4
const QUANT_MASK = 0xf
/** Допуск вокруг центра доминирующего цвета при подсчёте однородности. */
const DOMINANT_TOLERANCE = 24

function isFramePixel(x: number, y: number, width: number, height: number, frame: number): boolean {
  return x < frame || x >= width - frame || y < frame || y >= height - frame
}

function emptyAnalysis(reason: string): PackshotAnalysis {
  return { isPackshot: false, whiteness: 0, uniformity: 0, reason }
}

/** Толщина рамки: ~6% от меньшей стороны, минимум 1 пиксель. */
function frameThickness(width: number, height: number): number {
  return Math.max(1, Math.round(Math.min(width, height) * FRAME_FRACTION))
}

interface FrameStats {
  total: number
  nearWhite: number
  buckets: Map<number, number>
}

/** Первый проход: размер рамки, доля белых и гистограмма квантованных цветов. */
function collectFrameStats(
  width: number,
  height: number,
  pixels: Uint8ClampedArray,
  frame: number,
): FrameStats {
  let total = 0
  let nearWhite = 0
  const buckets = new Map<number, number>()
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isFramePixel(x, y, width, height, frame)) continue
      const i = (y * width + x) * 4
      const r = pixels[i]
      const g = pixels[i + 1]
      const b = pixels[i + 2]
      total++
      if (r >= NEAR_WHITE_MIN && g >= NEAR_WHITE_MIN && b >= NEAR_WHITE_MIN) nearWhite++
      const key = ((r >> QUANT_SHIFT) << 8) | ((g >> QUANT_SHIFT) << 4) | (b >> QUANT_SHIFT)
      buckets.set(key, (buckets.get(key) ?? 0) + 1)
    }
  }
  return { total, nearWhite, buckets }
}

interface Color {
  r: number
  g: number
  b: number
}

/** Центр самого частого квантованного цвета рамки. */
function dominantColor(buckets: Map<number, number>): Color {
  let key = 0
  let count = -1
  for (const [candidate, candidateCount] of buckets) {
    if (candidateCount > count) {
      count = candidateCount
      key = candidate
    }
  }
  const step = QUANT_MASK + 1
  const half = QUANT_MASK / 2 + 0.5
  return {
    r: ((key >> 8) & QUANT_MASK) * step + half,
    g: ((key >> 4) & QUANT_MASK) * step + half,
    b: (key & QUANT_MASK) * step + half,
  }
}

/** Второй проход: сколько пикселей рамки лежит в допуске от доминирующего цвета. */
function countUniform(
  width: number,
  height: number,
  pixels: Uint8ClampedArray,
  frame: number,
  color: Color,
): number {
  let within = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isFramePixel(x, y, width, height, frame)) continue
      const i = (y * width + x) * 4
      if (
        Math.abs(pixels[i] - color.r) <= DOMINANT_TOLERANCE &&
        Math.abs(pixels[i + 1] - color.g) <= DOMINANT_TOLERANCE &&
        Math.abs(pixels[i + 2] - color.b) <= DOMINANT_TOLERANCE
      ) {
        within++
      }
    }
  }
  return within
}

/**
 * Анализирует рамку изображения. Чистая функция: ни DOM, ни сети.
 */
export function analyzeFrame(data: FrameData): PackshotAnalysis {
  const { width, height, pixels } = data
  if (width <= 0 || height <= 0 || pixels.length < width * height * 4) {
    return emptyAnalysis('Пустое изображение')
  }

  const frame = frameThickness(width, height)
  const { total, nearWhite, buckets } = collectFrameStats(width, height, pixels, frame)
  if (total === 0) return emptyAnalysis('Пустое изображение')

  const whiteness = nearWhite / total
  const uniformity = countUniform(width, height, pixels, frame, dominantColor(buckets)) / total
  const isPackshot = whiteness >= WHITENESS_MIN && uniformity >= UNIFORMITY_MIN
  return {
    isPackshot,
    whiteness,
    uniformity,
    reason: explain(isPackshot, whiteness, uniformity),
  }
}

function explain(isPackshot: boolean, whiteness: number, uniformity: number): string {
  if (isPackshot) return 'Рамка почти белая и однородная — это пакшот'
  if (whiteness < WHITENESS_MIN && uniformity < UNIFORMITY_MIN) {
    return 'Фон не белый и неоднородный — не пакшот'
  }
  if (whiteness < WHITENESS_MIN) {
    return `Фон не белый (белого ${Math.round(whiteness * 100)}%) — вероятно, фото на модели`
  }
  return 'Фон неоднородный — текст, градиент или несколько цветов'
}

/** Источник пикселей для {@link analyzeImage}. */
export type ImageSource = Blob | ImageBitmap

/** Анализирует картинку через offscreen canvas. В jsdom не вызывается. */
export async function analyzeImage(source: ImageSource): Promise<PackshotAnalysis> {
  const bitmap = source instanceof Blob ? await createImageBitmap(source) : source
  try {
    const { width, height } = bitmap
    const canvas = createCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) {
      throw new Error('Не удалось получить 2D-контекст для анализа изображения')
    }
    context.drawImage(bitmap, 0, 0)
    const imageData = context.getImageData(0, 0, width, height)
    return analyzeFrame({ width, height, pixels: imageData.data })
  } finally {
    if (source instanceof Blob) bitmap.close()
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/** Функция анализа одного фото: обычно `(url) => analyzeImage(await fetchBlob(url))`. */
export type PhotoAnalyzer = (photo: string) => Promise<PackshotAnalysis>

/** Итог выбора лучшего фото. */
export type PickBestPhotoResult =
  | { isPackshot: true; index: number; url: string; analysis: PackshotAnalysis }
  | { isPackshot: false; index: -1; reason: string; analyzed: number }

/**
 * Перебирает фото по возрастанию индекса и возвращает первое, признанное
 * пакшотом. Если пакшота нет — возвращает `{ isPackshot: false }` с честным
 * объяснением, не выдавая первое фото за пакшот. Ошибка анализа одного фото
 * не прерывает перебор.
 */
export async function pickBestPhoto(
  photos: readonly string[],
  analyze: PhotoAnalyzer,
): Promise<PickBestPhotoResult> {
  for (let index = 0; index < photos.length; index++) {
    const url = photos[index]
    let analysis: PackshotAnalysis
    try {
      analysis = await analyze(url)
    } catch {
      continue
    }
    if (analysis.isPackshot) {
      return { isPackshot: true, index, url, analysis }
    }
  }
  return {
    isPackshot: false,
    index: -1,
    reason: `Пакшот не найден среди ${photos.length} фото`,
    analyzed: photos.length,
  }
}
