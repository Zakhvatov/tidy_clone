import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { ArrowLeft } from '@phosphor-icons/react'
import { useNavigate, useParams } from 'react-router-dom'

import type { Season, ЭлементОбраза, Образ, Вещь } from '../../domain/types'
import { ФОН_ПО_УМОЛЧАНИЮ, ФОНЫ, загрузитьФон, сохранитьФон } from '../../services/outfit-background'
import {
  COLLAGE_HEIGHT,
  COLLAGE_WIDTH,
  MAX_SCALE,
  MIN_SCALE,
  изменитьСлой,
  layoutElements,
  ограничитьМасштаб,
  позицияПоУмолчанию,
  type ДействиеСлоя,
} from '../../services/outfit-render'
import { loadWardrobe, preferredImage, type WardrobeEntry } from '../../services/wardrobe'
import {
  create as создатьОбраз,
  get as получитьОбраз,
  update as обновитьОбраз,
} from '../../storage/outfits'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { OutfitPicker } from '../../ui/OutfitPicker'
import { useObjectUrl } from '../../ui/useObjectUrl'
import screenStyles from './Screen.module.css'
import styles from './OutfitEditorScreen.module.css'

type Состояние = 'загрузка' | 'готово' | 'нет' | 'ошибка'

const ОШИБКА_ЧТЕНИЯ = 'Не удалось открыть образ. Попробуйте ещё раз'
const ОШИБКА_СОХРАНЕНИЯ = 'Не удалось сохранить образ. Попробуйте ещё раз'

/** Сезон образа — одиночный выбор из трёх значений тикета. */
const СЕЗОНЫ: readonly Season[] = ['зима', 'лето', 'демисезон']

/** Название образа по умолчанию: «Образ от 5 мая». Редактируется вручную. */
function автоИмя(дата: Date): string {
  const день = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(дата)
  return `Образ от ${день}`
}

