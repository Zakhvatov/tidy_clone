import { describe, expect, it } from 'vitest'

import { FALLBACK_SUB, FALLBACK_TOP, TAXONOMY } from './taxonomy'
import {
  FALLBACK_TEMPLATE,
  MAX_PROMPT_CHARS,
  REQUIRED_PROMPT_FRAGMENTS,
  TOP_CATEGORIES_WITH_TEMPLATES,
  buildGenerationPrompt,
  garmentWord,
  templateFor,
  truncatePrompt,
  type PromptItem,
} from './prompt-templates'

const CYRILLIC = /[А-Яа-яЁё]/

/** Полная вещь с русским названием и переводимыми атрибутами. */
function sampleItem(категория: string, подкатегория: string): PromptItem {
  return {
    название: 'Платье "Ванесса" офисное',
    категория,
    подкатегория,
    цвета: ['черный', 'белый'],
    состав: ['хлопок', 'полиэстер'],
  }
}

describe('шаблоны по верхним категориям', () => {
  it('шаблон есть у каждой верхней категории ADR-0004', () => {
    expect([...TOP_CATEGORIES_WITH_TEMPLATES].sort()).toEqual([...Object.keys(TAXONOMY)].sort())
    for (const top of Object.keys(TAXONOMY)) {
      expect(templateFor(top).length, top).toBeGreaterThan(0)
    }
  })

  it('для неизвестной категории возвращается запасной шаблон, а не пустая строка', () => {
    expect(templateFor('Нечто')).toBe(FALLBACK_TEMPLATE)
    expect(buildGenerationPrompt({ категория: 'Нечто' }).length).toBeGreaterThan(0)
  })

  it('«Разное» получает запасной шаблон', () => {
    const prompt = buildGenerationPrompt({ категория: FALLBACK_TOP, подкатегория: FALLBACK_SUB })
    expect(prompt).toContain(FALLBACK_TEMPLATE)
    expect(prompt).not.toHaveLength(0)
  })
})

describe('buildGenerationPrompt', () => {
  it('каждая вещь получает все обязательные требования кадра', () => {
    for (const [top, subs] of Object.entries(TAXONOMY)) {
      for (const sub of subs) {
        const prompt = buildGenerationPrompt(sampleItem(top, sub))
        for (const fragment of REQUIRED_PROMPT_FRAGMENTS) {
          expect(prompt, `${top}/${sub} · ${fragment}`).toContain(fragment)
        }
        expect(prompt, `${top}/${sub} · полнота`).toMatch(/full|complete|whole/)
      }
    }
  })

  it('каждая подкатегория даёт конкретное слово-вещь, а не generic', () => {
    for (const [top, subs] of Object.entries(TAXONOMY)) {
      for (const sub of subs) {
        const word = garmentWord({ категория: top, подкатегория: sub })
        expect(word, `${top}/${sub}`).not.toBe('clothing item')
        expect(word.length, `${top}/${sub}`).toBeGreaterThan(0)
      }
    }
  })

  it('название вещи не протекает в промпт по-русски', () => {
    const prompt = buildGenerationPrompt(sampleItem('Платья', 'платье'))
    expect(CYRILLIC.test(prompt)).toBe(false)
    expect(prompt).not.toContain('Ванесса')
  })

  it('латинские токены названия попадают в промпт', () => {
    const prompt = buildGenerationPrompt({
      название: 'Худи с капюшоном IAMF Brazilian Dragon',
      категория: 'Второй слой',
      подкатегория: 'худи',
    })
    expect(prompt).toContain('IAMF')
    expect(CYRILLIC.test(prompt)).toBe(false)
  })

  it('цвета попадают в промпт, если есть', () => {
    const prompt = buildGenerationPrompt({
      категория: 'Верх',
      подкатегория: 'футболка',
      цвета: ['черный', 'белый', 'несуществующий-цвет'],
    })
    expect(prompt).toContain('colors: black white')
    // нераспознанный цвет не должен просочиться русским словом
    expect(prompt).not.toContain('несуществующий')
  })

  it('состав попадает в промпт, если есть', () => {
    const prompt = buildGenerationPrompt({
      категория: 'Верх',
      подкатегория: 'свитер',
      состав: ['шерсть', 'акрил'],
    })
    expect(prompt).toContain('material: wool acrylic')
  })

  it('без атрибутов промпт всё равно полный и без цветов/состава', () => {
    const prompt = buildGenerationPrompt({ категория: 'Обувь', подкатегория: 'кроссовки' })
    expect(prompt).not.toContain('colors:')
    expect(prompt).not.toContain('material:')
    expect(prompt).toContain('complete pair of shoes')
  })

  it('промпт не длиннее лимита воркера (800 символов)', () => {
    for (const [top, subs] of Object.entries(TAXONOMY)) {
      for (const sub of subs) {
        const prompt = buildGenerationPrompt({
          ...sampleItem(top, sub),
          цвета: ['черный', 'белый', 'красный', 'синий', 'зеленый'],
          состав: ['хлопок', 'полиэстер', 'шерсть', 'вискоза', 'нейлон'],
        })
        expect(prompt.length, `${top}/${sub}`).toBeLessThanOrEqual(MAX_PROMPT_CHARS)
      }
    }
  })

  it('очень длинное ASCII-название обрезается, но обязательные требования остаются', () => {
    const prompt = buildGenerationPrompt({
      название: `Hoodie ${'X'.repeat(1500)}`,
      категория: 'Второй слой',
      подкатегория: 'худи',
      цвета: ['розовый'],
    })
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS)
    expect(prompt).toContain('no watermark')
    expect(prompt).toContain('front view')
    expect(CYRILLIC.test(prompt)).toBe(false)
  })
})

describe('truncatePrompt', () => {
  it('короткий текст не меняет', () => {
    expect(truncatePrompt('short prompt', 800)).toBe('short prompt')
  })

  it('ровно по лимиту не меняет', () => {
    const text = 'a'.repeat(800)
    expect(truncatePrompt(text, 800)).toBe(text)
  })

  it('режет по границе слова и не оставляет висячих запятых/пробелов', () => {
    const words: string[] = []
    for (let i = 0; i < 200; i++) words.push(`word${i}`)
    const text = words.join(', ')
    const cut = truncatePrompt(text, 50)
    expect(cut.length).toBeLessThanOrEqual(50)
    expect(cut.endsWith(',')).toBe(false)
    expect(cut.endsWith(' ')).toBe(false)
    // обрезок не заканчивается на середине слова: следующий символ в исходнике — разделитель
    const boundary = cut.length
    expect(['', ',', ' ']).toContain(text[boundary] ?? '')
    // все слова в обрезке — целые из исходного списка
    for (const token of cut.split(', ')) {
      expect(words).toContain(token)
    }
  })

  it('текст без пробелов режет по лимиту', () => {
    const cut = truncatePrompt('x'.repeat(1000), 10)
    expect(cut.length).toBeLessThanOrEqual(10)
    expect(cut.length).toBeGreaterThan(0)
  })
})
