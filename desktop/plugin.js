/**
 * Prompt Enhancer — composer "enhance prompt" button for Hermes desktop.
 *
 * Two-stage core loop, one click:
 *   1. REPAIR (v1.7.0) — its own stateless call fixes dictation/typo damage in
 *      the draft and writes the cleaned text back to the composer, so the user
 *      sees what changed and keeps a clean draft even if stage 2 fails.
 *   2. ENHANCE — rewrites the (repaired) draft into a structured prompt.
 *   ⌥/Option-click stops after stage 1 (repair only) — same write-back, same
 *   revert, no second call.
 *   A second click restores the original typing, typos included — one level of
 *   undo, never "back to the half-fixed draft".
 *   - read:  host.composer.getDraft (official session-addressed draft)
 *   - write: host.composer.setDraft — the app re-hydrates @ref / `/` tokens
 *   - model: both requests are sent BARE (no session_id), so llm.oneshot's auto
 *            arm lands on the configured aux route. To pin a dedicated model per
 *            step, set `auxiliary.prompt_repair` / `auxiliary.prompt_enhancement`
 *            in config.yaml — the plugin has no model picker of its own.
 *            NOTE: `auxiliary.<task>.timeout` does NOT apply here — the backend
 *            hard-caps each one-shot at 60s (agent/oneshot.py).
 *   - A2:    write-back only when draft untouched during the wait
 * Pure-SDK build (catalog review #121246): no DOM write path and no legacy
 * fallback — hosts without the draft API are gated out via requires_hermes.
 *
 * Stacked layout: contributed actions group with the send cluster natively
 * (upstream #116942) — no plugin-side layout workaround is needed or shipped.
 */
import { COMPOSER_AREAS, Button, Codicon, Tip, host, usePluginI18n } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

const ID = 'prompt-enhancer'
const MAX_INPUT_CHARS = 8000
const BTN_ATTR = 'data-prompt-enhancer-btn'

const GHOST_ICON_BTN =
  'size-(--composer-control-size) shrink-0 rounded-md text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'

const SYSTEM_TEMPLATE = `你是一位提示词工程专家，负责改进用户发给 AI 助手的提示词。给定一段提示词，分析并增强它，生成更有效的版本，同时保持其核心意图不变。

改写原则：
- 指令清晰、具体
- 补齐必要的上下文与约束
- 明确期望的输出形式
- 结构清晰，便于执行

硬性约束：
1. 语言跟随是最高优先级：必须严格使用与用户输入完全相同的语言（中文输入→中文输出，英文输入→英文输出，混排输入保持自然混排）。
2. 保持精炼：增强后的提示词不超过约 800 字符。
3. 只输出增强后的提示词本身，不要任何解释、前言、markdown 代码围栏或语言标签。
4. 只改写，不回答：不要回答用户的问题，而是把它改写得更明确。
5. 不要主动索取教程/操作指南，除非用户明确要求。
6. 不要索要代码片段。
7. 不要建议用户未提及的具体技术栈。
8. 不要解释怎么做，聚焦于要做什么。
9. 不编造事实，不擅自添加无关需求。
10. 原文已经足够清晰时，做轻度润色，不要原样返回，也不要过度扩充。`

// Repair runs BEFORE enhance as its own stateless call (never folded into the
// enhance prompt: one prompt cannot hold both "minimal edit" and "restructure"
// constraints without the second contaminating the first). Its contract is
// narrower than enhancement's on purpose — only fix what is demonstrably a
// typo, leave everything a reader could call "style" alone.
const REPAIR_TEMPLATE = `你是文本校对员。任务：修正用户输入中的录入错误，不做任何其他改动。

只修这些：
- 错别字、同音字/近音字混淆（例：把"全休"还原为"全修"）
- 语音输入造成的口误、漏字、多字、重复词
- 补全缺失的句读标点
- 仅当原句读不通时才调整语序

不要做这些：
- 不改写风格、不润色、不扩写、不精简
- 不补充信息、不调整结构、不合并或拆分句子
- 不改变原文语言与语气

判定规则：
- 只有在上下文足以确定正确写法时才改；有疑问一律保留原样
- 修改后长度应与原文基本一致
- 全文无需修改时，原样输出原文

只输出修正后的文本本身，不要解释、不要前缀、不要代码围栏。`

