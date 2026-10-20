import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import type { Season } from '../../domain/types'
import {
  availableColors,
  availableSeasons,
  availableSubcategories,
  filterAndSearch,
  hasActiveFilter,
  СЕЗОНЫ,
  type WardrobeFilter,
} from '../../services/wardrobe-filter'
import {
  groupByTopCategory,
  loadWardrobe,
  preferredImage,
  type WardrobeEntry,
} from '../../services/wardrobe'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { FilterSheet } from '../../ui/FilterSheet'
import { useObjectUrl } from '../../ui/useObjectUrl'
import { AddItemForm } from './AddItemForm'
import screenStyles from './Screen.module.css'
import styles from './WardrobeScreen.module.css'

type Состояние = 'загрузка' | 'готово' | 'ошибка'

const ТЕКСТ_ОШИБКИ = 'Не удалось прочитать гардероб. Попробуйте ещё раз'
const КЛЮЧ_ПРОКРУТКИ = 'wardrobe:scrollY'

function фильтрИзПараметров(параметры: URLSearchParams): WardrobeFilter {
  const фильтр: WardrobeFilter = {}
  const top = параметры.get('top')?.trim() ?? ''
  const sub = параметры.get('sub')?.trim() ?? ''
  const цвета = [
    ...new Set(
      (параметры.get('color') ?? '')
        .split(',')
        .map((значение) => значение.trim())
        .filter((значение) => значение !== ''),
    ),
  ]
  const сезоны = [
    ...new Set(
      (параметры.get('season') ?? '')
        .split(',')
        .map((значение) => значение.trim())
        .filter((значение): значение is Season =>
          (СЕЗОНЫ as readonly string[]).includes(значение),
        ),
    ),
  ]

  if (top !== '') фильтр.top = top
  if (sub !== '') фильтр.sub = sub
  if (цвета.length > 0) фильтр.цвета = цвета
  if (сезоны.length > 0) фильтр.сезоны = сезоны
  return фильтр
}

function параметрыИзСостояния(запрос: string, фильтр: WardrobeFilter): URLSearchParams {
  const параметры = new URLSearchParams()
  if (запрос !== '') параметры.set('q', запрос)
  if (фильтр.top !== undefined && фильтр.top !== '') параметры.set('top', фильтр.top)
  if (фильтр.sub !== undefined && фильтр.sub !== '') параметры.set('sub', фильтр.sub)

  const цвета = фильтр.цвета ?? []
  if (цвета.length > 0) параметры.set('color', цвета.join(','))

  const сезоны = фильтр.сезоны ?? []
  if (сезоны.length > 0) параметры.set('season', сезоны.join(','))

  return параметры
}

function сохранитьПрокрутку() {
  try {
    window.sessionStorage.setItem(КЛЮЧ_ПРОКРУТКИ, String(window.scrollY))
  } catch {
    return
  }
}

function прочитатьПрокрутку(): number | null {
  try {
    const значение = window.sessionStorage.getItem(КЛЮЧ_ПРОКРУТКИ)
    if (значение === null) return null
    const число = Number.parseInt(значение, 10)
    return Number.isFinite(число) ? число : null
  } catch {
    return null
  }
}

function очиститьПрокрутку() {
  try {
    window.sessionStorage.removeItem(КЛЮЧ_ПРОКРУТКИ)
  } catch {
    return
  }
}

function WardrobeSkeleton() {
  return (
    <div className={styles.skeleton} role="status" aria-live="polite">
      <span className={styles.skeletonHeader} aria-hidden="true" />
      <div className={styles.skeletonGrid} aria-hidden="true">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((key) => (
          <span key={key} className={styles.skeletonCard} />
        ))}
      </div>
      <span className={styles.loading}>Загружаем гардероб…</span>
    </div>
  )
}

