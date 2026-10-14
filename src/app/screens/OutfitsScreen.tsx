import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { Изображение, Образ, Season, Вещь } from '../../domain/types'
import { renderOutfitCover } from '../../services/outfit-render'
import { loadWardrobe, preferredImage, type WardrobeEntry } from '../../services/wardrobe'
import {
  list as списокОбразов,
  remove as удалитьОбраз,
  update as обновитьОбраз,
} from '../../storage/outfits'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { useObjectUrl } from '../../ui/useObjectUrl'
import screenStyles from './Screen.module.css'
import styles from './OutfitsScreen.module.css'

type Состояние = 'загрузка' | 'готово' | 'ошибка'

const ОШИБКА_ЧТЕНИЯ = 'Не удалось прочитать образы. Попробуйте ещё раз'
const ОШИБКА_ПЕРЕИМЕНОВАНИЯ = 'Не удалось сохранить название. Попробуйте ещё раз'
const ОШИБКА_УДАЛЕНИЯ = 'Не удалось удалить образ. Попробуйте ещё раз'

/** Сезон образа — одиночный выбор из трёх значений тикета. */
const СЕЗОНЫ: readonly Season[] = ['зима', 'лето', 'демисезон']

/** Фильтр списка: «Все» либо один из сезонов. */
const ВСЕ = 'Все'
type Фильтр = typeof ВСЕ | Season

const ФИЛЬТРЫ: readonly Фильтр[] = [ВСЕ, ...СЕЗОНЫ]

/** Число вещей с правильным русским словом: 1 вещь, 2 вещи, 5 вещей. */
function числоВещей(образ: Образ): string {
  const n = образ.элементы.length
  const десяток = n % 10
  const сотня = n % 100
  const слово =
    десяток === 1 && сотня !== 11
      ? 'вещь'
      : десяток >= 2 && десяток <= 4 && (сотня < 12 || сотня > 14)
        ? 'вещи'
        : 'вещей'
  return `${n} ${слово}`
}

/** Новые образы идут первыми; при равной дате — устойчиво по `id`. */
function поУбываниюДаты(a: Образ, b: Образ): number {
  const поДате = b.датаСоздания.localeCompare(a.датаСоздания)
  if (поДате !== 0) return поДате
  return b.id.localeCompare(a.id)
}

interface OutfitCoverProps {
  образ: Образ
  вещи: readonly Вещь[]
  изображения: readonly Изображение[]
  /** Изображение первой вещи — что показать, если коллаж не собрался. */
  подложка?: Blob
  alt: string
}

/**
 * Обложка-миниатюра: коллаж через `renderOutfitCover`.
 *
 * Рендер асинхронен и может не получиться (нет canvas, битая картинка). В этом
 * случае карточка не падает: показывается первая вещь образа, а если и её нет —
 * просто подложка. Object URL освобождается при смене образа и размонтировании.
 */
function OutfitCover({ образ, вещи, изображения, подложка, alt }: OutfitCoverProps) {
  const [url, setUrl] = useState('')
  const подложкаUrl = useObjectUrl(подложка)

  useEffect(() => {
    let активен = true
    let созданный = ''
    setUrl('')

    void renderOutfitCover(образ, вещи, изображения)
      .then((blob) => {
        if (!активен) return
        созданный = URL.createObjectURL(blob)
        setUrl(созданный)
      })
      .catch(() => {
        if (активен) setUrl('')
      })

    return () => {
      активен = false
      if (созданный !== '') URL.revokeObjectURL(созданный)
    }
  }, [образ, вещи, изображения])

  const показать = url !== '' ? url : подложкаUrl
  const декоративный = url === '' && подложкаUrl !== ''

  return (
    <span className={styles.cover}>
      {показать !== '' && (
        <img
          className={styles.coverImage}
          src={показать}
          alt={декоративный ? '' : alt}
          loading="lazy"
          decoding="async"
        />
      )}
    </span>
  )
}