// Repair is a cheap pre-step, not a second product surface: long drafts are
// never dictated (so they carry few dictation typos) and a repair call whose
// output is as long as its input would eat the fixed 60s one-shot budget the
// enhance call needs right after it.
const REPAIR_SKIP_CHARS = 2000
// A real typo fix is length-neutral (homophones) or ±a few characters (dropped
// / doubled syllables, restored punctuation). Anything past this budget is the
// model rewriting, not proofreading — drop it and enhance the original.
const REPAIR_MAX_DRIFT_RATIO = 0.15

// ── pure:TDD-BEGIN ──
const RICH_INPUT_SLOT = 'composer-rich-input'
const COMPOSER_SURFACE_SLOT = 'composer-surface'

function stripWrappingQuotes(text) {
  return String(text).trim().replace(/^["'“”‘’「」『』]|["'“”‘’「」『』]$/g, '')
}

function looksTruncated(text) {
  return [':', '：', ',', '，'].includes(String(text).slice(-1))
}

// ── repair guardrails (pure) ──────────────────────────────────────────────
// Prompt-level instructions are soft: a model asked to "only fix typos" still
// drifts into light rewriting. These three checks are the hard gate — a repair
// result that fails any of them is discarded and the ORIGINAL draft is enhanced
// instead, so a bad repair degrades to today's behaviour rather than shipping
// the model's rewrite into the composer.
function repairDriftOk(original, repaired) {
  const before = String(original).length
  const drift = Math.abs(String(repaired).length - before)
  return drift <= Math.max(8, Math.ceil(before * REPAIR_MAX_DRIFT_RATIO))
}

const CHIP_TOKEN_RE = /@(?:file|folder|url|image|tool|line|terminal|session):[^\s，。；、）)】」』]+/g

// Reference tokens are machine text: a repair that drops or transliterates one
// breaks the chip on write-back (setDraft re-hydrates them), so every token in
// the original must survive verbatim.
function chipsPreserved(original, repaired) {
  const tokens = String(original).match(CHIP_TOKEN_RE) || []
  if (!tokens.length) return true
  const out = String(repaired)
  return tokens.every((token) => out.includes(token))
}

// The model likes to answer "修复后：……" or wrap the text in quotes. Strip that
// framing; a result that is still empty afterwards is rejected by the caller.
function cleanRepair(text) {
  const stripped = stripWrappingQuotes(String(text ?? ''))
  return stripped.replace(/^(?:修复后|修正后|校对后|已修复|修正版本)[:：]\s*/, '').trim()
}

function resolveSessionId(btnEl, getActiveSessionId) {
  const anchor = btnEl && btnEl.closest ? btnEl.closest('[data-session-anchor]')?.getAttribute('data-session-anchor') ?? '' : ''
  const m = anchor.match(/^session-tile:(.+)$/)
  if (m && m[1]) return m[1]
  return getActiveSessionId() || null
}
// ── pure:TDD-END ──

// Per-composer state isolation: each composer instance (editor DOM node) owns
// its own phase / backup / applied-text / cancel token. A global atom here made
// EVERY window's button spin when one session was enhancing (v1.0.6 bug) —
// state must be keyed by the editor node, React state drives this instance's
// render only. Keyed by the editor element: it is the stable anchor per
// composer (survives button remounts; WeakMap GCs when the composer unmounts).
const stateByEditor = new WeakMap() // editor → { phase, backup, lastApplied, seq }
function editorState(editor) {
  let s = stateByEditor.get(editor)
  if (!s) {
    s = { phase: 'idle', backup: '', lastApplied: '', seq: 0 }
    stateByEditor.set(editor, s)
  }
  return s
}

// ── i18n via official channel (v3 §3-⑩) ──
// ctx.i18n.register(LOCALES): nested tree, dot-path keys, interpolator fns.
// Components read via usePluginI18n(ID) (reactive on locale switch);
// non-React handlers use ctx.i18n.t captured at register time.
const LOCALES = {
  en: {
    tip: { idle: 'Enhance prompt (⌥-click: fix typos only)', repairing: 'Fixing typos…', enhancing: 'Enhancing…', retrying: 'Rate limited — retrying…', repaired: 'Input fixed — click to revert', revert: 'Revert to original' },
    notify: {
      noEditor: 'Composer not found',
      notEditable: 'Composer is not editable right now',
      chipBail: 'Draft contains references/path tags — enhance not supported yet',
      tooLong: (n, max) => `Draft too long (${n} > ${max} chars) — enhance not supported`,
      noSession: 'Cannot resolve the owning session — enhance not supported',
      draftChanged: 'Draft changed — enhancement not applied',
      revertStale: 'Draft changed — revert mode exited',
      truncated: 'Result may be truncated — click the button to revert',
      emptyDraft: 'Composer is empty — nothing to enhance',
      repairNoChange: 'No typos found — nothing to fix',
      empty: 'Enhancement came back empty',
      failed: (m) => `Enhance failed: ${m}`
    }
  },
  zh: {
    tip: { idle: '增强提示词（⌥ 点击仅修复错字）', repairing: '修复输入中…', enhancing: '增强中…', retrying: '限流重试中…', repaired: '已修复输入 · 恢复原文', revert: '恢复原文' },
    notify: {
      noEditor: '未找到输入框',
      notEditable: '输入框当前不可编辑',
      chipBail: '草稿含引用/路径标签，暂不支持增强',
      tooLong: (n, max) => `草稿过长（${n} > ${max} 字符），暂不支持增强`,
      noSession: '无法确定所属会话，暂不支持增强',
      draftChanged: '草稿已变动，本次增强结果未应用',
      revertStale: '草稿已变动，已退出恢复模式',
      truncated: '结果可能被截断，可点击按钮恢复原文',
      emptyDraft: '输入框为空，没有可增强的内容',
      repairNoChange: '未发现需要修复的内容',
      empty: '增强结果为空',
      failed: (m) => `增强失败：${m}`
    }
  },
  'zh-hant': {
    tip: { idle: '增強提示詞（⌥ 點擊僅修復錯字）', repairing: '修復輸入中…', enhancing: '增強中…', retrying: '限流重試中…', repaired: '已修復輸入 · 恢復原文', revert: '恢復原文' },
    notify: {
      noEditor: '未找到輸入框',
      notEditable: '輸入框目前不可編輯',
      chipBail: '草稿含引用/路徑標籤，暫不支援增強',
      tooLong: (n, max) => `草稿過長（${n} > ${max} 字元），暫不支援增強`,
      noSession: '無法確定所屬會話，暫不支援增強',
      draftChanged: '草稿已變動，本次增強結果未套用',
      revertStale: '草稿已變動，已退出恢復模式',
      truncated: '結果可能被截斷，可點擊按鈕恢復原文',
      emptyDraft: '輸入框為空，沒有可增強的內容',
      repairNoChange: '未發現需要修復的內容',
      empty: '增強結果為空',
      failed: (m) => `增強失敗：${m}`
    }
  }
}

let ti18nStatic = null // captured at register; null before → raw-key fallback

function tNotify(kind, key, ...args) {
  const msg = ti18nStatic ? ti18nStatic(key, ...args) : null
  host.notify({ kind, message: msg ?? `[prompt-enhancer] ${key}` })
}

// The button's OWN composer editor. Both live inside the surface wrapper
// (actions strip + rich editor are siblings), so hop one level then find the
// editor slot — read-only: isContentEditable probe + change-watch target
// below; all draft I/O goes through host.composer.
function resolveEditor(btnEl) {
  const root = btnEl?.closest?.(`[data-slot="${COMPOSER_SURFACE_SLOT}"]`)
  return root?.querySelector(`[data-slot="${RICH_INPUT_SLOT}"]`) ?? null
}

const RETRY_DELAYS_MS = [3000, 5000]

// Gateway 429 (upstream channel rate limit, e.g. shared aggregator RPM) is
// transient — the agent's own chat loop survives it via backoff retries, so a
// one-shot no-retry call failing on the first click looked like a broken
// plugin. Mirror the same defense here: retry 429 with backoff (3s, 5s).
function isRateLimited(err) {
  return /429|rate.?limit/i.test(`${err?.message ?? ''} ${err?.name ?? ''} ${String(err)}`)
}

// ── host.composer draft API (hermes-agent #120907) ────────────────────────
// On hosts exposing host.composer the whole read/write pair goes through the
// getDraft answers with the live text, setDraft re-hydrates @ref / `/` tokens
// into chips exactly like an official paste (the app's renderComposerContents).
// This is the ONLY draft path: hosts below the API are gated out by
// requires_hermes, and a false write (fail-closed contract = no mounted
// surface claimed the address, e.g. the user switched away while the LLM call
// ran) is reported to the user, never papered over with DOM.
function sdkComposer() {
  const c = host.composer
  return c && typeof c.getDraft === 'function' && typeof c.setDraft === 'function' ? c : null
}

// Ref chips (@file:... etc) serialize to their literal command text inside the
// draft and the official renderer rebuilds them on write-back. Module scope: the
// repair pre-step reads it too (a chip-bearing draft skips repair entirely —
// reference tokens are machine text with nothing to proofread, and rewriting
// one breaks the chip).
const CHIP_REF_RE = /@(file|folder|url|image|tool|line|terminal|session):/

// Shared 429 backoff for both one-shots: the gateway's upstream channel is a
// shared aggregator and rate-limits in bursts, so a single transient failure
// must not surface as a broken button.
async function callGatewayWithRetry(gw, req, onRetry) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await gw.request('llm.oneshot', req, 180_000)
    } catch (e) {
      if (attempt < RETRY_DELAYS_MS.length && isRateLimited(e)) {
        onRetry?.(attempt + 1) // surface "retrying" in the tooltip instead of silent backoff
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]))
        continue
      }
      throw e
    }
  }
}

