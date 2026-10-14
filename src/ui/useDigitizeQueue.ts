import { useCallback, useEffect, useState } from 'react'

import { appDigitizeQueue, type QueueProgress } from '../services/digitize-queue'

/** То, что панель оцифровки показывает и умеет. */
export interface DigitizeQueueApi {
  progress: QueueProgress
  /** Очередь обрабатывается прямо сейчас. */
  busy: boolean
  /** Незавершённая очередь, которую можно продолжить (после закрытия приложения). */
  resumable: boolean
  /** Ошибка запуска/возобновления (сбой хранилища), а не ошибка отдельной вещи. */
  startError: string | null
  start: () => Promise<void>
  resume: () => Promise<void>
  stop: () => void
}

const ОШИБКА_ЗАПУСКА = 'Не удалось запустить оцифровку. Попробуйте ещё раз'

/**
 * Связывает панель с очередью оцифровки (`src/services/digitize-queue.ts`).
 *
 * Очередь — синглтон приложения: состояние живёт в IndexedDB, поэтому панель
 * только подписывается на прогресс и зовёт `start`/`resume`/`stop`. Возобновление
 * **не** запускается само: генерация без нажатия запрещена, поэтому экран лишь
 * показывает кнопку «Продолжить оцифровку».
 */
export function useDigitizeQueue(): DigitizeQueueApi {
  const [progress, setProgress] = useState<QueueProgress>(() => appDigitizeQueue.progress)
  const [startError, setStartError] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribe = appDigitizeQueue.subscribe(setProgress)
    // Подтягиваем сохранённую очередь: экран должен показать «Продолжить».
    void appDigitizeQueue.refresh()
    return unsubscribe
  }, [])

  const start = useCallback(async () => {
    setStartError(null)
    try {
      await appDigitizeQueue.start()
    } catch {
      setStartError(ОШИБКА_ЗАПУСКА)
    }
  }, [])

  const resume = useCallback(async () => {
    setStartError(null)
    try {
      await appDigitizeQueue.resume()
    } catch {
      setStartError(ОШИБКА_ЗАПУСКА)
    }
  }, [])

  const stop = useCallback(() => {
    appDigitizeQueue.stop()
  }, [])

  const busy = progress.статус === 'выполняется'
  const resumable =
    !busy && progress.осталось > 0 && (progress.статус === 'остановлена' || progress.статус === 'ожидает')

  return { progress, busy, resumable, startError, start, resume, stop }
}