interface RenameFormProps {
  образ: Образ
  onSave: (название: string) => void
  onCancel: () => void
}

/** Инлайн-переименование прямо в списке: сохраняем по Enter или кнопке. */
function RenameForm({ образ, onSave, onCancel }: RenameFormProps) {
  const [значение, setЗначение] = useState(образ.название)

  return (
    <form
      className={styles.rename}
      onSubmit={(event) => {
        event.preventDefault()
        const имя = значение.trim()
        if (имя !== '') onSave(имя)
      }}
    >
      <input
        className={styles.renameInput}
        type="text"
        value={значение}
        aria-label="Название образа"
        autoFocus
        onChange={(event) => setЗначение(event.target.value)}
      />
      <div className={styles.renameButtons}>
        <button className={styles.renameSave} type="submit">
          Сохранить
        </button>
        <button className={styles.renameCancel} type="button" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  )
}

/**
 * Экран образов (T18): список сохранённых образов с обложками-миниатюрами,
 * авторедактируемым названием, сезоном и числом вещей.
 *
 * Сезон образа меняется в редакторе (`/outfit/:id`): там же живут элементы и
 * подложка, а список служит для обзора. Название можно поправить и здесь —
 * инлайн-форма пишет его в тот же `Образ` в IndexedDB.
 */