// Best-effort pre-step. Returns the repaired text, or null meaning "enhance the
// original". null deliberately covers every reason to skip — too long, carries
// ref chips, too short, call failed, cancelled, empty output, or a guardrail
// rejection — because none of them should block the enhancement the user asked
// for. The caller never distinguishes, so a bad repair degrades to the old
// behaviour instead of failing the click.
async function runRepair(c, sessionId, text, st, seq, onRetry) {
  if (text.length > REPAIR_SKIP_CHARS) return null
  if (CHIP_REF_RE.test(text)) return null
  if (text.trim().length < 8) return null
  const gw = host.getGateway()
  if (!gw) return null
  let res
  try {
    res = await callGatewayWithRetry(gw, {
      instructions: REPAIR_TEMPLATE,
      input: text,
      // Output is as long as the input, so the budget tracks it: the enhance
      // call's fixed 2048 would truncate a 1.5k-character draft.
      max_tokens: Math.min(8192, Math.ceil(text.length * 1.6) + 256),
      temperature: 0, // proofreading is not a creative task
      // Its own aux task so the two steps can be routed separately (a fast
      // model for repair, a strong one for enhancement).
      task: 'prompt_repair'
    }, onRetry)
  } catch (e) {
    console.error('[prompt-enhancer] repair failed (enhancing the original):', e)
    return null
  }
  if (seq !== st.seq) return null
  const repaired = cleanRepair(res?.text)
  if (!repaired || repaired === text) return null
  if (!repairDriftOk(text, repaired) || !chipsPreserved(text, repaired)) {
    console.error('[prompt-enhancer] repair rejected by guardrail (drift/chip) — enhancing the original')
    return null
  }
  return repaired
}

