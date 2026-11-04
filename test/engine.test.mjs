import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addedLines, changeRatio, htmlToText, judgeImportance, makeSnapshot, slugOf, snapshotFingerprint, urlFingerprint } from '../lib/engine.js'

test('slugOf turns URLs into safe file names', () => {
  assert.equal(slugOf('https://www.bupt.edu.cn'), 'https_www_bupt_edu_cn')
  assert.equal(slugOf('https://www.bupt.edu.cn/xxgg.htm'), 'https_www_bupt_edu_cn_xxgg_htm')
  assert.equal(slugOf('https://a.b?x=1&y=2'), 'https_a_b_x_1_y_2')
})

test('htmlToText strips scripts, styles, nav/footer and tags; decodes entities', () => {
  const html = `
<!doctype html><html><head><title>T</title><style>.x{}</style></head>
<body>
<nav><a href="/">Home</a></nav>
<main>
  <h1>标题 &amp; 公告</h1>
  <p>第一段 &#8212; 破折号</p>
  <script>alert(1)</script>
  <ul><li>条目一</li><li>条目二</li></ul>
</main>
<footer>版权</footer>
</body></html>`
  const text = htmlToText(html)
  assert.ok(!text.includes('alert'), 'script content removed')
  assert.ok(!text.includes('版权'), 'footer removed')
  assert.ok(text.includes('标题 & 公告'), 'entity decoded')
  assert.ok(text.includes('第一段'), 'paragraph kept')
  assert.ok(text.includes('条目一') && text.includes('条目二'), 'list items kept')
  // one item per line
  assert.ok(text.split('\n').some((l) => l.includes('条目一')))
})

test('htmlToText decodes double-encoded entities too', () => {
  // publishers emit &amp;nbsp; and &amp;amp; — one pass leaves a literal "&nbsp;"
  // in the snapshot, which then shows up as text in every diff
  const text = htmlToText('<main><p>A&amp;nbsp;B &amp;amp; C &amp;lt;tag&amp;gt;</p></main>')
  assert.ok(!/&nbsp;|&amp;|&lt;|&gt;/.test(text), `still encoded: ${text}`)
  assert.ok(text.includes('A B & C <tag>'), text)
})

test('changeRatio: identical=0, disjoint=1, close≈small', () => {
  assert.equal(changeRatio('same text here', 'same text here'), 0)
  assert.equal(changeRatio('aaaa', 'bbbb'), 1)
  const r = changeRatio('这是一段完全相同的文字。', '这是一段完全相同的文字，但结尾多了一句。')
  assert.ok(r > 0 && r < 0.4, `small edit should be a small ratio, got ${r}`)
})

test('judgeImportance: threshold OR keyword', () => {
  const oldT = '今天天气很好。'
  assert.equal(judgeImportance({ oldText: oldT, newText: oldT }).important, false)
  assert.equal(judgeImportance({ oldText: oldT, newText: '报名开始了！' , keywords: ['报名'] }).important, true)
  const big = judgeImportance({ oldText: 'a'.repeat(200), newText: 'b'.repeat(200), threshold: 0.3 })
  assert.equal(big.important, true)
  assert.equal(big.hits.length, 0)
})

test('judgeImportance ignores a keyword that was already there', () => {
  // 通知/公告/成绩 are in the heading of nearly every notice page, so matching
  // the whole new page fired on every unrelated tweak.
  const oldT = '公告\n今日无新通知。'
  const newT = '公告\n今日无新通知。\n天气转凉。'
  const v = judgeImportance({ oldText: oldT, newText: newT, keywords: ['公告', '通知'], minAddedLines: 99 })
  assert.equal(v.important, false)
  assert.deepEqual(v.hits, [])
  const fresh = judgeImportance({ oldText: oldT, newText: `${newT}\n补录开始。`, keywords: ['补录'], minAddedLines: 99 })
  assert.equal(fresh.important, true)
  assert.deepEqual(fresh.hits, ['补录'])
})

test('judgeImportance counts new lines, because the ratio cannot see one announcement', () => {
  // 5 000 chars of stable page + one 20-char announcement = ratio 0.052, so a
  // 30 % threshold only ever fired on a total rewrite.
  const oldT = Array.from({ length: 120 }, (_, i) => `行${i}：今日无新通知`).join('\n')
  const newT = `${oldT}\n【新通知】报名开始！`
  const v = judgeImportance({ oldText: oldT, newText: newT, threshold: 0.3 })
  assert.ok(v.ratio < 0.3)
  assert.equal(v.addedLines, 1)
  // one new line is below the default of 2 (a rotating banner also adds one);
  // minAddedLines:1 is the "tell me about any single new line" mode
  assert.equal(v.important, false)
  assert.equal(judgeImportance({ oldText: oldT, newText: newT, threshold: 0.3, minAddedLines: 1 }).important, true)
})

test('urlFingerprint keeps hosts that slugOf collapses apart', () => {
  const a = 'https://例子.中国/公告'
  const b = 'https://另一个例子.中国/通知'
  assert.equal(slugOf(a), slugOf(b))
  assert.notEqual(urlFingerprint(a), urlFingerprint(b))
})

test('addedLines trims the old side too', () => {
  // the lexmount provider returns indented text; an untrimmed old set made
  // every line look new
  assert.deepEqual(addedLines('  alpha\n  beta', 'alpha\nbeta'), [])
})

test('makeSnapshot stores fingerprint and timestamps', () => {
  const s = makeSnapshot({ url: 'https://x', title: 'X', text: 'hello' })
  assert.equal(s.hash, snapshotFingerprint('hello'))
  assert.ok(s.savedAt)
  assert.equal(s.prevHash, undefined)
})

test('addedLines returns only truly new lines, capped', () => {
  const oldT = 'alpha\nbeta\ngamma'
  const newT = 'alpha\nNEW-ONE\nbeta\ngamma'
  const added = addedLines(oldT, newT, 30)
  assert.deepEqual(added, ['NEW-ONE'])
  const many = addedLines('', Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n'), 10)
  assert.equal(many.length, 10)
})
