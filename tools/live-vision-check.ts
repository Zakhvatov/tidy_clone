/**
 * Живая проверка распознавания категории по ФОТО (вход «фото», T7) на реальных карточках WB.
 *
 * Берёт настоящие фото через настоящий код (`loadWbCard` сам подбирает basket-лоадер),
 * уменьшает их (локальная сеть режет тела >~16 КБ, D4) и зовёт живой `/classify`.
 * Сравнивает ответ vision-модели со словарным ответом по данным продавца.
 *
 * Запуск:  npx vite-node tools/live-vision-check.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadWbCard } from '../src/services/wb/card'
import { mapWbCategory } from '../src/domain/wb-taxonomy'

const NM_IDS = [14058746, 14058741, 16020837, 14058401, 14058606]
const API = 'https://tidy-api.megabaff2011.workers.dev'

function token(): string {
  const env = readFileSync('.env.local', 'utf8')
  const match = env.match(/VITE_TIDY_CLIENT_TOKEN=(.+)/)
  if (!match) throw new Error('нет VITE_TIDY_CLIENT_TOKEN в .env.local')
  return match[1].trim()
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'tidy-vision-'))
  const key = token()
  const rows: Array<Record<string, unknown>> = []

  for (const nmId of NM_IDS) {
    const row: Record<string, unknown> = { nmId }
    try {
      const card = await loadWbCard(nmId)
      const dictionary = mapWbCategory(card.rootSubjectName, card.subjectName)
      row.название = card.name
      row.словарь = `${dictionary.top} / ${dictionary.sub}`

      const response = await fetch(card.photoUrls[0])
      const webp = join(tmp, `${nmId}.webp`)
      writeFileSync(webp, Buffer.from(await response.arrayBuffer()))

      // уменьшаем: 150 px по ширине, низкое качество — чтобы тело уложилось в лимит локальной сети
      const jpeg = join(tmp, `${nmId}.jpg`)
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', webp, '-vf', 'scale=150:-2', '-q:v', '10', jpeg])
      const base64 = readFileSync(jpeg).toString('base64')
      const body = JSON.stringify({ imageBase64: base64, mimeType: 'image/jpeg' })
      row.тело = `${body.length} Б`

      const started = Date.now()
      const classified = await fetch(`${API}/classify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tidy-client': key },
        body,
      })
      row.мс = Date.now() - started
      row.http = classified.status
      const payload = (await classified.json()) as Record<string, unknown>
      if (classified.ok) {
        row.vision = `${payload.category} / ${payload.subcategory}`
        row.уверенность = payload.confidence
        row.совпалоСоСловарём = payload.category === dictionary.top
      } else {
        row.ошибкаVision = JSON.stringify(payload)
      }
    } catch (error) {
      row.ошибка = (error as Error).message
    }
    rows.push(row)
  }

  console.log('\n=== Живое распознавание по фото (реальные карточки WB) ===\n')
  for (const row of rows) {
    const r = row as Record<string, string>
    console.log(`nmId ${row.nmId}: ${r.название ?? r.ошибка}`)
    if (r.словарь) console.log(`  словарь по данным продавца: ${r.словарь}`)
    if (r.vision) console.log(`  vision по фото: ${r.vision} (уверенность ${r.уверенность}, совпал верх: ${r.совпалоСоСловарём})`)
    if (r.ошибкаVision) console.log(`  vision вернул ошибку: ${r.ошибкаVision}`)
    if (r.http) console.log(`  http=${r.http} ${r.мс} мс, тело ${r.тело}`)
    console.log('')
  }

  writeFileSync('docs/evidence/raw/live-vision.json', JSON.stringify(rows, null, 2))
  console.log('Отчёт: docs/evidence/raw/live-vision.json\n')
}

main().catch((error) => {
  console.error('ФАТАЛЬНО:', error)
  process.exit(1)
})