// Where a failed or cancelled run leaves the composer: if the repair pre-step
// already wrote a fixed draft back, that is still a usable result AND still
// revertable, so drop to `repaired`; an untouched draft returns to idle.
function settlePhase(st) {
  return st.backup ? 'repaired' : 'idle'
}

// Runs the repair pre-step AND writes its result back, for both entry points
// (⌥-click stops here; plain click continues into enhancement). One
// implementation on purpose: the draft-unchanged guard and the "backup is the
// user's original" rule must not drift between the two paths.
//   reason: 'applied'   — repaired text is in the composer, backup recorded
//           'skipped'   — nothing to repair / guardrail rejected the result
//           'changed'   — the user edited the draft while we were working
//           'cancelled' — the run was cancelled mid-flight
async function repairAndApply(c, sessionId, text, st, seq, onRetry) {
  const repaired = await runRepair(c, sessionId, text, st, seq, onRetry)
  if (seq !== st.seq) return { reason: 'cancelled', base: null }
  if (!repaired) return { reason: 'skipped', base: null }
  // Same draft-unchanged guard as the enhance write-back: the user may have
  // kept typing while the repair call ran.
  const beforeWrite = await c.getDraft(sessionId)
  if (beforeWrite !== text) return { reason: 'changed', base: null }
  let wrote = false
  try { wrote = await c.setDraft(sessionId, repaired) } catch { wrote = false }
  if (!wrote) return { reason: 'changed', base: null }
  // The app normalizes on paint; keep the composer's own text as the base so
  // the enhance guard and revert compare like with like.
  const painted = await c.getDraft(sessionId)
  const base = typeof painted === 'string' && painted ? painted : repaired
  // Backup is the user's ORIGINAL text, set exactly once here — never
  // overwritten by the enhance write-back, so "revert" always lands on what the
  // user typed, not on the half-fixed draft.
  st.backup = text
  st.lastApplied = base
  st.phase = 'repaired'
  return { reason: 'applied', base }
}

