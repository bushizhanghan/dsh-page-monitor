// dsh-page-monitor engine: pure functions for watchlist snapshots, change
// detection, and importance judgment. No DSH imports, no network: callers
// inject fetch and storage. This mirrors the flow of the author's earlier
// lesson1_monitor.py (感知→记忆→决策→行动) but standalone-testable.
import { createHash } from 'node:crypto'

// =====================================================================
// HTML → plain text (smallest dependency-free extractor: strip scripts,
// styles, nav/footer noise, tags, decode entities, collapse whitespace)
// =====================================================================
const BLOCK_TAGS = /<\/?(?:p|div|section|article|main|li|tr|h[1-6]|br|blockquote|pre|table|ul|ol)[^>]*>/gi

export function htmlToText(html) {
  let s = String(html)
  // keep only the visible main body when a main/article exists
  const main = s.match(/<(?:main|article)[\s>][\s\S]*?<\/(?:main|article)>/i)
  if (main) s = main[0]
  // drop script/style/noscript/template/head blocks wholesale
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(?:nav|footer|aside|header|form)[\s>][\s\S]*?<\/(?:nav|footer|aside|header|form)>/gi, ' ')
  // block-level tags become newlines so adjacent lines stay separable
  s = s.replace(BLOCK_TAGS, '\n')
  // strip remaining tags and comments
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
  // decode the common entities (numeric + named)
  s = s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
  // normalize: per-line trim, drop blanks, join
  return s
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

// =====================================================================
// URL → filesystem-safe slug (same scheme the author's script used)
// =====================================================================
export function slugOf(url) {
  return String(url).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase().replace(/^_+|_+$/g, '').slice(0, 80) || 'url'
}

// =====================================================================
// Snapshot shape + helpers
// =====================================================================
export function snapshotFingerprint(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function makeSnapshot({ url, title, text }) {
  const now = new Date().toISOString()
  return {
    url,
    title: title || '',
    text,
    hash: snapshotFingerprint(text),
    savedAt: now,
    checkedAt: now,
  }
}

// =====================================================================
// Change ratio: character-bigram Dice, the same math as
// difflib.SequenceMatcher.quick_ratio (2·matches / total length) so it
// matches the author's original lesson1_monitor semantics, dependency-free.
// 0 = identical, 1 = completely different.
// =====================================================================
export function changeRatio(oldText, newText) {
  if (!oldText && !newText) return 0
  if (!oldText || !newText) return 1
  const norm = (t) => t.replace(/\s+/g, ' ').trim()
  const bigrams = (text) => {
    const s = norm(text)
    if (s.length < 2) return new Set([s])
    const out = new Set()
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
    return out
  }
  const a = bigrams(oldText)
  const b = bigrams(newText)
  let inter = 0
  for (const g of a) if (b.has(g)) inter += 1
  const total = a.size + b.size
  if (total === 0) return 0
  return 1 - (2 * inter) / total
}

// =====================================================================
// Importance: ratio threshold OR keyword hit (the author's rule版; the
// learning plan replaces judge with an LLM later — swap only this function)
// =====================================================================
export function judgeImportance({ oldText, newText, threshold = 0.3, keywords = [] }) {
  const ratio = changeRatio(oldText, newText)
  const hits = (keywords || []).filter((k) => k && newText.includes(k))
  const important = ratio >= threshold || hits.length > 0
  return {
    important,
    ratio,
    hits,
    reason: [ratio >= threshold ? `变化率 ${(ratio * 100).toFixed(0)}%` : '', hits.length ? `命中关键词 ${hits.join('、')}` : '']
      .filter(Boolean)
      .join('；'),
  }
}

// =====================================================================
// Added-line diff: the lines in newText absent from oldText, up to a cap,
// so a notify/alarm shows what changed instead of the whole page.
// =====================================================================
export function addedLines(oldText, newText, cap = 30) {
  const oldSet = new Set(String(oldText).split('\n'))
  const added = []
  for (const line of String(newText).split('\n')) {
    const t = line.trim()
    if (t && !oldSet.has(t)) added.push(t)
    if (added.length >= cap) break
  }
  return added
}
