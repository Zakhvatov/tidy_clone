/**
 * T5-fix: живая проверка подбора basket-лоадера.
 *
 * Прогоняет реальный `loadWbCard` по живой сети и считает запросы/время:
 *   - 1318303621 — регресс из задачи (товар на basket-45, таблица даёт 65);
 *   - 14058746 / 14058741 / 16020837 — контрольные, грузились и раньше;
 *   - повторный вызов — показывает работу кэша лоадера.
 *
 * Запуск:  npx vite-node tools/t5-fix-live.ts
 * Результат: docs/evidence/raw/t5-fix-live.txt
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadWbCard, MAX_BASKET } from '../src/services/wb/card'
import { clearBasketCache } from '../src/services/wb/basket-cache'
import type { ОшибкаЗагрузкиКарточки } from '../src/services/wb/errors'

// В Node нет `localStorage` — подкладываем in-memory шим, чтобы кэш лоадеров
// работал и его поведение было видно в живом прогоне.
const store = new Map<string, string>()
const localStorageShim: Storage = {
  get length() {
    return store.size
  },
  clear: () => store.clear(),
  getItem: (key: string) => store.get(key) ?? null,
  key: (index: number) => [...store.keys()][index] ?? null,
  removeItem: (key: string) => {
    store.delete(key)
  },
  setItem: (key: string, value: string) => {
    store.set(key, String(value))
  },
}
// SAFETY: Node (vite-node) в этом инструменте играет роль браузера; добавляем
// отсутствующее у него глобальное `localStorage` ровно тем же интерфейсом.
Object.assign(globalThis, { localStorage: localStorageShim })

const NM_IDS = [1318303621, 14058746, 14058741, 16020837] as const

const lines: string[] = []
function log(line: string): void {
  lines.push(line)
  console.log(line)
}

interface Counter {
  fetchImpl: typeof fetch
  count: () => number
  urls: () => string[]
}

function countingFetch(): Counter {
  let count = 0
  const urls: string[] = []
  // SAFETY: `input` — URL, который `loadWbCard` строит сам из nmId по шаблону
  // basket-NN.wbbasket.ru; внешних данных в него не подставляется. Это
  // обёртка над штатным `fetch`, а не приём произвольных адресов.
  const realFetch = globalThis.fetch.bind(globalThis)
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    count += 1
    urls.push(String(input))
    return realFetch(input, init)
  }) as typeof fetch
  return { fetchImpl, count: () => count, urls: () => urls }
}

function loaderOf(url: string): string | undefined {
  return /basket-(\d+)/.exec(url)?.[1]
}

async function main(): Promise<void> {
  log(`# T5-fix — живая проверка подбора basket-лоадера`)
  log(`Дата: ${new Date().toISOString()}`)
  log(`MAX_BASKET=${MAX_BASKET}`)
  log('')

  log('## Основные товары')
  for (const nmId of NM_IDS) {
    const counter = countingFetch()
    const started = Date.now()
    try {
      const card = await loadWbCard(nmId, counter.fetchImpl)
      const ms = Date.now() - started
      const loaders = [...new Set(counter.urls().map(loaderOf).filter((n): n is string => n !== undefined))]
      log(
        `OK   nmId=${nmId}  name="${card.name ?? '—'}"  subject="${card.subjectName ?? '—'}"  ` +
          `запросов=${counter.count()}  мс=${ms}  лоадеры=${loaders.join(',')}`,
      )
    } catch (cause) {
      const ms = Date.now() - started
      const error = cause as ОшибкаЗагрузкиКарточки
      log(
        `FAIL nmId=${nmId}  code=${error.code ?? '?'}  msg="${error.message}"  ` +
          `запросов=${counter.count()}  мс=${ms}`,
      )
    }
  }

  log('')
  log('## Регресс 1318303621: по каким лоадерам шёл перебор (без кэша)')
  clearBasketCache()
  const detail = countingFetch()
  const detailStarted = Date.now()
  const detailCard = await loadWbCard(1318303621, detail.fetchImpl)
  log(`name="${detailCard.name}"  мс=${Date.now() - detailStarted}`)
  for (const url of detail.urls()) {
    log(`  GET ${url.replace('https://', '')}`)
  }

  log('')
  log('## Кэш найденного лоадера (vol=13183 → basket-45)')
  clearBasketCache()
  const first = countingFetch()
  const firstStarted = Date.now()
  await loadWbCard(1318303621, first.fetchImpl)
  log(`первый вызов (без кэша): запросов=${first.count()}  мс=${Date.now() - firstStarted}`)
  const second = countingFetch()
  const secondStarted = Date.now()
  const cachedCard = await loadWbCard(1318303621, second.fetchImpl)
  log(
    `второй вызов (кэш): запросов=${second.count()}  мс=${Date.now() - secondStarted}  ` +
      `name="${cachedCard.name}"  url=${second.urls()[0] ?? '—'}`,
  )

  writeFileSync(join(process.cwd(), 'docs/evidence/raw/t5-fix-live.txt'), lines.join('\n') + '\n')
}

main().catch((cause: unknown) => {
  console.error('ФАТАЛЬНО:', cause)
  process.exit(1)
})
