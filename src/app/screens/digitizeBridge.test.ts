import 'fake-indexeddb/auto'

import { deleteDB } from 'idb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ОшибкаОцифровки } from '../../services/digitize'
import { DB_NAME, closeDb } from '../../storage/db'
import { digitizeItem } from './digitizeBridge'

/**
 * Стык T15↔T10: обёртка должна реально подхватить `src/services/digitize.ts`
 * через `import.meta.glob`, а не только собраться. На несуществующей вещи
 * сервис отдаёт `ОшибкаОцифровки('not_found')` ещё до обращения к сети —
 * это и проверяем: значит, вызвался именно настоящий сервис.
 */
describe('Стык карточки с сервисом оцифровки', () => {
  beforeEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  afterEach(async () => {
    await closeDb()
    await deleteDB(DB_NAME)
  })

  it('digitizeBridge вызывает реальный digitizeItem из services/digitize', async () => {
    await expect(digitizeItem('нет-такой-вещи')).rejects.toBeInstanceOf(ОшибкаОцифровки)
  })
})
