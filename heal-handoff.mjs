// heal-handoff.mjs —— 「空回复自愈」的上一会话交接摘要构造器（2026-11-05 · 桥自愈-上下文交接）
//
// 为什么要有这个文件（实证故障，维护者 判「桥必须改」）：
//   飞书私聊 oc_<redacted> 的长会话（11-03 建、
//   当天 13 万字级设计讨论）在 11-05 14:08 被旧自愈逻辑判「本轮无产出」→ 直接从绑定里
//   splice 掉、新建空会话 fs-main-mw35addq ⇒ 整条上下文断线，新会话的 agent 完全看不到
//   之前讨论过什么，只能人工从磁盘会话文件里捞回来。
//   旧逻辑的止血是对的（用户不能拿到空回复），但止血方式把「历史」一起扔了。
//
// 关键判据（写在这里防止后人改回去）：
//   🔴 **只注入会话 id 是没用的**。新会话的 agent 读不到那个 id 对应的内容——它在
//      ~/.dsh/sessions/**/session.v4.jsonl.zstd 里，多条 zstd 帧拼接，Node 自带
//      `zstdDecompressSync` 只解首帧（见 index.js 里该 import 的用途）。所以交接必须是
//      **正文摘要**：旧会话 id ＋ 尾部 N 轮用户/助手正文 ＋ 因何重建。
//
// 纯逻辑、零依赖（只吃 sessionEvents 数组），不启桥即可单测：
//   node selftest-heal-handoff-20261105.mjs
//
// 口径（与 index.js 保持一致的地方）：
//   · 只取 text 块正文 —— assistant/message 里的 reasoning 块与 tool 调用事件**天然不进**
//     （它们不是 `{type:'text'}`），工具明细由 tool/call、tool/result 事件承载，也不在收范围内；
//   · 纯 🎯 目的行旁白不构成「正文」（与 index.js `isNarrationOnly` 同口径）；
//   · 投递前缀（`【日期锚】…` / `[飞书 姓名] `）与明细行（`【发送方】…`）是给人看的标记，
//     不占摘要；剥离正则由调用方传入（index.js 的 FOOTER_STRIP_RE 是唯一真源），
//     没传就只剥日期锚与 `[飞书 …]` 标签，绝不在这里另写一份措辞字面量。

export const HEAL_HANDOFF_ROUNDS = 6          // 默认取旧会话尾部 6 段正文（用户/助手混排计段）
export const HEAL_ENTRY_MAX_CHARS = 240       // 单段正文上限
export const HEAL_TOTAL_MAX_CHARS = 2400      // 摘要正文总量上限（整段前缀另有固定骨架，长度可控）

const DATE_ANCHOR_RE = /^【日期锚】[^\n]*\n/
const FEISHU_LABEL_RE = /^\[飞书[^\]]*\]\s*/

// content 数组 → 纯文本（只认 text 块：reasoning/工具块一律跳过）
function textOfContent (content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
    const t = block.text.trim()
    if (t) parts.push(t)
  }
  return parts.join('\n').trim()
}

// 纯目的行旁白（每行都以 🎯 开头）—— 那是过程旁白，不是对用户的正文。
function isNarrationOnly (text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return false
  return lines.every((line) => line.startsWith('🎯'))
}

// 剥掉桥自己加的投递前缀/明细行（不剥的话摘要里全是 `[飞书 用户] `、`【发送方】kind=…`）
function stripEnvelope (text, footerStripRe) {
  let t = String(text || '')
  t = t.replace(DATE_ANCHOR_RE, '').replace(FEISHU_LABEL_RE, '')
  if (footerStripRe instanceof RegExp) t = t.replace(footerStripRe, '')
  return t.trim()
}

function clip (text, maxChars) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > maxChars ? t.slice(0, maxChars) + '…' : t
}

