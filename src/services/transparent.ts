/**
 * Прозрачный фон AI-версии (ADR-0008).
 *
 * Модели без нативного `background: "transparent"` отдают кадр на почти-белом
 * фоне (Grok, Flux, Qwen, Nano Banana). Чтобы в образе вокруг вещи не было
 * белого прямоугольника, готовый кадр нормализуется на клиенте: если альфы ещё
 * нет, запускается существующий точный вырез {@link makeCutout} из `cutout.ts`.
 *
 * Нормализация не должна ломать генерацию: среда без `createImageBitmap`
 * (jsdom, старый webview), ошибка декодирования, подозрительный вырез — во всех
 * этих случаях возвращается исходный blob. Повторный вызов на PNG с альфой
 * сразу отдаёт исходник.
 */

import { makeCutout } from './cutout'

/** Есть ли в RGBA-пикселях хоть один полупрозрачный или прозрачный пиксель. */
export function hasTransparency(pixels: Uint8ClampedArray): boolean {
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < 255) return true
  }
  return false
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

async function toPngBlob(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: 'image/png' })
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) {
    throw new Error('Не удалось сохранить прозрачный PNG: canvas.toBlob вернул null')
  }
  return blob
}

/**
 * Возвращает PNG с прозрачным фоном либо исходный blob, если прозрачность уже
 * есть или вырез небезопасен. Никогда не бросает: генерация важнее нормализации.
 */
export async function ensureTransparentPng(blob: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') return blob

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    return blob
  }

  try {
    const { width, height } = bitmap
    const canvas = createCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return blob

    context.drawImage(bitmap, 0, 0)
    const imageData = context.getImageData(0, 0, width, height)
    if (hasTransparency(imageData.data)) return blob

    const result = makeCutout({ width, height, pixels: imageData.data })
    if (result.suspicious || result.transparentRatio === 0) return blob

    const output = context.createImageData(width, height)
    output.data.set(result.pixels)
    context.putImageData(output, 0, 0)
    return await toPngBlob(canvas)
  } catch {
    return blob
  } finally {
    bitmap.close()
  }
}
