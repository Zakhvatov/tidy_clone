import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BASKET_RANGES,
  MAX_BASKET,
  basketCandidates,
  basketForVol,
  buildCardUrl,
  loadWbCard,
  remainingBaskets,
} from './card'
import { clearBasketCache, readCachedBasket, writeCachedBasket } from './basket-cache'
import { ОшибкаЗагрузкиКарточки } from './errors'

// Кэш лоадера живёт в localStorage и переживает тесты — чистим перед каждым.
beforeEach(() => {
  clearBasketCache()
})

/** Минимальный ответ-заглушка вместо `Response`, чтобы не зависеть от undici. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** Строит мок fetch по карте «URL → тело | HTTP-код». Неизвестный URL — 404. */
function makeFetch(routes: Record<string, unknown | number>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const route = routes[url]
    if (route === undefined) return jsonResponse({}, 404)
    if (typeof route === 'number') return jsonResponse({}, route)
    return jsonResponse(route)
  }) as typeof fetch
}

const BROOCH_URL = 'https://basket-02.wbbasket.ru/vol160/part16020/16020837'

/** Ошибка `fetch`, которой Node сообщает NXDOMAIN (хост не существует). */
function dnsError(): TypeError {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND basket-66.wbbasket.ru'), {
    code: 'ENOTFOUND',
  })
  return new TypeError('fetch failed', { cause })
}

describe('basketForVol / basketCandidates', () => {
  it('находит лоадер по диапазону для подтверждённых вживую vol', () => {
    expect(basketForVol(160)).toBe(2)
    expect(basketForVol(140)).toBe(1)
  })

  it('таблица диапазонов покрывает vol без дыр', () => {
    for (let i = 1; i < BASKET_RANGES.length; i++) {
      expect(BASKET_RANGES[i].from).toBe(BASKET_RANGES[i - 1].to + 1)
    }
  })

  it('начинает перебор с расчётного лоадера и добавляет соседей', () => {
    expect(basketCandidates(16020837)[0]).toBe(2)
    expect(basketCandidates(16020837)).toEqual([2, 1, 3, 4])
  })

  it('не предлагает нулевой лоадер и держит максимум 4 попытки', () => {
    const candidates = basketCandidates(14058746)
    expect(candidates[0]).toBe(1)
    expect(candidates).not.toContain(0)
    expect(candidates.length).toBeLessThanOrEqual(4)
  })

  it('экстраполирует лоадер за пределами таблицы, но не выше MAX_BASKET', () => {
    expect(basketForVol(100000)).toBeGreaterThan(BASKET_RANGES[BASKET_RANGES.length - 1].basket)
    expect(basketForVol(100000)).toBeLessThanOrEqual(MAX_BASKET)
  })

  it('не выдаёт лоадеры вне 1..MAX_BASKET ни для каких vol', () => {
    for (const vol of [0, 1, 140, 4565, 4566, 13183, 1_000_000, 2_000_000]) {
      const predicted = basketForVol(vol)
      expect(predicted).toBeGreaterThanOrEqual(1)
      expect(predicted).toBeLessThanOrEqual(MAX_BASKET)
      const candidates = basketCandidates(vol * 100000 + 1)
      expect(candidates.length).toBeGreaterThan(0)
      for (const candidate of candidates) {
        expect(candidate).toBeGreaterThanOrEqual(1)
        expect(candidate).toBeLessThanOrEqual(MAX_BASKET)
      }
    }
  })

  it('для реального vol=13183 расчёт даёт 65, хотя товар лежит на 45', () => {
    expect(basketForVol(13183)).toBe(65)
    expect(basketCandidates(1318303621)).toEqual([65, 64])
  })

  it('remainingBaskets перечисляет все существующие лоадеры без исключённых', () => {
    const rest = remainingBaskets([65, 64], 65)
    expect(rest).toHaveLength(MAX_BASKET - 2)
    expect(rest).not.toContain(65)
    expect(rest).not.toContain(64)
    expect(new Set(rest).size).toBe(rest.length)
    for (const basket of rest) {
      expect(basket).toBeGreaterThanOrEqual(1)
      expect(basket).toBeLessThanOrEqual(MAX_BASKET)
    }
    // Ближние к расчётному ищутся раньше — 45 попадёт в первую волну перебора.
    expect(rest[0]).toBe(63)
  })
})

describe('buildCardUrl', () => {
  it('строит URL по vol/part/nm и лоадеру', () => {
    expect(buildCardUrl(16020837, 2)).toBe(
      'https://basket-02.wbbasket.ru/vol160/part16020/16020837',
    )
    expect(buildCardUrl(14058746, 1)).toBe(
      'https://basket-01.wbbasket.ru/vol140/part14058/14058746',
    )
  })

  it('по умолчанию берёт расчётный лоадер', () => {
    expect(buildCardUrl(16020837)).toBe(BROOCH_URL)
  })
})

