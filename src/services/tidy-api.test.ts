import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_API_URL,
  TidyApiError,
  apiBaseUrl,
  clientTokenFromEnv,
  generateImage,
  requestBlob,
  requestJson,
} from './tidy-api'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fakeFetch(response: Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return response
  }) as unknown as typeof fetch
  return { impl, calls }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('tidy-api: конфигурация', () => {
  it('базовый URL: явный параметр важнее env, env — важнее default', () => {
    expect(DEFAULT_API_URL).toBe('https://tidy-api.megabaff2011.workers.dev')
    expect(apiBaseUrl('https://example.com/')).toBe('https://example.com')
    vi.stubEnv('VITE_TIDY_API_URL', 'https://env.example.com/')
    expect(apiBaseUrl()).toBe('https://env.example.com')
    expect(apiBaseUrl('https://explicit.example.com')).toBe('https://explicit.example.com')
  })

  it('клиентский токен: явный, env, пустой', () => {
    expect(clientTokenFromEnv('  token  ')).toBe('token')
    expect(clientTokenFromEnv(null)).toBeNull()
    expect(clientTokenFromEnv('')).toBeNull()
    vi.stubEnv('VITE_TIDY_CLIENT_TOKEN', 'env-token')
    expect(clientTokenFromEnv()).toBe('env-token')
  })
})

describe('tidy-api: понятные ошибки', () => {
  it('401 → unauthorized с русским текстом', async () => {
    const { impl } = fakeFetch(
      jsonResponse(401, { error: { code: 'unauthorized', message: 'Неверный клиентский токен' } }),
    )
    const error = await requestJson('/x', { fetchImpl: impl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TidyApiError)
    expect(error).toMatchObject({ code: 'unauthorized', status: 401, message: 'Неверный клиентский токен' })
  })

  it('402 → billing с понятным текстом про баланс', async () => {
    const { impl } = fakeFetch(
      jsonResponse(402, { error: { code: 'billing', message: 'Закончился баланс генерации' } }),
    )
    const error = await requestJson('/x', { fetchImpl: impl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TidyApiError)
    expect(error).toMatchObject({ code: 'billing', status: 402, message: 'Закончился баланс генерации' })
  })

  it('402 без текста → billing с запасным сообщением', async () => {
    const { impl } = fakeFetch(jsonResponse(402, { error: { code: 'billing' } }))
    const error = await requestJson('/x', { fetchImpl: impl }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'billing', status: 402 })
    expect((error as Error).message).toMatch(/баланс/i)
  })

  it('429 → rate_limited с понятным текстом по умолчанию', async () => {
    const { impl } = fakeFetch(jsonResponse(429, { error: { code: 'rate_limited' } }))
    const error = await requestJson('/x', { fetchImpl: impl }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'rate_limited', status: 429 })
    expect((error as Error).message).toMatch(/Слишком много запросов/)
  })

  it('503 not_configured, 400, 404, 500, 504 разбираются по коду/статусу', async () => {
    const cases: Array<[number, string, string]> = [
      [503, 'not_configured', 'not_configured'],
      [400, 'invalid_input', 'bad_request'],
      [404, 'not_found', 'not_found'],
      [500, 'internal_error', 'server'],
      [504, 'model_timeout', 'timeout'],
    ]
    for (const [status, code, expected] of cases) {
      const { impl } = fakeFetch(jsonResponse(status, { error: { code } }))
      const error = await requestJson('/x', { fetchImpl: impl }).catch((e: unknown) => e)
      expect(error).toMatchObject({ code: expected, status })
    }
  })

  it('сеть недоступна → network', async () => {
    const impl = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const error = await requestJson('/x', { fetchImpl: impl }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'network' })
  })

  it('таймаут → timeout', async () => {
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch
    const error = await requestJson('/x', { fetchImpl: impl, timeoutMs: 10 }).catch((e: unknown) => e)
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
    const promise = requestJson('/x', { fetchImpl: impl, signal: controller.signal, timeoutMs: 5000 })
    controller.abort()
    const error = await promise.catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'aborted' })
  })

  it('нечитаемый JSON при 200 → invalid_response', async () => {
    const { impl } = fakeFetch(new Response('не json', { status: 200 }))
    const error = await requestJson('/x', { fetchImpl: impl }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'invalid_response' })
  })
})

