// dsh-feishucard — host plugin (node half), self-developed.
// Bridges Feishu (Lark) chats with dedicated per-chat DeepSeek Harness agent
// sessions via the official SDK long connection (helper.cjs subprocess per
// bot), with /new /switch /list /help commands, a typing reaction, and a
// streaming reply card: one card per turn, PATCH-updated as the agent works
// (inline agent notes + collapsible tool-call panels), sealed with the final
// reply. Reliability: serialized sync queue, rate-limit coalescing,
// exponential backoff, circuit breaker, and a plain-text fallback when the
// card pipeline dies.
//
// Config: ~/.dsh-feishucard/feishu.config.json  ({ bots: [...] }).
// State:  ~/.dsh-feishucard/state-<appId>.json  (per-bot chat/session map).
// A one-time migration copies a legacy config from ~/.cc-connect if present.

import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'feishu-stream'

export const inject = ['shell', 'fs', 'agents', 'timer', 'webServer', 'tools']

const HELPER_PATH = fileURLToPath(new URL('./helper.cjs', import.meta.url))

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const CARD_MIN_INTERVAL = 400        // ms between card syncs (rate limit)
const CARD_RETRY_BASE = 1000         // backoff base (exponential)
const CARD_MAX_FAILURES = 5          // consecutive failures before breaker
const CARD_TIMEOUT = 15000           // single card request timeout
const CARD_POLL_INTERVAL = 300       // agent event poll interval
const SESSION_GEN = 2                // session-state schema gen; gen<2 sessions predate the standard-preset mount and never saw file/shell tools
const DRAIN_INTERVAL = 500           // helper stdout drain interval
const CONFIG_REFRESH_MS = 10000      // config hot-reload cadence
const STATUS_INTERVAL = 10000        // helper status line cadence

