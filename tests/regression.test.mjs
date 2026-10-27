// prompt-enhancer 回归用例（v1.0.9 固化）
// 跑法：node tests/regression.test.mjs
// 覆盖 v1.0.5-v1.0.8 四类已修 bug 的复现断言 + 模板行为用例。
// 状态层逻辑从 plugin.js 抽取为纯函数镜像（plugin.js 的 stateByEditor/seq 模式），
// plugin.js 改动状态机时必须同步本文件并全量重跑。

import assert from 'node:assert'

// ── 被测逻辑的纯函数镜像（与 plugin.js 保持同步） ──
function createStateStore() {
  const stateByEditor = new Map() // 测试用 Map 替代 WeakMap，以 editorId 为键
  function editorState(id) {
    if (!stateByEditor.has(id)) stateByEditor.set(id, { phase: 'idle', backup: '', lastApplied: '', seq: 0 })
    return stateByEditor.get(id)
  }
  return { editorState, stateByEditor }
}

function isRateLimited(err) {
  return /429|rate.?limit/i.test(`${err?.message ?? ''} ${err?.name ?? ''} ${String(err)}`)
}

const RETRY_DELAYS_MS = [3000, 5000] // 测试中缩水为 [1,1]，断言调用次数而非等待

// 模拟 gw.request 的重试包装（与 plugin.js runEnhance 内循环同构）
async function callWithRetry(mockFn, delays = [1, 1]) {
  let res = null
  for (let attempt = 0; ; attempt++) {
    try {
      res = await mockFn(); break
    } catch (e) {
      if (attempt < delays.length && isRateLimited(e)) {
        await new Promise((r) => setTimeout(r, delays[attempt]))
        continue
      }
      throw e
    }
  }
  return res
}

// ── 用例集 ──
const results = []
function test(name, fn) {
  try { fn(); results.push([name, 'PASS']) }
  catch (e) { results.push([name, `FAIL: ${e.message}`]) }
}
async function atest(name, fn) {
  try { await fn(); results.push([name, 'PASS']) }
  catch (e) { results.push([name, `FAIL: ${e.message}`]) }
}

// [bug#1 v1.0.5] 429 一次即败 → 重试后成功
await atest('R1: 429 重试后成功（v1.0.5 bug 复现防护）', async () => {
  let calls = 0
  const res = await callWithRetry(() => {
    calls++
    if (calls < 2) { const e = new Error('one-shot generation failed: Error code: 429'); e.name = 'JsonRpcGatewayError'; throw e }
    return 'OK'
  })
  assert.equal(res, 'OK'); assert.equal(calls, 2)
})

// [bug#1 伴生] 非 429 不重试
await atest('R2: 非 429 错误不重试', async () => {
  let calls = 0
  try {
    await callWithRetry(() => { calls++; throw new Error('empty') })
    assert.fail('should throw')
  } catch (e) { assert.equal(e.message, 'empty'); assert.equal(calls, 1) }
})

// [bug#1 伴生] 连续 429 耗尽后抛出
await atest('R3: 重试耗尽后抛出原始错误', async () => {
  let calls = 0
  try {
    await callWithRetry(() => { calls++; throw new Error('Error code: 429') })
    assert.fail('should throw')
  } catch (e) { assert.equal(e.message, 'Error code: 429'); assert.equal(calls, 3) }
})

// [bug#2 v1.0.7] 全局状态导致跨会话取消作废 → seq 必须按实例隔离
test('R4: seq 按 editor 实例隔离，B 取消不作废 A（v1.0.7 bug 防护）', () => {
  const { editorState } = createStateStore()
  const a = editorState('A'); a.seq++; a.phase = 'enhancing'
  const b = editorState('B')
  const bSeq = ++b.seq; b.phase = 'enhancing'
  // B 点取消：作废的是 B 自己的 in-flight 请求
  b.seq++
  assert.equal(a.phase, 'enhancing', 'A 不受 B 取消影响')
  assert.equal(a.seq === editorState('A').seq, true, 'A 的请求仍有效')
  // B 的取消守卫：捕获的 bSeq 已落后于当前 seq → B 的迟到结果作废
  assert.equal(bSeq !== b.seq, true, 'B 的请求已作废（B 自己的 seq 已 bump）')
  // 全局共享 seq 的旧 bug 形态：若 seq 是共享计数，B 的 ++ 会让 a.seq !== 全局值 → A 被误作废。
  // 隔离后 A 的 seq 独立，不受 B 的任何操作影响。
  assert.equal(editorState('A').seq, 1, 'A 的 seq 独立计数，未被 B 的 bump 波及')
})

