// Integration test: boot the plugin against a fake ctx (mock tools registry +
// web seam), then drive the registered tools end-to-end:
//   add → check (first) → change page → check (detect) → history
// Run: node test/integration.test.mjs
import { mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
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
      if (this.truncated?.has(url)) return { url, statusCode: 200, truncated: true, body: { kind: 'html', content: html } }
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
  // watchers is an array of OBJECTS: the declared output schema says
  // items:{type:'object'}, and the host validates every tool value, so a plain
  // URL string here made the tool fail after its side effects had run.
  results.push(['add', added.ok === true && added.watchers.some((w) => w.url === 'https://example.edu/notice')])
  results.push(['add reports the baseline', /baseline captured/.test(added.message || '')])
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

  // 7. a truncated body is an error, not a silent half-snapshot: past the cap a
  //    real change is invisible, and a cut inside <script> leaks JSON as text.
  fakeCtx.web.truncated = new Set(['https://example.edu/big'])
  fakeCtx.web.pages.set('https://example.edu/big', '<html><body><main><p>hi</p></main></body></html>')
  const bigAdd = await call('page_watch_add', { url: 'https://example.edu/big' })
  const bigCheck = await call('page_watch_check', { url: 'https://example.edu/big' })
  results.push(['truncated-body-is-an-error', bigCheck.results[0].ok === false && /100000-char fetch cap/.test(bigCheck.results[0].error)])
  results.push(['truncated-baseline-is-reported', /baseline fetch failed/.test(bigAdd.message || '')])

  // 8. two hosts that slugOf collapses to the same name must not share a file
  const cjk = ['https://例子.中国/公告', 'https://另一个例子.中国/通知']
  for (const url of cjk) {
    fakeCtx.web.pages.set(url, `<html><body><main><p>${url}</p></main></body></html>`)
    await call('page_watch_add', { url })
  }
  const snaps = readdirSync(join(dir, 'snapshots'))
  const cjkFiles = snaps.filter((f) => /^https_[0-9a-f]{10}\.json$/.test(f))
  results.push(['cjk hosts get separate snapshots', cjkFiles.length === 2])

  // 9. a corrupt watchlist must stop a mutating call instead of wiping the list
  const listFile = join(dir, 'watchlist.json')
  const good = readFileSync(listFile, 'utf8')
  writeFileSync(listFile, good.slice(0, 20), 'utf8')
  let corruptError = ''
  try {
    await call('page_watch_add', { url: 'https://example.edu/x' })
  } catch (error) {
    corruptError = String(error?.message || error)
  }
  results.push(['corrupt watchlist refuses to be overwritten', /not valid JSON/.test(corruptError)])
  writeFileSync(listFile, good, 'utf8')
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
