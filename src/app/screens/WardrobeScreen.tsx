import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { Season } from '../../domain/types'
import {
  availableColors,
  availableSeasons,
  availableSubcategories,
  filterAndSearch,
  hasActiveFilter,
  type WardrobeFilter,
} from '../../services/wardrobe-filter'
import { appDigitizeQueue } from '../../services/digitize-queue'
import {
  groupByTopCategory,
  loadWardrobe,
  preferredImage,
  type WardrobeEntry,
} from '../../services/wardrobe'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { DigitizePanel } from '../../ui/DigitizePanel'
import { ItemImage } from '../../ui/ItemImage'
import { AddItemForm } from './AddItemForm'
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

/** Чип фильтра: активный залит терракотовым акцентом (ADR-0005). */
function ФильтрЧип({
  активно,
  onToggle,
  children,
}: {
  активно: boolean
  onToggle: () => void
  children: string
}) {
  return (
    <button
      type="button"
      aria-pressed={активно}
      className={активно ? `${styles.chip} ${styles.chipActive}` : styles.chip}
      onClick={onToggle}
    >
      {children}
    </button>
  )
}

/** Карточка вещи сетки: изображение по правилу «Решения» и подпись. */
function КарточкаВещи({ entry, onOpen }: { entry: WardrobeEntry; onOpen: () => void }) {
  const название =
    entry.вещь.название.trim() === '' ? 'Без названия' : entry.вещь.название
  const изображение = preferredImage(entry.вещь, entry.изображения)
  return (
    <li>
      <button className={styles.card} type="button" onClick={onOpen} aria-label={название}>
        <ItemImage blob={изображение?.blob} alt={название} />
        <span className={styles.cardName}>{название}</span>
        <span className={styles.cardSub}>{entry.вещь.подкатегория}</span>
      </button>
    </li>
  )
}

/**
 * Экран гардероба (T13 + T14): вещи секциями по верхним категориям ADR-0004,
 * поиск по названию и фильтры по категории, подкатегории, цвету и сезону.
 *
 * Данные читаются из IndexedDB **один раз** при монтировании (и по «Повторить»
 * при ошибке). Поиск и фильтры работают в памяти: ввод в поле не перечитывает
 * хранилище — это проверяется тестом.
 *
 * Исключение — массовая оцифровка (T12): после успешной оцифровки вещи сетку
 * нужно перечитать, иначе в ней останутся старые Оригиналы, а пользователь
 * ждёт именно новые вырезы/AI-версии. Очередь сообщает об этом событием
 * `onDigitized`, а экран тихо подменяет записи без скелетона и без пропажи панели.
 *
 * Поведение секций: пока фильтр пуст, сохраняются полки T13. Как только задан
 * фильтр или запрос, показывается плоский результат со счётчиком «Найдено N»:
 * после сужения полки теряют смысл, а счётчик отвечает на вопрос «сколько нашлось».
 *
 * Бренд и цена в фильтрах отсутствуют — решение T14.
 */
