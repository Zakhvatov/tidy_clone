import { useCallback, useEffect, useState } from 'react'

import { appDigitizeQueue, type QueueProgress } from '../services/digitize-queue'
import { loadJobs } from '../storage/jobs'

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
  /** Задачи генерации, чью картинку уже можно забрать (ADR-0006). */
  readyCount: number
  /** Забор идёт прямо сейчас. */
  grabbing: boolean
  /** Итог последнего забора: сколько забрали, сколько ещё ждут. */
  grabMessage: string | null
  /** «Забрать готовое»: сохраняет уже сгенерированные картинки без новых оплат. */
  grab: () => Promise<void>
}

const ОШИБКА_ЗАПУСКА = 'Не удалось запустить оцифровку. Попробуйте ещё раз'
const ОШИБКА_ЗАБОРА = 'Не удалось забрать готовое. Попробуйте ещё раз'

/** Человекочитаемый итог забора: одна строка вида «забрали 2, ещё ждут 1». */
function текстИтога(сохранено: number, ждут: number, неудачно: number): string {
  const части: string[] = []
  if (сохранено > 0) части.push(`забрали ${сохранено}`)
  if (ждут > 0) части.push(`ещё ждут ${ждут}`)
  if (неудачно > 0) части.push(`не удалось ${неудачно}`)
  if (части.length === 0) return 'Забирать нечего — картинок ещё нет'
  return `Готовое: ${части.join(', ')}`
}

/**
 * Связывает панель с очередью оцифровки (`src/services/digitize-queue.ts`).
 *
 * Очередь — синглтон приложения: состояние живёт в IndexedDB, поэтому панель
 * только подписывается на прогресс и зовёт `start`/`resume`/`stop`. Возобновление
 * **не** запускается само: генерация без нажатия запрещена, поэтому экран лишь
 * показывает кнопку «Продолжить оцифровку».
 *
 * Отдельно — «Забрать готовое» (ADR-0006): считает задачи с `taskId`, чьи
 * картинки провайдер уже отдал, и забирает их одним нажатием. Счётчик
 * пересчитывается при монтировании, при возврате на видимую вкладку и после
 * запусков — новые задачи появляются по нажатию, видимость может их завершить.
 */
export function useDigitizeQueue(): DigitizeQueueApi {
  const [progress, setProgress] = useState<QueueProgress>(() => appDigitizeQueue.progress)
  const [startError, setStartError] = useState<string | null>(null)
  const [readyCount, setReadyCount] = useState(0)
  const [grabbing, setGrabbing] = useState(false)
  const [grabMessage, setGrabMessage] = useState<string | null>(null)

  const recount = useCallback(async () => {
    try {
      const jobs = await loadJobs()
      setReadyCount(jobs.filter((job) => job.taskId !== undefined && job.статус !== 'не удалось').length)
    } catch {
      // Хранилище недоступно: кнопку просто не показываем, панель работает.
      setReadyCount(0)
    }
  }, [])

  useEffect(() => {
    const unsubscribe = appDigitizeQueue.subscribe(setProgress)
    // Подтягиваем сохранённую очередь: экран должен показать «Продолжить».
    void appDigitizeQueue.refresh()
    void recount()
    // Вернулись из фона: задачи могли завершиться у провайдера.
    const onVisible = () => {
      if (!document.hidden) void recount()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [recount])

  const start = useCallback(async () => {
    setStartError(null)
    try {
      await appDigitizeQueue.start()
    } catch {
      setStartError(ОШИБКА_ЗАПУСКА)
    } finally {
      void recount()
    }
  }, [recount])

  const resume = useCallback(async () => {
    setStartError(null)
    try {
      await appDigitizeQueue.resume()
    } catch {
      setStartError(ОШИБКА_ЗАПУСКА)
    } finally {
      void recount()
    }
  }, [recount])

  const stop = useCallback(() => {
    appDigitizeQueue.stop()
  }, [])

  const grab = useCallback(async () => {
    setGrabbing(true)
    setGrabMessage(null)
    try {
      const итог = await appDigitizeQueue.grabReady()
      setGrabMessage(
        итог.последняяОшибка ?? текстИтога(итог.сохранено, итог.ждут, итог.неудачно),
      )
    } catch {
      setGrabMessage(ОШИБКА_ЗАБОРА)
    } finally {
      setGrabbing(false)
      void recount()
    }
  }, [recount])

  const busy = progress.статус === 'выполняется'
  const resumable =
    !busy && progress.осталось > 0 && (progress.статус === 'остановлена' || progress.статус === 'ожидает')

  return {
    progress,
    busy,
    resumable,
    startError,
    start,
    resume,
    stop,
    readyCount,
    grabbing,
    grabMessage,
    grab,
  }
}
