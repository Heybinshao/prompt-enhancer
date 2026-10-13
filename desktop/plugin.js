/**
 * Prompt Enhancer — composer "enhance prompt" button for Hermes desktop.
 *
 * M1 core loop. M2: ⌘+click opens the official model picker
 * (ModelCatalogMenu, "edit models" hidden) carrying OUR own enable toggle:
 * off = Hermes main model (request sent bare — no session inherit),
 * on = the pinned model sent as llm.oneshot provider/model params.
 * Hosts without the provider/model passthrough reject the pinned request
 * (contract extra=forbid → 4000 "out of sync"); the plain main-model path
 * works everywhere. Upstream support PR pending for hermes-agent.
 *   - read:  host.composer.getDraft (official session-addressed draft)
 *   - write: host.composer.setDraft — the app re-hydrates @ref / `/` tokens
 *   - model: main model by default; the ⌘+click pin overrides it when toggled on
 *   - A2:    write-back only when draft untouched during the wait
 * Pure-SDK build (catalog review #121246): no DOM write path and no legacy
 * fallback — hosts without the draft API are gated out via requires_hermes.
 *
 * Layout fix (stacked mode): the official controls cluster wraps itself in an
 * `ml-auto` div. Single-line the controls grid cell is `auto`-sized (no free
 * space → no visible gap); stacked it is `1fr` → the elastic ml-auto eats ALL
 * free space and orphanes our button at the cell's far left (next to "+").
 * Fix: inline-zero the sibling cluster's marginLeft and let the parent row's
 * own `justify-end` pack both right in every mode. Purely cosmetic inline
 * style; MutationObserver re-asserts after React remounts; disposed cleanly.
 */
import {
  COMPOSER_AREAS, Button, Codicon, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, ModelCatalogMenu, ModelMenuCloseContext, SegmentedControl, Tip, host, usePluginI18n
} from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

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
- 自动识别并修正语音输入造成的口误、笔误、同音/近音错别字、漏字、多字和明显语序错误（例如把"全休"还原为"全修"这类同音字问题）；修正应基于上下文推断用户本意，不改变原意；无法确定是否错误时保持原样，避免过度改写

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

// ── pure:TDD-BEGIN ──
const RICH_INPUT_SLOT = 'composer-rich-input'
const COMPOSER_SURFACE_SLOT = 'composer-surface'

