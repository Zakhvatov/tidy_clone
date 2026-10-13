import { afterEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_SUB, FALLBACK_TOP } from '../domain/taxonomy'
import {
  ClassifyError,
  DEFAULT_API_URL,
  MAX_BODY_BYTES,
  apiBaseUrl,
  base64Length,
  blobToBase64,
  bytesToBase64,
  classifyPhoto,
  estimateBodyBytes,
  mimeTypeOf,
  normalizeClassification,
} from './classify-photo'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** fetch, который отдаёт заранее заданный ответ и записывает вызов. */
function fakeFetch(response: Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return response
  }) as unknown as typeof fetch
  return { impl, calls }
}

function smallJpeg(): Blob {
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' })
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('classify-photo: служебное', () => {
  it('базовый URL берётся из параметра, иначе — из env, иначе default', () => {
    expect(DEFAULT_API_URL).toBe('https://tidy-api.megabaff2011.workers.dev')
    expect(apiBaseUrl('https://example.com/')).toBe('https://example.com')
    expect(apiBaseUrl()).toBe(DEFAULT_API_URL)
  })

  it('оценивает размер base64-тела без его построения', () => {
    expect(base64Length(3)).toBe(4)
    expect(base64Length(4)).toBe(8)
    expect(estimateBodyBytes(4)).toBeGreaterThan(base64Length(4))
  })

  it('кодирует байты в base64 и понимает MIME', async () => {
    expect(bytesToBase64(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe('Zm9v')
    expect(await blobToBase64(new Blob(['foo']))).toBe('Zm9v')
    expect(mimeTypeOf(new Blob(['x'], { type: 'IMAGE/PNG; charset=binary' }))).toBe('image/png')
    expect(mimeTypeOf(new Blob(['x']))).toBe('image/jpeg')
  })
})

describe('classify-photo: валидация ответа по таксономии', () => {
  it('принимает корректную пару', () => {
    expect(normalizeClassification({ category: 'Обувь', subcategory: 'кроссовки', confidence: 0.82 })).toEqual({
      top: 'Обувь',
      sub: 'кроссовки',
      confidence: 0.82,
      needsReview: false,
    })
  })

  it('незнакомое и мусор уводит в «Разное» + needsReview', () => {
    for (const payload of [
      { category: 'Носорог', subcategory: 'Рог', confidence: 0.99 },
      { category: 'Обувь', subcategory: 'щупальца', confidence: 0.5 },
      { category: 42, subcategory: null, confidence: 'нет' },
      'не JSON',
      null,
    ]) {
      const result = normalizeClassification(payload)
      expect(result.top).toBe(FALLBACK_TOP)
      expect(result.sub).toBe(FALLBACK_SUB)
      expect(result.needsReview).toBe(true)
    }
  })

  it('восстанавливает верхний уровень по валидной подкатегории', () => {
    expect(normalizeClassification({ category: 'Носки', subcategory: 'кроссовки', confidence: 0.4 })).toEqual({
      top: 'Обувь',
      sub: 'кроссовки',
      confidence: 0.4,
      needsReview: false,
    })
  })

  it('зажимает confidence в [0, 1]', () => {
    expect(normalizeClassification({ category: 'Верх', subcategory: 'топ', confidence: 5 }).confidence).toBe(1)
    expect(normalizeClassification({ category: 'Верх', subcategory: 'топ', confidence: -3 }).confidence).toBe(0)
  })
})

describe('classify-photo: запрос к воркеру', () => {
  it('успешный ответ: отправляет base64 и возвращает категорию', async () => {
    const { impl, calls } = fakeFetch(
      jsonResponse(200, { category: 'Верх', subcategory: 'футболка', confidence: 0.91 }),
    )
    const result = await classifyPhoto(smallJpeg(), { fetchImpl: impl, baseUrl: 'https://worker.test/' })

    expect(result).toEqual({ top: 'Верх', sub: 'футболка', confidence: 0.91, needsReview: false })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://worker.test/classify')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      imageBase64: 'AQIDBA==',
      mimeType: 'image/jpeg',
    })
  })

  it('ответ вне таксономии превращается в «Разное» + needsReview', async () => {
    const { impl } = fakeFetch(jsonResponse(200, { category: 'Еда', subcategory: 'суп', confidence: 0.7 }))
    const result = await classifyPhoto(smallJpeg(), { fetchImpl: impl })
    expect(result.top).toBe(FALLBACK_TOP)
    expect(result.sub).toBe(FALLBACK_SUB)
    expect(result.needsReview).toBe(true)
  })

  it('503 not_configured — понятная ошибка с кодом', async () => {
    const { impl } = fakeFetch(
      jsonResponse(503, { error: { code: 'not_configured', message: 'не настроен ключ' } }),
    )
    const error = await classifyPhoto(smallJpeg(), { fetchImpl: impl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ClassifyError)
    expect(error).toMatchObject({ code: 'not_configured', status: 503, message: 'не настроен ключ' })
  })

  it('сеть недоступна → network', async () => {
    const impl = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const error = await classifyPhoto(smallJpeg(), { fetchImpl: impl }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'network' })
  })

  it('таймаут → timeout, если fetch не отвечает', async () => {
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch
    const error = await classifyPhoto(smallJpeg(), { fetchImpl: impl, timeoutMs: 10 }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'timeout' })
  })

  it('отмена извне → aborted', async () => {
    const controller = new AbortController()
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch
    const promise = classifyPhoto(smallJpeg(), { fetchImpl: impl, signal: controller.signal, timeoutMs: 5000 })
    controller.abort()
    const error = await promise.catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'aborted' })
  })

  it('слишком большой файл без возможности сжать → image_too_large до отправки', async () => {
    const fetchSpy = vi.fn()
    const blob = new Blob([new Uint8Array(1000)], { type: 'image/jpeg' })
    const error = await classifyPhoto(blob, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
      maxBodyBytes: 256,
      resize: null,
    }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'image_too_large' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('слишком большой файл сжимается и только потом уходит', async () => {
    const { impl, calls } = fakeFetch(jsonResponse(200, { category: 'Низ', subcategory: 'брюки', confidence: 0.6 }))
    const resizer = async () => new Blob([new Uint8Array(30)], { type: 'image/jpeg' })
    const blob = new Blob([new Uint8Array(1000)], { type: 'image/jpeg' })

    const result = await classifyPhoto(blob, {
      fetchImpl: impl,
      maxBodyBytes: estimateBodyBytes(64),
      resize: resizer,
    })
    expect(result.top).toBe('Низ')
    expect(calls).toHaveLength(1)
  })

  it('отправляет x-tidy-client, когда токен задан явно', async () => {
    const { impl, calls } = fakeFetch(
      jsonResponse(200, { category: 'Верх', subcategory: 'футболка', confidence: 0.9 }),
    )
    await classifyPhoto(smallJpeg(), { fetchImpl: impl, clientToken: 'secret-token' })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['x-tidy-client']).toBe('secret-token')
  })

  it('берёт токен из VITE_TIDY_CLIENT_TOKEN, когда явный не передан', async () => {
    vi.stubEnv('VITE_TIDY_CLIENT_TOKEN', 'env-token')
    const { impl, calls } = fakeFetch(jsonResponse(200, { category: 'Верх', subcategory: 'топ', confidence: 0.5 }))
    await classifyPhoto(smallJpeg(), { fetchImpl: impl })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['x-tidy-client']).toBe('env-token')
  })

  it('без токена заголовок не отправляется (явно «не настроено»)', async () => {
    const { impl, calls } = fakeFetch(jsonResponse(200, { category: 'Верх', subcategory: 'топ', confidence: 0.5 }))
    await classifyPhoto(smallJpeg(), { fetchImpl: impl, clientToken: null })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['x-tidy-client']).toBeUndefined()
  })

  it('401 unauthorized → понятная ошибка с кодом', async () => {
    const { impl } = fakeFetch(
      jsonResponse(401, { error: { code: 'unauthorized', message: 'Неверный или отсутствующий клиентский токен' } }),
    )
    const error = await classifyPhoto(smallJpeg(), { fetchImpl: impl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ClassifyError)
    expect(error).toMatchObject({ code: 'unauthorized', status: 401 })
  })

  it('429 rate_limited → понятная ошибка с кодом', async () => {
    const { impl } = fakeFetch(
      jsonResponse(429, { error: { code: 'rate_limited', message: 'Слишком много запросов, попробуйте позже' } }),
    )
    const error = await classifyPhoto(smallJpeg(), { fetchImpl: impl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ClassifyError)
    expect(error).toMatchObject({ code: 'rate_limited', status: 429 })
  })

  it('неподдерживаемый формат → unsupported_media', async () => {    const error = await classifyPhoto(new Blob([new Uint8Array(4)], { type: 'image/gif' }), {
      fetchImpl: vi.fn() as unknown as typeof fetch,
    }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'unsupported_media' })
  })

  it('4xx без not_configured → bad_request, 5xx → server', async () => {
    const bad = fakeFetch(jsonResponse(400, { error: { code: 'invalid_input', message: 'плохое тело' } }))
    const badError = await classifyPhoto(smallJpeg(), { fetchImpl: bad.impl }).catch((e: unknown) => e)
    expect(badError).toMatchObject({ code: 'bad_request', status: 400 })

    const broken = fakeFetch(jsonResponse(500, { error: { code: 'internal_error', message: 'ой' } }))
    const serverError = await classifyPhoto(smallJpeg(), { fetchImpl: broken.impl }).catch((e: unknown) => e)
    expect(serverError).toMatchObject({ code: 'server', status: 500 })
  })

  it('200 с нечитаемым телом → invalid_response', async () => {
    const { impl } = fakeFetch(new Response('не json', { status: 200 }))
    const error = await classifyPhoto(smallJpeg(), { fetchImpl: impl }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'invalid_response' })
  })

  it('лимит по умолчанию соответствует воркеру (4 МБ)', () => {
    expect(MAX_BODY_BYTES).toBe(4 * 1024 * 1024)
  })
})