function новыйId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `образ-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Приводит z-порядок к 0…n−1 после добавления, удаления или смены слоя. */
function нормализовать(элементы: readonly ЭлементОбраза[]): ЭлементОбраза[] {
  return [...элементы]
    .sort((a, b) => a.zПорядок - b.zПорядок)
    .map((элемент, индекс) => ({ ...элемент, zПорядок: индекс }))
}

/**
 * Снимок редактируемого состояния для проверки несохранённых правок.
 * Округляем координаты и масштаб, чтобы шум вычислений не считался правкой.
 */
function снимокОбраза(
  название: string,
  сезон: Season,
  элементы: readonly ЭлементОбраза[],
  фон: string,
): string {
  const раскладка = нормализовать(элементы).map((элемент) => [
    элемент.idВещи,
    Number(элемент.позиция.x.toFixed(3)),
    Number(элемент.позиция.y.toFixed(3)),
    Number(элемент.масштаб.toFixed(4)),
    элемент.zПорядок,
  ])
  return JSON.stringify({ название, сезон, фон, раскладка })
}

/** Изображение вещи на холсте: object URL создаётся и освобождается хуком. */
function ElementImage({ blob, alt }: { blob?: Blob; alt: string }) {
  const url = useObjectUrl(blob)
  if (url === '') return null
  return <img className={styles.elementImage} src={url} alt={alt} draggable={false} />
}

/**
 * Редактор коллажа (T16): холст с подложкой, перетаскивание, масштаб, слои,
 * удаление элемента и пикер вещей (T17).
 *
 * Новый образ открывается на `/outfit/new`; после сохранения адрес заменяется
 * на `/outfit/<id>`, и дальше правки идут в тот же образ. Элементы коллажа и
 * название с сезоном хранятся в IndexedDB (`outfits`), подложка — в
 * `localStorage` (в доменном `Образ` поля под неё нет).
 */
export function OutfitEditorScreen() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const новый = id === undefined || id === 'new'

  const [состояние, setСостояние] = useState<Состояние>('загрузка')
  const [название, setНазвание] = useState('')
  const [сезон, setСезон] = useState<Season>('демисезон')
  const [элементы, setЭлементы] = useState<ЭлементОбраза[]>([])
  const [фон, setФон] = useState<string>(ФОН_ПО_УМОЛЧАНИЮ)
  const [записи, setЗаписи] = useState<WardrobeEntry[]>([])
  const [выбран, setВыбран] = useState<string | null>(null)
  const [сохранение, setСохранение] = useState(false)
  const [сообщение, setСообщение] = useState<string | null>(null)
  const [ошибка, setОшибка] = useState<string | null>(null)
  const [попытка, setПопытка] = useState(0)
  const [перетаскивается, setПеретаскивается] = useState(false)
  const [исходныйСнимок, setИсходныйСнимок] = useState<string | null>(null)
  const [подтверждениеВыхода, setПодтверждениеВыхода] = useState(false)
  const [вернутьФокус, setВернутьФокус] = useState(false)

  const холстRef = useRef<HTMLDivElement>(null)
  const перетаскивание = useRef<{ idВещи: string; x: number; y: number } | null>(null)
  const кнопкаНазад = useRef<HTMLButtonElement>(null)
  const кнопкаОстаться = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let активен = true
    setСостояние('загрузка')
    setОшибка(null)
    setСообщение(null)
    setПодтверждениеВыхода(false)

    void (async () => {
      try {
        const гардероб = await loadWardrobe()
        if (!активен) return
        setЗаписи(гардероб)

        if (новый) {
          const имя = автоИмя(new Date())
          setНазвание(имя)
          setСезон('демисезон')
          setЭлементы([])
          setФон(ФОН_ПО_УМОЛЧАНИЮ)
          setВыбран(null)
          setИсходныйСнимок(снимокОбраза(имя, 'демисезон', [], ФОН_ПО_УМОЛЧАНИЮ))
          setСостояние('готово')
          return
        }

        const образ = await получитьОбраз(id)
        if (!активен) return
        if (образ === undefined) {
          setИсходныйСнимок(null)
          setСостояние('нет')
          return
        }
        const сохранённыйФон = загрузитьФон(образ.id)
        setНазвание(образ.название)
        setСезон(образ.сезон)
        setЭлементы(образ.элементы)
        setФон(сохранённыйФон)
        setВыбран(null)
        setИсходныйСнимок(
          снимокОбраза(образ.название, образ.сезон, образ.элементы, сохранённыйФон),
        )
        setСостояние('готово')
      } catch {
        if (!активен) return
        setИсходныйСнимок(null)
        setОшибка(ОШИБКА_ЧТЕНИЯ)
        setСостояние('ошибка')
      }
    })()

    return () => {
      активен = false
    }
  }, [id, новый, попытка])

  const раскладка = useMemo(
    () => layoutElements(элементы, { width: COLLAGE_WIDTH, height: COLLAGE_HEIGHT }),
    [элементы],
  )
  const записиПоИд = useMemo(
    () => new Map(записи.map((entry) => [entry.вещь.id, entry])),
    [записи],
  )
  const выбранныйЭлемент = элементы.find((элемент) => элемент.idВещи === выбран) ?? null
  const грязно =
    исходныйСнимок !== null &&
    снимокОбраза(название, сезон, элементы, фон) !== исходныйСнимок

  useEffect(() => {
    if (грязно && сообщение !== null) setСообщение(null)
  }, [грязно, сообщение])

  useEffect(() => {
    if (!грязно) return
    const предохранить = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', предохранить)
    return () => window.removeEventListener('beforeunload', предохранить)
  }, [грязно])

  useEffect(() => {
    if (подтверждениеВыхода) кнопкаОстаться.current?.focus()
  }, [подтверждениеВыхода])

  useEffect(() => {
    if (!подтверждениеВыхода && вернутьФокус) {
      кнопкаНазад.current?.focus()
      setВернутьФокус(false)
    }
  }, [вернутьФокус, подтверждениеВыхода])

  function назад(): void {
    if (грязно) {
      setПодтверждениеВыхода(true)
      return
    }
    navigate('/outfits')
  }

  function отменитьВыход(): void {
    setПодтверждениеВыхода(false)
    setВернутьФокус(true)
  }

  /** Коэффициент перевода пикселей экрана в координаты холста. */
  function масштабЭкрана(): number {
    const rect = холстRef.current?.getBoundingClientRect()
    if (rect === undefined || rect.width <= 0) return 1
    return rect.width / COLLAGE_WIDTH
  }

  function начатьПеретаскивание(
    idВещи: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void {
    setВыбран(idВещи)
    перетаскивание.current = { idВещи, x: event.clientX, y: event.clientY }
    setПеретаскивается(true)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // jsdom и часть мобильных браузеров pointer capture не поддерживают.
    }
  }

  function продолжитьПеретаскивание(event: ReactPointerEvent<HTMLButtonElement>): void {
    const активное = перетаскивание.current
    if (активное === null) return
    const коэффициент = масштабЭкрана()
    const dx = (event.clientX - активное.x) / коэффициент
    const dy = (event.clientY - активное.y) / коэффициент
    активное.x = event.clientX
    активное.y = event.clientY
    setЭлементы((текущие) =>
      текущие.map((элемент) => {
        if (элемент.idВещи !== активное.idВещи) return элемент
        const черновик: ЭлементОбраза = {
          ...элемент,
          позиция: { x: элемент.позиция.x + dx, y: элемент.позиция.y + dy },
        }
        // Держим состояние в тех же границах, что и раскладка: иначе у края
        // появляется мёртвая зона, пока накопленное смещение не сгорит.
        const [рамка] = layoutElements([черновик], {
          width: COLLAGE_WIDTH,
          height: COLLAGE_HEIGHT,
        })
        if (рамка === undefined) return черновик
        return {
          ...черновик,
          позиция: { x: рамка.left + рамка.width / 2, y: рамка.top + рамка.height / 2 },
        }
      }),
    )
  }

  function завершитьПеретаскивание(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (перетаскивание.current === null) return
    перетаскивание.current = null
    setПеретаскивается(false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // см. начатьПеретаскивание
    }
  }

  /** Один тап по вещи в пикере добавляет её в коллаж; повторный — только выбирает. */
  function добавитьВещь(вещь: Вещь): void {
    setВыбран(вещь.id)
    setЭлементы((текущие) => {
      if (текущие.some((элемент) => элемент.idВещи === вещь.id)) return текущие
      const максимальный = текущие.reduce(
        (макс, элемент) => Math.max(макс, элемент.zПорядок),
        -1,
      )
      return [
        ...текущие,
        {
          idВещи: вещь.id,
          позиция: позицияПоУмолчанию(текущие.length),
          масштаб: 1,
          zПорядок: максимальный + 1,
        },
      ]
    })
  }

  function изменитьМасштаб(значение: number): void {
    if (выбран === null) return
    setЭлементы((текущие) =>
      текущие.map((элемент) =>
        элемент.idВещи === выбран ? { ...элемент, масштаб: ограничитьМасштаб(значение) } : элемент,
      ),
    )
  }

  function сменитьСлой(действие: ДействиеСлоя): void {
    if (выбран === null) return
    setЭлементы((текущие) => изменитьСлой(текущие, выбран, действие))
  }

  /** Убирает вещь из коллажа; сама Вещь в гардеробе остаётся. */
  function убратьИзОбраза(): void {
    if (выбран === null) return
    setЭлементы((текущие) => нормализовать(текущие.filter((элемент) => элемент.idВещи !== выбран)))
    setВыбран(null)
  }

  async function сохранить(): Promise<void> {
    setОшибка(null)
    setСохранение(true)
    setСообщение(null)
    try {
      const имя = название.trim() === '' ? автоИмя(new Date()) : название.trim()
      const порядок = нормализовать(элементы)

      if (новый) {
        const создаваемый: Образ = {
          id: новыйId(),
          название: имя,
          сезон,
          элементы: порядок,
          датаСоздания: new Date().toISOString(),
        }
        await создатьОбраз(создаваемый)
        сохранитьФон(создаваемый.id, фон)
        setНазвание(имя)
        setИсходныйСнимок(снимокОбраза(имя, сезон, порядок, фон))
        setСообщение('Сохранено')
        navigate(`/outfit/${создаваемый.id}`, { replace: true })
        return
      }

      await обновитьОбраз(id, { название: имя, сезон, элементы: порядок })
      сохранитьФон(id, фон)
      setНазвание(имя)
      setИсходныйСнимок(снимокОбраза(имя, сезон, порядок, фон))
      setСообщение('Сохранено')
    } catch {
      setОшибка(ОШИБКА_СОХРАНЕНИЯ)
    } finally {
      setСохранение(false)
    }
  }

  if (состояние === 'загрузка') {
    return (
      <section className={screenStyles.screen}>
        <p className={styles.status} role="status" aria-live="polite">
          Загружаем образ…
        </p>
      </section>
    )
  }

  if (состояние === 'ошибка') {
    return (
      <section className={screenStyles.screen}>
        <ErrorNotice
          message={ошибка ?? ОШИБКА_ЧТЕНИЯ}
          onRetry={() => setПопытка((текущая) => текущая + 1)}
        />
      </section>
    )
  }

  if (состояние === 'нет') {
    return (
      <section className={screenStyles.screen}>
        <div className={styles.notFound}>
          <h1 className={screenStyles.title}>Образ не найден</h1>
          <p className={styles.notFoundText}>Возможно, его удалили. Вернитесь к образам.</p>
          <button className={styles.back} type="button" onClick={() => navigate('/outfits')}>
            Назад
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className={screenStyles.screen}>
      <header className={styles.header}>
        <button ref={кнопкаНазад} className={styles.back} type="button" onClick={назад}>
          <ArrowLeft size={20} weight="regular" aria-hidden="true" />
          Назад
        </button>
        <h1 className={screenStyles.title}>{новый ? 'Новый образ' : 'Образ'}</h1>
      </header>

      {подтверждениеВыхода && (
        <div
          className={styles.confirm}
          role="alertdialog"
          aria-modal="true"
          aria-label="Несохранённые изменения"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              отменитьВыход()
            }
          }}
        >
          <p className={styles.confirmText}>
            Есть несохранённые изменения. Выйти из редактора без сохранения?
          </p>
          <div className={styles.confirmActions}>
            <button
              ref={кнопкаОстаться}
              className={styles.confirmCancel}
              type="button"
              onClick={отменитьВыход}
            >
              Остаться
            </button>
            <button
              className={styles.confirmLeave}
              type="button"
              onClick={() => navigate('/outfits')}
            >
              Выйти без сохранения
            </button>
          </div>
        </div>
      )}

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Название</span>
        <input
          className={styles.input}
          type="text"
          value={название}
          aria-label="Название образа"
          onChange={(event) => setНазвание(event.target.value)}
        />
      </label>

      <div className={styles.seasons} role="group" aria-label="Сезон">
        {СЕЗОНЫ.map((значение) => (
          <button
            key={значение}
            type="button"
            aria-pressed={сезон === значение}
            className={сезон === значение ? `${styles.season} ${styles.seasonActive}` : styles.season}
            onClick={() => setСезон(значение)}
          >
            {значение}
          </button>
        ))}
      </div>

      <div className={styles.canvasWrap} ref={холстRef}>
        <div
          className={styles.canvas}
          style={{ backgroundColor: фон }}
          data-dragging={перетаскивается ? 'true' : 'false'}
        >
          {раскладка.map((box) => {
            const запись = записиПоИд.get(box.idВещи)
            const названиеВещи =
              запись === undefined
                ? 'Вещь'
                : запись.вещь.название.trim() === ''
                  ? 'Без названия'
                  : запись.вещь.название
            const изображение =
              запись === undefined ? undefined : preferredImage(запись.вещь, запись.изображения)
            const выбранЭтот = выбран === box.idВещи
            return (
              <button
                key={box.idВещи}
                type="button"
                className={
                  выбранЭтот ? `${styles.element} ${styles.elementSelected}` : styles.element
                }
                style={{
                  left: `${(box.left / COLLAGE_WIDTH) * 100}%`,
                  top: `${(box.top / COLLAGE_HEIGHT) * 100}%`,
                  width: `${(box.width / COLLAGE_WIDTH) * 100}%`,
                  height: `${(box.height / COLLAGE_HEIGHT) * 100}%`,
                  zIndex: box.zПорядок + 1,
                }}
                aria-label={`Элемент: ${названиеВещи}`}
                aria-pressed={выбранЭтот}
                onPointerDown={(event) => начатьПеретаскивание(box.idВещи, event)}
                onPointerMove={продолжитьПеретаскивание}
                onPointerUp={завершитьПеретаскивание}
                onPointerCancel={завершитьПеретаскивание}
                onClick={() => setВыбран(box.idВещи)}
              >
                <ElementImage blob={изображение?.blob} alt={названиеВещи} />
              </button>
            )
          })}

          {раскладка.length === 0 && (
            <p className={styles.canvasHint}>Добавьте вещи из списка ниже</p>
          )}
        </div>
      </div>

      {выбранныйЭлемент === null ? (
        <p className={styles.hint} role="status">
          Выберите вещь на холсте, чтобы изменить масштаб, слой или убрать её
        </p>
      ) : (
        <section className={styles.controls} aria-label="Выбранная вещь">
          <label className={styles.sliderField}>
            <span className={styles.fieldLabel}>Масштаб</span>
            <input
              className={styles.slider}
              type="range"
              min={Math.round(MIN_SCALE * 100)}
              max={Math.round(MAX_SCALE * 100)}
              step={5}
              value={Math.round(выбранныйЭлемент.масштаб * 100)}
              aria-label="Масштаб"
              onChange={(event) => изменитьМасштаб(Number(event.target.value) / 100)}
            />
          </label>
          <div className={styles.layerButtons} role="group" aria-label="Слои">
            <button type="button" className={styles.control} onClick={() => сменитьСлой('выше')}>
              Выше
            </button>
            <button type="button" className={styles.control} onClick={() => сменитьСлой('ниже')}>
              Ниже
            </button>
            <button type="button" className={styles.control} onClick={() => сменитьСлой('наверх')}>
              Наверх
            </button>
            <button type="button" className={styles.control} onClick={() => сменитьСлой('вниз')}>
              Вниз
            </button>
          </div>
          <button type="button" className={styles.remove} onClick={убратьИзОбраза}>
            Убрать из образа
          </button>
        </section>
      )}

      <div className={styles.backgrounds} role="group" aria-label="Подложка">
        {ФОНЫ.map((вариант) => (
          <button
            key={вариант.значение}
            type="button"
            className={
              фон === вариант.значение ? `${styles.swatch} ${styles.swatchActive}` : styles.swatch
            }
            style={{ backgroundColor: вариант.значение }}
            aria-label={вариант.метка}
            aria-pressed={фон === вариант.значение}
            onClick={() => setФон(вариант.значение)}
          />
        ))}
      </div>

      <OutfitPicker
        entries={записи}
        выбранные={элементы.map((элемент) => элемент.idВещи)}
        onAdd={добавитьВещь}
      />

      {ошибка !== null && <ErrorNotice message={ошибка} />}
      {сообщение !== null && !грязно && (
        <p className={styles.saved} role="status">
          {сообщение}
        </p>
      )}
      {грязно && <p className={styles.dirty}>Есть несохранённые изменения</p>}

      <div className={styles.saveBar}>
        <button className={styles.cancel} type="button" onClick={назад}>
          Отмена
        </button>
        <button
          className={styles.save}
          type="button"
          disabled={сохранение}
          onClick={() => {
            void сохранить()
          }}
        >
          {сохранение ? 'Сохраняем…' : 'Сохранить образ'}
        </button>
      </div>
    </section>
  )
}
