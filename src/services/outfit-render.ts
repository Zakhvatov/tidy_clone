/**
 * Рендер образа в PNG (T16).
 *
 * Модуль живёт вне React и не трогает DOM, кроме самого canvas: его задача —
 * превратить сохранённый `Образ` в картинку-коллаж. Экран `/outfit/:id` рисует
 * элементы обычными DOM-узлами ради перетаскивания, а этот сервис нужен для
 * обложки-миниатюры (T18) и будущего экспорта.
 *
 * Раскладка вынесена в чистую `layoutElements()`: порядок слоёв, границы холста
 * и масштаб проверяются тестами без canvas. Изображение элемента берётся
 * правилом «Решения» — AI-версия, если она есть, иначе Оригинал (`preferredImage`).
 */

import type { Изображение, Образ, ЭлементОбраза, Вещь } from '../domain/types'
import { preferredImage } from './wardrobe'

/** Канонический холст коллажа: в этих координатах хранятся `позиция` и `масштаб`. */
export const COLLAGE_WIDTH = 1000
export const COLLAGE_HEIGHT = 1250

/** Канонический холст как объект — значение по умолчанию для раскладки. */
export const КАНОНИЧЕСКИЙ_ХОЛСТ: РазмерХолста = { width: COLLAGE_WIDTH, height: COLLAGE_HEIGHT }

/** Какую долю меньшей стороны холста занимает элемент при масштабе 1. */
export const BASE_ELEMENT_RATIO = 0.42

/** Пределы масштаба: мельче — теряется вещь, крупнее — элемент не влезает в холст. */
export const MIN_SCALE = 0.3
export const MAX_SCALE = 2.5

/** Большая сторона обложки-миниатюры. */
export const COVER_MAX_SIDE = 600

export interface РазмерХолста {
  width: number
  height: number
}

/** Прямоугольник элемента в пикселях холста: левый верхний угол и сторона квадрата. */
export interface ПрямоугольникЭлемента {
  idВещи: string
  zПорядок: number
  left: number
  top: number
  width: number
  height: number
}

/** Действие над слоем выбранного элемента. */
export type ДействиеСлоя = 'выше' | 'ниже' | 'наверх' | 'вниз'

/** Ограничивает масштаб допустимым диапазоном; нечисло трактуется как 1. */
export function ограничитьМасштаб(масштаб: number): number {
  if (!Number.isFinite(масштаб)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, масштаб))
}

/** Сторона квадрата элемента при данном масштабе и холсте. */
function сторонаЭлемента(масштаб: number, холст: РазмерХолста): number {
  const меньшая = Math.min(холст.width, холст.height)
  const база = меньшая * BASE_ELEMENT_RATIO
  return Math.min(база * ограничитьМасштаб(масштаб), меньшая)
}

/**
 * Чистая раскладка: превращает элементы образа в прямоугольники холста.
 *
 * Элементы возвращаются в порядке отрисовки — по возрастанию `zПорядок`, так
 * что последний нарисован поверх остальных. Позиция центра зажимается внутрь
 * холста, поэтому крайние элементы не улетают за границы при любом вводе.
 */
export function layoutElements(
  элементы: readonly ЭлементОбраза[],
  холст: РазмерХолста = КАНОНИЧЕСКИЙ_ХОЛСТ,
): ПрямоугольникЭлемента[] {
  return [...элементы]
    .sort((a, b) => a.zПорядок - b.zПорядок)
    .map((элемент) => {
      const сторона = сторонаЭлемента(элемент.масштаб, холст)
      const половина = сторона / 2
      const x = Math.min(Math.max(элемент.позиция.x, половина), холст.width - половина)
      const y = Math.min(Math.max(элемент.позиция.y, половина), холст.height - половина)
      return {
        idВещи: элемент.idВещи,
        zПорядок: элемент.zПорядок,
        left: x - половина,
        top: y - половина,
        width: сторона,
        height: сторона,
      }
    })
}

/** Заранее подобранные места для новых вещей — коллаж не схлопывается в центр. */
const СЛОТЫ: ReadonlyArray<readonly [number, number]> = [
  [0.32, 0.28],
  [0.68, 0.28],
  [0.32, 0.6],
  [0.68, 0.6],
  [0.5, 0.85],
  [0.5, 0.5],
]

/** Позиция центра для новой вещи по счётчику уже добавленных. */
export function позицияПоУмолчанию(
  index: number,
  холст: РазмерХолста = КАНОНИЧЕСКИЙ_ХОЛСТ,
): { x: number; y: number } {
  const слот = СЛОТЫ[index] ?? СЛОТЫ[СЛОТЫ.length - 1]
  const [доляX, доляY] = слот ?? [0.5, 0.5]
  return { x: Math.round(холст.width * доляX), y: Math.round(холст.height * доляY) }
}

/**
 * Переставляет слой элемента и перенормирует `zПорядок` в 0…n−1.
 * Неизвестный `idВещи` ничего не меняет.
 */
