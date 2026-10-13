import { FALLBACK_SUB, subcategoriesOf, topCategories } from '../domain/taxonomy'
import styles from './CategoryPicker.module.css'

interface CategoryPickerProps {
  категория: string
  подкатегория: string
  /** Категория определена неуверенно — предложить выбрать вручную, не блокируя сохранение. */
  needsReview: boolean
  onChange: (категория: string, подкатегория: string) => void
}

function optionsOf(values: readonly string[], current: string): readonly string[] {
  return values.includes(current) ? values : [current, ...values]
}

/**
 * Правка категории вещи двумя селектами из таксономии ADR-0004: верхний уровень
 * задаёт полку гардероба, нижний — подкатегорию. Если словарь или vision дали
 * «Разное» (`needsReview`), показываем подсказку, но сохранение не блокируем.
 */
export function CategoryPicker({ категория, подкатегория, needsReview, onChange }: CategoryPickerProps) {
  const tops = optionsOf(topCategories(), категория)
  const knownSubs = subcategoriesOf(категория)
  const subs = optionsOf(knownSubs.length > 0 ? knownSubs : [FALLBACK_SUB], подкатегория)

  return (
    <div className={styles.picker}>
      <p className={styles.label}>Категория</p>
      <div className={styles.selects}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Раздел</span>
          <select
            className={styles.select}
            value={категория}
            onChange={(event) => {
              const top = event.target.value
              const firstSub = subcategoriesOf(top)[0] ?? FALLBACK_SUB
              onChange(top, firstSub)
            }}
          >
            {tops.map((top) => (
              <option key={top} value={top}>
                {top}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Подкатегория</span>
          <select
            className={styles.select}
            value={подкатегория}
            onChange={(event) => onChange(категория, event.target.value)}
          >
            {subs.map((sub) => (
              <option key={sub} value={sub}>
                {sub}
              </option>
            ))}
          </select>
        </label>
      </div>
      {needsReview && (
        <p className={styles.hint} role="status">
          Категория определена неточно — выберите вручную. Это не помешает сохранить вещь.
        </p>
      )}
    </div>
  )
}
