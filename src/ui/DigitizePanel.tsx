import { useDigitizeQueue } from './useDigitizeQueue'
import { OfflineNotice } from './OfflineNotice'
import { useOnline } from './useOnline'
import styles from './DigitizePanel.module.css'

/** Понятный текст статуса очереди для панели. */
function статусТекст(статус: string): string {
  switch (статус) {
    case 'выполняется':
      return 'Оцифровываем…'
    case 'остановлена':
      return 'Оцифровка остановлена'
    case 'завершена':
      return 'Оцифровка завершена'
    default:
      return 'Оцифровка'
  }
}

/**
 * Панель массовой оцифровки на экране гардероба (T12 + ADR-0006).
 *
 * Кнопка запускает «Оцифровать всё, где нет пакшота»: вещи без выреза и без
 * AI-версии. Пока очередь идёт — прогресс (обработано/всего, успехи, ошибки,
 * текущая вещь) и кнопка «Остановить». Если приложение закрыли на середине,
 * панель предлагает «Продолжить оцифровку» — сама очередь не запускается:
 * генерация без нажатия запрещена.
 *
 * Если висят задачи генерации, пережившие закрытие вкладки, поверх появляется
 * «Забрать готовое (N)» — разовый забор уже сгенерированных картинок без
 * новых оплат.
 *
 * Компонент самодостаточен: он один знает про очередь, поэтому врезка в
 * `WardrobeScreen` — одна строка.
 */
export function DigitizePanel() {
  const { progress, busy, resumable, startError, start, resume, stop, readyCount, grabbing, grabMessage, grab } =
    useDigitizeQueue()
  const online = useOnline()

  const всего = progress.всего
  const обработано = progress.обработано
  const процент = всего > 0 ? Math.round((обработано / всего) * 100) : 0
  const показыватьПрогресс = всего > 0

  return (
    <section className={styles.panel}>
      {!online && <OfflineNotice />}
      {!busy && readyCount > 0 && (
        <div className={styles.grabRow}>
          <button className={styles.primary} type="button" disabled={grabbing} onClick={() => void grab()}>
            {grabbing ? 'Забираем готовое…' : `Забрать готовое (${readyCount})`}
          </button>
        </div>
      )}
      {grabMessage !== null && (
        <p className={styles.line} role="status" aria-live="polite">
          {grabMessage}
        </p>
      )}
      <div className={styles.header}>
        <h2 className={styles.title}>{статусТекст(progress.статус)}</h2>
        {busy ? (
          <button className={styles.secondary} type="button" onClick={stop}>
            Остановить
          </button>
        ) : resumable ? (
          <button className={styles.primary} type="button" onClick={() => void resume()}>
            Продолжить оцифровку
          </button>
        ) : (
          <button className={styles.primary} type="button" onClick={() => void start()}>
            Оцифровать всё, где нет пакшота
          </button>
        )}
      </div>

      {показыватьПрогресс && (
        <div className={styles.body} role="status" aria-live="polite">
          <div
            className={styles.track}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={всего}
            aria-valuenow={обработано}
            aria-valuetext={`${обработано} из ${всего}`}
          >
            <span className={styles.fill} style={{ width: `${процент}%` }} />
          </div>
          <p className={styles.line}>
            Обработано {обработано} из {всего} · успешно {progress.успехов} · ошибок {progress.ошибок}
          </p>
          {busy && progress.текущая !== undefined && (
            <p className={styles.current}>Сейчас: {progress.текущая}</p>
          )}
          {progress.последняяОшибка !== undefined && (
            <p className={styles.error}>{progress.последняяОшибка}</p>
          )}
        </div>
      )}

      {!busy && progress.статус === 'завершена' && всего === 0 && (
        <p className={styles.line}>Всё уже оцифровано</p>
      )}

      {startError !== null && (
        <p className={styles.error} role="alert">
          {startError}
        </p>
      )}
    </section>
  )
}