// [bug#2 伴生] 状态隔离：A 完成 B 仍转圈
test('R5: 并发增强状态互不干扰', () => {
  const { editorState } = createStateStore()
  const a = editorState('A'); a.phase = 'enhancing'
  const b = editorState('B'); b.phase = 'enhancing'
  a.phase = 'enhanced'
  assert.equal(b.phase, 'enhancing')
  assert.equal(a.phase, 'enhanced')
})

// [bug#3 v1.0.7] 全局 atom 让所有窗口转圈 → phase 不能是模块级单例
test('R6: 不同 editor 的初始态互不共享', () => {
  const { editorState, stateByEditor } = createStateStore()
  editorState('A').phase = 'enhancing'
  assert.equal(editorState('B').phase, 'idle', 'B 初始必须是 idle（全局 atom 时代 B 会跟着 enhancing）')
  assert.equal(stateByEditor.size, 2)
})

// [模板 v1.7.0] 修复指令已从增强模板拆出，独立成 REPAIR_TEMPLATE
// （v1.0.8 起它写在 SYSTEM_TEMPLATE 里，等于「增强时顺手修」；v1.7.0 改为
// 前置独立一步，所以断言必须跟着搬家，否则会钉死一个已废弃的形态）
test('R7: REPAIR_TEMPLATE 含语音纠错原则与全休→全修示例', () => {
  const fs = await_import_fs()
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  const m = src.match(/const REPAIR_TEMPLATE = `(.*?)`/s)
  assert.ok(m, 'REPAIR_TEMPLATE 存在')
  assert.ok(/语音输入/.test(m[1]), '含语音输入纠错')
  // v1.7.1：示例换成真实失败案例（合法词被同音替换）。旧的「全休→全修」是
  // 词级例子，实测证明词级判据漏掉「绘画→会话」这类合法词，已弃用。
  assert.ok(/绘画/.test(m[1]) && /会话/.test(m[1]), '含合法词同音替换的示例锚点')
  assert.ok(/这句话在语境里通不通/.test(m[1]), '含「按整句语境判定」的判据')
  assert.ok(/不改写风格/.test(m[1]), '含「不改风格」边界')
  assert.ok(/换个说法更好/.test(m[1]), '含「只是换个说法不算错」护栏')
})

// [v1.7.0] 修复不再写在增强模板里——两边都写 = 同一处被修两遍，
// 第二遍在「重写」心态下跑，会破坏前置修复的保真度
test('R7b: SYSTEM_TEMPLATE 不再含修复指令（防重复修复）', () => {
  const fs = await_import_fs()
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  const m = src.match(/const SYSTEM_TEMPLATE = `(.*?)`/s)
  assert.ok(m, 'SYSTEM_TEMPLATE 存在')
  assert.ok(!/语音输入/.test(m[1]), '增强模板里不该再有语音纠错指令')
  assert.ok(!/全休/.test(m[1]), '增强模板里不该再有同音字示例')
})

// [取消语义] WorkBuddy parity：转圈可点=取消，取消后迟到大结果丢弃
await atest('R8: 等待中取消 → 迟到结果被丢弃', async () => {
  const { editorState } = createStateStore()
  const a = editorState('A')
  a.seq++; const seq = a.seq; a.phase = 'enhancing'
  // 模拟慢请求期间用户取消
  a.seq++; a.phase = 'idle'
  // 迟到结果守卫（与 plugin.js: if (seq !== st.seq) return 同构）
  const guard = seq !== a.seq ? 'DISCARDED' : 'APPLIED'
  assert.equal(guard, 'DISCARDED')
})

// helper：node ESM 里同步读文件
function await_import_fs() {
  // eslint-disable-next-line no-undef
  return process.getBuiltinModule('fs')
}


