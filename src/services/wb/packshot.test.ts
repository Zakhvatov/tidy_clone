import { describe, expect, it } from 'vitest'

import { analyzeFrame, pickBestPhoto, type FrameData, type PackshotAnalysis } from './packshot'

type Rgb = readonly [number, number, number]

function solid(width: number, height: number, [r, g, b]: Rgb): FrameData {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = r
    pixels[i * 4 + 1] = g
    pixels[i * 4 + 2] = b
    pixels[i * 4 + 3] = 255
  }
  return { width, height, pixels }
}

function setPixel(data: FrameData, x: number, y: number, [r, g, b]: Rgb): void {
  const i = (y * data.width + x) * 4
  data.pixels[i] = r
  data.pixels[i + 1] = g
  data.pixels[i + 2] = b
  data.pixels[i + 3] = 255
}

/** Рисует только по рамке (та же формула толщины, что и в ядре). */
function paintFrame(data: FrameData, paint: (x: number, y: number) => Rgb | null): void {
  const frame = Math.max(1, Math.round(Math.min(data.width, data.height) * 0.06))
  for (let y = 0; y < data.height; y++) {
    for (let x = 0; x < data.width; x++) {
      const isFrame = x < frame || x >= data.width - frame || y < frame || y >= data.height - frame
      if (!isFrame) continue
      const color = paint(x, y)
      if (color) setPixel(data, x, y, color)
    }
  }
}

describe('analyzeFrame', () => {
  it('белая рамка → пакшот', () => {
    const result = analyzeFrame(solid(100, 100, [255, 255, 255]))
    expect(result.isPackshot).toBe(true)
    expect(result.whiteness).toBe(1)
    expect(result.uniformity).toBe(1)
  })

  it('серая однородная рамка → не пакшот', () => {
    const result = analyzeFrame(solid(100, 100, [128, 128, 128]))
    expect(result.isPackshot).toBe(false)
    expect(result.whiteness).toBe(0)
    expect(result.reason).toContain('не белый')
  })

  it('светлая рамка с вшитым текстом → не пакшот', () => {
    const data = solid(100, 100, [247, 247, 247])
    // «Текст» — тёмные штрихи примерно на трети пикселей рамки.
    paintFrame(data, (x, y) => ((x + y) % 3 === 0 ? [20, 20, 20] : null))
    const result = analyzeFrame(data)
    expect(result.isPackshot).toBe(false)
    expect(result.whiteness).toBeLessThan(0.8)
  })

  it('рамка с сильным градиентом → не пакшот', () => {
    const data = solid(100, 100, [255, 255, 255])
    paintFrame(data, (x) => {
      const value = Math.round((255 * x) / (data.width - 1))
      return [value, value, value]
    })
    const result = analyzeFrame(data)
    expect(result.isPackshot).toBe(false)
    expect(result.uniformity).toBeLessThan(0.75)
  })

  it('почти белая рамка с ~15% пикселей вещи → пакшот (как у реального WB-пакшота)', () => {
    const data = solid(100, 100, [255, 255, 255])
    let index = 0
    paintFrame(data, () => (index++ % 7 === 0 ? [60, 60, 60] : null))
    const result = analyzeFrame(data)
    expect(result.isPackshot).toBe(true)
    expect(result.whiteness).toBeGreaterThan(0.8)
  })

  it('не падает на пустом и однопиксельном изображении', () => {
    expect(analyzeFrame({ width: 0, height: 0, pixels: new Uint8ClampedArray(0) }).isPackshot).toBe(
      false,
    )
    expect(analyzeFrame(solid(1, 1, [255, 255, 255])).isPackshot).toBe(true)
  })
})

function analysis(isPackshot: boolean, reason = 'тест'): PackshotAnalysis {
  return { isPackshot, whiteness: isPackshot ? 1 : 0, uniformity: isPackshot ? 1 : 0, reason }
}

describe('pickBestPhoto', () => {
  it('возвращает первое фото, признанное пакшотом, по возрастанию индекса', async () => {
    const photos = ['a', 'b', 'c']
    const analyze = async (photo: string) => analysis(photo === 'b')

    const result = await pickBestPhoto(photos, analyze)

    expect(result).toEqual({
      isPackshot: true,
      index: 1,
      url: 'b',
      analysis: analysis(true),
    })
  })

  it('если пакшота нет — честно сообщает, не подсовывая первое фото', async () => {
    const photos = ['a', 'b', 'c']
    const analyze = async () => analysis(false)

    const result = await pickBestPhoto(photos, analyze)

    expect(result.isPackshot).toBe(false)
    if (result.isPackshot) throw new Error('ожидался отказ')
    expect(result.index).toBe(-1)
    expect(result.reason).toContain('Пакшот не найден')
    expect(result.analyzed).toBe(3)
  })

  it('пропускает фото, на котором анализ упал, и продолжает перебор', async () => {
    const photos = ['broken', 'good']
    const analyze = async (photo: string) => {
      if (photo === 'broken') throw new Error('не декодировалось')
      return analysis(true)
    }

    const result = await pickBestPhoto(photos, analyze)
    expect(result).toMatchObject({ isPackshot: true, index: 1, url: 'good' })
  })
})
