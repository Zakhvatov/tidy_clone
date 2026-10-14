import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type { Вещь } from '../domain/types'
import { groupByTopCategory, preferredImage, type WardrobeEntry } from '../services/wardrobe'
import { ItemImage } from './ItemImage'
import styles from './OutfitPicker.module.css'

interface OutfitPickerProps {
  /** Вещи гардероба с изображениями — как их отдаёт `loadWardrobe()`. */
  entries: readonly WardrobeEntry[]
  /** id вещей, уже добавленных в коллаж. */
  выбранные: readonly string[]
  /** Добавить вещь в образ одним нажатием. */
  onAdd: (вещь: Вещь) => void
}

/** Чип «Все подкатегории» внутри выбранной верхней категории. */
const ВСЕ = 'Все'

/**
 * Пикер вещей для коллажа (T17): табы верхних категорий, чипы подкатегорий и
 * лента вещей. Вещь добавляется в образ одним нажатием.
 *
 * Категории берутся из `groupByTopCategory()`, поэтому пустых табов не бывает.
 * Изображение в ленте — по правилу «Решения»: AI-версия, если есть, иначе
 * Оригинал; пометок об AI здесь нет, как и в сетке гардероба.
 */
export function OutfitPicker({ entries, выбранные, onAdd }: OutfitPickerProps) {
  const секции = useMemo(() => groupByTopCategory(entries), [entries])
  const [активныйВерх, setАктивныйВерх] = useState<string | null>(null)
  const [активнаяПод, setАктивнаяПод] = useState<string>(ВСЕ)

  if (секции.length === 0) {
    return (
      <section className={styles.picker} aria-label="Выбор вещей">
        <h2 className={styles.title}>Вещи</h2>
        <div className={styles.empty}>
          <p className={styles.emptyText}>В гардеробе пока нет вещей</p>
          <Link className={styles.emptyLink} to="/add">
            Добавить вещь
          </Link>
        </div>
      </section>
    )
  }

  const текущая = секции.find((секция) => секция.категория === активныйВерх) ?? секции[0]
  const подкатегории = [ВСЕ, ...new Set(текущая.вещи.map((entry) => entry.вещь.подкатегория))]
  const под = подкатегории.includes(активнаяПод) ? активнаяПод : ВСЕ
  const лента =
    под === ВСЕ
      ? текущая.вещи
      : текущая.вещи.filter((entry) => entry.вещь.подкатегория === под)

  return (
    <section className={styles.picker} aria-label="Выбор вещей">
      <h2 className={styles.title}>Вещи</h2>

      <div className={styles.tabs} role="tablist" aria-label="Категории">
        {секции.map((секция) => {
          const активна = секция.категория === текущая.категория
          return (
            <button
              key={секция.категория}
              type="button"
              role="tab"
              aria-selected={активна}
              className={активна ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => {
                setАктивныйВерх(секция.категория)
                setАктивнаяПод(ВСЕ)
              }}
            >
              {секция.категория}
              <span className={styles.tabCount}>{секция.количество}</span>
            </button>
          )
        })}
      </div>

      <div className={styles.chips} role="group" aria-label="Подкатегории">
        {подкатегории.map((значение) => (
          <button
            key={значение}
            type="button"
            aria-pressed={значение === под}
            className={значение === под ? `${styles.chip} ${styles.chipActive}` : styles.chip}
            onClick={() => setАктивнаяПод(значение)}
          >
            {значение}
          </button>
        ))}
      </div>

      <ul className={styles.strip}>
        {лента.map((entry) => {
          const название =
            entry.вещь.название.trim() === '' ? 'Без названия' : entry.вещь.название
          const изображение = preferredImage(entry.вещь, entry.изображения)
          const добавлена = выбранные.includes(entry.вещь.id)
          return (
            <li key={entry.вещь.id} className={styles.stripItem}>
              <button
                type="button"
                className={добавлена ? `${styles.item} ${styles.itemChosen}` : styles.item}
                aria-label={`Добавить ${название}`}
                aria-pressed={добавлена}
                onClick={() => onAdd(entry.вещь)}
              >
                <div className={styles.itemImage}>
                  <ItemImage blob={изображение?.blob} alt={название} />
                </div>
                <span className={styles.itemName}>{название}</span>
                {добавлена && <span className={styles.itemBadge}>В образе</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
