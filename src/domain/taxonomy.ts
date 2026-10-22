/**
 * Двухуровневая таксономия вещей (ADR-0004; «Блузки» и «Комбинезоны» — ADR-0007).
 *
 * Верхний уровень задаёт полки гардероба, нижний — чипы в редакторе образов.
 * Таксономия — часть домена: её можно расширять без миграции данных, потому что
 * в вещи хранятся строки-значения, а не ссылки на таблицу категорий.
 *
 * Сетевых вызовов и React здесь нет: это чистые константы и функции.
 */

/** Верхний уровень таксономии: категория → её подкатегории. */
export const TAXONOMY = {
  Верх: ['лонгслив', 'футболка', 'топ', 'кроп-топ', 'рубашка', 'свитер'],
  Низ: ['джинсы', 'брюки', 'шорты', 'юбка'],
  Платья: ['платье', 'сарафан'],
  Блузки: ['блузка'],
  Комбинезоны: ['комбинезон'],
  'Верхняя одежда': ['куртка', 'пальто', 'пуховик', 'пиджак', 'тренч'],
  'Второй слой': ['кардиган', 'жилет', 'худи'],
  Обувь: ['кроссовки', 'ботинки', 'сапоги', 'туфли', 'сандалии'],
  Аксессуары: ['сумка', 'ремень', 'шапка', 'шарф', 'украшения', 'очки'],
  Бельё: ['бюстгальтер', 'трусы', 'носки', 'колготки'],
} as const

/** Верхняя категория из словаря ADR-0004. */
export type TopCategory = keyof typeof TAXONOMY

/**
 * Куда попадает вещь, если словарь не узнал категорию: не теряем вещь,
 * а кладём в «Разное» и предлагаем выбрать вручную.
 */
export const FALLBACK_TOP = 'Разное'

/** Подкатегория для «Разное»: вещь остаётся полноценной, пока категория не выбрана. */
export const FALLBACK_SUB = 'Разное'

function isTopCategory(value: string): value is TopCategory {
  return Object.prototype.hasOwnProperty.call(TAXONOMY, value)
}

/** Верхние категории, включая «Разное» для неизвестных вещей. */
export function topCategories(): readonly string[] {
  return [...(Object.keys(TAXONOMY) as TopCategory[]), FALLBACK_TOP]
}

/** Подкатегории верхней категории. Для неизвестной категории — пустой список. */
export function subcategoriesOf(top: string): readonly string[] {
  if (top === FALLBACK_TOP) return [FALLBACK_SUB]
  if (isTopCategory(top)) return TAXONOMY[top]
  return []
}

/** Известна ли верхняя категория (включая «Разное»). */
export function isKnownTop(value: string): boolean {
  return value === FALLBACK_TOP || isTopCategory(value)
}

/** Известна ли пара «верхняя категория — подкатегория». */
export function isKnownSub(top: string, sub: string): boolean {
  if (top === FALLBACK_TOP) return sub === FALLBACK_SUB
  if (!isTopCategory(top)) return false
  return (TAXONOMY[top] as readonly string[]).includes(sub)
}
