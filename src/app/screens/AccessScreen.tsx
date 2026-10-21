import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { TidyApiError, validateAccessToken } from '../../services/tidy-api'
import {
  clearAccessToken,
  maskedAccessToken,
  readAccessToken,
  saveAccessToken,
} from '../../storage/settings'
import { ErrorNotice } from '../../ui/ErrorNotice'
import screenStyles from './Screen.module.css'
import styles from './AccessScreen.module.css'

/** Понятный текст для проверки токена: причина важнее общего «не получилось». */
function сообщениеОбОшибке(error: unknown): string {
  if (error instanceof TidyApiError) {
    switch (error.code) {
      case 'unauthorized':
        return 'Токен не подошёл. Проверьте его и попробуйте снова.'
      case 'not_configured':
        return 'Сервис не настроен: владелец приложения не задал токены доступа.'
      case 'network':
        return 'Не удалось связаться с сервисом. Проверьте интернет и попробуйте снова.'
      case 'timeout':
        return 'Сервис не ответил вовремя. Попробуйте ещё раз.'
      case 'rate_limited':
        return 'Слишком много проверок. Подождите минуту и попробуйте снова.'
      default:
        return error.message
    }
  }
  return 'Не удалось проверить токен. Попробуйте ещё раз.'
}

/**
 * Экран доступа к генерации (T22).
 *
 * Токен выдаёт владелец приложения, а не магазин или аккаунт. Пользователь
 * вводит его один раз: приложение проверяет токен дешёвым `GET /session`,
 * сохраняет на этом устройстве и дальше подставляет в каждый запрос к воркеру.
 * Токен не попадает в публичный бандл и не покидает телефон, кроме как
 * в заголовке запроса к воркеру.
 */
export function AccessScreen() {
  const [текущий, setТекущий] = useState<string | null>(() => readAccessToken())
  const [ввод, setВвод] = useState('')
  const [ошибка, setОшибка] = useState<string | null>(null)
  const [успех, setУспех] = useState<string | null>(null)
  const [проверка, setПроверка] = useState(false)

  async function проверитьИСохранить(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const кандидат = ввод.trim()
    if (кандидат === '') {
      setУспех(null)
      setОшибка('Введите токен доступа.')
      return
    }

    setПроверка(true)
    setОшибка(null)
    setУспех(null)
    try {
      await validateAccessToken(кандидат)
      saveAccessToken(кандидат)
      setТекущий(кандидат)
      setВвод('')
      setУспех('Токен сохранён на этом устройстве.')
    } catch (error) {
      setОшибка(сообщениеОбОшибке(error))
    } finally {
      setПроверка(false)
    }
  }

  function забыть() {
    clearAccessToken()
    setТекущий(null)
    setВвод('')
    setОшибка(null)
    setУспех('Токен удалён с этого устройства.')
  }

  return (
    <section className={screenStyles.screen}>
      <h1 className={screenStyles.title}>Доступ к генерации</h1>
      <p className={styles.lead}>
        AI-версии и распознавание категорий работают через сервис генерации. Токен выдаёт
        владелец приложения — он хранится только на этом устройстве и не попадает в сборку.
      </p>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Текущий токен</h2>
        {текущий === null ? (
          <p className={styles.status}>Токен не задан. Без него доступны только гардероб и образы.</p>
        ) : (
          <p className={styles.status}>
            Сохранён на устройстве: <code className={styles.token}>{maskedAccessToken(текущий)}</code>
          </p>
        )}
        {текущий !== null && (
          <button className={styles.secondary} type="button" onClick={забыть}>
            Забыть токен
          </button>
        )}
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Ввести токен</h2>
        <p className={styles.cardText}>
          Вставьте токен доступа и проверьте его. Приложение сохранит токен, только если сервис
          его примет.
        </p>
        <form className={styles.form} onSubmit={(event) => void проверитьИСохранить(event)}>
          <label className={styles.label} htmlFor="access-token">
            Токен доступа
          </label>
          <input
            id="access-token"
            className={styles.input}
            type="password"
            value={ввод}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={проверка}
            onChange={(event) => setВвод(event.target.value)}
          />
          <button className={styles.primary} type="submit" disabled={проверка}>
            {проверка ? 'Проверяем…' : 'Проверить и сохранить'}
          </button>
        </form>
        {успех !== null && (
          <p className={styles.success} role="status" aria-live="polite">
            {успех}
          </p>
        )}
        <div className={styles.actions}>
          <Link className={styles.linkButton} to="/backup">
            Вернуться в «Данные»
          </Link>
          <Link className={styles.linkButton} to="/generations">
            Открыть историю генераций
          </Link>
        </div>
      </section>

      {ошибка !== null && <ErrorNotice message={ошибка} />}
    </section>
  )
}
