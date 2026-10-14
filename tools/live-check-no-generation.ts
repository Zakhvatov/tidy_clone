/**
 * Живая проверка всего пути импорта БЕЗ генерации изображений.
 *
 * Прогоняет реальные данные Wildberries через НАСТОЯЩИЙ код проекта:
 *   ссылка → nmId → card.json → фото → детектор пакшота → вырез → распознавание категории.
 *
 * Запуск:  npx vite-node tools/live-check-no-generation.ts
 * Результат: docs/evidence/raw/live-no-generation.json + печать таблицы в stdout.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseWbLink } from '../src/services/wb/parse-link'
import { loadWbCard } from '../src/services/wb/card'
import { analyzeFrame } from '../src/services/wb/packshot'
import { makeCutout } from '../src/services/cutout'
import { mapWbCategory } from '../src/domain/wb-taxonomy'
import { isKnownSub, isKnownTop } from '../src/domain/taxonomy'

const tmp = mkdtempSync(join(tmpdir(), 'tidy-live-'))

function decodeImage(file: string): { width: number; height: number; pixels: Uint8ClampedArray } {
  const raw = join(tmp, `dec-${Math.random().toString(36).slice(2)}.rgba`)
  const meta = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0', file,
  ]).toString().trim().split(',')
  const width = Number(meta[0])
  const height = Number(meta[1])
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', raw])
  return { width, height, pixels: new Uint8ClampedArray(readFileSync(raw)) }
}

function encodePng(pixels: Uint8ClampedArray, width: number, height: number, out: string): void {
  const raw = join(tmp, `enc-${Math.random().toString(36).slice(2)}.rgba`)
  writeFileSync(raw, Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength))
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', raw, out])
}

function downscale(file: string, out: string, size: number, quality: number): void {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `scale=${size}:-2`, '-q:v', String(quality), out])
}

async function download(url: string): Promise<{ file: string; bytes: number }> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const file = join(tmp, `dl-${Math.random().toString(36).slice(2)}.webp`)
  writeFileSync(file, buffer)
  return { file, bytes: buffer.byteLength }
}

const LINKS = [
  'https://www.wildberries.ru/catalog/14058746/detail.aspx',
  'https://wildberries.ru/catalog/14058741/detail.aspx?targetUrl=SG',
  'wildberries.ru/catalog/16020837/detail.aspx',
  'https://www.wildberries.ru/catalog/14058401/detail.aspx?utm_source=x#reviews',
  'https://wb.ru/catalog/14058606/detail.aspx',
]

const NM_IDS = [14058746, 14058741, 16020837]

async function main(): Promise<void> {
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), links: [], cards: [] }

  console.log('\n=== 1. Разбор ссылок (T4) ===')
  const links: unknown[] = []
  for (const link of LINKS) {
    try {
      const { nmId } = parseWbLink(link)
      console.log(`  ok   ${link}  →  nmId=${nmId}`)
      links.push({ link, nmId })
    } catch (error) {
      console.log(`  FAIL ${link}  →  ${(error as Error).message}`)
      links.push({ link, error: (error as Error).message })
    }
  }
  report.links = links

  console.log('\n=== 2–5. Карточка → фото → пакшот → вырез (T5, T6, T7, T9) ===')
  const cards: unknown[] = []
  for (const nmId of NM_IDS) {
    const row: Record<string, unknown> = { nmId }
    const started = Date.now()
    try {
      const card = await loadWbCard(nmId)
      row.название = card.name
      row.wbКатегория = `${card.rootSubjectName ?? '—'} / ${card.subjectName ?? '—'}`
      const mapping = mapWbCategory(card.rootSubjectName, card.subjectName)
      row.нашаКатегория = `${mapping.top} / ${mapping.sub}`
      row.категорияВалидна = isKnownTop(mapping.top) && isKnownSub(mapping.top, mapping.sub)
      row.бренд = card.brand
      row.цвета = card.colors
      row.состав = card.composition
      row.фотоВКарточке = card.photoCount

      // перебор фото: ищем пакшот
      const analyses: Array<Record<string, unknown>> = []
      let packshotIndex = -1
      let packshotPixels: { width: number; height: number; pixels: Uint8ClampedArray } | null = null
      for (let i = 0; i < card.photoUrls.length; i++) {
        const { file, bytes } = await download(card.photoUrls[i])
        const image = decodeImage(file)
        const analysis = analyzeFrame(image)
        analyses.push({ index: i + 1, bytes, whiteness: Number(analysis.whiteness.toFixed(3)), uniformity: Number(analysis.uniformity.toFixed(3)), isPackshot: analysis.isPackshot, reason: analysis.reason })
        if (analysis.isPackshot && packshotIndex === -1) {
          packshotIndex = i + 1
          packshotPixels = image
        }
      }
      row.фотоРазбор = analyses
      row.пакшот = packshotIndex === -1 ? 'нет' : `фото №${packshotIndex}`

      // вырез для пакшота (T9)
      if (packshotPixels) {
        const cut = makeCutout(packshotPixels)
        let maxRgbDiff = 0
        for (let p = 0; p < cut.pixels.length; p += 4) {
          maxRgbDiff = Math.max(
            maxRgbDiff,
            Math.abs(cut.pixels[p] - packshotPixels.pixels[p]),
            Math.abs(cut.pixels[p + 1] - packshotPixels.pixels[p + 1]),
            Math.abs(cut.pixels[p + 2] - packshotPixels.pixels[p + 2]),
          )
        }
        const out = join(process.cwd(), 'docs/evidence/raw', `live-cutout-${nmId}.png`)
        encodePng(cut.pixels, cut.width, cut.height, out)
        row.вырез = {
          прозрачныхДоля: Number(cut.transparentRatio.toFixed(4)),
          подозрительный: cut.suspicious,
          maxИзменениеRGB: maxRgbDiff,
          файл: out.replace(process.cwd() + '/', ''),
        }
      } else {
        row.вырез = 'не делался: пакшота нет'
      }
      row.мсПолногоПути = Date.now() - started
    } catch (error) {
      row.ошибка = (error as Error).message
    }
    cards.push(row)
    const r = row as Record<string, string>
    console.log(`\n  nmId ${nmId}: ${r.название ?? r.ошибка}`)
    if (!r.ошибка) {
      console.log(`    WB: ${r.wbКатегория}  →  наша: ${r.нашаКатегория} (валидна: ${r.категорияВалидна})`)
      console.log(`    цвета: ${JSON.stringify(r.цвета)}  состав: ${JSON.stringify(r.состав)}`)
      console.log(`    фото: ${r.фотоВКарточке}, пакшот: ${r.пакшот}, вырез: ${JSON.stringify(r.вырез)}`)
      console.log(`    путь целиком: ${r.мсПолногоПути} мс`)
      for (const a of (row.фотоРазбор as Array<Record<string, unknown>>)) {
        console.log(`      фото ${a.index}: whiteness=${a.whiteness} uniformity=${a.uniformity} пакшот=${a.isPackshot} (${a.reason})`)
      }
    }
  }
  report.cards = cards

  writeFileSync(join(process.cwd(), 'docs/evidence/raw/live-no-generation.json'), JSON.stringify(report, null, 2))
  console.log('\nОтчёт: docs/evidence/raw/live-no-generation.json\n')
}

main().catch((error) => {
  console.error('ФАТАЛЬНО:', error)
  process.exit(1)
})
