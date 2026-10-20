import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
} from 'idb'

import type { Изображение, Образ, Вещь } from '../domain/types'
import type { ЗадачаГенерации } from './jobs'

/** Имя базы на устройстве. */
export const DB_NAME = 'wardrobe'

/** Текущая версия схемы. Версия увеличивается вместе с новой веткой миграции. */
export const DB_VERSION = 4

/** Схема базы: сторы `items`, `images`, `outfits` и `jobs`. */
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
   * Задачи асинхронной генерации AI-версии (ADR-0006). Добавлен в версии 3;
   * хранит `Idempotency-Key` и `taskId` провайдера, чтобы закрытие вкладки не
   * теряло ни оплаченную задачу, ни деньги.
   */
  jobs: {
    key: string
    value: ЗадачаГенерации
  }
}

/** Схема версии 1. Вынесена, чтобы `upgrade` читался как список шагов. */
function createSchemaV1(db: IDBPDatabase): void {
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
function createSchemaV2(db: IDBPDatabase): void {
  if (db.objectStoreNames.contains('queue')) return
  db.createObjectStore('queue', { keyPath: 'id' })
}

/**
 * Схема версии 3: добавляется стор `jobs` (задачи асинхронной генерации,
 * ADR-0006). Существующие сторы не пересоздаются — миграция только дополняет.
 */
function createSchemaV3(db: IDBPDatabase): void {
  if (db.objectStoreNames.contains('jobs')) return
  db.createObjectStore('jobs', { keyPath: 'id' })
}

/**
 * Схема версии 4: стор `queue` удаляется — массовой оцифровки в гардеробе
 * больше нет (D16). Данные гардероба (`items`/`images`/`outfits`) и задачи
 * генерации (`jobs`) не затрагиваются; очередь была служебной и одноразовой.
 */
function dropQueueV4(db: IDBPDatabase): void {
  if (db.objectStoreNames.contains('queue')) db.deleteObjectStore('queue')
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
  // Шаги миграции работают на «сырой» схеме: старые версии содержат сторы,
  // которых больше нет в текущем `WardrobeDB` (например, удалённый `queue`).
  const migrationDb = db as unknown as IDBPDatabase
  const targetVersion = newVersion ?? DB_VERSION
  for (let version = oldVersion; version < targetVersion; version += 1) {
    switch (version) {
      case 0:
        createSchemaV1(migrationDb)
        break
      case 1:
        createSchemaV2(migrationDb)
        break
      case 2:
        createSchemaV3(migrationDb)
        break
      case 3:
        dropQueueV4(migrationDb)
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
