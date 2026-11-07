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
  // keep only the visible main body when a main/article exists. Greedy: a
  // notice list is sibling <article> cards, and a non-greedy match keeps only
  // the first card, so a new announcement in card #4 is never seen.
  const main = s.match(/<(?:main|article)[\s>][\s\S]*<\/(?:main|article)>/i)
  if (main) s = main[0]
  // drop script/style/noscript/template/head blocks wholesale
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(?:nav|footer|aside|header|form)[\s>][\s\S]*?<\/(?:nav|footer|aside|header|form)>/gi, ' ')
    // a body cut inside an inline <script> has no closing tag left, so the
    // paired strip above misses it and ~90k of JSON becomes "page text"
    .replace(/<(?:script|style|noscript|template)[\s\S]*$/i, ' ')
  // block-level tags become newlines so adjacent lines stay separable
  s = s.replace(BLOCK_TAGS, '\n')
  // strip remaining tags and comments
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
  // decode the common entities (numeric + named). Twice, because publishers
  // double-encode (`&amp;nbsp;`): the `&amp;` pass would otherwise leave a
  // literal "&nbsp;" in the snapshot and every diff shows it as text.
  // shortcut: a second pass also turns `&amp;lt;` into "<" instead of the
  // literal text "&lt;". Rare, stable across both snapshots, and cheaper than
  // tracking which characters the first pass produced.
  // String.fromCodePoint throws RangeError above 0x10FFFF, which a double-encoded
  // `&amp;#x110000;` reaches on the second pass.
  const safeCp = (cp, raw) => (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : raw)
  const decodeEntities = (t) =>
    t
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeCp(parseInt(h, 16), m))
      .replace(/&#(\d+);/g, (m, d) => safeCp(Number(d), m))
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&amp;/gi, '&')
  s = decodeEntities(decodeEntities(s))
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

// The slug drops every non-ASCII character, so 例子.中国 and 另一个例子.中国
// both collapsed to "https" and shared one snapshot file. The digest of the
// full URL keeps them apart; it is short because it only has to disambiguate.
export function urlFingerprint(url) {
  return createHash('sha1').update(String(url)).digest('hex').slice(0, 10)
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
// Change ratio: character-bigram Dice (2·|A∩B| / (|A|+|B|)) over the whole
// page. 0 = identical, 1 = completely different.
// NOT the same as difflib.SequenceMatcher.quick_ratio — that counts a
// multiset of single characters, so the two disagree on reorderings
// (changeRatio('abc','cba') is 1). The bigram form is what we want here:
// it is insensitive to moved blocks, which a notice page does not do.
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
export function judgeImportance({ oldText, newText, threshold = 0.3, keywords = [], minAddedLines = 2 }) {
  const ratio = changeRatio(oldText, newText)
  // The whole-page ratio is a magnitude measure: one new announcement on a
  // 5 000-char page is ~5%, so a 30% threshold only ever fires on a total
  // rewrite. New lines are what "something was published" actually looks like.
  const added = addedLines(oldText, newText, 200)
  const addedText = added.join('\n')
  // A keyword only counts inside text that was not there before. Matching the
  // whole new page fired on 通知/公告/成绩 already sitting in the site's nav, and
  // requiring absence from the whole old page meant a page that ever mentioned
  // the word could never alert again.
  const hits = (keywords || []).filter((k) => k && addedText.includes(k))
  const enoughLines = added.length >= minAddedLines
  const important = ratio >= threshold || hits.length > 0 || enoughLines
  return {
    important,
    ratio,
    addedLines: added.length,
    hits,
    reason: [
      ratio >= threshold ? `变化率 ${(ratio * 100).toFixed(0)}%` : '',
      hits.length ? `命中关键词 ${hits.join('、')}` : '',
      enoughLines ? `新增 ${added.length} 行` : '',
    ]
      .filter(Boolean)
      .join('；'),
  }
}

// =====================================================================
// Added-line diff: the lines in newText absent from oldText, up to a cap,
// so a notify/alarm shows what changed instead of the whole page.
// =====================================================================
export function addedLines(oldText, newText, cap = 30) {
  // Trim both sides: the lexmount provider returns raw text with indentation,
  // so an untrimmed old set never matched and every line looked new.
  const oldSet = new Set(String(oldText).split('\n').map((l) => l.trim()))
  const added = []
  for (const line of String(newText).split('\n')) {
    const t = line.trim()
    if (t && !oldSet.has(t)) added.push(t)
    if (added.length >= cap) break
  }
  return added
}
