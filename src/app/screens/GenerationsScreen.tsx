import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  downloadHistoryImage,
  listGenerationHistory,
  restoreGeneration,
  type GenerationRecord,
} from '../../services/generations-history'
import { TidyApiError } from '../../services/tidy-api'
import { readAccessToken } from '../../storage/settings'
import { ErrorNotice } from '../../ui/ErrorNotice'
import screenStyles from './Screen.module.css'
import styles from './GenerationsScreen.module.css'

type Состояние = 'загрузка' | 'готово' | 'ошибка'

/** Превью грузятся с ограничением параллелизма: лимитер воркера — 60/мин. */
const ПРЕВЬЮ_ОДНОВРЕМЕННО = 2

/** Понятный текст ошибки истории: 401 и 429 у воркера свои коды и своя тактика. */
function текстОшибки(error: unknown): string {
  if (error instanceof TidyApiError) {
    switch (error.code) {
      case 'unauthorized':
        return 'Сервис отклонил запрос: токен не подошёл. Введите его заново.'
      case 'not_configured':
        return 'Сервис не настроен: владелец приложения не задал токены доступа.'
      case 'rate_limited':
        return 'Слишком много запросов. Подождите минуту и попробуйте снова.'
      case 'network':
        return 'Не удалось связаться с сервисом. Проверьте интернет и попробуйте снова.'
      case 'timeout':
        return 'Сервис не ответил вовремя. Попробуйте ещё раз.'
      case 'invalid_response':
        return 'Сервис вернул некорректный ответ. Попробуйте обновить список.'
      default:
        return error.message
    }
  }
  return 'Что-то пошло не так. Попробуйте ещё раз.'
}

function форматДаты(iso: string): string {
  const дата = new Date(iso)
  if (Number.isNaN(дата.getTime())) return '—'
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(
    дата,
  )
}

/** Категория / подкатегория из метаданных генерации; пусто — честное «Без категории». */
function меткаКатегории(запись: GenerationRecord): string {
  const части = [запись.category?.trim(), запись.subcategory?.trim()].filter(
    (часть): часть is string => часть !== undefined && часть !== '',
  )
  return части.length === 0 ? 'Без категории' : части.join(' / ')
}

/** Модель и цена генерации: что успел запомнить воркер. */
function меткаМодели(запись: GenerationRecord): string {
  const части: string[] = []
  if (запись.model.trim() !== '') части.push(запись.model.trim())
  if (запись.costRub !== null) части.push(`${запись.costRub} ₽`)
  return части.join(' · ')
}

interface CardProps {
  запись: GenerationRecord
  превью: string | undefined
  busy: boolean
  восстановленныйId: string | undefined
  onЗабрать: (запись: GenerationRecord) => void
}

/** Карточка генерации: превью, метаданные и кнопка «Забрать в гардероб». */
function Карточка({ запись, превью, busy, восстановленныйId, onЗабрать }: CardProps) {
  const название = запись.title.trim() === '' ? 'Без названия' : запись.title.trim()
  const модель = меткаМодели(запись)

  return (
    <li className={styles.card}>
      <div className={styles.preview}>
        {превью !== undefined && (
          <img
            className={styles.previewImage}
            src={превью}
            alt={название}
            loading="lazy"
            decoding="async"
          />
        )}
      </div>
      <div className={styles.info}>
        <span className={styles.name}>{название}</span>
        <span className={styles.meta}>{меткаКатегории(запись)}</span>
        <span className={styles.meta}>
          {форматДаты(запись.createdAt)}
          {модель !== '' ? ` · ${модель}` : ''}
        </span>
      </div>
      {восстановленныйId === undefined ? (
        <button
          className={styles.restore}
          type="button"
          disabled={busy}
          onClick={() => onЗабрать(запись)}
        >
          {busy ? 'Забираем…' : 'Забрать в гардероб'}
        </button>
      ) : (
        <div className={styles.restored}>
          <span className={styles.restoredLabel}>Уже в гардеробе</span>
          <Link className={styles.openLink} to={`/item/${восстановленныйId}`}>
            Открыть вещь
          </Link>
        </div>
      )}
    </li>
  )
}

/**
 * Экран истории генераций (T23): всё, что воркер сохранил в KV при скачивании
 * AI-версий. Превью грузятся с ограничением параллелизма и не роняют список —
 * одна битая картинка даёт пустую заглушку, а не сломанный экран.
 */
