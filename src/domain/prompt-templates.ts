/**
 * Шаблоны промптов генерации AI-версии по категориям (T11, ADR-0002/ADR-0004).
 *
 * Проблема, ради которой это существует: модель понимает «hoodie» буквально как
 * «капюшон» и рисует фрагмент вещи. Поэтому промпт собирается из двух частей:
 *   1. слово-вещь по подкатегории (при неизвестной — по категории, иначе generic);
 *   2. шаблон полноты **верхней категории** из ADR-0004 плюс общий обязательный
 *      хвост (вид спереди, по центру, белый фон, каталожное фото, без человека,
 *      без текста/водяных знаков).
 *
 * Модуль чистый: ни сети, ни React, ни DOM — только строки. Промпт англоязычный,
 * потому что модель англоязычная. Русские слова в промпт не попадают: названия и
 * цвета переводятся словарями, а нераспознанное отбрасывается (транслитерация
 * «Платье Ванесса» в «Plate Vanecca» дала бы модели мусорный токен). Это
 * осознанное решение, описано в `docs/evidence/T11.md`.
 *
 * Ограничение воркера — 800 символов (`MAX_PROMPT_CHARS` в `workers/api`).
 * {@link truncatePrompt} режет по границе слова и никогда не оставляет обрывок.
 */

/** Лимит длины промпта, синхронный с `MAX_PROMPT_CHARS` воркера `tidy-api`. */
export const MAX_PROMPT_CHARS = 800

/**
 * Минимальный срез Вещи, который нужен для промпта. Совместим с `Вещь` из
 * `src/domain/types.ts`, но не требует обязательных для хранения полей (id и т.п.),
 * чтобы функция оставалась удобной для тестов.
 */
export interface PromptItem {
  /** Название вещи; из него берутся только латинские токены. */
  название?: string
  /** Верхняя категория из ADR-0004 или «Разное». */
  категория: string
  /** Подкатегория из ADR-0004. */
  подкатегория?: string
  /** Цвета вещи по-русски; переводятся словарём. */
  цвета?: readonly string[]
  /** Состав вещи по-русски; переводится словарём. */
  состав?: readonly string[]
}

/**
 * Обязательный хвост промпта: полнота кадра, вид, фон, назначение и запреты.
 * Проверяется тестом `REQUIRED_PROMPT_FRAGMENTS`.
 */
const REQUIRED_SUFFIX =
  'front view, centered, plain pure white background, catalog product photo, ' +
  'e-commerce product shot, no person, no human model, no mannequin, no text, no watermark'

/**
 * Слова, которые обязаны быть в каждом промпте: визуальные требования из тикета.
 * Тест сверяет их наличие у всех верхних категорий и запасного шаблона.
 */
export const REQUIRED_PROMPT_FRAGMENTS: readonly string[] = [
  'front view',
  'centered',
  'white background',
  'catalog product photo',
  'no person',
  'no mannequin',
  'no text',
  'no watermark',
]

/**
 * Шаблон полноты на верхнюю категорию ADR-0004. Ключевое отличие от общего
 * хвоста — категорийное пояснение, что именно должно быть целиком в кадре
 * (пара обуви, всё платье от горловины до подола и т.п.).
 */
export const CATEGORY_TEMPLATES: Readonly<Record<string, string>> = {
  Верх: 'full garment, the whole top fully visible in frame, not a fragment or close-up',
  Низ: 'full garment, the whole bottom fully visible in frame, not a fragment or close-up',
  Платья: 'full dress, the whole garment from neckline to hem fully visible in frame',
  'Верхняя одежда':
    'full outerwear item, the whole coat fully visible in frame, including sleeves and hem',
  'Второй слой':
    'full garment, the whole layered knit piece fully visible in frame, including sleeves and hood',
  Обувь: 'complete pair of shoes, both shoes fully visible in frame, not a single shoe',
  Аксессуары:
    'the complete accessory, the whole item fully visible in frame, not a fragment or detail',
  Бельё: 'complete single undergarment, the whole item fully visible in frame, not a fragment',
}

/** Верхние категории, для которых есть собственный шаблон (без «Разное»). */
export const TOP_CATEGORIES_WITH_TEMPLATES: readonly string[] = Object.keys(CATEGORY_TEMPLATES)

