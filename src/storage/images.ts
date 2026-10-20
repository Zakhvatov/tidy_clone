/**
 * Репозиторий изображений.
 *
 * Инвариант из ADR-0002: оригинал неизменяем. Здесь нет ни метода перезаписи,
 * ни общего метода удаления роли `оригинал`; изображения добавляются через `add`
 * (а не `put`), поэтому повторный `id` не затирает существующую запись.
 *
 * Единственное исключение — {@link removeUploadedOriginal} (ADR-0006): удаление
 * загруженного снимка после успешной генерации. Оригинал с маркетплейса и
 * оригинал безусловно остаются; в целом Оригинал исчезает и каскадом вместе со
 * своей вещью (`items.remove`).
 */

import type { ImageRole, Изображение } from '../domain/types'
import { getDb } from './db'
import { ОшибкаОригиналНеизменяем, ОшибкаХранилища } from './errors'

function assertRole(изображение: Изображение, роль: ImageRole): void {
  if (изображение.роль !== роль) {
    throw new ОшибкаХранилища(
      `Ожидалось изображение с ролью «${роль}», а получено «${изображение.роль}»`,
    )
  }
}

/** Сохраняет оригинал. Существующий оригинал с тем же `id` перезаписать нельзя. */
export async function addOriginal(изображение: Изображение): Promise<Изображение> {
  assertRole(изображение, 'оригинал')
  const db = await getDb()
  await db.add('images', изображение)
  return изображение
}

/** Сохраняет AI-версию. */
export async function addAiVersion(изображение: Изображение): Promise<Изображение> {
  assertRole(изображение, 'ai')
  const db = await getDb()
  await db.add('images', изображение)
  return изображение
}

/** Сохраняет точный вырез пакшота. */
export async function addCutout(изображение: Изображение): Promise<Изображение> {
  assertRole(изображение, 'вырез')
  const db = await getDb()
  await db.add('images', изображение)
  return изображение
}

/** Изображения вещи в порядке добавления. */
export async function listByItem(idВещи: string): Promise<Изображение[]> {
  const db = await getDb()
  const images = await db.getAllFromIndex('images', 'byВещь', idВещи)
  return images.sort((a, b) => a.датаСоздания.localeCompare(b.датаСоздания))
}

/**
 * Удаляет загруженный Оригинал-снимок — сознательное исключение из правила
 * «оригинал неизменяем» (ADR-0006 §4). Снимок был сырьём для оцифровки: после
 * успешной генерации в галерее остаётся одна AI-версия, а референсом следующей
 * перегенерации служит она сама.
 *
 * Вызывающий код обязан проверять `вещь.источник === 'фото'`: для
 * маркетплейсовых Оригиналов правило продолжает действовать. Роль внутри
 * проверяется всё равно — метод умеет удалять только оригинал.
 */
export async function removeUploadedOriginal(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('images', 'readwrite')
  const store = tx.objectStore('images')
  const изображение = await store.get(id)
  if (изображение === undefined) {
    await tx.done
    throw new ОшибкаХранилища(`Изображение «${id}» не найдено`)
  }
  if (изображение.роль !== 'оригинал') {
    tx.abort()
    await tx.done.catch(() => undefined)
    throw new ОшибкаХранилища(
      `removeUploadedOriginal ожидает оригинал, а пришла роль «${изображение.роль}»`,
    )
  }
  await store.delete(id)
  await tx.done
}

export async function get(id: string): Promise<Изображение | undefined> {
  const db = await getDb()
  return db.get('images', id)
}

/**
 * Удаляет производное изображение (`ai` или `вырез`).
 * Попытка удалить оригинал возвращает `ОшибкаОригиналНеизменяем`.
 */
export async function removeNonOriginal(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('images', 'readwrite')
  const store = tx.objectStore('images')
  const изображение = await store.get(id)
  if (изображение === undefined) {
    await tx.done
    throw new ОшибкаХранилища(`Изображение «${id}» не найдено`)
  }
  if (изображение.роль === 'оригинал') {
    tx.abort()
    await tx.done.catch(() => undefined)
    throw new ОшибкаОригиналНеизменяем(
      `Оригинал «${id}» удалить нельзя: он остаётся навсегда`,
    )
  }
  await store.delete(id)
  await tx.done
}