export function apply(ctx) {
  if (globalThis.__dshFeishucardApplyCount === undefined) globalThis.__dshFeishucardApplyCount = 0
  globalThis.__dshFeishucardApplyCount += 1
  console.log('[fs] plugin apply #' + globalThis.__dshFeishucardApplyCount + ' @ ' + new Date().toISOString())
  let stopping = false
  let lastConfigCheck = 0
  let lastSpawnAt = 0
  const bots = new Map()             // appId -> Bot runtime

  // Agent -> live streaming-card context of its current turn. Lets the
  // ask_user_question flow freeze the *old* card (the one sitting above the
  // question card) and hand the agent's post-answer narration to a *new*
  // card below it — otherwise updates land on the stale card the user can no
  // longer see (2026-09-08 CM report).
  const activeTurns = new Map()         // agentId -> { card, bot, chatId, split }

  // 找出某个会话当前正在跑的、还没封口的卡片（用于让 feishu_send 知道"这个对话正在被回复"）。
  // 2026-09-15：agent 在活跃对话里调 feishu_send 会另发一条消息，与卡片里的回复重复
  //（CM 反馈"同一段东西分两个卡片发"）——有活跃卡时应当跳过。
  function findActiveCardForChat(chatId) {
    if (!chatId) return null
    for (const entry of activeTurns.values()) {
      if (entry && entry.chatId === chatId && entry.card && entry.card.status !== 'sealed') return entry
    }
    return null
  }

  // ---- config -------------------------------------------------------------
  // Config/state live under ~/.dsh-feishucard by default; FS_CONFIG_DIR
  // overrides the base directory (used by tests, and for multi-profile
  // setups).
  const configDir = () => process.env.FS_CONFIG_DIR || join(homedir(), '.dsh-feishucard')
  const configPath = () => join(configDir(), 'feishu.config.json')
  const statePathFor = (appId) => join(
    configDir(), 'state-' + String(appId).replace(/[^a-zA-Z0-9]/g, '') + '.json',
  )

  // One-time migration: if our own config dir has no config yet but the
  // legacy ecosystem path (~/.cc-connect, used by the third-party plugin we
  // replaced) has one, copy it over so users keep their bots without
  // re-entering credentials. Runs once at boot.
  function migrateLegacyConfig() {
    try {
      const own = configPath()
      if (existsSync(own)) return
      const legacy = join(homedir(), '.cc-connect', 'feishu.config.json')
      if (!existsSync(legacy)) return
      mkdirSync(configDir(), { recursive: true })
      writeFileSync(own, readFileSync(legacy, 'utf8'))
      console.log('[fs] migrated config from legacy ' + legacy + ' to ' + own)
    } catch (error) {
      console.log('[fs] legacy config migration skipped: ' + String(error && error.message || error))
    }
  }
  migrateLegacyConfig()

  const workspaceRoot = () => {
    const sp = ctx.get('sandboxPolicy')
    return sp && typeof sp.workspaceRoot === 'string' ? sp.workspaceRoot : undefined
  }

  // Accept { bots: [...] } and the legacy single-bot object shape.
  function normalizeConfig(raw) {
    const value = raw && typeof raw === 'object' ? raw : {}
    let list = Array.isArray(value.bots) ? value.bots : []
    if (list.length === 0 && typeof value.appId === 'string' && value.appId) {
      list = [value]
    }
    const cleaned = []
    for (const bot of list) {
      if (!bot || typeof bot !== 'object') continue
      const appId = typeof bot.appId === 'string' ? bot.appId.trim() : ''
      if (!appId) continue
      cleaned.push({
        name: typeof bot.name === 'string' && bot.name.trim() ? bot.name.trim() : appId,
        workspace: typeof bot.workspace === 'string' ? bot.workspace : '',
        fileInbox: typeof bot.fileInbox === 'string' ? bot.fileInbox.trim() : '',
        appId,
        appSecret: typeof bot.appSecret === 'string' ? bot.appSecret : '',
        reactionEmoji: typeof bot.reactionEmoji === 'string' ? bot.reactionEmoji : undefined,
        ownerOpenId: typeof bot.ownerOpenId === 'string' ? bot.ownerOpenId : '',
        // 2026-09-16：目标模式（goal round）过程卡开关；未设置=开（可用环境变量全局关）
        notifyGoalRounds: typeof bot.notifyGoalRounds === 'boolean' ? bot.notifyGoalRounds : undefined,
      })
    }
    return cleaned
  }

  async function readConfig() {
    try {
      const target = configPath()
      if (!existsSync(target)) return []
      return normalizeConfig(JSON.parse(readFileSync(target, 'utf8')))
    } catch {
      return []
    }
  }

  function readState(appId) {
    try {
      const target = statePathFor(appId)
      if (!existsSync(target)) return { chats: {} }
      const parsed = JSON.parse(readFileSync(target, 'utf8'))
      return parsed && typeof parsed === 'object' && parsed.chats ? parsed : { chats: {} }
    } catch {
      return { chats: {} }
    }
  }

  function writeState(appId, state) {
    try {
      mkdirSync(configDir(), { recursive: true })
      writeFileSync(statePathFor(appId), JSON.stringify(state, null, 2))
    } catch (error) {
      console.log('[fs] state save failed: ' + String(error && error.message || error))
    }
  }

  // ---- outbound HTTP -------------------------------------------------------
  async function httpJson(url, method, headers, body, signal) {
    try {
      const response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      })
      const text = await response.text()
      return { status: response.status, text }
    } catch (error) {
      return { status: 0, text: String(error && error.message || error) }
    }
  }

  function parseJson(text) {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }

  // ---- Feishu REST ---------------------------------------------------------
  async function tenantAccessToken(bot, appId, appSecret) {
    const now = Date.now()
    if (bot.token && bot.tokenExpiresAt > now + 60000) return bot.token
    const res = await httpJson(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      'POST',
      { 'Content-Type': 'application/json' },
      { app_id: appId, app_secret: appSecret },
    )
    const parsed = parseJson(res.text)
    if (parsed && parsed.code === 0 && typeof parsed.tenant_access_token === 'string') {
      bot.token = parsed.tenant_access_token
      bot.tokenExpiresAt = now + (Number(parsed.expire) || 7200) * 1000
      return bot.token
    }
    throw new Error('tenant_access_token failed: ' + (res.text || JSON.stringify(res)))
  }

  async function sendInteractive(bot, chatId, payload, signal) {
    const accessToken = await tenantAccessToken(bot, bot.cfg.appId, bot.cfg.appSecret)
    const res = await httpJson(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      'POST',
      { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
      { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(payload) },
      signal,
    )
    const parsed = parseJson(res.text)
    if (!(res.status >= 200 && res.status < 300) || !parsed || parsed.code !== 0) {
      throw new Error('create card failed: ' + (res.text || JSON.stringify(res)))
    }
    return parsed.data && parsed.data.message_id
  }

  async function updateInteractive(bot, messageId, payload, signal) {
    const accessToken = await tenantAccessToken(bot, bot.cfg.appId, bot.cfg.appSecret)
    const res = await httpJson(
      'https://open.feishu.cn/open-apis/im/v1/messages/' + encodeURIComponent(messageId),
      'PATCH',
      { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
      { msg_type: 'interactive', content: JSON.stringify(payload) },
      signal,
    )
    const parsed = parseJson(res.text)
    if (!(res.status >= 200 && res.status < 300) || !parsed || parsed.code !== 0) {
      throw new Error('update card failed: ' + (res.text || JSON.stringify(res)))
    }
  }

  async function sendPlainText(bot, chatId, text) {
    const cfg = bot.cfg
    const hasCreds = typeof cfg.appId === 'string' && cfg.appId
      && typeof cfg.appSecret === 'string' && cfg.appSecret
    if (!hasCreds) return { status: 0, text: '未配置 appId/appSecret（~/.dsh-feishucard/feishu.config.json）' }
    const target = chatId || bot.lastChatId || ''
    let receiveIdType = 'chat_id'
    if (!target) {
      if (!cfg.ownerOpenId) return { status: 0, text: '没有可用的 chat_id：先给机器人发条消息，或配置 ownerOpenId' }
      receiveIdType = 'open_id'
    }
    const card = {
      config: { wide_screen_mode: true },
      elements: [{ tag: 'markdown', content: text }],
    }
    const res = await httpJson(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=' + receiveIdType,
      'POST',
      { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await tenantAccessToken(bot, cfg.appId, cfg.appSecret) },
      { receive_id: target || cfg.ownerOpenId, msg_type: 'interactive', content: JSON.stringify(card) },
    )
    return res
  }

  async function addReaction(bot, messageId, emoji) {
    const accessToken = await tenantAccessToken(bot, bot.cfg.appId, bot.cfg.appSecret)
    const res = await httpJson(
      'https://open.feishu.cn/open-apis/im/v1/messages/' + encodeURIComponent(messageId) + '/reactions',
      'POST',
      { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
      { reaction_type: { emoji_type: emoji } },
    )
    const parsed = parseJson(res.text)
    if (!(res.status >= 200 && res.status < 300) || !parsed || parsed.code !== 0) {
      throw new Error('reaction create failed: ' + (res.text || JSON.stringify(res)))
    }
    return parsed.data && parsed.data.reaction_id ? { reaction_id: parsed.data.reaction_id } : {}
  }

  async function removeReaction(bot, messageId, reactionId) {
    const accessToken = await tenantAccessToken(bot, bot.cfg.appId, bot.cfg.appSecret)
    return httpJson(
      'https://open.feishu.cn/open-apis/im/v1/messages/' + encodeURIComponent(messageId)
        + '/reactions/' + encodeURIComponent(reactionId),
      'DELETE',
      { Authorization: 'Bearer ' + accessToken },
      undefined,
    )
  }

  // ---- streaming card state machine ---------------------------------------
  function makeCardState() {
    return {
      token: '',           // message id; '' => create, else PATCH
      blocks: [],          // [{type:'message'|'note',text,seq?} | {type:'tools',toolIds:[]}]
      tools: new Map(),    // callId -> {name,args,status,error}
      status: 'running',   // running | completed | error | sealed
      lastSyncAt: 0,
      failCount: 0,
      circuitOpen: false,
      retryUntil: 0,
      queue: Promise.resolve(),
      // 2026-09-15 修复：一卡一游标 + 已消费事件去重。
      // 旧实现的 seal 前补扫用 `{from: seqBefore}`（本轮起点）重放整轮，而 appendNote 无去重
      // → split 之后新卡会把 split 前的内容再写一遍、split 后的内容写两遍
      //   （CM 反馈的"同一段东西分两个卡片发、内容大量重复"）。
      cursor: 0,           // 本卡已消费到的事件下标（== seq）
      seenSeqs: new Set(), // 已写入卡片的 assistant/message seq（防重放重复）
      createFailed: false, // 建卡失败过 → 不再重复建卡（防超时导致的孤儿卡与多张卡）
      // 2026-09-16：诚实状态用。lastEventAt = 上次有新事件的时刻；idleMinutes = 已静默分钟数（0=正常）
      lastEventAt: Date.now(),
      idleMinutes: 0,
    }
  }

  // Short arg summary for a tool line (picks the most informative fields).
  function toolArgSummary(argsJson) {
    let obj
    try { obj = JSON.parse(argsJson || '{}') } catch { return '' }
    const picks = []
    for (const key of ['path', 'file_path', 'pattern', 'query', 'command', 'url', 'name', 'message', 'file', 'prompt']) {
      const v = obj[key]
      if (v !== undefined && v !== null && typeof v !== 'object' && typeof v !== 'boolean') {
        picks.push(String(v))
        if (picks.length >= 2) break
      }
    }
    // 2026-09-16 修复：此处曾被误插入一行 `if (cmd && EGRESS_CMD_RE.test(cmd)) ...`
    // （从 approvalReasonFor 里抄过来的"联网/外发命令"判断），但本函数作用域内没有 cmd，
    // 且该插入同时删掉了 `const joined = ...` 一行 → 本函数**每次调用必抛
    // ReferenceError: cmd is not defined**，导致卡片工具面板构建失败、
    // 流式更新整条链路崩掉，只能退化成最后一条纯文本回复（CM 反馈"隔很久才回、看不到进度"）。
    // 现按 git 历史（5c800e5 等提交）还原为已知正确实现；"联网/外发命令"提示由
    // approvalReasonFor（第 ~1868 行，那里的 cmd 有正确定义）负责，职责不重复。
    const joined = picks.join(' ').replace(/\s+/g, ' ').trim()
    return joined.length > 80 ? joined.slice(0, 80) + '…' : joined
  }

  // First error/result text inside a tool/result message.
  function toolResultText(message) {
    if (!message || !Array.isArray(message.content)) return ''
    const block = message.content[0]
    const inner = block && block.content
    if (!inner || !Array.isArray(inner)) return ''
    for (const c of inner) {
      if (c && c.type === 'text' && typeof c.text === 'string') {
        const t = c.text.trim()
        if (t) return t
      }
    }
    return ''
  }

  // Agent spoken words (text blocks of assistant/message) — the "process
  // narration" shown inline on the card; reasoning blocks are NOT pushed.
  function extractProcessText(message) {
    if (!message || !Array.isArray(message.content)) return ''
    const parts = []
    for (const block of message.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        const t = block.text.trim()
        if (t) parts.push(t)
      }
    }
    return parts.join('\n').trim()
  }

  const MAX_NOTE_CHARS = 500

  // 截断过程话语时**不能把表格切断**（2026-09-16 与 CM 的"表格只显示竖线"排查一并处理）：
  // markdown 表格必须是「表头行 + 分隔行 + 数据行」连续成块才会被飞书渲染成表格；
  // 原实现直接 `slice(0, 500) + '…'`，一旦截断点落在表格中间，就可能只剩表头没有分隔行
  // → 飞书判定不是表格 → 原样显示竖线（CM 看到的现象之一）。
  // 处理：先退到整行边界；若末尾还停留在表格行上，把这个不完整的表格整块丢掉。
  function clipNoteText(text, max) {
    const s = String(text || '')
    if (s.length <= max) return s
    let cut = s.slice(0, max)
    const nl = cut.lastIndexOf('\n')
    if (nl > 0) cut = cut.slice(0, nl)
    const lines = cut.split('\n')
    while (lines.length && /^\s*\|.*\|\s*$/.test(lines[lines.length - 1])) lines.pop()
    return lines.join('\n').replace(/\s+$/, '') + '…'
  }

  function appendNote(card, text, seq) {
    const trimmed = String(text || '').trim()
    if (!trimmed) return
    // 同一 seq 只写一次：补扫与 watcher 会扫到重叠区间，旧实现没有去重 → 卡上出现重复段落
    // （2026-09-15 CM 反馈"内容大量重复"）。
    if (seq !== undefined && seq !== null) {
      if (!card.seenSeqs) card.seenSeqs = new Set()
      if (card.seenSeqs.has(seq)) return
      card.seenSeqs.add(seq)
    }
    const clipped = clipNoteText(trimmed, MAX_NOTE_CHARS)
    card.blocks.push({ type: 'note', text: clipped, seq })
  }

  function formatToolLine(tool) {
    const symbol = tool.status === 'completed' ? '✅'
      : tool.status === 'failed' ? '❌'
      : tool.status === 'denied' ? '🔒'
      : '⏳'
    const arg = toolArgSummary(tool.args)
    const head = tool.name + (arg ? ' `' + arg + '`' : '')
    let line = '- ' + symbol + ' · ' + head
    if (tool.status === 'failed' && tool.error) {
      line += ' · ' + String(tool.error).slice(0, 100)
    }
    return line
  }

  // Dedupe then merge into the trailing tools block (or start a new one).
  function appendTool(card, toolId) {
    for (const b of card.blocks) {
      if (b.type === 'tools' && b.toolIds.includes(toolId)) return
    }
    const last = card.blocks[card.blocks.length - 1]
    if (last && last.type === 'tools') {
      last.toolIds.push(toolId)
      return
    }
    card.blocks.push({ type: 'tools', toolIds: [toolId] })
  }

  // Card payload: notes as markdown blocks, tool panels collapsed by default,
  // a bottom status line until sealed. Elements capped (Feishu limit 50,
  // keep headroom at 40), overflow folded into one "更多过程" panel.
  // Card payload: notes as markdown blocks, tool panels collapsed by default,
  // a bottom status line until sealed. Elements capped (Feishu limit 50,
  // keep headroom at 40), overflow folded into one "更多过程" panel.

  // 正文 → 元素列表：**长代码块折成默认收起的面板**，短代码块保持原样渲染。
  // 阈值与 Hermes 侧一致（>8 行 或 >600 字符），行为可预期；未闭合围栏自动补全。
  const CODE_MAX_LINES = 8
  const CODE_MAX_CHARS = 600
  const CODE_FENCE_RE = /```(\w*)\n([\s\S]*?)```/g

  function renderMessageElements(text) {
    let src = String(text || '')
    if ((src.match(/```/g) || []).length % 2 === 1) {
      // 流式片段可能把围栏切开：奇数个 ``` → 补一个，避免飞书渲染错乱
      src = src.trim().endsWith('```') && !src.trim().startsWith('```')
        ? '```\n' + src
        : src + '\n```'
    }
    const out = []
    let pos = 0
    CODE_FENCE_RE.lastIndex = 0
    let m
    while ((m = CODE_FENCE_RE.exec(src)) !== null) {
      const before = src.slice(pos, m.index)
      if (before.trim()) out.push({ tag: 'markdown', content: before })
      const lang = m[1] || 'code'
      const code = m[2]
      const lines = code.split('\n').length
      if (lines > CODE_MAX_LINES || code.length > CODE_MAX_CHARS) {
        out.push({
          tag: 'collapsible_panel',
          expanded: false,
          background_color: 'grey-50',
          border: { color: 'grey', corner_radius: '8px' },
          header: { title: { tag: 'plain_text', content: lang + ' · ' + lines + ' 行 · 点击展开' } },
          elements: [{ tag: 'markdown', content: '```' + lang + '\n' + code + '```' }],
        })
      } else {
        out.push({ tag: 'markdown', content: m[0] })
      }
      pos = m.index + m[0].length
    }
    const tail = src.slice(pos)
    if (tail.trim()) out.push({ tag: 'markdown', content: tail })
    return out.length ? out : [{ tag: 'markdown', content: src }]
  }

  // ---- 折叠/容量：两个机制必须自洽（2026-09-16 从 Hermes 侧同步的两个修复）---------
  // ① 每个「更早过程」面板的正文上限：内容超过它就**多切一块面板**，绝不截断丢弃。
  const FOLD_CHUNK_CHARS = 3000
  // ② 单卡 markdown 表格数上限：飞书官方硬上限 5（《表格组件》），超出报
  //    `ErrCode 11310 / card table number over limit`。Hermes 侧 2026-09-15 实测
  //    单日 22 次 11310 **全部**来自这一条 —— 而 DSH 此前**完全没有表格防护**。
  const CARD_MAX_TABLES = 5

  // 把长文本按段落边界切成 ≤ size 的块；单段本身超长则硬切。**不丢任何字符。**
  function chunkText(text, size) {
    const out = []
    let buf = ''
    for (const para of String(text || '').split('\n\n')) {
      const piece = buf ? buf + '\n\n' + para : para
      if (piece.length <= size) { buf = piece; continue }
      if (buf) { out.push(buf); buf = '' }
      let rest = para
      while (rest.length > size) { out.push(rest.slice(0, size)); rest = rest.slice(size) }
      buf = rest
    }
    if (buf) out.push(buf)
    return out.filter((c) => c.trim())
  }

  // 一段 markdown 里有几张表（连续 |...| 行算一张）
  // **必须跳过 ``` 代码块**：代码块里的 `| a | b |` 是普通文本，飞书不算表格组件
  // （否则"把超限表格降级成代码块"会被自己重新数进去，降级永远不生效 —— 实测踩过）。
  function countMarkdownTables(text) {
    let count = 0
    let prev = false
    let inFence = false
    for (const line of String(text || '').split('\n')) {
      if (/^\s*```/.test(line)) { inFence = !inFence; prev = false; continue }
      const row = !inFence && /^\s*\|.*\|\s*$/.test(line)
      if (row && !prev) count += 1
      prev = row
    }
    return count
  }

  // 把一行 markdown 表格行拆成单元格数组：'| a | b |' → ['a','b']
  function splitTableRow(line) {
    let s = String(line || '').trim()
    if (s.startsWith('|')) s = s.slice(1)
    if (s.endsWith('|')) s = s.slice(0, -1)
    return s.split('|').map((c) => c.trim())
  }
  // 把 markdown 表格行转成**可读清单**（降级用）：
  // CM 2026-09-16 反馈"超出限额后表格只剩一堆 | 符号" —— 旧的降级方式是包成 ``` 代码块，
  // 代码块里就是原始竖线，纯属把问题换个地方展示。
  // 现在改成 `- **列名**：值 ｜ **列名**：值`，人一眼能读，且一个字符都不丢。
  function demoteTableToLines(rows) {
    const cells = rows.map(splitTableRow).filter((c) => c.length > 0)
    if (cells.length === 0) return rows
    const header = cells[0]
    // 第 2 行若是分隔行（全是 --- / :--:）则跳过
    const isSep = (c) => c.every((x) => /^:?-{1,}:?$/.test(x.replace(/\s/g, '')))
    const body = cells.slice(1).filter((c, i) => !(i === 0 && isSep(c)))
    if (body.length === 0) return rows
    const out = ['*（表格超出飞书单卡上限，已转为清单，内容不变）*']
    for (const c of body) {
      const parts = header.map((h, i) => {
        const v = (c[i] === undefined || c[i] === '') ? '—' : c[i]
        return (h ? '**' + h + '**：' : '') + v
      })
      out.push('- ' + parts.join('　｜　'))
    }
    return out
  }

  // 把文本里"超出配额"的表格降级（保持行序与内容，一个字符都不丢）。
  // 为什么必须这么做：**折叠降低不了表格数**（折叠只是把同样的文本挪进面板），
  // 所以超限时只能改渲染方式，不能删内容。
  function demoteTablesInText(text, shouldDemote) {
    const out = []
    let table = []
    let inFence = false
    const flush = () => {
      if (!table.length) return
      if (shouldDemote()) out.push(...demoteTableToLines(table))
      else out.push(...table)
      table = []
    }
    for (const line of String(text || '').split('\n')) {
      if (/^\s*```/.test(line)) inFence = !inFence
      if (!inFence && /^\s*\|.*\|\s*$/.test(line)) { table.push(line); continue }
      flush()
      out.push(line)
    }
    flush()
    return out.join('\n')
  }

  // 卡片级表格配额：按元素顺序，第 6 张起的表格降级成可读清单（不再用代码块）
  function demoteOverflowTables(elements, max) {
    let used = 0
    for (const el of elements) {
      const targets = el && el.tag === 'markdown' ? [el]
        : (el && el.tag === 'collapsible_panel' ? (el.elements || []) : [])
      for (const t of targets) {
        if (!t || t.tag !== 'markdown' || !t.content) continue
        if (countMarkdownTables(t.content) === 0) continue
        t.content = demoteTablesInText(t.content, () => (++used > max))
      }
    }
    return elements
  }

  // 本卡**当前累计**的 markdown 表格数 —— 「表格额度换卡」的判定依据（CM 2026-09-16 方案）。
  // 为什么按 message 块数、而不是数渲染后的 elements：换卡判定发生在扫描新事件**之前**，
  // 此时还没生成 elements；而 buildCardPayload 里各 message 块是各自独立渲染的，
  // 表格总数 = 各块表格数之和（代码块内的 `|` 不算，已有 countMarkdownTables 处理）。
  function cardTableCount(card) {
    let n = 0
    for (const block of (card && card.blocks) || []) {
      // 必须同时数 message 与 note：agent 的过程话语走 appendNote 存成 `type: 'note'`，
      // 最终回复才会被提升成 `type: 'message'`。只数 message 会让判定永远不触发
      // （2026-09-16 实测：用例 12 换卡不生效，create 次数停在 1）。
      if (block.type !== 'message' && block.type !== 'note') continue
      if (!block.text) continue
      n += countMarkdownTables(block.text)
    }
    return n
  }

  // ---- 状态行（2026-09-16 与 Hermes 对齐：状态必须真实）---------------------------
  // 原实现两个毛病：
  //   ① `completed` 是**死状态** —— 全文件从未赋值 → 「已完成」分支永不执行；
  //   ② `sealed` 时**直接把状态行删掉** → 回合结束后用户看不出"这轮结束了没有"。
  // 另加一条诚实提示：长时间无新事件 → 写明"已 N 分钟无新动作"，不用假状态糊弄。
  const DSH_IDLE_NOTICE_MIN = 3      // 无新事件多少分钟后提示
  function statusTextFor(card) {
    if (card.status === 'sealed') return '_✅ 已完成_'
    if (card.status === 'completed') return '_已完成_'
    if (card.status === 'error') return '_失败_'
    if (card.idleMinutes > 0) return '_运行中…（已 ' + card.idleMinutes + ' 分钟无新动作）_'
    return '_运行中…_'
  }

  function buildCardPayload(card) {
    const elements = []
    console.log('[fs] buildCardPayload: blocks=' + card.blocks.length
      + ' notes=' + card.blocks.filter((b) => b.type === 'note').length
      + ' tools=' + card.tools.size)
    for (const block of card.blocks) {
      if (block.type === 'message' || block.type === 'note') {
        const text = (block.text || '').trim()
        // 2026-09-15：正文里的长代码块也折起来（移植 Hermes 的 message_elements 思路）。
        // 旧实现平铺 markdown → 回复里的 ``` 代码框、命令全文全部摊在卡片上，
        // 用户看到的"只有工具面板折叠、其余代码框全展示"就是这个（DSH 侧没有正文折叠）。
        if (text) elements.push(...renderMessageElements(text))
        continue
      }
      if (block.type === 'tools') {
        const lines = []
        for (const id of block.toolIds) {
          const tool = card.tools.get(id)
          if (tool) lines.push(formatToolLine(tool))
        }
        if (lines.length === 0) continue
        elements.push({
          tag: 'collapsible_panel',
          expanded: false,
          background_color: 'grey-50',
          border: { color: 'grey', corner_radius: '8px' },
          padding: '8px 8px 8px 8px',
          header: {
            title: { tag: 'plain_text', content: '🛠️ 工具调用 (' + lines.length + ')' },
            vertical_align: 'center',
            padding: '8px 8px 8px 8px',
            icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '16px 16px' },
            icon_position: 'right',
            icon_expanded_angle: -180,
          },
          elements: [{ tag: 'markdown', content: lines.join('\n') }],
        })
      }
    }
    // 表格配额：飞书单卡最多 5 张表，超出的改成代码块（**不删内容**）。
    // 必须在折叠之前做 —— 折叠把文本挪进面板并不会减少表格数。
    demoteOverflowTables(elements, CARD_MAX_TABLES)

    // Window fold: keep the NEWEST content visible (live progress + conclusion
    // at the bottom), fold the ALREADY-SEEN history into panel(s) at the TOP.
    // The last KEEP_TAIL elements are never folded (2026-08-15 CM design).
    if (elements.length > 40) {
      const KEEP_TAIL = 10
      const head = elements.slice(0, elements.length - KEEP_TAIL)
      const tail = elements.slice(elements.length - KEEP_TAIL)
      const extraLines = []
      for (const el of head) {
        if (el.tag === 'markdown') {
          if (el.content) extraLines.push(el.content)
        } else {
          const inner = el.elements && el.elements[0]
          if (inner && inner.tag === 'markdown' && inner.content) extraLines.push(inner.content)
        }
      }
      if (extraLines.length > 0) {
        // **无损折叠（2026-09-16 修复）**：旧实现是
        //   `extraLines.join('\n\n').slice(0, 3000)` —— 把折叠正文硬砍到 3000 字、
        //   其余**直接丢弃**。而卡片没有容量上限（DSH 没有 Hermes 那种换卡），会长到远超
        //   3000 字，于是中间那一大段历史被删掉，用户看到的就是"旧消息被吞"
        //   （Hermes 侧同款 bug 实测丢 57% 内容、28/50 段消失）。
        //   现在按 FOLD_CHUNK_CHARS 切成**多块面板**：每块仍 ≤ 单元素保守上限，一个字符都不丢。
        const chunks = chunkText(extraLines.join('\n\n'), FOLD_CHUNK_CHARS)
        const count = chunks.length
        for (let i = count - 1; i >= 0; i--) {
          tail.unshift({
            tag: 'collapsible_panel',
            expanded: false,
            background_color: 'grey-50',
            border: { color: 'grey', corner_radius: '8px' },
            padding: '8px 8px 8px 8px',
            header: {
              title: {
                tag: 'plain_text',
                content: count === 1
                  ? '📎 更早过程 (' + (elements.length - KEEP_TAIL) + ')'
                  : '📎 更早过程 (' + (i + 1) + '/' + count + ')',
              },
              vertical_align: 'center',
              padding: '8px 8px 8px 8px',
              icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '16px 16px' },
              icon_position: 'right',
              icon_expanded_angle: -180,
            },
            elements: [{ tag: 'markdown', content: chunks[i] }],
          })
        }
      }
      elements.length = 0
      for (const el of tail) elements.push(el)
    }
    if (elements.length === 0) elements.push({ tag: 'markdown', content: ' ' })
    elements.push({ tag: 'markdown', content: statusTextFor(card) })
    return { schema: '2.0', config: { wide_screen_mode: true }, body: { elements } }
  }

  // Serialized, rate-limited, backoff'd, breakered card sync.
  function syncCard(bot, chatId, card, force) {
    if (!card || !bot || card.circuitOpen) {
      if (card && card.circuitOpen) console.log('[fs] card sync skipped: circuitOpen (failCount=' + card.failCount + ')')
      return card.queue
    }
    // 建卡失败过就**不再重复建卡**：15s 超时被 abort 时飞书侧可能已经建成功，
    // 再发一次就会留下一张永远不再更新的孤儿卡（用户看到两张内容相同的卡）。
    if (!card.token && card.createFailed) {
      console.log('[fs] card sync skipped: createFailed (no token)')
      return card.queue
    }
    const now = Date.now()
    if (now < card.retryUntil) return card.queue
    if (card.token && !force && now - card.lastSyncAt < CARD_MIN_INTERVAL) return card.queue
    card.queue = card.queue.catch(() => {}).then(async () => {
      // 队列**内部**再检查一次：syncCard 会被多处几乎同时调用（建卡时 force、watcher、
      // seal），它们在入口检查时 createFailed 还是 false → 都排进队列 → 串行执行时各自 create。
      // 队列内检查才能保证"建卡只成功/尝试一次"（2026-09-15 smoke 实测：入口检查漏掉 3 次 create）。
      if (!card.token && card.createFailed) return
      const payload = buildCardPayload(card)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('card request timed out')), CARD_TIMEOUT)
      const wasPatch = Boolean(card.token)
      try {
        if (wasPatch) {
          await updateInteractive(bot, card.token, payload, controller.signal)
        } else {
          const messageId = await sendInteractive(bot, chatId, payload, controller.signal)
          // 必须校验返回值：旧实现把 undefined 也写进 token → token 恒空 → 每次 sync 再建一张卡
          if (!messageId || typeof messageId !== 'string') {
            throw new Error('create card returned no message_id')
          }
          card.token = messageId
        }
        card.lastSyncAt = Date.now()
        // 只有**成功的 PATCH** 才清零失败计数：create 成功不代表这张卡健康，
        // 否则"建卡成功→PATCH 失败→计数归零"会绕过熔断（与 Hermes 侧同型缺陷）。
        if (wasPatch) card.failCount = 0
        card.retryUntil = 0
        // 2026-09-16 修复（CM：卡片看不到中间过程、只等到最后一条）：
        // createFailed / circuitOpen 原本**只置位、没有任何复位** → 一次瞬时故障就把整张卡
        // 永久打进"静默跳过"状态：之后 buildCardPayload 照常跑、但一次都不再发出去
        // （日志特征：card created=0 / card reply delivered=0，且**无任何报错**）。
        // 现在：任何一次成功（create 或 PATCH）= 链路是通的 → 复位。
        card.circuitOpen = false
        if (card.token) card.createFailed = false
      } catch (error) {
        card.failCount += 1
        if (!wasPatch) card.createFailed = true   // 建卡失败 → 放弃该卡，交给兜底纯文本
        const delay = CARD_RETRY_BASE * 2 ** (card.failCount - 1)
        if (card.failCount >= CARD_MAX_FAILURES) {
          card.circuitOpen = true
          console.log('[fs] card circuit opened chat=' + chatId + ': '
            + String(error && error.message || error))
        } else {
          card.retryUntil = Date.now() + delay
          console.log('[fs] card sync failed chat=' + chatId + ' fail=' + card.failCount
            + ' retry=' + delay + 'ms: ' + String(error && error.message || error))
        }
      } finally {
        clearTimeout(timer)
      }
    })
    return card.queue
  }

  // Session event log accessor — DSH version compatibility.
  // 0.1.0-rc.5 (公开版，本机在跑的那版) 暴露的是 `session.events`（数组，下标=seq）；
  // 更晚的 0.1.2-rc.1 把它废弃成 `session.snapshotEvents()`。2026-09-08 那次"为 0.1.2 适配"
  // 把调用点硬编码成了后者 → 在 0.1.0-rc.5 上入站消息一进 runTurn 就抛
  // `TypeError: session.snapshotEvents is not a function`，飞书里表现为"发消息没回复"。
  // 两个版本都读一遍：有 snapshotEvents 就用，没有就退回 events。
  function sessionEvents(session) {
    if (!session) return []
    try {
      if (typeof session.snapshotEvents === 'function') {
        const snapshot = session.snapshotEvents()
        if (Array.isArray(snapshot)) return snapshot
      }
    } catch (e) {
      console.log('[fs] snapshotEvents() failed, falling back to events: ' + String(e && e.message || e))
    }
    return Array.isArray(session.events) ? session.events : []
  }

  // Scan the agent session event log from **this card's own cursor** and mirror
  // new events into the card. Returns true if anything changed.
  //
  // 2026-09-15 修复：游标挂在**卡对象**上（`card.cursor`），不再由调用方传 `{from}`。
  // 旧实现里 watcher 用局部 `fromRef`、seal 前补扫用 `{from: seqBefore}`（本轮起点），
  // 两者互不知情 —— 一旦发生 `split()`（答题后开新卡），补扫会把 split **之前**的内容
  // 重放一遍、split 之后的写两遍（appendNote 无去重），用户就看到"同一段东西分两张卡、
  // 内容大量重复"。一卡一游标 + appendNote 的 seq 去重彻底消除这个重叠窗口。
  function scanCard(agent, card) {
    const events = sessionEvents(agent.session)
    const from = Number.isFinite(card.cursor) ? card.cursor : 0
    let changed = false
    for (let i = from; i < events.length; i++) {
      const event = events[i]
      if (!event || !event.data) continue
      if (event.type === 'assistant/message') {
        const spoken = extractProcessText(event.data.message)
        if (spoken) {
          appendNote(card, spoken, event.seq)
          changed = true
        }
      } else if (event.type === 'tool/call' && event.data.callId) {
        const id = String(event.data.callId)
        if (!card.tools.has(id)) {
          card.tools.set(id, {
            name: String(event.data.name || 'tool'),
            args: String(event.data.arguments || ''),
            status: 'running',
          })
          appendTool(card, id)
          changed = true
        }
      } else if (event.type === 'tool/result' && event.data.message) {
        const id = event.data.message.source && event.data.message.source.callId
        if (id) {
          const tool = card.tools.get(String(id))
          if (tool) {
            const block = event.data.message.content && event.data.message.content[0]
            tool.status = block && block.isError ? 'failed' : 'completed'
            if (tool.status === 'failed') {
              tool.error = toolResultText(event.data.message)
                || (event.data.error && event.data.error.code ? 'code ' + event.data.error.code : '失败')
            }
            changed = true
          }
        }
      }
    }
    card.cursor = events.length
    return changed
  }

  // Poll the agent session event log and mirror new events into the card.
  // `initialCursor` 只在第一次设置（卡自己的游标），不传则沿用 card.cursor。
  function startCardWatcher(agent, card, bot, chatId, onTableBudget) {
    const timer = setInterval(() => {
      if (card.sealing) return
      try {
        // 表格额度换卡（CM 2026-09-16 方案）：飞书单卡硬上限 5 张表（ErrCode 11310）。
        // 本卡已用满且**还有新事件待镜像**时，先换一张新卡 —— 旧卡的表格原样留在旧卡，
        // 新事件由新卡接续（新卡游标 = 旧卡游标，不丢不重）。这样永远不降级表格。
        if (typeof onTableBudget === 'function' && cardTableCount(card) >= CARD_MAX_TABLES) {
          const pending = sessionEvents(agent.session)
          const from = Number.isFinite(card.cursor) ? card.cursor : 0
          if (pending.length > from) { onTableBudget(); return }
        }
        if (scanCard(agent, card)) {
          card.lastEventAt = Date.now()
          card.idleMinutes = 0
          void syncCard(bot, chatId, card, false).catch(() => {})
        } else if (card.status === 'running' && card.lastEventAt) {
          // 诚实状态：长时间没有新事件就说清楚"多久没动"，**不宣称完成**
          const mins = Math.floor((Date.now() - card.lastEventAt) / 60000)
          const next = mins >= DSH_IDLE_NOTICE_MIN ? mins : 0
          if (next !== card.idleMinutes) {
            card.idleMinutes = next
            void syncCard(bot, chatId, card, false).catch(() => {})
          }
        }
      } catch (error) {
        console.log('[fs] card watcher error: ' + String(error && error.message || error))
      }
    }, CARD_POLL_INTERVAL)
    return () => clearInterval(timer)
  }

  // ---- dedicated agent sessions --------------------------------------------
  const defaultAgentOptions = () => {
    const selection = ctx.get('agentDefaultModel')
    const selected = selection && typeof selection.currentSelection === 'function'
      ? selection.currentSelection() : undefined
    return selected ? { provider: selected.provider, model: selected.model } : undefined
  }

  // Compose the standard agent preset (fs/bash/web/... bundles) onto an agent
  // context — sessions created/resumed without it only expose plugin-owned
  // tools (feishu_send): the "飞书新会话没有工具" failure (2026-09-08, dsh
  // 0.1.2-rc.1). Mirrors the GUI session factory (presets.mount from setup).
  async function mountStandardPreset(agentCtx) {
    const presets = agentCtx.get('agentPresets')
    if (!presets) return
    try {
      const preset = await presets.mount(agentCtx)
      console.log('[fs] standard agent preset mounted: ' + String(preset && preset.id || 'default'))
    } catch (error) {
      console.log('[fs] preset mount failed: ' + String(error && error.message || error))
    }
  }

  async function createDedicated(bot, sessionId, cwdOverride) {
    const agents = ctx.get('agents')
    if (!agents) throw new Error('agents service unavailable')
    const cfg = bot.cfg
    return agents.create({
      sessionId,
      meta: { cwd: (cwdOverride && String(cwdOverride).trim())
        || (cfg.workspace && String(cfg.workspace).trim()) || workspaceRoot() || undefined },
      ...(defaultAgentOptions() ? { agentOptions: defaultAgentOptions() } : {}),
      setup: mountStandardPreset,
    })
  }

  async function resumeDedicated(bot, sessionId) {
    const agents = ctx.get('agents')
    if (!agents) throw new Error('agents service unavailable')
    return agents.resume({
      resumeSessionId: sessionId,
      ...(defaultAgentOptions() ? { agentOptions: defaultAgentOptions() } : {}),
      setup: mountStandardPreset,
    })
  }

  // ---- chat/session bookkeeping ---------------------------------------------
  function loadChats(bot) {
    const state = readState(bot.cfg.appId)
    const chats = new Map()
    for (const [chatId, record] of Object.entries(state.chats || {})) {
      let sessions = Array.isArray(record && record.sessions) ? record.sessions : []
      // Sessions persisted before SESSION_GEN 2 were created without the
      // standard-preset mount and only expose feishu_send — reuse would keep
      // them tool-less forever, so drop them once; the next inbound message
      // auto-creates a fully tooled session for the chat.
      const legacy = sessions.filter((s) => s && s.type === 'dedicated' && s.gen !== SESSION_GEN)
      if (legacy.length > 0) {
        console.log('[fs] dropping ' + legacy.length + ' legacy session(s) created without standard tools: '
          + legacy.map((s) => s.id).join(', '))
        sessions = sessions.filter((s) => !(s && s.type === 'dedicated' && s.gen !== SESSION_GEN))
      }
      const activeId = record && record.active
      let activeIndex = 0
      if (activeId) {
        const idx = sessions.findIndex((s) => s && s.id === activeId)
        if (idx >= 0) activeIndex = idx
      }
      chats.set(chatId, { sessions, activeIndex })
    }
    return chats
  }

  function persistChats(bot, chats) {
    const state = { chats: {} }
    for (const [chatId, chat] of chats) {
      const active = chat.sessions[chat.activeIndex]
      state.chats[chatId] = {
        sessions: chat.sessions.map((s) => ({ id: s.id, label: s.label, type: s.type, gen: s.gen })),
        active: active ? active.id : (chat.sessions[0] ? chat.sessions[0].id : 'main'),
      }
    }
    writeState(bot.cfg.appId, state)
  }

  // Resolve the live agent handle for a chat's active session.
  async function resolveAgent(bot, chat, mainAgent) {
    const entry = chat.sessions[chat.activeIndex]
    if (!entry) return undefined
    if (entry.type === 'main') return undefined          // legacy marker -> recreate
    if (entry.handle) return entry.handle.agent
    // (1) The session may already be LIVE in this process: DSH restores
    //     sessions on boot (and the GUI may hold them). resume would be
    //     rejected with "cannot prepare session while it is live", but the
    //     live agent still carries the full conversation — reuse it directly
    //     so context is preserved across restarts.
    try {
      const agents = ctx.get('agents')
      const list = agents && typeof agents.list === 'function' ? agents.list() : []
      const live = list.find((a) => a && a.id === entry.id)
      if (live) {
        entry.handle = { agent: live }
        console.log('[fs] reused live session ' + entry.id + ' (context preserved)')
        return live
      }
    } catch (error) {
      console.log('[fs] live lookup failed: ' + String(error && error.message || error))
    }
    // (2) Otherwise try resume (prepares the persisted session).
    try {
      const handle = await resumeDedicated(bot, entry.id, mainAgent)
      entry.handle = handle
      return handle.agent
    } catch (error) {
      console.log('[fs] resume failed for ' + entry.id + ': ' + String(error && error.message || error))
      return undefined
    }
  }

  // ---- commands --------------------------------------------------------------
  const COMMANDS = ['help', 'new', 'switch', 'list', 'plan', 'goal', 'stop']

  function splitCommand(text) {
    const trimmed = (text || '').trim()
    if (!trimmed.startsWith('/')) return undefined
    const parts = trimmed.slice(1).split(/\s+/)
    return { name: (parts[0] || '').toLowerCase(), arg: parts.slice(1).join(' ') }
  }

  function resolveCommandName(name) {
    if (!name) return undefined
    const exact = COMMANDS.find((c) => c === name)
    if (exact) return exact
    const prefix = COMMANDS.find((c) => c.startsWith(name))
    return prefix
  }

  // `/goal` 的正文由 harness 的 command-goal 实现渲染（英文标签：Goal created /
  // Status / Objective / Rounds）。这里只在"刚启动一轮目标"时补一句中文说明，
  // 让 CM 知道接下来飞书上会发生什么 —— 每轮一张进度卡，不需要他催。
  const GOAL_START_HINT = '（目标模式下我会自动一轮一轮接着干；每一轮的进度都会在这张聊天里开卡更新，'
    + '轮结束封口写「本轮结束」。随时 /goal 查看状态，/goal pause 暂停。）'
  function normalizeGoalReply(text) {
    const body = String(text || '').trim() || 'ok'
    if (/^Goal (created|resumed)/iu.test(body)) return body + '\n\n' + GOAL_START_HINT
    return body
  }

  async function handleCommand(bot, chat, chatId, cmd) {
    const resolved = resolveCommandName(cmd.name)
    if (!resolved) return false
    if (resolved === 'help') {
      await sendPlainText(bot, chatId,
        '/new [名称] 新建会话\n/switch 切换会话/工作区（列出清单，可点按钮）\n/switch <序号> [new] 按序号切换 / 在该工作区新建\n/list 列出本聊天会话\n/plan [off] 计划模式开关\n/goal <目标> 目标模式（自动续轮，每轮进度发到飞书）\n/goal (无参数) 查看目标状态 ｜ /goal pause|resume|clear|edit <目标>\n/stop 停止当前任务\n/help 帮助')
      return true
    }
    if (resolved === 'stop') {
      const active = chat.sessions[chat.activeIndex]
      if (!active) {
        await sendPlainText(bot, chatId, '当前没有可用会话：先发一条普通消息建立会话，再 /stop。')
        return true
      }
      // Resolve the CURRENT live agent (a cached handle may point at a stale
      // instance after hmr reloads) — mirror resolveAgent's live lookup so
      // cancel() hits the agent actually running the turn.
      let agent
      try {
        const agents = ctx.get('agents')
        const list = agents && typeof agents.list === 'function' ? agents.list() : []
        agent = list.find((a) => a && a.id === active.id) || null
      } catch (error) {
        console.log('[fs] /stop live lookup failed: ' + String(error && error.message || error))
        agent = null
      }
      if (!agent && active.handle) agent = active.handle.agent
      if (!agent) {
        await sendPlainText(bot, chatId, '当前没有可用会话：先发一条普通消息建立会话，再 /stop。')
        return true
      }
      try {
        console.log('[fs] /stop: cancelling live agent ' + agent.id)
        agent.cancel({ kind: 'user' })
        console.log('[fs] /stop: cancel() returned without throwing')
        await sendPlainText(bot, chatId, '已发送停止指令。')
      } catch (error) {
        console.log('[fs] /stop: cancel threw: ' + String(error && error.stack || error))
        await sendPlainText(bot, chatId, '停止失败：' + String(error && error.message || error))
      }
      return true
    }
    if (resolved === 'plan') {
      const active = chat.sessions[chat.activeIndex]
      const agent = active && active.handle && active.handle.agent
      if (!agent) {
        await sendPlainText(bot, chatId, '当前没有可用会话：先发一条普通消息建立会话，再 /plan。')
        return true
      }
      // Prefer the harness commands registry (plan-mode registers /plan
      // there); fall back to the injected planMode service directly.
      // ctx.get('planMode') misses the service across bundle scopes (2026-08-15).
      let planMode
      try {
        const commands = ctx.get('commands')
        if (commands && typeof commands.execute === 'function') {
          const line = cmd.arg ? '/plan ' + cmd.arg : '/plan'
          const exec = await commands.execute(agent, line, new AbortController().signal)
          if (exec !== undefined) {
            const text = exec.result && exec.result.text ? exec.result.text : 'ok'
            await sendPlainText(bot, chatId, text)
            return true
          }
          console.log('[fs] /plan: commands.execute resolved nothing, falling back')
        }
      } catch (error) {
        console.log('[fs] /plan via commands failed: ' + String(error && error.message || error))
      }
      planMode = planModeRef
      if (!planMode || typeof planMode.set !== 'function') {
        await sendPlainText(bot, chatId, '计划模式不可用（plan-mode 插件未装载）。')
        return true
      }
      const off = cmd.arg === 'off'
      const outcome = planMode.set(agent, !off)
      await sendPlainText(bot, chatId, off
        ? '已退出计划模式（' + outcome + '）。'
        : '已进入计划模式（' + outcome + '）。提交计划时我会通过评审卡片请你确认。')
      return true
    }
    if (resolved === 'goal') {
      const active = chat.sessions[chat.activeIndex]
      const agent = active && active.handle && active.handle.agent
      if (!agent) {
        await sendPlainText(bot, chatId, '当前没有可用会话：先发一条普通消息建立会话，再 /goal <目标>。')
        return true
      }
      // 目标模式（CM 2026-09-16）：走与 /plan 同一条命令通道 —— command-goal 插件
      // 已在 `commands` 注册表登记 /goal，能正确处理 <目标>|pause|resume|clear|edit。
      const line = cmd.arg ? '/goal ' + cmd.arg : '/goal'
      let handled = false
      try {
        const commands = ctx.get('commands')
        if (commands && typeof commands.execute === 'function') {
          const exec = await commands.execute(agent, line, new AbortController().signal)
          if (exec !== undefined) {
            const text = exec.result && exec.result.text ? exec.result.text : 'ok'
            await sendPlainText(bot, chatId, normalizeGoalReply(text))
            handled = true
          } else {
            console.log('[fs] /goal: commands.execute resolved nothing, falling back')
          }
        }
      } catch (error) {
        console.log('[fs] /goal via commands failed: ' + String(error && error.message || error))
      }
      if (handled) return true
      // 兜底：命令注册表不可用时直接调 goals 服务（只覆盖创建；其余子命令提示用法）。
      const goals = ctx.get('goals')
      if (!goals || typeof goals.create !== 'function') {
        await sendPlainText(bot, chatId, '目标模式不可用（goal 插件未装载）。')
        return true
      }
      if (!cmd.arg || /^(pause|resume|clear|edit)(\s|$)/iu.test(cmd.arg)) {
        await sendPlainText(bot, chatId, '用法：/goal <目标> ｜ /goal（查看状态）｜ /goal pause ｜ /goal resume ｜ /goal clear ｜ /goal edit <新目标>')
        return true
      }
      try {
        const view = goals.create(agent, { objective: cmd.arg })
        await sendPlainText(bot, chatId, '目标已创建：' + view.objective
          + '（轮数 ' + view.roundsStarted + '/' + view.maxGoalRounds + '）\n\n' + GOAL_START_HINT)
      } catch (error) {
        await sendPlainText(bot, chatId, '创建目标失败：' + String(error && error.message || error))
      }
      return true
    }
    if (resolved === 'new') {
      const sessionId = 'fs-main-' + Date.now().toString(36)
      const handle = await createDedicated(bot, sessionId)
      chat.sessions.push({ id: sessionId, label: cmd.arg || ('会话 ' + (chat.sessions.length + 1)), type: 'dedicated', gen: SESSION_GEN, handle })
      chat.activeIndex = chat.sessions.length - 1
      persistChats(bot, bot.chats)
      await sendPlainText(bot, chatId, '已新建会话' + (cmd.arg ? '「' + cmd.arg + '」' : '') + '并切换过去。')
      return true
    }
    if (resolved === 'list') {
      const lines = chat.sessions.map((s, i) =>
        (i === chat.activeIndex ? '▶ ' : '  ') + (i + 1) + '. ' + s.label,
      )
      await sendPlainText(bot, chatId, lines.length ? lines.join('\n') : '（无会话）')
      return true
    }
    if (resolved === 'switch') {
      const arg = String(cmd.arg || '').trim()
      // 无参数 = 列出可切换的会话/工作区（卡片 + 文字兜底）。CM 2026-09-16 需求。
      if (!arg) {
        const rows = await buildSwitchRows(bot, chat)
        if (!rows.length) {
          await sendPlainText(bot, chatId, '没有可切换的会话：先发一条普通消息建立会话。')
          return true
        }
        await sendSwitchCard(bot, chatId, chat, rows)
        return true
      }
      const parsed = /^(\d+)(?:\s+(new|takeover|接管|新建))?$/iu.exec(arg)
      if (!parsed) {
        await sendPlainText(bot, chatId, '用法：/switch（列出可切换的会话/工作区）｜ /switch <序号> ｜ /switch <序号> new')
        return true
      }
      const index = Number(parsed[1]) - 1
      const modeArg = (parsed[2] || '').toLowerCase()
      const mode = (modeArg === 'new' || modeArg === '新建') ? 'new' : 'takeover'
      const cached = lastSwitchRows.get(chatId)
      const rows = (cached && Date.now() - cached.at <= SWITCH_CARD_TTL_MS)
        ? cached.rows
        : await buildSwitchRows(bot, chat)
      if (!cached || Date.now() - cached.at > SWITCH_CARD_TTL_MS) lastSwitchRows.set(chatId, { rows, at: Date.now() })
      const row = switchRowByIndex(rows, index)
      if (!row) {
        await sendPlainText(bot, chatId, '序号无效：当前有 ' + rows.length + ' 个可切换项，先发 /switch 看列表。')
        return true
      }
      await applySwitch(bot, chat, chatId, row, mode)
      return true
    }
    return false
  }

  // ---- inbound message handling ----------------------------------------------
  function normalizeEvent(data) {
    const d = data && typeof data === 'object' ? data : {}
    const message = d.message || (d.event && d.event.message) || {}
    const sender = d.sender || (d.event && d.event.sender) || {}
    return {
      message_id: message.message_id,
      message_type: message.message_type,
      chat_id: message.chat_id,
      chat_type: message.chat_type,
      content: message.content,
      create_time: message.create_time,
      sender,
    }
  }

  function extractText(contentJson) {
    try {
      const parsed = JSON.parse(contentJson || '{}')
      // Plain text (mobile client): {"text":"...","mentions":[...]}
      if (typeof parsed.text === 'string') {
        const mentions = parsed.mentions
        if (!mentions || !Array.isArray(mentions)) return parsed.text
        let out = parsed.text
        for (const m of mentions) {
          if (m && typeof m.key === 'string' && typeof m.denote_text === 'string') {
            out = out.split(m.key).join(m.denote_text)
          }
        }
        return out
      }
      // Rich-text post (desktop client): {"title":"...","content":[[{tag,text},...],...]}
      // PC 端发的普通文本是 post 格式，不解析会被静默丢弃（2026-09-01 事故）。
      if (Array.isArray(parsed.content)) {
        const parts = []
        for (const para of parsed.content) {
          if (!Array.isArray(para)) continue
          for (const el of para) {
            if (el && typeof el === 'object' && typeof el.text === 'string') parts.push(el.text)
          }
        }
        return parts.join(' ').trim()
      }
      return ''
    } catch {
      return ''
    }
  }

  // ---- inbound file inbox (2026-09-09, CM): Feishu file/media messages carry
  // no text, so extractText() returns '' and the old code dropped them
  // silently. Download the resource via the message-resources API and inject a
  // text note with its local path so the agent session can read the file.
  // Destination: bot.fileInbox, else <bot.workspace>/downloaded_files (config
  // driven, never a hardcoded absolute path).
  async function downloadInboundFile(bot, evt) {
    try {
      const msgType = String(evt.msg_type || '')
      const parsed = JSON.parse(evt.content || '{}')
      let key = ''
      let type = ''
      let fileName = ''
      if (msgType === 'file') { type = 'file'; key = parsed.file_key || ''; fileName = parsed.file_name || '' }
      else if (msgType === 'image') { type = 'image'; key = parsed.image_key || ''; fileName = 'image' }
      else if (msgType === 'audio') { type = 'file'; key = parsed.file_key || parsed.audio_key || ''; fileName = parsed.file_name || 'audio' }
      else if (msgType === 'media') { type = 'file'; key = parsed.file_key || ''; fileName = parsed.file_name || 'media' }
      if (!key || !type) return ''
      const ws = bot.cfg.workspace && String(bot.cfg.workspace).trim() ? String(bot.cfg.workspace).trim() : ''
      const base = (bot.cfg.fileInbox && String(bot.cfg.fileInbox).trim())
        || (ws ? join(ws, 'downloaded_files') : join(homedir(), 'downloaded_files'))
      mkdirSync(base, { recursive: true })
      const token = await tenantAccessToken(bot, bot.cfg.appId, bot.cfg.appSecret)
      const url = 'https://open.feishu.cn/open-apis/im/v1/messages/' + encodeURIComponent(evt.message_id)
        + '/resources/' + encodeURIComponent(key) + '?type=' + type
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } })
      if (!res.ok) {
        console.log('[fs] inbound file download failed: HTTP ' + res.status + ' (' + fileName + ')')
        return ''
      }
      const buf = Buffer.from(await res.arrayBuffer())
      const safe = String(fileName || type + '-' + Date.now()).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120)
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const path = join(base, stamp + '_' + safe)
      writeFileSync(path, buf)
      console.log('[fs] inbound file saved: ' + path + ' (' + buf.length + ' bytes)')
      return '📎 收到文件：' + (fileName || '(无文件名)') + '\n已保存到：' + path + '\n（需要时请用文件工具读取该路径）'
    } catch (e) {
      console.log('[fs] inbound file handler error: ' + String(e && e.message || e))
      return ''
    }
  }

  // ---- inbound dedup (2026-09-15) -------------------------------------------
  // 按 message_id 记住最近处理过的入站消息，防"重连重投 / 双 helper"导致整轮重复。
  const SEEN_INBOUND_MAX = 200
  const seenInboundIds = new Set()
  function isDuplicateInbound(messageId) {
    const id = String(messageId || '')
    if (!id) return false
    if (seenInboundIds.has(id)) return true
    seenInboundIds.add(id)
    if (seenInboundIds.size > SEEN_INBOUND_MAX) {
      // Set 保序：删掉最早的一个，维持 LRU 窗口
      const oldest = seenInboundIds.values().next().value
      seenInboundIds.delete(oldest)
    }
    return false
  }

  async function handleInbound(bot, evt) {
    const chatId = evt.chat_id
    if (!chatId) return
    // 入站去重：飞书长连接是 at-least-once，重连后会重投未 ack 的事件；
    // 进程内也可能有两份 helper 订阅同一 app。没有去重时同一条消息会跑两整轮、
    // 产出两张内容相同的卡（2026-09-15 CM 反馈"同一段东西分两个卡片发"）。
    if (isDuplicateInbound(evt.message_id)) {
      console.log('[fs] duplicate inbound skipped: ' + String(evt.message_id || ''))
      return
    }
    bot.lastChatId = chatId

    const messageId = evt.message_id
    let text = extractText(evt.content)
    if (!text.trim()) {
      const note = await downloadInboundFile(bot, evt)
      if (note) text = note
    }
    if (!text.trim()) return

    // Commands are handled without touching an agent session.
    const cmd = splitCommand(text)
    if (cmd) {
      const chat = bot.chats.get(chatId) || { sessions: [], activeIndex: 0 }
      bot.chats.set(chatId, chat)
      const handled = await handleCommand(bot, chat, chatId, cmd).catch((error) => {
        console.log('[fs] command error: ' + String(error && error.message || error))
        return false
      })
      if (handled) return
    }

    // A pending user-question (ask_user_question / plan review) is answered
    // by the next plain message in this chat (F-04).
    const pendingQ = pendingQuestions.get(chatId)
    if (pendingQ) {
      pendingQuestions.delete(chatId)
      if (pendingQ.timer) clearTimeout(pendingQ.timer)
      // Free-text answers should also continue on a fresh card below the
      // question card (same stale-card problem as button taps).
      if (pendingQ.agentId) {
        const turn = activeTurns.get(pendingQ.agentId)
        if (turn && typeof turn.split === 'function') {
          try { turn.split() } catch (error) {
            console.log('[fs] question split failed (text path): ' + String(error && error.message || error))
          }
        }
      }
      pendingQ.resolve(buildQuestionAnswer(pendingQ.questions, text))
      await sendPlainText(bot, chatId, '✅ 已收到你的回答。')
      return
    }

    // Ensure a dedicated session exists for this chat.
    let chat = bot.chats.get(chatId)
    let agent
    let sessionReused = false
    if (!chat || chat.sessions.length === 0) {
      chat = { sessions: [], activeIndex: 0 }
      bot.chats.set(chatId, chat)
      const sessionId = 'fs-main-' + Date.now().toString(36)
      try {
        const handle = await createDedicated(bot, sessionId)
        chat.sessions = [{ id: sessionId, label: '主会话', type: 'dedicated', gen: SESSION_GEN, handle }]
        chat.activeIndex = 0
        persistChats(bot, bot.chats)
        agent = handle.agent
      } catch (error) {
        console.log('[fs] auto-create agent failed: ' + String(error && error.stack || error))
        await sendPlainText(bot, chatId, '创建 Agent 会话失败：'
          + (bot.cfg.workspace || workspaceRoot() || '?') + '。请检查工作区配置后重试，或发送 /new 手动创建。')
        return
      }
    } else {
      sessionReused = true
      agent = await resolveAgent(bot, chat)
      if (!agent) {
        // The previous session could not be resumed (DSH refuses to prepare a
        // session still marked live, e.g. after a hard kill of dsh web). Fall
        // back to creating a fresh session automatically so the user's message
        // always gets a reply; keep the old entry in the list for reference.
        const sessionId = 'fs-main-' + Date.now().toString(36)
        try {
          const handle = await createDedicated(bot, sessionId)
          chat.sessions.push({ id: sessionId, label: '会话 ' + (chat.sessions.length + 1), type: 'dedicated', gen: SESSION_GEN, handle })
          chat.activeIndex = chat.sessions.length - 1
          persistChats(bot, bot.chats)
          sessionReused = false
          agent = handle.agent
          console.log('[fs] old session not resumable (live), created fallback ' + sessionId)
        } catch (error) {
          console.log('[fs] fallback create failed: ' + String(error && error.stack || error))
          await sendPlainText(bot, chatId, '会话创建失败：'
            + (bot.cfg.workspace || workspaceRoot() || '?') + '。请检查工作区配置后重试。')
          return
        }
      }
    }

    const openId = evt.sender && evt.sender.sender_id && evt.sender.sender_id.open_id || ''
    const label = openId ? '[飞书 ' + openId + '] ' : '[飞书消息] '

    // Typing reaction: added on arrival, removed after the reply is delivered.
    const emoji = (bot.cfg.reactionEmoji && String(bot.cfg.reactionEmoji).trim()) || 'OnIt'
    let reactionId
    if (emoji && emoji !== 'none') {
      try {
        const r = await addReaction(bot, messageId, emoji)
        reactionId = r && r.reaction_id
      } catch (error) {
        console.log('[fs] reaction add failed: ' + String(error && error.message || error))
      }
    }
    const removeReactionOnce = () => {
      if (!reactionId) return
      const id = reactionId
      reactionId = undefined
      void removeReaction(bot, messageId, id).catch((error) => {
        console.log('[fs] reaction remove failed: ' + String(error && error.message || error))
      })
    }

    // Send -> wait -> scan -> seal. Delivery stays outside so a zombie session
    // (answers nothing after a dsh web restart interrupted its turn) can be
    // dropped and retried on a fresh session before an empty card is sent.
    const runTurn = async (turnAgent) => {
      const seqBefore = sessionEvents(turnAgent.session).length
      const message = {
        id: 'fs-' + messageId,
        role: 'user',
        content: [{ type: 'text', text: label + text }],
        source: { kind: 'user' },
      }
      turnAgent.send(message, 'next-turn', true)
      let card = makeCardState()
      card.cursor = seqBefore          // 本卡只消费本轮开始之后的事件
      card.blocks.push({ type: 'message', text: '正在工作中…' })
      void syncCard(bot, chatId, card, true).catch(() => {})
      // 表格额度换卡（CM 2026-09-16 方案）：飞书单卡最多 5 张表，满额时**不降级表格**，
      // 而是把旧卡封住（表格留在旧卡），后续内容写到一张新卡上。
      // 与 split() 的唯一差别：新卡游标 = 旧卡**当前**游标 → 触发换卡的待处理事件落到新卡，
      // 既不丢也不重（split() 是答题专用，它把游标设到事件末尾，会跳过待处理事件）。
      const rotateTables = () => {
        if (!stopCardWatcher) return
        if (!card || card.status === 'sealed' || card.status === 'error') return
        const carry = Number.isFinite(card.cursor) ? card.cursor : 0
        stopCardWatcher()
        card.status = 'sealed'
        void syncCard(bot, chatId, card, true).catch(() => {})
        const fresh = makeCardState()
        fresh.cursor = carry
        fresh.blocks.push({ type: 'message', text: '📊 上一张卡的表格已满（飞书单卡最多 5 张），后续内容在这张新卡继续。' })
        card = fresh
        void syncCard(bot, chatId, fresh, true).catch(() => {})
        stopCardWatcher = startCardWatcher(turnAgent, fresh, bot, chatId, rotateTables)
        const live = activeTurns.get(turnAgent.id)
        if (live) live.card = fresh
      }
      let stopCardWatcher = startCardWatcher(turnAgent, card, bot, chatId, rotateTables)
      // Register this turn's live card so ask_user_question can split the
      // stream: when the user answers, the old card (above the question card)
      // is frozen and a fresh card takes over for the post-answer narration.
      const entry = {
        card, bot, chatId,
        split: () => {
          if (card.status === 'sealed' || card.status === 'error') return
          // 1) Freeze the current card: stop its watcher, seal it in place.
          stopCardWatcher()
          card.status = 'sealed'
          card.blocks = card.blocks.filter((b) => !(b.type === 'message' && b.text === '正在工作中…'))
          card.blocks.push({ type: 'message', text: '✅ 已收到你的选择，继续处理中…' })
          void syncCard(bot, chatId, card, true).catch(() => {})
          // 2) Open a fresh card below for the rest of this turn. Resume the
          // watcher from the CURRENT event position so events already shown
          // on the old card are not replayed onto the fresh one.
          const fresh = makeCardState()
          // 新卡游标 = 当前事件位置：split 之前的内容**已经**在旧卡上，绝不能再重放一遍
          // （旧实现的 seal 前补扫从 seqBefore 重放整轮，造成新卡与旧卡内容大面积重复）。
          fresh.cursor = sessionEvents(turnAgent.session).length
          fresh.blocks.push({ type: 'message', text: '继续处理中…' })
          card = fresh
          void syncCard(bot, chatId, fresh, true).catch(() => {})
          stopCardWatcher = startCardWatcher(turnAgent, fresh, bot, chatId, rotateTables)
          entry.card = fresh
        },
      }
      activeTurns.set(turnAgent.id, entry)
      let waitError = null
      try {
        await turnAgent.whenIdle()
      } catch (error) {
        waitError = error
        console.log('[fs] turn wait failed for ' + messageId + ': ' + String(error && error.message || error))
      }
      stopCardWatcher()
      activeTurns.delete(turnAgent.id)
      if (waitError) {
        card.status = 'error'
        void syncCard(bot, chatId, card, true).catch(() => {})
        return { card, reply: '（Agent 未产生文字回复）', hadOutput: false, waitError }
      }
      // Catch-up scan: if the turn finished faster than the watcher's poll
      // interval, fold every event into the card now so narration and tool
      // panels are not lost. 用**本卡自己的游标**（不是本轮起点）→ 已镜像过的不会重放。
      scanCard(turnAgent, card)
      // Seal: promote the last note (the final reply) to a message block so
      // the reply is not duplicated as narration; drop the placeholder; kill
      // the status line.
      const events = sessionEvents(turnAgent.session)
      let reply = '（Agent 未产生文字回复）'
      let lastSeq
      for (let i = events.length - 1; i >= seqBefore; i--) {
        const event = events[i]
        if (event && event.type === 'assistant/message') {
          const spoken = extractProcessText(event.data && event.data.message)
          if (spoken) { reply = spoken; lastSeq = event.seq; break }
        }
      }
      card.status = 'sealed'
      card.blocks = card.blocks.filter((b) => !(b.type === 'message' && b.text === '正在工作中…'))
      let replaced = false
      if (lastSeq !== undefined) {
        for (let i = card.blocks.length - 1; i >= 0; i--) {
          const b = card.blocks[i]
          if (b.type === 'note' && b.seq === lastSeq) {
            card.blocks[i] = { type: 'message', text: reply }
            replaced = true
            break
          }
        }
      }
      if (!replaced) card.blocks.push({ type: 'message', text: reply })
      return {
        card,
        reply,
        hadOutput: lastSeq !== undefined || card.tools.size > 0,
        waitError: null,
      }
    }

    let turn = await runTurn(agent)
    if (!turn.hadOutput && sessionReused) {
      // Reused/resumed session produced nothing at all — the signature of a
      // session whose turn was killed by a dsh web restart (2026-09-08). Drop
      // it and answer from a brand-new session so the user never gets a blank
      // reply; keep the old entry's history in DSH storage, just unbind it.
      const stale = chat.sessions[chat.activeIndex]
      console.log('[fs] session ' + (stale && stale.id || '?') + ' produced no output; recreating session and retrying once')
      chat.sessions.splice(chat.activeIndex, 1)
      if (chat.sessions.length === 0) chat.activeIndex = 0
      else if (chat.activeIndex >= chat.sessions.length) chat.activeIndex = chat.sessions.length - 1
      const sessionId = 'fs-main-' + Date.now().toString(36)
      try {
        const handle = await createDedicated(bot, sessionId)
        chat.sessions.push({ id: sessionId, label: '主会话（自愈）', type: 'dedicated', gen: SESSION_GEN, handle })
        chat.activeIndex = chat.sessions.length - 1
        persistChats(bot, bot.chats)
        turn = await runTurn(handle.agent)
        turn.reply = '⚠️ 检测到上一会话无响应（可能被 dsh 重启打断），已自动重建会话。\n\n' + turn.reply
        console.log('[fs] heal: recreated session ' + sessionId + ' and retried the message')
      } catch (error) {
        console.log('[fs] heal create failed: ' + String(error && error.message || error))
      }
    }
    if (turn.waitError) {
      removeReactionOnce()
      return
    }
    let cardDelivered = false
    try {
      await syncCard(bot, chatId, turn.card, true)
      cardDelivered = !!turn.card.token && !turn.card.circuitOpen
    } catch {
      cardDelivered = false
    }
    if (!cardDelivered) {
      try {
        const res = await sendPlainText(bot, chatId, turn.reply)
        console.log('[fs] fallback text reply to ' + chatId + ' status=' + String(res.status))
      } catch (error) {
        console.log('[fs] send failed for ' + messageId + ': ' + String(error && error.message || error))
      }
    } else {
      console.log('[fs] card reply delivered to ' + chatId)
    }
    removeReactionOnce()
  }

  // ---- helper subprocess lifecycle -------------------------------------------
  function quoteArg(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  }

  function spawnHelper(bot) {
    const cfg = bot.cfg
    const appId = cfg.appId && String(cfg.appId).trim()
    const appSecret = cfg.appSecret && String(cfg.appSecret).trim()
    if (!appId || !appSecret) return
    const key = appId + '|' + appSecret + '|' + String(cfg.workspace || '')
    if (bot.proc && bot.proc.status === 'running' && bot.procKey === key) return
    lastSpawnAt = Date.now()
    bot.spawningAt = Date.now()
    if (bot.proc) {
      try { bot.proc.kill() } catch { /* ignore */ }
    }
    const spec = ctx.shell.resolve({
      command: 'node ' + quoteArg(HELPER_PATH) + ' ' + quoteArg(appId) + ' ' + quoteArg(appSecret),
    })
    bot.proc = ctx.shell.start(spec)
    bot.procKey = key
    console.log('[fs] helper spawned (app ' + appId + ')')
  }

  async function ensureHelpers() {
    if (stopping) return
    const now = Date.now()
    const refresh = now - lastConfigCheck >= CONFIG_REFRESH_MS
    if (refresh) lastConfigCheck = now
    const list = await readConfig()

    // Stop helpers whose bot was removed from config.
    for (const [appId, bot] of bots) {
      if (!list.some((c) => c.appId === appId)) {
        console.log('[fs] bot ' + appId + ' removed from config; stopping helper')
        try { if (bot.proc) bot.proc.kill() } catch { /* ignore */ }
        bots.delete(appId)
      }
    }

    // Ensure one helper per configured bot.
    for (const cfg of list) {
      let bot = bots.get(cfg.appId)
      if (!bot) {
        bot = {
          cfg,
          proc: undefined,
          procKey: '',
          spawningAt: 0,       // cooldown: last spawnHelper() timestamp for this bot
          status: '',
          chain: Promise.resolve(),
          token: undefined,
          tokenExpiresAt: 0,
          lastChatId: '',
          chats: new Map(),
        }
        bot.chats = loadChats(bot)
        bots.set(cfg.appId, bot)
      } else {
        bot.cfg = cfg
      }
      const appId = cfg.appId
      const appSecret = cfg.appSecret
      if (!appId || !appSecret) {
        if (bot.proc && bot.proc.status === 'running') {
          try { bot.proc.kill() } catch { /* ignore */ }
          bot.proc = undefined
        }
        continue
      }
      const key = appId + '|' + appSecret + '|' + String(cfg.workspace || '')
      if (!refresh && bot.proc && bot.proc.status === 'running') continue
      if (now - lastSpawnAt < 5000 && bot.proc && bot.proc.status === 'running') continue
      if (bot.proc && bot.proc.status === 'running' && bot.procKey === key) continue
      // Per-bot spawn cooldown: a just-spawned helper may not yet report
      // status 'running', which would otherwise trigger a duplicate spawn on
      // the next 500ms tick (observed: 5x "helper spawned" in a row).
      if (now - bot.spawningAt < 5000) continue
      spawnHelper(bot)
    }
  }

  function drainOutput() {
    for (const bot of bots.values()) {
      if (!bot.proc) continue
      try {
        const read = bot.proc.readOutput()
        if (read && read.delta) {
          for (const line of read.delta.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed) continue
            let msg
            try { msg = JSON.parse(trimmed) } catch { continue }
            handleHelperMessage(bot, msg)
          }
        }
      } catch (error) {
        console.log('[fs] drain error: ' + String(error && error.message || error))
      }
    }
  }

  function handleHelperMessage(bot, msg) {
    if (!msg || typeof msg !== 'object') return
    // Raw debug events from the helper's invoke hook are observation-only —
    // the same event is re-emitted by the registered handler right after.
    if (msg.raw) {
      console.log('[fs] helper event (raw debug): ' + msg.eventType)
      return
    }
    if (msg.type === 'event' && msg.eventType === 'im.message.receive_v1') {
      const evt = normalizeEvent(msg.data)
      // Control commands (/stop etc.) bypass the serial chain so they can
      // interrupt a running turn immediately — queuing them behind the turn
      // makes /stop arrive only after the turn finished (2026-08-15).
      const text = extractText(evt.content)
      const cmd = text ? splitCommand(text) : undefined
      if (cmd) {
        const chatId = evt.chat_id
        const chat = bot.chats.get(chatId) || { sessions: [], activeIndex: 0 }
        bot.chats.set(chatId, chat)
        handleCommand(bot, chat, chatId, cmd).catch((error) => {
          console.log('[fs] command error: ' + String(error && error.stack || error))
        })
        return
      }
      // A pending user-question (ask_user_question) is answered by the next
      // plain message. This MUST bypass the chain too: the chain is held by
      // the turn waiting for the answer, so a queued reply would never be
      // processed and the question would hang forever (2026-08-16).
      const chatId = evt.chat_id
      const pendingQ = pendingQuestions.get(chatId)
      if (pendingQ && text) {
        pendingQuestions.delete(chatId)
        if (pendingQ.timer) clearTimeout(pendingQ.timer)
        pendingQ.resolve(buildQuestionAnswer(pendingQ.questions, text))
        console.log('[fs] question answered via chat: ' + chatId)
        sendPlainText(bot, chatId, '✅ 已收到你的回答。').catch(() => {})
        return
      }
      bot.chain = bot.chain.then(() => handleInbound(bot, evt)).catch((error) => {
        console.log('[fs] handler error: ' + String(error && error.stack || error))
      })
      return
    }
    if (msg.type === 'event' && msg.eventType === 'card.action.trigger') {
      // Card clicks MUST bypass the serial chain: the chain is held by the
      // turn waiting on the approval, so a queued click would only be
      // processed after the approval times out (2026-08-16).
      try {
        handleCardAction(msg.data)
      } catch (error) {
        console.log('[fs] card action error: ' + String(error && error.stack || error))
      }
      return
    }
    if (msg.type === 'event') {
      // Anything else that arrives over the long connection (debug hook in
      // helper.cjs marks raw events) — shows whether callbacks reach us at all.
      console.log('[fs] helper event (unhandled): ' + msg.eventType + (msg.raw ? ' [raw]' : ''))
      return
    }
    if (msg.type === 'ready') {
      bot.status = 'connected'
      console.log('[fs] long connection ready (app ' + bot.cfg.appId + ')')
      return
    }
    if (msg.type === 'error') {
      console.log('[fs] helper error: ' + String(msg.message))
      return
    }
    if (msg.type === 'status') {
      const state = msg.status && msg.status.state ? msg.status.state : '?'
      const attempts = msg.status && msg.status.reconnectAttempts ? '/' + String(msg.status.reconnectAttempts) : ''
      const line = state + attempts
      if (line !== bot.status) {
        bot.status = line
        console.log('[fs] connection status (app ' + bot.cfg.appId + '): ' + line)
      }
    }
  }

  // ---- approval cards (dsh approval/request -> Feishu card with buttons) -----
  const pendingApprovals = new Map()     // token -> record { bot, chatId, request, settle, timer, cardId }
  // 2026-09-16 CM 反馈：3 分钟太短，人常常不在手机前，卡就自动过期被拒了（实测拦掉一条
  // 正常的 git push）。改为 10 分钟；卡片文案由本常量推导，别再写死数字（原来文案里
  // 硬编码了"3 分钟"，改常量不改文案会自相矛盾）。
  const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
  const APPROVAL_TIMEOUT_MIN = Math.round(APPROVAL_TIMEOUT_MS / 60000)

  // planMode service arrives via dependency injection (cordis scopes make a
  // plain ctx.get miss cross-bundle services; the commands registry is
  // preferred at call time and this is the fallback).
  let planModeRef = null
  ctx.inject(['planMode'], (scope) => { planModeRef = scope.planMode })

  function findChatForAgent(agent) {
    for (const bot of bots.values()) {
      for (const [chatId, chat] of bot.chats) {
        for (const s of chat.sessions || []) {
          if (s.handle && s.handle.agent === agent) return { bot, chatId }
        }
      }
    }
    return undefined
  }

  // Look up which bot owns a chat id (for replying from card-action callbacks
  // where we only know open_chat_id, e.g. stale question-card taps).
  function findBotForChat(chatId) {
    if (!chatId) return undefined
    for (const bot of bots.values()) {
      if (bot.chats && bot.chats.has(chatId)) return bot
    }
    // Fall back to the bot that most recently heard from this chat.
    for (const bot of bots.values()) {
      if (bot.lastChatId === chatId) return bot
    }
    return undefined
  }

  function approvalCardPayload(toolName, reason, token) {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '🔒 需要你的确认' }, template: 'orange' },
      elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: '**工具**：`' + toolName + '`\n**说明**：' + (reason || '（无说明）')
                + '\n\n是否允许执行（仅本次）？\n⏰ ' + APPROVAL_TIMEOUT_MIN + ' 分钟内未操作将自动拒绝。',
            },
          },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { tag: 'plain_text', content: '✅ 允许一次' }, type: 'primary', value: { fs_approval: token, fs_action: 'allow' } },
            { tag: 'button', text: { tag: 'plain_text', content: '❌ 拒绝' }, type: 'danger', value: { fs_approval: token, fs_action: 'reject' } },
          ],
        },
      ],
    }
  }

  function approvalResultCardPayload(toolName, label) {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '🔒 需要你的确认' }, template: 'blue' },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '**工具**：`' + toolName + '`\n**结果**：' + label },
        },
      ],
    }
  }

  // Withdraw the approval card once it is decided so it does not linger at the
  // bottom of the chat while the reply card keeps updating (2026-08-16 CM
  // design, mirroring ZCode's in-flow permission UX). Falls back to updating
  // the card in place when recall is unavailable.
  async function dismissApprovalCard(bot, record, label) {
    if (!record || !record.cardId) return
    try {
      const accessToken = await tenantAccessToken(bot, bot.cfg.appId, bot.cfg.appSecret)
      const res = await httpJson(
        'https://open.feishu.cn/open-apis/im/v1/messages/' + encodeURIComponent(record.cardId),
        'DELETE',
        { Authorization: 'Bearer ' + accessToken },
      )
      const parsed = parseJson(res.text)
      if (!(res.status >= 200 && res.status < 300) || !parsed || parsed.code !== 0) {
        throw new Error('recall failed: ' + (res.text || JSON.stringify(res)))
      }
      console.log('[fs] approval card recalled: ' + record.request.toolName)
    } catch (error) {
      console.log('[fs] approval card recall failed, updating in place: ' + String(error && error.message || error))
      await updateApprovalCard(bot, record, label)
    }
  }

  function askApprovalCard(bot, chatId, request) {
    const token = randomUUID()
    const record = {
      bot, chatId, request,
      settle: undefined, timer: undefined, signalOff: undefined, cardId: undefined,
    }
    return new Promise((resolve) => {
      let settled = false
      const settle = (outcome) => {
        if (settled) return
        settled = true
        if (record.timer) clearTimeout(record.timer)
        if (record.signalOff) record.signalOff()
        pendingApprovals.delete(token)
        resolve(outcome)
      }
      record.settle = settle
      pendingApprovals.set(token, record)
      record.timer = setTimeout(() => {
        console.log('[fs] approval timed out, auto-reject: ' + request.toolName)
        dismissApprovalCard(bot, record, '⏰ 已超时（自动拒绝）')
        settle('rejected')
      }, APPROVAL_TIMEOUT_MS)
      if (request.signal && typeof request.signal.addEventListener === 'function') {
        const onAbort = () => {
          console.log('[fs] approval cancelled (agent aborted): ' + request.toolName)
          settle('cancelled')
        }
        request.signal.addEventListener('abort', onAbort)
        record.signalOff = () => request.signal.removeEventListener('abort', onAbort)
      }
      sendInteractive(bot, chatId, approvalCardPayload(request.toolName, request.reason, token))
        .then((msgId) => {
          record.cardId = msgId
          console.log('[fs] approval card sent: ' + request.toolName + ' token=' + token)
        })
        .catch((error) => {
          console.log('[fs] approval card send failed: ' + String(error && error.message || error))
          // Text fallback (same policy as the streaming card): never silently
          // grant, but tell the user the approval could not be delivered.
          sendPlainText(bot, chatId, '⚠️ 审批卡片发送失败（已自动拒绝该操作）——工具：' + request.toolName)
            .catch(() => {})
          settle('rejected')
        })
    })
  }

  // ─── 会话/工作区切换（CM 2026-09-16 需求）────────────────────────────────────
  // 需求：① 打一个命令 ② 展示可切换的会话/工作区 ③ 切过去。
  // 设计：无参数 `/switch` → 一张卡片，分三组列出候选（① 本聊天会话 ② 本工作区其它会话
  // ③ 其它工作区），每行两个按钮「接管 / 新建」；文本兜底 `/switch <序号> [new]`。
  // 序号**从本聊天会话开始连续编号** → 老语义 `/switch 1`（= 主会话）不变。
  //
  // 两个安全约束（写进卡面，不让 CM 猜）：
  //  · 正在别处运行的会话（🟡）**不给"接管"** —— DSH 里同一会话被两处同时驱动会写坏历史，
  //    只允许"在该工作区新建"。
  //  · "新建"不碰任何旧会话：只是在该工作区开一个全新会话（cwd = 那个工作区）。
  const SWITCH_CARD_TTL_MS = 15 * 60 * 1000
  const SWITCH_OWN_LIMIT = 5          // 本工作区其它会话最多列几条
  const SWITCH_FOREIGN_LIMIT = 2      // 每个其它工作区最多列几条
  const SWITCH_FOREIGN_GROUPS = 2     // 最多列几个其它工作区
  const SWITCH_SUMMARY_MAX_BYTES = 4 * 1024 * 1024   // 只对小于此体积的日志读"首条消息"当摘要
  const SWITCH_SUMMARY_TIMEOUT_MS = 1500
  const SWITCH_GROUP_TITLES = {
    1: '**① 本聊天的会话**',
    2: '**② 本工作区的其它会话**（含 GUI 里开的）',
    3: '**③ 其它工作区**',
  }
  const pendingSwitchCards = new Map()   // token -> { bot, chatId, rows, timer }
  const lastSwitchRows = new Map()       // chatId -> { rows, at }

  function shortSessionId(id) { return String(id || '').slice(0, 8) }

  function fmtClock(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return ''
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function workspaceLeaf(cwd) {
    const parts = String(cwd || '').split(/[\\/]/).filter(Boolean)
    return parts.length ? parts[parts.length - 1] : '（无工作区）'
  }

  function sameWorkspace(a, b) {
    const norm = (v) => String(v || '').replace(/[\\/]+$/, '').toLowerCase()
    return norm(a) === norm(b) && norm(a) !== ''
  }

  function liveAgentsById() {
    const out = new Map()
    try {
      const agents = ctx.get('agents')
      const list = agents && typeof agents.list === 'function' ? agents.list() : []
      for (const a of list) if (a && a.id) out.set(String(a.id), a)
    } catch (error) {
      console.log('[fs] switch: agents.list failed: ' + String(error && error.message || error))
    }
    return out
  }

  // 会话标题：DSH 把标题写成 `session/title` 事件 → 活着的会话直接从内存事件里取最后一条。
  function liveTitle(agent) {
    try {
      const events = sessionEvents(agent.session)
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (!e || e.type !== 'session/title') continue
        const t = e.data && e.data.title
        if (typeof t === 'string' && t.trim()) return t.trim()
      }
    } catch { /* 标题只是展示信息，取不到就算了 */ }
    return ''
  }

  function artifactInfo(sp, meta) {
    try {
      const loc = typeof sp.locate === 'function' ? sp.locate(meta) : undefined
      if (!loc || !loc.path) return undefined
      const st = statSync(loc.path)
      return { size: st.size, mtime: st.mtimeMs }
    } catch { return undefined }
  }

  // 首条用户消息（摘要）：只对**体积可控**的日志读，绝不为列个表去解析几百 MB 的历史。
  async function firstUserText(sp, meta, size) {
    if (Number.isFinite(size) && size > SWITCH_SUMMARY_MAX_BYTES) return ''
    try {
      const pending = Promise.resolve(sp.readFrom(meta.id, 0))
      pending.catch(() => {})                       // 超时后仍会 reject：先挂上处理器
      const raced = await Promise.race([
        pending,
        new Promise((resolve) => { setTimeout(() => resolve(undefined), SWITCH_SUMMARY_TIMEOUT_MS) }),
      ])
      if (!raced || !Array.isArray(raced.events)) return ''
      for (const ev of raced.events) {
        if (!ev || ev.type !== 'user/message') continue
        const src = (ev.data && ev.data.source) || {}
        if (src.kind && src.kind !== 'user') continue
        const text = (ev.data && ev.data.content || [])
          .map((c) => (c && typeof c.text === 'string' ? c.text : '')).join(' ')
          .replace(/\s+/g, ' ').trim()
        if (text) return text.length > 60 ? text.slice(0, 60) + '…' : text
      }
    } catch (error) {
      console.log('[fs] switch: summary read failed for ' + meta.id + ': ' + String(error && error.message || error))
    }
    return ''
  }

  async function buildSwitchRows(bot, chat) {
    const rows = []
    const seen = new Set()
    const live = liveAgentsById()
    const botWorkspace = (bot.cfg && bot.cfg.workspace) || ''
    for (let i = 0; i < chat.sessions.length; i++) {
      const s = chat.sessions[i]
      const agent = live.get(String(s.id)) || (s.handle && s.handle.agent)
      const resolved = live.get(String(s.id)) || agent
      seen.add(String(s.id))
      rows.push({
        group: 1,
        sessionId: String(s.id),
        workspace: botWorkspace,
        inChat: true,
        current: i === chat.activeIndex,
        live: Boolean(resolved),
        title: resolved ? liveTitle(resolved) : '',
        summary: '',
        label: s.label || ('会话 ' + (i + 1)),
        mtime: undefined,
      })
    }

    const sp = ctx.get('sessionPersistence')
    if (!sp || typeof sp.list !== 'function') return rows
    let all = []
    try {
      all = await sp.list()
    } catch (error) {
      console.log('[fs] switch: persistence.list failed: ' + String(error && error.message || error))
      return rows
    }
    const candidates = []
    for (const meta of all) {
      if (!meta || !meta.id) continue
      const id = String(meta.id)
      if (seen.has(id)) continue
      if (meta.origin === 'subagent' || (meta.delegationDepth || 0) > 0) continue   // 子代理子会话不是可切换目标
      const info = artifactInfo(sp, meta)
      candidates.push({ meta, id, cwd: String(meta.cwd || ''), info })
    }
    const recency = (c) => (c.info && c.info.mtime) || c.meta.createdAt || 0
    candidates.sort((a, b) => recency(b) - recency(a))

    const own = candidates.filter((c) => sameWorkspace(c.cwd, botWorkspace)).slice(0, SWITCH_OWN_LIMIT)
    const foreign = candidates.filter((c) => !sameWorkspace(c.cwd, botWorkspace))
    const byWorkspace = new Map()
    for (const c of foreign) {
      const key = c.cwd.toLowerCase() || '?'
      if (!byWorkspace.has(key)) byWorkspace.set(key, [])
      byWorkspace.get(key).push(c)
    }
    const foreignPick = []
    for (const [, list] of [...byWorkspace.entries()].sort((a, b) => recency(b[1][0]) - recency(a[1][0]))) {
      if (foreignPick.length >= SWITCH_FOREIGN_GROUPS) break
      foreignPick.push(...list.slice(0, SWITCH_FOREIGN_LIMIT))
    }

    const picked = [...own.map((c) => ({ c, group: 2 })), ...foreignPick.map((c) => ({ c, group: 3 }))]
    const summaries = await Promise.all(picked.map(({ c }) => firstUserText(sp, c.meta, c.info && c.info.size)))
    picked.forEach(({ c, group }, i) => {
      const agent = live.get(c.id)
      rows.push({
        group,
        sessionId: c.id,
        workspace: c.cwd,
        inChat: false,
        current: false,
        live: Boolean(agent),
        title: agent ? liveTitle(agent) : '',
        summary: summaries[i] || '',
        label: workspaceLeaf(c.cwd),
        mtime: recency(c),
      })
    })
    return rows
  }

  function buildSwitchCard(bot, chat, rows) {
    const active = chat.sessions[chat.activeIndex]
    const elements = [{
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '**当前**：' + ((active && active.label) || '（无）')
          + '\n**工作目录**：`' + ((bot.cfg && bot.cfg.workspace) || '?') + '`'
          + '\n🟢 空闲（可接管） ｜ 🟡 运行中（只给"新建"，避免同一会话被两处同时驱动）',
      },
    }]
    let group = 0
    rows.forEach((row, i) => {
      const n = i + 1
      if (row.group !== group) {
        group = row.group
        elements.push({ tag: 'hr' })
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: SWITCH_GROUP_TITLES[group] || '' } })
      }
      const what = row.title || row.summary || (row.group === 1 ? row.label : '（未命名会话）')
      const meta = ['`' + shortSessionId(row.sessionId) + '`']
      if (row.workspace) meta.push('`' + row.workspace + '`')     // 完整工作区路径：CM 需要知道切过去是哪个目录
      const clock = fmtClock(row.mtime)
      if (clock) meta.push(clock)
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: (row.current ? '▶ ' : '') + n + '. ' + (row.live ? '🟡 ' : '🟢 ') + '**' + what + '**'
            + '\n　　' + meta.join(' · '),
        },
      })
      const actions = []
      const push = (label, type, mode) => actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: label },
        type,
        value: { fs_switch: row.token, fs_index: n - 1, fs_mode: mode },
      })
      if (row.inChat) {
        if (!row.current) push(n + ' 切过去', 'primary', 'takeover')
      } else if (row.live) {
        push(n + ' 新建', 'default', 'new')
      } else {
        push(n + ' 接管', 'primary', 'takeover')
        push(n + ' 新建', 'default', 'new')
      }
      if (actions.length) elements.push({ tag: 'action', actions })
    })
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '也可以发文字：`/switch <序号>` 接管 ｜ `/switch <序号> new` 在该工作区新建' },
    })
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '🔀 切换会话 / 工作区' }, template: 'blue' },
      elements,
    }
  }

  async function sendSwitchCard(bot, chatId, chat, rows) {
    const token = randomUUID()
    for (const row of rows) row.token = token
    lastSwitchRows.set(chatId, { rows, at: Date.now() })
    const record = { bot, chatId, rows, timer: undefined }
    record.timer = setTimeout(() => pendingSwitchCards.delete(token), SWITCH_CARD_TTL_MS)
    pendingSwitchCards.set(token, record)
    const cardId = await sendInteractive(bot, chatId, buildSwitchCard(bot, chat, rows))
    console.log('[fs] /switch card sent: rows=' + rows.length + ' card=' + String(cardId || ''))
    return cardId
  }

  function switchRowByIndex(rows, index) {
    const n = Number(index)
    if (!Number.isInteger(n) || n < 0 || n >= rows.length) return undefined
    return rows[n]
  }

  async function applySwitch(bot, chat, chatId, row, mode) {
    const cwd = (row.workspace && String(row.workspace).trim()) || (bot.cfg && bot.cfg.workspace) || ''
    if (mode === 'new') {
      const sessionId = 'fs-main-' + Date.now().toString(36)
      const handle = await createDedicated(bot, sessionId, cwd)
      chat.sessions.push({
        id: sessionId,
        label: workspaceLeaf(cwd) + '（新建）',
        type: 'dedicated',
        gen: SESSION_GEN,
        handle,
      })
      chat.activeIndex = chat.sessions.length - 1
      persistChats(bot, bot.chats)
      console.log('[fs] /switch new session ' + sessionId + ' cwd=' + cwd)
      await sendPlainText(bot, chatId, '✅ 已在工作区 `' + cwd + '` 新建会话并切过去（旧会话一个都没动）。')
      return
    }
    const idx = chat.sessions.findIndex((s) => String(s.id) === String(row.sessionId))
    if (idx >= 0) {
      chat.activeIndex = idx
      persistChats(bot, bot.chats)
      await sendPlainText(bot, chatId, '✅ 已切换到会话「' + (chat.sessions[idx].label || shortSessionId(row.sessionId)) + '」。')
      return
    }
    if (row.live) {
      await sendPlainText(bot, chatId, '🟡 这个会话正在别处运行，不能同时接管（会把同一份历史写坏）。'
        + '等它结束再来，或者点「新建」在该工作区开一个新会话。')
      return
    }
    const handle = await resumeDedicated(bot, row.sessionId)
    chat.sessions.push({
      id: String(row.sessionId),
      label: row.title || row.summary || shortSessionId(row.sessionId),
      type: 'resumed',
      gen: SESSION_GEN,
      handle,
    })
    chat.activeIndex = chat.sessions.length - 1
    persistChats(bot, bot.chats)
    console.log('[fs] /switch takeover session ' + row.sessionId + ' cwd=' + cwd)
    await sendPlainText(bot, chatId, '✅ 已接管会话 `' + shortSessionId(row.sessionId) + '`'
      + (cwd ? '（工作目录 `' + cwd + '`）' : '') + '，接着往下说就行。')
  }

  async function handleSwitchAction(bot, chatId, value) {
    const record = pendingSwitchCards.get(String(value.fs_switch || ''))
    if (!record) {
      await sendPlainText(bot, chatId, '这张切换卡片已过期（超过 ' + Math.round(SWITCH_CARD_TTL_MS / 60000) + ' 分钟）。'
        + '重新发一个 /switch 即可。')
      return
    }
    const row = switchRowByIndex(record.rows, value.fs_index)
    if (!row) {
      await sendPlainText(bot, chatId, '这张卡片里的序号已经对不上了，重新发一个 /switch 吧。')
      return
    }
    const chat = bot.chats.get(chatId) || { sessions: [], activeIndex: 0 }
    bot.chats.set(chatId, chat)
    const mode = value.fs_mode === 'new' ? 'new' : 'takeover'
    console.log('[fs] /switch click: index=' + value.fs_index + ' mode=' + mode + ' session=' + row.sessionId)
    await applySwitch(bot, chat, chatId, row, mode)
  }

  function handleCardAction(data) {
    console.log('[fs] card action event received: tag=' + (data && data.action && data.action.tag || '?'))
    const action = data && data.action ? data.action : {}
    const value = action.value || {}
    // Session/workspace switch buttons (the /switch picker card).
    if (value.fs_switch !== undefined) {
      const chatId = data && data.context && data.context.open_chat_id
      const ownerBot = chatId ? findBotForChat(chatId) : undefined
      if (!chatId || !ownerBot) {
        console.log('[fs] /switch click without a resolvable chat/bot (chat=' + String(chatId || '') + ')')
        return
      }
      void handleSwitchAction(ownerBot, chatId, value).catch((error) => {
        console.log('[fs] /switch click failed: ' + String(error && error.message || error))
        void sendPlainText(ownerBot, chatId, '切换失败：' + String(error && error.message || error)).catch(() => {})
      })
      return
    }
    // Question-option buttons (ask_user_question card).
    if (value.fs_question !== undefined && value.fs_option !== undefined) {
      const chatId = data && data.context && data.context.open_chat_id
      const record = chatId ? pendingQuestions.get(chatId) : undefined
      if (!record || record.token !== value.fs_question) {
        // Stale-card click (already answered / superseded) must never be a
        // silent no-op: tell the user visibly instead of dropping the tap.
        // (2026-09-08 CM: clicked a stale card button -> nothing happened.)
        console.log('[fs] question button: record not found for chat ' + chatId + ' token=' + value.fs_question)
        const stale = chatId ? recentQuestions.get(chatId) : undefined
        const hint = (stale && stale.token === value.fs_question)
          ? '该选项已经处理过了（点过即生效）。请看我最新一条消息，或直接回复文字。'
          : '这张卡片已过期（可能已经回答过）。请看我最新一条卡片，或直接回复文字即可。'
        if (chatId) {
          const ownerBot = findBotForChat(chatId)
          if (ownerBot) {
            sendPlainText(ownerBot, chatId, '⚠️ ' + hint).catch(() => {})
          }
        }
        return
      }
      const q = record.questions[0]
      const opts = (q.options || []).slice(0, QUESTION_MAX_BUTTONS)
      const opt = opts[Number(value.fs_option)]
      if (!opt) {
        console.log('[fs] question button: bad option index ' + value.fs_option)
        if (chatId) {
          const ownerBot = findBotForChat(chatId)
          if (ownerBot) {
            sendPlainText(ownerBot, chatId, '⚠️ 无法识别该选项，请直接回复文字。').catch(() => {})
          }
        }
        return
      }
      pendingQuestions.delete(chatId)
      if (record.timer) clearTimeout(record.timer)
      console.log('[fs] question answered via button: ' + q.id + ' -> ' + opt.label)
      // Keep the last answered token per chat so a second tap on the same
      // (now stale) card gets a friendly hint instead of silence.
      recentQuestions.set(chatId, { token: value.fs_question, answeredAt: Date.now() })
      // Split the streaming card: the old one sits above this question card,
      // so the rest of the turn must continue on a NEW card below it
      // (2026-09-08 CM report). Do this before resolve() so post-answer
      // narration lands on the fresh card.
      if (record.agentId) {
        const turn = activeTurns.get(record.agentId)
        if (turn && typeof turn.split === 'function') {
          try { turn.split() } catch (error) {
            console.log('[fs] question split failed: ' + String(error && error.message || error))
          }
        }
      }
      record.resolve(buildQuestionAnswer(record.questions, opt.label))
      if (record.cardId) {
        updateInteractive(record.bot, record.cardId, questionResultCardPayload(q, opt.label))
          .catch((error) => {
            console.log('[fs] question card update failed: ' + String(error && error.message || error))
            // Fallback: a visible text confirmation so the tap never looks dead.
            sendPlainText(record.bot, chatId, '✅ 已收到：' + opt.label).catch(() => {})
          })
      } else if (chatId) {
        sendPlainText(record.bot, chatId, '✅ 已收到：' + opt.label).catch(() => {})
      }
      return
    }
    const token = value.fs_approval
    if (!token) {
      console.log('[fs] card action: no fs_approval token in value, ignoring')
      return
    }
    const record = pendingApprovals.get(token)
    if (!record) {
      console.log('[fs] card action: token not found (already settled?) ' + token)
      return
    }
    if (value.fs_action === 'allow') {
      console.log('[fs] approval allowed (once): ' + record.request.toolName)
      record.settle('allowed-once')
      dismissApprovalCard(record.bot, record, '✅ 已允许（仅本次）')
    } else if (value.fs_action === 'reject') {
      console.log('[fs] approval rejected: ' + record.request.toolName)
      record.settle('rejected')
      dismissApprovalCard(record.bot, record, '❌ 已拒绝')
    }
  }

  // Answer dsh approval/request for agents owned by this plugin's Feishu chats;
  // everything else (GUI sessions etc.) delegates via next().
  ctx.on('approval/request', (request, next) => {
    const agentId = request && request.agent ? request.agent.id : '?'
    console.log('[fs] approval/request received: tool=' + (request && request.toolName)
      + ' agent=' + agentId + ' callId=' + (request && request.callId || 'none'))
    const owner = findChatForAgent(request.agent)
    if (!owner) {
      console.log('[fs] approval/request: no chat owner for agent ' + agentId + ', delegating')
      return next()
    }
    console.log('[fs] approval/request: owner found, asking via card')
    return askApprovalCard(owner.bot, owner.chatId, request)
  })

  // ---- 审批前置拦截：把"审计类 ask"搬到飞书（2026-09-16 CM 拍板）--------------------
  // 为什么要自己拦：审计插件返回 {kind:"ask"} 后，主程序走它自己的 `ctx.approval`
  // （PC 一次性提示），**绕开**我们已有的 `approval/request` 卡片链路 —— 实机日志已验证：
  // 5 次 `sentinel: ask`（01:49 / 05:50 / 05:55 / 05:56×2）**没有一次**走到 approval/request，
  // 所以飞书上根本收不到卡，CM 只能在电脑上点。
  // 修法：在**更前面的** `tools/pre-execute` 自己拦 —— 发飞书卡、等点击、再决定放行/拦截。
  // 这样 `ctx.approval` 根本不会被触发，审批只出现在飞书。
  // 开关：**默认关闭**；要启用审批设 DSH_FEISHU_APPROVAL=1（CM 2026-09-16 拍板）
  // **默认关闭**（CM 2026-09-16 拍板）：他给的是 danger-full-access 完全访问，
  // 审批不该由插件再加一道。要恢复审批：设环境变量 DSH_FEISHU_APPROVAL=1。
  const APPROVAL_ON_FEISHU = String(process.env.DSH_FEISHU_APPROVAL ?? '0').trim() === '1'
  // 需要确认的两类（**故意收窄**：只拦"外发数据"和"工作区外写入"，避免把常用操作都拦下来）
  //
  // 2026-09-16 收窄（CM 拍板）：原正则尾部的 `nc ` 是**两个字母加一个空格**，
  // 太短，极易在多行命令拼接后误命中，把纯读操作判成"联网/外发命令"并弹审批卡；
  // CM 未及时点 → 命令直接被拒（实测白费一轮排查）。
  // 现处理：
  //   ① 所有词都加 `\b` 词边界（避免路径/文件名里出现 ssh、ftp 等子串被误判）；
  //   ② `nc` 要求后接空白 + 短横线（`\bnc\s+-`），即真实的 netcat 调用形式，
  //      纯文本里出现 "nc " 不再触发；
  //   ③ 补上常被忽略的真实外发命令：`socat`、`telnet`、`Test-NetConnection`、`tracert`。
  const EGRESS_CMD_RE = /(\bcurl\b|\bwget\b|\bInvoke-WebRequest\b|\biwr\b|\bncat\b|\bsocat\b|\btelnet\b|\bssh\b|\bscp\b|\bsftp\b|\bftp\b|\bnc\s+-|\bTest-NetConnection\b)/i
  const SHELL_TOOLS = /^(terminal|pwsh|powershell|shell|exec|bash|cmd)$/i
  const WRITE_TOOLS = /^(write|write_file|patch|edit|edit_file|apply_patch)$/i
  let lastChat = null          // { bot, chatId }：最近收到消息的会话，用于兜底定位

  function normPath(v) {
    return String(v || '').split(String.fromCharCode(92)).join('/').toLowerCase()
  }
  function workspaceOf(bot) {
    return normPath(bot && (bot.workspace || (bot.config && bot.config.workspace) || ''))
  }
  // 返回"需要确认的理由"，null = 放行
  function approvalReasonFor(exec, bot) {
    const name = String((exec && exec.name) || '')
    const args = (exec && (exec.arguments || exec.args)) || {}
    if (SHELL_TOOLS.test(name)) {
      const cmd = String(args.command || args.cmd || '')
      // 只测**命令主体**：砍掉 '#' 之后的注释（PowerShell 注释里提到 curl 也拦 = 误报，
      // 2026-09-16 实测被拦过一条 `Write-Output ... # 旧正则会拦这条`）
      const body = String(cmd).split('#')[0]
      if (body && EGRESS_CMD_RE.test(body)) return '联网/外发命令：' + body.split(' ').filter(Boolean).join(' ').slice(0, 140)
      return null
    }
    if (WRITE_TOOLS.test(name)) {
      const target = String(args.path || args.file_path || args.filename || '')
      const ws = workspaceOf(bot)
      if (target && ws && !normPath(target).startsWith(ws)) return '工作区外写入：' + target.slice(0, 160)
      return null
    }
    return null
  }
  function ownerForExec(exec) {
    const agent = exec && exec.agent
    if (agent) {
      const hit = findChatForAgent(agent)
      if (hit) return hit
    }
    return lastChat                      // 兜底：最近活跃会话（拿不到 agent 时）
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const pass = () => (typeof next === 'function' ? next() : undefined)
    if (!APPROVAL_ON_FEISHU) return pass()
    try {
      const owner = ownerForExec(exec)
      if (!owner) return pass()
      const reason = approvalReasonFor(exec, owner.bot)
      if (!reason) return pass()
      console.log('[fs] approval needed (pre-execute): ' + String(exec && exec.name) + ' — ' + reason)
      const outcome = await askApprovalCard(owner.bot, owner.chatId,
        { toolName: String(exec && exec.name || 'tool'), reason })
      // 注意：askApprovalCard 的返回值是 'allowed-once' / 可能还有 'allowed-always' /
      // 'rejected' / 'cancelled' —— 旧代码写 `=== 'allowed'` **永远不成立**，
      // 导致"你在飞书点了允许，agent 收到的却是拒绝"（2026-09-16 实机日志抓到）。
      // 现在按前缀判定，并把原始值打进日志，便于以后一眼确认。
      const verdict = String(outcome || '')
      if (verdict.indexOf('allowed') === 0) {
        console.log('[fs] approval granted on Feishu (' + verdict + '): ' + String(exec && exec.name))
        return pass()
      }
      console.log('[fs] approval ' + outcome + ' on Feishu — denying: ' + String(exec && exec.name))
      return { kind: 'deny', reason: '用户在飞书' + (outcome === 'rejected' ? '拒绝' : '未在时限内确认') + '：' + reason }
    } catch (error) {
      // 出错一律放行（保持原有行为，绝不因审批自身故障把 agent 卡死）；但记日志
      console.log('[fs] approval hook error (passing through): ' + String(error && error.message || error))
      return pass()
    }
  })

  // ---- user questions (ask_user_question over Feishu, plugin-only) ----------
  // We intercept the ask_user_question tool dispatch on the tools/execute
  // waterfall — no harness source changes needed, so the open-source plugin
  // works on stock DSH builds. The question goes out as a plain message; the
  // next message in the chat is the answer, returned as the tool result.
  const pendingQuestions = new Map()    // chatId -> { resolve, reject, questions, timer }
  const recentQuestions = new Map()     // chatId -> { token, answeredAt } (last answered question card, for stale-tap hints)

  function buildQuestionAnswer(questions, text) {
    return {
      answers: questions.map((q) => {
        const opts = q.options || []
        if (opts.length === 0) return { id: q.id, selected: [], custom: text }
        const trimmed = String(text || '').trim()
        const num = parseInt(trimmed, 10)
        if (Number.isFinite(num) && num >= 1 && num <= opts.length) {
          return { id: q.id, selected: [opts[num - 1].label] }
        }
        const hit = opts.find((o) => o.label === trimmed
          || o.label.includes(trimmed) || trimmed.includes(o.label))
        if (hit) return { id: q.id, selected: [hit.label] }
        return { id: q.id, selected: [], custom: trimmed }
      }),
    }
  }

  // Question card (option buttons, ZCode-style). Feishu action rows hold up
  // to 5 buttons; more options fall back to the plain-text list.
  const QUESTION_MAX_BUTTONS = 5

  function questionCardPayload(q, token) {
    const opts = (q.options || []).slice(0, QUESTION_MAX_BUTTONS)
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '❓ 需要你的回答' }, template: 'blue' },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '**' + q.question + '**'
              + (q.detail ? '\n\n' + q.detail : '')
              + '\n\n点击选项，或直接回复文字。',
          },
        },
        {
          tag: 'action',
          actions: opts.map((o, i) => ({
            tag: 'button',
            text: { tag: 'plain_text', content: o.label },
            value: { fs_question: token, fs_option: i },
          })),
        },
      ],
    }
  }

  function questionResultCardPayload(q, label) {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '❓ 需要你的回答' }, template: 'green' },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '**' + q.question + '**\n\n✅ 已收到：' + label },
        },
      ],
    }
  }

  function askUserQuestion(bot, chatId, questions, signal, agentId) {
    return new Promise((resolve, reject) => {
      const q = questions[0]
      const opts = (q.options || []).slice(0, QUESTION_MAX_BUTTONS)
      const record = {
        resolve, reject, questions, timer: undefined, token: randomUUID(),
        cardId: undefined, bot, chatId, q, agentId,
      }
      pendingQuestions.set(chatId, record)
      record.timer = setTimeout(() => {
        if (pendingQuestions.get(chatId) === record) pendingQuestions.delete(chatId)
        reject(new Error('question timed out (30 min, no reply)'))
      }, 30 * 60 * 1000)
      if (signal && typeof signal.addEventListener === 'function') {
        const onAbort = () => {
          if (pendingQuestions.get(chatId) === record) pendingQuestions.delete(chatId)
          clearTimeout(record.timer)
          reject(new Error('ask_user_question aborted'))
        }
        signal.addEventListener('abort', onAbort)
      }
      // Options fit on buttons -> interactive card; otherwise plain text.
      if (opts.length > 0) {
        sendInteractive(bot, chatId, questionCardPayload(q, record.token))
          .then((msgId) => {
            record.cardId = msgId
            console.log('[fs] question card sent: ' + q.id + ' token=' + record.token)
          })
          .catch((error) => {
            console.log('[fs] question card send failed: ' + String(error && error.message || error))
            if (pendingQuestions.get(chatId) === record) pendingQuestions.delete(chatId)
            clearTimeout(record.timer)
            reject(new Error('question card send failed: ' + String(error && error.message || error)))
          })
        return
      }
      const lines = ['❓ **需要你的回答**', '', '**' + q.question + '**']
      if (q.detail) lines.push('', q.detail)
      lines.push('', '直接回复即可。')
      sendPlainText(bot, chatId, lines.join('\n')).catch((error) => {
        if (pendingQuestions.get(chatId) === record) pendingQuestions.delete(chatId)
        clearTimeout(record.timer)
        reject(new Error('question send failed: ' + String(error && error.message || error)))
      })
    })
  }

  // Take over ask_user_question for Feishu-owned agents: answer the question
  // in the chat and return a normal tool success, so stock DSH works as-is.
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'ask_user_question') return next()
    const owner = findChatForAgent(exec.agent)
    if (!owner) return next()
    console.log('[fs] ask_user_question intercepted for ' + exec.agent.id)
    const args = exec.arguments || {}
    const questions = Array.isArray(args.questions) ? args.questions : []
    if (questions.length === 0) return next()
    const answer = await askUserQuestion(owner.bot, owner.chatId, questions, exec.signal, exec.agent.id)
    return {
      isError: false,
      value: answer,
      content: [{ type: 'text', text: JSON.stringify(answer) }],
    }
  })

  // ---- admin routes (same-origin RPC) -----------------------------------------
  function respondJson(res, status, obj) {
    if (res.headersSent) return
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }

  function readBody(req, maxBytes) {
    return new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > (maxBytes || 65536)) {
          resolve(undefined)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve({}) }
      })
      req.on('error', () => resolve({}))
    })
  }

  function registerRoute(path, handler) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }))
  }

  function handleStatus(res) {
    const list = []
    for (const bot of bots.values()) {
      list.push({
        appId: bot.cfg.appId,
        name: bot.cfg.name,
        workspace: bot.cfg.workspace,
        connection: bot.status,
        hasSecret: !!bot.cfg.appSecret,
        lastChatId: bot.lastChatId,
      })
    }
    respondJson(res, 200, { ok: true, bots: list })
  }

  // ---- lifecycle --------------------------------------------------------------
  ctx.effect(() => {
    const stopTimer = ctx.interval(() => {
      void ensureHelpers()
      drainOutput()
    }, DRAIN_INTERVAL)
    return () => {
      stopping = true
      for (const bot of bots.values()) {
        try { if (bot.proc) bot.proc.kill() } catch { /* ignore */ }
      }
      bots.clear()
      stopTimer()
    }
  })

  registerRoute('/feishu/admin/status', (req, res) => {
    if (req.method !== 'GET') return respondJson(res, 405, { ok: false, message: 'method not allowed' })
    handleStatus(res)
  })
  registerRoute('/feishu/admin/config', async (req, res) => {
    if (req.method === 'GET') {
      const list = await readConfig()
      respondJson(res, 200, { ok: true, bots: list.map((b) => ({ ...b, appSecret: b.appSecret ? '***' : '' })) })
      return
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      const list = normalizeConfig(body)
      try {
        mkdirSync(configDir(), { recursive: true })
        writeFileSync(configPath(), JSON.stringify({ bots: list }, null, 2))
        respondJson(res, 200, { ok: true, message: '已保存 ' + list.length + ' 个机器人配置' })
      } catch (error) {
        respondJson(res, 500, { ok: false, message: String(error && error.message || error) })
      }
      return
    }
    respondJson(res, 405, { ok: false, message: 'method not allowed' })
  })

  // ---- model tool: proactive send -------------------------------------------------
  const tool = defineTool({
    name: 'feishu_send',
    description: 'Send a text message to a Feishu chat through a configured app bot (~/.dsh-feishucard/feishu.config.json). chatId is optional: it defaults to the most recent chat that messaged the bot. appId is optional: it selects which bot to use (defaults to the bot that last received a message). NOTE: replying to the user in an ongoing Feishu conversation does NOT need this tool — the reply is delivered as a card automatically; calling it mid-conversation sends a SECOND message and duplicates the answer.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text content to send.' },
      chatId: { type: 'string', description: 'Target chat id (oc_...). Omit to send to the most recent chat that messaged the bot.' },
      appId: { type: 'string', description: 'Bot app id (cli_...) to send through. Omit to use the bot that most recently received a message.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'number', required: true },
          detail: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: 'feishu_send -> ' + JSON.stringify(value) }],
    },
    async execute(args) {
      const list = await readConfig()
      const appId = typeof args.appId === 'string' && args.appId.length > 0 ? args.appId.trim() : undefined
      let bot
      if (appId) {
        const cfg = list.find((c) => c.appId === appId)
        if (!cfg) return { ok: false, status: 0, detail: '未找到 appId=' + appId + ' 对应的机器人配置' }
        bot = bots.get(appId) || { cfg, lastChatId: '' }
      } else {
        let best
        for (const b of bots.values()) {
          if (b.lastChatId && (!best || b.lastChatId > best.lastChatId)) best = b
        }
        if (!best && list.length > 0) {
          best = bots.get(list[0].appId) || { cfg: list[0], lastChatId: '' }
        }
        if (!best) return { ok: false, status: 0, detail: '没有配置任何机器人' }
        bot = best
      }
      const chatId = typeof args.chatId === 'string' && args.chatId.length > 0 ? args.chatId : undefined
      // 2026-09-15 修复：对话进行中不要另发一条消息。
      // 实测（CM 反馈"同一段东西分两个卡片发"）：agent 在回答时调用了 feishu_send，
      // 把同一段回复主动发了一遍；紧接着这段内容又作为最终回复进了流式卡
      // → 用户看到两张卡片、内容重复。飞书对话的回复本来就会自动显示在卡片上，
      // 所以"目标 chat 正是当前活跃 turn"时应当跳过，并明确告诉 agent 不需要它。
      const targetChat = chatId || bot.lastChatId
      if (targetChat) {
        const active = findActiveCardForChat(targetChat)
        if (active) {
          console.log('[fs] feishu_send skipped (active card in this chat): ' + targetChat)
          return {
            ok: true,
            status: 200,
            detail: '（已跳过）当前对话的回复会自动显示为飞书卡片，无需调用 feishu_send；'
              + '请直接把要说的内容作为最终回答输出。若确实要发到别的会话，请显式传 chatId。',
          }
        }
      }
      try {
        const res = await sendPlainText(bot, chatId, String(args.text))
        return { ok: res.status >= 200 && res.status < 300, status: res.status, detail: String(res.text || '').slice(0, 1000) }
      } catch (error) {
        return { ok: false, status: 0, detail: String(error && error.message || error) }
      }
    },
  })
  ctx.effect(() => ctx.tools.register(tool))

  // ---- 目标模式（goal round）过程上飞书 · 2026-09-16 CM 要求 -------------------
  // 背景：目标续轮由 `@deepseek-ai/dsh-goal-round-driver` 以「**同会话**注入一条
  // user/message，source.kind === 'goal'、带 round 号、内容为 <goal_round> 提示词」驱动；
  // 该轮产出的事件（assistant/message、tool/call、tool/result）与普通回合**完全同构**。
  // 但本插件的建卡入口 `runTurn` **只从飞书入站消息调用** → 目标轮没有卡承接
  // → CM 在飞书**完全看不到**目标模式在干什么（不是没发，是没有通道）。
  // 做法：监听 DSH 的 `agent/status`（emit 处：packages/core/agent-loop/src/agent.ts）
  //   · running 且该 agent 属于某个飞书聊天、当前**没有**活跃卡、且本轮触发消息是 goal 轮
  //     → 建卡「🎯 目标模式 · 第 N 轮」，复用**与普通回合同一套** watcher / syncCard
  //       → 过程话语内联、工具折叠面板、状态行、表格换卡全部照旧生效
  //   · idle → seal 该卡并写「✅ 本轮结束」
  // 开关：环境变量 DSH_FEISHU_GOAL_CARDS=0 全局关；per-bot 配置 notifyGoalRounds:false 单独关。
  // 范围（CM 拍板）：**只报目标轮**（精确匹配 source.kind==='goal'），不报其它自动回合，噪声最低。
  const GOAL_CARDS_ON = String(process.env.DSH_FEISHU_GOAL_CARDS ?? '1').trim() !== '0'
  const autoCards = new Map()     // agentId -> { card, bot, chatId, agent, openedAt, stop }

  // 本轮最后一段"过程话语"（用于封口时提升为正式消息块）。
  // 只从**本卡开始镜像的位置**往后找：本轮若一句话都没说，绝不能把上一轮的话搬过来。
  function lastAssistantTextSince(agent, fromIndex) {
    try {
      const events = sessionEvents(agent.session)
      for (let i = events.length - 1; i >= Math.max(0, fromIndex); i--) {
        const event = events[i]
        if (!event || event.type !== 'assistant/message') continue
        const spoken = extractProcessText(event.data && event.data.message)
        if (spoken) return { text: spoken, seq: event.seq }
      }
    } catch (error) {
      console.log('[fs] goal seal scan failed: ' + String(error && error.message || error))
    }
    return { text: '', seq: undefined }
  }

  // 本轮是否由目标轮驱动？看会话事件里**最后一条** user/message 的来源标记。
  function currentRoundIsGoal(agent) {
    try {
      const events = sessionEvents(agent.session)
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (!e || e.type !== 'user/message') continue
        const src = (e.data && e.data.source) || {}
        return { isGoal: src.kind === 'goal', round: Number(src.round) || 0 }
      }
    } catch (error) {
      console.log('[fs] goal round probe failed: ' + String(error && error.message || error))
    }
    return { isGoal: false, round: 0 }
  }

  function openGoalCard(agent, bot, chatId, info) {
    const state = { card: null, stop: null }
    // 表格额度换卡：与普通回合的 rotateTables 同机制（旧卡留表格，后续写新卡，游标接续不丢不重）
    const rotate = () => {
      if (!state.stop || !state.card || state.card.status !== 'running') return
      const carry = Number.isFinite(state.card.cursor) ? state.card.cursor : 0
      state.stop()
      state.card.status = 'sealed'
      void syncCard(bot, chatId, state.card, true).catch(() => {})
      const fresh = makeCardState()
      fresh.cursor = carry
      fresh.blocks.push({ type: 'message', text: '📊 上一张卡的表格已满（飞书单卡最多 5 张），后续内容在这张新卡继续。' })
      state.card = fresh
      void syncCard(bot, chatId, fresh, true).catch(() => {})
      state.stop = startCardWatcher(agent, fresh, bot, chatId, rotate)
      const live = autoCards.get(agent.id)
      if (live) live.card = fresh
    }
    const card = makeCardState()
    card.cursor = sessionEvents(agent.session).length      // 只镜像本轮**后续**事件（goal 提示词本身不搬上卡）
    card.blocks.push({ type: 'message', text: '🎯 目标模式 · 第 ' + (info.round || 1) + ' 轮开始，正在工作…' })
    state.card = card
    void syncCard(bot, chatId, card, true).catch(() => {})
    state.stop = startCardWatcher(agent, card, bot, chatId, rotate)
    return state
  }

  ctx.on('agent/status', ({ agent, status }) => {
    try {
      if (!agent || !agent.id) return

      if (status === 'idle') {
        const live = autoCards.get(agent.id)
        if (!live) return
        autoCards.delete(agent.id)
        try { if (live.stop) live.stop() } catch {}
        const card = live.card
        if (card) {
          // 封口前**必须补扫**（与普通回合 runTurn 的 catch-up scan 同源）：
          // 目标轮的收尾话语（"进度（第 N 轮）…"）几乎与轮结束同时到达，
          // watcher 一拍（300ms）常常来不及镜像 → 不补扫就会只剩工具记录、
          // 一句话都没有（CM 2026-09-16 反馈，取证：会话里 seq 有整段文字，卡上 notes=0）。
          try { scanCard(agent, card) } catch (error) {
            console.log('[fs] goal catch-up scan failed: ' + String(error && error.message || error))
          }
          // 把本轮最后一段话提升为**正式消息块**：过程话语有 500 字截断，
          // 轮次的进度汇报通常远超这个长度，截断后 CM 看不到实质内容。
          const closing = lastAssistantTextSince(agent, live.openedAt || 0)
          let promoted = false
          if (closing.seq !== undefined) {
            for (let i = card.blocks.length - 1; i >= 0; i--) {
              const block = card.blocks[i]
              if (block.type === 'note' && block.seq === closing.seq) {
                card.blocks[i] = { type: 'message', text: closing.text }
                promoted = true
                break
              }
            }
          }
          if (!promoted && closing.text) card.blocks.push({ type: 'message', text: closing.text })
          card.status = 'sealed'
          card.blocks.push({ type: 'message', text: '✅ 本轮结束' })
          void syncCard(live.bot, live.chatId, card, true).catch(() => {})
        }
        console.log('[fs] goal card sealed: agent=' + agent.id)
        return
      }
      if (status !== 'running') return
      if (!GOAL_CARDS_ON) return
      if (autoCards.has(agent.id)) return          // 已在跟踪这一轮
      if (activeTurns.has(agent.id)) return        // 普通飞书回合持有卡，绝不抢
      const where = findChatForAgent(agent)
      if (!where) return                           // 不是飞书会话（GUI/其它通道）
      const cfg = where.bot && where.bot.cfg
      if (cfg && cfg.notifyGoalRounds === false) return
      const info = currentRoundIsGoal(agent)
      if (!info.isGoal) return                     // 只报目标轮（CM 拍板口径）
      const state = openGoalCard(agent, where.bot, where.chatId, info)
      autoCards.set(agent.id, {
        card: state.card,
        bot: where.bot,
        chatId: where.chatId,
        agent,
        // 本卡开始镜像的位置：封口时用它界定"本轮说过的话"，防止把上一轮的文字搬过来
        openedAt: Number.isFinite(state.card.cursor) ? state.card.cursor : 0,
        stop: () => (state.stop ? state.stop() : undefined),
      })
      console.log('[fs] goal card opened: agent=' + agent.id + ' round=' + (info.round || 1) + ' chat=' + where.chatId)
    } catch (error) {
      console.log('[fs] agent/status handler error: ' + String(error && error.stack || error))
    }
  })

  console.log('[fs] bridge active. config: ' + configPath())
  void ensureHelpers()
}
