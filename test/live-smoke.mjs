// Real-world smoke test: fetch two live university pages through plain fetch
// (the DSH web seam is unavailable outside a plugin context; this validates
// htmlToText + snapshot + changeRatio on real HTML instead). Run:
//   node test/live-smoke.mjs [url1] [url2]
import { htmlToText, makeSnapshot, snapshotFingerprint, changeRatio, judgeImportance, addedLines } from '../lib/engine.js'

const urls = process.argv.slice(2).length ? process.argv.slice(2) : ['https://www.bupt.edu.cn', 'https://www.bupt.edu.cn/xxgg.htm']
const out = []
for (const url of urls) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0' } })
  const html = await res.text()
  const text = htmlToText(html)
  const snap = makeSnapshot({ url, title: '', text })
  const ratio = changeRatio(text, text.slice(0, Math.floor(text.length * 0.95)))
  const judged = judgeImportance({ oldText: text.slice(0, Math.floor(text.length * 0.5)), newText: text, keywords: ['通知', '公告'] })
  out.push({
    url,
    http: res.status,
    htmlChars: html.length,
    textChars: text.length,
    textLines: text.split('\n').length,
    hash: snap.hash,
    ratioSelf95: ratio,
    keywordsHit: judged.hits,
    sample: text.split('\n').slice(0, 3),
  })
}
console.log(JSON.stringify(out, null, 2))
