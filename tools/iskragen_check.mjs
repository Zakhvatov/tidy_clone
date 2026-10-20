/**
 * Живая проверка ключа IskraGen без деплоя воркера.
 *
 * Зачем: локальная сеть режет ответы `*.workers.dev` больше ~19 КБ (D7),
 * поэтому картинку от нашего воркера с этой машины не скачать. Прямой запрос
 * к `api.iskragen.ru` проверяет ключ, модель и качество кадра, не трогая прод.
 *
 * Запуск:
 *   ISKRAGEN_API_KEY=isk_live_... npx vite-node tools/iskragen_check.mjs
 *   ISKRAGEN_API_KEY=... npx vite-node tools/iskragen_check.mjs --slug nano-banana-2-1 --prompt "..."
 *
 * Одна генерация стоит денег (gpt-image-2 — 7 ₽, nano-banana-2-1 — 4 ₽).
 * Скрипт делает ровно одну попытку и печатает баланс до и после.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'https://api.iskragen.ru/v1'
const KEY = process.env.ISKRAGEN_API_KEY?.trim()
const POLL_MS = 2000
const TIMEOUT_MS = 120_000

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const slug = arg('slug', 'gpt-image-2-text-to-image')
const prompt = arg('prompt', 'beige oversized cotton hoodie, front view, centered, plain pure white background, catalog product photo, no person, no mannequin, no text')
const out = arg('out', join(ROOT, 'docs/evidence/raw/iskragen-check.png'))

if (!KEY) {
  console.error('Нет ISKRAGEN_API_KEY. Пример: ISKRAGEN_API_KEY=isk_live_... npx vite-node tools/iskragen_check.mjs')
  process.exit(1)
}

const headers = { authorization: `Bearer ${KEY}` }
const started = Date.now()

async function json(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`${path} → ${response.status}: ${JSON.stringify(body).slice(0, 400)}`)
  }
  return body
}

async function balance() {
  try {
    const data = await json('/billing/balance?fresh=true')
    return `${data.availableRub} ₽ (в резерве ${data.reservedRub} ₽)`
  } catch (error) {
    return `не удалось прочитать: ${String(error)}`
  }
}

console.log(`До: ${await balance()}`)

const created = await json('/generations', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    modelSlug: slug,
    prompt,
    params: { aspect_ratio: '1:1', resolution: '1K' },
  }),
})
console.log(`Задача ${created.id}, статус ${created.status}, цена ${created.costRub} ₽`)

let state = created
const deadline = Date.now() + TIMEOUT_MS
while (state.status === 'PENDING' || state.status === 'PROCESSING') {
  if (Date.now() > deadline) throw new Error('задача не завершилась за 120 с')
  await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  state = await json(`/generations/${encodeURIComponent(created.id)}`)
  console.log(`  ${state.status}`)
}

if (state.status !== 'SUCCEEDED') {
  throw new Error(`генерация ${state.status}: ${state.errorCode ?? ''} ${state.errorMessage ?? ''}`)
}

const response = await fetch(`${BASE}/generations/${encodeURIComponent(created.id)}/download?index=0`, {
  headers,
  signal: AbortSignal.timeout(60_000),
})
if (!response.ok) throw new Error(`download → ${response.status}`)
const bytes = new Uint8Array(await response.arrayBuffer())
if (bytes.length === 0) throw new Error('пустой файл')

const extension = (response.headers.get('content-type') ?? '').includes('png')
  ? 'png'
  : (response.headers.get('content-type') ?? '').includes('webp')
    ? 'webp'
    : 'jpg'
const file = out.replace(/\.[a-z0-9]+$/i, `.${extension}`)
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, bytes)
console.log(`Файл: ${file} (${bytes.length} байт, ${response.headers.get('content-type')})`)
console.log(`Время: ${((Date.now() - started) / 1000).toFixed(1)} с`)
console.log(`После: ${await balance()}`)