// 事件流 → [{ role:'用户'|'助手', text }]
// 只收**真实对话**：user/message 的 source.kind 缺省或 'user'（goal 轮提示、subagent 回执、
// 桥内部合成轮这些插件注入不算对话正文，混进来只会把摘要冲淡）。
export function collectDialogTail (events, opts) {
  const o = opts || {}
  const footerStripRe = o.footerStripRe
  const out = []
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev.type !== 'string') continue
    if (ev.type === 'user/message') {
      // 两种事件结构都要兼容（宿主两代 session 接口的差异，见 index.js firstUserText 的注释）：
      //   · { type, data: { source, content:[{text}] } }
      //   · payload 就是 UserMessage 本体（不一定有 data 包装）
      const d = (ev.data && typeof ev.data === 'object') ? ev.data : ev
      const src = (d && d.source) || {}
      if (src.kind && src.kind !== 'user') continue
      const text = stripEnvelope(textOfContent(d.content || (d.message && d.message.content)), footerStripRe)
      if (text) out.push({ role: '用户', text })
    } else if (ev.type === 'assistant/message') {
      const text = textOfContent(ev.data && ev.data.message && ev.data.message.content)
      if (!text || isNarrationOnly(text)) continue
      out.push({ role: '助手', text })
    }
  }
  // 末尾「还没得到回答的用户消息」＝本轮这条（本轮零产出）⇒ 剔除，否则同一句话会在新会话里
  // 出现两次（一次在摘要里、一次在真正的消息正文里）。
  while (out.length > 0 && out[out.length - 1].role === '用户') out.pop()
  return out
}

// 取尾部若干段并压总量（从新往旧累加，超预算就停）
export function tailWithinBudget (entries, opts) {
  const o = opts || {}
  const rounds = Number.isFinite(o.rounds) && o.rounds > 0 ? Math.floor(o.rounds) : HEAL_HANDOFF_ROUNDS
  const maxEntry = Number.isFinite(o.maxEntryChars) && o.maxEntryChars > 0 ? o.maxEntryChars : HEAL_ENTRY_MAX_CHARS
  const maxTotal = Number.isFinite(o.maxTotalChars) && o.maxTotalChars > 0 ? o.maxTotalChars : HEAL_TOTAL_MAX_CHARS
  const picked = []
  let used = 0
  const list = Array.isArray(entries) ? entries : []
  for (let i = list.length - 1; i >= 0 && picked.length < rounds; i--) {
    const one = list[i]
    const text = clip(one && one.text, maxEntry)
    if (!text) continue
    if (used + text.length > maxTotal) break
    used += text.length
    picked.unshift({ role: String((one && one.role) || '?'), text })
  }
  return picked
}

// 生成注入新会话首条消息的交接前缀（结尾自带两个换行，直接拼在消息最前面）。
//   oldSessionId：旧会话 id（必须带 —— 人要靠它 /switch 切回、日志要靠它溯源）
//   reason      ：因何重建（人话；调用方已按档位闸处理过原文）
//   events      ：旧会话的事件流（sessionEvents(agent.session)）
export function buildHealHandoff (opts) {
  const o = opts || {}
  const oldId = String(o.oldSessionId || '').trim() || '（未知）'
  const reason = String(o.reason || '').trim() || '旧会话本轮没有产出（上游未上报失败标记）'
  const picked = tailWithinBudget(collectDialogTail(o.events, o), o)
  const lines = []
  lines.push('【上一会话交接｜桥自动新建，以下为历史摘录，不是用户的新指令】')
  // keptInBinding 决定「旧条目还在不在绑定里」这句——不能一律写「仍保留」：
  //   ① 自愈重建 / 重启后不可恢复的 fallback ⇒ 旧条目确实还 push 在 chat.sessions（真话）；
  //   ② loadChats 按世代丢弃的 legacy 会话 ⇒ 条目已被过滤掉，再说「/switch 可切回」就是骗人
  //      （A18 禁编造兜底：话术必须与实际状态一致）。
  lines.push('· 旧会话：' + oldId + (o.keptInBinding === false
    ? '（已换到本会话继续；旧条目没有保留在绑定里——属上一代格式或已被清理，需要时请让用户补一句背景）'
    : '（已换到本会话继续；旧会话仍保留在绑定里，需要时可 /switch 切回）'))
  lines.push('· 重建原因：' + reason)
  if (picked.length > 0) {
    lines.push('· 旧会话最后 ' + picked.length + ' 段对话正文（用户＋助手，已跳过思考过程与工具明细）：')
    lines.push('')
    for (const one of picked) lines.push('[' + one.role + '] ' + one.text)
  } else {
    lines.push('· 旧会话正文没能取到（事件流为空或全部被裁剪）——必要时请让用户补一句背景。')
  }
  lines.push('')
  lines.push('（以上是历史上下文，供你和用户接着旧话题往下聊；用户的新消息在下面。）')
  return lines.join('\n') + '\n\n'
}
