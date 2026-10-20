import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  DEFAULT_GENERATION_MODEL_SLUG,
  FALLBACK_GENERATION_MODELS,
  loadGenerationModels,
  resolveGenerationModel,
  storeGenerationModelSlug,
  storedGenerationModelSlug,
  type GenerationModel,
} from '../services/generation-models'

/**
 * Выбор модели генерации для карточки вещи.
 *
 * Сначала показываем запасной каталог с ценами из `generation-models.ts`, затем
 * тихо подменяем его живым ответом воркера. Выбор хранится в localStorage:
 * следующая AI-версия по умолчанию делается той же моделью.
 *
 * В тестах сеть не трогаем: UI-тесты не должны зависеть от доступности
 * каталога, а сам загрузчик проверяется отдельно с подменённым `fetch`.
 */
export function useGenerationModels() {
  const [result, setResult] = useState<{ models: GenerationModel[]; defaultSlug: string }>({
    models: [...FALLBACK_GENERATION_MODELS],
    defaultSlug: DEFAULT_GENERATION_MODEL_SLUG,
  })
  const [storedSlug, setStoredSlug] = useState<string | null>(() => storedGenerationModelSlug())

  useEffect(() => {
    if (import.meta.env.MODE === 'test') return
    let active = true
    void loadGenerationModels().then((loaded) => {
      if (!active) return
      setResult({ models: loaded.models, defaultSlug: loaded.defaultSlug })
    })
    return () => {
      active = false
    }
  }, [])

  const selected = useMemo(
    () => resolveGenerationModel(result.models, storedSlug, result.defaultSlug),
    [result, storedSlug],
  )

  const select = useCallback((slug: string) => {
    setStoredSlug(slug)
    storeGenerationModelSlug(slug)
  }, [])

  return { models: result.models, selected, select }
}
