import type { GenerationModel } from '../services/generation-models'
import styles from './GenerationModelPicker.module.css'

interface GenerationModelPickerProps {
  models: readonly GenerationModel[]
  /** Slug выбранной модели. */
  value: string
  onChange: (slug: string) => void
}

/**
 * Выбор модели генерации с ценой за кадр. Нативный radio внутри подписанной
 * строки: работает с клавиатуры и скринридером без самодельных ролей.
 */
export function GenerationModelPicker({ models, value, onChange }: GenerationModelPickerProps) {
  return (
    <fieldset className={styles.picker}>
      <legend className={styles.legend}>Модель</legend>
      <div className={styles.options}>
        {models.map((model) => {
          const active = model.slug === value
          return (
            <label
              key={model.slug}
              className={active ? `${styles.option} ${styles.optionActive}` : styles.option}
            >
              <input
                className={styles.radio}
                type="radio"
                name="generation-model"
                value={model.slug}
                checked={active}
                onChange={() => onChange(model.slug)}
              />
              <span className={styles.name}>{model.title}</span>
              <span className={styles.price}>{model.priceRub} ₽</span>
            </label>
          )
        })}
      </div>
      <p className={styles.hint}>Цена за кадр 1:1, 1K. Списывается с баланса сервиса.</p>
    </fieldset>
  )
}
