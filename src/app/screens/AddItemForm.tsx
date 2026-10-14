import { useRef, useState } from 'react'

import {
  ОшибкаИмпортаВещи,
  createDraftFromLink,
  createDraftFromPhoto,
  собратьВещь,
  type ItemDraft,
} from '../../services/import-item'
import * as images from '../../storage/images'
import * as items from '../../storage/items'
import { ОшибкаХранилища } from '../../storage/errors'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { ItemPreview } from '../../ui/ItemPreview'
import { OfflineNotice } from '../../ui/OfflineNotice'
import { useOnline } from '../../ui/useOnline'
import styles from './AddScreen.module.css'

type Phase = 'idle' | 'loading' | 'ready' | 'saving'

/** Понятный русский текст: свои ошибки показываем как есть, чужие — общим текстом. */
function сообщениеОбОшибке(error: unknown): string {
  if (error instanceof ОшибкаИмпортаВещи || error instanceof ОшибкаХранилища) return error.message
  return 'Что-то пошло не так. Попробуйте ещё раз'
}

/** Скелетон превью, пока идёт загрузка или распознавание. */
function PreviewSkeleton() {
  return (
    <div className={styles.skeleton} role="status" aria-live="polite">
      <div className={styles.skeletonImage} aria-hidden="true" />
      <div className={styles.skeletonBody} aria-hidden="true">
        <span className={styles.skeletonLine} />
        <span className={styles.skeletonLineShort} />
      </div>
      <p className={styles.loadingText}>Загружаем вещь…</p>
    </div>
  )
}

interface AddItemFormProps {
  /** Вызывается после успешной записи Вещи и её Оригинала в хранилище. */
  onSaved: () => void
}

/**
 * Форма добавления вещи (T8): два входа — по ссылке Wildberries и по своему фото.
 * Категорию по ссылке даёт словарь WB, по фото — vision-модель; её всегда можно
 * поправить. Ни одно поле не обязательно — нужен только сам Оригинал.
 *
 * Компонент не знает о маршрутизации: экран добавления (`/add`) и пустой гардероб
 * (`/`) переиспользуют его, каждый по-своему реагируя на `onSaved`. Логика импорта
 * и записи в IndexedDB живёт здесь в одном месте и не дублируется.
 */
export function AddItemForm({ onSaved }: AddItemFormProps) {
  const [ссылка, setСсылка] = useState('')
  const [черновик, setЧерновик] = useState<ItemDraft | null>(null)
  const [фаза, setФаза] = useState<Phase>('idle')
  const [ошибка, setОшибка] = useState<string | null>(null)
  const retryRef = useRef<(() => void) | null>(null)
  const online = useOnline()

  const busy = фаза === 'loading' || фаза === 'saving'

  function повторить() {
    retryRef.current?.()
  }

  async function загрузитьПоСсылке() {
    setОшибка(null)
    setЧерновик(null)
    setФаза('loading')
    retryRef.current = () => {
      void загрузитьПоСсылке()
    }
    try {
      const draft = await createDraftFromLink(ссылка)
      setЧерновик(draft)
      setФаза('ready')
    } catch (error) {
      setОшибка(сообщениеОбОшибке(error))
      setФаза('idle')
    }
  }

  async function загрузитьПоФото(file: File) {
    setОшибка(null)
    setЧерновик(null)
    setФаза('loading')
    retryRef.current = () => {
      void загрузитьПоФото(file)
    }
    try {
      const draft = await createDraftFromPhoto(file)
      setЧерновик(draft)
      setФаза('ready')
    } catch (error) {
      setОшибка(сообщениеОбОшибке(error))
      setФаза('idle')
    }
  }

  async function сохранить() {
    if (черновик === null) return
    setОшибка(null)
    setФаза('saving')
    const { вещь, оригинал } = собратьВещь(черновик)
    try {
      await items.create(вещь)
      try {
        await images.addOriginal(оригинал)
      } catch (cause) {
        // Вещь без Оригинала — потеря: откатываем и сообщаем честно.
        await items.remove(вещь.id).catch(() => undefined)
        throw cause
      }
      onSaved()
    } catch (error) {
      setОшибка(сообщениеОбОшибке(error))
      setФаза('ready')
    }
  }

  return (
    <>
      <p className={styles.lead}>Вставьте ссылку с Wildberries или загрузите своё фото.</p>

      {!online && <OfflineNotice />}

      <form
        className={styles.linkForm}
        onSubmit={(event) => {
          event.preventDefault()
          void загрузитьПоСсылке()
        }}
      >
        <input
          className={styles.input}
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="Ссылка на товар с Wildberries"
          aria-label="Ссылка на товар"
          value={ссылка}
          onChange={(event) => setСсылка(event.target.value)}
          disabled={busy}
        />
        <button className={styles.submit} type="submit" disabled={busy || ссылка.trim() === ''}>
          Найти вещь
        </button>
      </form>

      <div className={styles.orGroup}>
        <span className={styles.orLine} aria-hidden="true" />
        <span className={styles.orText}>или</span>
        <span className={styles.orLine} aria-hidden="true" />
      </div>

      <label className={styles.fileButton}>
        Загрузить фото
        <input
          className={styles.fileInput}
          type="file"
          accept="image/*"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0]
            // Сброс значения: повторный выбор того же файла снова поднимет change.
            event.target.value = ''
            if (file !== undefined) void загрузитьПоФото(file)
          }}
        />
      </label>

      {ошибка !== null && (
        <ErrorNotice message={ошибка} onRetry={retryRef.current === null ? undefined : повторить} />
      )}
      {фаза === 'loading' && <PreviewSkeleton />}
      {фаза !== 'loading' && черновик !== null && (
        <ItemPreview
          черновик={черновик}
          saving={фаза === 'saving'}
          onChangeCategory={(категория, подкатегория) =>
            setЧерновик((current) =>
              current === null ? current : { ...current, категория, подкатегория, needsReview: false },
            )
          }
          onSave={() => {
            void сохранить()
          }}
        />
      )}
    </>
  )
}
