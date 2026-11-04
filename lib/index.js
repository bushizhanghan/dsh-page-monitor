// dsh-page-monitor: register page_watch_* agent tools over the official
// ctx.web fetch seam. Watchlist + snapshots + alerts live under
// ~/.dsh/dsh-page-monitor/ (override with config.dataDir). Loaded via
// cordis.patch.yml row `dsh-page-monitor` (package.json dsh.bundle).
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { addedLines, htmlToText, judgeImportance, makeSnapshot, slugOf, urlFingerprint } from './engine.js'

export const name = 'page-monitor'
// 'timer' is not optional: apply() schedules a sweep whenever intervalMinutes > 0
// (the default). It worked only because the base layer always mounts the timer
// plugin; declaring it makes the dependency explicit and load-ordered.
export const inject = ['tools', 'web', 'timer']

const DEFAULT_KEYWORDS = ['通知', '公告', '报名', '考试', '成绩', '放假', '补录', '放票']

const Config = {
  intervalMinutes: 60, // 0 = no scheduled sweep, only manual `page_watch_check`
  threshold: 0.3,
  // The whole-page ratio is a magnitude measure and a single new announcement
  // on a few-thousand-char page is ~5%, so the ratio alone almost never fires.
  // Any 2+ new lines also count as important.
  minAddedLines: 2,
  keywords: DEFAULT_KEYWORDS,
  webhookUrl: '',
  dataDir: '',
  // Body-extraction provider. 'dsh' uses the official ctx.web seam
  // (free, SSRF-guarded, no key) — fine for ordinary sites. Sites behind
  // JS/anti-bot WAFs (e.g. bupt.edu.cn is RiverSecurity-protected and
  // replies 412 to any non-browser client) need 'lexmount', the same
  // extractor API the author's lesson1_monitor.py used: server-side
  // rendering that passes the WAF. Key configured via config or env.
  provider: 'dsh',
  lexmountApiKey: '',
  lexmountProjectId: '',
}