describe('loadWbCard', () => {
  const card = {
    nm_id: 16020837,
    imt_name: 'Брошь Ягоды, подарок',
    subj_name: 'Броши',
    subj_root_name: 'Бижутерия',
    nm_colors_names: 'бордовый, зеленый',
    options: [
      { name: 'Ширина предмета', value: '4.5 см' },
      { name: 'Состав бижутерии', value: 'бижутерный сплав' },
    ],
    contents: 'брошь; подарочная упаковка',
    selling: { brand_name: 'KORALI' },
    media: { photo_count: 2 },
  }

  it('загружает card.json и sellers.json и собирает WbCard', async () => {
    const fetchImpl = makeFetch({
      [`${BROOCH_URL}/info/ru/card.json`]: card,
      [`${BROOCH_URL}/info/sellers.json`]: { supplierName: 'ИП Коренев А. В.', trademark: 'KORALIONE' },
    })

    const result = await loadWbCard(16020837, fetchImpl)

    expect(result.nmId).toBe(16020837)
    expect(result.name).toBe('Брошь Ягоды, подарок')
    expect(result.subjectName).toBe('Броши')
    expect(result.rootSubjectName).toBe('Бижутерия')
    expect(result.brand).toBe('KORALI')
    expect(result.colors).toEqual(['бордовый', 'зеленый'])
    expect(result.composition).toEqual(['бижутерный сплав'])
    expect(result.contents).toBe('брошь; подарочная упаковка')
    expect(result.photoCount).toBe(2)
    expect(result.photoUrls).toEqual([
      `${BROOCH_URL}/images/big/1.webp`,
      `${BROOCH_URL}/images/big/2.webp`,
    ])
    expect(result.sellerName).toBe('ИП Коренев А. В.')
    expect(result.trademark).toBe('KORALIONE')
  })

  it('перебирает соседний лоадер, если расчётный отдал 404', async () => {
    // Расчётный для vol=160 — basket-02; отдаём 200 только на соседнем basket-01.
    const predicted = 'https://basket-02.wbbasket.ru/vol160/part16020/16020837'
    const neighbor = 'https://basket-01.wbbasket.ru/vol160/part16020/16020837'
    const fetchImpl = makeFetch({
      [`${neighbor}/info/ru/card.json`]: {
        nm_id: 16020837,
        imt_name: 'Соседний склад',
        media: { photo_count: 1 },
      },
    })

    const result = await loadWbCard(16020837, fetchImpl)
    expect(result.name).toBe('Соседний склад')
    expect(result.photoUrls[0] ?? '').toContain('basket-01')
    expect(buildCardUrl(16020837)).toBe(predicted)
  })

  it('не падает, если нет subj_name и media', async () => {
    const fetchImpl = makeFetch({
      [`${BROOCH_URL}/info/ru/card.json`]: { nm_id: 16020837, imt_name: 'Без категории' },
    })

    const result = await loadWbCard(16020837, fetchImpl)
    expect(result.subjectName).toBeUndefined()
    expect(result.photoCount).toBe(0)
    expect(result.photoUrls).toEqual([])
    expect(result.colors).toEqual([])
  })

  it('берёт состав из блока compositions, если в options его нет', async () => {
    const fetchImpl = makeFetch({
      [`${BROOCH_URL}/info/ru/card.json`]: {
        nm_id: 16020837,
        compositions: [{ name: 'полиэстер' }, { name: 'эластан' }],
      },
    })

    const result = await loadWbCard(16020837, fetchImpl)
    expect(result.composition).toEqual(['полиэстер', 'эластан'])
  })

  it('передаёт AbortSignal в fetch', async () => {
    const fetchImpl = vi.fn(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        return jsonResponse({ nm_id: 16020837 })
      }) as typeof fetch,
    )

    await loadWbCard(16020837, fetchImpl)
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('404 на всех лоадерах — это not_found, а не сетевой сбой', async () => {
    const fetchImpl = makeFetch({})
    const error = await loadWbCard(16020837, fetchImpl).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ОшибкаЗагрузкиКарточки)
    expect(error).toMatchObject({ code: 'not_found' })
    expect((error as Error).message).toBe('Товар не найден на складах Wildberries')
  })

  it('всегда бросающий fetch — это code network, а не «товар не найден»', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    const error = await loadWbCard(16020837, fetchImpl).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ОшибкаЗагрузкиКарточки)
    expect(error).toMatchObject({ code: 'network' })
    expect((error as Error).message).toMatch(/соединени/i)
    expect((error as Error).message).not.toContain('не найден')
  })

  it('5xx на всех лоадерах — сетевой сбой: ошибка network', async () => {
    const fetchImpl = (async () => jsonResponse({}, 503)) as unknown as typeof fetch

    const error = await loadWbCard(16020837, fetchImpl).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'network' })
  })

  it('404 на первом лоадере и успех на втором — вещь загружается', async () => {
    // Расчётный для vol=160 — basket-02 (отдаёт 404), соседний basket-01 — 200.
    const neighbor = 'https://basket-01.wbbasket.ru/vol160/part16020/16020837'
    const fetchImpl = makeFetch({
      [`${neighbor}/info/ru/card.json`]: { nm_id: 16020837, imt_name: 'Нашлась' },
      [`${neighbor}/info/sellers.json`]: { supplierName: 'ИП Тестов' },
    })

    const result = await loadWbCard(16020837, fetchImpl)
    expect(result.name).toBe('Нашлась')
    expect(result.sellerName).toBe('ИП Тестов')
  })

  it('отвергает некорректный nmId до сетевых вызовов', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(loadWbCard(0, fetchImpl)).rejects.toThrow(ОшибкаЗагрузкиКарточки)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('loadWbCard — перебор и сеть (T5-fix)', () => {
  const FAR_FOUND = 'https://basket-45.wbbasket.ru/vol13183/part1318303/1318303621'
  const FAR_CARD = {
    nm_id: 1318303621,
    imt_name: 'Брюки джоггеры широкие',
    subj_name: 'Брюки',
    media: { photo_count: 1 },
  }

  it('NXDOMAIN на одном кандидате не прерывает перебор (регресс)', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('https://basket-65.wbbasket.ru/vol13183/')) throw dnsError()
      if (url.startsWith(FAR_FOUND)) return jsonResponse(FAR_CARD)
      return jsonResponse({}, 404)
    }) as typeof fetch

    const result = await loadWbCard(1318303621, fetchImpl)
    expect(result.name).toBe('Брюки джоггеры широкие')
  })

  it('находит товар на далёком лоадере 45 после 404 на расчётном 65', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith(FAR_FOUND)) return jsonResponse(FAR_CARD)
      return jsonResponse({}, 404)
    }) as typeof fetch

    const result = await loadWbCard(1318303621, fetchImpl)
    expect(result.name).toBe('Брюки джоггеры широкие')
    expect(result.subjectName).toBe('Брюки')
    expect(result.photoUrls[0] ?? '').toContain('basket-45')
  })

  it('все таймауты/сетевые сбои — code network, а не «товар не найден»', async () => {
    const fetchImpl = (async () => {
      throw new DOMException('aborted', 'AbortError')
    }) as unknown as typeof fetch

    const error = await loadWbCard(1318303621, fetchImpl).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ОшибкаЗагрузкиКарточки)
    expect(error).toMatchObject({ code: 'network' })
    expect((error as Error).message).not.toContain('не найден')
  })

  it('не делает запросов к несуществующему лоадеру 66+', async () => {
    const requested: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requested.push(url)
      return jsonResponse({}, 404)
    }) as typeof fetch

    await loadWbCard(1318303621, fetchImpl).catch(() => undefined)
    expect(requested.some((url) => /basket-(66|67|68)/.test(url))).toBe(false)
    expect(requested.every((url) => !/basket-(\d{3,})/.test(url))).toBe(true)
  })

  it('перебор идёт с параллелизмом не больше SWEEP-лимита', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const fetchImpl = (async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return jsonResponse({}, 404)
    }) as typeof fetch

    await loadWbCard(1318303621, fetchImpl).catch(() => undefined)
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(6)
  })
})