export function GenerationsScreen() {
  const [токен] = useState<string | null>(() => readAccessToken())
  const [состояние, setСостояние] = useState<Состояние>('загрузка')
  const [записи, setЗаписи] = useState<GenerationRecord[]>([])
  const [ошибка, setОшибка] = useState<string | null>(null)
  const [нетДоступа, setНетДоступа] = useState(false)
  const [попытка, setПопытка] = useState(0)
  const [превью, setПревью] = useState<Map<string, string>>(new Map())
  const [восстанавливается, setВосстанавливается] = useState<string | null>(null)
  const [восстановлено, setВосстановлено] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (токен === null) return
    let активен = true
    setСостояние('загрузка')
    setОшибка(null)
    setНетДоступа(false)

    void (async () => {
      try {
        const список = await listGenerationHistory()
        if (!активен) return
        setЗаписи(список)
        setСостояние('готово')
      } catch (cause) {
        if (!активен) return
        setОшибка(текстОшибки(cause))
        setНетДоступа(cause instanceof TidyApiError && cause.code === 'unauthorized')
        setСостояние('ошибка')
      }
    })()

    return () => {
      активен = false
    }
  }, [токен, попытка])

  // Превью в очередь с параллелизмом 2: одна загрузка не конкурирует с пачкой,
  // object URL-ы освобождаются при смене списка и при размонтировании.
  useEffect(() => {
    if (состояние !== 'готово' || записи.length === 0) return
    let жив = true
    const созданные: string[] = []
    const очередь = [...записи]
    let активных = 0

    const дальше = (): void => {
      while (жив && активных < ПРЕВЬЮ_ОДНОВРЕМЕННО) {
        const запись = очередь.shift()
        if (запись === undefined) return
        активных += 1
        void downloadHistoryImage(запись.taskId)
          .then((blob) => {
            if (!жив) return
            const url = URL.createObjectURL(blob)
            созданные.push(url)
            setПревью((текущее) => new Map(текущее).set(запись.taskId, url))
          })
          .catch(() => {
            // Одно битое превью — заглушка в карточке, не падение экрана.
          })
          .finally(() => {
            активных -= 1
            if (жив) дальше()
          })
      }
    }
    дальше()

    return () => {
      жив = false
      for (const url of созданные) URL.revokeObjectURL(url)
    }
  }, [состояние, записи])

  function забрать(запись: GenerationRecord): void {
    setОшибка(null)
    setНетДоступа(false)
    setВосстанавливается(запись.taskId)
    void restoreGeneration(запись)
      .then((итог) => {
        setВосстановлено((текущее) => new Map(текущее).set(запись.taskId, итог.itemId))
      })
      .catch((cause: unknown) => {
        setОшибка(текстОшибки(cause))
        setНетДоступа(cause instanceof TidyApiError && cause.code === 'unauthorized')
      })
      .finally(() => {
        setВосстанавливается(null)
      })
  }

  if (токен === null) {
    return (
      <section className={screenStyles.screen}>
        <h1 className={screenStyles.title}>Генерации</h1>
        <div className={screenStyles.placeholder}>
          <p className={screenStyles.placeholderText}>
            История генераций хранится на сервере. Чтобы видеть её здесь, введите токен доступа.
          </p>
          <Link className={styles.accessLink} to="/access">
            Ввести токен
          </Link>
        </div>
      </section>
    )
  }

  return (
    <section className={screenStyles.screen}>
      <header className={styles.header}>
        <h1 className={screenStyles.title}>Генерации</h1>
        <button
          className={styles.refresh}
          type="button"
          aria-label="Обновить историю генераций"
          onClick={() => setПопытка((текущая) => текущая + 1)}
        >
          Обновить
        </button>
      </header>

      {состояние === 'загрузка' && (
        <p className={styles.status} role="status" aria-live="polite">
          Загружаем генерации…
        </p>
      )}

      {состояние === 'ошибка' && (
        <>
          <ErrorNotice
            message={ошибка ?? ''}
            onRetry={() => setПопытка((текущая) => текущая + 1)}
          />
          {нетДоступа && (
            <Link className={styles.accessLink} to="/access">
              Ввести токен
            </Link>
          )}
        </>
      )}

      {состояние === 'готово' && записи.length === 0 && (
        <div className={screenStyles.placeholder}>
          <p className={screenStyles.placeholderText}>Пока нет сохранённых генераций</p>
        </div>
      )}

      {состояние === 'готово' && записи.length > 0 && (
        <ul className={styles.list}>
          {записи.map((запись) => (
            <Карточка
              key={запись.taskId}
              запись={запись}
              превью={превью.get(запись.taskId)}
              busy={восстанавливается === запись.taskId}
              восстановленныйId={восстановлено.get(запись.taskId)}
              onЗабрать={забрать}
            />
          ))}
        </ul>
      )}

      {ошибка !== null && состояние === 'готово' && (
        <>
          <ErrorNotice message={ошибка} />
          {нетДоступа && (
            <Link className={styles.accessLink} to="/access">
              Ввести токен
            </Link>
          )}
        </>
      )}
    </section>
  )
}