export function OutfitsScreen() {
  const navigate = useNavigate()
  const [состояние, setСостояние] = useState<Состояние>('загрузка')
  const [образы, setОбразы] = useState<Образ[]>([])
  const [записи, setЗаписи] = useState<WardrobeEntry[]>([])
  const [фильтр, setФильтр] = useState<Фильтр>(ВСЕ)
  const [ошибка, setОшибка] = useState<string | null>(null)
  const [попытка, setПопытка] = useState(0)
  const [редактируется, setРедактируется] = useState<string | null>(null)

  useEffect(() => {
    let активен = true
    setСостояние('загрузка')
    setОшибка(null)

    void (async () => {
      try {
        const [сохранённые, гардероб] = await Promise.all([списокОбразов(), loadWardrobe()])
        if (!активен) return
        setОбразы(сохранённые)
        setЗаписи(гардероб)
        setСостояние('готово')
      } catch {
        if (!активен) return
        setОшибка(ОШИБКА_ЧТЕНИЯ)
        setСостояние('ошибка')
      }
    })()

    return () => {
      активен = false
    }
  }, [попытка])

  const вещи = useMemo(() => записи.map((entry) => entry.вещь), [записи])
  const изображения = useMemo(
    () => записи.flatMap((entry) => entry.изображения),
    [записи],
  )
  const записиПоИд = useMemo(
    () => new Map(записи.map((entry) => [entry.вещь.id, entry])),
    [записи],
  )

  const видимые = useMemo(() => {
    const отфильтрованные =
      фильтр === ВСЕ ? образы : образы.filter((образ) => образ.сезон === фильтр)
    return [...отфильтрованные].sort(поУбываниюДаты)
  }, [образы, фильтр])

  async function переименовать(id: string, название: string): Promise<void> {
    setОшибка(null)
    try {
      await обновитьОбраз(id, { название })
      setОбразы((текущие) =>
        текущие.map((образ) => (образ.id === id ? { ...образ, название } : образ)),
      )
      setРедактируется(null)
    } catch {
      setОшибка(ОШИБКА_ПЕРЕИМЕНОВАНИЯ)
    }
  }

  /** Удаляет образ; сама Вещь в гардеробе остаётся. */
  async function удалить(образ: Образ): Promise<void> {
    const подтверждено = window.confirm(
      `Удалить образ «${образ.название}»? Вещи останутся в гардеробе.`,
    )
    if (!подтверждено) return
    setОшибка(null)
    try {
      await удалитьОбраз(образ.id)
      setОбразы((текущие) => текущие.filter((текущий) => текущий.id !== образ.id))
    } catch {
      setОшибка(ОШИБКА_УДАЛЕНИЯ)
    }
  }

  const пусто = состояние === 'готово' && образы.length === 0

  return (
    <section className={screenStyles.screen}>
      <header className={styles.header}>
        <h1 className={screenStyles.title}>Образы</h1>
        {состояние === 'готово' && образы.length > 0 && (
          <button
            className={styles.create}
            type="button"
            onClick={() => navigate('/outfit/new')}
          >
            Собрать образ
          </button>
        )}
      </header>

      {состояние === 'загрузка' && (
        <p className={styles.status} role="status" aria-live="polite">
          Загружаем образы…
        </p>
      )}

      {состояние === 'ошибка' && (
        <ErrorNotice
          message={ошибка ?? ОШИБКА_ЧТЕНИЯ}
          onRetry={() => setПопытка((текущая) => текущая + 1)}
        />
      )}

      {состояние === 'готово' && образы.length > 0 && (
        <div className={styles.filters} role="group" aria-label="Фильтр по сезону">
          {ФИЛЬТРЫ.map((значение) => (
            <button
              key={значение}
              type="button"
              aria-pressed={фильтр === значение}
              className={
                фильтр === значение ? `${styles.chip} ${styles.chipActive}` : styles.chip
              }
              onClick={() => setФильтр(значение)}
            >
              {значение}
            </button>
          ))}
        </div>
      )}

      {пусто && (
        <div className={styles.empty}>
          <p className={screenStyles.placeholderText}>Образов пока нет</p>
          <button className={styles.create} type="button" onClick={() => navigate('/outfit/new')}>
            Собрать образ
          </button>
        </div>
      )}

      {состояние === 'готово' && образы.length > 0 && видимые.length === 0 && (
        <p className={styles.filterEmpty}>Образов с таким сезоном нет</p>
      )}

      {видимые.length > 0 && (
        <ul className={styles.grid}>
          {видимые.map((образ) => {
            const название =
              образ.название.trim() === '' ? 'Без названия' : образ.название
            const перваяВещь = образ.элементы[0]?.idВещи
            const запись = перваяВещь === undefined ? undefined : записиПоИд.get(перваяВещь)
            const подложка =
              запись === undefined
                ? undefined
                : preferredImage(запись.вещь, запись.изображения)?.blob
            return (
              <li key={образ.id} className={styles.card}>
                {редактируется === образ.id ? (
                  <RenameForm
                    образ={образ}
                    onSave={(имя) => {
                      void переименовать(образ.id, имя)
                    }}
                    onCancel={() => setРедактируется(null)}
                  />
                ) : (
                  <>
                    <button
                      className={styles.open}
                      type="button"
                      aria-label={`Открыть образ ${название}`}
                      onClick={() => navigate(`/outfit/${образ.id}`)}
                    >
                      <OutfitCover
                        образ={образ}
                        вещи={вещи}
                        изображения={изображения}
                        подложка={подложка}
                        alt={название}
                      />
                      <span className={styles.name}>{название}</span>
                      <span className={styles.meta}>
                        <span className={styles.season}>{образ.сезон}</span>
                        <span>{числоВещей(образ)}</span>
                      </span>
                    </button>
                    <div className={styles.actions}>
                      <button
                        className={styles.action}
                        type="button"
                        aria-label={`Переименовать ${название}`}
                        onClick={() => setРедактируется(образ.id)}
                      >
                        Переименовать
                      </button>
                      <button
                        className={styles.action}
                        type="button"
                        aria-label={`Удалить ${название}`}
                        onClick={() => {
                          void удалить(образ)
                        }}
                      >
                        Удалить
                      </button>
                    </div>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {ошибка !== null && состояние === 'готово' && <ErrorNotice message={ошибка} />}
    </section>
  )
}