// ⌥-click path: repair only, stop there. The repaired draft stays revertable
// exactly like the plain-click path — this is a real result, not a preview.
async function runRepairOnly(btnEl, onPhase, onRetry) {
  const c = sdkComposer()
  if (!c) return tNotify('error', 'notify.failed', 'requires Hermes ≥ 0.21.5 (composer draft API)')
  const editor = resolveEditor(btnEl)
  if (!editor) return tNotify('error', 'notify.noEditor')
  if (!editor.isContentEditable) return tNotify('error', 'notify.notEditable')
  const st = editorState(editor)
  if (st.phase === 'enhancing' || st.phase === 'repairing') return
  const sessionId = resolveSessionId(btnEl, () => host.state.activeSessionId.get())
  const text = (await c.getDraft(sessionId)) ?? ''
  if (!text.trim()) return tNotify('info', 'notify.emptyDraft')
  if (text.length > MAX_INPUT_CHARS) return tNotify('error', 'notify.tooLong', text.length, MAX_INPUT_CHARS)

  const seq = ++st.seq
  st.backup = ''
  st.lastApplied = ''
  st.phase = 'repairing'
  onPhase('repairing')
  const { reason } = await repairAndApply(c, sessionId, text, st, seq, onRetry)
  if (reason === 'cancelled') return
  if (reason === 'applied') return onPhase('repaired')
  st.phase = 'idle'
  onPhase('idle')
  // "Nothing happened" needs a reason: the draft changed under us, the draft is
  // chip-only (repair skips those), or there was genuinely nothing to fix.
  if (reason === 'changed') tNotify('info', 'notify.draftChanged')
  else tNotify('info', CHIP_REF_RE.test(text) ? 'notify.chipBail' : 'notify.repairNoChange')
}

