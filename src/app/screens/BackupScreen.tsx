import { useRef, useState } from 'react'

import {
  ОшибкаРезервнойКопии,
  applyImport,
  exportWardrobe,
  prepareImport,
  скачатьФайл,
  type ИтогИмпорта,
  type ПодготовленныйИмпорт,
  type СчётчикиИмпорта,
} from '../../services/backup'
import { ErrorNotice } from '../../ui/ErrorNotice'
import screenStyles from './Screen.module.css'
import styles from './BackupScreen.module.css'

type Фаза = 'покой' | 'экспорт' | 'чтение' | 'подтверждение' | 'импорт'

/** Склоняет существительное после числа: 1 вещь, 2 вещи, 5 вещей. */
function склонение(число: number, один: string, два: string, много: string): string {
  const остаток = число % 100
  if (остаток >= 11 && остаток <= 14) return много
  switch (число % 10) {
    case 1:
      return один
    case 2:
    case 3:
    case 4:
      return два
    default:
      return много
  }
}

/** «3 вещи, 5 изображений, 1 образ» — компактная подпись для счётчиков. */
function описаниеСчётчиков(счётчики: СчётчикиИмпорта): string {
  const части = [
    `${счётчики.вещи} ${склонение(счётчики.вещи, 'вещь', 'вещи', 'вещей')}`,
    `${счётчики.изображения} ${склонение(счётчики.изображения, 'изображение', 'изображения', 'изображений')}`,
    `${счётчики.образы} ${склонение(счётчики.образы, 'образ', 'образа', 'образов')}`,
  ]
  return части.join(', ')
}

/** Свои ошибки показываем как есть, чужие — общим текстом. */
function сообщениеОбОшибке(error: unknown): string {
  if (error instanceof ОшибкаРезервнойКопии) return error.message
  return 'Что-то пошло не так. Попробуйте ещё раз'
}

/**
 * Экран резервной копии (T19): весь гардероб одним файлом туда и обратно.
 *
 * Облака нет, поэтому экспорт и импорт — ручные и локальные: файл собирается
 * из IndexedDB и скачивается браузером, а выбранный файл сначала проверяется
 * и показывается план («что будет сделано»), и только потом пишется в базу.
 * Интернет для этого не нужен.
 */
export function BackupScreen() {
  const [фаза, setФаза] = useState<Фаза>('покой')
  const [ошибка, setОшибка] = useState<string | null>(null)
  const [экспортИтог, setЭкспортИтог] = useState<СчётчикиИмпорта | null>(null)
  const [подготовленный, setПодготовленный] = useState<ПодготовленныйИмпорт | null>(null)
  const [итог, setИтог] = useState<ИтогИмпорта | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const busy = фаза === 'экспорт' || фаза === 'чтение' || фаза === 'импорт'

  async function экспортировать() {
    setОшибка(null)
    setИтог(null)
    setЭкспортИтог(null)
    setФаза('экспорт')
    try {
      const { blob, имяФайла, счётчики } = await exportWardrobe()
      скачатьФайл(имяФайла, blob)
      setЭкспортИтог(счётчики)
    } catch (error) {
      setОшибка(сообщениеОбОшибке(error))
    } finally {
      setФаза('покой')
    }
  }

  async function выбратьФайл(file: File) {
    setОшибка(null)
    setИтог(null)
    setПодготовленный(null)
    setФаза('чтение')
    try {
      const подготовка = await prepareImport(file)
      setПодготовленный(подготовка)
      setФаза('подтверждение')
    } catch (error) {
      setОшибка(сообщениеОбОшибке(error))
      setФаза('покой')
    }
  }

  async function подтвердить() {
    if (подготовленный === null) return
    setОшибка(null)
    setФаза('импорт')
    try {
      const результат = await applyImport(подготовленный)
      setИтог(результат)
      setПодготовленный(null)
      setФаза('покой')
    } catch (error) {
      setОшибка(сообщениеОбОшибке(error))
      setФаза('подтверждение')
    }
  }

  function отменить() {
    setПодготовленный(null)
    setФаза('покой')
  }

  return (
    <section className={screenStyles.screen}>
      <h1 className={screenStyles.title}>Резервная копия</h1>
      <p className={styles.lead}>
        Весь гардероб — вещи, изображения и образы — сохраняется одним файлом. Файл можно открыть
        на другом устройстве. Работает без интернета: данные не покидают телефон.
      </p>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Экспорт</h2>
        <p className={styles.cardText}>Сохранить весь гардероб в один файл на устройство.</p>
        <button
          className={styles.primary}
          type="button"
          disabled={busy}
          onClick={() => void экспортировать()}
        >
          {фаза === 'экспорт' ? 'Собираем файл…' : 'Экспортировать гардероб'}
        </button>
        {экспортИтог !== null && (
          <p className={styles.success} role="status" aria-live="polite">
            Файл сохранён: {описаниеСчётчиков(экспортИтог)}.
          </p>
        )}
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Импорт</h2>
        <p className={styles.cardText}>
          Восстановить гардероб из файла. Существующие вещи не удаляются: новые добавятся,
          изменившиеся обновятся.
        </p>
        <label
          className={`${styles.fileButton} ${busy ? styles.fileButtonDisabled : ''}`}
          aria-disabled={busy}
        >
          Выбрать файл резервной копии
          <input
            ref={fileRef}
            className={styles.fileInput}
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              // Сброс значения: повторный выбор того же файла снова поднимет change.
              event.target.value = ''
              if (file !== undefined) void выбратьФайл(file)
            }}
          />
        </label>

        {фаза === 'чтение' && (
          <p className={styles.progress} role="status" aria-live="polite">
            Читаем и проверяем файл…
          </p>
        )}

        {подготовленный !== null && (
          <div className={styles.plan} role="status" aria-live="polite">
            <p className={styles.planLine}>
              В файле: {описаниеСчётчиков(подготовленный.вФайле)}.
            </p>
            <p className={styles.planLine}>
              Будет добавлено: {описаниеСчётчиков(подготовленный.план.добавлено)}.
            </p>
            <p className={styles.planLine}>
              Обновлено: {описаниеСчётчиков(подготовленный.план.обновлено)}; пропущено:{' '}
              {описаниеСчётчиков(подготовленный.план.пропущено)}.
            </p>
            <div className={styles.actions}>
              <button
                className={styles.primary}
                type="button"
                disabled={busy}
                onClick={() => void подтвердить()}
              >
                {фаза === 'импорт' ? 'Импортируем…' : 'Импортировать'}
              </button>
              <button
                className={styles.secondary}
                type="button"
                disabled={busy}
                onClick={отменить}
              >
                Отмена
              </button>
            </div>
          </div>
        )}

        {итог !== null && (
          <p className={styles.success} role="status" aria-live="polite">
            Импорт завершён. Добавлено: {описаниеСчётчиков(итог.добавлено)}; обновлено:{' '}
            {описаниеСчётчиков(итог.обновлено)}; пропущено: {описаниеСчётчиков(итог.пропущено)}.
          </p>
        )}
      </section>

      {ошибка !== null && <ErrorNotice message={ошибка} />}
    </section>
  )
}
