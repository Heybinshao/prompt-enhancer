// prompt-enhancer 运行时行为测试（v1.8.1 起）
// 跑法：node tests/runtime.test.mjs
//
// 为什么有这一层：regression.test.mjs 全是「源码字符串断言」——它能防回退，
// 但证明不了行为。这个文件把 desktop/plugin.js 原样搬到一个临时目录、把三个
// import 换成桩，然后真的调用里面的函数（pin 存储、降级重试、护栏、上限）。
// 仍然不渲染 React 组件（那要 jsdom），但把「逻辑被改坏」这一半挡住了。

import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const results = []
function test(name, fn) {
  try {
    fn()
    results.push([name, 'PASS'])
  } catch (e) {
    results.push([name, 'FAIL: ' + e.message])
  }
}
async function testAsync(name, fn) {
  try {
    await fn()
    results.push([name, 'PASS'])
  } catch (e) {
    results.push([name, 'FAIL: ' + e.message])
  }
}

// ── 桩：SDK / react / jsx ────────────────────────────────────────────────
const SDK_STUB = `
export const COMPOSER_AREAS = { actions: 'composer.actions' }
const noop = () => null
export const Button = noop
export const Codicon = noop
export const DropdownMenu = noop
export const DropdownMenuContent = noop
export const DropdownMenuItem = noop
export const DropdownMenuTrigger = noop
export const ModelCatalogMenu = noop
export const SegmentedControl = noop
export const Tip = noop
export const ModelMenuCloseContext = { Provider: noop }
export const usePluginI18n = () => (key) => key
export const host = {
  state: {
    activeSessionId: { get: () => null },
    focusedSessionProfile: { get: () => 'default' }
  },
  notify: () => {},
  getGateway: () => null,
  composer: null
}
`
const REACT_STUB = `
export const useCallback = (fn) => fn
export const useEffect = () => {}
export const useLayoutEffect = () => {}
export const useRef = (value) => ({ current: value })
export const useState = (init) => [typeof init === 'function' ? init() : init, () => {}]
`
const JSX_STUB = `
export const jsx = (type, props) => ({ type, props })
export const jsxs = jsx
export const Fragment = 'Fragment'
`

const EXPORTS = `
export const __test = {
  normalizePin, loadPin, setPinnedModel, saveModel, persistModel, readPersistedModel,
  pinComplete, snapshotPin, isContractReject, callGatewayWithRetry, cleanRepair,
  stripWrappingQuotes, looksTruncated, outputCapFor, maxTokensFor, profileScope,
  repairDriftOk, chipsPreserved, REPAIR_PREFIX_RE,
  cleanEnhance, enhanceTokensOk, slashCommandOf, slashReferencesOf, extractGlossary, buildContextBlock, ENHANCE_PREFIX_RE,
  runEnhance,
  hostRef: host,
  setStorage: (s) => { storageApi = s },
  setRest: (fn) => { restApi = fn },
  setKeepLocalOnly: (v) => { keepLocalOnly = v },
  getPinned: () => pinnedModel,
  setHostRejectsPin: (v) => { hostRejectsPin = v },
  setHostRejectsProfile: (v) => { hostRejectsProfile = v }
}
`

function loadPlugin() {
  const dir = mkdtempSync(join(tmpdir(), 'pe-runtime-'))
  const src = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
    .replace("from '@hermes/plugin-sdk'", "from './stub-sdk.mjs'")
    .replace("from 'react/jsx-runtime'", "from './stub-jsx.mjs'")
    .replace("from 'react'", "from './stub-react.mjs'")
  writeFileSync(join(dir, 'stub-sdk.mjs'), SDK_STUB)
  writeFileSync(join(dir, 'stub-react.mjs'), REACT_STUB)
  writeFileSync(join(dir, 'stub-jsx.mjs'), JSX_STUB)
  writeFileSync(join(dir, 'plugin.mjs'), src + EXPORTS)
  return import(pathToFileURL(join(dir, 'plugin.mjs')).href)
}

