#!/usr/bin/env node
/**
 * T9 — живая проверка точного выреза на реальном пакшоте WB.
 *
 * Запуск из корня проекта:
 *   npx vite-node tools/cutout_demo.mjs
 *
 * Скрипт:
 *   1. качает реальный пакшот WB (nmId 14058746, photo 1) в docs/evidence/raw/t9-source.webp;
 *   2. декодирует webp в сырые RGBA через ffmpeg (ffprobe даёт размер);
 *   3. зовёт настоящее ядро `makeCutout` из src/services/cutout.ts;
 *   4. отдаёт прозрачный PNG (docs/evidence/raw/t9-cutout.png);
 *   5. собирает превью на шахматке (docs/evidence/raw/t9-preview.png);
 *   6. печатает статистику: доля прозрачных пикселей, suspicious, изменение RGB.
 *
 * Ничего в проект не устанавливает: используются только ffmpeg/ffprobe из системы.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeCutout } from '../src/services/cutout.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const RAW_DIR = join(ROOT, 'docs', 'evidence', 'raw')

const NM_ID = 14058746
const PHOTO = 1
const BASKET = process.env.T9_BASKET ?? 'basket-01'
const vol = Math.floor(NM_ID / 100000)
const part = Math.floor(NM_ID / 1000)
const SOURCE_URL = `https://${BASKET}.wbbasket.ru/vol${vol}/part${part}/${NM_ID}/images/big/${PHOTO}.webp`

const SOURCE_WEBP = join(RAW_DIR, 't9-source.webp')
const SOURCE_PNG = join(RAW_DIR, 't9-source.png')
const CUTOUT_PNG = join(RAW_DIR, 't9-cutout.png')
const PREVIEW_PNG = join(RAW_DIR, 't9-preview.png')
const TMP_RAW = join(tmpdir(), 't9-cutout.raw')

function run(bin, args, input) {
  return execFileSync(bin, args, {
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
}

function probeSize(file) {
  const out = run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    file,
  ])
    .toString()
    .trim()
  const [width, height] = out.split(',').map(Number)
  return { width, height }
}

function decodeRgba(file, width, height) {
  const raw = run('ffmpeg', [
    '-v',
    'error',
    '-i',
    file,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-frames:v',
    '1',
    '-',
  ])
  if (raw.length !== width * height * 4) {
    throw new Error(`ffmpeg вернул ${raw.length} байт, ожидалось ${width * height * 4}`)
  }
  return new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length)
}

function encodeRgbaToPng(pixels, width, height, outFile) {
  writeFileSync(TMP_RAW, Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length))
  try {
    run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${width}x${height}`,
      '-i',
      TMP_RAW,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgba',
      '-y',
      outFile,
    ])
  } finally {
    unlinkSync(TMP_RAW)
  }
}

function checkerboard(width, height, cell = 24) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dark = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0
      const value = dark ? 200 : 235
      const i = (y * width + x) * 4
      pixels[i] = value
      pixels[i + 1] = value
      pixels[i + 2] = value
      pixels[i + 3] = 255
    }
  }
  return pixels
}

function compositeOver(fg, bg, width, height) {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let p = 0; p < width * height; p++) {
    const i = p * 4
    const a = fg[i + 3] / 255
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(fg[i + c] * a + bg[i + c] * (1 - a))
    out[i + 3] = 255
  }
  return out
}

/** Максимальное изменение RGB среди пикселей, оставшихся непрозрачными. */
function survivorRgbDelta(before, after, width, height) {
  let max = 0
  let survivors = 0
  let beforeTransparent = 0
  for (let p = 0; p < width * height; p++) {
    const i = p * 4
    if (before[i + 3] < 128) beforeTransparent++
    if (after[i + 3] < 128) continue
    survivors++
    for (let c = 0; c < 3; c++) {
      const delta = Math.abs(before[i + c] - after[i + c])
      if (delta > max) max = delta
    }
  }
  return {
    maxDelta: max,
    survivorRatio: survivors / (width * height),
    beforeTransparentRatio: beforeTransparent / (width * height),
  }
}

async function main() {
  mkdirSync(RAW_DIR, { recursive: true })

  process.stdout.write(`Пакшот WB nmId=${NM_ID} photo=${PHOTO}\n  ${SOURCE_URL}\n`)
  const response = await fetch(SOURCE_URL)
  if (!response.ok) throw new Error(`Загрузка не удалась: HTTP ${response.status}`)
  const webp = new Uint8ClampedArray(await response.arrayBuffer())
  writeFileSync(SOURCE_WEBP, webp)
  process.stdout.write(`  скачано ${webp.length} байт → ${SOURCE_WEBP}\n`)

  const { width, height } = probeSize(SOURCE_WEBP)
  process.stdout.write(`  размер ${width}×${height}\n`)

  const source = decodeRgba(SOURCE_WEBP, width, height)
  encodeRgbaToPng(source, width, height, SOURCE_PNG)

  const result = makeCutout({ width, height, pixels: source })
  encodeRgbaToPng(result.pixels, width, height, CUTOUT_PNG)

  const preview = compositeOver(result.pixels, checkerboard(width, height), width, height)
  encodeRgbaToPng(preview, width, height, PREVIEW_PNG)

  const delta = survivorRgbDelta(source, result.pixels, width, height)

  process.stdout.write('\nРезультат\n')
  process.stdout.write(`  прозрачных пикселей: ${(result.transparentRatio * 100).toFixed(2)}%\n`)
  process.stdout.write(`  выживших (альфа ≥ 128): ${(delta.survivorRatio * 100).toFixed(2)}%\n`)
  process.stdout.write(`  suspicious: ${result.suspicious}\n`)
  process.stdout.write(`  максимум изменения RGB у выживших: ${delta.maxDelta}\n`)
  process.stdout.write(`  прозрачных на входе: ${(delta.beforeTransparentRatio * 100).toFixed(2)}%\n`)
  process.stdout.write(`  вырез:  ${CUTOUT_PNG}\n`)
  process.stdout.write(`  превью: ${PREVIEW_PNG}\n`)

  // Файлы должны быть валидными PNG (сигнатура) — дешёвая проверка для отчёта.
  for (const file of [SOURCE_PNG, CUTOUT_PNG, PREVIEW_PNG]) {
    const head = readFileSync(file).subarray(0, 8)
    const isPng = head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    if (!isPng) throw new Error(`${file} не PNG`)
  }
  process.stdout.write('  PNG-сигнатуры на месте\n')
}

main().catch((error) => {
  process.stderr.write(`Ошибка: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
