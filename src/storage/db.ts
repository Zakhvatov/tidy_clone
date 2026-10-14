import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
} from 'idb'

import type { Изображение, Образ, Вещь } from '../domain/types'
import type { СостояниеОчереди } from './queue'

/** Имя базы на устройстве. */
export const DB_NAME = 'wardrobe'

/** Текущая версия схемы. Версия увеличивается вместе с новой веткой миграции. */
export const DB_VERSION = 2

/** Схема базы: сторы `items`, `images`, `outfits`, `queue` и их индексы. */
export interface WardrobeDB extends DBSchema {
  items: {
    key: string
    value: Вещь
    indexes: {
      byКатегория: string
      byДатаСоздания: string
    }
  }
  images: {
    key: string
    value: Изображение
    indexes: {
      byВещь: string
    }
  }
  outfits: {
    key: string
    value: Образ
    indexes: {
      byСезон: string
      byДатаСоздания: string
    }
  }
  /**
   * Персистентное состояние очереди оцифровки (T12). Добавлен в версии 2;
   * на версии 1 стора не было, данные `items`/`images`/`outfits` не меняются.
   */
  queue: {
    key: string
    value: СостояниеОчереди
  }
}

/** Схема версии 1. Вынесена, чтобы `upgrade` читался как список шагов. */
function createSchemaV1(db: IDBPDatabase<WardrobeDB>): void {
  const items = db.createObjectStore('items', { keyPath: 'id' })
  items.createIndex('byКатегория', 'категория')
  items.createIndex('byДатаСоздания', 'датаСоздания')

  const images = db.createObjectStore('images', { keyPath: 'id' })
  images.createIndex('byВещь', 'idВещи')

  const outfits = db.createObjectStore('outfits', { keyPath: 'id' })
  outfits.createIndex('byСезон', 'сезон')
  outfits.createIndex('byДатаСоздания', 'датаСоздания')
}

/**
 * Схема версии 2: добавляется стор `queue` (очередь оцифровки, T12).
 * Существующие сторы не пересоздаются — миграция только дополняет схему.
 */
function createSchemaV2(db: IDBPDatabase<WardrobeDB>): void {
  if (db.objectStoreNames.contains('queue')) return
  db.createObjectStore('queue', { keyPath: 'id' })
}

/**
 * Каркас миграций: применяем по одному шагу на каждую версию.
 *
 * Новая версия добавляется одной ветвью `switch` (`case 1`, `case 2`, …) —
 * прошлые шаги не переписываются, данные не теряются. `newVersion` берётся из
 * вызова `openDB`, поэтому функцию можно переиспользовать в тестах схемы.
 */
export function upgrade(
  db: IDBPDatabase<WardrobeDB>,
  oldVersion: number,
  newVersion: number | null,
): void {
  const targetVersion = newVersion ?? DB_VERSION
  for (let version = oldVersion; version < targetVersion; version += 1) {
    switch (version) {
      case 0:
        createSchemaV1(db)
        break
      case 1:
        createSchemaV2(db)
        break
      default:
        // Шага для этой версии ещё нет — значит, миграции не требуется.
        break
    }
  }
}

let dbPromise: Promise<IDBPDatabase<WardrobeDB>> | null = null

/** Синглтон-соединение с базой: одно на всё приложение. */
export function getDb(): Promise<IDBPDatabase<WardrobeDB>> {
  if (dbPromise === null) {
    dbPromise = openDB<WardrobeDB>(DB_NAME, DB_VERSION, { upgrade })
  }
  return dbPromise
}

/** Закрывает соединение и сбрасывает синглтон. Нужно тестам. */
export async function closeDb(): Promise<void> {
  const pending = dbPromise
  dbPromise = null
  if (pending === null) return
  const db = await pending.catch(() => null)
  db?.close()
}
