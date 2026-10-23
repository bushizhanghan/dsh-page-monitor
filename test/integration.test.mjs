// Integration test: boot the plugin against a fake ctx (mock tools registry +
// web seam), then drive the registered tools end-to-end:
//   add → check (first) → change page → check (detect) → history
// Run: node test/integration.test.mjs
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const toolRegistry = new Map()
const fakeCtx = {
  tools: { register: (tool) => toolRegistry.set(tool.name, tool) },
  web: {
    // mimic the official seam: a mutable page store
    pages: new Map([
      ['https://example.edu/notice', `<html><body><nav>nav</nav><main><h1>公告</h1><p>今日无新通知。</p></main><footer>f</footer></body></html>`],
    ]),
    async fetch({ url }) {
      const html = this.pages.get(url)
      if (html === undefined) return { url, statusCode: 404, truncated: false, body: { kind: 'html', content: '<html><body>missing</body></html>' } }
      return { url, statusCode: 200, truncated: false, body: { kind: 'html', content: html } }
    },
  },
  setInterval: () => 0,
  setTimeout: (fn) => fn,
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-pm-test-'))
apply(fakeCtx, { dataDir: dir, intervalMinutes: 0 })

const call = async (name, args) => toolRegistry.get(name).execute(args ?? {}, { signal: undefined })

const results = []
try {
  // 1. add starts empty watchlist, first check warms the snapshot
  const added = await call('page_watch_add', { url: 'https://example.edu/notice' })
  results.push(['add', added.ok === true && added.watchers.includes('https://example.edu/notice')])
  const listed1 = await call('page_watch_list', {})
  results.push(['list-after-add', listed1.ok === true && listed1.watchers.length === 1])

  // 2. check again: no change yet
  const check1 = await call('page_watch_check', {})
  const r1 = check1.results[0]
  results.push(['check-nochange', check1.ok === true && r1.changed === false])

  // 3. mutate the page, check again: change + keyword hit → important
  fakeCtx.web.pages.set('https://example.edu/notice', `<html><body><main><h1>公告</h1><p>今日无新通知。</p><p>【新通知】报名开始！</p></main></body></html>`)
  const check2 = await call('page_watch_check', {})
  const r2 = check2.results[0]
  results.push(['check-change', r2.changed === true && r2.important === true && r2.hits.includes('报名')])
  results.push(['added-lines', Array.isArray(r2.added) && r2.added.some((l) => l.includes('报名'))])

  // 4. history records the alert
  const hist = await call('page_watch_history', {})
  results.push(['history', hist.history.length === 1 && hist.history[0].url === 'https://example.edu/notice'])

  // 5. remove
  const removed = await call('page_watch_remove', { url: 'https://example.edu/notice' })
  results.push(['remove', removed.ok === true && removed.watchers.length === 0])

  // 6. error path: nonexistent URL in watchlist → ok:false, no crash
  await call('page_watch_add', { url: 'https://example.edu/missing' })
  const check3 = await call('page_watch_check', {})
  results.push(['missing-url', check3.results[0].ok === false && typeof check3.results[0].error === 'string'])
} catch (error) {
  console.error('UNEXPECTED THROW:', error)
  results.push(['no-throw', false])
} finally {
  rmSync(dir, { recursive: true, force: true })
}

let pass = 0
for (const [name, ok] of results) {
  console.log(`${ok ? '✔' : '✖'} ${name}`)
  if (ok) pass += 1
}
console.log(`\n${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)
