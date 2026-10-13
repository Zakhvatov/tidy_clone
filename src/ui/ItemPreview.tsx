import type { ItemDraft } from '../services/import-item'
import { CategoryPicker } from './CategoryPicker'
import { PhotoPreview } from './PhotoPreview'
import styles from './ItemPreview.module.css'

interface ItemPreviewProps {
  черновик: ItemDraft
  onChangeCategory: (категория: string, подкатегория: string) => void
  onSave: () => void
  saving: boolean
}

function AttrRow({ label, values }: { label: string; values: readonly string[] }) {
  if (values.length === 0) return null
  return (
    <div className={styles.attr}>
      <span className={styles.attrLabel}>{label}</span>
      <span className={styles.attrValue}>{values.join(', ')}</span>
    </div>
  )
}

/**
 * Превью вещи перед сохранением: фото (будущий Оригинал), атрибуты из карточки
 * и правка категории. Ни одно поле не обязательно — сохранить можно сразу.
 */
export function ItemPreview({ черновик, onChangeCategory, onSave, saving }: ItemPreviewProps) {
  const название = черновик.название.trim() === '' ? 'Без названия' : черновик.название.trim()
  const packshotNote =
    черновик.packshot === undefined ? null : черновик.packshot ? 'пакшот: да' : 'пакшот: нет'

  return (
    <article className={styles.card}>
      <PhotoPreview blob={черновик.фото} alt={название} />

      <div className={styles.body}>
        <header className={styles.header}>
          <h2 className={styles.name}>{название}</h2>
          {packshotNote !== null && <span className={styles.badge}>{packshotNote}</span>}
        </header>

        <div className={styles.attrs}>
          {черновик.бренд.trim() !== '' && (
            <div className={styles.attr}>
              <span className={styles.attrLabel}>Бренд</span>
              <span className={styles.attrValue}>{черновик.бренд}</span>
            </div>
          )}
          <AttrRow label="Цвета" values={черновик.цвета} />
          <AttrRow label="Состав" values={черновик.состав} />
        </div>

        <CategoryPicker
          категория={черновик.категория}
          подкатегория={черновик.подкатегория}
          needsReview={черновик.needsReview}
          onChange={onChangeCategory}
        />

        <button className={styles.save} type="button" onClick={onSave} disabled={saving}>
          {saving ? 'Сохраняем…' : 'Добавить в гардероб'}
        </button>
      </div>
    </article>
  )
}