describe('tidy-api: заголовок и генерация', () => {
  it('шлёт x-tidy-client из env и content-type', async () => {
    vi.stubEnv('VITE_TIDY_CLIENT_TOKEN', 'env-token')
    const { impl, calls } = fakeFetch(jsonResponse(200, { ok: true }))
    await requestJson('/x', { fetchImpl: impl, method: 'POST', body: '{}' })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['x-tidy-client']).toBe('env-token')
  })

  it('без токена заголовок не отправляется', async () => {
    const { impl, calls } = fakeFetch(jsonResponse(200, { ok: true }))
    await requestJson('/x', { fetchImpl: impl, clientToken: null })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['x-tidy-client']).toBeUndefined()
  })

  it('generateImage шлёт prompt и возвращает Blob', async () => {
    const jpeg = new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })
    const { impl, calls } = fakeFetch(jpeg)
    const blob = await generateImage('hoodie, full garment', {
      fetchImpl: impl,
      baseUrl: 'https://worker.test/',
    })
    expect(await blob.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer)
    expect(calls[0]?.url).toBe('https://worker.test/generate')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ prompt: 'hoodie, full garment' })
  })

  it('generateImage передаёт выбранную модель', async () => {
    const jpeg = new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })
    const { impl, calls } = fakeFetch(jpeg)
    await generateImage('hoodie', {
      fetchImpl: impl,
      baseUrl: 'https://worker.test',
      model: 'nano-banana-2-1',
    })
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      prompt: 'hoodie',
      model: 'nano-banana-2-1',
    })
  })

  it('generateImage шлёт референс для i2i (D13)', async () => {
    const jpeg = new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })
    const { impl, calls } = fakeFetch(jpeg)
    await generateImage('redraw hoodie', {
      fetchImpl: impl,
      baseUrl: 'https://worker.test',
      image: new Blob(['orig'], { type: 'image/png' }),
    })
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      prompt: 'redraw hoodie',
      imageBase64: 'b3JpZw==',
      mimeType: 'image/png',
    })
  })

  it('нечитаемый референс деградирует в текстовую генерацию с предупреждением', async () => {
    const jpeg = new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })
    const { impl, calls } = fakeFetch(jpeg)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const deadBlob = {} as Blob
      await generateImage('redraw hoodie', {
        fetchImpl: impl,
        baseUrl: 'https://worker.test',
        image: deadBlob,
      })
      const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
      expect(body.imageBase64).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('нечитаем'))
    } finally {
      warn.mockRestore()
    }
  })

  it('слишком большой референс → image_too_large без запроса', async () => {
    const { impl, calls } = fakeFetch(new Response(null, { status: 500 }))
    const big = new Blob([new Uint8Array([1])], { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: 8 * 1024 * 1024 + 1 })
    const error = await generateImage('hoodie', {
      fetchImpl: impl,
      baseUrl: 'https://worker.test',
      image: big,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TidyApiError)
    expect((error as TidyApiError).code).toBe('image_too_large')
    expect(calls).toHaveLength(0)
  })

  it('неподдерживаемый формат референса → unsupported_media', async () => {
    const { impl, calls } = fakeFetch(new Response(null, { status: 500 }))
    const error = await generateImage('hoodie', {
      fetchImpl: impl,
      baseUrl: 'https://worker.test',
      image: new Blob([new Uint8Array([1])], { type: 'image/heic' }),
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TidyApiError)
    expect((error as TidyApiError).code).toBe('unsupported_media')
    expect(calls).toHaveLength(0)
  })

  it('JSON вместо картинки и пустой ответ → invalid_response', async () => {
    const asJson = fakeFetch(jsonResponse(200, { error: { code: 'internal_error' } }))
    const jsonError = await requestBlob('/generate', { fetchImpl: asJson.impl }).catch((e: unknown) => e)
    expect(jsonError).toMatchObject({ code: 'invalid_response' })

    const empty = fakeFetch(new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    const emptyError = await requestBlob('/generate', { fetchImpl: empty.impl }).catch((e: unknown) => e)
    expect(emptyError).toMatchObject({ code: 'invalid_response' })
  })
})
