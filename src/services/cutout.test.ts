import { describe, expect, it } from 'vitest'

import { cutoutBlob, makeCutout, type CutoutInput, type CutoutOptions } from './cutout'

type Rgb = readonly [number, number, number]

function solid(width: number, height: number, [r, g, b]: Rgb): CutoutInput {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = r
    pixels[i * 4 + 1] = g
    pixels[i * 4 + 2] = b
    pixels[i * 4 + 3] = 255
  }
  return { width, height, pixels }
}

function setPixel(data: CutoutInput, x: number, y: number, [r, g, b]: Rgb): void {
  const i = (y * data.width + x) * 4
  data.pixels[i] = r
  data.pixels[i + 1] = g
  data.pixels[i + 2] = b
  data.pixels[i + 3] = 255
}

function fillRect(data: CutoutInput, x0: number, y0: number, w: number, h: number, color: Rgb): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) setPixel(data, x, y, color)
  }
}

/** RGBA пикселя результата. */
function rgba(data: CutoutInput, x: number, y: number): [number, number, number, number] {
  const i = (y * data.width + x) * 4
  return [data.pixels[i], data.pixels[i + 1], data.pixels[i + 2], data.pixels[i + 3]]
}

/** Ошибка RGB между входом и выходом по всем пикселям (цвет обязан сохраниться). */
function maxRgbDelta(before: CutoutInput, after: CutoutInput): number {
  let max = 0
  for (let i = 0; i < before.pixels.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const delta = Math.abs(before.pixels[i + c] - after.pixels[i + c])
      if (delta > max) max = delta
    }
  }
  return max
}

function alphas(data: CutoutInput): number[] {
  const result: number[] = []
  for (let i = 3; i < data.pixels.length; i += 4) result.push(data.pixels[i])
  return result
}

describe('makeCutout', () => {
  it('белый фон + вещь: рамка прозрачная, вещь непрозрачная, цвет не изменился', () => {
    const before = solid(40, 40, [255, 255, 255])
    fillRect(before, 10, 10, 20, 20, [180, 40, 60])

    const result = makeCutout(before)

    expect(rgba(result, 0, 0)[3]).toBe(0)
    expect(rgba(result, 39, 0)[3]).toBe(0)
    expect(rgba(result, 0, 39)[3]).toBe(0)
    expect(rgba(result, 39, 39)[3]).toBe(0)
    expect(rgba(result, 20, 20)[3]).toBe(255)
    expect(maxRgbDelta(before, result)).toBe(0)
    expect(result.transparentRatio).toBeGreaterThan(0.4)
    expect(result.suspicious).toBe(false)
  })

  it('почти-белый фон (250,250,250) тоже вырезается', () => {
    const before = solid(40, 40, [250, 250, 250])
    fillRect(before, 12, 12, 16, 16, [30, 90, 140])

    const result = makeCutout(before)

    expect(rgba(result, 0, 0)[3]).toBe(0)
    expect(rgba(result, 20, 20)[3]).toBe(255)
    expect(maxRgbDelta(before, result)).toBe(0)
    expect(result.suspicious).toBe(false)
  })

  it('светлая вещь на белом сохраняется и не исчезает', () => {
    const before = solid(40, 40, [255, 255, 255])
    fillRect(before, 10, 10, 20, 20, [240, 240, 235])

    const result = makeCutout(before)

    // Вещь не съедена: центр непрозрачен, выживших заметно больше 2%.
    expect(rgba(result, 20, 20)[3]).toBe(255)
    expect(result.suspicious).toBe(false)
    expect(result.transparentRatio).toBeLessThan(0.9)
    expect(maxRgbDelta(before, result)).toBe(0)
  })

  it('серый фон: вырез не вырезает ничего (нет почти-белой связной области)', () => {
    const before = solid(40, 40, [128, 128, 128])
    fillRect(before, 10, 10, 20, 20, [40, 40, 40])

    const result = makeCutout(before)

    expect(result.transparentRatio).toBe(0)
    expect(rgba(result, 0, 0)[3]).toBe(255)
    expect(rgba(result, 20, 20)[3]).toBe(255)
    expect(maxRgbDelta(before, result)).toBe(0)
  })

  it('внутренняя светлая деталь вещи остаётся непрозрачной', () => {
    const before = solid(40, 40, [255, 255, 255])
    fillRect(before, 8, 8, 24, 24, [60, 60, 60])
    // Белый рисунок внутри вещи, не связанный с рамкой.
    fillRect(before, 18, 18, 4, 4, [255, 255, 255])

    const result = makeCutout(before)

    expect(rgba(result, 19, 19)[3]).toBe(255)
    expect(rgba(result, 20, 20)[3]).toBe(255)
    expect(rgba(result, 0, 0)[3]).toBe(0)
    expect(maxRgbDelta(before, result)).toBe(0)
  })

  it('кромка мягкая: есть промежуточные уровни альфы вместо ступеньки', () => {
    const before = solid(40, 40, [255, 255, 255])
    // Имитация сглаженного края: градиент белого к вещи по колонкам 8..11.
    const ramp: Rgb[] = [
      [235, 235, 235],
      [230, 230, 230],
      [225, 225, 225],
      [220, 220, 220],
    ]
    for (let y = 8; y < 32; y++) {
      for (let x = 8; x < 12; x++) setPixel(before, x, y, ramp[x - 8])
    }
    fillRect(before, 12, 10, 20, 20, [60, 50, 40])

    const result = makeCutout(before)

    const intermediate = alphas(result).filter((a) => a > 0 && a < 255)
    const distinct = [...new Set(intermediate)].sort((a, b) => a - b)

    expect(distinct.length).toBeGreaterThanOrEqual(2)
    // Ближе к вещи — плотнее, дальше от фона — прозрачнее.
    expect(rgba(result, 8, 20)[3]).toBeLessThan(rgba(result, 9, 20)[3])
    expect(rgba(result, 9, 20)[3]).toBeLessThan(rgba(result, 20, 20)[3])
  })

  it('целиком белое изображение: suspicious, исходник не уничтожен', () => {
    const before = solid(30, 30, [255, 255, 255])

    const result = makeCutout(before)

    expect(result.suspicious).toBe(true)
    expect(result.transparentRatio).toBe(0)
    expect(rgba(result, 15, 15)[3]).toBe(255)
    expect(alphas(result).every((a) => a === 255)).toBe(true)
    expect(maxRgbDelta(before, result)).toBe(0)
  })

  it('не падает на пустом и однопиксельном изображении', () => {
    const empty = makeCutout({ width: 0, height: 0, pixels: new Uint8ClampedArray(0) })
    expect(empty.suspicious).toBe(true)

    const single = makeCutout(solid(1, 1, [255, 255, 255]))
    expect(single.suspicious).toBe(true)
    expect(single.pixels[3]).toBe(255)
  })

  it('aggressiveness меньше 1 оставляет фон полупрозрачным', () => {
    const before = solid(30, 30, [255, 255, 255])
    fillRect(before, 8, 8, 14, 14, [20, 20, 20])
    const options: Partial<CutoutOptions> = { aggressiveness: 0.5 }

    const result = makeCutout(before, options)

    expect(rgba(result, 0, 0)[3]).toBe(128)
    expect(rgba(result, 15, 15)[3]).toBe(255)
  })
})

describe('cutoutBlob', () => {
  it('без createImageBitmap/canvas бросает понятную ошибку, а не тихий сбой', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })

    await expect(cutoutBlob(blob)).rejects.toThrow(/вырез недоступен|createImageBitmap|canvas/i)
  })
})
