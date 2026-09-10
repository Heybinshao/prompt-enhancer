/**
 * Prompt Enhancer — composer "enhance prompt" button for Hermes desktop.
 *
 * M1 core loop + layout fix.
 *   - read:  simplified composerPlainText replica (rich-editor.ts semantics)
 *   - write: DOM rebuild + native InputEvent → official flush mirrors to store
 *   - A1:    session/model inherited from closest [data-session-anchor]
 *   - A2:    write-back only when draft untouched during the wait
 *
 * Layout fix (stacked mode): the official controls cluster wraps itself in an
 * `ml-auto` div. Single-line the controls grid cell is `auto`-sized (no free
 * space → no visible gap); stacked it is `1fr` → the elastic ml-auto eats ALL
 * free space and orphanes our button at the cell's far left (next to "+").
 * Fix: inline-zero the sibling cluster's marginLeft and let the parent row's
 * own `justify-end` pack both right in every mode. Purely cosmetic inline
 * style; MutationObserver re-asserts after React remounts; disposed cleanly.
 */
import { COMPOSER_AREAS, Button, Codicon, Tip, PALETTE_AREA, atom, host, usePluginI18n, useValue } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useLayoutEffect, useRef } from 'react'

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

// ── pure:TDD-BEGIN ──
const RICH_INPUT_SLOT = 'composer-rich-input'

function serializeEditor(node) {
  if (node.nodeType === 3) return node.textContent || ''
  if (node.nodeType !== 1) return ''
  const el = node
  if (el.dataset && el.dataset.refText) return el.dataset.refText
  if (
    el.dataset && el.dataset.slot === RICH_INPUT_SLOT &&
    el.childNodes.length === 1 && el.firstChild && el.firstChild.nodeName === 'BR'
  ) return ''
  if (el.tagName === 'BR') return '\n'
  const text = Array.from(el.childNodes).map(serializeEditor).join('')
  const block = el.tagName === 'DIV' || el.tagName === 'P'
  return block && text && el.dataset.slot !== RICH_INPUT_SLOT ? text + '\n' : text
}

function editorChildOps(text) {
  const ops = []
  String(text).split('\n').forEach((line, index) => {
    if (index > 0) ops.push({ br: true })
    if (line) ops.push({ text: line })
  })
  return ops
}

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

const $phase = atom('idle') // idle | enhancing | enhanced
let enhanceBackup = ''
let lastApplied = ''

// ── i18n via official channel (v3 §3-⑩) ──
// ctx.i18n.register(LOCALES): nested tree, dot-path keys, interpolator fns.
// Components read via usePluginI18n(ID) (reactive on locale switch);
// non-React handlers use ctx.i18n.t captured at register time.
const LOCALES = {
  en: {
    tip: { idle: 'Enhance prompt', enhancing: 'Enhancing…', revert: 'Revert to original' },
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
      failed: (m) => `Enhance failed: ${m}`,
      dumped: 'DOM structure written to log',
      noBtn: 'Button not found'
    }
  },
  zh: {
    tip: { idle: '增强提示词', enhancing: '增强中…', revert: '恢复原文' },
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
      failed: (m) => `增强失败：${m}`,
      dumped: 'DOM 结构已写入日志',
      noBtn: '按钮未找到'
    }
  },
  'zh-hant': {
    tip: { idle: '增強提示詞', enhancing: '增強中…', revert: '恢復原文' },
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
      failed: (m) => `增強失敗：${m}`,
      dumped: 'DOM 結構已寫入日誌',
      noBtn: '按鈕未找到'
    }
  }
}

let ti18nStatic = null // captured at register; null before → zh fallback

function tNotify(kind, key, ...args) {
  const msg = ti18nStatic ? ti18nStatic(key, ...args) : null
  host.notify({ kind, message: msg ?? `[增强提示词] ${key}` })
}

function resolveEditor(btnEl) {
  const root = btnEl?.closest?.('[data-slot="composer-root"]')
  return root?.querySelector(`[data-slot="${RICH_INPUT_SLOT}"]`) ?? null
}

function writeBack(editor, text) {
  const frag = document.createDocumentFragment()
  for (const op of editorChildOps(text)) {
    if (op.br) frag.append(document.createElement('br'))
    else frag.append(document.createTextNode(op.text))
  }
  editor.replaceChildren(frag)
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  editor.dispatchEvent(new InputEvent('input', { bubbles: true }))
}

