import { describe, expect, it } from 'vitest'

import { ОшибкаСсылкиWildberries } from './errors'
import { parseWbLink } from './parse-link'

describe('parseWbLink', () => {
  it('разбирает ссылку с www', () => {
    expect(parseWbLink('https://www.wildberries.ru/catalog/16020837/detail.aspx')).toEqual({
      nmId: 16020837,
    })
  })

  it('разбирает ссылку без www и с query-параметрами', () => {
    expect(
      parseWbLink('https://wildberries.ru/catalog/16020837/detail.aspx?targetUrl=SG'),
    ).toEqual({ nmId: 16020837 })
  })

  it('разбирает ссылку без схемы', () => {
    expect(parseWbLink('wildberries.ru/catalog/16020837/detail.aspx')).toEqual({
      nmId: 16020837,
    })
  })

  it('разбирает ссылку с utm и хэшем', () => {
    expect(
      parseWbLink('https://www.wildberries.ru/catalog/16020837/detail.aspx?utm_source=x#reviews'),
    ).toEqual({ nmId: 16020837 })
  })

  it('разбирает короткий хост wb.ru', () => {
    expect(parseWbLink('https://wb.ru/catalog/16020837/detail.aspx')).toEqual({ nmId: 16020837 })
  })

  it('разбирает мобильную ссылку с поддоменом', () => {
    expect(parseWbLink('https://m.wildberries.ru/catalog/14058746/detail.aspx')).toEqual({
      nmId: 14058746,
    })
  })

  it('терпит пробелы вокруг ссылки', () => {
    expect(parseWbLink('  wildberries.ru/catalog/16020837/detail.aspx  ')).toEqual({
      nmId: 16020837,
    })
  })

  it('берёт nm из query-параметра, если нет в пути', () => {
    expect(parseWbLink('https://www.wildberries.ru/catalog/detail.aspx?nm=16020837')).toEqual({
      nmId: 16020837,
    })
  })

  it('отвергает ссылку на другой маркетплейс', () => {
    expect(() => parseWbLink('https://www.ozon.ru/product/123456789/')).toThrow(
      ОшибкаСсылкиWildberries,
    )
    expect(() => parseWbLink('https://www.ozon.ru/product/123456789/')).toThrow(
      'Это не похоже на ссылку Wildberries',
    )
  })

  it('отвергает хост-обманку wildberries.ru.evil.com', () => {
    expect(() =>
      parseWbLink('https://wildberries.ru.evil.com/catalog/16020837/detail.aspx'),
    ).toThrow(ОшибкаСсылкиWildberries)
  })

  it('отвергает просто текст', () => {
    expect(() => parseWbLink('просто текст')).toThrow(ОшибкаСсылкиWildberries)
  })

  it('отвергает пустую строку', () => {
    expect(() => parseWbLink('')).toThrow(ОшибкаСсылкиWildberries)
    expect(() => parseWbLink('   ')).toThrow('Это не похоже на ссылку Wildberries')
  })

  it('отвергает нулевой nmId', () => {
    expect(() => parseWbLink('https://www.wildberries.ru/catalog/0/detail.aspx')).toThrow(
      ОшибкаСсылкиWildberries,
    )
  })

  it('отвергает слишком большой nmId', () => {
    expect(() =>
      parseWbLink('https://www.wildberries.ru/catalog/99999999999999999999/detail.aspx'),
    ).toThrow(ОшибкаСсылкиWildberries)
  })

  it('отвергает ссылку WB без номера товара', () => {
    expect(() => parseWbLink('https://www.wildberries.ru/catalog/')).toThrow(
      ОшибкаСсылкиWildberries,
    )
  })
})