async function runEnhance(btnEl, onPhase, onRetry) {
  const c = sdkComposer()
  if (!c) return tNotify('error', 'notify.failed', 'requires Hermes ≥ 0.21.5 (composer draft API)')
  const editor = resolveEditor(btnEl)
  if (!editor) return tNotify('error', 'notify.noEditor')
  if (!editor.isContentEditable) return tNotify('error', 'notify.notEditable')
  const st = editorState(editor)
  if (st.phase === 'enhancing' || st.phase === 'repairing') return
  // Routing: both requests are sent BARE (no session_id), so llm.oneshot's auto
  // arm lands on the configured aux route rather than the live session's model.
  // Dedicated models are configured host-side via `auxiliary.prompt_repair` /
  // `auxiliary.prompt_enhancement` in config.yaml.
  const sessionId = resolveSessionId(btnEl, () => host.state.activeSessionId.get())
  const draftText = await c.getDraft(sessionId)
  const text = draftText ?? ''
  if (!text.trim()) {
    // Images/attachments alone (no text) land here — tell the user instead of
    // silently no-oping (v3 §1 said "no-op", user feedback corrected it).
    tNotify('info', 'notify.emptyDraft')
    return
  }
  if (text.length > MAX_INPUT_CHARS) return tNotify('error', 'notify.tooLong', text.length, MAX_INPUT_CHARS)

  const snapshot = text
  const seq = ++st.seq
  // A fresh run owns its own backup: anything left over from a previous
  // enhance/revert must not be mistaken for this run's original draft.
  st.backup = ''
  st.lastApplied = ''

  // ── step 1: repair the draft (independent, best-effort) ─────────────────
  // Its own state phase and its own call. The repaired text is written back to
  // the composer so the user SEES what changed — the composer is the review
  // surface, there is no diff panel — and so the step still leaves them with a
  // clean draft if the enhancement that follows fails.
  st.phase = 'repairing'
  onPhase('repairing')
  const repairStep = await repairAndApply(c, sessionId, text, st, seq, onRetry)
  if (repairStep.reason === 'cancelled') return // draft untouched
  if (repairStep.reason === 'changed') {
    tNotify('info', 'notify.draftChanged')
    st.phase = 'idle'
    onPhase('idle')
    return
  }
  const base = repairStep.base ?? snapshot
  if (repairStep.reason === 'applied') onPhase('repaired')

  // ── step 2: enhance on top of the repaired draft ────────────────────────
  const hasChips = CHIP_REF_RE.test(base)
  st.phase = 'enhancing'
  onPhase('enhancing')
  try {
    const instructions = hasChips
      ? SYSTEM_TEMPLATE + '\n\n额外硬性约束：文本中的 @file:、@folder:、@url:、@image: 等引用标记是文件/资源引用 token，必须原样保留在增强结果中（位置可以合理调整），禁止改写、翻译或删除它们。'
      : SYSTEM_TEMPLATE
    const req = {
      instructions,
      input: base,
      max_tokens: 2048,
      temperature: 0.3,
      // NOT the default title_generation: that routes to the weak fast model.
      // A custom task name gets the standard aux route, so `auxiliary.<task>`
      // can pin a provider/model per step.
      task: 'prompt_enhancement'
    }
    // host.request is hard-capped at the gateway default 30s
    // (DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS) — LLM generation routinely exceeds
    // it. getGateway().request takes timeoutMs as its 3rd arg (client wait).
    // NOTE: the backend caps the generation itself at 60s regardless
    // (agent/oneshot.py run_oneshot timeout=60.0), so `auxiliary.<task>.timeout`
    // does NOT apply on this path — the client-side wait is only the outer bound.
    const gw = host.getGateway()
    if (!gw) throw new Error('Hermes gateway unavailable')
    const res = await callGatewayWithRetry(gw, req, onRetry)
    // Cancelled while waiting → discard the late result silently (the editor
    // still holds whatever step 1 left there; nothing to roll back).
    if (seq !== st.seq) return
    const cleaned = stripWrappingQuotes(String(res?.text ?? ''))
    if (!cleaned.trim()) throw new Error('empty')
    const live = await c.getDraft(sessionId)
    if (live !== base) {
      tNotify('info', 'notify.draftChanged')
      const p = settlePhase(st)
      st.phase = p
      onPhase(p)
      return
    }
    // Only when step 1 did not already record the original: `repaired` keeps
    // the pre-repair text, so revert still lands on what the user typed.
    if (!st.backup) st.backup = snapshot
    st.lastApplied = cleaned
    // SDK-only write: false/throw = no mounted surface claimed the address
    // (user switched away mid-call). Tell the user; never reach into the DOM.
    let applied = false
    try { applied = await c.setDraft(sessionId, cleaned) } catch { applied = false }
    if (!applied) {
      tNotify('info', 'notify.draftChanged')
      const p = settlePhase(st)
      st.phase = p
      onPhase(p)
      return
    }
    // The app normalizes on paint (a known `/token` becomes a pill, a ref
    // token gains its canonical quoting) — store the composer's OWN text so
    // the auto-reset observer and revert's stale check compare like with
    // like instead of tripping on that normalization.
    const painted = await c.getDraft(sessionId)
    if (typeof painted === 'string') st.lastApplied = painted
    st.phase = 'enhanced'
    onPhase('enhanced')
    if (looksTruncated(cleaned)) {
      tNotify('info', 'notify.truncated')
    }
  } catch (err) {
    if (seq !== st.seq) return // cancelled during retry backoff — stay quiet
    console.error('[prompt-enhancer] enhance failed:', err)
    tNotify('error', 'notify.failed', err?.message ?? String(err))
    // A failed enhance must not strand a repaired draft in an unusable state:
    // it stays revertable, so the user can still get their typing back.
    const p = settlePhase(st)
    st.phase = p
    onPhase(p)
  }
}