// Layout fix: zero the official cluster's ml-auto so the parent's justify-end
// packs [us, cluster] right in both inline and stacked modes.
function applyLayoutFix(btnEl) {
  const row = btnEl?.parentElement
  if (!row) return
  for (const sib of row.children) {
    if (sib !== btnEl && /\bml-auto\b/.test(String(sib.className))) {
      sib.style.marginLeft = '0'
    }
  }
}

function releaseLayoutFix(btnEl) {
  const row = btnEl?.parentElement
  if (!row) return
  for (const sib of row.children) {
    if (sib.style?.marginLeft === '0') sib.style.marginLeft = ''
  }
}

async function runEnhance(btnEl) {
  if ($phase.get() === 'enhancing') return
  const editor = resolveEditor(btnEl)
  if (!editor) return tNotify('error', 'notify.noEditor')
  if (!editor.isContentEditable) return tNotify('error', 'notify.notEditable')
  // Ref chips (@file:... etc) serialize to their literal command text and the
  // official renderer rebuilds them on write-back (REF_RE chipSpans) — so a
  // mixed draft is enhanceable: we protect the chip tokens in the template.
  const hasChips = editor.querySelector('[data-ref-text]') !== null
  const text = serializeEditor(editor)
  if (!text.trim()) {
    // Images/attachments alone (no text) land here — tell the user instead of
    // silently no-oping (v3 §1 said "no-op", user feedback corrected it).
    tNotify('info', 'notify.emptyDraft')
    return
  }
  if (text.length > MAX_INPUT_CHARS) return tNotify('error', 'notify.tooLong', text.length, MAX_INPUT_CHARS)
  // No live session (fresh chat, nothing sent yet) is FINE: llm.oneshot
  // natively falls back to the task backend when session_id is absent
  // (methods_session.py docstring). Just omit the field.
  const sessionId = resolveSessionId(btnEl, () => host.state.activeSessionId.get())

  const snapshot = text
  $phase.set('enhancing')
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
    if (sessionId) req.session_id = sessionId
    // host.request is hard-capped at the gateway default 30s
    // (DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS) — LLM generation routinely exceeds
    // it. getGateway().request takes timeoutMs as its 3rd arg: 3 minutes.
    const gw = host.getGateway()
    if (!gw) throw new Error('Hermes gateway unavailable')
    const res = await gw.request('llm.oneshot', req, 180_000)
    const cleaned = stripWrappingQuotes(String(res?.text ?? ''))
    if (!cleaned.trim()) throw new Error('empty')
    if (serializeEditor(editor) !== snapshot) {
      tNotify('info', 'notify.draftChanged')
      $phase.set('idle')
      return
    }
    enhanceBackup = snapshot
    lastApplied = cleaned
    writeBack(editor, cleaned)
    $phase.set('enhanced')
    if (looksTruncated(cleaned)) {
      tNotify('info', 'notify.truncated')
    }
  } catch (err) {
    console.error('[prompt-enhancer] enhance failed:', err)
    tNotify('error', 'notify.failed', err?.message ?? String(err))
    $phase.set('idle')
  }
}

function revert(btnEl) {
  const editor = resolveEditor(btnEl)
  if (!editor) {
    $phase.set('idle')
    return
  }
  if (serializeEditor(editor) !== lastApplied) {
    tNotify('info', 'notify.revertStale')
    $phase.set('idle')
    return
  }
  writeBack(editor, enhanceBackup)
  $phase.set('idle')
}

