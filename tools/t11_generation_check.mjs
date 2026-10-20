/**
 * T11 · живая проверка качества генерации по категориям (спайк).
 *
 * Запуск:
 *   npx vite-node tools/t11_generation_check.mjs
 *
 * Что делает:
 *   1. Тянет настоящие карточки WB (`basket-*.wbbasket.ru/.../card.json`) по
 *      заранее подобранным nmId — по 2 на каждую верхнюю категорию ADR-0004.
 *   2. Собирает промпт реальным модулем `src/domain/prompt-templates.ts`.
 *   3. Генерирует картинку **через воркер `tidy-api`** (service binding из
 *      временного `tools/t11_probe` — иначе локальная сеть рвёт ответ >20 КБ,
 *      D4), скачивает её кусками <15 КБ и сохраняет в `docs/evidence/raw/t11/`.
 *   4. Считает формальные метрики кадра реальным детектором пакшота
 *      `src/services/wb/packshot.ts` (доля почти-белой рамки, однородность) и
 *      долю непустых пикселей (есть ли вообще вещь в кадре).
 *   5. Пишет сырой лог `docs/evidence/raw/t11-live.txt`.
 *
 * Пробник — временный (см. `tools/t11_probe/README.md`); адрес переопределяется
 * переменной `T11_PROBE_URL`.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildGenerationPrompt } from '../src/domain/prompt-templates.ts'
import { loadWbCard } from '../src/services/wb/card.ts'
import { analyzeFrame } from '../src/services/wb/packshot.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'docs/evidence/raw/t11')
const LOG_PATH = join(ROOT, 'docs/evidence/raw/t11-live.txt')
const PROBE_URL = (process.env.T11_PROBE_URL ?? 'https://tidy-t11-probe.megabaff2011.workers.dev').replace(/\/$/, '')

/**
 * По 2 реальные карточки на верхнюю категорию. nmId подобраны перебором карточек
 * в vol 140/160 (см. `docs/evidence/T11.md`) и перепроверяются `card.json` в
 * прогоне — здесь только номера.
 */
const SAMPLES = [
  { top: 'Верх', nmIds: [14058529, 14058765] },
  { top: 'Низ', nmIds: [14058401, 14058426] },
  { top: 'Платья', nmIds: [14058746, 14059125] },
  { top: 'Верхняя одежда', nmIds: [14058443, 14058526] },
  { top: 'Второй слой', nmIds: [14058606, 14059812] },
  { top: 'Обувь', nmIds: [14058427, 14058428] },
  { top: 'Аксессуары', nmIds: [16020837, 14058446] },
  { top: 'Бельё', nmIds: [14058409, 14059139] },
]

const CHUNK = 12000

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(
  LOG_PATH,
  `# T11 · живой прогон генерации по категориям\n# ${new Date().toISOString()}\n# probe ${PROBE_URL}\n\n`,
)

