import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import type { ImageRole, Изображение, ItemSource, Season, Вещь } from '../../domain/types'
import { ПАЛИТРА_ЦВЕТОВ, СЕЗОНЫ } from '../../services/wardrobe-filter'
import { ОшибкаВещьВОбразе } from '../../storage/errors'
import { listByItem } from '../../storage/images'
import { get as получитьВещь, remove as удалитьВещь, update as обновитьВещь } from '../../storage/items'
import { CategoryPicker } from '../../ui/CategoryPicker'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { GenerationModelPicker } from '../../ui/GenerationModelPicker'
import { useGenerationModels } from '../../ui/useGenerationModels'
import { useObjectUrl } from '../../ui/useObjectUrl'
import { digitizeItem } from '../../services/digitize'
import screenStyles from './Screen.module.css'
import styles from './ItemScreen.module.css'

type Состояние = 'загрузка' | 'готово' | 'нет' | 'ошибка'

const ОШИБКА_ЧТЕНИЯ = 'Не удалось открыть вещь. Попробуйте ещё раз'

/** Кнопки переключателя изображения: метки — из решений T15. */
const МЕТКИ_РОЛЕЙ: Record<ImageRole, string> = {
  оригинал: 'Оригинал',
  ai: 'AI-версия',
  вырез: 'Вырез',
}

/**
 * Изображение указанной роли: оригинал — самый ранний (он неизменяем и обычно
 * один), производные (AI-версия, вырез) — самые новые. Так перегенерация
 * показывает свежий результат, а не первую попытку.
 */
function изображениеРоли(
  изображения: readonly Изображение[],
  роль: ImageRole,
): Изображение | undefined {
  const свои = изображения.filter((изображение) => изображение.роль === роль)
  if (свои.length === 0) return undefined
  const поВозрастанию = [...свои].sort((a, b) => a.датаСоздания.localeCompare(b.датаСоздания))
  return роль === 'оригинал' ? поВозрастанию[0] : поВозрастанию[поВозрастанию.length - 1]
}

function меткаИсточника(источник: ItemSource): string {
  return источник === 'ссылка' ? 'Ссылка' : 'Фото'
}

function форматДаты(iso: string): string {
  const дата = new Date(iso)
  if (Number.isNaN(дата.getTime())) return '—'
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(
    дата,
  )
}