const mod = await loadPlugin()
const T = mod.__test

// 假 storage：模拟 ctx.storage（localStorage 语义：JSON 往返）
function fakeStorage(seed = {}) {
  const data = { ...seed }
  return {
    data,
    get: (key, fallback) => (key in data ? JSON.parse(data[key]) : fallback),
    set: (key, value) => { data[key] = JSON.stringify(value) },
    remove: (key) => { delete data[key] }
  }
}

// ── pin 存储 ─────────────────────────────────────────────────────────────
test('T1: 旧裸记录 {provider,model} 视为启用，半条记录丢弃', () => {
  assert.deepEqual(T.normalizePin({ provider: 'p', model: 'm' }), { enabled: true, provider: 'p', model: 'm' })
  assert.equal(T.normalizePin({ provider: 'p' }), null)
  assert.equal(T.normalizePin({ enabled: false, provider: 'p', model: 'm' }).enabled, false)
})

test('T2: 固定值整条落盘，取消固定后清空记录', () => {
  const storage = fakeStorage()
  T.setStorage(storage)
  T.setPinnedModel({ enabled: true, provider: 'magpie', model: 'm1' })
  assert.deepEqual(JSON.parse(storage.data['enhanceModel']), { enabled: true, provider: 'magpie', model: 'm1' })
  T.setPinnedModel({ enabled: false, provider: '', model: '' })
  assert.deepEqual(JSON.parse(storage.data['enhanceModel']), { enabled: false, provider: '', model: '' })
})

test('T3: 选模型写的是 auxiliary 配置（两个任务一起写），不是请求参数', async () => {
  const calls = []
  T.setRest(async (path, opts) => { calls.push({ path, opts }); return { ok: true } })
  T.setKeepLocalOnly(false)
  const ok = await T.saveModel('magpie', 'm1')
  assert.equal(ok, true)
  assert.equal(calls[0].path, '/model')
  assert.deepEqual(calls[0].opts.body, { provider: 'magpie', model: 'm1' })
  assert.equal(T.getPinned().model, 'm1', '显示层同步记录')
})

test('T4: 写配置失败 → 回滚显示（不留假承诺）', async () => {
  T.setRest(async () => { throw new Error('backend half missing') })
  T.setKeepLocalOnly(false)
  T.setPinnedModel({ enabled: false, provider: '', model: '' })
  const ok = await T.saveModel('magpie', 'm1')
  assert.equal(ok, false)
  assert.equal(T.getPinned().enabled, false, '失败后不得显示为已固定')
  T.setRest(null)
  T.setKeepLocalOnly(true)
})

// ── 请求侧 ───────────────────────────────────────────────────────────────
test('T6: 输出上限按输入自适应（800 下限 / 2000 上限），max_tokens 跟得上', () => {
  assert.equal(T.outputCapFor(300), 800)
  assert.equal(T.outputCapFor(2000), 1200)
  assert.equal(T.outputCapFor(5000), 2000)
  assert.equal(T.maxTokensFor(800), 2048)
  assert.equal(T.maxTokensFor(2000), 4000)
  assert.ok(T.maxTokensFor(2000) <= 4096)
})

test('T7: profile 作用域只在有值时才带', () => {
  assert.deepEqual(T.profileScope(''), {})
  assert.deepEqual(T.profileScope(null), {})
  assert.deepEqual(T.profileScope(' qiaomenren '), { profile: 'qiaomenren' })
})

test('T8: 宿主契约拒收 → 剥掉 pin 重发裸请求，并记住本次运行', async () => {
  const calls = []
  const gw = {
    request: async (_method, req) => {
      calls.push({ ...req })
      if (req.provider) throw new Error('Extra inputs are not permitted: provider')
      return { text: 'ok' }
    }
  }
  T.setHostRejectsPin(false)
  const res = await T.callGatewayWithRetry(gw, { instructions: 'x', input: 'y', provider: 'p', model: 'm', session_id: 'S1' }, null, () => false)
  assert.equal(res.text, 'ok')
  assert.equal(calls.length, 2, '必须先带 pin 试一次、再裸发一次')
  assert.equal(calls[1].provider, undefined)
  assert.equal(calls[1].model, undefined)
  assert.equal(calls[1].session_id, undefined, '降级请求必须连 session_id 一起去掉')
  assert.ok(T.getPinned().enabled, '固定记录仍在（只是这次回落）')
})