/** Запасной шаблон для неизвестной верхней категории. */
export const FALLBACK_TEMPLATE =
  'one complete clothing item, the whole item fully visible in frame, not a fragment or close-up'

/** Слово-вещь по умолчанию для верхней категории, когда подкатегория не распознана. */
const TOP_GARMENT: Readonly<Record<string, string>> = {
  Верх: 'top',
  Низ: 'bottoms',
  Платья: 'dress',
  'Верхняя одежда': 'outerwear',
  'Второй слой': 'cardigan',
  Обувь: 'shoes',
  Аксессуары: 'fashion accessory',
  Бельё: 'underwear',
}

/** Английское слово-вещь по подкатегории ADR-0004. */
const SUBCATEGORY_GARMENT: Readonly<Record<string, string>> = {
  // Верх
  лонгслив: 'long-sleeve shirt',
  футболка: 't-shirt',
  топ: 'top',
  'кроп-топ': 'crop top',
  рубашка: 'shirt',
  свитер: 'sweater',
  // Низ
  джинсы: 'jeans',
  брюки: 'trousers',
  шорты: 'shorts',
  юбка: 'skirt',
  // Платья
  платье: 'dress',
  сарафан: 'sundress',
  // Верхняя одежда
  куртка: 'jacket',
  пальто: 'coat',
  пуховик: 'puffer jacket',
  пиджак: 'blazer',
  тренч: 'trench coat',
  // Второй слой
  кардиган: 'cardigan',
  жилет: 'vest',
  худи: 'hoodie',
  // Обувь
  кроссовки: 'sneakers',
  ботинки: 'boots',
  сапоги: 'tall boots',
  туфли: 'dress shoes',
  сандалии: 'sandals',
  // Аксессуары
  сумка: 'bag',
  ремень: 'belt',
  шапка: 'hat',
  шарф: 'scarf',
  украшения: 'jewelry',
  очки: 'glasses',
  // Бельё
  бюстгальтер: 'bra',
  трусы: 'underwear',
  носки: 'socks',
  колготки: 'tights',
}

/** Замена «ё» на «е» и обрезка: ключи словарей храним в этой нормальной форме. */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/ё/g, 'е')
}

/**
 * Русские цвета → английские. Покрыты частые цвета карточек WB; составные
 * («темно-синий») перечислены явно, потому что модель чувствительна к оттенку.
 */
const COLOR_EN: Readonly<Record<string, string>> = {
  белый: 'white',
  черный: 'black',
  серый: 'grey',
  красный: 'red',
  синий: 'blue',
  голубой: 'light blue',
  'темно-синий': 'navy',
  'светло-синий': 'light blue',
  зеленый: 'green',
  'темно-зеленый': 'dark green',
  'светло-зеленый': 'light green',
  'морской зеленый': 'sea green',
  'серо-зеленый': 'grey-green',
  желтый: 'yellow',
  оранжевый: 'orange',
  розовый: 'pink',
  'светло-розовый': 'light pink',
  'темно-розовый': 'dark pink',
  фиолетовый: 'purple',
  сиреневый: 'lilac',
  лиловый: 'lilac',
  бежевый: 'beige',
  'светло-бежевый': 'light beige',
  'серо-бежевый': 'grey-beige',
  коричневый: 'brown',
  'темно-коричневый': 'dark brown',
  'светло-коричневый': 'light brown',
  бордовый: 'burgundy',
  винный: 'wine',
  марсала: 'marsala',
  мятный: 'mint',
  'светло-бирюзовый': 'light turquoise',
  бирюзовый: 'turquoise',
  салатовый: 'lime',
  хаки: 'khaki',
  оливковый: 'olive',
  золотой: 'gold',
  золотистый: 'gold',
  серебряный: 'silver',
  серебристый: 'silver',
  бронзовый: 'bronze',
  медный: 'copper',
  коралловый: 'coral',
  персиковый: 'peach',
  кремовый: 'cream',
  молочный: 'milk white',
  песочный: 'sand',
  пшеничный: 'wheat',
  графитовый: 'graphite',
  мультиколор: 'multicolor',
  разноцветный: 'multicolor',
  прозрачный: 'transparent',
}

