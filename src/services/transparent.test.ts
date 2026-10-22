import { afterEach, describe, expect, it, vi } from 'vitest'

import { ensureTransparentPng, hasTransparency } from './transparent'

function whiteFrame(width = 40, height = 40): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = 255
    pixels[i * 4 + 1] = 255
    pixels[i * 4 + 2] = 255
    pixels[i * 4 + 3] = 255
  }
  for (let y = 10; y < 30; y++) {
    for (let x = 10; x < 30; x++) {
      const i = (y * width + x) * 4
      pixels[i] = 180
      pixels[i + 1] = 40
      pixels[i + 2] = 60
    }
  }
  return pixels
}

describe('hasTransparency', () => {
  it('находит прозрачные и полупрозрачные пиксели', () => {
    expect(hasTransparency(new Uint8ClampedArray([255, 255, 255, 255]))).toBe(false)
    expect(hasTransparency(new Uint8ClampedArray([0, 0, 0, 0]))).toBe(true)
    expect(
      hasTransparency(new Uint8ClampedArray([255, 255, 255, 255, 10, 20, 30, 128])),
    ).toBe(true)
  })
})

describe('ensureTransparentPng', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('без createImageBitmap возвращает исходный blob', async () => {
    const blob = new Blob(['jpg'], { type: 'image/jpeg' })
    expect(typeof createImageBitmap).not.toBe('function')
    expect(await ensureTransparentPng(blob)).toBe(blob)
  })

  it('шибка декодирования возвращает исходный blob', async () => {
    const blob = new Blob(['сломанный'], { type: 'image/jpeg' })
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('decode failed')
      }),
    )

    expect(await ensureTransparentPng(blob)).toBe(blob)
  })

  it('кадр с альфой возвращается как есть, без перекодирования', async () => {
    const blob = new Blob(['png'], { type: 'image/png' })
    const pixels = new Uint8ClampedArray([255, 255, 255, 0])
    const putImageData = vi.fn()
    const toBlob = vi.fn()
    const context = {
      drawImage: vi.fn(),
      getImageData: () => ({ data: pixels }),
      createImageData: () => ({ data: new Uint8ClampedArray(pixels.length) }),
      putImageData,
    }
    const canvas = { width: 0, height: 0, getContext: () => context, toBlob }
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement)
    vi.stubGlobal('OffscreenCanvas', undefined)
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
    )

    expect(await ensureTransparentPng(blob)).toBe(blob)
    expect(putImageData).not.toHaveBeenCalled()
    expect(toBlob).not.toHaveBeenCalled()
  })

  it('кадр на белом фоне проходит через makeCutout и становится PNG', async () => {
    const blob = new Blob(['jpg'], { type: 'image/jpeg' })
    const pixels = whiteFrame()
    let записанные: ImageData | undefined
    const putImageData = vi.fn((data: ImageData) => {
      записанные = data
    })
    const context = {
      drawImage: vi.fn(),
      getImageData: () => ({ data: pixels }),
      createImageData: () => ({
        data: new Uint8ClampedArray(pixels.length),
      }),
      putImageData,
    }
    const toBlob = vi.fn((callback: BlobCallback) =>
      callback(new Blob(['png'], { type: 'image/png' })),
    )
    const canvas = { width: 0, height: 0, getContext: () => context, toBlob }
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement)
    vi.stubGlobal('OffscreenCanvas', undefined)
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 40, height: 40, close: vi.fn() })),
    )

    const result = await ensureTransparentPng(blob)

    expect(result).not.toBe(blob)
    expect(result.type).toBe('image/png')
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png')
    // Кадр не должен терять размеры исходника.
    expect(canvas.width).toBe(40)
    expect(canvas.height).toBe(40)
    // Угол вырезан, центр вещи остался непрозрачным.
    expect(записанные?.data[3]).toBe(0)
    expect(записанные?.data[(20 * 40 + 20) * 4 + 3]).toBe(255)
  })

  it('кадр без белого фона (вырез ничего не нашёл) не перекодируется', async () => {
    const blob = new Blob(['jpg'], { type: 'image/jpeg' })
    // Ровный серый фон: белого фона нет, transparentRatio === 0.
    const pixels = new Uint8ClampedArray(40 * 40 * 4)
    for (let i = 0; i < 40 * 40; i++) {
      pixels[i * 4] = 100
      pixels[i * 4 + 1] = 100
      pixels[i * 4 + 2] = 100
      pixels[i * 4 + 3] = 255
    }
    const toBlob = vi.fn()
    const context = {
      drawImage: vi.fn(),
      getImageData: () => ({ data: pixels }),
      createImageData: () => ({ data: new Uint8ClampedArray(pixels.length) }),
      putImageData: vi.fn(),
    }
    const canvas = { width: 0, height: 0, getContext: () => context, toBlob }
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement)
    vi.stubGlobal('OffscreenCanvas', undefined)
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 40, height: 40, close: vi.fn() })),
    )

    expect(await ensureTransparentPng(blob)).toBe(blob)
    expect(toBlob).not.toHaveBeenCalled()
  })

  it('подозрительный вырез не портит кадр', async () => {
    const blob = new Blob(['jpg'], { type: 'image/jpeg' })
    // Почти весь кадр белый: вырез счёл бы это светлой вещью и отменился.
    const pixels = new Uint8ClampedArray(40 * 40 * 4).fill(255)
    const toBlob = vi.fn()
    const context = {
      drawImage: vi.fn(),
      getImageData: () => ({ data: pixels }),
      createImageData: () => ({ data: new Uint8ClampedArray(pixels.length) }),
      putImageData: vi.fn(),
    }
    const canvas = { width: 0, height: 0, getContext: () => context, toBlob }
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement)
    vi.stubGlobal('OffscreenCanvas', undefined)
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 40, height: 40, close: vi.fn() })),
    )

    expect(await ensureTransparentPng(blob)).toBe(blob)
    expect(toBlob).not.toHaveBeenCalled()
  })
})