function stripWrappingQuotes(text) {
  return String(text).trim().replace(/^["'“”‘’「」『』]|["'“”‘’「」『』]$/g, '')
}

function looksTruncated(text) {
  return [':', '：', ',', '，'].includes(String(text).slice(-1))
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

// ── Enhance model pin (⌘+click picker, M2) ───────────────────────────────
// One global pin for every composer, stored via ctx.storage as
// { enabled, provider, model }. Semantics (user spec): toggle OFF (or never
// picked) → enhance runs on Hermes' configured MAIN model — the request is
// sent bare (no session_id), so llm.oneshot's auto arm lands on
// model.default, NOT the live session's model. Toggle ON → the pinned model
// wins via llm.oneshot's provider/model params (explicit route beats
// session/default). Picking a model auto-enables; disabling keeps the pick.
// Hosts without the llm.oneshot provider/model passthrough answer 4000
// "out of sync" for PINNED requests only — bare/main-model enhancement never
// touches the new params and works on every host (upstream PR pending).
let storageApi = null          // ctx.storage, captured at register
let modelPin = null            // { enabled, provider, model } | null
const pinListeners = new Set() // re-render buttons whose tooltip shows the pin

function loadPin() {
  try {
    const v = storageApi?.get('enhanceModel')
    if (v && typeof v === 'object') {
      const provider = typeof v.provider === 'string' ? v.provider : ''
      const model = typeof v.model === 'string' ? v.model : ''
      // Pre-toggle storage (a bare { provider, model }) reads as enabled.
      return { enabled: v.enabled !== false, provider, model }
    }
  } catch { /* corrupted storage → default */ }
  return null
}

// Merge-patch the pin, persist, broadcast. The record is always written whole
// (never removed) so a disabled toggle survives restarts.
function setModelPin(patch) {
  modelPin = { enabled: false, provider: '', model: '', ...(modelPin ?? {}), ...patch }
  try { storageApi?.set('enhanceModel', modelPin) } catch { /* best-effort */ }
  for (const fn of pinListeners) { try { fn(modelPin) } catch { /* one bad listener must not break the rest */ } }
}

// The pin that actually routes a request: enabled AND fully specified.
function effectivePin() {
  return modelPin?.enabled && modelPin.provider && modelPin.model ? modelPin : null
}

// ── i18n via official channel (v3 §3-⑩) ──
// ctx.i18n.register(LOCALES): nested tree, dot-path keys, interpolator fns.
// Components read via usePluginI18n(ID) (reactive on locale switch);
// non-React handlers use ctx.i18n.t captured at register time.
const LOCALES = {
  en: {
    tip: { idle: 'Enhance prompt', enhancing: 'Enhancing…', retrying: 'Rate limited — retrying…', revert: 'Revert to original', pinned: (m) => `Enhance prompt (${m})` },
    menu: {
      custom: 'Custom model', off: 'Off', on: 'On',
      statusMain: 'Current: main model',
      statusPick: 'Turn on, then pick a model above'
    },
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
      empty: 'Enhancement came back empty',
      failed: (m) => `Enhance failed: ${m}`
    }
  },
  zh: {
    tip: { idle: '增强提示词', enhancing: '增强中…', retrying: '限流重试中…', revert: '恢复原文', pinned: (m) => `增强提示词（${m}）` },
    menu: {
      custom: '自定义模型', off: '关', on: '开',
      statusMain: '当前：主模型',
      statusPick: '开启后，点上方列表选模型'
    },
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
      empty: '增强结果为空',
      failed: (m) => `增强失败：${m}`
    }
  },
  'zh-hant': {
    tip: { idle: '增強提示詞', enhancing: '增強中…', retrying: '限流重試中…', revert: '恢復原文', pinned: (m) => `增強提示詞（${m}）` },
    menu: {
      custom: '自訂模型', off: '關', on: '開',
      statusMain: '目前：主模型',
      statusPick: '開啟後，點上方列表選模型'
    },
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

async function runEnhance(btnEl, onPhase, onRetry) {
  const c = sdkComposer()
  if (!c) return tNotify('error', 'notify.failed', 'requires Hermes ≥ 0.21.5 (composer draft API)')
  const editor = resolveEditor(btnEl)
  if (!editor) return tNotify('error', 'notify.noEditor')
  if (!editor.isContentEditable) return tNotify('error', 'notify.notEditable')
  const st = editorState(editor)
  if (st.phase === 'enhancing') return
  // Ref chips (@file:... etc) serialize to their literal command text inside
  // the draft and the official renderer rebuilds them on write-back — so a
  // mixed draft is enhanceable: we protect the chip tokens in the template.
  // (Token scan on the TEXT, not the DOM: getDraft already carries them.)
  const CHIP_REF_RE = /@(file|folder|url|image|tool|line|terminal|session):/
  // Routing (user spec): pin enabled → session_id + explicit provider/model
  // (the pin wins over the session's model). Pin off / never picked → send the
  // request BARE (no session_id): llm.oneshot's auto arm then lands on the
  // configured MAIN model (model.default), not whatever the session happens to
  // run — the picker is the only thing that steers enhancement.
  const sessionId = resolveSessionId(btnEl, () => host.state.activeSessionId.get())
  const pin = effectivePin()
  const draftText = await c.getDraft(sessionId)
  const text = draftText ?? ''
  const hasChips = CHIP_REF_RE.test(text)
  if (!text.trim()) {
    // Images/attachments alone (no text) land here — tell the user instead of
    // silently no-oping (v3 §1 said "no-op", user feedback corrected it).
    tNotify('info', 'notify.emptyDraft')
    return
  }
  if (text.length > MAX_INPUT_CHARS) return tNotify('error', 'notify.tooLong', text.length, MAX_INPUT_CHARS)

  const snapshot = text
  // Draft-unchanged guard: re-read the live draft and compare TEXT. Prevents
  // writing an enhancement onto text the user kept editing while the LLM was
  // thinking.
  const seq = ++st.seq
  st.phase = 'enhancing'
  onPhase('enhancing')
  try {
    const instructions = hasChips
      ? SYSTEM_TEMPLATE + '\n\n额外硬性约束：文本中的 @file:、@folder:、@url:、@image: 等引用标记是文件/资源引用 token，必须原样保留在增强结果中（位置可以合理调整），禁止改写、翻译或删除它们。'
      : SYSTEM_TEMPLATE
    const req = {
      instructions,
      input: text,
      max_tokens: 2048,
      temperature: 0.3,
      // NOT the default title_generation: that routes to the weak fast model
      // and times out on our ~700-char template + long drafts (60s cap).
      // A custom task name gets the standard aux model + its own timeout key.
      task: 'prompt_enhancement'
    }
    if (pin) {
      if (sessionId) req.session_id = sessionId
      // M2: an enabled ⌘+click pin wins over session/default routing (host
      // llm.oneshot provider/model passthrough; hosts without it reject this
      // request with 4000 out-of-sync — enhancement stays usable with the
      // toggle off, which needs no new host surface).
      req.provider = pin.provider
      req.model = pin.model
    }
    // host.request is hard-capped at the gateway default 30s
    // (DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS) — LLM generation routinely exceeds
    // it. getGateway().request takes timeoutMs as its 3rd arg: 3 minutes.
    const gw = host.getGateway()
    if (!gw) throw new Error('Hermes gateway unavailable')
    let res = null
    for (let attempt = 0; ; attempt++) {
      try {
        res = await gw.request('llm.oneshot', req, 180_000)
        break
      } catch (e) {
        if (attempt < RETRY_DELAYS_MS.length && isRateLimited(e)) {
          onRetry(attempt + 1) // surface "retrying" in the tooltip instead of silent backoff
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]))
          continue
        }
        throw e
      }
    }
    // Cancelled while waiting → discard the late result silently (the editor
    // still holds the original snapshot; nothing to roll back).
    if (seq !== st.seq) return
    const cleaned = stripWrappingQuotes(String(res?.text ?? ''))
    if (!cleaned.trim()) throw new Error('empty')
    const live = await c.getDraft(sessionId)
    if (live !== snapshot) {
      tNotify('info', 'notify.draftChanged')
      st.phase = 'idle'
      onPhase('idle')
      return
    }
    st.backup = snapshot
    st.lastApplied = cleaned
    // SDK-only write: false/throw = no mounted surface claimed the address
    // (user switched away mid-call). Tell the user; never reach into the DOM.
    let applied = false
    try { applied = await c.setDraft(sessionId, cleaned) } catch { applied = false }
    if (!applied) {
      tNotify('info', 'notify.draftChanged')
      st.phase = 'idle'
      onPhase('idle')
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
    st.phase = 'idle'
    onPhase('idle')
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
    onPhase('idle')
    return
  }
  let applied = false
  try { applied = await c.setDraft(sessionId, st.backup) } catch { applied = false }
  if (!applied) tNotify('info', 'notify.revertStale')
  st.phase = 'idle'
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
  // Model pin (⌘+click picker): global value, this instance's tooltip mirrors
  // it via the listener set so every composer's button updates together.
  const metaGesture = useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pin, setPin] = useState(modelPin)
  useEffect(() => {
    const fn = (v) => setPin(v)
    pinListeners.add(fn)
    return () => pinListeners.delete(fn)
  }, [])
  const syncPhase = useCallback((p) => {
    const editor = resolveEditor(btnRef.current)
    if (editor) editorState(editor).phase = p
    if (p !== 'enhancing') setRetrying(false) // leaving enhancing clears retry flag
    setPhase(p)
  }, [])
  const syncRetry = useCallback(() => setRetrying(true), [])

  // Auto-reset: once enhanced, the enhanced state only stays valid while the
  // editor still HOLDS the enhanced text. Sending clears the editor
  // (use-composer-submit clearDraft) — so watch the editor and fall back to
  // idle the moment its content diverges (sent / edited / switched session).
  useLayoutEffect(() => {
    if (phase !== 'enhanced') return
    const btn = btnRef.current
    const editor = resolveEditor(btn)
    if (!editor) return
    const st = editorState(editor)
    // Read-only change-watch (send clears the draft, user edits mutate it):
    // any mutation re-reads the authoritative draft and drops to idle when it
    // diverges from what we applied. DOM is never written from here.
    const mo = new MutationObserver(() => {
      if (st.phase !== 'enhanced') return
      const c = sdkComposer()
      if (!c) return
      const btn = btnRef.current
      void c.getDraft(resolveSessionId(btn, () => host.state.activeSessionId.get())).then((live) => {
        if (st.phase !== 'enhanced') return
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
    // ⌘+click opens the model picker instead of enhancing (the DropdownMenu
    // trigger already toggled on pointerdown; the gesture's metaKey was
    // captured there and gates the onOpenChange below).
    if (e?.metaKey) return
    const editor = resolveEditor(btnRef.current)
    const st = editor ? editorState(editor) : null
    const current = st?.phase ?? phaseRef.current
    if (current === 'enhanced') void revert(btnRef.current, syncPhase)
    else if (current === 'enhancing') {
      // WorkBuddy parity: the spinning button is a cancel button. Bump THIS
      // editor's seq so its in-flight request's late result is discarded.
      if (st) st.seq++
      syncPhase('idle')
    } else runEnhance(btnRef.current, syncPhase, syncRetry)
  }

  // The pin that would route an enhance call right now (enabled + complete).
  const effPin = pin?.enabled && pin.provider && pin.model ? pin : null

  const tip = phase === 'enhancing'
    ? (retrying ? t('tip.retrying') : t('tip.enhancing'))
    : phase === 'enhanced' ? t('tip.revert')
    : effPin ? t('tip.pinned', `${effPin.provider}: ${effPin.model}`) : t('tip.idle')

  // The MENU is not ours: ModelCatalogMenu from the SDK is the same component
  // the composer's model pill renders (search, provider grouping, effort
  // submenu) — only the controller differs: our select() holds a detached
  // per-task pin instead of writing to a live session (kanban model-override
  // pattern). Effort/fast have no wire path on llm.oneshot, so the submenu is
  // inert (presetFor {} / setOptions no-op). The check mark follows the
  // EFFECTIVE pin only — a disabled pin must not look current.
  const menuController = {
    applyPreset: () => {},
    current: { effort: '', fast: false, model: effPin?.model ?? '', provider: effPin?.provider ?? '' },
    presetFor: () => ({}),
    // Picking a model is an act of intent: it also flips the toggle on.
    select: (model, provider) => { setModelPin({ enabled: true, model, provider }) }, // menu closes via ModelMenuCloseContext
    setOptions: () => {}
  }

  return jsx(DropdownMenu, {
    open: menuOpen,
    // Radix toggles on the trigger's pointerdown and only reports the desired
    // state here — no event. The gesture's metaKey was recorded capture-phase
    // (fires before Radix's bubble handler regardless of compose order), so a
    // plain click's open request is vetoed and only ⌘+click opens the picker.
    onOpenChange: (next) => {
      if (!next) return setMenuOpen(false)
      if (metaGesture.current) setMenuOpen(true)
    },
    children: [
      jsx(DropdownMenuTrigger, {
        key: 'trigger',
        asChild: true,
        children: jsx('span', {
          onPointerDownCapture: (e) => { metaGesture.current = Boolean(e.metaKey) },
          onKeyDownCapture: (e) => { metaGesture.current = Boolean(e.metaKey) },
          style: { display: 'inline-flex' },
          children: jsx(Tip, {
            label: tip,
            children: jsx(Button, {
              'aria-label': tip,
              [BTN_ATTR]: '',
              className: GHOST_ICON_BTN,
              disabled: false, // spinner is a cancel button while enhancing (WorkBuddy parity)
              onClick,
              ref: btnRef,
              size: 'icon',
              type: 'button',
              variant: 'ghost',
              children: phase === 'enhancing'
                ? jsx(Spinner, {})
                : jsx(Codicon, {
                    // The icon tracks the action available, not the event that
                    // just happened: once enhanced, the only thing this button
                    // can still do is go back to the original draft → return
                    // arrow, not a static done-marker.
                    name: phase === 'enhanced' ? 'discard' : 'sparkle',
                    size: '0.875rem'
                  })
            })
          })
        })
      }),
      jsx(DropdownMenuContent, {
        key: 'menu',
        align: 'end',
        side: 'top',
        sideOffset: 6,
        className: 'w-72 p-0',
        children: jsx(ModelMenuCloseContext.Provider, {
          value: () => setMenuOpen(false),
          children: jsx(ModelCatalogMenu, {
            controller: menuController,
            // Curation rows belong to the composer pill; our surface only
            // consumes the curated list (host showEditModels patch).
            showEditModels: false,
            // The toggle is OURS (rendered in the catalog's footer slot):
            // off = main model, on = the pinned pick above. Both rows
            // preventDefault so the menu stays open while toggling.
            footer: [
              jsx(DropdownMenuItem, {
                key: 'toggle',
                onSelect: (e) => e.preventDefault(),
                children: [
                  jsx(Codicon, { key: 'icon', name: 'sparkle', size: '0.75rem' }),
                  jsx('span', { key: 'label', style: { flex: 1, minWidth: 0 }, children: t('menu.custom') }),
                  jsx(SegmentedControl, {
                    key: 'seg',
                    onChange: (id) => setModelPin({ enabled: id === 'on' }),
                    options: [
                      { id: 'off', label: t('menu.off') },
                      { id: 'on', label: t('menu.on') }
                    ],
                    value: pin?.enabled ? 'on' : 'off'
                  })
                ]
              }),
              jsx(DropdownMenuItem, {
                key: 'status',
                disabled: true,
                onSelect: (e) => e.preventDefault(),
                children: jsx('span', {
                  style: {
                    color: 'var(--ui-text-tertiary)', display: 'block', fontSize: '0.68rem',
                    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                  },
                  children: !pin?.enabled
                    ? t('menu.statusMain')
                    : (effPin ? `${effPin.provider} · ${effPin.model}` : t('menu.statusPick'))
                })
              })
            ]
          })
        })
      })
    ]
  })
}

export default {
  id: ID,
  name: 'Prompt Enhancer',
  description: 'A composer ✨ button that rewrites a rough draft into a structured prompt (task / scope / constraints / output shape) and restores the original on a second click. ⌘+click picks a dedicated enhance model (toggleable; off = main model).',
  register(ctx) {
    const disposeI18n = ctx.i18n.register(LOCALES)
    ti18nStatic = ctx.i18n.t
    storageApi = ctx.storage
    modelPin = loadPin()
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
      storageApi = null
      pinListeners.clear()
    })
    console.error(`[prompt-enhancer] registered (M2) into ${COMPOSER_AREAS.actions}`)
  }
}
