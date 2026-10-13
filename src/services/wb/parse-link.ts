/**
 * Разбор ссылки Wildberries: вытащить `nmId` карточки.
 *
 * Никаких «магических» регекспов по всей строке: строка разбирается через `URL`,
 * а для ввода без схемы подставляется `https://`. Хост проверяется по суффиксу,
 * чтобы `wildberries.ru.evil.com` не прошёл.
 */

import { ОшибкаСсылкиWildberries } from './errors'

/** Домены Wildberries, которые считаем «своими» (вместе с поддоменами). */
const WB_HOSTS = ['wildberries.ru', 'wb.ru'] as const

/**
 * Верхняя граница `nmId`. Реальные номера сейчас порядка 10^7, так что запас
 * огромный; всё, что выше, — заведомо мусор, а не карточка.
 */
const MAX_NM_ID = 1_000_000_000_000

const DIGITS = /^\d+$/

function isWbHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return WB_HOSTS.some((wbHost) => host === wbHost || host.endsWith(`.${wbHost}`))
}

/** Достаёт номер из пути `/catalog/<nm>/detail.aspx` или из `?nm=<nm>`. */
function extractNmId(url: URL): number | null {
  const segments = url.pathname.split('/').filter(Boolean)
  const catalogIndex = segments.findIndex((segment) => segment.toLowerCase() === 'catalog')
  const pathCandidate = catalogIndex >= 0 ? segments[catalogIndex + 1] : undefined
  const queryCandidate = url.searchParams.get('nm') ?? undefined

  for (const candidate of [pathCandidate, queryCandidate]) {
    if (candidate !== undefined && DIGITS.test(candidate)) {
      const nmId = Number(candidate)
      if (Number.isSafeInteger(nmId) && nmId > 0 && nmId <= MAX_NM_ID) {
        return nmId
      }
    }
  }
  return null
}

/**
 * Разбирает ссылку Wildberries и возвращает `nmId`.
 *
 * Бросает `ОшибкаСсылкиWildberries` с понятным русским текстом, если это не
 * ссылка WB или номер некорректен.
 *
 * @example
 * parseWbLink('wildberries.ru/catalog/16020837/detail.aspx') // { nmId: 16020837 }
 */
export function parseWbLink(input: string): { nmId: number } {
  const trimmed = input.trim()
  if (trimmed === '') {
    throw new ОшибкаСсылкиWildberries('Это не похоже на ссылку Wildberries')
  }

  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new ОшибкаСсылкиWildberries('Это не похоже на ссылку Wildberries')
  }

  if (!isWbHost(url.hostname)) {
    throw new ОшибкаСсылкиWildberries('Это не похоже на ссылку Wildberries')
  }

  const nmId = extractNmId(url)
  if (nmId === null) {
    throw new ОшибкаСсылкиWildberries(
      'В ссылке Wildberries не найден номер товара — проверьте, что это ссылка на карточку',
    )
  }

  return { nmId }
}