/** Русские материалы → английские. Покрыты частые составы WB. */
const MATERIAL_EN: Readonly<Record<string, string>> = {
  хлопок: 'cotton',
  полиэстер: 'polyester',
  нейлон: 'nylon',
  шерсть: 'wool',
  кашемир: 'cashmere',
  шелк: 'silk',
  лен: 'linen',
  вискоза: 'viscose',
  эластан: 'elastane',
  лайкра: 'lycra',
  спандекс: 'spandex',
  акрил: 'acrylic',
  полиамид: 'polyamide',
  полиуретан: 'polyurethane',
  кожа: 'leather',
  замша: 'suede',
  деним: 'denim',
  трикотаж: 'knit',
  модал: 'modal',
  бамбук: 'bamboo',
  микрофибра: 'microfiber',
  пух: 'down',
  мех: 'fur',
  войлок: 'felt',
  флис: 'fleece',
  резина: 'rubber',
  текстиль: 'textile',
}

/** Сколько значений каждого атрибута пускаем в промпт — чтобы уложиться в лимит. */
const MAX_COLORS = 4
const MAX_MATERIALS = 3
const MAX_NAME_TOKENS = 4

/** Переводит список русских слов, отбрасывая нераспознанные; с ограничением длины. */
function translateList(
  values: readonly string[] | undefined,
  dictionary: Readonly<Record<string, string>>,
  limit: number,
): string[] {
  if (!values) return []
  const out: string[] = []
  for (const value of values) {
    const translated = dictionary[normalize(value)]
    if (translated === undefined) continue
    if (!out.includes(translated)) out.push(translated)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Латинские токены названия (модели, бренды, английские слова). Русские названия
 * (большинство карточек WB) дают пустой список — это ожидаемо, см. шапку модуля.
 */
function latinTokens(name: string | undefined): string[] {
  if (!name) return []
  const tokens = name.match(/[A-Za-z][A-Za-z0-9&'.-]*/g)
  return tokens ? tokens.slice(0, MAX_NAME_TOKENS) : []
}

/** Шаблон полноты для верхней категории; для неизвестной — запасной. */
export function templateFor(top: string): string {
  return CATEGORY_TEMPLATES[top] ?? FALLBACK_TEMPLATE
}

/** Слово-вещь: подкатегория → категория → generic. */
export function garmentWord(item: PromptItem): string {
  return (
    SUBCATEGORY_GARMENT[item.подкатегория ?? ''] ??
    TOP_GARMENT[item.категория] ??
    'clothing item'
  )
}

/**
 * Аккуратно обрезает промпт до `limit` символов: не рвёт слово посередине и не
 * оставляет висячую запятую/пробел. Если резать нечего — возвращает как есть.
 */
export function truncatePrompt(text: string, limit: number = MAX_PROMPT_CHARS): string {
  if (text.length <= limit) return text
  let cut = text.slice(0, limit)
  const nextChar = text[limit] ?? ''
  // Если на границе разреза стоит слово — отступаем до предыдущего пробела.
  if (/[A-Za-z0-9]/.test(nextChar) && /[A-Za-z0-9]/.test(cut.at(-1) ?? '')) {
    const lastSpace = cut.lastIndexOf(' ')
    if (lastSpace > 0) cut = cut.slice(0, lastSpace)
  }
  return cut.replace(/[\s,;:-]+$/, '').trimEnd()
}

/**
 * Собирает англоязычный промпт генерации для вещи.
 *
 * Порядок частей выбран так, чтобы при обрезке первыми уходили необязательные
 * атрибуты (цвет/состав/название), а обязательные требования кадра оставались:
 * `{вещь}, {шаблон полноты}, {обязательный хвост}, {атрибуты}`.
 */
export function buildGenerationPrompt(item: PromptItem): string {
  const parts = [garmentWord(item), templateFor(item.категория), REQUIRED_SUFFIX]

  const colors = translateList(item.цвета, COLOR_EN, MAX_COLORS)
  if (colors.length > 0) parts.push(`colors: ${colors.join(' ')}`)

  const materials = translateList(item.состав, MATERIAL_EN, MAX_MATERIALS)
  if (materials.length > 0) parts.push(`material: ${materials.join(' ')}`)

  const tokens = latinTokens(item.название)
  if (tokens.length > 0) parts.push(`item type: ${tokens.join(' ')}`)

  return truncatePrompt(parts.join(', '), MAX_PROMPT_CHARS)
}
