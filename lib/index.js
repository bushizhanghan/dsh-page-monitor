// dsh-page-monitor: register page_watch_* agent tools over the official
// ctx.web fetch seam. Watchlist + snapshots + alerts live under
// ~/.dsh/dsh-page-monitor/ (override with config.dataDir). Loaded via
// cordis.patch.yml row `dsh-page-monitor` (package.json dsh.bundle).
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { addedLines, htmlToText, judgeImportance, makeSnapshot, slugOf } from './engine.js'

export const name = 'page-monitor'
export const inject = ['tools', 'web']

const DEFAULT_KEYWORDS = ['通知', '公告', '报名', '考试', '成绩', '放假', '补录', '放票']

const Config = {
  intervalMinutes: 60, // 0 = no scheduled sweep, only manual `page_watch_check`
  threshold: 0.3,
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
  const readWatchlist = () => readJson(watchlistFile, [])
  const writeWatchlist = (list) => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(watchlistFile, JSON.stringify(list, null, 2), 'utf8')
  }
  const snapshotFile = (url) => join(snapDir, `${slugOf(url)}.json`)
  const readSnapshot = (url) => readJson(snapshotFile(url), null)
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
      writeFileSync(snapshotFile(url), JSON.stringify(makeSnapshot({ url, title: got.title, text: got.text }), null, 2), 'utf8')
      return { url, ok: true, first: true, title: got.title, statusCode: got.statusCode }
    }
    const verdict = judgeImportance({ oldText: old.text, newText: got.text, threshold: cfg.threshold, keywords })
    // unconditionally refresh the snapshot so the next sweep diffs against now
    const fresh = makeSnapshot({ url, title: got.title || old.title, text: got.text })
    fresh.prevHash = old.hash
    writeFileSync(snapshotFile(url), JSON.stringify(fresh, null, 2), 'utf8')
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
    ctx.setInterval(() => {
      let delay = 0
      for (const entry of readWatchlist()) {
        const run = () => checkUrl(entry, { signal: undefined }).catch(() => {})
        ctx.setTimeout(run, delay)
        delay += io * 1000
      }
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
        const watchers = readWatchlist().map((e) => {
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
        const list = readWatchlist()
        let entry = list.find((e) => e.url === url)
        if (!entry) {
          entry = { url, title: '', keywords: Array.isArray(args.keywords) ? args.keywords : undefined, addedAt: new Date().toISOString() }
          list.push(entry)
          writeWatchlist(list)
        } else if (Array.isArray(args.keywords)) {
          entry.keywords = args.keywords
          writeWatchlist(list)
        }
        // warm the first snapshot so the next check has a baseline
        await checkUrl(entry, { signal: exec.signal }).catch(() => {})
        return { ok: true, watchers: list.map((e) => e.url) }
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
        const list = readWatchlist()
        const next = list.filter((e) => e.url !== url)
        if (next.length === list.length) return { ok: true, message: `not watched: ${url}`, watchers: next.map((e) => e.url) }
        writeWatchlist(next)
        return { ok: true, watchers: next.map((e) => e.url) }
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
        const list = readWatchlist()
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
        const limit = Math.max(1, Number(args.limit) || 20)
        const lines = readFileSync(alertsFile, 'utf8').trim().split('\n').filter(Boolean)
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
        timeoutMs: 75_000,
        isConcurrencySafe: () => true,
        presentCall: (args) => ({ card: 'generic', title: tool.name, kind: 'tool', rawInput: args }),
        execute: tool.execute,
      })
    } catch (error) {
      console.error(`[page-monitor] ${tool.name} registration skipped: ${error}`)
    }
  }
}