export function WardrobeScreen() {
  const navigate = useNavigate()
  const [состояние, setСостояние] = useState<Состояние>('загрузка')
  const [записи, setЗаписи] = useState<WardrobeEntry[]>([])
  const [ошибка, setОшибка] = useState<string | null>(ТЕКСТ_ОШИБКИ)
  // Счётчик попыток: кнопка «Повторить» перезапускает чтение, не перезагружая экран.
  const [попытка, setПопытка] = useState(0)

  const [запрос, setЗапрос] = useState('')
  const [фильтр, setФильтр] = useState<WardrobeFilter>({})

  useEffect(() => {
    let активен = true
    setСостояние('загрузка')
    setОшибка(null)

    void loadWardrobe()
      .then((данные) => {
        if (!активен) return
        setЗаписи(данные)
        setСостояние('готово')
      })
      .catch(() => {
        if (!активен) return
        setЗаписи([])
        setОшибка(ТЕКСТ_ОШИБКИ)
        setСостояние('ошибка')
      })

    return () => {
      активен = false
    }
  }, [попытка])

  // После оцифровки вещи (очередь T12) изображения в хранилище меняются, а сетка
  // уже прочитана. Тихо перечитываем гардероб — скелетон не мигает, панель
  // оцифровки не пропадает, а в карточке появляется свежий вырез/AI-версия.
  useEffect(() => {
    let активен = true
    const отписаться = appDigitizeQueue.onDigitized(() => {
      void loadWardrobe()
        .then((данные) => {
          if (активен) setЗаписи(данные)
        })
        .catch(() => {
          // Молчаливое обновление: если перечитать не удалось, остаются прежние
          // данные и уже показанное сообщение об ошибке — затирать его нечем.
        })
    })
    return () => {
      активен = false
      отписаться()
    }
  }, [])

  const всеВещи = useMemo(() => записи.map((запись) => запись.вещь), [записи])

  // Фильтрация целиком в памяти — без обращения к хранилищу на каждый ввод.
  const найдено = useMemo(() => {
    const подходящие = new Set(
      filterAndSearch(всеВещи, фильтр, запрос).map((вещь) => вещь.id),
    )
    return записи.filter((запись) => подходящие.has(запись.вещь.id))
  }, [записи, всеВещи, фильтр, запрос])

  const секции = useMemo(() => groupByTopCategory(найдено), [найдено])

  const доступныеВерхние = useMemo(
    () => groupByTopCategory(записи).map((секция) => секция.категория),
    [записи],
  )
  const доступныеПод = useMemo(
    () => availableSubcategories(всеВещи, фильтр.top ?? ''),
    [всеВещи, фильтр.top],
  )
  const доступныеЦвета = useMemo(() => availableColors(всеВещи), [всеВещи])
  const доступныеСезоны = useMemo(() => availableSeasons(всеВещи), [всеВещи])

  const активен = hasActiveFilter(фильтр) || запрос.trim() !== ''

  const повторить = () => setПопытка((текущая) => текущая + 1)
  const сбросить = () => {
    setЗапрос('')
    setФильтр({})
  }

  const выбратьВерх = (категория: string) => {
    setФильтр((текущий) => {
      if (текущий.top === категория) return { ...текущий, top: undefined, sub: undefined }
      return { ...текущий, top: категория, sub: undefined }
    })
  }

  const выбратьПод = (под: string) => {
    setФильтр((текущий) => ({ ...текущий, sub: текущий.sub === под ? undefined : под }))
  }

  const переключитьЦвет = (цвет: string) => {
    setФильтр((текущий) => {
      const выбраны = текущий.цвета ?? []
      return {
        ...текущий,
        цвета: выбраны.includes(цвет)
          ? выбраны.filter((значение) => значение !== цвет)
          : [...выбраны, цвет],
      }
    })
  }

  const переключитьСезон = (сезон: Season) => {
    setФильтр((текущий) => {
      const выбраны = текущий.сезоны ?? []
      return {
        ...текущий,
        сезоны: выбраны.includes(сезон)
          ? выбраны.filter((значение) => значение !== сезон)
          : [...выбраны, сезон],
      }
    })
  }

  return (
    <section className={screenStyles.screen}>
      <h1 className={screenStyles.title}>Гардероб</h1>

      {состояние === 'готово' && записи.length > 0 && (
        <div className={styles.controls}>
          <input
            className={styles.search}
            type="search"
            value={запрос}
            placeholder="Поиск по названию"
            aria-label="Поиск по названию"
            onChange={(event) => setЗапрос(event.target.value)}
          />

          <div className={styles.chipGroup} role="group" aria-label="Верхние категории">
            {доступныеВерхние.map((категория) => (
              <ФильтрЧип
                key={категория}
                активно={фильтр.top === категория}
                onToggle={() => выбратьВерх(категория)}
              >
                {категория}
              </ФильтрЧип>
            ))}
          </div>

          {доступныеПод.length > 0 && (
            <div className={styles.chipGroup} role="group" aria-label="Подкатегории">
              {доступныеПод.map((под) => (
                <ФильтрЧип
                  key={под}
                  активно={фильтр.sub === под}
                  onToggle={() => выбратьПод(под)}
                >
                  {под}
                </ФильтрЧип>
              ))}
            </div>
          )}

          {доступныеЦвета.length > 0 && (
            <div className={styles.chipGroup} role="group" aria-label="Цвета">
              {доступныеЦвета.map((цвет) => (
                <ФильтрЧип
                  key={цвет}
                  активно={(фильтр.цвета ?? []).includes(цвет)}
                  onToggle={() => переключитьЦвет(цвет)}
                >
                  {цвет}
                </ФильтрЧип>
              ))}
            </div>
          )}

          {доступныеСезоны.length > 0 && (
            <div className={styles.chipGroup} role="group" aria-label="Сезоны">
              {доступныеСезоны.map((сезон) => (
                <ФильтрЧип
                  key={сезон}
                  активно={(фильтр.сезоны ?? []).includes(сезон)}
                  onToggle={() => переключитьСезон(сезон)}
                >
                  {сезон}
                </ФильтрЧип>
              ))}
            </div>
          )}

          {активен && (
            <div className={styles.controlsFooter}>
              <span className={styles.found} role="status">
                Найдено {найдено.length}
              </span>
              {/* Когда ничего не нашлось, сброс живёт в блоке «Ничего не найдено»,
                  чтобы не было двух одинаковых кнопок. */}
              {найдено.length > 0 && (
                <button className={styles.reset} type="button" onClick={сбросить}>
                  Сбросить фильтры
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {состояние === 'готово' && записи.length > 0 && <DigitizePanel />}

      {состояние === 'загрузка' && <WardrobeSkeleton />}

      {состояние === 'ошибка' && (
        <ErrorNotice message={ошибка ?? ТЕКСТ_ОШИБКИ} onRetry={повторить} />
      )}

      {/* O7: при пустом гардеробе первый экран — сама форма добавления, а не
          ссылка на отдельный /add. После сохранения перечитываем гардероб, и
          место формы занимает сетка (T13). */}
      {состояние === 'готово' && записи.length === 0 && (
        <div className={styles.onboarding}>
          <p className={screenStyles.placeholderText}>Гардероб пуст</p>
          <AddItemForm onSaved={повторить} />
        </div>
      )}

      {состояние === 'готово' && активен && найдено.length === 0 && (
        <div className={styles.nothing}>
          <p className={styles.nothingTitle}>Ничего не найдено</p>
          <p className={styles.nothingHint}>
            Попробуйте изменить запрос или сбросить фильтры
          </p>
          <button
            className={`${screenStyles.button} ${styles.nothingButton}`}
            type="button"
            onClick={сбросить}
          >
            Сбросить фильтры
          </button>
        </div>
      )}

      {состояние === 'готово' && активен && найдено.length > 0 && (
        <section className={styles.section} aria-label="Результаты">
          <ul className={styles.grid}>
            {найдено.map((entry) => (
              <КарточкаВещи
                key={entry.вещь.id}
                entry={entry}
                onOpen={() => navigate(`/item/${entry.вещь.id}`)}
              />
            ))}
          </ul>
        </section>
      )}

      {состояние === 'готово' &&
        !активен &&
        секции.map((секция) => (
          <section key={секция.категория} className={styles.section} aria-label={секция.категория}>
            <header className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>{секция.категория}</h2>
              <span className={styles.count}>{секция.количество}</span>
            </header>
            <ul className={styles.grid}>
              {секция.вещи.map((entry) => (
                <КарточкаВещи
                  key={entry.вещь.id}
                  entry={entry}
                  onOpen={() => navigate(`/item/${entry.вещь.id}`)}
                />
              ))}
            </ul>
          </section>
        ))}
    </section>
  )
}