// [v1.6.0] chip 保真改由官方 setDraft 水化负责（旧 DOM 写回层已随 #121246 审查删除）
test('R9: chip token 走草稿文本保护，模板含 token 保真约束', () => {
  const fs = process.getBuiltinModule('fs')
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  // 识别在 getDraft 返回的文本上（不是 DOM 查询）
  assert.ok(/CHIP_REF_RE\.test\(text\)/.test(src), 'hasChips 走文本正则')
  assert.ok(!/querySelector\('\[data-ref-text\]'\)/.test(src), '不再查 chip DOM')
  // chip 存在时，模板追加 token 保真约束（用户核心诉求：引用标记不丢）
  assert.ok(/额外硬性约束[\s\S]*必须原样保留/.test(src), '模板含 token 原样保留约束')
  const m = src.match(/const SYSTEM_TEMPLATE = `(.*?)`/s)
  assert.ok(m && !/输出格式防误识别/.test(m[1]), '模板无防误识别约束（已回滚）')
})

// R10 (v1.1.0 slash-chip snapshot mirror) removed in v1.6.0: the snapshot/
// write-back layer was deleted with the catalog review #121246 — chip
// hydration is now entirely the official setDraft's job. sdk-only.test.mjs
// pins the new contract.
// [v1.8.0] 模型 pin（⌘+点击）回归。v1.6.1 曾因宿主契约没有 provider/model
// 整块删掉（e5cc952）；现在加回，但三条不变量必须同时成立——裸请求路径原样、
// pin 只在完整记录上生效、宿主拒收时降级成裸请求而不是把一次点击变成报错。
test('R11: 模型 pin 存在，透传被 if(pin) 包住（未选模型时请求与 v1.7.1 一致）', () => {
  const fs = process.getBuiltinModule('fs')
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  const need = [
    'ModelCatalogMenu', 'ModelMenuCloseContext', 'metaGesture',
    'setPinnedModel', 'effectivePin', 'enhanceModel'
  ]
  const missing = need.filter((n) => !src.includes(n))
  assert.equal(missing.length, 0, '缺 pin 组件: ' + missing.join(', '))
  // ⌘/Ctrl+点击只开菜单，不触发增强
  assert.ok(/if \(e\?\.metaKey \|\| e\?\.ctrlKey\) return/.test(src), 'onClick 缺 ⌘ 早退')
  const at = src.indexOf('\n    if (pin) {')
  assert.ok(at > 0, '缺 pin 条件分支（裸请求必须原样）')
  const body = src.slice(at, src.indexOf('\n    }', at))
  assert.ok(/req\.provider = pin\.provider/.test(body), 'pin 分支缺 provider')
  assert.ok(/req\.model = pin\.model/.test(body), 'pin 分支缺 model')
  assert.ok(/req\.session_id = sessionId/.test(body), 'pin 分支缺 session_id（会话 profile 作用域）')
})

