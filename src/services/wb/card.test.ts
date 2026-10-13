import { describe, expect, it, vi } from 'vitest'

import { BASKET_RANGES, basketCandidates, basketForVol, buildCardUrl, loadWbCard } from './card'
import { ОшибкаЗагрузкиКарточки } from './errors'

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

  it('экстраполирует лоадер за пределами таблицы', () => {
    expect(basketForVol(100000)).toBeGreaterThan(BASKET_RANGES[BASKET_RANGES.length - 1].basket)
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

  it('бросает понятную ошибку, если ни один лоадер не ответил', async () => {
    const fetchImpl = makeFetch({})
    await expect(loadWbCard(16020837, fetchImpl)).rejects.toThrow(ОшибкаЗагрузкиКарточки)
    await expect(loadWbCard(16020837, fetchImpl)).rejects.toThrow(
      'Товар не найден на складах Wildberries',
    )
  })

  it('переживает сетевые сбои и всё равно бросает понятную ошибку', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    await expect(loadWbCard(16020837, fetchImpl)).rejects.toThrow(
      'Товар не найден на складах Wildberries',
    )
  })

  it('отвергает некорректный nmId до сетевых вызовов', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(loadWbCard(0, fetchImpl)).rejects.toThrow(ОшибкаЗагрузкиКарточки)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
