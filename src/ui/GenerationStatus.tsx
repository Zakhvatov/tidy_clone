import type { ЗадачаГенерации } from '../storage/jobs'
import styles from './GenerationStatus.module.css'

/** Понятный заголовок по статусу задачи (ADR-0006). */
function заголовок(job: ЗадачаГенерации): string {
  switch (job.статус) {
    case 'создаётся':
      return 'Ставим задачу генерации…'
    case 'ждёт':
      return 'Ждём картинку от сервиса…'
    case 'просрочена':
      return 'Ждали 5 минут — не дождались'
    case 'не удалось':
      return job.последняяОшибка ?? 'Сервис не смог сгенерировать изображение'
  }
}

interface GenerationStatusProps {
  job: ЗадачаГенерации
  /** Кнопка «Обновить»: немедленный опрос уже идущего прогона. */
  onRefresh: () => void
  /**
   * Кнопка «Повторить»: новый сеанс. Для `просрочена` — допрос той же задачи
   * (taskId жив), для `не удалось` — новая попытка с новым ключом.
   */
  onRetry: () => void
  /** Модель и цена — для строки «Nano Banana 2.1 · 10 ₽». */
  модель?: string
  цена?: number
}

/**
 * Статус-блок идущей или неудавшейся генерации (ADR-0006).
 *
 * Задача переживает закрытие вкладки, поэтому блок одинаков «сейчас» и
 * «вернулись в приложение»: в обоих случаях есть taskId и понятные кнопки.
 * Пока задача в `создаётся`/`ждёт` — кнопок нет, кроме «Обновить»: генерация
 * уже оплачена, второй запуск не нужен.
 */
export function GenerationStatus({ job, onRefresh, onRetry, модель, цена }: GenerationStatusProps) {
  const можно = job.статус === 'ждёт'
  const повторять = job.статус === 'просрочена' || job.статус === 'не удалось'
  const подпись = [модель, цена !== undefined ? `${цена} ₽` : undefined]
    .filter((часть): часть is string => часть !== undefined && часть !== '')
    .join(' · ')

  return (
    <div className={styles.block} role="status" aria-live="polite">
      <div className={styles.text}>
        <p className={styles.title}>{заголовок(job)}</p>
        {подпись !== '' && <p className={styles.meta}>{подпись}</p>}
        {можно && (
          <p className={styles.hint}>
            Можно закрыть экран — задача сохранится, картинку получится забрать позже
          </p>
        )}
      </div>
      <div className={styles.actions}>
        {можно && (
          <button className={styles.secondary} type="button" onClick={onRefresh}>
            Обновить
          </button>
        )}
        {повторять && (
          <button className={styles.primary} type="button" onClick={onRetry}>
            Повторить
          </button>
        )}
      </div>
    </div>
  )
}