test('R11b: 宿主契约没有 provider/model 时降级为裸请求（不把点击变成 4000）', () => {
  const fs = process.getBuiltinModule('fs')
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  assert.ok(/function isContractReject\(/.test(src), '缺契约拒收识别')
  assert.ok(/Extra inputs are not permitted/.test(src), '缺 extra=forbid 文案判据')
  assert.ok(/delete bare\.provider/.test(src) && /delete bare\.model/.test(src), '缺降级剥字段')
  assert.ok(/hostRejectsPin = true/.test(src), '降级后必须记住本次运行')
  assert.ok(/tNotify\('info', 'notify\.pinUnsupported'\)/.test(src), '降级要给用户一句解释')
})

test('R11d: 「恢复默认」常驻，未固定时置灰（不是隐藏）', () => {
  const fs = process.getBuiltinModule('fs')
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  const at = src.indexOf("key: 'reset'")
  assert.ok(at > 0, '缺「恢复默认」菜单项')
  const body = src.slice(at, at + 500)
  assert.ok(/setPinnedModel\(\{ enabled: false/.test(body), '恢复默认必须清掉记录')
  assert.ok(/disabled: !pinComplete\(pin\.pinned\)/.test(body), '未固定时必须置灰而不是消失')
  assert.ok(!src.includes('clearOnce'), '不得再有并列的清除入口')
})

test('R21: 菜单去掉宿主提示行与目录尾巴 + 按钮 a11y', () => {
  const fs = process.getBuiltinModule('fs')
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  // 常驻的宿主提示行已删除（改为失败后 statusUnsupported 才说）
  assert.ok(!/hostNote/.test(src), '宿主提示行应已删除')
  // 目录自带的两行（添加自定义模型 / 编辑模型）只在本插件菜单里隐藏
  assert.ok(/pe-model-menu \[role="menuitem"\]:has\(\.codicon-add\)/.test(src), '缺「添加自定义模型」行隐藏规则')
  assert.ok(/pe-model-menu \[role="menuitem"\]:has\(\.codicon-settings-gear\)/.test(src), '缺「编辑模型」行隐藏规则')
  assert.ok(/className: 'w-72 p-0 pe-model-menu'/.test(src), '菜单容器缺标记类')
  // Radix 把 aria-* 挂在外层 span，按钮本体要自己声明
  assert.ok(/'aria-haspopup': 'menu'/.test(src), '按钮缺 aria-haspopup')
  assert.ok(/'aria-expanded': menuOpen/.test(src), '按钮缺 aria-expanded')
})

test('R20: 多 profile 接线——菜单按会话 profile 拉、裸请求带 profile、本次 pin 绑会话', () => {
  const fs = process.getBuiltinModule('fs')
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  // 菜单：profile / gateway 由打开时捕获的 menuTarget 提供（默认 'default' 是错的）
  assert.ok(/profile: menuTarget\.profile \|\| 'default'/.test(src), '菜单缺 profile')
  assert.ok(/gateway: menuTarget\.gateway \?\? undefined/.test(src), '菜单缺 gateway')
  assert.ok(/host\.state\.focusedSessionProfile\.get\(\)/.test(src), '未读会话所属 profile')
  // 裸请求（无 pin）必须带 profile，否则落 launch profile 的辅助路由；两处调用点都要有
  const profileAssigns = (src.match(/Object\.assign\(req, profileScope\(/g) || []).length
  assert.ok(profileAssigns >= 2, '增强与修复的裸请求都应带 profile，实际 ' + profileAssigns)
  assert.ok(/profileScope\(host\.state\.focusedSessionProfile\.get\(\)\)/.test(src), '未读会话所属 profile')
  // 跨窗口同步
  assert.ok(/addEventListener\?\.\(window, 'storage'/.test(src), '缺 storage 跨窗口同步')
  // 取消要传 isCancelled
  assert.ok(/onRetry, \(\) => seq !== st\.seq\)/.test(src), '重试未接取消信号')
})

test('R11e: 选模型即固定（菜单不关），状态行只有固定/未固定两态', () => {
  const fs = process.getBuiltinModule('fs')
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  assert.ok(/suppressClose/.test(src), '缺 keep-open 标记')
  assert.ok(/if \(suppressClose\.current\) \{/.test(src), '缺「吞掉选择后的关闭」分支')
  const at = src.indexOf('select: (model, provider) => {')
  assert.ok(at > 0, '缺 controller.select')
  const body = src.slice(at, at + 400)
  assert.ok(/setPinnedModel\(\{ enabled: true, provider, model \}\)/.test(body), '选模型必须落成固定记录')
  assert.ok(!/oncePin/.test(src), '「本次」记录必须彻底删除')
  const s2 = src.indexOf('const statusLine =')
  const sb = src.slice(s2, s2 + 300)
  assert.ok(/pinComplete\(pin\.pinned\)/.test(sb), '状态行必须读固定记录')
  assert.ok(!/statusOnce/.test(src), '状态行不得再有「本次」')
})

test('R11c: 仅修复路径也跟随同一个模型（一个选择管两步）', () => {
  const fs = process.getBuiltinModule('fs')
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  const start = src.indexOf('async function runRepair(')
  const next = src.indexOf('\nasync function ', start + 10)
  const body = src.slice(start, next === -1 ? undefined : next)
  assert.ok(/effectivePin\(\)/.test(body), '修复步骤必须读同一个模型选择')
  assert.ok(/req\.provider = pin\.provider/.test(body) && /req\.model = pin\.model/.test(body), '修复请求必须带同一个模型')
  assert.ok(/task: 'prompt_repair'/.test(body), '修复步骤必须留在 prompt_repair 任务上（日志/归属）')
  // 两处调用点都必须是同一套 pin 分支
  const pinBlocks = (src.match(/^\s+if \(pin\) \{$/gm) || []).length
  assert.ok(pinBlocks >= 2, '增强与修复都应各有 pin 分支，实际 ' + pinBlocks)
})

// R12 (v1.8.0 恢复为 R18/R19 的语义镜像): 被镜像的归一化与优先级逻辑见下。
// ── v1.7.0 修复前置步骤：护栏纯函数镜像 ──
// 与 plugin.js 的 repairDriftOk / chipsPreserved / cleanRepair 保持同步。
const REPAIR_MAX_DRIFT_RATIO = 0.15
function repairDriftOk(original, repaired) {
  const before = String(original).length
  const drift = Math.abs(String(repaired).length - before)
  return drift <= Math.max(8, Math.ceil(before * REPAIR_MAX_DRIFT_RATIO))
}
const CHIP_TOKEN_RE = /@(?:file|folder|url|image|tool|line|terminal|session):[^\s，。；、）)】」』]+/g
function chipsPreserved(original, repaired) {
  const tokens = String(original).match(CHIP_TOKEN_RE) || []
  if (!tokens.length) return true
  const out = String(repaired)
  return tokens.every((token) => out.includes(token))
}
function cleanRepair(text) {
  const stripped = String(text).trim().replace(/^["'“”‘’「」『』]|["'“”‘’「」『』]$/g, '')
  return stripped.replace(/^(?:修复后|修正后|校对后|已修复|修正版本)[:：]\s*/, '').trim()
}

test('R13: 长度护栏——同音字替换/补标点放行，扩写拒绝', () => {
  const orig = '帮我把这个方案整理一下发出去吧'
  // 等长同音字修正
  assert.equal(repairDriftOk(orig, '帮我把这个方案整理一下发出去吧'), true, '等长必须放行')
  assert.equal(repairDriftOk(orig, '帮我把这个方按整理一下发出去吧'), true, '同音字等长替换放行')
  // 补标点：+3
  assert.equal(repairDriftOk(orig, '帮我把这个方案整理一下，发出去吧。'), true, '补标点放行')
  // 扩写：40 字 → 90 字，预算 8
  const expanded = orig + '，另外请注意格式要规范、语气要正式、结构要清晰、不要遗漏任何关键信息、最好分点说明'
  assert.equal(repairDriftOk(orig, expanded), false, '扩写必须拒绝')
  // 长文本按 15% 放宽
  const long = '甲'.repeat(200)
  assert.equal(repairDriftOk(long, '甲'.repeat(230)), true, '200 字 +30 在 15% 预算内')
  assert.equal(repairDriftOk(long, '甲'.repeat(260)), false, '200 字 +60 超预算')
})

test('R14: chip token 护栏——丢失即拒绝', () => {
  const orig = '看看 @file:src/app.tsx 这个组件的样式'
  assert.equal(chipsPreserved(orig, '看看 @file:src/app.tsx 这个组件的样式。'), true, 'token 保留放行')
  assert.equal(chipsPreserved(orig, '看看 src/app.tsx 这个组件的样式'), false, 'token 被吃掉必须拒绝')
  assert.equal(chipsPreserved(orig, '看看 @file:src/app.ts 这个组件的样式'), false, 'token 被改写必须拒绝')
  assert.equal(chipsPreserved('没有引用标记的一句话', '没有引用标记的一句话'), true, '无 token 直接放行')
})

test('R15: cleanRepair 剥掉模型加的前缀与引号', () => {
  assert.equal(cleanRepair('修复后：帮我把方案整理一下'), '帮我把方案整理一下')
  assert.equal(cleanRepair('“帮我把方案整理一下”'), '帮我把方案整理一下')
  assert.equal(cleanRepair('  帮我把方案整理一下  '), '帮我把方案整理一下')
  assert.equal(cleanRepair('修正版本: 帮我把方案整理一下'), '帮我把方案整理一下')
})

// [v1.7.0] 回退只有一层：backup 记的是用户原文，且增强写回不得覆盖它
test('R16: 回退单层——backup 只赋一次、revert 后清空', () => {
  const fs = await_import_fs()
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  assert.ok(/if \(!st\.backup\) st\.backup = snapshot/.test(src), '增强写回不得无条件覆盖 backup')
  const revertBody = src.slice(src.indexOf('async function revert('))
  assert.ok(/st\.backup = ''/.test(revertBody.slice(0, 1200)), 'revert 后必须清空 backup（否则下次误判可回退）')
  assert.ok(!/st\.backup = (?:st\.lastApplied|repaired)/.test(src), 'backup 不得被写成修复稿/增强稿')
})

// [v1.7.0] ⌥ 点击 = 仅修复：入口必须存在，且这条路径绝不能调到增强
test('R17: ⌥ 点击只修复——有独立入口、不触发增强调用', () => {
  const fs = await_import_fs()
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  assert.ok(/e\?\.altKey\) runRepairOnly\(/.test(src), 'onClick 缺 altKey 分支')
  assert.ok(/async function runRepairOnly\(/.test(src), '缺 runRepairOnly 入口')
  // 取出 runRepairOnly 函数体（到下一个顶层 async function 为止）
  const start = src.indexOf('async function runRepairOnly(')
  const next = src.indexOf('\nasync function ', start + 10)
  const body = src.slice(start, next === -1 ? undefined : next)
  assert.ok(!/prompt_enhancement/.test(body), '仅修复路径不得调用增强任务')
  assert.ok(!/SYSTEM_TEMPLATE/.test(body), '仅修复路径不得使用增强模板')
  assert.ok(/repairAndApply\(/.test(body), '仅修复路径必须复用同一套修复写回（含快照守卫）')
})

// ── v1.8.0 模型 pin 语义镜像（与 plugin.js 的 normalizePin / effectivePin /
// consumeOnce 保持同步；plugin.js 改动这三处必须同步本文件并全量重跑） ──
function normalizePinMirror(v) {
  if (!v || typeof v !== 'object') return null
  const provider = typeof v.provider === 'string' ? v.provider.trim() : ''
  const model = typeof v.model === 'string' ? v.model.trim() : ''
  if (!provider || !model) return null
  return { enabled: v.enabled !== false, provider, model }
}

test('R18: 存储归一化——旧裸 {provider,model} 视为开启，半条记录丢弃', () => {
  assert.equal(normalizePinMirror(null), null)
  assert.equal(normalizePinMirror({ provider: 'p' }), null, '缺 model 的记录必须丢弃')
  assert.deepEqual(normalizePinMirror({ provider: ' p ', model: 'm' }), { enabled: true, provider: 'p', model: 'm' })
  assert.equal(normalizePinMirror({ enabled: false, provider: 'p', model: 'm' }).enabled, false)
})

test('R19: 只有「固定 / 未固定」两态：半条记录不生效，取消后回主模型', () => {
  let rec = { enabled: false, provider: '', model: '' }
  const complete = (p) => Boolean(p?.enabled && p.provider && p.model)
  const effective = () => (complete(rec) ? { provider: rec.provider, model: rec.model } : null)

  assert.equal(effective(), null, '没固定 → 主模型')
  rec = { ...rec, enabled: true }
  assert.equal(effective(), null, '开了但没有模型 → 不生效')
  rec = { ...rec, provider: 'p', model: 'm' }
  assert.deepEqual(effective(), { provider: 'p', model: 'm' })
  rec = { ...rec, enabled: false, provider: '', model: '' }
  assert.equal(effective(), null, '取消固定 → 主模型')
})

// ── 汇总 ──
let fail = 0
for (const [name, r] of results) {
  console.log(`${r === 'PASS' ? '✅' : '❌'} ${name}  ${r === 'PASS' ? '' : r}`)
  if (r !== 'PASS') fail++
}
console.log(`\n${results.length - fail}/${results.length} passed`)
process.exit(fail ? 1 : 0)
