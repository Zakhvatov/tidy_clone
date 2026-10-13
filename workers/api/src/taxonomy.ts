/**
 * Двухуровневая таксономия вещей.
 *
 * Источник — ADR-0004 (`docs/adr/0004-categorization-by-wb-dictionary.md`).
 * Список продублирован здесь намеренно: у воркера своя среда исполнения и свой
 * `package.json`, а `src/domain/taxonomy.ts` живёт в корневом приложении (T2).
 * При изменении таксономии нужно синхронно править оба места.
 *
 * Слова домена строгие (CONTEXT.md): Вещь, Оригинал, AI-версия, Пакшот, Образ.
 */

export const TAXONOMY = {
  Верх: ["лонгслив", "футболка", "топ", "кроп-топ", "рубашка", "свитер"],
  Низ: ["джинсы", "брюки", "шорты", "юбка"],
  Платья: ["платье", "сарафан"],
  "Верхняя одежда": ["куртка", "пальто", "пуховик", "пиджак", "тренч"],
  "Второй слой": ["кардиган", "жилет", "худи"],
  Обувь: ["кроссовки", "ботинки", "сапоги", "туфли", "сандалии"],
  Аксессуары: ["сумка", "ремень", "шапка", "шарф", "украшения", "очки"],
  Бельё: ["бюстгальтер", "трусы", "носки", "колготки"],
} as const satisfies Record<string, readonly string[]>;

export type TopCategory = keyof typeof TAXONOMY | typeof FALLBACK_CATEGORY;

/**
 * «Разное» — не часть таксономии ADR-0004, а поведение для неизвестного значения:
 * вещь не теряется, а попадает в «Разное» с предложением выбрать категорию вручную.
 */
export const FALLBACK_CATEGORY = "Разное";
export const FALLBACK_SUBCATEGORY = "Разное";

export interface Classification {
  category: string;
  subcategory: string;
  confidence: number;
}

export function topCategories(): string[] {
  return Object.keys(TAXONOMY);
}

export function subcategoriesOf(top: string): readonly string[] {
  if (isKnownCategory(top)) return TAXONOMY[top];
  return [];
}

export function isKnownCategory(value: string): value is keyof typeof TAXONOMY {
  return Object.prototype.hasOwnProperty.call(TAXONOMY, value);
}

export function isKnownSubcategory(top: string, sub: string): boolean {
  if (!isKnownCategory(top)) return false;
  return (TAXONOMY[top] as readonly string[]).includes(sub);
}

/** Промпт для vision-модели: жёстко ограничивает её фиксированным списком. */
export const CLASSIFY_SYSTEM_PROMPT = [
  "Ты определяешь категорию вещи на фотографии для личного цифрового гардероба.",
  "Отвечай строго одним JSON-объектом без пояснений и без markdown:",
  '{"category": "<верхняя категория>", "subcategory": "<подкатегория>", "confidence": <число от 0 до 1>}.',
  "",
  "Верхняя категория обязана быть одной из: " + topCategories().join(", ") + ".",
  "Подкатегория обязана принадлежать выбранной верхней категории:",
  ...topCategories().map((top) => `${top}: ${subcategoriesOf(top).join(", ")}`),
  "",
  `Если вещь не опознана или не относится к одежде, обуви и аксессуарам, верни ` +
    `{"category":"${FALLBACK_CATEGORY}","subcategory":"${FALLBACK_SUBCATEGORY}","confidence":0}.`,
].join("\n");

/** Приводит лишённый доверия ответ модели к строгому значению из таксономии. */
export function classifyFromModel(parsed: unknown): Classification {
  const fallback: Classification = {
    category: FALLBACK_CATEGORY,
    subcategory: FALLBACK_SUBCATEGORY,
    confidence: 0,
  };

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;

  const raw = parsed as Record<string, unknown>;
  const confidence = normalizeConfidence(raw.confidence);
  const category = findTop(typeof raw.category === "string" ? raw.category : "");
  const subcategory = findSub(typeof raw.subcategory === "string" ? raw.subcategory : "");

  // Полное совпадение: категория и подкатегория согласованы.
  if (category && subcategory && isKnownSubcategory(category, subcategory)) {
    return { category, subcategory, confidence };
  }

  // Модель ошиблась верхним уровнем, но верную подкатегорию — восстанавливаем владельца.
  if (subcategory) {
    const owner = ownerOf(subcategory);
    if (owner) return { category: owner, subcategory, confidence };
  }

  // Верхний уровень известен, подкатегорию не разобрали — оставляем категорию, низ в «Разное».
  if (category) return { category, subcategory: FALLBACK_SUBCATEGORY, confidence };

  return fallback;
}

function findTop(value: string): string | null {
  const needle = value.trim().toLowerCase();
  if (!needle) return null;
  if (needle === FALLBACK_CATEGORY.toLowerCase()) return FALLBACK_CATEGORY;
  for (const top of topCategories()) {
    if (top.toLowerCase() === needle) return top;
  }
  return null;
}

function findSub(value: string): string | null {
  const needle = value.trim().toLowerCase();
  if (!needle) return null;
  for (const top of topCategories()) {
    for (const sub of subcategoriesOf(top)) {
      if (sub.toLowerCase() === needle) return sub;
    }
  }
  return null;
}

function ownerOf(subcategory: string): string | null {
  for (const top of topCategories()) {
    if (subcategoriesOf(top).includes(subcategory)) return top;
  }
  return null;
}

function normalizeConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
