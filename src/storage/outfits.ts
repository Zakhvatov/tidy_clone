/**
 * Репозиторий образов. Только домен и IndexedDB — ни React, ни сети.
 */

import type { Season, Образ } from '../domain/types'
import { getDb } from './db'
import { ОшибкаХранилища } from './errors'

/** Что можно изменить в образе: `id` и `датаСоздания` неизменяемы. */
export type ОбразPatch = Partial<Omit<Образ, 'id' | 'датаСоздания'>>

export async function create(образ: Образ): Promise<Образ> {
  const db = await getDb()
  await db.add('outfits', образ)
  return образ
}

export async function get(id: string): Promise<Образ | undefined> {
  const db = await getDb()
  return db.get('outfits', id)
}

export async function list(): Promise<Образ[]> {
  const db = await getDb()
  return db.getAll('outfits')
}

/** Частично обновляет образ: название, сезон, элементы, обложку. */
export async function update(id: string, patch: ОбразPatch): Promise<Образ> {
  const db = await getDb()
  const tx = db.transaction('outfits', 'readwrite')
  const store = tx.objectStore('outfits')
  const current = await store.get(id)
  if (current === undefined) {
    await tx.done
    throw new ОшибкаХранилища(`Образ «${id}» не найден`)
  }
  const updated: Образ = { ...current, ...patch, id: current.id }
  await store.put(updated)
  await tx.done
  return updated
}

export async function remove(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('outfits', id)
}

/** Образы одного сезона — через индекс `byСезон`. */
export async function listBySeason(сезон: Season): Promise<Образ[]> {
  const db = await getDb()
  return db.getAllFromIndex('outfits', 'byСезон', сезон)
}
