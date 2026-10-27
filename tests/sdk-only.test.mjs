import { readFileSync } from 'node:fs'
const url = new URL('../desktop/plugin.js', import.meta.url)
const src = readFileSync(url, 'utf8')
const results = []
function test(name, fn) {
  try { fn(); results.push([name, 'PASS']) } catch (e) { results.push([name, 'FAIL: ' + e.message]) }
}

// v1.6.0 (catalog review #121246): the plugin is PURE SDK now — the legacy
// DOM read/write layer is deleted, not just bypassed. These assertions pin
// that contract so a future edit can't silently reintroduce DOM writes.
test('P1: 禁词零出现（官方验收 grep 五项）', () => {
  const banned = ['ProseMirror', 'InputEvent', 'composer-insert', 'composer-root', 'data-composer-target']
  const hits = banned.filter((b) => src.includes(b))
  if (hits.length) throw new Error('发现禁词: ' + hits.join(', '))
})

test('P2: 旧兼容层已删除', () => {
  const dead = ['serializeEditor', 'writeBack(', 'collectDraftSlashChips', 'chipSpansFor', 'appendChippedContents', 'refChipEl', 'slashChipEl', 'CHIP_ICON_PATHS']
  const hits = dead.filter((d) => src.includes(d))
  if (hits.length) throw new Error('兼容层残留: ' + hits.join(', '))
})

test('P3: 草稿读写全部经 host.composer', () => {
  if (!/await c\.getDraft\(sessionId\)/.test(src)) throw new Error('缺 getDraft')
  if (!/await c\.setDraft\(sessionId, cleaned\)/.test(src)) throw new Error('缺 setDraft(增强写回)')
  if (!/await c\.setDraft\(sessionId, st\.backup\)/.test(src)) throw new Error('缺 setDraft(恢复)')
})

test('P4: SDK 不可用时告知用户而非回落', () => {
  // runEnhance: early gate with a notify
  if (!/if \(!c\) return tNotify\('error', 'notify\.failed'/.test(src)) throw new Error('runEnhance 缺 SDK 闸门提示')
  // write refused → notify, no DOM
  const w = src.match(/let applied = false[\s\S]{0,400}/g) ?? []
  const refuses = w.some((m) => /tNotify\('info', 'notify\.(draftChanged|revertStale)'/.test(m.split('\n\n')[0]))
  if (!refuses) throw new Error('写回失败路径未提示用户')
  if (/dispatchEvent\(new (Event|InputEvent)/.test(src)) throw new Error('仍有合成 DOM 事件')
  if (/replaceChildren/.test(src)) throw new Error('仍有 DOM 写回')
})

test('P5: 只读探针仅剩 isContentEditable + 变更观察', () => {
  const probes = [...src.matchAll(/editor\.[a-zA-Z]+/g)].map((m) => m[0])
  const allowed = new Set(['editor.isContentEditable'])
  const bad = probes.filter((p) => !allowed.has(p) && !/editorState/.test(p))
  // any other direct editor.* member access would mean DOM logic is back
  if (bad.length) throw new Error('新增直接 editor 操作: ' + [...new Set(bad)].join(', '))
})

test('P6: 版本闸门不低于用到的 SDK 导出起点（ModelCatalogMenu = 0.21.6）', () => {
  const y = readFileSync(new URL('../plugin.yaml', import.meta.url), 'utf8')
  if (!/requires_hermes:\s*">=0\.21\.6"/.test(y)) throw new Error('requires_hermes 必须 >=0.21.6（ModelCatalogMenu/SegmentedControl 最早出现在该版）')
  // 代码里给用户的提示不能比闸门更旧
  if (/0\.21\.5/.test(src)) throw new Error('plugin.js 里仍有 >=0.21.5 的过期提示')
})

test('P7: chip token 识别改在草稿文本上（非 DOM 查询）', () => {
  if (!/CHIP_REF_RE\.test\(text\)/.test(src)) throw new Error('hasChips 未走文本正则')
  if (/querySelector\('\[data-ref-text\]'\)/.test(src)) throw new Error('hasChips 仍在查 DOM')
})

// ── 汇总 ──
let fail = 0
for (const [name, r] of results) {
  console.log(`${r === 'PASS' ? '✅' : '❌'} ${name}  ${r === 'PASS' ? '' : r}`)
  if (r !== 'PASS') fail++
}
console.log(`\n${results.length - fail}/${results.length} passed`)
process.exit(fail ? 1 : 0)