async function revert(btnEl, onPhase) {
  const c = sdkComposer()
  if (!c) return
  const editor = resolveEditor(btnEl)
  if (!editor) return // button detached (session switched) — nothing to restore into
  const st = editorState(editor)
  const sessionId = resolveSessionId(btnEl, () => host.state.activeSessionId.get())
  const live = await c.getDraft(sessionId)
  if (live !== st.lastApplied) {
    tNotify('info', 'notify.revertStale')
    st.phase = 'idle'
    st.backup = ''
    st.lastApplied = ''
    onPhase('idle')
    return
  }
  let applied = false
  try { applied = await c.setDraft(sessionId, st.backup) } catch { applied = false }
  if (!applied) tNotify('info', 'notify.revertStale')
  // One level only: back to what the user typed (typos included). There is no
  // intermediate "repaired" step to land on — that would make a single revert
  // click feel like it did not finish.
  st.phase = 'idle'
  st.backup = ''
  st.lastApplied = ''
  onPhase('idle')
}

// WorkBuddy-parity spinner: 16px circle, stroke-dasharray "28 10", 1s linear
// infinite rotation (extracted from WorkBuddy app.asar, EnhanceButton spinner).
// Native DOM — color follows currentColor so the button's --ui-text-tertiary
// drives it across light/dark themes.
function Spinner() {
  return jsx('span', {
    style: {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: '16px', height: '16px',
      animation: 'pe-spin 1s linear infinite'
    },
    children: jsx('svg', {
      width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
      children: jsx('circle', {
        cx: 8, cy: 8, r: 6, stroke: 'currentColor', strokeWidth: 2,
        strokeLinecap: 'round', strokeDasharray: '28 10'
      })
    })
  })
}

// Keyframes can't be inline styles — inject once at register, remove on dispose.
function injectSpinnerStyle() {
  if (document.getElementById('prompt-enhancer-styles')) return
  const el = document.createElement('style')
  el.id = 'prompt-enhancer-styles'
  el.textContent = '@keyframes pe-spin{to{transform:rotate(360deg)}}'
  document.head.appendChild(el)
}
function removeSpinnerStyle() {
  document.getElementById('prompt-enhancer-styles')?.remove()
}

