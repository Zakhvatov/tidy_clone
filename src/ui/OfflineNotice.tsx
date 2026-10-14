import styles from './OfflineNotice.module.css'

/**
 * Понятный индикатор отсутствия сети. Ставится на экранах, где без интернета
 * ничего не выйдет (импорт по ссылке, распознавание и оцифровка фото), чтобы
 * пользователь не увидел загадочную ошибку запроса.
 */
export function OfflineNotice() {
  return (
    <div className={styles.notice} role="status" aria-live="polite">
      <span className={styles.dot} aria-hidden="true" />
      <p className={styles.text}>
        Нет сети. Это действие требует интернета — подключитесь и попробуйте снова. Гардероб
        остаётся доступен офлайн.
      </p>
    </div>
  )
}
