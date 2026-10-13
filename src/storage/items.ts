/**
 * Репозиторий вещей. Только домен и IndexedDB — ни React, ни сети.
 */

import type { Вещь } from '../domain/types'
import { getDb } from './db'
import { ОшибкаВещьВОбразе, ОшибкаХранилища } from './errors'

/** Что можно изменить в вещи: `id`, даты и создание менять нельзя. */
export type ВещьPatch = Partial<Omit<Вещь, 'id' | 'датаСоздания' | 'датаОбновления'>>

/** Сохраняет готовую вещь. Повторная запись с тем же `id` не перезаписывает её. */
export async function create(вещь: Вещь): Promise<Вещь> {
  const db = await getDb()
  await db.add('items', вещь)
  return вещь
}

export async function get(id: string): Promise<Вещь | undefined> {
  const db = await getDb()
  return db.get('items', id)
}

export async function list(): Promise<Вещь[]> {
  const db = await getDb()
  return db.getAll('items')
}

/** Частично обновляет вещь и проставляет `датаОбновления`. */
export async function update(id: string, patch: ВещьPatch): Promise<Вещь> {
  const db = await getDb()
  const tx = db.transaction('items', 'readwrite')
  const store = tx.objectStore('items')
  const current = await store.get(id)
  if (current === undefined) {
    await tx.done
    throw new ОшибкаХранилища(`Вещь «${id}» не найдена`)
  }
  const updated: Вещь = {
    ...current,
    ...patch,
    id: current.id,
    датаСоздания: current.датаСоздания,
    датаОбновления: new Date().toISOString(),
  }
  await store.put(updated)
  await tx.done
  return updated
}

/**
 * Удаляет вещь вместе с её изображениями.
 *
 * Вещь, входящую в сохранённый образ, удалять нельзя: сначала нужно убрать её
 * из образа. Ошибка — `ОшибкаВещьВОбразе` с названием образа.
 */
export async function remove(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['items', 'images', 'outfits'], 'readwrite')

  const outfits = await tx.objectStore('outfits').getAll()
  const usingOutfit = outfits.find((образ) =>
    образ.элементы.some((элемент) => элемент.idВещи === id),
  )
  if (usingOutfit !== undefined) {
    tx.abort()
    await tx.done.catch(() => undefined)
    throw new ОшибкаВещьВОбразе(
      `Вещь «${id}» входит в образ «${usingOutfit.название}»: сначала уберите её из образа`,
    )
  }

  await tx.objectStore('items').delete(id)

  const images = tx.objectStore('images')
  const imageIds = await images.index('byВещь').getAllKeys(id)
  for (const imageId of imageIds) {
    await images.delete(imageId)
  }

  await tx.done
}

export async function count(): Promise<number> {
  const db = await getDb()
  return db.count('items')
}
