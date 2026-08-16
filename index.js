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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
        appId,
        appSecret: typeof bot.appSecret === 'string' ? bot.appSecret : '',
        reactionEmoji: typeof bot.reactionEmoji === 'string' ? bot.reactionEmoji : undefined,
        ownerOpenId: typeof bot.ownerOpenId === 'string' ? bot.ownerOpenId : '',
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
        const t = c.text.replace(/\s+/g, ' ').trim()
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

  function appendNote(card, text, seq) {
    const trimmed = String(text || '').trim()
    if (!trimmed) return
    const clipped = trimmed.length > MAX_NOTE_CHARS ? trimmed.slice(0, MAX_NOTE_CHARS) + '…' : trimmed
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
  function buildCardPayload(card) {
    const elements = []
    console.log('[fs] buildCardPayload: blocks=' + card.blocks.length
      + ' notes=' + card.blocks.filter((b) => b.type === 'note').length
      + ' tools=' + card.tools.size)
    for (const block of card.blocks) {
      if (block.type === 'message' || block.type === 'note') {
        const text = (block.text || '').trim()
        if (text) elements.push({ tag: 'markdown', content: text })
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
    // Window fold: keep the NEWEST content visible (live progress + conclusion
    // at the bottom), fold the ALREADY-SEEN history into one panel at the TOP.
    // The last KEEP_TAIL elements are never folded (2026-08-15 CM design).
    if (elements.length > 40) {
      const KEEP_TAIL = 10
      const head = elements.slice(0, elements.length - KEEP_TAIL)
      const tail = elements.slice(elements.length - KEEP_TAIL)
      const extraLines = []
      let extraPanels = 0
      for (const el of head) {
        if (el.tag === 'markdown') {
          if (el.content) extraLines.push(el.content)
        } else {
          extraPanels += 1
          const inner = el.elements && el.elements[0]
          if (inner && inner.tag === 'markdown' && inner.content) extraLines.push(inner.content)
        }
      }
      if (extraLines.length > 0) {
        tail.unshift({
          tag: 'collapsible_panel',
          expanded: false,
          background_color: 'grey-50',
          border: { color: 'grey', corner_radius: '8px' },
          padding: '8px 8px 8px 8px',
          header: {
            title: { tag: 'plain_text', content: '📎 更早过程 (' + (elements.length - KEEP_TAIL) + ')' },
            vertical_align: 'center',
            padding: '8px 8px 8px 8px',
            icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '16px 16px' },
            icon_position: 'right',
            icon_expanded_angle: -180,
          },
          elements: [{ tag: 'markdown', content: extraLines.join('\n\n').slice(0, 3000) }],
        })
      }
      elements.length = 0
      for (const el of tail) elements.push(el)
    }
    if (elements.length === 0) elements.push({ tag: 'markdown', content: ' ' })
    if (card.status !== 'sealed') {
      const statusText = card.status === 'completed' ? '_已完成_'
        : card.status === 'error' ? '_失败_'
        : '_运行中…_'
      elements.push({ tag: 'markdown', content: statusText })
    }
    return { schema: '2.0', config: { wide_screen_mode: true }, body: { elements } }
  }

  // Serialized, rate-limited, backoff'd, breakered card sync.
  function syncCard(bot, chatId, card, force) {
    if (!card || !bot || card.circuitOpen) return card.queue
    const now = Date.now()
    if (now < card.retryUntil) return card.queue
    if (card.token && !force && now - card.lastSyncAt < CARD_MIN_INTERVAL) return card.queue
    card.queue = card.queue.catch(() => {}).then(async () => {
      const payload = buildCardPayload(card)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('card request timed out')), CARD_TIMEOUT)
      try {
        if (card.token) {
          await updateInteractive(bot, card.token, payload, controller.signal)
        } else {
          const messageId = await sendInteractive(bot, chatId, payload, controller.signal)
          card.token = messageId
        }
        card.lastSyncAt = Date.now()
        card.failCount = 0
        card.retryUntil = 0
      } catch (error) {
        card.failCount += 1
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

  // Scan the agent session event log from `fromRef.from` and mirror new events
  // into the card. Returns true if anything changed. Shared by the periodic
  // watcher and the seal-time catch-up scan so a fast turn still gets its
  // narration + tool panels on the card.
  function scanEvents(agent, fromRef, card) {
    const events = agent.session.events
    let changed = false
    for (let i = fromRef.from; i < events.length; i++) {
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
    fromRef.from = events.length
    return changed
  }

  // Poll the agent session event log and mirror new events into the card.
  function startCardWatcher(agent, seqFrom, card, bot, chatId) {
    const fromRef = { from: seqFrom }
    const timer = setInterval(() => {
      if (card.sealing) return
      try {
        if (scanEvents(agent, fromRef, card)) {
          void syncCard(bot, chatId, card, false).catch(() => {})
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

  async function createDedicated(bot, sessionId) {
    const agents = ctx.get('agents')
    if (!agents) throw new Error('agents service unavailable')
    const cfg = bot.cfg
    return agents.create({
      sessionId,
      meta: { cwd: (cfg.workspace && String(cfg.workspace).trim()) || workspaceRoot() || undefined },
      ...(defaultAgentOptions() ? { agentOptions: defaultAgentOptions() } : {}),
      setup: async (agentCtx) => {
        const presets = agentCtx.get('agentPresets')
        if (!presets) return
        try {
          await presets.mount(agentCtx)
        } catch (error) {
          console.log('[fs] preset mount failed: ' + String(error && error.message || error))
        }
      },
    })
  }

  async function resumeDedicated(bot, sessionId) {
    const agents = ctx.get('agents')
    if (!agents) throw new Error('agents service unavailable')
    return agents.resume({
      resumeSessionId: sessionId,
      ...(defaultAgentOptions() ? { agentOptions: defaultAgentOptions() } : {}),
    })
  }

  // ---- chat/session bookkeeping ---------------------------------------------
  function loadChats(bot) {
    const state = readState(bot.cfg.appId)
    const chats = new Map()
    for (const [chatId, record] of Object.entries(state.chats || {})) {
      const sessions = Array.isArray(record && record.sessions) ? record.sessions : []
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
        sessions: chat.sessions.map((s) => ({ id: s.id, label: s.label, type: s.type })),
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
  const COMMANDS = ['help', 'new', 'switch', 'list', 'plan', 'stop']

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

  async function handleCommand(bot, chat, chatId, cmd) {
    const resolved = resolveCommandName(cmd.name)
    if (!resolved) return false
    if (resolved === 'help') {
      await sendPlainText(bot, chatId,
        '/new [名称] 新建会话\n/switch <序号> 切换会话\n/list 列出会话\n/plan [off] 计划模式开关\n/stop 停止当前任务\n/help 帮助')
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
    if (resolved === 'new') {
      const sessionId = 'fs-main-' + Date.now().toString(36)
      const handle = await createDedicated(bot, sessionId)
      chat.sessions.push({ id: sessionId, label: cmd.arg || ('会话 ' + (chat.sessions.length + 1)), type: 'dedicated', handle })
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
      const n = parseInt(cmd.arg, 10)
      if (!Number.isFinite(n) || n < 1 || n > chat.sessions.length) {
        await sendPlainText(bot, chatId, '序号无效：/switch <1-' + chat.sessions.length + '>')
        return true
      }
      chat.activeIndex = n - 1
      persistChats(bot, bot.chats)
      await sendPlainText(bot, chatId, '已切换到会话 ' + n + '「' + chat.sessions[n - 1].label + '」')
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
      const text = typeof parsed.text === 'string' ? parsed.text : ''
      const mentions = parsed.mentions
      if (!mentions || !Array.isArray(mentions)) return text
      let out = text
      for (const m of mentions) {
        if (m && typeof m.key === 'string' && typeof m.denote_text === 'string') {
          out = out.split(m.key).join(m.denote_text)
        }
      }
      return out
    } catch {
      return ''
    }
  }

  async function handleInbound(bot, evt) {
    const chatId = evt.chat_id
    if (!chatId) return
    bot.lastChatId = chatId

    const messageId = evt.message_id
    const text = extractText(evt.content)
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
      pendingQ.resolve(buildQuestionAnswer(pendingQ.questions, text))
      await sendPlainText(bot, chatId, '✅ 已收到你的回答。')
      return
    }

    // Ensure a dedicated session exists for this chat.
    let chat = bot.chats.get(chatId)
    let agent
    if (!chat || chat.sessions.length === 0) {
      chat = { sessions: [], activeIndex: 0 }
      bot.chats.set(chatId, chat)
      const sessionId = 'fs-main-' + Date.now().toString(36)
      try {
        const handle = await createDedicated(bot, sessionId)
        chat.sessions = [{ id: sessionId, label: '主会话', type: 'dedicated', handle }]
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
      agent = await resolveAgent(bot, chat)
      if (!agent) {
        // The previous session could not be resumed (DSH refuses to prepare a
        // session still marked live, e.g. after a hard kill of dsh web). Fall
        // back to creating a fresh session automatically so the user's message
        // always gets a reply; keep the old entry in the list for reference.
        const sessionId = 'fs-main-' + Date.now().toString(36)
        try {
          const handle = await createDedicated(bot, sessionId)
          chat.sessions.push({ id: sessionId, label: '会话 ' + (chat.sessions.length + 1), type: 'dedicated', handle })
          chat.activeIndex = chat.sessions.length - 1
          persistChats(bot, bot.chats)
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
    const seqBefore = agent.session.events.length
    const message = {
      id: 'fs-' + messageId,
      role: 'user',
      content: [{ type: 'text', text: label + text }],
      source: { kind: 'user' },
    }
    agent.send(message, 'next-turn', true)

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

    // Streaming reply card for this turn.
    const card = makeCardState()
    card.blocks.push({ type: 'message', text: '正在工作中…' })
    void syncCard(bot, chatId, card, true).catch(() => {})
    const stopCardWatcher = startCardWatcher(agent, seqBefore, card, bot, chatId)

    try {
      await agent.whenIdle()
    } catch (error) {
      console.log('[fs] turn wait failed for ' + messageId + ': ' + String(error && error.message || error))
      stopCardWatcher()
      card.status = 'error'
      void syncCard(bot, chatId, card, true).catch(() => {})
      removeReactionOnce()
      return
    }
    stopCardWatcher()

    // Catch-up scan: if the turn finished faster than the watcher's poll
    // interval, fold every event into the card now so narration and tool
    // panels are not lost.
    scanEvents(agent, { from: seqBefore }, card)

    // Seal: promote the last note (the final reply) to a message block so the
    // reply is not duplicated as narration; drop the placeholder; kill the
    // status line.
    const events = agent.session.events
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

    let cardDelivered = false
    try {
      await syncCard(bot, chatId, card, true)
      cardDelivered = !!card.token && !card.circuitOpen
    } catch {
      cardDelivered = false
    }
    if (!cardDelivered) {
      try {
        const res = await sendPlainText(bot, chatId, reply)
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
  const APPROVAL_TIMEOUT_MS = 3 * 60 * 1000

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
                + '\n\n是否允许执行（仅本次）？\n⏰ 3 分钟内未操作将自动拒绝。',
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

  function handleCardAction(data) {
    console.log('[fs] card action event received: tag=' + (data && data.action && data.action.tag || '?'))
    const action = data && data.action ? data.action : {}
    const value = action.value || {}
    // Question-option buttons (ask_user_question card).
    if (value.fs_question !== undefined && value.fs_option !== undefined) {
      const chatId = data && data.context && data.context.open_chat_id
      const record = chatId ? pendingQuestions.get(chatId) : undefined
      if (!record || record.token !== value.fs_question) {
        console.log('[fs] question button: record not found for chat ' + chatId)
        return
      }
      const q = record.questions[0]
      const opts = (q.options || []).slice(0, QUESTION_MAX_BUTTONS)
      const opt = opts[Number(value.fs_option)]
      if (!opt) {
        console.log('[fs] question button: bad option index ' + value.fs_option)
        return
      }
      pendingQuestions.delete(chatId)
      if (record.timer) clearTimeout(record.timer)
      console.log('[fs] question answered via button: ' + q.id + ' -> ' + opt.label)
      record.resolve(buildQuestionAnswer(record.questions, opt.label))
      if (record.cardId) {
        updateInteractive(record.bot, record.cardId, questionResultCardPayload(q, opt.label))
          .catch((error) => {
            console.log('[fs] question card update failed: ' + String(error && error.message || error))
          })
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

  // ---- user questions (ask_user_question over Feishu, plugin-only) ----------
  // We intercept the ask_user_question tool dispatch on the tools/execute
  // waterfall — no harness source changes needed, so the open-source plugin
  // works on stock DSH builds. The question goes out as a plain message; the
  // next message in the chat is the answer, returned as the tool result.
  const pendingQuestions = new Map()    // chatId -> { resolve, reject, questions, timer }

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

  function askUserQuestion(bot, chatId, questions, signal) {
    return new Promise((resolve, reject) => {
      const q = questions[0]
      const opts = (q.options || []).slice(0, QUESTION_MAX_BUTTONS)
      const record = {
        resolve, reject, questions, timer: undefined, token: randomUUID(),
        cardId: undefined, bot, chatId, q,
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
    const answer = await askUserQuestion(owner.bot, owner.chatId, questions, exec.signal)
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
    description: 'Send a text message to a Feishu chat through a configured app bot (~/.dsh-feishucard/feishu.config.json). chatId is optional: it defaults to the most recent chat that messaged the bot. appId is optional: it selects which bot to use (defaults to the bot that last received a message).',
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
      try {
        const res = await sendPlainText(bot, chatId, String(args.text))
        return { ok: res.status >= 200 && res.status < 300, status: res.status, detail: String(res.text || '').slice(0, 1000) }
      } catch (error) {
        return { ok: false, status: 0, detail: String(error && error.message || error) }
      }
    },
  })
  ctx.effect(() => ctx.tools.register(tool))

  console.log('[fs] bridge active. config: ' + configPath())
  void ensureHelpers()
}
