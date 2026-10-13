import { mapWbCategory } from '../src/domain/wb-taxonomy.ts'

const targets = ['Верх','Низ','Платья','Верхняя одежда','Второй слой','Обувь','Аксессуары','Бельё']
const perTop = 2
const found = {}
const basketFor = (id) => { const vol = Math.floor(id/100000); return vol < 144 ? '01' : vol < 288 ? '02' : '03' }
const log = []
async function one(id) {
  const vol = Math.floor(id/100000), part = Math.floor(id/1000)
  const url = `https://basket-${basketFor(id)}.wbbasket.ru/vol${vol}/part${part}/${id}/info/ru/card.json`
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) return null
    const c = await r.json()
    return { nmId: id, basket: basketFor(id), subj: c.subj_name, root: c.subj_root_name, name: c.imt_name, colors: c.nm_colors_names, brand: c.selling && c.selling.brand_name }
  } catch { return null }
}
function take(card) {
  if (!card || !card.subj) return
  const m = mapWbCategory(card.root, card.subj)
  if (!targets.includes(m.top)) return
  if (!found[m.top]) found[m.top] = []
  if (found[m.top].length >= perTop) return
  if (found[m.top].some(x => x.subj === card.subj)) return
  found[m.top].push({ ...card, top: m.top, sub: m.sub })
  log.push(`${card.nmId} ${m.top}/${m.sub} subj=${card.subj} name=${card.name}`)
}
const ranges = [[14058400, 14062000]]
let i = 0
for (const [start, end] of ranges) {
  const ids = []
  for (let id = start; id < end; id++) ids.push(id)
  i = 0
  const CONC = 28
  async function worker() {
    while (i < ids.length) {
      const id = ids[i++]
      take(await one(id))
    }
  }
  await Promise.all(Array.from({length: CONC}, worker))
  if (targets.every(t => (found[t]||[]).length >= perTop)) break
}
console.log(log.join('\n'))
console.log('---MISSING---', targets.filter(t => !(found[t]||[]).length))
console.log('---JSON---')
console.log(JSON.stringify(found, null, 1))