function log(line) {
  console.log(line)
  appendFileSync(LOG_PATH, `${line}\n`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function probeGen(prompt, attempt = 1) {
  const response = await fetch(`${PROBE_URL}/gen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(100_000),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.ok) {
    // Каждая попытка стоит денег (7 ₽ за кадр), а таймаут клиента не отменяет
    // работу на сервере (D6). Поэтому максимум две попытки, не восемь.
    if (attempt < 2) {
      await sleep(3000)
      return probeGen(prompt, attempt + 1)
    }
    throw new Error(`/gen ${response.status}: ${JSON.stringify(data).slice(0, 300)}`)
  }
  return data
}

async function fetchChunk(key, off, attempt = 1) {
  const response = await fetch(`${PROBE_URL}/bytes?key=${key}&off=${off}&len=${CHUNK}`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404 && attempt < 5) {
    await sleep(1000) // KV может быть ещё не виден в этом коле
    return fetchChunk(key, off, attempt + 1)
  }
  if (!response.ok) throw new Error(`/bytes ${response.status}`)
  const total = Number(response.headers.get('x-total') ?? 0)
  return { bytes: new Uint8Array(await response.arrayBuffer()), total }
}

async function download(key, expectedSize) {
  const parts = []
  let off = 0
  let total = expectedSize
  for (;;) {
    const { bytes, total: reported } = await fetchChunk(key, off)
    total = reported || total
    parts.push(Buffer.from(bytes))
    off += bytes.byteLength
    if (bytes.byteLength === 0 || off >= total) break
  }
  return Buffer.concat(parts)
}

/** JPEG → сырые RGBA через ffmpeg (T9 делал так же). */
function decodeJpeg(path) {
  const meta = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
    { encoding: 'utf8' },
  ).trim()
  const [width, height] = meta.split(',').map(Number)
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { maxBuffer: 256 * 1024 * 1024 },
  )
  return { width, height, pixels: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength) }
}

/** Доля пикселей, не являющихся почти-белыми: есть ли вещь в кадре (не пустой холст). */
function nonWhiteRatio({ width, height, pixels }) {
  let filled = 0
  const total = width * height
  for (let i = 0; i < total; i++) {
    const p = i * 4
    if (pixels[p] < 240 || pixels[p + 1] < 240 || pixels[p + 2] < 240) filled++
  }
  return filled / total
}

const results = []

for (const group of SAMPLES) {
  let index = 0
  for (const nmId of group.nmIds) {
    index++
    const card = await loadWbCard(nmId)
    const item = {
      название: card.name,
      категория: group.top,
      подкатегория: '',
      цвета: card.colors,
      состав: card.composition,
    }
    // Подкатегорию берём из словаря WB по реальным subj_name/subj_root_name.
    const { mapWbCategory } = await import('../src/domain/wb-taxonomy.ts')
    const mapped = mapWbCategory(card.rootSubjectName ?? '', card.subjectName ?? '')
    item.подкатегория = mapped.top === group.top ? mapped.sub : ''

    const prompt = buildGenerationPrompt(item)
    const started = Date.now()
    let gen
    let buffer
    try {
      gen = await probeGen(prompt)
      buffer = await download(gen.key, gen.size)
    } catch (error) {
      log(`[${group.top}/${index}] nmId=${nmId} wb=${card.subjectName} → ОШИБКА: ${String(error)}`)
      results.push({ top: group.top, sub: mapped.sub, wbSub: card.subjectName, nmId, failed: String(error) })
      continue
    }
    const ms = Date.now() - started

    const extension = /png/i.test(gen.contentType ?? '') ? 'png' : /webp/i.test(gen.contentType ?? '') ? 'webp' : 'jpg'
    const file = join(OUT_DIR, `${group.top}-${index}-${card.subjectName ?? 'item'}.${extension}`)
    writeFileSync(file, buffer)

    const frame = decodeJpeg(file)
    const analysis = analyzeFrame(frame)
    const coverage = nonWhiteRatio(frame)

    const row = {
      top: group.top,
      sub: mapped.sub,
      wbSub: card.subjectName,
      name: card.name,
      colors: card.colors.join(', '),
      nmId,
      bytes: buffer.byteLength,
      ms,
      whiteness: Number(analysis.whiteness.toFixed(3)),
      uniformity: Number(analysis.uniformity.toFixed(3)),
      isPackshot: analysis.isPackshot,
      coverage: Number(coverage.toFixed(3)),
      prompt,
      file: file.replace(`${ROOT}/`, ''),
    }
    results.push(row)
    log(
      `[${group.top}/${index}] nmId=${nmId} wb=${card.subjectName} → ${mapped.top}/${mapped.sub}\n` +
        `  prompt: ${prompt}\n` +
        `  file=${row.file} bytes=${row.bytes} ms=${ms} whiteness=${row.whiteness} uniformity=${row.uniformity} coverage=${row.coverage}\n`,
    )
    await sleep(1200)
  }
}

writeFileSync(
  join(ROOT, 'docs/evidence/raw/t11-analysis.json'),
  JSON.stringify(results, null, 2),
)

log('\n=== СВОДКА ===')
log('top | подкат | файл | whiteness | uniformity | coverage')
for (const r of results) {
  log(`${r.top}\t${r.wbSub}\t${r.file}\t${r.whiteness}\t${r.uniformity}\t${r.coverage}`)
}
log(`\nГотово: ${results.length} изображений.`)