await testAsync('T9: 取消后不再重试（isCancelled 生效）', async () => {
  let n = 0
  const gw = {
    request: async () => { n += 1; const e = new Error('429 rate limit'); throw e }
  }
  await assert.rejects(() => T.callGatewayWithRetry(gw, { instructions: 'x' }, null, () => true))
  assert.equal(n, 1, '取消后不得再发第二次')
})

test('T10: 契约拒收判据认得 4000 / out of sync / Extra inputs', () => {
  assert.ok(T.isContractReject(new Error('Extra inputs are not permitted')))
  assert.ok(T.isContractReject({ code: 4000, message: 'nope' }))
  assert.ok(T.isContractReject(new Error('client and backend are out of sync')))
  assert.ok(!T.isContractReject(new Error('429 rate limit')))
})

// ── 护栏 ─────────────────────────────────────────────────────────────────
test('T11: 修复前缀只剥元话术，不碰用户自己的「输出：」', () => {
  assert.equal(T.cleanRepair('修复后：今天天气不错'), '今天天气不错')
  assert.equal(T.cleanRepair('以下是修正后的文本：把错字改了'), '把错字改了')
  assert.equal(T.cleanRepair('校对后的内容：「引用」'), '引用')
  assert.equal(T.cleanRepair('输出：JSON 结构如下'), '输出：JSON 结构如下', '用户原文不得被吃')
})

test('T12: 截断判据覆盖悬空标点与未闭合包裹', () => {
  assert.ok(T.looksTruncated('第一步做完，'))
  assert.ok(T.looksTruncated('要点如下：'))
  assert.ok(T.looksTruncated('它支持（可选'))
  assert.ok(T.looksTruncated('他说「明天再'))
  assert.ok(!T.looksTruncated('完整的一句话。'))
})

test('T13: 修复护栏沿用（长度漂移 + chip 保真）', () => {
  assert.ok(T.repairDriftOk('这是一句普通的草稿文本', '这是一句普通的草稿文本。'))
  assert.ok(!T.repairDriftOk('短句', '短句'.repeat(30)))
  assert.ok(T.chipsPreserved('看 @file:a.md 这段', '看 @file:a.md 这段内容'))
  assert.ok(!T.chipsPreserved('看 @file:a.md 这段', '看 a.md 这段内容'))
})

await testAsync('T14: 旧宿主不认 profile 参数 → 剥掉重发，之后不再带', async () => {
  const calls = []
  const gw = {
    request: async (_m, req) => {
      calls.push({ ...req })
      if (req.profile) throw new Error('Extra inputs are not permitted: profile')
      return { text: 'ok' }
    }
  }
  T.setHostRejectsProfile(false)
  const res = await T.callGatewayWithRetry(gw, { instructions: 'x', input: 'y', profile: 'qiaomenren' }, null, () => false)
  assert.equal(res.text, 'ok')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].profile, undefined)
  assert.deepEqual(T.profileScope('qiaomenren'), {}, '记住之后不得再带 profile')
  T.setHostRejectsProfile(false)
})

