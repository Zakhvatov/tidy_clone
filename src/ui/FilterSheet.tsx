import { useEffect, useRef } from 'react'

import type { Season } from '../domain/types'
import { hasActiveFilter, type WardrobeFilter } from '../services/wardrobe-filter'
import styles from './FilterSheet.module.css'

interface FilterSheetProps {
  фильтр: WardrobeFilter
  верхние: readonly string[]
  подкатегории: readonly string[]
  цвета: readonly string[]
  сезоны: readonly Season[]
  onЗакрыть: () => void
  onСбросить: () => void
  onВерх: (значение: string) => void
  onПод: (значение: string) => void
  onЦвет: (значение: string) => void
  onСезон: (значение: Season) => void
}

function элементыФокуса(контейнер: HTMLElement): HTMLElement[] {
  return Array.from(
    контейнер.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
}

function ГруппаФильтров({
  название,
  значения,
  выбрано,
  onПереключить,
}: {
  название: string
  значения: readonly string[]
  выбрано: (значение: string) => boolean
  onПереключить: (значение: string) => void
}) {
  if (значения.length === 0) return null

  return (
    <div className={styles.group} role="group" aria-label={название}>
      <span className={styles.groupTitle}>{название}</span>
      <div className={styles.chips}>
        {значения.map((значение) => {
          const активен = выбрано(значение)
          return (
            <button
              key={значение}
              type="button"
              aria-pressed={активен}
              className={активен ? `${styles.chip} ${styles.chipActive}` : styles.chip}
              onClick={() => onПереключить(значение)}
            >
              {значение}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function FilterSheet({
  фильтр,
  верхние,
  подкатегории,
  цвета,
  сезоны,
  onЗакрыть,
  onСбросить,
  onВерх,
  onПод,
  onЦвет,
  onСезон,
}: FilterSheetProps) {
  const панельRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const предыдущий = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = предыдущий
    }
  }, [])

  useEffect(() => {
    панельRef.current?.focus()
  }, [])

  useEffect(() => {
    const панель = панельRef.current

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onЗакрыть()
        return
      }
      if (event.key !== 'Tab' || панель === null) return

      const доступные = элементыФокуса(панель)
      if (доступные.length === 0) {
        event.preventDefault()
        панель.focus()
        return
      }

      const первый = доступные[0]
      const последний = доступные[доступные.length - 1]
      const текущий = document.activeElement

      if (!панель.contains(текущий)) {
        event.preventDefault()
        первый.focus()
      } else if (event.shiftKey && (текущий === первый || текущий === панель)) {
        event.preventDefault()
        последний.focus()
      } else if (!event.shiftKey && текущий === последний) {
        event.preventDefault()
        первый.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onЗакрыть])

  const естьАктивные = hasActiveFilter(фильтр)

  return (
    <div
      className={styles.overlay}
      onClick={(event) => {
        if (event.target === event.currentTarget) onЗакрыть()
      }}
    >
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Фильтры"
        tabIndex={-1}
        ref={панельRef}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Фильтры</h2>
        </header>

        <div className={styles.body}>
          <ГруппаФильтров
            название="Верхние категории"
            значения={верхние}
            выбрано={(значение) => фильтр.top === значение}
            onПереключить={onВерх}
          />
          <ГруппаФильтров
            название="Подкатегории"
            значения={подкатегории}
            выбрано={(значение) => фильтр.sub === значение}
            onПереключить={onПод}
          />
          <ГруппаФильтров
            название="Цвета"
            значения={цвета}
            выбрано={(значение) => (фильтр.цвета ?? []).includes(значение)}
            onПереключить={onЦвет}
          />
          <ГруппаФильтров
            название="Сезоны"
            значения={сезоны}
            выбрано={(значение) => (фильтр.сезоны ?? []).includes(значение as Season)}
            onПереключить={(значение) => onСезон(значение as Season)}
          />
        </div>

        <footer className={styles.footer}>
          <button
            type="button"
            className={styles.reset}
            onClick={onСбросить}
            disabled={!естьАктивные}
          >
            Сбросить
          </button>
          <button type="button" className={styles.done} onClick={onЗакрыть}>
            Готово
          </button>
        </footer>
      </div>
    </div>
  )
}