function EnhanceButton() {
  const t = usePluginI18n(ID)
  const btnRef = useRef(null)
  // Phase is per-composer: React state drives THIS instance's render only;
  // the authoritative copy lives in stateByEditor (keyed by editor node) so
  // runEnhance/revert/MutationObserver can read/update it outside React.
  const [phase, setPhase] = useState('idle')
  const [retrying, setRetrying] = useState(false)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const syncPhase = useCallback((p) => {
    const editor = resolveEditor(btnRef.current)
    if (editor) editorState(editor).phase = p
    // Leaving either busy phase clears the retry flag (both one-shots can hit 429).
    if (p !== 'enhancing' && p !== 'repairing') setRetrying(false)
    setPhase(p)
  }, [])
  const syncRetry = useCallback(() => setRetrying(true), [])

  // Auto-reset: once the composer holds OUR text (a repaired draft or an
  // enhanced one), that state only stays valid while the editor still HOLDS it.
  // Sending clears the editor (use-composer-submit clearDraft) — so watch the
  // editor and fall back to idle the moment its content diverges (sent / edited
  // / switched session).
  useLayoutEffect(() => {
    if (phase !== 'enhanced' && phase !== 'repaired') return
    const btn = btnRef.current
    const editor = resolveEditor(btn)
    if (!editor) return
    const st = editorState(editor)
    const holdsOurs = () => st.phase === 'enhanced' || st.phase === 'repaired'
    // Read-only change-watch (send clears the draft, user edits mutate it):
    // any mutation re-reads the authoritative draft and drops to idle when it
    // diverges from what we applied. DOM is never written from here.
    const mo = new MutationObserver(() => {
      if (!holdsOurs()) return
      const c = sdkComposer()
      if (!c) return
      const btn = btnRef.current
      void c.getDraft(resolveSessionId(btn, () => host.state.activeSessionId.get())).then((live) => {
        if (!holdsOurs()) return
        if (live !== null && live !== st.lastApplied) {
          st.phase = 'idle'
          st.backup = ''
          st.lastApplied = ''
          setPhase('idle')
        }
      }).catch(() => { /* detached mid-read — next observer tick retries */ })
    })
    mo.observe(editor, { childList: true, characterData: true, subtree: true })
    return () => mo.disconnect()
  }, [phase])

  const onClick = (e) => {
    const editor = resolveEditor(btnRef.current)
    const st = editor ? editorState(editor) : null
    const current = st?.phase ?? phaseRef.current
    // Both "holds our text" states revert the same way — one click, back to the
    // user's original typing. `repaired` is a partial success, not a second
    // level of undo.
    if (current === 'enhanced' || current === 'repaired') void revert(btnRef.current, syncPhase)
    else if (current === 'enhancing' || current === 'repairing') {
      // WorkBuddy parity: the spinning button is a cancel button. Bump THIS
      // editor's seq so its in-flight request's late result is discarded.
      if (st) st.seq++
      // A repair already written back is a finished result — stay revertable
      // instead of dropping the user into an idle button over a changed draft.
      syncPhase(st ? settlePhase(st) : 'idle')
    }
    // ⌥/Option-click = repair only, no enhancement. Only honoured from idle:
    // in the revert and busy states the button has exactly one meaning and a
    // modifier must not silently change it.
    else if (e?.altKey) runRepairOnly(btnRef.current, syncPhase, syncRetry)
    else runEnhance(btnRef.current, syncPhase, syncRetry)
  }

  const busy = phase === 'enhancing' || phase === 'repairing'
  const tip = phase === 'enhancing'
    ? (retrying ? t('tip.retrying') : t('tip.enhancing'))
    : phase === 'repairing'
      ? (retrying ? t('tip.retrying') : t('tip.repairing'))
      : phase === 'repaired' ? t('tip.repaired')
        : phase === 'enhanced' ? t('tip.revert')
          : t('tip.idle')

  return jsx(Tip, {
    label: tip,
    children: jsx(Button, {
      'aria-label': tip,
      [BTN_ATTR]: '',
      className: GHOST_ICON_BTN,
      disabled: false, // spinner is a cancel button while busy (WorkBuddy parity)
      onClick,
      ref: btnRef,
      size: 'icon',
      type: 'button',
      variant: 'ghost',
      children: busy
        ? jsx(Spinner, {})
        : jsx(Codicon, {
            // The icon tracks the action available, not the event that just
            // happened: once the composer holds our text, the only thing this
            // button can still do is go back to the original draft → return arrow.
            name: phase === 'enhanced' || phase === 'repaired' ? 'discard' : 'sparkle',
            size: '0.875rem'
          })
    })
  })
}

export default {
  id: ID,
  name: 'Prompt Enhancer',
  description: 'A composer ✨ button that fixes dictation typos in the draft, then rewrites it into a structured prompt (task / scope / constraints / output shape); one click back restores the original typing. Two stateless gateway calls (repair → enhance), preserves @file and /command chips, per-session state.',
  register(ctx) {
    const disposeI18n = ctx.i18n.register(LOCALES)
    ti18nStatic = ctx.i18n.t
    injectSpinnerStyle()

    ctx.register({
      id: 'enhance-button',
      area: COMPOSER_AREAS.actions,
      order: 100,
      render: () => jsx(EnhanceButton, {})
    })
    ctx.onDispose?.(() => {
      disposeI18n?.()
      removeSpinnerStyle()
      ti18nStatic = null
    })
    console.error(`[prompt-enhancer] registered (pure-sdk) into ${COMPOSER_AREAS.actions}`)
  }
}
