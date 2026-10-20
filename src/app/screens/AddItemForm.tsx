import { useEffect, useRef, useState } from 'react'

import {
  ОшибкаИмпортаВещи,
  createDraftFromPhoto,
  собратьВещь,
  type ItemDraft,
} from '../../services/import-item'
import * as images from '../../storage/images'
import * as items from '../../storage/items'
import { type ЗадачаГенерации } from '../../storage/jobs'
import { ОшибкаХранилища } from '../../storage/errors'
import { digitizeItem } from '../../services/digitize'
import { ОшибкаГенерации, activeGenerationRun } from '../../services/generation'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { GenerationModelPicker } from '../../ui/GenerationModelPicker'
import { GenerationStatus } from '../../ui/GenerationStatus'
import { ItemPreview } from '../../ui/ItemPreview'
import { OfflineNotice } from '../../ui/OfflineNotice'
import { useGenerationModels } from '../../ui/useGenerationModels'
import { useOnline } from '../../ui/useOnline'
import styles from './AddScreen.module.css'

type Phase = 'idle' | 'loading' | 'ready' | 'saving' | 'confirm' | 'generating'

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
  /** Вызывается после успешной записи Вещи — сразу или после AI-версии. */
  onSaved: () => void
}

/**
 * Форма добавления вещи (T8 + ADR-0006): вход по своему фото. Категорию даёт
 * vision-модель, её всегда можно поправить. Ни одно поле не обязательно —
 * нужен только сам Оригинал.
 *
 * Ссылочный вход из формы убран (ADR-0006 §1), модуль импорта WB при этом
 * остался: он обслуживает разбор уже сохранённых ссылок.
 *
 * Генерация — только по нажатию и только после подтверждения: вещь сначала
 * сохраняется (её видно в гардеробе), затем блок «Сделать AI-версию · N ₽» или
 * «Добавить без AI-версии». `onSaved` зовётся в конце любого из двух путей.
 */
export function AddItemForm({ onSaved }: AddItemFormProps) {
  const [черновик, setЧерновик] = useState<ItemDraft | null>(null)
  const [сохранённыйId, setСохранённыйId] = useState<string | null>(null)
  const [задача, setЗадача] = useState<ЗадачаГенерации | null>(null)
  const [фаза, setФаза] = useState<Phase>('idle')
  const [ошибка, setОшибка] = useState<string | null>(null)
  const retryRef = useRef<(() => void) | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const online = useOnline()
  const { models: моделиГенерации, selected: выбраннаяМодель, select: выбратьМодель } =
    useGenerationModels()

  // Уход с экрана действительно прекращает загрузку: без этого подвисшее
  // соединение продолжало бы тянуть фото в никуда после размонтирования.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
    }
  }, [])

  const busy = фаза === 'loading' || фаза === 'saving' || фаза === 'generating'

  function повторить() {
    retryRef.current?.()
  }

  /** Начинает новую загрузку, отменяя предыдущую незавершённую. */
  function начатьЗагрузку(): AbortController {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    return controller
  }

  async function загрузитьПоФото(file: File) {
    setОшибка(null)
    setЧерновик(null)
    setФаза('loading')
    retryRef.current = () => {
      void загрузитьПоФото(file)
    }
    const controller = начатьЗагрузку()
    try {
      const draft = await createDraftFromPhoto(file, { signal: controller.signal })
      if (controller.signal.aborted || !mountedRef.current) return
      setЧерновик(draft)
      setФаза('ready')
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current) return
      setОшибка(сообщениеОбОшибке(error))
      setФаза('idle')
    }
  }

  async function сохранить() {
    if (черновик === null) return
    setОшибка(null)
    setФаза('saving')
    // «Повторить» после ошибки сохранения повторяет именно запись, а не тянет
    // фото заново: данные уже загружены и лежат в черновике.
    retryRef.current = () => {
      void сохранить()
    }
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
      // Вещь уже в гардеробе. Генерация — отдельный шаг с подтверждением.
      setСохранённыйId(вещь.id)
      setФаза('confirm')
    } catch (error) {
      if (!mountedRef.current) return
      setОшибка(сообщениеОбОшибке(error))
      setФаза('ready')
    }
  }

  async function запуститьГенерацию(id: string, force = false) {
    setОшибка(null)
    setФаза('generating')
    retryRef.current = () => {
      void запуститьГенерацию(id, force)
    }
    try {
      await digitizeItem(id, {
        force,
        model: выбраннаяМодель.slug,
        onJobChange: (job) => setЗадача(job),
      })
      setЗадача(null)
      onSaved()
    } catch (error) {
      if (!mountedRef.current) return
      if (error instanceof ОшибкаГенерации) {
        // Судьбу задачи показывает GenerationStatus: «просрочена» (taskId жив,
        // «Повторить» допросит ту же задачу) или «не удалось» (новая попытка).
        return
      }
      setОшибка(сообщениеОбОшибке(error))
      setФаза('confirm')
    }
  }

  return (
    <>
      <p className={styles.lead}>Загрузите фото вещи — категорию определим автоматически.</p>

      {!online && <OfflineNotice />}

      {фаза !== 'confirm' && фаза !== 'generating' && (
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
      )}

      {ошибка !== null && (
        <ErrorNotice message={ошибка} onRetry={retryRef.current === null ? undefined : повторить} />
      )}
      {фаза === 'loading' && <PreviewSkeleton />}
      {(фаза === 'ready' || фаза === 'saving') && черновик !== null && (
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

      {(фаза === 'confirm' || фаза === 'generating') && сохранённыйId !== null && (
        <section className={styles.confirm} role="region" aria-label="AI-версия при добавлении">
          <p className={styles.confirmTitle}>Вещь сохранена. Сделать AI-версию?</p>

          {фаза === 'confirm' && (
            <GenerationModelPicker
              models={моделиГенерации}
              value={выбраннаяМодель.slug}
              onChange={выбратьМодель}
            />
          )}

          {фаза === 'generating' && задача !== null && (
            <GenerationStatus
              job={задача}
              модель={выбраннаяМодель.title}
              цена={выбраннаяМодель.priceRub}
              onRefresh={() => {
                const идущий = activeGenerationRun(задача.idВещи)
                if (идущий !== undefined) идущий.refresh()
                else void запуститьГенерацию(сохранённыйId, true)
              }}
              onRetry={() => {
                void запуститьГенерацию(сохранённыйId, true)
              }}
            />
          )}
          {фаза === 'generating' && задача === null && (
            <p className={styles.confirmHint} role="status" aria-live="polite">
              Готовим AI-версию…
            </p>
          )}

          <div className={styles.confirmActions}>
            {фаза === 'confirm' && (
              <button
                className={styles.confirmPrimary}
                type="button"
                onClick={() => {
                  void запуститьГенерацию(сохранённыйId)
                }}
              >
                Сделать AI-версию · {выбраннаяМодель.priceRub} ₽
              </button>
            )}
            <button
              className={фаза === 'confirm' ? styles.confirmSecondary : styles.confirmPrimary}
              type="button"
              onClick={onSaved}
            >
              Добавить без AI-версии
            </button>
          </div>
        </section>
      )}
    </>
  )
}
