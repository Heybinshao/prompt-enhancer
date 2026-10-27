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
  normalizePin, loadPin, setDefaultPin, setOncePin, effectivePin, consumeOnce,
  pinComplete, snapshotPin, isContractReject, callGatewayWithRetry, cleanRepair,
  stripWrappingQuotes, looksTruncated, outputCapFor, maxTokensFor, profileScope,
  repairDriftOk, chipsPreserved, REPAIR_PREFIX_RE,
  setStorage: (s) => { storageApi = s },
  getDefaultPin: () => defaultPin,
  getOncePin: () => oncePin,
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

test('T2: 默认值整条落盘，关掉后仍保留 provider/model（供再开）', () => {
  const storage = fakeStorage()
  T.setStorage(storage)
  T.setDefaultPin({ enabled: true, provider: 'magpie', model: 'm1' })
  assert.deepEqual(storage.data['enhanceModel'] && JSON.parse(storage.data['enhanceModel']),
    { enabled: true, provider: 'magpie', model: 'm1' })
  T.setDefaultPin({ enabled: false })
  const saved = JSON.parse(storage.data['enhanceModel'])
  assert.equal(saved.enabled, false)
  assert.equal(saved.provider, 'magpie', '关掉默认不得丢模型（否则再开要重选）')
  assert.equal(saved.model, 'm1')
})

test('T3: 优先级 本次 > 默认；本次按会话生效，别的会话落到默认', () => {
  const storage = fakeStorage()
  T.setStorage(storage)
  T.setDefaultPin({ enabled: true, provider: 'p0', model: 'm0' })
  T.setOncePin({ provider: 'p1', model: 'm1', sessionId: 'S1' })
  assert.deepEqual(T.effectivePin('S1'), { provider: 'p1', model: 'm1', sessionId: 'S1' })
  assert.deepEqual(T.effectivePin('S2'), { provider: 'p0', model: 'm0' }, '换会话不得沿用本次')
  assert.deepEqual(T.effectivePin(), { provider: 'p1', model: 'm1', sessionId: 'S1' }, '无会话上下文时用于展示')
})

test('T4: 降级标记一置，任何 pin 都不再生效', () => {
  T.setOncePin({ provider: 'p1', model: 'm1', sessionId: null })
  T.setHostRejectsPin(true)
  assert.equal(T.effectivePin('S1'), null)
  T.setHostRejectsPin(false)
})

test('T5: 消费一次即清，且不会误清别的模型', () => {
  T.setOncePin({ provider: 'p1', model: 'm1' })
  T.consumeOnce({ provider: 'p9', model: 'm9' })
  assert.ok(T.getOncePin(), '不匹配的消费不得清掉')
  T.consumeOnce({ provider: 'p1', model: 'm1' })
  assert.equal(T.getOncePin(), null)
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
  assert.equal(T.snapshotPin().unsupported, true)
  assert.equal(T.effectivePin('S1'), null, '降级后不得再宣称在用 pin')
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

// ── 汇总 ──
let fail = 0
for (const [name, r] of results) {
  console.log(`${r === 'PASS' ? '✅' : '❌'} ${name}  ${r === 'PASS' ? '' : r}`)
  if (r !== 'PASS') fail++
}
console.log(`\n${results.length - fail}/${results.length} passed`)
process.exit(fail ? 1 : 0)