export function apply(ctx, config = {}) {
  const cfg = { ...Config, ...config }
  const dataDir = cfg.dataDir || join(homedir(), '.dsh', 'dsh-page-monitor')
  const watchlistFile = join(dataDir, 'watchlist.json')
  const snapDir = join(dataDir, 'snapshots')
  const alertsFile = join(dataDir, 'alerts.jsonl')
  mkdirSync(snapDir, { recursive: true })

  // ---------- storage helpers (synchronous, tiny) ----------
  const readJson = (file, fallback) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return fallback
    }
  }
  // null = the file exists but will not parse. Callers that mutate state must
  // refuse rather than treat it as "empty", or one truncated write silently
  // deletes the whole watchlist.
  const readWatchlist = () => {
    if (!existsSync(watchlistFile)) return []
    try {
      const parsed = JSON.parse(readFileSync(watchlistFile, 'utf8'))
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  const writeWatchlist = (list) => {
    mkdirSync(dataDir, { recursive: true })
    // atomic: a kill mid-write must not truncate the only copy of the list
    const tmp = `${watchlistFile}.tmp`
    writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8')
    renameSync(tmp, watchlistFile)
  }
  // For the mutating tools: a corrupt file must stop the call, not be treated
  // as an empty list (which deletes every watcher on the next write).
  const mutableWatchlist = () => {
    const list = readWatchlist()
    if (list === null) throw new Error(`${watchlistFile} is not valid JSON — fix or delete it first; refusing to overwrite it`)
    return list
  }
  const watcherView = (list) => list.map((e) => ({ url: e.url, keywords: e.keywords || cfg.keywords }))
  // The slug drops every non-ASCII character, so 例子.中国 and 另一个例子.中国
  // both became "https" and shared one snapshot. The URL hash keeps them apart.
  const snapshotFile = (url) => join(snapDir, `${slugOf(url)}_${urlFingerprint(String(url))}.json`)
  const readSnapshot = (url) => readJson(snapshotFile(url), null)
  const writeSnapshot = (url, snap) => {
    const file = snapshotFile(url)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8')
    renameSync(tmp, file)
  }
  const appendAlert = (entry) => {
    mkdirSync(dataDir, { recursive: true })
    appendFileSync(alertsFile, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  // ---------- fetch one page (provider dispatch) ----------
  async function fetchText(url, signal) {
    if ((cfg.provider || 'dsh') === 'lexmount') return fetchTextLexmount(url, signal)
    return fetchTextWebSeam(url, signal)
  }

  // official ctx.web seam: SSRF-guarded, returns decoded body
  async function fetchTextWebSeam(url, signal) {
    const result = await ctx.web.fetch({ url }, signal)
    const status = result.statusCode ?? 0
    if (status >= 400) throw new Error(`HTTP ${status} (anti-bot/WAF pages need the lexmount provider)`)
    // The seam caps a body at 100 000 chars and says so. Silently snapshotting
    // the first 100k means a change past the cut is invisible forever — and if
    // the cut lands inside an inline <script>, ~90k of JSON becomes page text.
    if (result.truncated) {
      throw new Error('body exceeded the 100000-char fetch cap; changes past the cut cannot be detected (use the lexmount provider or watch a shorter page)')
    }
    const body = result?.body?.content ?? ''
    const text = result?.body?.kind === 'html' ? htmlToText(body) : body.trim()
    if (!text) throw new Error(`empty body (HTTP ${status}; anti-bot/WAF pages need the lexmount provider)`)
    const title = text.split('\n')[0]?.slice(0, 120) || result.url
    return { ok: true, text, title, statusCode: result.statusCode }
  }

  // lexmount extract API: the same server-side extractor the author's
  // lesson1_monitor.py used; renders through JS WAFs. Key from config or env.
  async function fetchTextLexmount(url, signal) {
    const apiKey = cfg.lexmountApiKey || process.env.LEXMOUNT_API_KEY || ''
    const projectId = cfg.lexmountProjectId || process.env.LEXMOUNT_PROJECT_ID || ''
    if (!apiKey || !projectId) throw new Error('lexmount provider needs lexmountApiKey + lexmountProjectId (config or LEXMOUNT_API_KEY/LEXMOUNT_PROJECT_ID env)')
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    // The seam has its own 30s deadline; this path had none, so a stalled
    // response hung the tool (and, with signal: undefined, the sweep) forever.
    const deadline = setTimeout(() => controller.abort(), 30_000)
    try {
      const res = await fetch('https://api.lexmount.cn/v1/extract', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'X-Project-Id': projectId },
        body: JSON.stringify({ extract: { url } }),
      })
      if (!res.ok) throw new Error(`lexmount HTTP ${res.status}`)
      const data = await res.json()
      const mainText = data?.result?.main_text ?? ''
      if (!mainText) throw new Error('lexmount returned no main_text')
      return { ok: true, text: mainText, title: data?.result?.title || mainText.split('\n')[0]?.slice(0, 120) || url, statusCode: 200 }
    } finally {
      clearTimeout(deadline)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  // ---------- check one URL: fetch → snapshot/diff → judge → alert ----------
  async function checkUrl(entry, { signal }) {
    const { url, keywords = cfg.keywords } = entry
    let got
    try {
      got = await fetchText(url, signal)
    } catch (error) {
      return {
        url,
        ok: false,
        error: error?.message?.slice(0, 200) || String(error),
        statusCode: null,
      }
    }
    const old = readSnapshot(url)
    if (old === null) {
      writeSnapshot(url, makeSnapshot({ url, title: got.title, text: got.text }))
      return { url, ok: true, first: true, title: got.title, statusCode: got.statusCode }
    }
    const verdict = judgeImportance({ oldText: old.text, newText: got.text, threshold: cfg.threshold, keywords, minAddedLines: cfg.minAddedLines })
    // unconditionally refresh the snapshot so the next sweep diffs against now
    const fresh = makeSnapshot({ url, title: got.title || old.title, text: got.text })
    writeSnapshot(url, fresh)
    const changed = fresh.hash !== old.hash
    const added = changed && verdict.important ? addedLines(old.text, got.text, 30) : []
    if (changed && verdict.important) {
      const alert = {
        url,
        title: got.title || old.title || url,
        at: fresh.savedAt,
        ratio: verdict.ratio,
        hits: verdict.hits,
        reason: verdict.reason,
        added,
      }
      appendAlert(alert)
      notifyWebhook(alert)
    }
    return {
      url,
      ok: true,
      title: got.title || old.title,
      statusCode: got.statusCode,
      changed,
      important: changed && verdict.important,
      ratio: verdict.ratio,
      hits: verdict.hits,
      reason: verdict.reason,
      added,
    }
  }

  // ---------- webhook: enterprise-WeChat style POST (no-op when unset) ----------
  async function notifyWebhook(alert) {
    if (!cfg.webhookUrl) return
    const text = [
      `【网页监控】${alert.title}`,
      alert.url,
      alert.reason,
      ...alert.added.slice(0, 10).map((l) => `> ${l}`),
    ].join('\n')
    try {
      await fetch(cfg.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text.slice(0, 4000) } }),
      })
    } catch (error) {
      console.error(`[page-monitor] webhook failed: ${error?.message}`)
    }
  }

  // ---------- scheduled sweep ----------
  if (cfg.intervalMinutes > 0) {
    const io = 5 // per-URL interleave seconds
    let sweeping = false
    ctx.setInterval(() => {
      // A sweep can outlive its interval (each URL may burn 30 s), and a second
      // sweep would double-fetch every page and race on the snapshot files.
      if (sweeping) return
      sweeping = true
      const list = readWatchlist() ?? []
      let delay = 0
      for (const entry of list) {
        const run = () => checkUrl(entry, { signal: undefined }).catch(() => {})
        ctx.setTimeout(run, delay)
        delay += io * 1000
      }
      // release after the last URL's budget plus one fetch deadline
      ctx.setTimeout(() => {
        sweeping = false
      }, delay + 35_000)
    }, cfg.intervalMinutes * 60_000)
  }

  // ---------- tool definitions ----------
  const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      results: { type: 'array', items: { type: 'object' } },
      watchers: { type: 'array', items: { type: 'object' } },
      history: { type: 'array', items: { type: 'object' } },
      message: { type: 'string' },
    },
  }
  const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  const tools = [
    {
      name: 'page_watch_list',
      description:
        'List the watched URLs with their current snapshot status (first-seen time, saved hash) and the configured keywords per URL. Read this before adding or checking. Returns {ok, watchers:[{url,title,firstSeen,lastChecked,keywords}]}.',
      parameters: {
        type: 'object',
        properties: {},
      },
      async execute() {
        const watchers = mutableWatchlist().map((e) => {
          const snap = readSnapshot(e.url)
          return {
            url: e.url,
            title: e.title || snap?.title || '',
            keywords: e.keywords || cfg.keywords,
            firstSeen: snap?.savedAt || null,
            lastChecked: snap?.checkedAt || null,
            hash: snap?.hash || null,
          }
        })
        return { ok: true, watchers }
      },
    },
    {
      name: 'page_watch_add',
      description:
        'Add a URL to the page-monitor watchlist. Optional keywords override the global list for this URL (e.g. ["放票","补录"]); pass them to narrow or widen what counts as important. Adding an already-watched URL is a no-op report. Returns the updated watchlist.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTP(S) URL to watch, e.g. https://www.bupt.edu.cn' },
          keywords: { type: 'array', items: { type: 'string' }, description: 'Optional per-URL important keywords' },
        },
        required: ['url'],
      },
      async execute(args, exec) {
        const url = String(args.url || '').trim()
        if (!/^https?:\/\//i.test(url)) throw new Error('url must be a valid http(s) URL')
        const list = mutableWatchlist()
        const existed = list.some((e) => e.url === url)
        let entry = list.find((e) => e.url === url)
        if (!entry) {
          entry = { url, title: '', keywords: Array.isArray(args.keywords) ? args.keywords : undefined, addedAt: new Date().toISOString() }
          list.push(entry)
          writeWatchlist(list)
        } else if (Array.isArray(args.keywords)) {
          entry.keywords = args.keywords
          writeWatchlist(list)
        }
        // Warm the baseline only for a NEW url. Re-adding an existing one must
        // not diff against the kept snapshot and alert: the tool would report
        // "changed" for a page nobody touched. Report the baseline result
        // instead of swallowing it, so a WAF-blocked first fetch is visible.
        let baseline = null
        if (!existed) {
          baseline = await checkUrl(entry, { signal: exec.signal }).catch((error) => ({ ok: false, error: String(error?.message || error) }))
        }
        return {
          ok: true,
          watchers: watcherView(list),
          message: existed ? `already watched: ${url}` : baseline?.ok ? `added and baseline captured: ${url}` : `added, but the baseline fetch failed: ${baseline?.error || 'unknown error'} — the next check will report "first seen" instead of a change`,
        }
      },
    },
    {
      name: 'page_watch_remove',
      description:
        'Remove a URL from the page-monitor watchlist. Returns the remaining watchlist. The snapshot file is kept, so re-adding the same URL does not alarm on old content.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The exact watched URL to remove' } },
        required: ['url'],
      },
      async execute(args) {
        const url = String(args.url || '').trim()
        const list = mutableWatchlist()
        const next = list.filter((e) => e.url !== url)
        if (next.length === list.length) return { ok: true, message: `not watched: ${url}`, watchers: watcherView(next) }
        writeWatchlist(next)
        return { ok: true, watchers: watcherView(next) }
      },
    },
    {
      name: 'page_watch_check',
      description:
        'Sweep the watchlist now: fetch each watched URL, diff the new text against the stored snapshot, refresh the snapshot, and report changes. An important change (ratio ≥ threshold or keyword hit) is recorded in the alert log and sent to the configured webhook. Optional url checks only that one entry. Returns per-URL {ok, changed, important, ratio, hits, reason, added:[new lines]}.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Optional: check only this watched URL' },
        },
      },
      async execute(args, exec) {
        const list = mutableWatchlist()
        const entries = args.url ? list.filter((e) => e.url === args.url) : list
        if (entries.length === 0) throw new Error(args.url ? `not watched: ${args.url} (add it first)` : 'watchlist is empty (add a URL first)')
        const results = []
        for (const entry of entries) {
          results.push(await checkUrl(entry, { signal: exec.signal }))
        }
        return { ok: true, results }
      },
    },
    {
      name: 'page_watch_history',
      description:
        'Read the recorded important-change alert log for one URL (or the whole log). Each entry: {url,title,at,ratio,hits,reason,added:[new lines]}. Use after a check reported important=true, or to answer "what changed on X recently".',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Optional: filter by URL' }, limit: { type: 'integer', description: 'Optional: newest N entries (default 20)' } },
      },
      async execute(args) {
        if (!existsSync(alertsFile)) return { ok: true, history: [] }
        // Clamp: `limit: 0` used to mean "all", a negative meant 1, and there
        // was no upper bound on how much of the log one call could read.
        const raw = Number(args.limit)
        const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 500) : 20
        // The log is append-only and unbounded, so read only the tail. 8 KiB of
        // UTF-8 is far more than 500 entries of this shape.
        const size = statSync(alertsFile).size
        const start = Math.max(0, size - 64 * 1024)
        const fd = openSync(alertsFile, 'r')
        let chunk
        try {
          chunk = Buffer.alloc(size - start)
          readSync(fd, chunk, 0, chunk.length, start)
        } finally {
          closeSync(fd)
        }
        const text = chunk.toString('utf8')
        const lines = text.split('\n').filter(Boolean)
        // a tail read can start mid-line: drop the first partial entry
        if (start > 0 && lines.length > 0) lines.shift()
        const history = lines
          .map((l) => {
            try {
              return JSON.parse(l)
            } catch {
              return null
            }
          })
          .filter(Boolean)
          .filter((e) => !args.url || e.url === args.url)
          .slice(-limit)
          .reverse()
        return { ok: true, history }
      },
    },
  ]

  for (const tool of tools) {
    try {
      ctx.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: { schema: OUTPUT_SCHEMA, render },
        // A sweep fetches one URL after another, each with its own 30 s deadline,
        // so the old 75 s cap was shorter than the work the tool schedules for
        // itself. Capped at 200 s: past that a watchlist is too long to sweep in
        // one call and the caller should pass `url`.
        timeoutMs: 200_000,
        isConcurrencySafe: () => true,
        presentCall: (args) => ({ card: 'generic', title: tool.name, kind: 'read', rawInput: args }),
        execute: tool.execute,
      })
    } catch (error) {
      console.error(`[page-monitor] ${tool.name} registration skipped: ${error}`)
    }
  }
}
