/**
 * Кэш найденного лоадера для диапазона `vol` (T5-fix).
 *
 * Рост числа лоадеров `basket-{NN}` не линеен: таблица `vol → basket`
 * ошибается на больших `vol` (например, `vol=13183` лежит на `basket-45`, а не
 * на экстраполированном `basket-65`). Поэтому лоадер, найденный перебором,
 * запоминаем, чтобы следующая вещь того же диапазона открывалась одним
 * запросом. Это настройка устройства, а не доменные данные, — ей место в
 * `localStorage` (как фон образа в `outfit-background.ts`), а не в IndexedDB.
 *
 * Запись может устареть (лоадер переехал): `loadWbCard` использует её лишь как
 * первого кандидата, и при 404 спокойно идёт обычным перебором. Поэтому кэш не
 * может сломать загрузку — он только ускоряет удачный случай.
 *
 * Модуль не зависит от React, IndexedDB и сети.
 */

const ПРЕФИКС_КЛЮЧА = 'tidy.wb.basket.vol.'

function ключ(vol: number): string {
  return `${ПРЕФИКС_КЛЮЧА}${vol}`
}

/**
 * Читает запомненный лоадер для `vol`. Возвращает `undefined`, если записи нет
 * или она испорчена; вызывающий сам проверяет попадание в `1..MAX_BASKET`.
 */
export function readCachedBasket(vol: number): number | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    const raw = localStorage.getItem(ключ(vol))
    if (raw === null) return undefined
    const value = Number.parseInt(raw, 10)
    return Number.isInteger(value) && value >= 1 ? value : undefined
  } catch {
    // Приватный режим браузера может запрещать чтение — работаем без кэша.
    return undefined
  }
}

/** Запоминает лоадер для `vol`. Ошибки хранилища не должны ломать загрузку. */
export function writeCachedBasket(vol: number, basket: number): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(ключ(vol), String(basket))
  } catch {
    // Записать не удалось — просто обойдёмся без кэша.
  }
}

/** Убирает все записи кэша лоадеров (тесты и диагностика). */
export function clearBasketCache(): void {
  try {
    if (typeof localStorage === 'undefined') return
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key !== null && key.startsWith(ПРЕФИКС_КЛЮЧА)) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
  } catch {
    // Хранилище недоступно — чистить нечего.
  }
}
