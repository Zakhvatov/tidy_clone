/**
 * Ошибки импорта из Wildberries.
 *
 * Наследуются от общего базового класса, чтобы вызывающий код мог ловить
 * `ОшибкаWildberries` и при этом различать причины. Тексты — на русском:
 * они показываются пользователю как есть.
 */

/** Базовая ошибка работы с Wildberries. */
export class ОшибкаWildberries extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ОшибкаWildberries'
  }
}

/** Ссылка не похожа на карточку Wildberries или номер товара некорректен. */
export class ОшибкаСсылкиWildberries extends ОшибкаWildberries {
  constructor(message: string) {
    super(message)
    this.name = 'ОшибкаСсылкиWildberries'
  }
}

/**
 * Почему карточку не удалось загрузить.
 *
 * `not_found` — все лоадеры ответили 404: товара по этой ссылке нет.
 * `network` — сеть недоступна, таймаут или 5xx: это не «товар не найден»,
 * и маскировать сбой под 404 нельзя.
 */
export type CardLoadErrorCode = 'not_found' | 'network'

/** Не удалось загрузить карточку товара (нет на складах, сеть, таймаут). */
export class ОшибкаЗагрузкиКарточки extends ОшибкаWildberries {
  readonly code: CardLoadErrorCode

  constructor(
    message: string,
    options: { code?: CardLoadErrorCode; cause?: unknown } = {},
  ) {
    super(message, options)
    this.name = 'ОшибкаЗагрузкиКарточки'
    this.code = options.code ?? 'not_found'
  }
}