// ── 增强侧护栏与上下文（v2.2.0） ─────────────────────────────────────────
test('T15: 增强结果丢 chip / 丢 /命令 一律拒绝写回', () => {
  const draft = '@file:src/app.tsx 这个组件加个 loading，/compact 之后再说'
  assert.ok(T.enhanceTokensOk(draft, draft + '（保持原样）'), '引用与命令都在 → 放行')
  assert.ok(!T.enhanceTokensOk(draft, '这个组件加个 loading，/compact 之后再说'), '丢了 @file → 拒绝')
  assert.ok(!T.enhanceTokensOk('/compact 之后继续整理', '整理会话记录'), '丢了开头 /命令 → 拒绝')
  assert.equal(T.slashCommandOf('/compact 整理一下'), '/compact')
  assert.equal(T.slashCommandOf('整理一下 /compact'), '', '只有开头的斜杠才是命令')
  assert.equal(T.slashCommandOf('/Users/xiebin/a.md 看下这个'), '', '路径不是命令')
  assert.ok(T.enhanceTokensOk('没有引用的普通草稿', '改写后的普通草稿'), '无 token 直接放行')
})

test('T15b: 行内 /skill 引用也要存活（skill 可以出现在提示词任意位置）', () => {
  const draft = '用 /content-drafting 写一篇公众号稿，格式参考 /wechat-publish'
  assert.deepEqual(T.slashReferencesOf(draft), ['/content-drafting', '/wechat-publish'])
  assert.ok(T.enhanceTokensOk(draft, '帮我写一篇公众号稿：用 /content-drafting，格式参照 /wechat-publish'), '两个都保留 → 放行')
  assert.ok(!T.enhanceTokensOk(draft, '用写作技能写一篇公众号稿，格式参考发布流程'), '被改写成自然语言 → 拒绝')
  assert.deepEqual(T.slashReferencesOf('/Users/xiebin/a.md 看下'), [], '/Users/… 不是引用')
  assert.deepEqual(T.slashReferencesOf('把 1/2 改成 a/b'), [], '分数与路径片段不算引用')
  assert.deepEqual(T.slashReferencesOf('这个/那个'), [], '中文里紧贴斜杠不算引用')
})

test('T16: cleanEnhance 剥掉「改写后：」这类标题，但不吃用户的「输出：」', () => {
  assert.equal(T.cleanEnhance('改写后：帮我把方案整理一下'), '帮我把方案整理一下')
  assert.equal(T.cleanEnhance('以下是增强后的提示词：帮我把方案整理一下'), '帮我把方案整理一下')
  assert.equal(T.cleanEnhance('增强版本: 帮我把方案整理一下'), '帮我把方案整理一下')
  assert.equal(T.cleanEnhance('“帮我把方案整理一下”'), '帮我把方案整理一下')
  assert.equal(T.cleanEnhance('输出：把三条结论列出来'), '输出：把三条结论列出来', '用户自己的开头不得被吃')
})

test('T17: 名词表——标识符 + 出现两次的产品名，排除令牌/哈希/版本号', () => {
  const msgs = [
    { role: 'user', text: 'Hermes 的 prompt-enhancer 里 chipsPreserved 怎么写的' },
    { role: 'assistant', text: '现在用的是 Hermes 0.21.6，文件在 /Users/xiebin/Projects/catalog-prep/prompt-enhancer/desktop/plugin.js' },
    { role: 'user', text: '好的，令牌 ghp_abcdefghijklmn 和 a1b2c3d4e5f6 还有 v2.2.0 都别外传' }
  ]
  const terms = T.extractGlossary(msgs)
  assert.ok(terms.includes('prompt-enhancer'), '含连字符标识符')
  assert.ok(terms.includes('chipsPreserved'), '含 camelCase')
  assert.ok(terms.includes('plugin.js'), '长路径取文件名')
  assert.ok(terms.includes('Hermes'), '出现两次的大写产品名入表（语音最易错的就是这类）')
  assert.ok(!terms.includes('Users'), '路径只留文件名，不留目录段')
  assert.ok(!terms.some((t) => /^ghp_/.test(t)), '令牌不入表')
  assert.ok(!terms.some((t) => /^[0-9a-f]{12}$/i.test(t)), '十六进制哈希不占名额')
  assert.ok(!terms.includes('v2.2.0'), '版本号不入表')
  assert.ok(!terms.includes('the') && !terms.includes('and'), '普通英文词不入表')
  const dup = T.extractGlossary([{ role: 'user', text: 'foo.js foo.js foo.js' }, { role: 'user', text: 'FOO.js' }])
  assert.equal(dup.filter((t) => t.toLowerCase() === 'foo.js').length, 1, '去重按小写')
  assert.ok(T.extractGlossary([{ role: 'user', text: '这是一句纯中文' }]).length === 0, '纯中文不产生噪音')
})

