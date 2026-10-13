/**
 * Ошибки импорта из Wildberries.
 *
 * Наследуются от общего базового класса, чтобы вызывающий код мог ловить
 * `ОшибкаWildberries` и при этом различать причины. Тексты — на русском:
 * они показываются пользователю как есть.
 */

/** Базовая ошибка работы с Wildberries. */
export class ОшибкаWildberries extends Error {
  constructor(message: string) {
    super(message)
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

/** Не удалось загрузить карточку товара (нет на складах, сеть, таймаут). */
export class ОшибкаЗагрузкиКарточки extends ОшибкаWildberries {
  constructor(message: string) {
    super(message)
    this.name = 'ОшибкаЗагрузкиКарточки'
  }
}