function EnhanceButton() {
  const phase = useValue($phase)
  const t = usePluginI18n(ID)
  const btnRef = useRef(null)

  // Auto-reset: once enhanced, the enhanced state only stays valid while the
  // editor still HOLDS the enhanced text. Sending clears the editor
  // (use-composer-submit clearDraft) — so watch the editor and fall back to
  // idle the moment its content diverges (sent / edited / switched session).
  useLayoutEffect(() => {
    if (phase !== 'enhanced') return
    const btn = btnRef.current
    const editor = resolveEditor(btn)
    if (!editor) return
    const mo = new MutationObserver(() => {
      if ($phase.get() !== 'enhanced') return
      if (serializeEditor(editor) !== lastApplied) {
        $phase.set('idle')
        enhanceBackup = ''
        lastApplied = ''
      }
    })
    mo.observe(editor, { childList: true, characterData: true, subtree: true })
    return () => mo.disconnect()
  }, [phase])

  // Layout fix lifecycle: apply now, re-assert when React remounts siblings,
  // release on unmount. Scoped to this button's own controls row.
  useLayoutEffect(() => {
    const btn = btnRef.current
    if (!btn) return
    applyLayoutFix(btn)
    const row = btn.parentElement
    const mo = new MutationObserver(() => applyLayoutFix(btn))
    if (row) mo.observe(row, { childList: true, subtree: false, attributes: true, attributeFilter: ['class'] })
    return () => {
      mo.disconnect()
      releaseLayoutFix(btn)
    }
  }, [])

  const onClick = () => {
    if (phase === 'enhanced') revert(btnRef.current)
    else runEnhance(btnRef.current)
  }

  const tip = phase === 'enhancing' ? t('tip.enhancing') : phase === 'enhanced' ? t('tip.revert') : t('tip.idle')

  return jsx(Tip, {
    label: tip,
    children: jsx(Button, {
      'aria-label': tip,
      [BTN_ATTR]: '',
      className: GHOST_ICON_BTN,
      disabled: phase === 'enhancing',
      onClick,
      ref: btnRef,
      size: 'icon',
      type: 'button',
      variant: 'ghost',
      children: jsx(Codicon, {
        name: phase === 'enhanced' ? 'sparkle-filled' : 'sparkle',
        size: '0.875rem',
        spinning: phase === 'enhancing'
      })
    })
  })
}

function dumpDom() {
  const btn = document.querySelector(`[${BTN_ATTR}]`)
  if (!btn) {
    tNotify('error', 'notify.noBtn')
    return
  }
  const lines = []
  let el = btn
  let depth = 0
  while (el && el !== document.body && depth < 14) {
    const cls = typeof el.className === 'string' ? el.className : ''
    const slot = el.getAttribute?.('data-slot') ?? ''
    lines.push(
      `${'  '.repeat(depth)}<${el.tagName?.toLowerCase()}> slot=${slot}` +
      `${cls.includes('grid-area') ? ' [GRID-AREA]' : ''}${cls.includes('justify-end') ? ' [j-END]' : ''}` +
      `${cls.includes('ml-auto') ? ' [ML-AUTO]' : ''} cls=${cls.slice(0, 110)}`
    )
    el = el.parentElement
    depth++
  }
  const parent = btn.parentElement
  if (parent) {
    lines.push('--- siblings of button (the controls row) ---')
    for (const s of parent.children) {
      const cs = getComputedStyle(s)
      lines.push(`  sib: <${s.tagName.toLowerCase()}> ml=${cs.marginLeft} cls=${String(s.className).slice(0, 90)}`)
    }
  }
  console.error(`[prompt-enhancer][DOM-DUMP]\n${lines.join('\n')}`)
  tNotify('info', 'notify.dumped')
}

export default {
  id: ID,
  name: 'Prompt Enhancer',
  register(ctx) {
    const disposeI18n = ctx.i18n.register(LOCALES)
    ti18nStatic = ctx.i18n.t

    ctx.register({
      id: 'enhance-button',
      area: COMPOSER_AREAS.actions,
      order: 100,
      render: () => jsx(EnhanceButton, {})
    })
    ctx.register({
      id: 'dom-dump',
      area: PALETTE_AREA,
      data: {
        id: 'dom-dump',
        label: 'Dump composer DOM (prompt-enhancer)',
        keywords: ['dump', 'composer', 'dom', 'debug', 'prompt'],
        run: dumpDom
      }
    })
    ctx.onDispose?.(() => {
      disposeI18n?.()
      $phase.set('idle')
      enhanceBackup = ''
      lastApplied = ''
      ti18nStatic = null
      document.querySelectorAll(`[${BTN_ATTR}]`).forEach(releaseLayoutFix)
    })
    console.error(`[prompt-enhancer] registered (M1+layoutfix) into ${COMPOSER_AREAS.actions}`)
  }
}