export function изменитьСлой(
  элементы: readonly ЭлементОбраза[],
  idВещи: string,
  действие: ДействиеСлоя,
): ЭлементОбраза[] {
  const упорядоченные = [...элементы].sort((a, b) => a.zПорядок - b.zПорядок)
  const текущий = упорядоченные.findIndex((элемент) => элемент.idВещи === idВещи)
  if (текущий < 0) return [...элементы]

  let цель = текущий
  switch (действие) {
    case 'выше':
      цель = Math.min(упорядоченные.length - 1, текущий + 1)
      break
    case 'ниже':
      цель = Math.max(0, текущий - 1)
      break
    case 'наверх':
      цель = упорядоченные.length - 1
      break
    case 'вниз':
      цель = 0
      break
    default:
      цель = текущий
      break
  }

  const [перемещаемый] = упорядоченные.splice(текущий, 1)
  if (перемещаемый === undefined) return [...элементы]
  упорядоченные.splice(цель, 0, перемещаемый)
  return упорядоченные.map((элемент, индекс) => ({ ...элемент, zПорядок: индекс }))
}

/** Размер обложки: большая сторона равна `maxSide`, пропорции коллажа сохранены. */
export function coverSize(maxSide: number = COVER_MAX_SIDE): РазмерХолста {
  if (COLLAGE_WIDTH >= COLLAGE_HEIGHT) {
    return {
      width: maxSide,
      height: Math.max(1, Math.round((maxSide * COLLAGE_HEIGHT) / COLLAGE_WIDTH)),
    }
  }
  return {
    width: Math.max(1, Math.round((maxSide * COLLAGE_WIDTH) / COLLAGE_HEIGHT)),
    height: maxSide,
  }
}

export interface ПараметрыРендера {
  width?: number
  height?: number
  /** Цвет подложки. По умолчанию белый — ADR-0005. */
  background?: string
}

/** Загруженное изображение вещи вместе с функцией освобождения ресурса. */
interface ЗагруженноеИзображение {
  источник: CanvasImageSource
  ширина: number
  высота: number
  освободить: () => void
}

function создатьХолст(width: number, height: number): HTMLCanvasElement {
  if (typeof document === 'undefined') {
    throw new Error('Canvas доступен только в браузере')
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/**
 * Читает blob в источник для `drawImage`. `createImageBitmap` эффективнее и не
 * течёт; запасной путь через `Image` освобождает object URL после отрисовки.
 */
async function загрузитьИзображение(blob: Blob): Promise<ЗагруженноеИзображение> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    return {
      источник: bitmap,
      ширина: bitmap.width,
      высота: bitmap.height,
      освободить: () => bitmap.close(),
    }
  }

  const url = URL.createObjectURL(blob)
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const элемент = new Image()
    элемент.onload = () => resolve(элемент)
    элемент.onerror = () => reject(new Error('Не удалось прочитать изображение вещи'))
    элемент.src = url
  })
  return {
    источник: image,
    ширина: image.naturalWidth,
    высота: image.naturalHeight,
    освободить: () => URL.revokeObjectURL(url),
  }
}

/** Вписывает изображение в квадрат элемента, сохраняя пропорции (contain). */
function нарисоватьВписанное(
  ctx: CanvasRenderingContext2D,
  изображение: ЗагруженноеИзображение,
  прямоугольник: ПрямоугольникЭлемента,
): void {
  if (изображение.ширина <= 0 || изображение.высота <= 0) return
  const коэффициент = Math.min(
    прямоугольник.width / изображение.ширина,
    прямоугольник.height / изображение.высота,
  )
  const ширина = изображение.ширина * коэффициент
  const высота = изображение.высота * коэффициент
  const x = прямоугольник.left + (прямоугольник.width - ширина) / 2
  const y = прямоугольник.top + (прямоугольник.height - высота) / 2
  ctx.drawImage(изображение.источник, x, y, ширина, высота)
}

/**
 * Рисует образ на canvas и возвращает PNG.
 *
 * Элементы рисуются в порядке z-порядка; для каждой вещи берётся AI-версия,
 * если она есть, иначе Оригинал. Вещь без изображения просто пропускается.
 */
export async function renderOutfit(
  образ: Образ,
  вещи: readonly Вещь[],
  изображения: readonly Изображение[],
  options: ПараметрыРендера = {},
): Promise<Blob> {
  const width = Math.max(1, Math.round(options.width ?? COLLAGE_WIDTH))
  const height = Math.max(1, Math.round(options.height ?? COLLAGE_HEIGHT))
  const background = options.background ?? '#FFFFFF'

  const canvas = создатьХолст(width, height)
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('Canvas 2D недоступен')

  ctx.fillStyle = background
  ctx.fillRect(0, 0, width, height)

  const вещиПоИд = new Map(вещи.map((вещь) => [вещь.id, вещь]))
  const прямоугольники = layoutElements(образ.элементы, { width, height })

  for (const прямоугольник of прямоугольники) {
    const вещь = вещиПоИд.get(прямоугольник.idВещи)
    if (вещь === undefined) continue
    const изображение = preferredImage(вещь, изображения)
    if (изображение === undefined) continue

    let загруженное: ЗагруженноеИзображение | null = null
    try {
      загруженное = await загрузитьИзображение(изображение.blob)
      нарисоватьВписанное(ctx, загруженное, прямоугольник)
    } finally {
      загруженное?.освободить()
    }
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('Не удалось собрать коллаж'))
      else resolve(blob)
    }, 'image/png')
  })
}

/** Миниатюра образа для списка: та же композиция, большая сторона — `maxSide`. */
export async function renderOutfitCover(
  образ: Образ,
  вещи: readonly Вещь[],
  изображения: readonly Изображение[],
  options: ПараметрыРендера & { maxSide?: number } = {},
): Promise<Blob> {
  const { maxSide, ...остальные } = options
  const размер = coverSize(maxSide)
  return renderOutfit(образ, вещи, изображения, { ...остальные, ...размер })
}
