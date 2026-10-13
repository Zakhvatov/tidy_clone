/**
 * Чтение гардероба для сетки (T13).
 *
 * Модуль отвечает на три вопроса экрана:
 *   1. `loadWardrobe()` — что лежит в устройстве: вещи и их изображения.
 *   2. `preferredImage()` — какое изображение показать в сетке.
 *   3. `groupByTopCategory()` — как разложить вещи по секциям-полкам.
 *
 * Правило изображения — из раздела «Решения» тикета: в сетке показывается
 * **AI-версия, если она есть, иначе Оригинал**. Вырез пакшота в сетку не попадает,
 * он нужен коллажу. Пометки об AI в сетке нет: сетка выглядит чисто.
 *
 * Сеть и React здесь отсутствуют. Чтение идёт через `src/storage/*` одним
 * IndexedDB-проходом (`loadWardrobe`): вещи и изображения берутся в одной
 * транзакции, связь строится один раз, лишних обходов нет.
 */

import { FALLBACK_TOP, topCategories } from '../domain/taxonomy'
import type { Изображение, Вещь } from '../domain/types'
import { getDb } from '../storage/db'

/** Вещь вместе с её изображениями — то, что нужно карточке сетки. */
export interface WardrobeEntry {
  вещь: Вещь
  изображения: Изображение[]
}

/** Секция-полка: верхняя категория ADR-0004 и её вещи. */
export interface WardrobeSection {
  категория: string
  вещи: WardrobeEntry[]
  количество: number
}

/**
 * Читает все вещи и изображения одним проходом.
 *
 * Одна readonly-транзакция на оба стора: параллельные `getAll` держат её живой,
 * затем изображения раскладываются по вещам через `Map` — это один линейный
 * проход, а не поиск по массиву на каждую вещь.
 */
export async function loadWardrobe(): Promise<WardrobeEntry[]> {
  const db = await getDb()
  const tx = db.transaction(['items', 'images'], 'readonly')
  const [вещи, изображения] = await Promise.all([
    tx.objectStore('items').getAll(),
    tx.objectStore('images').getAll(),
  ])
  await tx.done

  const поВещиId = new Map<string, Изображение[]>()
  for (const изображение of изображения) {
    const список = поВещиId.get(изображение.idВещи)
    if (список === undefined) {
      поВещиId.set(изображение.idВещи, [изображение])
    } else {
      список.push(изображение)
    }
  }

  return вещи.map((вещь) => ({
    вещь,
    изображения: поВещиId.get(вещь.id) ?? [],
  }))
}

function поУбываниюДаты(a: Изображение, b: Изображение): number {
  return b.датаСоздания.localeCompare(a.датаСоздания)
}

/**
 * Изображение для сетки по правилу «Решения»: AI-версия, иначе Оригинал.
 *
 * Если AI-версий несколько, берётся самая новая; среди оригиналов — самый
 * ранний (оригинал неизменяем, поэтому он обычно один). Ничего не найдено —
 * `undefined`, карточка покажет подложку без картинки.
 */
export function preferredImage(
  вещь: Вещь,
  изображения: readonly Изображение[],
): Изображение | undefined {
  const свои = изображения.filter((изображение) => изображение.idВещи === вещь.id)

  const ai = свои.filter((изображение) => изображение.роль === 'ai').sort(поУбываниюДаты)[0]
  if (ai !== undefined) return ai

  return свои
    .filter((изображение) => изображение.роль === 'оригинал')
    .sort((a, b) => a.датаСоздания.localeCompare(b.датаСоздания))[0]
}

/** Внутри секции новые вещи идут первыми; при равной дате — устойчиво по `id`. */
function поУбываниюДатыСоздания(a: WardrobeEntry, b: WardrobeEntry): number {
  const поДате = b.вещь.датаСоздания.localeCompare(a.вещь.датаСоздания)
  if (поДате !== 0) return поДате
  return a.вещь.id.localeCompare(b.вещь.id)
}

/**
 * Раскладывает вещи по верхним категориям.
 *
 * Порядок секций берётся из `topCategories()` — это порядок ADR-0004, а «Разное»
 * идёт последней секцией. Вещь с неизвестной категорией не теряется и попадает
 * в «Разное». Пустые секции не показываются: сетка не должна состоять из заголовков
 * без вещей.
 */
export function groupByTopCategory(entries: readonly WardrobeEntry[]): WardrobeSection[] {
  const порядок = topCategories()
  const известные = new Set(порядок)
  const поКатегории = new Map<string, WardrobeEntry[]>()

  for (const entry of entries) {
    const категория = известные.has(entry.вещь.категория) ? entry.вещь.категория : FALLBACK_TOP
    const список = поКатегории.get(категория)
    if (список === undefined) {
      поКатегории.set(категория, [entry])
    } else {
      список.push(entry)
    }
  }

  const секции: WardrobeSection[] = []
  for (const категория of порядок) {
    const вещи = поКатегории.get(категория)
    if (вещи === undefined || вещи.length === 0) continue
    const отсортированные = [...вещи].sort(поУбываниюДатыСоздания)
    секции.push({ категория, вещи: отсортированные, количество: отсортированные.length })
  }
  return секции
}
