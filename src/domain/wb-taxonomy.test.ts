import { describe, expect, it } from 'vitest'

import { FALLBACK_SUB, FALLBACK_TOP, TAXONOMY, isKnownSub } from './taxonomy'
import {
  WB_DICTIONARY,
  WB_SUBJECT_ALIASES,
  dictionarySize,
  isDictionaryConsistent,
  knownPairs,
  mapWbCategory,
  nameVariants,
  normalizeWbName,
  unknownSubjects,
  type WbTop,
} from './wb-taxonomy'

const ADR_TOPS = Object.keys(TAXONOMY) as ReadonlyArray<keyof typeof TAXONOMY>

describe('Словарь WB → наша таксономия (T7)', () => {
  it('содержит минимум 50 реальных строк subj_name', () => {
    expect(dictionarySize()).toBeGreaterThanOrEqual(50)
    expect(dictionarySize()).toBe(WB_DICTIONARY.length)
  })

  it('каждая запись указывает на существующую пару нашей таксономии', () => {
    expect(isDictionaryConsistent()).toBe(true)
    for (const entry of WB_DICTIONARY) {
      expect(isKnownSub(entry.top, entry.sub), `${entry.root}/${entry.subject}`).toBe(true)
    }
  })

  it('представлен каждый известный верх из ADR-0004', () => {
    const covered = new Set<WbTop>(WB_DICTIONARY.map((entry) => entry.top))
    for (const top of ADR_TOPS) {
      expect(covered.has(top), `верх «${top}» не покрыт словарём`).toBe(true)
    }
  })

  it('нет коллизий: одна строка WB не ведёт в две наши категории', () => {
    // Одинаковый subj_name в разных корнях допустим только при одном и том же исходе.
    const bySubject = new Map<string, Set<string>>()
    for (const entry of WB_DICTIONARY) {
      const subject = normalizeWbName(entry.subject)
      const outcome = `${entry.top}/${entry.sub}`
      const outcomes = bySubject.get(subject) ?? new Set<string>()
      outcomes.add(outcome)
      bySubject.set(subject, outcomes)
    }
    for (const [subject, outcomes] of bySubject) {
      expect(outcomes.size, `«${subject}» ведёт в ${[...outcomes].join(', ')}`).toBe(1)
    }

    // Каждая пара в её собственном корне разрешается ровно в одну запись.
    for (const entry of WB_DICTIONARY) {
      const result = mapWbCategory(entry.root, entry.subject)
      expect(result.top, `${entry.root}/${entry.subject}`).toBe(entry.top)
      expect(result.sub, `${entry.root}/${entry.subject}`).toBe(entry.sub)
      expect(result.needsReview).toBe(entry.top === FALLBACK_TOP)
      expect(result.matchedBy).toBe('root+subject')
    }
  })

  it('разрешает строки реальных карточек из wb-cards-sample.json', () => {
    // Значения из card.json: nm 16020837 (брошь), 14058746/14058741 (платья),
    // 14058742 (спортивный костюм), 14058739 (эфирное масло — вне нашей таксономии).
    expect(mapWbCategory('Бижутерия', 'Броши')).toMatchObject({
      top: 'Аксессуары',
      sub: 'украшения',
      needsReview: false,
      matchedBy: 'root+subject',
    })
    expect(mapWbCategory('Одежда', 'Платья')).toMatchObject({
      top: 'Платья',
      sub: 'платье',
      needsReview: false,
    })
    expect(mapWbCategory('Спортивная одежда', 'Костюмы спортивные')).toMatchObject({
      top: FALLBACK_TOP,
      sub: FALLBACK_SUB,
      needsReview: true,
    })
    expect(mapWbCategory('Красота', 'Эфирные масла')).toMatchObject({
      top: FALLBACK_TOP,
      sub: FALLBACK_SUB,
      needsReview: true,
      matchedBy: 'none',
    })
  })

  it('знает пример из тикета: «Кеды» → кроссовки', () => {
    expect(mapWbCategory('Обувь', 'Кеды')).toMatchObject({
      top: 'Обувь',
      sub: 'кроссовки',
      matchedBy: 'root+subject',
    })
    expect(mapWbCategory('Обувь', 'Кроссовки')).toMatchObject({ top: 'Обувь', sub: 'кроссовки' })
  })

  it('неизвестное не теряется: «Разное» + needsReview', () => {
    const result = mapWbCategory('Неведомая категория', 'Неведомый предмет')
    expect(result).toEqual({
      top: FALLBACK_TOP,
      sub: FALLBACK_SUB,
      needsReview: true,
      matchedBy: 'none',
    })
    expect(mapWbCategory('', '')).toMatchObject({ top: FALLBACK_TOP, needsReview: true })
    expect(mapWbCategory(null, null)).toMatchObject({ top: FALLBACK_TOP, needsReview: true })
  })

  it('нормализует регистр, ё/е, пробелы и пунктуацию', () => {
    expect(normalizeWbName('  ФУТБОЛКИ  ')).toBe('футболки')
    expect(normalizeWbName('Бельё')).toBe('белье')
    expect(normalizeWbName('Платья (включая сарафаны)')).toBe('платья включая сарафаны')
    expect(normalizeWbName('Футболки 18+')).toBe('футболки')

    expect(mapWbCategory('ОДЕЖДА', '   футболки ')).toMatchObject({ top: 'Верх', sub: 'футболка' })
    // Корень WB пишет «Белье» без ё, наш словарь и таксономия — с ё.
    expect(mapWbCategory('Бельё', 'Носки')).toMatchObject({ top: 'Бельё', sub: 'носки' })
    expect(mapWbCategory('Белье', 'НОСКИ')).toMatchObject({ top: 'Бельё', sub: 'носки' })
  })

  it('понимает единственное число и синонимы', () => {
    // Единственное число автоматически: «футболка» находит WB-строку «Футболки».
    expect(mapWbCategory('Одежда', 'футболка')).toMatchObject({ top: 'Верх', sub: 'футболка' })
    expect(nameVariants('футболки')).toContain('футболка')
    // Синонимы из WB_SUBJECT_ALIASES.
    expect(mapWbCategory('Обувь', 'кроссы')).toMatchObject({ top: 'Обувь', sub: 'кроссовки' })
    expect(WB_SUBJECT_ALIASES['кроссы']).toBe('кроссовки')
  })

  it('корень не совпал — ищет по предмету и помечает matchedBy=subject', () => {
    const result = mapWbCategory('Спортивная одежда', 'Футболки')
    expect(result).toMatchObject({ top: 'Верх', sub: 'футболка', matchedBy: 'subject' })
    const bySubjectOnly = mapWbCategory(null, 'Платья')
    expect(bySubjectOnly).toMatchObject({ top: 'Платья', sub: 'платье', matchedBy: 'subject' })
  })

  it('спорные комплекты уходят в ручной выбор, а не в случайную категорию', () => {
    for (const subject of ['Костюмы', 'Костюмы спортивные', 'Пижамы', 'Слитные купальники']) {
      const result = mapWbCategory('Одежда', subject)
      expect(result.top, subject).toBe(FALLBACK_TOP)
      expect(result.needsReview, subject).toBe(true)
    }
  })

  it('отдаёт для UI список строк, которые нужно подтвердить вручную', () => {
    const subjects = unknownSubjects()
    expect(subjects.length).toBeGreaterThan(0)
    expect(subjects).toContain('Костюмы спортивные')
    expect(subjects).toContain('Пижамы')
  })

  it('knownPairs() повторяет словарь без потерь', () => {
    expect(knownPairs()).toHaveLength(dictionarySize())
    expect(knownPairs()[0]).toHaveProperty('root')
    expect(knownPairs()[0]).toHaveProperty('subject')
  })
})
