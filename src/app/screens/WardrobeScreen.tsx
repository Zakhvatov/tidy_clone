import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import {
  groupByTopCategory,
  loadWardrobe,
  preferredImage,
  type WardrobeSection,
} from '../../services/wardrobe'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { DigitizePanel } from '../../ui/DigitizePanel'
import { ItemImage } from '../../ui/ItemImage'
import screenStyles from './Screen.module.css'
import styles from './WardrobeScreen.module.css'

type Состояние = 'загрузка' | 'готово' | 'ошибка'

const ТЕКСТ_ОШИБКИ = 'Не удалось прочитать гардероб. Попробуйте ещё раз'

/** Скелетоны секций, пока IndexedDB отдаёт данные. */
function WardrobeSkeleton() {
  return (
    <div className={styles.skeleton} role="status" aria-live="polite">
      <span className={styles.skeletonHeader} aria-hidden="true" />
      <div className={styles.skeletonGrid} aria-hidden="true">
        {[0, 1, 2, 3].map((key) => (
          <span key={key} className={styles.skeletonCard} />
        ))}
      </div>
      <span className={styles.count}>Загружаем гардероб…</span>
    </div>
  )
}

/**
 * Экран гардероба (T13): вещи секциями по верхним категориям ADR-0004.
 *
 * Изображение карточки берётся правилом «Решения» — AI-версия, иначе Оригинал;
 * пометки об AI в сетке нет (она живёт только в карточке вещи — T15). Клик по
 * карточке пока ведёт на `/`: сама карточка вещи появится в T15.
 */
export function WardrobeScreen() {
  const navigate = useNavigate()
  const [состояние, setСостояние] = useState<Состояние>('загрузка')
  const [секции, setСекции] = useState<WardrobeSection[]>([])
  const [ошибка, setОшибка] = useState<string | null>(ТЕКСТ_ОШИБКИ)
  // Счётчик попыток: кнопка «Повторить» перезапускает чтение, не перезагружая экран.
  const [попытка, setПопытка] = useState(0)

  useEffect(() => {
    let активен = true
    setСостояние('загрузка')
    setОшибка(null)

    void loadWardrobe()
      .then((данные) => {
        if (!активен) return
        setСекции(groupByTopCategory(данные))
        setСостояние('готово')
      })
      .catch(() => {
        if (!активен) return
        setСекции([])
        setОшибка(ТЕКСТ_ОШИБКИ)
        setСостояние('ошибка')
      })

    return () => {
      активен = false
    }
  }, [попытка])

  const повторить = () => setПопытка((текущая) => текущая + 1)

  return (
    <section className={screenStyles.screen}>
      <h1 className={screenStyles.title}>Гардероб</h1>

      {состояние === 'готово' && секции.length > 0 && <DigitizePanel />}

      {состояние === 'загрузка' && <WardrobeSkeleton />}

      {состояние === 'ошибка' && (
        <ErrorNotice message={ошибка ?? ТЕКСТ_ОШИБКИ} onRetry={повторить} />
      )}

      {состояние === 'готово' && секции.length === 0 && (
        <div className={styles.empty}>
          <p className={screenStyles.placeholderText}>Гардероб пуст</p>
          <button
            className={`${screenStyles.button} ${styles.emptyButton}`}
            type="button"
            onClick={() => navigate('/add')}
          >
            Добавить вещь
          </button>
        </div>
      )}

      {состояние === 'готово' &&
        секции.map((секция) => (
          <section key={секция.категория} className={styles.section} aria-label={секция.категория}>
            <header className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>{секция.категория}</h2>
              <span className={styles.count}>{секция.количество}</span>
            </header>
            <ul className={styles.grid}>
              {секция.вещи.map((entry) => {
                const название = entry.вещь.название.trim() === '' ? 'Без названия' : entry.вещь.название
                const изображение = preferredImage(entry.вещь, entry.изображения)
                return (
                  <li key={entry.вещь.id}>
                    <button
                      className={styles.card}
                      type="button"
                      onClick={() => navigate('/')}
                      aria-label={название}
                    >
                      <ItemImage blob={изображение?.blob} alt={название} />
                      <span className={styles.cardName}>{название}</span>
                      <span className={styles.cardSub}>{entry.вещь.подкатегория}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
    </section>
  )
}
