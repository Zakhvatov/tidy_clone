import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_GENERATION_MODEL_SLUG,
  FALLBACK_GENERATION_MODELS,
  loadGenerationModels,
  resetGenerationModelsCache,
  resolveGenerationModel,
  storeGenerationModelSlug,
  storedGenerationModelSlug,
} from './generation-models'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fakeFetch(response: Response): {
  impl: typeof fetch
  calls: () => number
} {
  let calls = 0
  const impl = vi.fn(async () => {
    calls += 1
    return response
  }) as unknown as typeof fetch
  return { impl, calls: () => calls }
}

describe('generation-models: каталог', () => {
  beforeEach(() => {
    resetGenerationModelsCache()
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('отдаёт модели и цены из ответа воркера', async () => {
    const { impl, calls } = fakeFetch(
      jsonResponse({
        models: [
          { slug: 'cheap-model', title: 'Дешёвая', priceRub: 3 },
          { slug: 'fine-model', title: 'Хорошая', priceRub: 12 },
        ],
        defaultSlug: 'fine-model',
        pricesLive: true,
      }),
    )

    const result = await loadGenerationModels({ fetchImpl: impl, clientToken: null, baseUrl: 'https://worker.test' })

    expect(result.live).toBe(true)
    expect(result.defaultSlug).toBe('fine-model')
    expect(result.models).toEqual([
      { slug: 'cheap-model', title: 'Дешёвая', priceRub: 3 },
      { slug: 'fine-model', title: 'Хорошая', priceRub: 12 },
    ])
    expect(calls()).toBe(1)
  })

  it('кэширует каталог на сессию', async () => {
    const { impl, calls } = fakeFetch(
      jsonResponse({ models: [{ slug: 'm', title: 'М', priceRub: 1 }], defaultSlug: 'm' }),
    )

    await loadGenerationModels({ fetchImpl: impl, clientToken: null })
    await loadGenerationModels({ fetchImpl: impl, clientToken: null })

    expect(calls()).toBe(1)
  })

  it('битый ответ и сетевой сбой дают запасной список, а не ошибку', async () => {
    const битый = fakeFetch(jsonResponse({ models: [{ slug: 1 }], defaultSlug: 'm' }))
    const first = await loadGenerationModels({ fetchImpl: битый.impl, clientToken: null })
    expect(first.live).toBe(false)
    expect(first.models).toEqual(FALLBACK_GENERATION_MODELS)

    resetGenerationModelsCache()
    const сбой = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const second = await loadGenerationModels({ fetchImpl: сбой, clientToken: null })
    expect(second.live).toBe(false)
    expect(second.models).toEqual(FALLBACK_GENERATION_MODELS)
  })

  it('без токена отдаёт запасной список и не падает', async () => {
    const { impl, calls } = fakeFetch(
      jsonResponse({ models: [{ slug: 'm', title: 'М', priceRub: 1 }], defaultSlug: 'm' }),
    )
    const result = await loadGenerationModels({ fetchImpl: impl })
    expect(result.live).toBe(false)
    expect(result.models).toEqual(FALLBACK_GENERATION_MODELS)
    expect(calls()).toBe(0)
  })

  it('по умолчанию выбирает модель сервера, сохранённый выбор важнее', () => {
    const models = [
      { slug: 'a', title: 'A', priceRub: 4 },
      { slug: 'b', title: 'B', priceRub: 7 },
    ]
    expect(resolveGenerationModel(models, null, 'b').slug).toBe('b')
    expect(resolveGenerationModel(models, 'a', 'b').slug).toBe('a')
    // Сохранённой модели больше нет в каталоге — откат на серверную.
    expect(resolveGenerationModel(models, 'удалённая', 'b').slug).toBe('b')
    expect(resolveGenerationModel([], null, DEFAULT_GENERATION_MODEL_SLUG).slug).toBe(
      DEFAULT_GENERATION_MODEL_SLUG,
    )
  })

  it('сохраняет выбор в localStorage и переживает перезагрузку', () => {
    expect(storedGenerationModelSlug()).toBeNull()
    storeGenerationModelSlug('nano-banana-2-1')
    expect(storedGenerationModelSlug()).toBe('nano-banana-2-1')
  })
})