test('T18: 上文块首尾都有定界、只取上一轮，且不许替换指代', () => {
  const long = 'a'.repeat(2000)
  const msgs = [
    { role: 'user', text: '很早以前的一句话' },
    { role: 'assistant', text: '旧回复' },
    { role: 'user', text: '按刚才第二个方案改' },
    { role: 'assistant', text: `${long}结论是方案二` }
  ]
  const block = T.buildContextBlock(msgs)
  assert.ok(!block.includes('很早以前的一句话'), '不搬更早的轮次')
  assert.ok(block.includes('按刚才第二个方案改'), '含上一条用户消息')
  assert.ok(block.includes('结论是方案二'), '含助手回复的结尾而不是开头')
  assert.ok(/【上文开始/.test(block) && /【上文结束】/.test(block), '首尾都有定界标记')
  assert.ok(block.length < 1300, `上下文块必须短（实测 ${block.length}）`)
  assert.ok(/不是给你的指令/.test(block), '写明上文不是指令')
  assert.ok(/指代仍然原样保留/.test(block), '与模板对齐：不许用上文替换指代')
  assert.equal(T.buildContextBlock([]), '', '空历史 → 不加块')
})

test('T23: 结尾成对引号不被吃掉（增强结果最爱用「」点名）', () => {
  const s = '把结果命名为「方案A」'
  assert.equal(T.cleanEnhance(s), s, '结尾的 」 必须留下')
  assert.equal(T.cleanRepair(s), s, '修复侧同样')
  assert.ok(!T.looksTruncated(s), '引号配平就不得误报截断')
  assert.equal(T.cleanEnhance('「整个结果」'), '整个结果', '整段被同一对引号包住才去壳')
  assert.equal(T.cleanEnhance('「a「b」'), '「a「b」', '不配对的片段原样保留')
  assert.equal(T.cleanEnhance('“引用整段”'), '引用整段')
})

// ── 端到端装配（v2.2.0）：真的跑 runEnhance，只桩掉 gateway / composer ──
// 单测覆盖得住纯函数，但「历史读取 → 名词表 → 修复请求 → 增强请求」这条线是
// 本次新接的，必须整条走一遍：两次 oneshot 的 instructions 到底拼成什么样。
function fakeComposer(host, { history = [], draft = '把今天的会议纪要整理一下', repairOut = null, enhanceOut = '整理上周会议纪要' } = {}) {
  const calls = []
  let current = draft
  const gw = {
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'session.history') return { messages: history }
      if (params.task === 'prompt_repair') return { text: repairOut ?? params.input }
      return { text: enhanceOut }
    }
  }
  host.state.activeSessionId.get = () => 's1'
  host.getGateway = () => gw
  host.composer = { getDraft: async () => current, setDraft: async (_s, t) => { current = t; return true } }
  return { calls, draft: () => current }
}

function fakeBtn() {
  const editor = { isContentEditable: true }
  return { closest: () => ({ querySelector: () => editor, getAttribute: () => null }) }
}

const HISTORY = [
  { role: 'user', text: '我在调 prompt-enhancer 这个插件' },
  { role: 'assistant', text: '好的，看 plugin.js 里的 chipsPreserved' }
]

