import styles from './ErrorNotice.module.css'

interface ErrorNoticeProps {
  message: string
  onRetry?: () => void
}

/** Понятное сообщение об ошибке с повторной попыткой без перезагрузки страницы. */
export function ErrorNotice({ message, onRetry }: ErrorNoticeProps) {
  return (
    <div className={styles.notice} role="alert">
      <p className={styles.message}>{message}</p>
      {onRetry && (
        <button className={styles.retry} type="button" onClick={onRetry}>
          Повторить
        </button>
      )}
    </div>
  )
}