function WardrobeCard({ entry, onOpen }: { entry: WardrobeEntry; onOpen: () => void }) {
  const название =
    entry.вещь.название.trim() === '' ? 'Без названия' : entry.вещь.название
  const изображение = preferredImage(entry.вещь, entry.изображения)
  const url = useObjectUrl(изображение?.blob)

  return (
    <li className={styles.tile}>
      <button className={styles.card} type="button" onClick={onOpen} aria-label={название}>
        <span className={styles.thumb}>
          {url !== '' && (
            <img className={styles.image} src={url} alt={название} loading="lazy" decoding="async" />
          )}
        </span>
        <span className={styles.cardName}>{название}</span>
      </button>
    </li>
  )
}

function АктивныйФильтр({
  подпись,
  ariaLabel,
  onУдалить,
}: {
  подпись: string
  ariaLabel: string
  onУдалить: () => void
}) {
  return (
    <li>
      <button type="button" className={styles.pill} aria-label={ariaLabel} onClick={onУдалить}>
        <span className={styles.pillLabel}>{подпись}</span>
        <span className={styles.pillRemove} aria-hidden="true">
          ×
        </span>
      </button>
    </li>
  )
}

export function WardrobeScreen() {
  const navigate = useNavigate()
  const [параметры, setПараметры] = useSearchParams()
  const [состояние, setСостояние] = useState<Состояние>('загрузка')
  const [записи, setЗаписи] = useState<WardrobeEntry[]>([])
  const [ошибка, setОшибка] = useState<string | null>(ТЕКСТ_ОШИБКИ)
  const [попытка, setПопытка] = useState(0)

  const [запрос, setЗапрос] = useState(() => параметры.get('q') ?? '')
  const [фильтр, setФильтр] = useState<WardrobeFilter>(() => фильтрИзПараметров(параметры))
  const [открытыФильтры, setОткрытыФильтры] = useState(false)
  const кнопкаФильтров = useRef<HTMLButtonElement>(null)

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

  useEffect(() => {
    const следующие = параметрыИзСостояния(запрос, фильтр)
    if (следующие.toString() === параметры.toString()) return
    setПараметры(следующие, { replace: true })
  }, [запрос, фильтр, параметры, setПараметры])

  useEffect(() => {
    if (состояние !== 'готово') return
    const значение = прочитатьПрокрутку()
    if (значение === null) return
    if (значение <= 0) {
      очиститьПрокрутку()
      return
    }

    const таймер = window.setTimeout(() => {
      window.scrollTo(0, значение)
      очиститьПрокрутку()
    }, 0)

    return () => window.clearTimeout(таймер)
  }, [состояние])

  const всеВещи = useMemo(() => записи.map((запись) => запись.вещь), [записи])

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
  const количествоФильтров =
    (фильтр.top ? 1 : 0) +
    (фильтр.sub ? 1 : 0) +
    (фильтр.цвета?.length ?? 0) +
    (фильтр.сезоны?.length ?? 0)

  const повторить = () => setПопытка((текущая) => текущая + 1)
  const сбросить = () => {
    setЗапрос('')
    setФильтр({})
  }
  const сброситьФильтр = () => setФильтр({})

  const закрытьФильтры = () => {
    setОткрытыФильтры(false)
    кнопкаФильтров.current?.focus()
  }

  const открытьВещь = (id: string) => {
    сохранитьПрокрутку()
    navigate(`/item/${id}`)
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
        <div className={styles.stickyBar}>
          <input
            className={styles.search}
            type="search"
            value={запрос}
            placeholder="Поиск по названию"
            aria-label="Поиск по названию"
            onChange={(event) => setЗапрос(event.target.value)}
          />
          <button
            type="button"
            ref={кнопкаФильтров}
            aria-haspopup="dialog"
            aria-expanded={открытыФильтры}
            className={
              количествоФильтров > 0
                ? `${styles.filtersButton} ${styles.filtersButtonActive}`
                : styles.filtersButton
            }
            onClick={() => setОткрытыФильтры(true)}
          >
            {количествоФильтров > 0 ? `Фильтры · ${количествоФильтров}` : 'Фильтры'}
          </button>
        </div>
      )}

      {открытыФильтры && (
        <FilterSheet
          фильтр={фильтр}
          верхние={доступныеВерхние}
          подкатегории={доступныеПод}
          цвета={доступныеЦвета}
          сезоны={доступныеСезоны}
          onЗакрыть={закрытьФильтры}
          onСбросить={сброситьФильтр}
          onВерх={выбратьВерх}
          onПод={выбратьПод}
          onЦвет={переключитьЦвет}
          onСезон={переключитьСезон}
        />
      )}

      {состояние === 'загрузка' && <WardrobeSkeleton />}

      {состояние === 'ошибка' && (
        <ErrorNotice message={ошибка ?? ТЕКСТ_ОШИБКИ} onRetry={повторить} />
      )}

      {состояние === 'готово' && записи.length === 0 && (
        <div className={styles.onboarding}>
          <p className={screenStyles.placeholderText}>Гардероб пуст</p>
          <AddItemForm onSaved={повторить} />
        </div>
      )}

      {состояние === 'готово' && записи.length > 0 && активен && (
        <div className={styles.activeArea}>
          <ul className={styles.pills} aria-label="Активные фильтры">
            {запрос.trim() !== '' && (
              <АктивныйФильтр
                подпись={`Поиск: «${запрос.trim()}»`}
                ariaLabel={`Убрать поиск «${запрос.trim()}»`}
                onУдалить={() => setЗапрос('')}
              />
            )}
            {фильтр.top !== undefined && фильтр.top !== '' && (
              <АктивныйФильтр
                подпись={фильтр.top}
                ariaLabel={`Убрать фильтр «${фильтр.top}»`}
                onУдалить={() =>
                  setФильтр((текущий) => ({ ...текущий, top: undefined, sub: undefined }))
                }
              />
            )}
            {фильтр.sub !== undefined && фильтр.sub !== '' && (
              <АктивныйФильтр
                подпись={фильтр.sub}
                ariaLabel={`Убрать фильтр «${фильтр.sub}»`}
                onУдалить={() =>
                  setФильтр((текущий) => ({ ...текущий, sub: undefined }))
                }
              />
            )}
            {(фильтр.цвета ?? []).map((цвет) => (
              <АктивныйФильтр
                key={`цвет-${цвет}`}
                подпись={цвет}
                ariaLabel={`Убрать фильтр «${цвет}»`}
                onУдалить={() => переключитьЦвет(цвет)}
              />
            ))}
            {(фильтр.сезоны ?? []).map((сезон) => (
              <АктивныйФильтр
                key={`сезон-${сезон}`}
                подпись={сезон}
                ariaLabel={`Убрать фильтр «${сезон}»`}
                onУдалить={() => переключитьСезон(сезон)}
              />
            ))}
          </ul>

          <div className={styles.statusRow}>
            <span className={styles.found} role="status">
              Найдено {найдено.length}
            </span>
            {найдено.length > 0 && (
              <button className={styles.reset} type="button" onClick={сбросить}>
                Сбросить фильтры
              </button>
            )}
          </div>

          {найдено.length === 0 ? (
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
          ) : (
            <section className={styles.section} aria-label="Результаты">
              <ul className={styles.grid}>
                {найдено.map((entry) => (
                  <WardrobeCard
                    key={entry.вещь.id}
                    entry={entry}
                    onOpen={() => открытьВещь(entry.вещь.id)}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {состояние === 'готово' &&
        записи.length > 0 &&
        !активен &&
        секции.map((секция) => (
          <section key={секция.категория} className={styles.section} aria-label={секция.категория}>
            <header className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>{секция.категория}</h2>
              <span className={styles.count}>{секция.количество}</span>
            </header>
            <ul className={styles.grid}>
              {секция.вещи.map((entry) => (
                <WardrobeCard
                  key={entry.вещь.id}
                  entry={entry}
                  onOpen={() => открытьВещь(entry.вещь.id)}
                />
              ))}
            </ul>
          </section>
        ))}
    </section>
  )
}