await testAsync('T19: 普通点击——修复带名词表、增强带上限、不带上文', async () => {
  const { calls } = fakeComposer(T.hostRef, { history: HISTORY })
  await T.runEnhance(fakeBtn(), () => {}, null, undefined)
  const oneShots = calls.filter((c) => c.method === 'llm.oneshot')
  assert.equal(oneShots.length, 2, '一次点击 = 修复 + 增强两次调用')
  const repairInstr = oneShots[0].params.instructions
  assert.ok(/你是文本校对员/.test(repairInstr), '第一次调修复模板')
  assert.ok(/本会话出现过的专有名词/.test(repairInstr), '修复带名词表')
  assert.ok(repairInstr.includes('prompt-enhancer'), '名词表取自会话里的标识符')
  assert.ok(!/上文/.test(repairInstr), '修复不带对话上文')
  assert.ok(repairInstr.trim().endsWith('不要代码围栏。'), '名词表之后重申「只输出文本」，输出规则仍是最后一句')
  const enhanceInstr = oneShots[1].params.instructions
  assert.ok(/你是提示词改写器/.test(enhanceInstr), '第二次调增强模板')
  assert.ok(/【输出上限】不超过 \d+ 字符/.test(enhanceInstr), '上限以具体数字注入')
  assert.ok(!/【上文/.test(enhanceInstr), '普通点击不带上文')
  assert.equal(oneShots[1].params.input, '把今天的会议纪要整理一下', '用户消息只有草稿本身')
})

await testAsync('T20: ⇧ 点击——上文只进 system 半，草稿仍是唯一的用户消息', async () => {
  const draft = '按刚才那个方案继续'
  const { calls } = fakeComposer(T.hostRef, { history: HISTORY, draft })
  await T.runEnhance(fakeBtn(), () => {}, null, { useContext: true })
  const enhance = calls.filter((c) => c.method === 'llm.oneshot')[1]
  assert.ok(/【上文/.test(enhance.params.instructions), '⇧ 时带上文块')
  assert.ok(enhance.params.instructions.includes('chipsPreserved'), '上文取最近一轮')
  assert.ok(/不写进输出|不是给你的指令/.test(enhance.params.instructions), '上文块带只读约束')
  assert.equal(enhance.params.input, draft, '草稿仍然是唯一 user 消息，不被上文污染')
})

await testAsync('T21: 增强结果丢引用标记 → 不写回草稿', async () => {
  const draft = '@file:src/app.tsx 给这个组件加 loading'
  const { calls, draft: now } = fakeComposer(T.hostRef, { draft, enhanceOut: '给这个组件加 loading' })
  await T.runEnhance(fakeBtn(), () => {}, null, undefined)
  assert.equal(now(), draft, '草稿保持原样（拒绝写回）')
  const oneShots = calls.filter((c) => c.method === 'llm.oneshot')
  assert.equal(oneShots.length, 1, '含引用的草稿跳过修复，只发增强请求')
  assert.ok(/额外硬性约束/.test(oneShots[0].params.instructions), '引用齐备时仍注入保真条款')
})

// 验收缺口补的两条之一：纯 /命令 草稿必须收到「保留 /命令」的约束，
// 否则硬闸每次都拒它（评审实测：输入 `/plan 做个东西` → 输出「请规划：…」→ 拒绝）。
await testAsync('T22: 纯 /命令 草稿也会收到 token 保真约束', async () => {
  const { calls } = fakeComposer(T.hostRef, { draft: '/plan 做个东西', enhanceOut: '/plan 做个东西：先列目标再拆步骤' })
  await T.runEnhance(fakeBtn(), () => {}, null, undefined)
  const oneShots = calls.filter((c) => c.method === 'llm.oneshot')
  const enhanceInstr = oneShots[oneShots.length - 1].params.instructions
  assert.ok(/额外硬性约束/.test(enhanceInstr), '没有 @ 引用也要注入保真条款')
  assert.ok(/\/命令/.test(enhanceInstr), '条款点名 /命令')
})

// ── 汇总 ──
let fail = 0
for (const [name, r] of results) {
  console.log(`${r === 'PASS' ? '✅' : '❌'} ${name}  ${r === 'PASS' ? '' : r}`)
  if (r !== 'PASS') fail++
}
console.log(`\n${results.length - fail}/${results.length} passed`)
process.exit(fail ? 1 : 0)
