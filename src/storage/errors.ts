/**
 * Ошибки хранилища: понятные сообщения вместо сырых `DOMException` из IndexedDB.
 */

/** Базовая ошибка хранилища. */
export class ОшибкаХранилища extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ОшибкаХранилища'
  }
}

/** Вещь нельзя удалить: она входит в сохранённый образ. */
export class ОшибкаВещьВОбразе extends ОшибкаХранилища {
  constructor(message: string) {
    super(message)
    this.name = 'ОшибкаВещьВОбразе'
  }
}

/** Оригинал неизменяем: его нельзя перезаписать или удалить вне каскада вещи. */
export class ОшибкаОригиналНеизменяем extends ОшибкаХранилища {
  constructor(message: string) {
    super(message)
    this.name = 'ОшибкаОригиналНеизменяем'
  }
}