/** Код ошибки tidy-api, если он есть: по нему различаем 401 и 429. */
function кодОшибки(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

/**
 * Понятный текст ошибки оцифровки. 401 и 429 у T10 имеют собственные коды —
 * им даём человеческие формулировки; остальное показываем как есть, если это
 * осмысленное сообщение сервиса.
 */
function текстОшибкиОцифровки(error: unknown): string {
  const code = кодОшибки(error)
  if (code === 'unauthorized') {
    return 'Сервис оцифровки отклонил запрос (401). Проверьте доступ и попробуйте снова'
  }
  if (code === 'rate_limited') {
    return 'Слишком много запросов на оцифровку (429). Подождите немного и повторите'
  }
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return 'Не удалось сделать AI-версию. Попробуйте ещё раз'
}

/** Текст ошибки удаления: вещь в образе называем по имени, если оно есть. */
function текстОшибкиУдаления(error: unknown): string {
  if (error instanceof ОшибкаВещьВОбразе) {
    const образ = /входит в образ «([^»]+)»/.exec(error.message)?.[1]
    if (образ !== undefined) {
      return `Нельзя удалить: вещь входит в образ «${образ}». Сначала уберите её из образа`
    }
    return 'Нельзя удалить вещь: она входит в образ. Сначала уберите её из образа'
  }
  return 'Не удалось удалить вещь. Попробуйте ещё раз'
}

function СтрокаАтрибута({ label, value }: { label: string; value: string }) {
  if (value.trim() === '') return null
  return (
    <div className={styles.attr}>
      <dt className={styles.attrLabel}>{label}</dt>
      <dd className={styles.attrValue}>{value}</dd>
    </div>
  )
}

/**
 * Карточка вещи (T15): большое изображение с переключателем «Оригинал / AI-версия»,
 * правка категории, перегенерация AI-версии и удаление.
 *
 * Пометка «AI-версия» живёт только здесь — в сетке её нет (решение T15).
 * Переключатель показывается, только если есть что переключать: без AI-версии
 * и без выреза остаётся один оригинал без кнопок.
 *
 * Генерация запускается **только нажатием** и идёт напрямую в сервис оцифровки
 * (`src/services/digitize.ts`, T10) — без промежуточной прослойки.
 */
export function ItemScreen() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { models: моделиГенерации, selected: выбраннаяМодель, select: выбратьМодель } =
    useGenerationModels()

  const [состояние, setСостояние] = useState<Состояние>('загрузка')
  const [вещь, setВещь] = useState<Вещь | null>(null)
  const [изображения, setИзображения] = useState<Изображение[]>([])
  const [выбраннаяРоль, setВыбраннаяРоль] = useState<ImageRole>('оригинал')
  const [ошибка, setОшибка] = useState<string | null>(null)
  const [генерация, setГенерация] = useState(false)
  const [подтверждениеУдаления, setПодтверждениеУдаления] = useState(false)
  const [попытка, setПопытка] = useState(0)

  useEffect(() => {
    let активен = true
    setСостояние('загрузка')
    setОшибка(null)

    if (id === undefined) {
      setСостояние('нет')
      return () => {
        активен = false
      }
    }

    void (async () => {
      try {
        const найденная = await получитьВещь(id)
        if (!активен) return
        if (найденная === undefined) {
          setВещь(null)
          setСостояние('нет')
          return
        }
        const картинки = await listByItem(id)
        if (!активен) return
        setВещь(найденная)
        setИзображения(картинки)
        // По решению «Какое изображение где» показываем AI-версию, если она есть.
        setВыбраннаяРоль(изображениеРоли(картинки, 'ai') === undefined ? 'оригинал' : 'ai')
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
  }, [id, попытка])

  const оригинал = изображениеРоли(изображения, 'оригинал')
  const ai = изображениеРоли(изображения, 'ai')
  const вырез = изображениеРоли(изображения, 'вырез')
  const выбранное =
    выбраннаяРоль === 'ai' ? ai : выбраннаяРоль === 'вырез' ? вырез : оригинал
  const url = useObjectUrl(выбранное?.blob)

  const опции: ImageRole[] = ['оригинал']
  if (ai !== undefined) опции.push('ai')
  if (вырез !== undefined) опции.push('вырез')

  async function сохранитьКатегорию(категория: string, подкатегория: string) {
    if (вещь === null) return
    setОшибка(null)
    try {
      const обновлённая = await обновитьВещь(вещь.id, { категория, подкатегория })
      setВещь(обновлённая)
    } catch {
      setОшибка('Не удалось сохранить категорию. Попробуйте ещё раз')
    }
  }

  /** Правка атрибутов сохраняется сразу; при сбое оптимистичная правка откатывается. */
  async function сохранитьСезон(новый: Season[]) {
    if (вещь === null) return
    const предыдущая = вещь
    setОшибка(null)
    setВещь({ ...вещь, сезон: новый })
    try {
      const обновлённая = await обновитьВещь(вещь.id, { сезон: новый })
      setВещь(обновлённая)
    } catch {
      setВещь(предыдущая)
      setОшибка('Не удалось сохранить сезон. Попробуйте ещё раз')
    }
  }

  async function сохранитьЦвета(новые: string[]) {
    if (вещь === null) return
    const предыдущая = вещь
    setОшибка(null)
    setВещь({ ...вещь, цвета: новые })
    try {
      const обновлённая = await обновитьВещь(вещь.id, { цвета: новые })
      setВещь(обновлённая)
    } catch {
      setВещь(предыдущая)
      setОшибка('Не удалось сохранить цвета. Попробуйте ещё раз')
    }
  }

  const переключитьСезон = (сезон: Season) => {
    if (вещь === null) return
    const есть = вещь.сезон.includes(сезон)
    void сохранитьСезон(есть ? вещь.сезон.filter((з) => з !== сезон) : [...вещь.сезон, сезон])
  }

  const переключитьЦвет = (цвет: string) => {
    if (вещь === null) return
    const есть = вещь.цвета.includes(цвет)
    void сохранитьЦвета(есть ? вещь.цвета.filter((ц) => ц !== цвет) : [...вещь.цвета, цвет])
  }

  async function сделатьAiВерсию(force: boolean) {
    if (вещь === null) return
    setОшибка(null)
    setГенерация(true)
    try {
      await digitizeItem(вещь.id, {
        force,
        model: выбраннаяМодель.slug,
      })
      const картинки = await listByItem(вещь.id)
      setИзображения(картинки)
      setВыбраннаяРоль('ai')
    } catch (error) {
      setОшибка(текстОшибкиОцифровки(error))
    } finally {
      setГенерация(false)
    }
  }

  async function удалитьВещьОкончательно() {
    if (вещь === null) return
    setОшибка(null)
    try {
      await удалитьВещь(вещь.id)
      navigate('/')
    } catch (error) {
      setОшибка(текстОшибкиУдаления(error))
      setПодтверждениеУдаления(false)
    }
  }

  if (состояние === 'загрузка') {
    return (
      <section className={screenStyles.screen}>
        <p className={styles.status} role="status" aria-live="polite">
          Загружаем вещь…
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

  if (состояние === 'нет' || вещь === null) {
    return (
      <section className={screenStyles.screen}>
        <div className={styles.notFound}>
          <h1 className={styles.name}>Вещь не найдена</h1>
          <p className={styles.confirmText}>Возможно, её удалили. Вернитесь в гардероб.</p>
          <button className={styles.back} type="button" onClick={() => navigate('/')}>
            Назад
          </button>
        </div>
      </section>
    )
  }

  const название = вещь.название.trim() === '' ? 'Без названия' : вещь.название.trim()
  // Палитра предлагает типовые цвета, но цвета вещи из карточки WB не теряются:
  // даже незнакомый палитре цвет остаётся отдельным чипом.
  const цветаДляПравки = [...new Set([...ПАЛИТРА_ЦВЕТОВ, ...вещь.цвета])]

  return (
    <section className={screenStyles.screen}>
      <header className={styles.header}>
        <button className={styles.back} type="button" onClick={() => navigate('/')}>
          ← Назад
        </button>
      </header>

      <article className={styles.card}>
        <div className={styles.imageBlock}>
          <div className={styles.imageFrame}>
            {url !== '' && <img className={styles.image} src={url} alt={название} />}
          </div>

          {выбраннаяРоль === 'ai' && (
            <p className={styles.aiBadge} role="note">
              AI-версия
            </p>
          )}

          {опции.length > 1 && (
            <div className={styles.switcher} role="group" aria-label="Изображение">
              {опции.map((роль) => (
                <button
                  key={роль}
                  type="button"
                  aria-pressed={выбраннаяРоль === роль}
                  className={
                    выбраннаяРоль === роль
                      ? `${styles.switchOption} ${styles.switchOptionActive}`
                      : styles.switchOption
                  }
                  onClick={() => setВыбраннаяРоль(роль)}
                >
                  {МЕТКИ_РОЛЕЙ[роль]}
                </button>
              ))}
            </div>
          )}
        </div>

        <h1 className={styles.name}>{название}</h1>

        <dl className={styles.attrs}>
          <СтрокаАтрибута label="Состав" value={вещь.состав.join(', ')} />
          <СтрокаАтрибута label="Бренд" value={вещь.бренд} />
          <СтрокаАтрибута label="Источник" value={меткаИсточника(вещь.источник)} />
          <div className={styles.attr}>
            <dt className={styles.attrLabel}>Добавлено</dt>
            <dd className={styles.attrValue}>
              <time dateTime={вещь.датаСоздания}>{форматДаты(вещь.датаСоздания)}</time>
            </dd>
          </div>
        </dl>

        {ошибка !== null && (
          <ErrorNotice
            message={ошибка}
            onRetry={
              ошибка === ОШИБКА_ЧТЕНИЯ ? () => setПопытка((текущая) => текущая + 1) : undefined
            }
          />
        )}

        <section className={styles.section} aria-label="Категория">
          <h2 className={styles.sectionTitle}>Категория</h2>
          <CategoryPicker
            категория={вещь.категория}
            подкатегория={вещь.подкатегория}
            needsReview={false}
            onChange={(категория, подкатегория) => {
              void сохранитьКатегорию(категория, подкатегория)
            }}
          />
        </section>

        <section className={styles.section} aria-label="Сезон">
          <h2 className={styles.sectionTitle}>Сезон</h2>
          <div className={styles.chips} role="group" aria-label="Сезон вещи">
            {СЕЗОНЫ.map((сезон) => {
              const выбран = вещь.сезон.includes(сезон)
              return (
                <button
                  key={сезон}
                  type="button"
                  aria-pressed={выбран}
                  className={выбран ? `${styles.chip} ${styles.chipActive}` : styles.chip}
                  onClick={() => переключитьСезон(сезон)}
                >
                  {сезон}
                </button>
              )
            })}
          </div>
        </section>

        <section className={styles.section} aria-label="Цвета">
          <h2 className={styles.sectionTitle}>Цвета</h2>
          <div className={styles.chips} role="group" aria-label="Цвета вещи">
            {цветаДляПравки.map((цвет) => {
              const выбран = вещь.цвета.includes(цвет)
              return (
                <button
                  key={цвет}
                  type="button"
                  aria-pressed={выбран}
                  className={выбран ? `${styles.chip} ${styles.chipActive}` : styles.chip}
                  onClick={() => переключитьЦвет(цвет)}
                >
                  {цвет}
                </button>
              )
            })}
          </div>
        </section>

        <section className={styles.section} aria-label="AI-версия">
          <h2 className={styles.sectionTitle}>AI-версия</h2>
          <GenerationModelPicker
            models={моделиГенерации}
            value={выбраннаяМодель.slug}
            onChange={выбратьМодель}
          />
          <div className={styles.generateRow}>
            <button
              className={styles.generate}
              type="button"
              disabled={генерация}
              onClick={() => {
                // «Перегенерировать» (AI-версия уже есть) обязана генерировать
                // заново; «Сделать AI-версию» — обычный идемпотентный запуск.
                void сделатьAiВерсию(ai !== undefined)
              }}
            >
              {генерация
                ? 'Готовим AI-версию…'
                : ai === undefined
                  ? 'Сделать AI-версию'
                  : 'Перегенерировать'}
            </button>
            <span className={styles.generatePrice}>{выбраннаяМодель.priceRub} ₽ за кадр</span>
          </div>
        </section>

        <section className={styles.section} aria-label="Удаление">
          <h2 className={styles.sectionTitle}>Удаление</h2>
          {!подтверждениеУдаления && (
            <button
              className={styles.danger}
              type="button"
              onClick={() => setПодтверждениеУдаления(true)}
            >
              Удалить вещь
            </button>
          )}
          {подтверждениеУдаления && (
            <div className={styles.confirm} role="alertdialog" aria-label="Подтверждение удаления">
              <p className={styles.confirmText}>
                Удалить вещь безвозвратно? Оригинал и AI-версия тоже будут удалены.
              </p>
              <div className={styles.confirmActions}>
                <button
                  className={styles.confirmDelete}
                  type="button"
                  onClick={() => {
                    void удалитьВещьОкончательно()
                  }}
                >
                  Удалить
                </button>
                <button
                  className={styles.confirmCancel}
                  type="button"
                  onClick={() => setПодтверждениеУдаления(false)}
                >
                  Отмена
                </button>
              </div>
            </div>
          )}
        </section>
      </article>
    </section>
  )
}