describe('loadWbCard — кэш лоадера (T5-fix)', () => {
  const FAR_FOUND = 'https://basket-45.wbbasket.ru/vol13183/part1318303/1318303621'

  function countingFetch(): { fetchImpl: typeof fetch; calls: () => number } {
    let count = 0
    const fetchImpl = (async (input: RequestInfo | URL) => {
      count += 1
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith(FAR_FOUND)) {
        return jsonResponse({ nm_id: 1318303621, imt_name: 'Брюки джоггеры широкие' })
      }
      return jsonResponse({}, 404)
    }) as typeof fetch
    return { fetchImpl, calls: () => count }
  }

  it('запоминает найденный лоадер для vol', async () => {
    const { fetchImpl } = countingFetch()
    await loadWbCard(1318303621, fetchImpl)
    expect(readCachedBasket(13183)).toBe(45)
  })

  it('второй вызов того же vol использует запомненный лоадер и тратит меньше запросов', async () => {
    const { fetchImpl, calls } = countingFetch()
    await loadWbCard(1318303621, fetchImpl)
    const first = calls()

    const second = countingFetch()
    await loadWbCard(1318303621, second.fetchImpl)
    expect(second.calls()).toBeLessThan(first)
    expect(second.calls()).toBe(2) // card.json + sellers.json на кэшированном 45.
  })

  it('неверный кэш (404) не ломает загрузку — идёт обычный перебор', async () => {
    writeCachedBasket(13183, 10)
    const { fetchImpl } = countingFetch()

    const result = await loadWbCard(1318303621, fetchImpl)
    expect(result.name).toBe('Брюки джоггеры широкие')
    expect(readCachedBasket(13183)).toBe(45)
  })

  it('кэш вне 1..MAX_BASKET игнорируется', async () => {
    writeCachedBasket(13183, MAX_BASKET + 5)
    const requested: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requested.push(url)
      if (url.startsWith(FAR_FOUND)) return jsonResponse({ nm_id: 1318303621, imt_name: 'ok' })
      return jsonResponse({}, 404)
    }) as typeof fetch

    const result = await loadWbCard(1318303621, fetchImpl)
    expect(result.name).toBe('ok')
    expect(requested.some((url) => url.includes(`basket-${MAX_BASKET + 5}`))).toBe(false)
  })
})
