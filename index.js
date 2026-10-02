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
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync,
} from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
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
const NOTICE_POLL_MS = 1000          // 子代理回执轮询间隔（改造①，必须独立于回合状态）
// CM 2026-10-01 B 方案（同日 17:3x 修正一次口径）：本轮耗时 ≥ 此阈值 ⇒ **结论独立成一张新卡**
// （新卡＝新消息 ⇒ 飞书会提醒；过程卡退化成"工作日志"）。
// ⚠️ 修正原因（真机实测）：原规则还带一条"有工具调用就分卡"，但实测**几乎每一轮都有工具调用**
//    ⇒ 该条件形同虚设，12 秒的短任务也被分成两张卡（CM：「短任务都变了两张卡了」）。
//    现在**只按耗时**判定。阈值优先级：**bot 配置 `splitConclusionMinMs`（热更新，10s 生效）**
//    → 环境变量 `DSH_FEISHU_SPLIT_MIN_MS` → 默认 30 秒。每次判读（不是启动读一次）⇒ 可热调、测试可逐用例设。
const CONCLUSION_SPLIT_DEFAULT_MS = 30000
function conclusionSplitMinMs(bot) {
  const cfgVal = bot && bot.cfg ? Number(bot.cfg.splitConclusionMinMs) : NaN
  if (Number.isFinite(cfgVal) && cfgVal >= 0) return cfgVal
  const raw = Number(process.env.DSH_FEISHU_SPLIT_MIN_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : CONCLUSION_SPLIT_DEFAULT_MS
}
const SESSION_GEN = 2                // session-state schema gen; gen<2 sessions predate the standard-preset mount and never saw file/shell tools
const DRAIN_INTERVAL = 500           // helper stdout drain interval
const CONFIG_REFRESH_MS = 10000      // config hot-reload cadence
const STATUS_INTERVAL = 10000        // helper status line cadence

// 构建标记（2026-09-18 落地复验教训）：此前要确认"线上到底跑的是哪一份 index.js"，
// 只能靠外部 md5 比对源码与 profile 副本 —— 太绕，而且副本是实体拷贝（HMR 碰不到它）。
// 现在 apply 时直接打印**自身文件**的版本与 md5：`grep 'plugin apply'` 一眼可查。
// 版本取**部署目录里**的 package.json —— 元数据陈旧（副本曾长期停在 0.2.0）会在这里露出来。
function buildStamp() {
  try {
    const self = fileURLToPath(import.meta.url)
    let version = '?'
    try {
      const pkg = JSON.parse(readFileSync(join(dirname(self), 'package.json'), 'utf8'))
      version = String(pkg && pkg.version || '?')
    } catch { /* 缺 package.json 不影响运行，只影响标记里的版本号 */ }
    const bytes = readFileSync(self)
    return 'v' + version + ' md5=' + createHash('md5').update(bytes).digest('hex').slice(0, 8)
      + ' bytes=' + bytes.length
  } catch (error) {
    return 'stamp failed: ' + String(error && error.message || error)
  }
}

export function apply(ctx) {
  if (globalThis.__dshFeishucardApplyCount === undefined) globalThis.__dshFeishucardApplyCount = 0
  globalThis.__dshFeishucardApplyCount += 1
  console.log('[fs] plugin apply #' + globalThis.__dshFeishucardApplyCount + ' ' + buildStamp()
    + ' @ ' + new Date().toISOString())
  let stopping = false
  let lastConfigCheck = 0
  let lastSpawnAt = 0
  const bots = new Map()             // appId -> Bot runtime

  // Agent -> live streaming-card context of its current turn. Lets the
  // ask_user_question flow freeze the *old* card (the one sitting above the
  // question card) and hand the agent's post-answer narration to a *new*
  // card below it — otherwise updates land on the stale card the user can no
  // longer see (2026-09-08 CM report).
  // ⚠️ 2026-10-02（CM 报障「卡片又有重复」）：这张表**必须跨插件代际存活**。
  // 实证（web.log 69810→69833）：热重载后 `activeTurns` 被清空 ⇒ CM 紧接着发的那条消息
  // 查不到活跃回合 ⇒ **没有插话，而是另起一轮、另开一张卡**；与此同时上一代那条仍在跑的
  // 回合继续更新它自己的卡 ⇒ 同一对话里两张卡并行长（＝"重复"）。
  // 处置：挂到 globalThis —— 新实例能直接看见上一代正在跑的回合（entry 里的
  // agent / card / bot / chatId / split 都跨代可用），于是照旧走插话那条路。
  const activeTurns = globalThis.__fsActiveTurns
    || (globalThis.__fsActiveTurns = new Map())   // agentId -> { card, bot, chatId, split }

  // 刚封口的普通回合卡：agentId -> { card, bot, chatId, sealedAt }
  // 2026-09-27（CM 实证："每次发东西，大部分都会一个内容发两次"）：
  // 普通回合卡封口后，同一轮里紧接着起的 goal/notice 自动轮**又开一张新卡**，
  // 两张卡同源镜像同一批会话事件 → 用户看到同内容两张卡。
  // 处置：自动轮开卡前先看这张表 —— 短时间内（AUTO_CARD_REUSE_MS）同一个群刚封过卡，
  // 就把这一轮**接在那张卡上**，不再另开（正文照旧不丢、也不重复）。
  // 2026-10-02 代码审查 low#11：这张表也必须**跨代际**共享 —— 两个兄弟
  // （activeTurns / liveCardRegistry）已经搬到 globalThis，而热重载会清空每代模块状态：
  // 一重载，3 分钟的复用窗口就没了，紧接着起的 goal 轮又会另开一张卡去镜像同一批事件
  //（正是这张表要防的"同内容两张卡"）。
  const recentTurnCards = globalThis.__fsRecentTurnCards
    || (globalThis.__fsRecentTurnCards = new Map())
  const AUTO_CARD_REUSE_MS = 3 * 60 * 1000

  // 跨代际之后这张表**不再随代际清空**，所以得自己收（2026-10-02 审查 low）：
  // 每条还钉着封口卡（含 blocks）与**上一代的 bot**，而 agentId 每建一个会话就换一个
  //（/new、`fs-main-<ts>`）⇒ 不剔就是随会话数无限增长。
  function pruneRecentTurnCards(now) {
    const at = Number(now) || Date.now()
    for (const [key, value] of Array.from(recentTurnCards)) {
      if (!value || at - (Number(value.sealedAt) || 0) > AUTO_CARD_REUSE_MS) recentTurnCards.delete(key)
    }
  }

  // 写入即剔（第三轮门槛 low）：读路径上的 prune 位于一串提前 return **之后**
  //（关掉自动卡 / per-bot 通知开关时根本走不到）⇒ 剔除必须挂到**写**这一侧，
  // 否则这张跨代际的表照样按"每个 agentId 一条"无限涨。
  function rememberRecentTurnCard(agentId, entry) {
    pruneRecentTurnCards()
    recentTurnCards.set(agentId, entry)
  }

  // agent 作用域监听的注销函数（2026-10-02 代码审查 high#1）——
  // `agent.ctx` 是**长生命周期**的：HMR 只换插件代际、不换 agent。每代都往同一个
  // agent.ctx 上再挂一条 approval/request / user-questions/request，老闭包就把整代插件
  // （bots / pendingApprovals …）钉在内存里；而且瀑布流里**最早的监听先被调用**
  // ⇒ 可能是上一代在应答。这里留住 disposer，随本代卸载一起注销（见 ctx.effect）。
  const agentScopeDisposers = []

  // 载荷/正文指纹（只为留痕：飞书对 2.0 卡片只回占位符，正文读不回来；
  // 有了指纹就能在日志里直接比对"两张卡是不是同一段内容"）。djb2，无依赖。
  function shortHash(s) {
    let h = 5381
    const str = String(s)
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0
    return h.toString(16).padStart(8, '0')
  }

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

  // ---- 消息索引（改造⑤ 引用透传，CM 2026-10-01 定）----------------------------
  // 飞书入站消息带 `parent_id`（CM 引用的是哪一条），旧实现只取正文 ⇒ agent 看不出
  // CM 回的是哪张卡、哪条消息。这里把"发出去的卡片/消息"和"CM 发来的消息"登记成
  // message_id -> 摘要；入站命中 parent_id 时把摘要随正文一起注入会话。
  // 只用本地登记表：**不新增任何飞书权限**（GET /im/v1/messages 需要读消息 scope，
  // 当前应用没开；本地表覆盖"引用我们自己的卡片/消息"这一主场景）。
  const recentMessages = new Map()      // messageId -> { label, at }
  const RECENT_MESSAGE_MAX = 300        // 只留最近若干条，避免长跑内存无界增长
  // ⚠️ 2026-10-01 真机实证（CM 引用一张卡片，卡面回「内容未登记，可能是更早的消息」）：
  //    登记表原本**只在内存**里，而 dsh 重启（改插件代码/框架升级）会把它清空
  //    ⇒ **重启前发出的卡片一律查不到**（实证：CM 引的卡 `om_x100b64d11132f0a0b0484fbba40a0ca`
  //    建于 v0.4.10 重启之前，日志 `card created … 65263` vs `plugin apply … 65275`）。
  //    ⇒ 落盘到 `~/.dsh-feishucard/message-index.json`（沿用已有 state 目录，**零新增飞书权限**）：
  //      启动时加载；**未命中时再读一次盘**（覆盖"本进程启动前写进去的"这一类）。
  const MESSAGE_INDEX_FLUSH_MS = 300
  let messageIndexTimer = null

  function messageIndexPath() {
    return join(configDir(), 'message-index.json')
  }

  function flushMessageIndex() {
    messageIndexTimer = null
    try {
      const out = {}
      for (const [id, value] of recentMessages) out[id] = value
      writeFileSync(messageIndexPath(), JSON.stringify(out))
    } catch (error) {
      console.log('[fs] message index write failed: ' + String(error && error.message || error))
    }
  }

  function scheduleMessageIndexFlush() {
    if (messageIndexTimer) return
    messageIndexTimer = setTimeout(() => { try { flushMessageIndex() } catch {} }, MESSAGE_INDEX_FLUSH_MS)
    // 定时器不该拖住进程退出（冒烟测试/重启都受影响）
    if (messageIndexTimer && typeof messageIndexTimer.unref === 'function') messageIndexTimer.unref()
  }

  function loadMessageIndex() {
    let added = 0
    try {
      const obj = JSON.parse(readFileSync(messageIndexPath(), 'utf8') || '{}')
      for (const [id, value] of Object.entries(obj || {})) {
        if (!id || !value || typeof value.label !== 'string') continue
        // 2026-10-02 代码审查 low#10：**内存里已有的条目不许被盘上的旧值盖回去**。
        // quoteHintFor() 每次未命中都会再读一次盘（"每条引用都 readFileSync + JSON.parse"
        // 就是这么来的），而卡片每次成功同步都会重取标签、只等 300ms 去抖落盘
        // ⇒ 覆盖会把刚刷新的标签退回旧值。跳过快照里已有的 key，只补磁盘新增的。
        if (recentMessages.has(id)) continue
        recentMessages.set(id, { label: value.label, at: Number(value.at) || 0 })
        added += 1
      }
      while (recentMessages.size > RECENT_MESSAGE_MAX) {
        const oldest = recentMessages.keys().next().value
        recentMessages.delete(oldest)
      }
    } catch { /* 没有索引文件／内容坏了都属正常：查不到就照实说「未登记」 */ }
    return added
  }

  function rememberMessage(messageId, label) {
    const id = String(messageId || '')
    if (!id) return
    if (recentMessages.has(id)) recentMessages.delete(id)
    recentMessages.set(id, { label: String(label || '').replace(/\s+/g, ' ').slice(0, 100), at: Date.now() })
    while (recentMessages.size > RECENT_MESSAGE_MAX) {
      const oldest = recentMessages.keys().next().value
      recentMessages.delete(oldest)
    }
    scheduleMessageIndexFlush()
  }

  // 卡片的"引用摘要"该取哪一句（2026-10-01 真机实证）：
  //   CM 引用一张卡 → 卡面回「bot 的回复卡片：正在工作中…」—— 建卡那一刻卡片里**只有占位符**，
  //   登记它等于没登记。卡片内容是随回合推进才成形的 ⇒ 每次成功同步都重取一次。
  //   取法：跳过占位符/指路语，优先**最后一段正文**（封口后的结论最有信息量）。
  const CARD_LABEL_SKIP = new Set([
    '正在工作中…', '继续处理中…',
    '✅ 本轮完成，结论见下方卡片。', '✅ 已收到你的选择，继续处理中…',
  ])

  function cardLabel(card) {
    const blocks = (card && card.blocks) || []
    let best = ''
    for (const block of blocks) {
      if (block && block.type === 'message' && block.text && !CARD_LABEL_SKIP.has(block.text)) best = block.text
    }
    if (!best) {
      // 还在跑（或只有占位符）时退到**最后一条过程话语**（例如 `🎯 <目的>`）——
      // 它比「正在工作中…」有信息量；都取不到就给中性文案，**绝不留占位符**。
      for (const block of blocks) {
        if (block && block.type === 'note' && block.text && !CARD_LABEL_SKIP.has(block.text)) best = block.text
      }
    }
    if (!best) best = '（内容还在生成中）'
    return 'bot 的回复卡片：' + String(best).replace(/\s+/g, ' ').slice(0, 60)
  }

  function quoteHintFor(parentId) {
    if (!parentId) return ''
    const key = String(parentId)
    let hit = recentMessages.get(key)
    if (!hit) {
      // 未命中 ⇒ 再读一次落盘索引：重启前登记的卡片就在那里（**不许猜内容**，
      // 读不到就照实写「未登记」——见 ~/.dsh/AGENTS.md A24 禁无出处断言）。
      loadMessageIndex()
      hit = recentMessages.get(key)
    }
    const what = hit && hit.label ? '：' + hit.label : '（内容未登记，可能是更早的消息）'
    return '\n\n（你在引用这条消息' + what + '）'
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

  // 引用透传（改造⑤）：消息索引落盘 → **重启后仍能查出"CM 引的是哪一条/哪张卡"**
  // （2026-10-01 真机实证：不落盘时，重启前发出的卡片一律回「内容未登记」）。
  try {
    const loaded = loadMessageIndex()
    if (loaded > 0) console.log('[fs] message index loaded: ' + loaded + ' entries')
  } catch (error) {
    console.log('[fs] message index load skipped: ' + String(error && error.message || error))
  }

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
        // 2026-09-21：后台回执轮（子代理／后台 job 完成把模型唤醒）过程卡开关；未设置=开
        notifyAgentNotices: typeof bot.notifyAgentNotices === 'boolean' ? bot.notifyAgentNotices : undefined,
        // 2026-10-01 修复（smoke 38 抓出）：此前**漏在白名单外** ⇒ 配置里写了也被丢掉，
        // 文档承诺的「bot 配置优先（10s 热读、免重启）」实际不成立（只有 env／默认值生效）。
        splitConclusionMinMs: (Number.isFinite(Number(bot.splitConclusionMinMs)) && Number(bot.splitConclusionMinMs) >= 0)
          ? Number(bot.splitConclusionMinMs) : undefined,
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

  // 删掉一条自己发的消息（2026-10-02 CM：「加一个取消按钮，一按取消，这个卡片就撤销掉」）
  async function deleteMessage(bot, messageId) {
    if (!bot || !messageId) return false
    try {
      const accessToken = await tenantAccessToken(bot, bot.cfg.appId, bot.cfg.appSecret)
      const res = await httpJson(
        'https://open.feishu.cn/open-apis/im/v1/messages/' + encodeURIComponent(messageId),
        'DELETE',
        { Authorization: 'Bearer ' + accessToken },
        undefined,
      )
      const parsed = parseJson(res.text)
      const okDel = res.status >= 200 && res.status < 300 && parsed && parsed.code === 0
      if (!okDel) {
        console.log('[fs] delete message failed: status=' + res.status + ' '
          + String(res.text || '').slice(0, 160))
      }
      return okDel
    } catch (error) {
      console.log('[fs] delete message error: ' + String(error && error.message || error))
      return false
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
    // 改造⑤：把发出去的消息登记进本地索引，CM 引用它时能把摘要带进会话
    try {
      const parsed = parseJson(res.text)
      rememberMessage(parsed && parsed.data && parsed.data.message_id, 'bot 的一条消息：' + String(text))
    } catch {}
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
  // 2026-10-01（改造③）：卡片必须知道自己是**哪个 agent** 的 —— 底部「目标条」
  // （目标全文/状态/上下文/缓存命中）要从该 agent 的会话里现读。
  // 不传 agent 时保持 null：buildCardPayload 见到 null 就整块跳过（优雅降级）。
  function makeCardState(agent) {
    return {
      agent: agent || null,
      // 底部状态栏形态（CM 2026-10-01 定 A 方案）：
      //   'full' = 灰底那条（状态 ｜ 目标 ｜ 上下文占比 ｜ 缓存命中）—— **结论卡 / 自动卡**用
      //   'bare' = 只有一行裸状态（运行中… / ✅ 已完成）—— **普通回合的过程卡**用（工作日志不摆状态栏）
      // 分卡只有到**封口时**才知道 ⇒ 过程卡先设 bare；若不满足分卡条件（短任务），
      // 封口时升级成 full（那张卡本身就是结论卡）。
      footerMode: 'full',
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

  // 纯目的行旁白：全部非空行都以 🎯 开头（项目约定：每次调用工具前先写一行 🎯 目的）。
  // 这类文本是「过程旁白」，**不构成对用户的答复** —— 封口时不能拿它当结论，否则会产出
  // 只含一行 🎯 的无信息结论卡（turn 9 体检已把它列为验收项：新增数必须为 0）。
  function isNarrationOnly(text) {
    const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean)
    if (lines.length === 0) return false
    return lines.every((line) => line.startsWith('🎯'))
  }

  // 本轮失败原因 —— 只认上游**显式标记**，不靠文案去猜（开发标准 §10.2-2）：
  //   turn/end          → data.reason = { kind:'error', error:{ message, code, status } }
  //   assistant/attempt → data.stream[].chunk = { type:'finish', reason:{ kind:'error', failure:{...} } }
  // 背景（2026-09-18 真机事故，会话 fs-main-mu532zzl seq=724-727）：账户余额不足时上游返回
  // 402 QUOTA「Insufficient Balance」，整轮**一个 assistant/message 都没有**；旧实现只写
  // 「（Agent 未产生文字回复）」、状态行还显示「✅ 已完成」→ CM：'我都不知道它为什么突然不回我了'。
  function failureSummary(failure) {
    const message = String(failure && failure.message || '').trim()
    const code = String(failure && failure.code || '').trim()
    const status = failure && failure.status !== undefined && failure.status !== null ? String(failure.status) : ''
    const tag = [code, status].filter(Boolean).join(' ')
    const zh = failureZh(failure)
    const raw = message + (tag ? ' · ' + tag : '')
    return {
      message,
      code,
      status,
      zh,
      // 中文人话在前、上游原文在后（用户 2026-09-21：「它不会提示我欠费」——
      // 「Insufficient Balance · QUOTA 402」摆在卡面上等于没说）。
      text: (zh ? zh + '｜' : '') + (raw || '原因未上报（上游没有给出错误内容）'),
    }
  }

  // 已知上游错误的**人话**。只做最保守的映射（认不出就不编，原样透传）。
  function failureZh(failure) {
    const code = String(failure && failure.code || '').toUpperCase()
    const status = failure && failure.status !== undefined && failure.status !== null ? String(failure.status) : ''
    const message = String(failure && failure.message || '')
    if (code === 'QUOTA' || status === '402' || /insufficient\s*(balance|quota)|balance/i.test(message)) {
      return '账户欠费／余额不足'
    }
    if (status === '401' || code === 'AUTH' || /invalid\s*api\s*key|unauthor/i.test(message)) return 'API 密钥无效或未授权'
    if (status === '429' || code === 'RATE_LIMIT' || /rate\s*limit|too\s*many\s*requests/i.test(message)) return '被上游限流（请求过快）'
    if (status === '503' || /overloaded|service\s*unavailable/i.test(message)) return '上游暂时不可用'
    if (/context\s*window|too\s*long|maximum\s*context/i.test(message)) return '上下文超长'
    return ''
  }

  // turn/end 是本轮的**终审**：只要它存在就以它为准（中途某步失败后重试成功的回合，
  // 不能再被 assistant/attempt 里的旧失败误判成失败）。没有 turn/end 时才回退看 attempt。
  function turnFailureReason(events, fromSeq) {
    for (let i = events.length - 1; i >= fromSeq; i--) {
      const event = events[i]
      if (!event || event.type !== 'turn/end') continue
      const reason = event.data && event.data.reason
      return reason && reason.kind === 'error' && reason.error ? failureSummary(reason.error) : null
    }
    for (let i = events.length - 1; i >= fromSeq; i--) {
      const event = events[i]
      if (!event || event.type !== 'assistant/attempt') continue
      const stream = event.data && event.data.stream
      if (!Array.isArray(stream)) continue
      for (let j = stream.length - 1; j >= 0; j--) {
        const chunk = stream[j] && stream[j].chunk
        const reason = chunk && chunk.type === 'finish' ? chunk.reason : null
        if (reason && reason.kind === 'error' && reason.failure) return failureSummary(reason.failure)
      }
    }
    return null
  }

  // 插话提示的醒目样式（2026-10-02 CM：「加个框，然后加粗，或者换个颜色」）。
  // 颜色取自飞书官方枚举：14 色系（blue/carmine/green/indigo/lime/orange/purple/red/
  // sunflower/turquoise/violet/wathet/yellow/grey）+ 深浅后缀，**-50 的语义就是「区块背景」**。
  // 注意：column_set **不支持** border（会被 API 拒 ErrCode 200621）—— 底块靠 background_style。
  // 换色只改这一行（候选：blue-50 冷静 / wathet-50 浅青 / yellow-50 亮黄）。
  const STEER_NOTICE_BG = 'orange-50'
  const STEER_NOTICE_TITLE = '📨 你的消息已插话送达'
  const MAX_NOTE_CHARS = 500

  // 2026-10-01（改造② 中文目的行）：CM 要求「每个工具调用前能看到一行中文目的」。
  // 目的行由约定层产出（agent 每次调工具前写一行 `🎯 …`，**不带"目的："前缀** —— CM 2026-10-01 当场改的口径），
  // 落成 assistant/message 的 text 块 → 走 extractProcessText → appendNote。它只有一行、信息密度最高，
  // 但可能跟在长过程话语里被 500 字截断切掉 ⇒ 这里单独保护：截断后若目的行丢了就补回来。
  // 只做"保留"，不做"拆块"——拆块会让封口时"最后一段话提升为正式回复"的替换出现两份。
  const PURPOSE_LINE_RE = /^\s*(?:[-*]\s*)?🎯/
  const MAX_PURPOSE_CHARS = 200

  function purposeLinesOf(text) {
    return String(text || '').split('\n').filter((line) => PURPOSE_LINE_RE.test(line)).map((l) => l.trim())
  }

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
    const clipped = lines.join('\n').replace(/\s+$/, '') + '…'
    const kept = purposeLinesOf(clipped)
    const missing = purposeLinesOf(s).filter((line) => kept.indexOf(line) < 0)
    if (missing.length === 0) return clipped
    return missing.map((line) => line.slice(0, MAX_PURPOSE_CHARS)).join('\n') + '\n' + clipped
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

  // ---- 底部「目标条」＋ 上下文/缓存（改造③，CM 2026-10-01 定稿）-----------------
  // 数据全部来自本会话已有的事件与服务；**任何一项读不到就整块不显示**，
  // 绝不让卡片因为读状态失败而炸掉（services 缺失/投影未注册都会抛）。
  function contextSnapshot(agent) {
    try {
      const events = sessionEvents(agent.session)
      let usage = null
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e && e.type === 'assistant/message' && e.data && e.data.usage) { usage = e.data.usage; break }
      }
      if (!usage) return null
      let windowSize = 0
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e && e.type === 'request/context' && e.data && e.data.contextWindow) {
          windowSize = Number(e.data.contextWindow) || 0
          break
        }
      }
      // 口径（2026-10-01 实测核对）：totalTokens = inputTokens + cacheReadTokens + outputTokens
      // ⇒ inputTokens 是**未命中缓存**的输入、cacheReadTokens 是命中缓存的部分；
      //   「上下文占用」= 二者之和，「缓存命中率」= cacheRead / 上下文占用。
      const miss = Number(usage.inputTokens) || 0
      const hitTokens = Number(usage.cacheReadTokens) || 0
      const ctxTokens = miss + hitTokens
      return { ctx: ctxTokens, windowSize, hit: ctxTokens > 0 ? (100 * hitTokens / ctxTokens) : 0 }
    } catch (error) {
      return null
    }
  }

  function humanTokens(n) {
    if (!Number.isFinite(n) || n <= 0) return '0'
    if (n >= 1000000) return (n / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M'
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
    return String(Math.round(n))
  }

  function goalSnapshot(agent) {
    try {
      const goals = ctx.get('goals')
      if (!goals || typeof goals.state !== 'function' || typeof goals.view !== 'function') return null
      const state = goals.state(agent.session)
      const runtime = typeof goals.runtimeState === 'function'
        ? goals.runtimeState(agent.session) : { activation: 'disarmed' }
      const view = goals.view(state, runtime)
      if (!view || !view.objective) return null
      return view
    } catch (error) {
      return null
    }
  }

  // 状态文案：CM 2026-10-01 定稿。`activation !== 'armed'` 是最关键的一格 ——
  // 每次 dsh 重启，活跃 goal 的续行都会被驱动插件解除武装（disarm），
  // 卡面上必须能直接看出"目标还在、但续行停了"。
  function goalStateText(view) {
    const rounds = '第 ' + (Number(view.roundsStarted) || 0) + '/' + (Number(view.maxGoalRounds) || 0) + ' 轮'
    const phase = String(view.phase || '')
    if (phase === 'complete') return '✅ 目标模式 · 已完成 · 共 ' + (Number(view.roundsStarted) || 0) + ' 轮'
    if (phase === 'paused') return '⏸️ 目标模式 · 已暂停（发 /goal resume 恢复）· ' + rounds
    // CM 2026-10-01：**状态栏只写「已阻塞」** —— 长原因会把 `🧠 上下文/占比`、`💾 缓存命中`
    // 两栏挤断；原因一律放到**展开面板**的「阻塞原因」一行（见 goalFooterElements 的 detail）。
    if (phase === 'blocked') return '🚫 目标模式 · 已阻塞 · ' + rounds
    if (phase === 'active' && String(view.activation || '') !== 'armed') {
      return '⚠️ 目标模式 · 已创建但续行已停（发 /goal resume 恢复）· ' + rounds
    }
    return '🎯 目标模式 · 已激活（续行已开）· ' + rounds
  }

  function goalFooterElements(card) {
    const agent = card && card.agent
    if (!agent) return []
    // A 方案（CM 2026-10-01）：过程卡**不摆状态栏**，只留一条灰线 ＋ 一行裸状态。
    if (card && card.footerMode === 'bare') {
      return [{ tag: 'hr' }, { tag: 'markdown', content: statusTextFor(card) }]
    }
    const snap = contextSnapshot(agent)
    const view = goalSnapshot(agent)
    const metric = snap
      ? '🧠 ' + humanTokens(snap.ctx) + (snap.windowSize ? '/' + humanTokens(snap.windowSize) : '')
        + (snap.windowSize ? '（' + (100 * snap.ctx / snap.windowSize).toFixed(1) + '%）' : '')
        + '  ｜  💾 缓存命中 ' + snap.hit.toFixed(1) + '%'
      : ''
    // 2026-10-01 CM：「目标条上面加一条灰色分隔线，不然它跟正文会混到一起」。
    // 飞书 `hr` 组件就是那条灰色横线（JSON 2.0 结构组件；真机已发卡验证 schema 合法）。
    const rule = { tag: 'hr' }
    // CM 2026-10-01：把「进行中／已完成」并进这条状态栏（不再单独占一行）。
    const status = statusTextFor(card).replace(/_/g, '')
    if (!view) {
      // 2026-10-01 CM：「未激活的时候能不能也加一个灰色底，这样好看一点」。
      // 用 `column_set` + `background_style:'grey-50'` 包一行 markdown（真机验证过：
      // column_set **不支持** `border` 属性，带 border 会被 API 拒：ErrCode 200621）。
      return [rule, {
        tag: 'column_set',
        flex_mode: 'none',
        background_style: 'grey-50',
        columns: [{
          tag: 'column',
          width: 'weighted',
          weight: 1,
          vertical_align: 'center',
          padding: '6px 8px 6px 8px',
          elements: [{
            tag: 'markdown',
            // CM 2026-10-01 选定 **V3**（三张预览卡里挑的）：灰底 + 斜体一行 —— 与正文区分、又不抢眼
            content: '_' + status + '  ｜  🎯 目标模式 · 未启用' + (metric ? '  ｜  ' + metric : '') + '_',
          }],
        }],
      }]
    }
    const header = (status + '  ｜  ' + goalStateText(view) + (metric ? '  ｜  ' + metric : '')).replace(/\*\*/g, '')
    const created = Number(view.createdAt)
    const detail = [
      '**状态**：`' + String(view.phase || '?') + '` ｜ **续行**：`' + String(view.activation || '?')
        + '` ｜ **轮数**：' + (Number(view.roundsStarted) || 0) + '/' + (Number(view.maxGoalRounds) || 0)
        + (view.blockedReason
          // 与 goalStateText 同一口径：对象取 message（其次 reason/code），字符串原样用 ——
          // 修 2026-10-01 真机的 `[object Object]`（折叠面板这一行此前漏修，被新断言抓出）
          ? ' ｜ **阻塞原因**：' + (typeof view.blockedReason === 'object'
            ? String(view.blockedReason.message || view.blockedReason.reason || view.blockedReason.code || '（未给原因）')
            : String(view.blockedReason))
          : ''),
      created ? '**创建于**：' + new Date(created).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '',
      '',
      '**目标全文**',
      '',
      String(view.objective || ''),
    ].filter((line) => line !== '').join('\n')
    return [rule, {
      tag: 'collapsible_panel',
      expanded: false,
      background_color: 'grey-50',
      border: { color: 'grey', corner_radius: '8px' },
      padding: '8px 8px 8px 8px',
      header: {
        title: { tag: 'plain_text', content: header.slice(0, 200) },
        vertical_align: 'center',
        padding: '8px 8px 8px 8px',
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '16px 16px' },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      elements: [{ tag: 'markdown', content: detail }],
    }]
  }

  function buildCardPayload(card) {
    const elements = []
    // 2026-10-02：日志带上**卡片身份**（token 前 8 位 + 状态）——
    // 之前只有 blocks/notes/tools，出现"两条流并行长"时**分不清是哪两张卡**
    // （就是靠猜；CM 报的"重复"因此多绕了几轮）。
    console.log('[fs] buildCardPayload: card=' + String(card.token || '-').slice(-8)
      + ' status=' + String(card.status || '?')
      + ' cursor=' + String(Number.isFinite(card.cursor) ? card.cursor : '-')
      + ' blocks=' + card.blocks.length
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
      // 插话提示：**醒目块**（CM 2026-10-02：与普通正文同款渲染时"堆在下面看不出来"）。
      // 结构 = hr + 彩色 column_set 底块 + hr，把提示从上下文里框出来。
      // 该块类型**不参与** cardTableCount（只数 message/note）与结论摘要提取，天然隔离。
      if (block.type === 'notice') {
        const text = (block.text || '').trim()
        if (text) {
          if (elements.length > 0) elements.push({ tag: 'hr' })
          elements.push({
            tag: 'column_set',
            flex_mode: 'none',
            background_style: STEER_NOTICE_BG,
            columns: [{
              tag: 'column',
              width: 'weighted',
              weight: 1,
              vertical_align: 'center',
              padding: '6px 10px 6px 10px',
              elements: [{
                tag: 'markdown',
                content: '**' + STEER_NOTICE_TITLE + '**\n\n' + text,
              }],
            }],
          })
          elements.push({ tag: 'hr' })
        }
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
    // 底部状态栏：上下文占比/缓存命中/目标状态 + **运行状态**都收在这一块里（改造③ + CM 2026-10-01）
    let footerDrawn = false
    try {
      const footer = goalFooterElements(card)
      for (const el of footer) elements.push(el)
      footerDrawn = footer.length > 0
    } catch (error) {
      console.log('[fs] goal footer failed: ' + String(error && error.message || error))
    }
    // 兜底：卡片没有 agent（读不到会话）时，状态行不能因此消失
    if (!footerDrawn) elements.push({ tag: 'markdown', content: statusTextFor(card) })
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
          // 改造⑤：登记卡片 message_id → 摘要（真正的摘要在下面统一刷新，见 cardLabel 注释）
          try { rememberMessage(messageId, cardLabel(card)) } catch {}
          // 2026-09-27：建卡时留痕 message_id ＋ 载荷指纹（事后可比对两张卡是否同内容）
          try {
            const els = (payload && payload.body && payload.body.elements) || []
            console.log('[fs] card created chat=' + chatId + ' msg=' + messageId
              + ' elements=' + els.length + ' payload_hash=' + shortHash(JSON.stringify(payload)))
          } catch {}
        }
        card.lastSyncAt = Date.now()
        // 引用透传（改造⑤）：卡片内容随回合推进才成形（建卡那刻只有「正在工作中…」）
        // ⇒ **每次成功同步都重取摘要**，CM 引用时才看得到"引的是哪张、说了什么"。
        // 真机实证：只登记建卡那一刻 → 引用回来的是「bot 的回复卡片：正在工作中…」。
        if (card.token) { try { rememberMessage(card.token, cardLabel(card)) } catch {} }
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
  // ---- 热重载卫生：上一代的卡片 watcher 必须停掉（2026-10-02，CM 报障后修）------------
  // CM 报障「最近发给我的几张卡片，**又有重复了**」。取证（web.log）：
  //   `buildCardPayload` 成对交错、且两边块数不同 —— 例 69950 `blocks=38 tools=62` /
  //   69951 `blocks=29 tools=51`，一路并排涨到 69967/69969 ⇒ **同一回合有两张卡在并行长**。
  //   成因：插件热重载（那一轮 apply #12 / #13 / #14）重建了模块状态，但**上一代实例的
  //   `setInterval` 仍持有它自己的 card/bot/chatId 继续 PATCH** —— 旧实现只在回合正常
  //   收尾时 `clearInterval`，**没有任何 dispose 清理** ⇒ watcher 泄漏、卡片成对。
  // 修法：每个 watcher 登记进本代 `liveCardWatchers`；插件卸载（＝热重载）时全部停掉，
  //   并给旧卡留一行"已热重载、停止更新"，免得它在飞书里永远停在「正在工作中…」。
  // （结论卡的重复另有一道防护：见下方 `duplicate conclusion suppressed`。）
  // 注意：本防护**只对"带着这段代码的那一代"生效** —— 若重载时正在被销毁的是更早的实例
  // （还没有这张登记表），它的 watcher 仍然会漏一次；从下一代起就干净了。
  const liveCardWatchers = new Set()
  // 「可接管」登记表（**跨插件代际**，挂 globalThis）：agentId -> { agent, card, bot, chatId, stop }
  // 热重载后新实例靠它**接管**上一代还没封口的卡，在**同一张卡**上继续更新；
  // 不接管的话两代各自开卡 ⇒ 就是 CM 报的"两张卡并行长"。
  const liveCardRegistry = globalThis.__fsLiveCards || (globalThis.__fsLiveCards = new Map())

  function startCardWatcher(agent, card, bot, chatId, onTableBudget) {
    const entry = { agent, card, bot, chatId, stop: null }
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
    const stop = () => {
      clearInterval(timer)
      liveCardWatchers.delete(entry)
      if (liveCardRegistry.get(String(agent.id)) === entry) liveCardRegistry.delete(String(agent.id))
    }
    entry.stop = stop
    liveCardWatchers.add(entry)
    liveCardRegistry.set(String(agent.id), entry)
    return stop
  }

  // 卸载（含 HMR 热重载）时：① 注销本代挂在 `agent.ctx`（长生命周期）上的监听；
  // ② 停掉全部在跑的 watcher —— **但不封口**（卡片留给新实例"续卡"，见下面 ③）。
  ctx.effect(() => () => {
    // ⓪ 热重载「打断播报」的承前启后（2026-10-02 CM：「热重载打断会话要在会话里发提示」）。
    //    abort 发生在 dispose **之后** ~40ms（agent 生命周期 effect 被拆 ⇒
    //    agent-loop `machine.cancel({kind:'disposed'})`），那时本代 watcher 已经停了 ⇒ 抓不到。
    //    这里只留"有哪些回合在跑"的线索，由**新实例**播报（见 announceReloadInterrupts）。
    try {
      const interrupted = []
      for (const [agentId, entry] of Array.from(activeTurns)) {
        if (!entry || !entry.bot || !entry.chatId) continue
        interrupted.push({
          sessionId: String(agentId),
          chatId: String(entry.chatId),
          appId: String((entry.bot.cfg && entry.bot.cfg.appId) || ''),
        })
      }
      if (interrupted.length > 0) {
        globalThis.__fsReloadHint = { at: Date.now(), items: interrupted }
        console.log('[fs] dispose(热重载): 登记 ' + interrupted.length + ' 个可能被中断的回合（由新实例播报）')
      }
    } catch (error) {
      console.log('[fs] dispose(热重载): 登记中断线索失败 ' + String(error && error.message || error))
    }
    // ① 活跃回合**不需要"移交"**（2026-10-02 代码审查 low#12）：`activeTurns` 本身就是
    //    globalThis.__fsActiveTurns 那个 Map（见上方声明）⇒ 跨代际共享是构造上就有的。
    //    旧那段 `if (!shared.has(key)) shared.set(...)` 永远搬不动任何一条（has 恒为 true），
    //    `移交 N 个活跃回合` 那行日志不可达 —— 已删除，免得后来者以为还需要一次搬运。
    // ② 注销本代挂在 **agent.ctx**（长生命周期）上的监听：不注销就是每次热重载往同一个
    //    agent 上再叠一条，老闭包钉住整代插件状态，且瀑布流里最早的监听先被调用
    //    ⇒ 可能是上一代在应答（评审 high#1）。
    try {
      let unbound = 0
      for (const off of agentScopeDisposers.splice(0)) {
        // 记**尝试次数**而不是成功次数（2026-10-02 审查 low）：这行日志是"本代监听已注销"的
        // 可验证信号，若某个 disposer 抛错被静默吞掉，少计就会把"没拆干净"伪装成正常。
        try { off() } catch (error) {
          console.log('[fs] dispose(热重载): 某个 agent 作用域监听注销失败 ' + String(error && error.message || error))
        } finally { unbound += 1 }
      }
      // 留痕（可复验）：每次热重载都应注销掉**本次挂上去的那几条**；这个数字一直涨才说明在叠。
      if (unbound > 0) console.log('[fs] dispose(热重载): 注销 ' + unbound + ' 个 agent 作用域监听（防跨代叠加）')
    } catch (error) {
      console.log('[fs] dispose(热重载): 注销 agent 作用域监听失败 ' + String(error && error.message || error))
    }
    // ③ 停 watcher — **但不封口**（2026-10-02 实测副作用：一封口就把观众丢在
    //    「后续内容见新的卡片」而下面根本没有新卡）。卡片留给新实例"续卡"继续更新：
    //    先把登记表快照下来，停 watcher 时会被顺手删掉，停完再放回去。
    const keep = Array.from(liveCardRegistry.entries())
    const n = liveCardWatchers.size
    for (const entry of Array.from(liveCardWatchers)) {
      try { entry.stop() } catch { }
    }
    for (const [key, value] of keep) {
      if (!liveCardRegistry.has(key)) liveCardRegistry.set(key, value)
    }
    if (n > 0) console.log('[fs] dispose(热重载): 停掉 ' + n + ' 个 watcher（卡片留给新实例续卡）')
  })

  // 表格额度换卡（续卡通道专用）：旧卡保留表格，新卡接续游标，不丢不重。
  function rotateAdoptedCard(agent) {
    const key = String(agent && agent.id)
    const entry = liveCardRegistry.get(key)
    if (!entry || !entry.card) return
    const old = entry.card
    const fresh = makeCardState(agent)
    fresh.cursor = old.cursor
    fresh.footerMode = 'bare'
    old.sealing = true
    old.status = 'sealed'
    old.blocks.push({ type: 'message', text: '📊 表格已达飞书单卡上限，后续内容见下方新卡。' })
    try { void syncCard(entry.bot, entry.chatId, old, true).catch(() => { }) } catch { }
    entry.card = fresh
    if (entry.stop) { try { entry.stop() } catch { } }
    entry.stop = startCardWatcher(agent, fresh, entry.bot, entry.chatId, () => rotateAdoptedCard(agent))
    console.log('[fs] 续卡通道：表格换卡 card=' + String(fresh.token || '-').slice(-8))
  }

  // 热重载「续卡」：新实例接管上一代还没封口的卡（同一张卡上继续更新）。
  for (const [key, entry] of Array.from(liveCardRegistry.entries())) {
    try {
      const card = entry && entry.card
      if (!entry || !card || !entry.agent || !entry.bot || !entry.chatId
        || card.status === 'sealed' || card.status === 'error') {
        liveCardRegistry.delete(key)
        continue
      }
      console.log('[fs] 热重载续卡：接管 agent=' + key + ' card=' + String(card.token || '-').slice(-8)
        + ' blocks=' + card.blocks.length)
      entry.stop = startCardWatcher(entry.agent, card, entry.bot, entry.chatId, () => rotateAdoptedCard(entry.agent))
    } catch (error) {
      console.log('[fs] 热重载续卡失败（不影响其它功能）: ' + String(error && error.message || error))
    }
  }

  // ---- 热重载「打断播报」（2026-10-02 CM：热重载打断会话，必须在会话里说清）-------------------
  // 由来（有出处）：0.4.20 曾在 dispose 时把旧卡就地封口并留一行
  //   `♻️ 插件已热重载：本卡停止更新，后续内容见新的卡片。`（CHANGELOG 0.4.20）；
  // 0.4.22 改成"续卡"（新实例接管同一张卡）时把这行删了 ⇒ 之后热重载打断回合变成**完全无声**：
  // abort 被当正常收尾（卡片 status=sealed），一个字都不解释。CM 2026-10-02 追问"为什么现在没了"。
  // 抓法：上一代在 dispose 时留线索（见 dispose 钩子 ⓪），本代在**有 bot 之后**播报 ——
  //   不看"谁先跑"的竞态，也不依赖旧实例的 watcher 还活着。
  // 边界：只对"重载时确实有回合在跑"的情况播报（线索为空 ⇒ 不发任何东西，杜绝噪声）；
  //   每会话只播一次（globalThis 去重，幂等）；窗口外的旧线索直接丢弃。
  const RELOAD_NOTICE_WINDOW_MS = 120000
  function announceReloadInterrupts(attempt) {
    const hint = globalThis.__fsReloadHint
    if (!hint) return
    const items = Array.isArray(hint.items) ? hint.items : []
    const tries = Number(attempt) || 0
    if (!items.length || Date.now() - Number(hint.at || 0) > RELOAD_NOTICE_WINDOW_MS) {
      globalThis.__fsReloadHint = null
      return
    }
    // apply 期 ensureHelpers() 是异步的 ⇒ bot 可能还没进表。留住线索、稍后再播，
    // 绝不因为"来得太早"把提示吞掉（这正是本次要修的毛病）。
    if (bots.size === 0) {
      if (tries < 30) setTimeout(() => announceReloadInterrupts(tries + 1), 300)
      return
    }
    globalThis.__fsReloadHint = null
    const notified = globalThis.__fsReloadNotified || (globalThis.__fsReloadNotified = new Map())
    for (const [key, at] of Array.from(notified)) {
      if (Date.now() - Number(at || 0) > RELOAD_NOTICE_WINDOW_MS) notified.delete(key)
    }
    for (const item of items) {
      try {
        const sessionId = String((item && item.sessionId) || '')
        const chatId = String((item && item.chatId) || '')
        if (!sessionId || !chatId) continue
        if (notified.has(sessionId)) continue          // 同一会话只提示一次
        const bot = bots.get(String((item && item.appId) || '')) || Array.from(bots.values())[0]
        if (!bot) continue
        notified.set(sessionId, Date.now())
        void sendPlainText(bot, chatId,
          '♻️ 插件已热重载：上一轮被热重载打断（不是模型出错，也不是你的操作）。'
          + '刚才那轮没说完的不会自己继续 —— 你回我一句就行。').catch(() => { })
        console.log('[fs] hot reload interrupt notice: agent=' + sessionId + ' chat=' + chatId)
      } catch (error) {
        console.log('[fs] hot reload interrupt notice failed: ' + String(error && error.message || error))
      }
    }
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
        // title：dsh 自己生成的会话标题（session/title 事件）。只有活着的会话读得到，
        // 所以在这里落盘 —— 重启后 /list、/switch 仍能显示真名而不是「主会话 / 会话 N」。
        sessions: chat.sessions.map((s) => ({
          id: s.id, label: s.label, title: s.title, type: s.type, gen: s.gen,
        })),
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
  const COMMANDS = ['help', 'new', 'switch', 'list', 'plan', 'goal', 'compact', 'stop', 'model']

  // 会话名上限：与 /list 单行、/switch 卡片行的渲染宽度匹配（超了就换行糊成一坨）。
  const NEW_NAME_MAX = 60

  function splitCommand(text) {
    const trimmed = (text || '').trim()
    if (!trimmed.startsWith('/')) return undefined
    const parts = trimmed.slice(1).split(/\s+/)
    // rawArg = 命令名之后的**原始**文本（保留换行）。arg 保持"压平"形态，
    // 现有消费者（/goal /plan /switch）不受影响；/new 需要 rawArg 才能只取首行。
    const rest = trimmed.slice(1)
    const sp = rest.search(/\s/)
    const rawArg = sp < 0 ? '' : rest.slice(sp)
    return { name: (parts[0] || '').toLowerCase(), arg: parts.slice(1).join(' '), rawArg }
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

  // ---- 把命令失败回注给 agent（CM 2026-10-01：「报错能不能直接知道、提醒到 agent？」）----
  // 背景：斜杠命令（/compact、/goal…）是在**会话链之外**处理的 —— 命令炸了，用户看到一句报错，
  // 而 agent 完全不知道（它那一轮早结束了）。真机事故：`/compact` 报 TypeError，
  // agent 直到 CM 把错误贴过来才知道 → 属于"能自愈却等用户救"。
  // 做法：① 先建一张卡承接 agent 被唤醒后的这一轮（复用自动卡机制）
  //      ② 把失败注入会话并**唤醒** agent（新开一轮）→ 它会排查并用人话回给用户。
  function reportCommandFailure(agent, bot, chatId, what, error) {
    const detail = String(error && error.message || error)
    console.log('[fs] reporting command failure to agent: ' + what + ' -> ' + detail)
    try {
      if (!agent || typeof agent.send !== 'function') return
      if (!activeTurns.has(agent.id) && !autoCards.has(agent.id)) {
        const info = { kind: 'notice', round: 0, title: '⚠️ ' + what + ' 执行失败 · 正在排查…' }
        const state = openGoalCard(agent, bot, chatId, info, null)
        autoCards.set(agent.id, makeAutoCardEntry(agent, bot, chatId, state, 'notice'))
      }
      agent.send({
        id: 'fs-cmdfail-' + randomUUID(),
        role: 'user',
        content: [{
          type: 'text',
          text: '[系统回执] 用户刚在飞书执行 `' + what + '` 失败了：' + detail
            + '\n请排查原因（必要时查 dsh 日志），然后用一句人话告诉用户现在什么情况、要不要重试。',
        }],
        // kind='plugin' + 这个前缀 ⇒ 走既有的"自动轮"通道（agent/status 会建卡/续卡）
        source: { kind: 'plugin', plugin: 'feishu-stream' },
      }, 'next-turn', true)
    } catch (error2) {
      console.log('[fs] report command failure failed: ' + String(error2 && error2.message || error2))
    }
  }

  async function handleCommand(bot, chat, chatId, cmd) {
    const resolved = resolveCommandName(cmd.name)
    if (!resolved) return false
    if (resolved === 'help') {
      await sendPlainText(bot, chatId,
        '/new [名称] 新建会话\n/switch 选工作区（第一步）→ 点进去再选该工作区的会话\n/switch <工作区序号> 看该工作区的会话 ｜ /switch <工作区序号> new 在该工作区新建 ｜ /switch <工作区序号> <会话序号> 接管\n/list 列出当前工作区的会话\n/plan [off] 计划模式开关\n/goal <目标> 目标模式（自动续轮，每轮进度发到飞书）\n/goal (无参数) 查看目标状态 ｜ /goal pause|resume|clear|edit <目标>\n/compact 压缩上下文（agent 空闲时才可用）\n/model 切换模型（发一张卡，点一下即切）\n/stop 停止当前任务\n/help 帮助')
      return true
    }
    if (resolved === 'model') {
      // CM 2026-10-02：「飞书上切换不了模型，你现在能发个卡片给我选择吗」
      const agent = await commandAgent(bot, chat)
      if (!agent) {
        await sendPlainText(bot, chatId, '当前没有可用会话：先发一条普通消息建立会话，再 /model。')
        return true
      }
      const arg = String(cmd.arg || '').trim()
      const direct = /^([\w.-]+)\/([\w.:-]+)$/.exec(arg)
      if (direct) {
        try {
          const how = switchModelForAgent(agent, direct[1], direct[2])
          await sendPlainText(bot, chatId, '✅ 模型已切换为 `' + direct[1] + '/' + direct[2]
            + '`（下一次请求生效，via ' + how + '）')
        } catch (error) {
          await sendPlainText(bot, chatId, '切换失败：' + String(error && error.message || error))
        }
        return true
      }
      await sendModelPicker(bot, chatId, agent)
      return true
    }
    if (resolved === 'stop') {
      // 2026-10-02：改用 commandAgent（活会话 → resume 持久化会话），
      // 空闲久了也能直接下命令，不再要求"先发一条普通消息"。
      const agent = await commandAgent(bot, chat)
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
      const agent = await commandAgent(bot, chat)
      // 2026-10-01：飞书 agent 的提问水位线必须挂到 agent scope（只挂根级会被 GUI 桥接
      // 抢答，计划审批只到电脑端）——见 handleUserQuestionRequest 上方注释。
      bindFeishuAgentQuestions(agent)
      bindFeishuAgentApproval(agent)
      if (!agent) {
        await sendPlainText(bot, chatId, '当前没有可用会话：先发一条普通消息建立会话，再 /plan。')
        return true
      }
      // Prefer the harness commands registry (plan-mode registers /plan
      // there); fall back to the injected planMode service directly.
      // ctx.get('planMode') misses the service across bundle scopes (2026-08-15).
      // 命令**可能在执行中就把正文投进会话并起一个回合**（/plan <正文>）⇒ 游标必须在
      // execute 之前取，否则那一轮已产生的步骤会被新卡的游标跳过（又一次「看不见」）。
      const seqBeforeForPlan = sessionEvents(agent.session).length
      let planMode
      try {
        const commands = ctx.get('commands')
        if (commands && typeof commands.execute === 'function') {
          const line = cmd.arg ? '/plan ' + cmd.arg : '/plan'
          // ⚠️ 签名是 execute(agent, line, **submittedAttachments**, signal) —— signal 在第 **4** 位！
          // 旧代码把 signal 传在第 3 位 ⇒ 真正进去的 signal=undefined ⇒ 注册表里 `signal.aborted`
          // 当场抛 TypeError（被下面的 catch 吞掉 → 静默走兜底分支）。
          // ⚠️ 第 3 位**必须是数组**（`NO_ATTACHMENTS = Object.freeze([])`）：传 undefined 会在
          //    注册表里读 `submittedAttachments.length` 再抛一次（2026-10-01 第二次真机报错）。
          const exec = await commands.execute(agent, line, [], new AbortController().signal)
          if (exec !== undefined) {
            const text = exec.result && exec.result.text ? exec.result.text : 'ok'
            await sendPlainText(bot, chatId, text)
            // 2026-10-01 CM 报障：「我发了这个计划模式的启动给你……飞书上没有看到卡片」。
            // 根因：/plan <正文> 被 harness 解释成「开计划模式 + 把正文当用户消息起一个真回合」
            // （会话 fs-main-mupoeiy4 seq 721→725 实证），而命令通道只发一句纯文本回执就
            // return ⇒ 那一整轮（16 步）**没有任何卡片持有它**，CM 完全看不到过程。
            // 修法：把「已起回合 + 事件游标」交回 handleInbound，走普通回合的建卡/封口。
            // 判据只认 harness 自身语义：只有**带正文**（且非 off）时 plan-mode 才
            // agent.steer(正文)（dsh-plan-mode/lib/index.js:217）；/plan 与 /plan off
            // 都只切开关、不起回合。
            if (cmd.arg && cmd.arg !== 'off') {
              return { turnStarted: { agent, seqBefore: seqBeforeForPlan } }
            }
            return true
          }
          console.log('[fs] /plan: commands.execute resolved nothing, falling back')
        }
      } catch (error) {
        console.log('[fs] /plan via commands failed: ' + String(error && error.message || error))
        reportCommandFailure(agent, bot, chatId, '/plan', error)
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
      const agent = await commandAgent(bot, chat)
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
          const exec = await commands.execute(agent, line, [], new AbortController().signal)
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
        reportCommandFailure(agent, bot, chatId, '/goal', error)
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
    if (resolved === 'compact') {
      // 压缩上下文（CM 2026-10-01 要求）：harness 的 `@deepseek-ai/dsh-command-compact`
      // 已在 `commands` 注册表登记 `/compact`（无参数，内部走 `compaction.compactNow`）。
      // ⚠️ 已知前置条件：**agent 必须空闲**，否则上游返回 busy
      //   （"this process has an active compaction, or the agent is not idle"）。
      // 旧实现的问题：`compact` 不在 COMMANDS 白名单里 ⇒ `/compact` 被当成**普通消息**发给模型，
      // 压缩根本不会发生（用户以为按了、实际什么都没做）。
      const active = chat.sessions[chat.activeIndex]
      const agent = await commandAgent(bot, chat)
      if (!agent) {
        await sendPlainText(bot, chatId, '当前没有可用会话：先发一条普通消息建立会话，再 /compact。')
        return true
      }
      let handled = false
      try {
        const commands = ctx.get('commands')
        if (commands && typeof commands.execute === 'function') {
          const exec = await commands.execute(agent, '/compact', [], new AbortController().signal)
          if (exec !== undefined) {
            const text = exec.result && exec.result.text ? exec.result.text : 'ok'
            await sendPlainText(bot, chatId, '🗜️ 压缩上下文：' + text)
            handled = true
            console.log('[fs] /compact executed for ' + agent.id)
          } else {
            console.log('[fs] /compact: commands.execute resolved nothing')
          }
        }
      } catch (error) {
        console.log('[fs] /compact via commands failed: ' + String(error && error.message || error))
        await sendPlainText(bot, chatId, '压缩失败：' + String(error && error.message || error))
        reportCommandFailure(agent, bot, chatId, '/compact', error)
        return true
      }
      if (!handled) {
        await sendPlainText(bot, chatId,
          '压缩不可用：命令注册表里没有 /compact（`dsh-command-compact` 未装载），或当前没有可压缩的历史。')
      }
      return true
    }
    if (resolved === 'new') {
      // 2026-10-02 CM 实证：他把整段 /help 输出当消息发过去（正文以 /new 开头），
      // splitCommand 把所有空白压成单空格 ⇒ 后面几十行全成了会话名，
      // 建出来的名字是**一整段帮助文本**。修法：
      //   ① 只取 rawArg 的**首行**（多行粘贴只认第一行）② 折叠空白 + 修剪 ③ 超长**拒绝**。
      // ⚠️ 校验必须排在"停掉旧会话"**之前** —— 否则一个被拒绝的 /new 先把你的当前会话杀了。
      const nameArg = String((cmd.rawArg !== undefined && cmd.rawArg !== null) ? cmd.rawArg : (cmd.arg || ''))
        .split('\n')[0].replace(/\s+/g, ' ').trim()
      if (nameArg.length > NEW_NAME_MAX) {
        await sendPlainText(bot, chatId,
          '会话名太长（' + nameArg.length + ' 字，上限 ' + NEW_NAME_MAX + '）—— **没有新建**，你的当前会话未受影响。\n'
          + '请用简短名称重发：「/new 足球复盘」\n'
          + '（你发的开头是：' + nameArg.slice(0, 30) + '…）')
        return true
      }
      // 2026-09-27（CM 实证：/new 之后旧会话没被停 → 同一个群里有**两个**活会话各自发卡，
      // 卡片/用户消息 = 1.82:1，用户看到"一个内容发两次"）：切新会话前先把旧会话停掉。
      // 用与 /stop 同一套 live lookup（缓存句柄可能指向 hmr 后的陈旧实例）。
      const prev = chat.sessions[chat.activeIndex]
      let stoppedPrev = null
      if (prev) {
        let prevAgent = null
        try {
          const agents = ctx.get('agents')
          const list = agents && typeof agents.list === 'function' ? agents.list() : []
          prevAgent = list.find((x) => x && x.id === prev.id) || null
        } catch (error) {
          console.log('[fs] /new live lookup failed: ' + String(error && error.message || error))
        }
        if (!prevAgent && prev.handle) prevAgent = prev.handle.agent
        if (prevAgent) {
          try {
            prevAgent.cancel({ kind: 'user' })
            stoppedPrev = prev.id
            console.log('[fs] /new: cancelled previous live session ' + prev.id)
          } catch (error) {
            console.log('[fs] /new: cancel previous failed: ' + String(error && error.message || error))
          }
        } else {
          console.log('[fs] /new: previous session ' + prev.id + ' has no live agent (already idle)')
        }
      }
      const sessionId = 'fs-main-' + Date.now().toString(36)
      const handle = await createDedicated(bot, sessionId)
      chat.sessions.push({ id: sessionId, label: nameArg || ('会话 ' + (chat.sessions.length + 1)), type: 'dedicated', gen: SESSION_GEN, handle })
      chat.activeIndex = chat.sessions.length - 1
      persistChats(bot, bot.chats)
      // 2026-10-02：回复必须用校验后的 nameArg，**不能用 cmd.arg** ——
      // cmd.arg 是整段压平文本（splitCommand 连换行一起压成空格）。
      // 只改 label 不改这里，就会出现「状态表里名字是对的、回复里还是一整段」的割裂
      //（CM 实测：label=「[名称] 新建会话」，回复却回了全部 10 行）。
      await sendPlainText(bot, chatId, '已新建会话' + (nameArg ? '「' + nameArg + '」' : '') + '并切换过去。'
        + (stoppedPrev ? '（旧会话 ' + stoppedPrev + ' 已停 —— 避免两个会话同时往这个群发卡）' : ''))
      return true
    }
    if (resolved === 'list') {
      // 2026-10-02（CM 定稿 A 方案）：/list ＝ **当前工作区的会话**（不再只列"本聊天的会话"，
      // 也不再与工作区混淆）。当前工作区 ＝ 活跃会话的 cwd。
      const cands = await sessionCandidates(bot, chat)
      const wsRows = await buildWorkspaceRows(bot, chat, cands)
      const current = currentWorkspaceOf(bot, chat, cands)
      const wsIndex = wsRows.findIndex((r) => sameWorkspace(r.path, current.cwd))
      const ws = wsIndex >= 0
        ? wsRows[wsIndex]
        : { path: current.cwd, title: workspaceLeaf(current.cwd) }
      const rows = await buildSessionRows(bot, chat, ws, cands)
      // 会话下标只建一次（原来是每行 findIndex ⇒ O(n²)）；标题也别重算 ——
      // buildSessionRows 里的 r.title 已经是 "liveTitle 优先、日志回填兜底" 的同一结果（low）。
      const chatIndexById = new Map((chat.sessions || []).map((s, i) => [String(s.id), i]))
      // 顺手把读到的标题落盘（变了才写一次）：/list 是命令、不走消息路径，
      // 所以记录动作必须放在这里，否则"光发 /list"永远补不上真名。
      let titleChanged = false
      const lines = rows.map((r, i) => {
        const t = r.title
        const idx = chatIndexById.has(String(r.sessionId)) ? chatIndexById.get(String(r.sessionId)) : -1
        if (idx >= 0 && t && chat.sessions[idx].title !== t) { chat.sessions[idx].title = t; titleChanged = true }
        const name = t || r.summary || r.label || shortSessionId(r.sessionId)
        const flags = []
        if (r.current) flags.push('当前')
        else if (r.inChat) flags.push('本聊天')
        if (r.live) flags.push('🟡 运行中')
        return (r.current ? '▶ ' : '  ') + (i + 1) + '. ' + name + (flags.length ? '（' + flags.join('·') + '）' : '')
      })
      if (titleChanged) { try { persistChats(bot, bot.chats) } catch { /* 落盘失败不影响展示 */ } }
      const head = '**工作区**：' + ws.title + '　`' + (ws.path || '?') + '`'
        + (wsIndex >= 0 ? '（第 ' + (wsIndex + 1) + ' 个，共 ' + wsRows.length + ' 个）' : '（未在注册表里）')
      const tail = (rows.length && wsIndex >= 0)
        ? '发 `/switch ' + (wsIndex + 1) + ' <序号>` 接管 ｜ `/switch ' + (wsIndex + 1) + ' new` 新建 ｜ `/switch` 换工作区'
        : '发 `/switch` 换工作区'
      await sendPlainText(bot, chatId, [head, ...(lines.length ? lines : ['（这个工作区还没有会话）']), tail].join('\n'))
      return true
    }
    if (resolved === 'switch') {
      // 两级：无参数 = 工作区卡；<工作区序号> = 该工作区的会话卡；
      //        <工作区序号> new = 在该工作区新建；<工作区序号> <会话序号> = 接管。
      const arg = String(cmd.arg || '').trim()
      const cands = await sessionCandidates(bot, chat)
      const wsRows = await buildWorkspaceRows(bot, chat, cands)
      if (!wsRows.length) {
        await sendPlainText(bot, chatId, '没有可切换的工作区：先发一条普通消息建立会话。')
        return true
      }
      if (!arg) {
        await sendWorkspaceCard(bot, chatId, wsRows, undefined, currentWorkspaceOf(bot, chat, cands))
        return true
      }
      const parsed = /^(\d+)(?:\s+(\d+|new|新建))?$/iu.exec(arg)
      if (!parsed) {
        await sendPlainText(bot, chatId, '用法：`/switch`（选工作区）｜ `/switch <工作区序号>`（看它的会话）'
          + '｜ `/switch <工作区序号> new`（在该工作区新建）｜ `/switch <工作区序号> <会话序号>`（接管）')
        return true
      }
      const wsIndex = Number(parsed[1]) - 1
      const ws = switchRowByIndex(wsRows, wsIndex)
      if (!ws) {
        await sendPlainText(bot, chatId, '工作区序号无效：当前有 ' + wsRows.length + ' 个，先发 /switch 看列表。')
        return true
      }
      const second = (parsed[2] || '').toLowerCase()
      if (second === 'new' || second === '新建') {
        await applySwitch(bot, chat, chatId, ws, 'new')
        return true
      }
      const sessRows = await buildSessionRows(bot, chat, ws, cands)
      if (!second) {
        // ⚠️ 这里**必须**带上序号（门槛第四轮 medium）：卡片按钮里的 fs_i 取自 ws.index，
        // 缺了它按钮全带 fs_i=0 ⇒ 空工作区点「在这里新建会话」会在**第一个**工作区建会话。
        // （/list 分支里那句才是真死的，已删；这句是活的，当初一起删错了。）
        ws.index = wsIndex
        // 文字命令路径：给这次会话列表**新开一张卡**（带自己的 pending 记录）
        const rec = registerPendingSwitchCard({ token: randomUUID(), bot, chatId, timer: undefined, cardId: '', wsRows })
        await showSessionPage(bot, chatId, ws, rec, sessRows, 0)
        return true
      }
      const row = switchRowByIndex(sessRows, Number(second) - 1)
      if (!row) {
        await sendPlainText(bot, chatId, '会话序号无效：该工作区有 ' + sessRows.length + ' 个会话，'
          + '先发 /switch ' + (wsIndex + 1) + ' 看列表。')
        return true
      }
      await applySwitch(bot, chat, chatId, row, 'takeover')
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
      // 2026-10-02 修复：附件下载那条链读的是 `msg_type`（见 downloadInboundFile），
      // 而这里**只**给了 `message_type` ⇒ 文件/图片消息恒判"没有 key" ⇒ 被静默丢弃
      // （web.log 里连一条 `inbound file saved` / `download failed` 都没有）。
      // 两个键都给：新读法用 msg_type，旧读法照旧能用 message_type。
      msg_type: message.message_type,
      chat_id: message.chat_id,
      chat_type: message.chat_type,
      content: message.content,
      create_time: message.create_time,
      // 改造⑤（2026-10-01）：引用回复的上下文 —— parent_id=被引用的那条消息，
      // root_id=该话题的根消息。旧实现整条丢弃，agent 因此看不出 CM 在回哪张卡。
      parent_id: message.parent_id,
      root_id: message.root_id,
      thread_id: message.thread_id,
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
      const msgType = String(evt.msg_type || evt.message_type || '')
      const parsed = JSON.parse(evt.content || '{}')
      let key = ''
      let type = ''
      let fileName = ''
      if (msgType === 'file') { type = 'file'; key = parsed.file_key || ''; fileName = parsed.file_name || '' }
      else if (msgType === 'image') { type = 'image'; key = parsed.image_key || ''; fileName = 'image' }
      else if (msgType === 'audio') { type = 'file'; key = parsed.file_key || parsed.audio_key || ''; fileName = parsed.file_name || 'audio' }
      else if (msgType === 'media') { type = 'file'; key = parsed.file_key || ''; fileName = parsed.file_name || 'media' }
      if (!key || !type) {
        // 不支持的附件类型（sticker / share_chat / 系统消息…）也要留痕：旧实现直接
        // `return ''`，日志里与"插件根本没收到"完全无法区分 —— 正是 CM 说的那种盲区。
        console.log('[fs] inbound non-text ignored: type=' + (msgType || '?') + ' hasKey=' + Boolean(key))
        return ''
      }
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
        // 失败必须**可见**（否则又回到"我不知道你发了文件"）：回一条文本，让插件照常起轮告诉 CM。
        return '⚠️ 收到文件「' + (fileName || '(无文件名)') + '」但下载失败（HTTP ' + res.status + '）。'
          + '（多为该应用缺 `im:resource` 权限 —— 见 dsh 日志）'
      }
      const buf = Buffer.from(await res.arrayBuffer())
      const safe = String(fileName || type + '-' + Date.now()).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120)
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const path = join(base, stamp + '_' + safe)
      writeFileSync(path, buf)
      console.log('[fs] inbound file saved: ' + path + ' (' + buf.length + ' bytes)')
      return '📎 收到文件：' + (fileName || '(无文件名)') + '\n已保存到：' + path
        + '\n（先只回我一句确认收到即可，等我说要做什么再动它；要读就用文件工具读上面这个路径）'
    } catch (e) {
      console.log('[fs] inbound file handler error: ' + String(e && e.message || e))
      // 同样不许无声：解析/写盘炸了也要让 CM 看到（否则他只会以为"你又不知道"）。
      return '⚠️ 收到一个我没能处理的附件消息：' + String(e && e.message || e)
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

  // 只「窥探」是否已处理过 —— **绝不能在这里认领**：调用方若随后没真正投递出去，
  // 它落到 handleInbound 时会被 isDuplicateInbound 判成重投而**静默丢弃**。
  function inboundAlreadySeen(messageId) {
    const id = String(messageId || '')
    return id ? seenInboundIds.has(id) : false
  }

  // ---- 回合进行中的插话（steer）------------------------------------------------
  // 2026-10-01 CM 报障：「发给你这段话，他在排队……你在做事情的时候没有收到我这条信息」。
  // 根因：入站消息统一排在 bot.chain 后面（见事件入口），而上一条 handleInbound 正卡在
  // await whenIdle() 上 ⇒ 新消息要等**整轮跑完**才进会话；投递目标又写死 next-turn。
  // 修法：回合进行中、且这条是**普通消息**（不是命令、不是某个提问的答案）时，直接
  // agent.steer() 插到下一步 —— Agent 接口：steer(message: UserMessage): void；
  // plan-mode 的 /plan <正文> 走的也是这条（会话里落成 inbox/spliced target="next-step"）。
  // 命令与提问答案仍然绕开这里（它们各自有必须立即执行的语义）。
  function steerActiveTurn(bot, evt, text) {
    const chatId = evt.chat_id
    if (!chatId || !text) return false
    // ⚠️ 只窥探、不认领（2026-10-01 事故复盘）：这里原先直接调 isDuplicateInbound()，
    // 它有副作用（把 id 记进 seenInboundIds）；一旦下面 steer 没走成、函数 return false
    // 落到 handleInbound，那里再查一次 ⇒ 已"见过" ⇒ 判重投直接丢掉
    // ⇒ **所有飞书消息被静默吞掉**（日志特征：duplicate inbound skipped 连发）。
    if (inboundAlreadySeen(evt.message_id)) return true   // 重投：直接吞掉，不重复插话
    const chat = bot.chats.get(chatId)
    if (!chat) return false
    const active = chat.sessions[chat.activeIndex]
    if (!active) return false
    // activeTurns 以 **agent id** 为键；会话表里存的是 session id。
    // 生产上两者相同（agent.id 就是 sessionId），但按"这张会话绑定的 agent"查更准，
    // 再用 session id 兜底 —— 两条都查不到才算"没有活跃回合"。
    const boundAgent = active.handle && active.handle.agent
    const entry = (boundAgent && activeTurns.get(boundAgent.id)) || activeTurns.get(active.id)
    if (!entry || !entry.agent || typeof entry.agent.steer !== 'function') return false
    const openId = evt.sender && evt.sender.sender_id && evt.sender.sender_id.open_id || ''
    const label = openId ? '[飞书 ' + openId + '] ' : '[飞书消息] '
    const quote = quoteHintFor(evt.parent_id || evt.root_id)
    try {
      entry.agent.steer({
        id: 'fs-' + evt.message_id,
        role: 'user',
        content: [{ type: 'text', text: label + text + quote }],
        source: { kind: 'user' },
      })
    } catch (error) {
      console.log('[fs] steer failed, falling back to queue: ' + String(error && error.message || error))
      return false
    }
    // 到这里才算真的投出去了 ⇒ 现在认领 message_id，防止重投被插两次。
    isDuplicateInbound(evt.message_id)
    // 2026-10-02 CM：「我"插话"了以后，你应该新开卡片。不然我说的话全部堆到下面，
    // 但是你一直在旧卡片上更新」⇒ 插话**必须换卡**：复用答题后那套 split()，
    // 旧卡就地封口（留一行指路），后续内容写到下面新卡的第一块（醒目彩色块）。
    try {
      const brief = String(text).replace(/\s+/g, ' ').slice(0, 300)
      if (typeof entry.split === 'function') {
        const ok = entry.split({
          old: { type: 'message', text: '📨 你的消息已插话送达 —— 后续内容见下方新卡。' },
          fresh: { type: 'notice', text: brief },
        })
        if (ok !== true) {
          console.log('[fs] steer card split skipped (card already sealed); message still delivered')
        }
      }
    } catch (error) {
      console.log('[fs] steer card split failed: ' + String(error && error.message || error))
    }
    console.log('[fs] steered inbound message into active turn: agent=' + active.id)
    return true
  }

  async function handleInbound(bot, evt, holdFromEvent) {
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
    // holdFromEvent：事件入口已经执行过这条命令并且它起了回合 —— 这里**不能再执行一次**
    //（否则 /plan 会被跑两遍），直接接着建卡。
    let commandHold = holdFromEvent || null
    if (cmd && !commandHold) {
      const chat = bot.chats.get(chatId) || { sessions: [], activeIndex: 0 }
      bot.chats.set(chatId, chat)
      const handled = await handleCommand(bot, chat, chatId, cmd).catch((error) => {
        console.log('[fs] command error: ' + String(error && error.message || error))
        return false
      })
      // /plan <正文> 会把正文投进会话并**起一个回合**（见 handleCommand 的 plan 分支）。
      // 那种情况不能在这里 return —— 必须落下去走「建卡 → 等回合 → 封口」，否则整轮不可见。
      if (handled && handled.turnStarted) commandHold = handled.turnStarted
      else if (handled) return
    }

    // A pending user-question (ask_user_question / plan review) is answered
    // by the next plain message in this chat (F-04).
    const pendingQ = pendingQuestions.get(chatId)
    if (pendingQ) {
      pendingQuestions.delete(chatId)
      if (pendingQ.timer) clearTimeout(pendingQ.timer)
      // Free-text answers should also continue on a fresh card below the
      // question card (same stale-card problem as button taps).
      // 2026-10-01：改成统一入口 —— 入站轮 / 自动轮两张卡都要能 split。
      splitLiveCardAfterAnswer(pendingQ.agentId)
      // 2026-10-02：两条文字回答路径都要把卡片改成「已收到」态（见 finalizeQuestionCard）
      finalizeQuestionCard(pendingQ, text)
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

    // 2026-10-01：拿到飞书 agent 的第一时间就把提问水位线挂到它自己的 scope 上。
    bindFeishuAgentQuestions(agent)
    // 2026-10-02：审批水位线同样下沉到 agent scope（否则 GUI 连着时飞书收不到审批卡）。
    bindFeishuAgentApproval(agent)

    // 2026-10-02：顺手把 dsh 的会话标题记进会话表（变了才落盘）。
    // 标题来源 = 会话事件流里的 session/title（此前 liveTitle 只被 /switch 用到）。
    try {
      const title = liveTitle(agent)
      const entry = chat.sessions[chat.activeIndex]
      if (title && entry && entry.title !== title) {
        entry.title = title
        persistChats(bot, bot.chats)
        console.log('[fs] session title recorded: ' + title)
      }
    } catch { /* 标题只是展示信息，取不到不影响任何流程 */ }

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
    const runTurn = async (turnAgent, opts) => {
      // 命令通道（/plan <正文>）已经起过回合：游标要回到**命令执行之前**，
      // 否则那一轮已产生的步骤会被这张卡的游标跳过（＝又一次「看不见」）。
      const seqBefore = opts && Number.isFinite(opts.seqBefore)
        ? opts.seqBefore
        : sessionEvents(turnAgent.session).length
      // 改造⑤：CM 长按引用某条消息/某张卡片时，把被引内容的摘要随正文一起送进会话
      // （旧实现只送正文 ⇒ agent 无法判断"他回的是哪一条"）。
      const quote = quoteHintFor(evt.parent_id || evt.root_id)
      const message = {
        id: 'fs-' + messageId,
        role: 'user',
        content: [{ type: 'text', text: label + text + quote }],
        source: { kind: 'user' },
      }
      let card = makeCardState(turnAgent)
      card.footerMode = 'bare'         // A 方案：过程卡只留裸状态，状态栏归结论卡
      card.cursor = seqBefore          // 本卡只消费本轮开始之后的事件
      card.blocks.push({ type: 'message', text: '正在工作中…' })
      const turnStartedAt = Date.now() // 结论是否独立成卡要用到本轮耗时（CM 2026-10-01 B 方案）
      let stopCardWatcher = null       // 在 send() 之前就必须存在（见下方登记顺序注释）
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
        const fresh = makeCardState(turnAgent)
        fresh.footerMode = 'bare'      // 换表新卡仍是"过程卡"
        fresh.cursor = carry
        fresh.blocks.push({ type: 'message', text: '📊 上一张卡的表格已满（飞书单卡最多 5 张），后续内容在这张新卡继续。' })
        card = fresh
        void syncCard(bot, chatId, fresh, true).catch(() => {})
        stopCardWatcher = startCardWatcher(turnAgent, fresh, bot, chatId, rotateTables)
        const live = activeTurns.get(turnAgent.id)
        if (live) live.card = fresh
      }
      // Register this turn's live card so ask_user_question can split the
      // stream: when the user answers, the old card (above the question card)
      // is frozen and a fresh card takes over for the post-answer narration.
      const entry = {
        // agent 一并登记：回合进行中收到新消息时要能直接 steer（见 steerActiveTurn）。
        card, bot, chatId, agent: turnAgent,
        // notice（可选）：{ old, fresh } —— 插话走这条时，旧卡留一行、新卡顶部放醒目块；
        // 答题路径不传（保持原样「✅ 已收到你的选择，继续处理中…」）。
        split: (notice) => {
          if (card.status === 'sealed' || card.status === 'error') return false
          // 1) Freeze the current card: stop its watcher, seal it in place.
          if (stopCardWatcher) stopCardWatcher()
          card.status = 'sealed'
          card.blocks = card.blocks.filter((b) => !(b.type === 'message' && b.text === '正在工作中…'))
          // 🔴 CM 2026-10-02：「我发信息给你，若你刚好在应答的时候，你会**直接截断掉**
          // 需要打印结果的那些回复的内容，导致我看不到」。
          // 机理：插话会 split 换卡 ⇒ 旧卡就此封口；而旧卡上镜像的过程话语是 **note**，
          // 建卡时限长 `MAX_NOTE_CHARS`(500) 截断；新卡游标从**当前位置**起、不重放旧内容；
          // seal 时结论又只取"末尾那一段文本"（段与段之间没有工具调用就停）
          // ⇒ **前半段正文彻底看不到**（只剩旧卡上那 500 字）。
          // 修法：封口前把这些 note **按 seq 从会话事件里还原成完整正文** —— 一个字都不丢。
          try {
            const liveEvents = sessionEvents(turnAgent.session)
            let expanded = 0
            for (let i = 0; i < card.blocks.length; i++) {
              const b = card.blocks[i]
              if (!b || b.type !== 'note' || b.seq === undefined) continue
              let full = ''
              for (let k = liveEvents.length - 1; k >= 0; k--) {
                const ev = liveEvents[k]
                if (!ev || ev.seq === undefined) continue
                if (ev.seq === b.seq) {
                  if (ev.type === 'assistant/message') full = extractProcessText(ev.data && ev.data.message)
                  break
                }
                if (ev.seq < b.seq) break
              }
              if (full && full.length > String(b.text || '').length) {
                card.blocks[i] = { type: 'note', seq: b.seq, text: full }
                expanded++
              }
            }
            if (expanded > 0) console.log('[fs] 插话封口：还原 ' + expanded + ' 段被截断的过程正文')
          } catch (error) {
            console.log('[fs] 插话封口还原失败（不影响换卡）: ' + String(error && error.message || error))
          }
          card.blocks.push(notice && notice.old
            ? notice.old
            : { type: 'message', text: '✅ 已收到你的选择，继续处理中…' })
          void syncCard(bot, chatId, card, true).catch(() => {})
          // 2) Open a fresh card below for the rest of this turn. Resume the
          // watcher from the CURRENT event position so events already shown
          // on the old card are not replayed onto the fresh one.
          const fresh = makeCardState(turnAgent)
          fresh.footerMode = 'bare'    // 答题后续写仍是"过程卡"
          // 新卡游标 = 当前事件位置：split 之前的内容**已经**在旧卡上，绝不能再重放一遍
          // （旧实现的 seal 前补扫从 seqBefore 重放整轮，造成新卡与旧卡内容大面积重复）。
          fresh.cursor = sessionEvents(turnAgent.session).length
          // 新卡第一块就是醒目提示（CM 2026-10-02：插话要"新开卡片"，他这句话要在新卡上）
          if (notice && notice.fresh) fresh.blocks.push(notice.fresh)
          fresh.blocks.push({ type: 'message', text: '继续处理中…' })
          card = fresh
          void syncCard(bot, chatId, fresh, true).catch(() => {})
          stopCardWatcher = startCardWatcher(turnAgent, fresh, bot, chatId, rotateTables)
          entry.card = fresh
          return true
        },
      }
      // ⚠️ 顺序不能改（2026-09-23 修）：必须在 send() **之前**登记 activeTurns。
      // send() 会把 agent 立刻置为 running，`agent/status` 处理器在**同一拍**里读 activeTurns；
      // 登记晚一步（旧实现登记在 send 之后）时它读到「没有普通回合」，转而按 kind='notice'
      // 再开一张卡 —— 同一轮两张卡、都在镜像同一批会话事件（用户看到内容重复的两张卡）。
      activeTurns.set(turnAgent.id, entry)
      try {
        // skipSend：这一轮由命令通道（/plan <正文>）投递并启动，绝不能重复投递一次
        // （否则正文会被喂两遍，模型会看到两条一模一样的用户消息）。
        if (!(opts && opts.skipSend)) turnAgent.send(message, 'next-turn', true)
      } catch (error) {
        if (activeTurns.get(turnAgent.id) === entry) activeTurns.delete(turnAgent.id)
        throw error
      }
      void syncCard(bot, chatId, card, true).catch(() => {})
      stopCardWatcher = startCardWatcher(turnAgent, card, bot, chatId, rotateTables)
      let waitError = null
      try {
        await turnAgent.whenIdle()
      } catch (error) {
        waitError = error
        console.log('[fs] turn wait failed for ' + messageId + ': ' + String(error && error.message || error))
      }
      stopCardWatcher()
      // 只有"表里还是我这条"才删 —— 跨代共享后，新实例可能已经登记了它自己的 entry，
      // 无条件 delete 会把**别人正在跑的回合**从表里摘掉（又一次"两张卡"）。
      if (activeTurns.get(turnAgent.id) === entry) activeTurns.delete(turnAgent.id)
      if (waitError) {
        card.status = 'error'
        // 中断同样要把原因说清楚，并且**不能把「正在工作中…」留在卡上**
        //（旧实现直接 sync 现状 → 卡片永远停在"正在工作中…" + "失败"，用户看不出所以然）。
        card.blocks = card.blocks.filter((b) => !(b.type === 'message' && b.text === '正在工作中…'))
        card.blocks.push({
          type: 'message',
          text: '⚠️ 本轮中断：' + String(waitError && waitError.message || waitError),
        })
        void syncCard(bot, chatId, card, true).catch(() => {})
        return { card, reply: '（Agent 未产生文字回复）', hadOutput: false, waitError, failure: null }
      }
      // Catch-up scan: if the turn finished faster than the watcher's poll
      // interval, fold every event into the card now so narration and tool
      // panels are not lost. 用**本卡自己的游标**（不是本轮起点）→ 已镜像过的不会重放。
      scanCard(turnAgent, card)
      // Seal: promote the last note (the final reply) to a message block so
      // the reply is not duplicated as narration; drop the placeholder; kill
      // the status line.
      const events = sessionEvents(turnAgent.session)
      const failure = turnFailureReason(events, seqBefore)
      // 2026-10-01 CM 报障：「你的正式回复又被截断了，结论卡片只有这一句话，其他都进了
      // 你的过程卡片」。根因：旧实现把「最后一条 assistant 文本」当结论，而 agent 常把正文
      // 写在**最后一次工具调用之前**（本次实录：正文 → present → 一句收尾），于是那句收尾
      // 顶替了整段答复，真正的正文只剩过程卡上被 MAX_NOTE_CHARS(500) 截断的 note。
      // 新口径（结构性判据，不用长度阈值）：从末尾往前收集 assistant 文本，
      // 遇到**纯目的行旁白**即停 —— 旁白是段落边界，答复不跨旁白。
      // 收紧后的口径（结构性判据，不用长度阈值、也不用长度倍数）：
      //   · 遇到**纯目的行旁白**即停 —— 旁白是段落边界，答复不跨旁白；
      //   · 连续两段文本之间**没有工具调用** ⇒ 只取最后那段（那是同一段叙述的多次快照，
      //     例：seq 重放、或一次 push 多条事件）⇒ **绝不把它们拼起来**；
      //   · 中间**隔着工具调用** ⇒ 允许再取上一段 —— 这正是「正文 → present → 收尾」
      //     的真实形态，正文必须跟着收尾一起进结论卡；
      //   · 同一 seq 只收一次。
      // 少了前两条约束时，一个「全程无旁白、无工具调用」的回合会把整轮文本都并进结论
      // （smoke 7 重复文本、smoke 12 六张表并成一张卡，两次都是这么踩到的）。
      const spokenBlocks = []
      const spokenSeqs = new Set()
      let crossedTool = false
      for (let i = events.length - 1; i >= seqBefore; i--) {
        const event = events[i]
        if (!event) continue
        if (event.type === 'tool/call' || event.type === 'tool/result') { crossedTool = true; continue }
        if (event.type !== 'assistant/message') continue
        const spoken = extractProcessText(event.data && event.data.message)
        if (!spoken) continue
        if (isNarrationOnly(spoken)) break
        if (spokenBlocks.length > 0 && !crossedTool) break
        if (event.seq !== undefined && spokenSeqs.has(event.seq)) continue
        if (event.seq !== undefined) spokenSeqs.add(event.seq)
        spokenBlocks.unshift({ seq: event.seq, text: spoken })
        crossedTool = false
      }
      // 整轮只有旁白（没有真正答复）时退回旧口径：取最后一条文本，但**不拆结论卡**。
      const narrationOnlyTurn = spokenBlocks.length === 0
      let replySeqs = spokenBlocks.map((block) => block.seq)
      let reply = spokenBlocks.map((block) => block.text).join('\n\n')
      if (!reply) {
        for (let i = events.length - 1; i >= seqBefore; i--) {
          const event = events[i]
          if (event && event.type === 'assistant/message') {
            const spoken = extractProcessText(event.data && event.data.message)
            if (spoken) { reply = spoken; replySeqs = [event.seq]; break }
          }
        }
      }
      if (!reply) reply = '（Agent 未产生文字回复）'
      const lastSeq = replySeqs.length > 0 ? replySeqs[replySeqs.length - 1] : undefined
      // 一个字都没说出来时，卡面**必须**说清为什么（2026-09-21 用户原话：「它不会提示我欠费，
      // 它不会把报错信息报出来，就直接显示说"本轮没有回复"」）：
      //   ① 有上游失败标记 → 写原因（中文人话 ＋ 上游原文）
      //   ② 没有失败标记  → 明说"原因未上报"，**不再**留下一句干巴巴的占位符
      const notSpoken = lastSeq === undefined
      const silent = notSpoken && card.tools.size === 0
      if (notSpoken && failure) {
        reply = '⚠️ 本轮没有产生回复：' + failure.text
      } else if (silent) {
        reply = '⚠️ 本轮没有产生回复：上游没有给出失败标记（原因未上报 —— 见 dsh 日志／GUI 里这一轮）'
      }
      card.status = (notSpoken && (failure || card.tools.size === 0)) ? 'error' : 'sealed'
      // 留痕：下次"卡片到底写了什么"不用再靠猜（飞书对 2.0 卡片只回占位符，读不回来）。
      console.log('[fs] turn sealed: status=' + card.status + ' silent=' + silent
        + ' failure=' + (failure ? failure.text : 'none')
        + ' reply_hash=' + shortHash(String(reply)) + ' reply_len=' + String(reply).length
        + ' card=' + (card.token || '-') + ' blocks=' + card.blocks.length
        + ' reply=' + JSON.stringify(String(reply).slice(0, 160)))
      card.blocks = card.blocks.filter((b) => !(b.type === 'message' && b.text === '正在工作中…'))
      // CM 2026-10-01 B 方案：本轮"有工具调用"或"耗时 ≥ 10s" ⇒ **结论独立成一张新卡**。
      // 依据：飞书只对**新消息**提醒；卡片原地 PATCH 不会二次提醒 ⇒ 长任务做完时用户收不到信号。
      // 结论卡是新的消息 ⇒ 有提醒；过程卡封口当"工作日志"（结论从它身上摘掉，避免重复）。
      // CM 2026-10-01 B 方案（修正版）：**只按耗时**判定 —— 「有工具调用」那条已删掉，
      // 因为它对几乎每一轮都成立（实测 12 秒的短任务也被分卡，CM 当场反馈）。
      const elapsedMs = Date.now() - turnStartedAt
      const splitMinMs = conclusionSplitMinMs(bot)
      // ---- 结论去重（2026-10-02 CM 报障「刚才那一段话，为什么发了给我两次？」）------------
      // 实证（web.log 69634→69649）：
      //   69634 `turn sealed` card=…a877c91b3 / 69636 `turn sealed` card=…9621c1113
      //   69635 `conclusion split` tools=83   / 69637 `conclusion split` tools=26
      //   69642 `card created` payload_md5=4326a255
      //   69645 `card created` payload_md5=4326a255   ← **同一 payload**
      //   69648 `card reply delivered` / 69649 `card reply delivered`  ← 发了两次
      // 成因：插件**热重载**（那一轮里 apply #8–#11）会重建模块状态，但上一代实例里
      // 还在 `await whenIdle()` 的回合链条**不会被注销**；它和新链条在同一秒各自收尾
      // ⇒ 两条链各封一次口、各拆一张结论卡。**与 steer/插话无关**（插话只是让两条链
      // 各自持有不同的卡，所以看起来像"两张卡"）。
      // 收敛口径：结论按「agent + 回复正文哈希」**跨代际**去重（记在 globalThis 上）。
      // **先到先得** ⇒ 不会丢结论（谁先收尾谁发），也不会重复发新卡；窗口 2 分钟。
      const CONCLUSION_DEDUPE_WINDOW_MS = 120000
      const conclusionSeen = globalThis.__fsConclusionSeen
        || (globalThis.__fsConclusionSeen = new Map())
      // ⚠️ **只在「本来就会开结论卡」的回合上做去重**：短回合（未达阈值／纯旁白）完全不受影响。
      // 否则同一进程里两轮相同文本的短回复会被误并（冒烟用例大量是短回合）。
      const conclusionEligible = !notSpoken && !narrationOnlyTurn && elapsedMs >= splitMinMs
      // 2026-10-02 代码审查 low#13：这个 32 位指纹同时充当**结论去重的 key**，撞了就会把
      // 一条正常结论静默换成"✅ 本轮已完成…"。
      // ⚠️ 但**不许靠"掺盐"来防撞**（第三轮门槛 medium#2）：这张表挂在 globalThis 上，
      // 存在的意义就是**跨代际**去重（上一代的旧代码可能还在收尾同一段回复）；一旦改了
      // key 的推导，旧代码写进去的条目就永远对不上 ⇒ 升级后那一次热重载的去重直接失效，
      // 用户又会看到一次"同内容两张卡"。⇒ key 推导保持**跨版本稳定**，防撞改用**长度**
      // 作为**第二判据**（分开存、分开比；旧条目没有 len 时按"兼容"放过）。
      const replyHash = conclusionEligible ? shortHash(String(reply)) : ''
      const replyLen = String(reply).length
      let duplicateConclusion = false
      if (conclusionEligible) {
        const prevConclusion = conclusionSeen.get(turnAgent.id)
        duplicateConclusion = Boolean(prevConclusion)
          && prevConclusion.hash === replyHash
          && (prevConclusion.len === undefined || prevConclusion.len === replyLen)
          && (Date.now() - prevConclusion.at) < CONCLUSION_DEDUPE_WINDOW_MS
        if (duplicateConclusion) {
          console.log('[fs] duplicate conclusion suppressed: agent=' + turnAgent.id
            + ' hash=' + replyHash + ' age_ms=' + String(Date.now() - prevConclusion.at))
        } else {
          conclusionSeen.set(turnAgent.id, { hash: replyHash, len: replyLen, at: Date.now() })
        }
      }
      // 纯旁白的一轮不开结论卡：卡面上只有一行 🎯 目的行 = 无信息卡片。
      const splitConclusion = conclusionEligible && !duplicateConclusion
      // A 方案：**不分卡**时这张卡本身就是结论卡 ⇒ 升级成完整状态栏；
      // 分卡时它只是过程卡 ⇒ 保持 bare（状态栏由下面新开的结论卡承担）。
      if (!splitConclusion) card.footerMode = 'full'
      let replaced = false
      if (duplicateConclusion) {
        // 重复链条：**不再重复发送结论**，本卡只留一行指路（正文不重复、也不新开卡）。
        card.blocks = card.blocks.filter((b) => !(b.type === 'note' && replySeqs.includes(b.seq)))
        card.blocks.push({ type: 'message', text: '✅ 本轮已完成，结论见上方卡片。' })
        replaced = true
      } else if (splitConclusion) {
        // 摘掉镜像进来的结论 note，改一行指路（正文一个字不丢：整段进下面的结论卡）
        card.blocks = card.blocks.filter((b) => !(b.type === 'note' && replySeqs.includes(b.seq)))
        card.blocks.push({ type: 'message', text: '✅ 本轮完成，结论见下方卡片。' })
        replaced = true
      } else if (replySeqs.length > 0) {
        // 把**第一条**被镜像的 note 就地换成完整答复（保持时间顺序），其余同批 note 删掉
        // （否则同一段话会既在过程区各出现一次、又在结论处出现一次）。
        for (let i = 0; i < card.blocks.length; i++) {
          const b = card.blocks[i]
          if (b.type === 'note' && replySeqs.includes(b.seq)) {
            card.blocks[i] = { type: 'message', text: reply }
            replaced = true
            break
          }
        }
        if (replaced) {
          card.blocks = card.blocks.filter((b) => !(b.type === 'note' && replySeqs.includes(b.seq)))
        }
      }
      if (!replaced) card.blocks.push({ type: 'message', text: reply })
      // 2026-09-27：记下这张刚封口的回合卡 —— 同一轮里紧接着起的 goal/notice 自动轮
      // 会在 AUTO_CARD_REUSE_MS 内复用它，而不是另开一张（见 recentTurnCards 注释）。
      rememberRecentTurnCard(turnAgent.id, { card, bot, chatId, sealedAt: Date.now() })
      if (splitConclusion) {
        console.log('[fs] conclusion split: agent=' + turnAgent.id + ' elapsed=' + elapsedMs
          + 'ms threshold=' + splitMinMs + 'ms tools=' + card.tools.size
          + ' reply_len=' + String(reply).length)
        try {
          await syncCard(bot, chatId, card, true)          // 先把过程卡封口推上去
          const conclusion = makeCardState(turnAgent)
          conclusion.cursor = events.length
          conclusion.status = card.status
          conclusion.blocks.push({ type: 'message', text: reply })
          await syncCard(bot, chatId, conclusion, true)     // 新消息 = 新卡 ⇒ 飞书会提醒
          // ⚠️ 2026-10-01 审计实测（smoke 34）：`syncCard` **内部把异常吞掉了**
          //    （catch 里只置 `createFailed`／`circuitOpen`，不往外抛）⇒ 建卡失败时这里
          //    依旧会"顺利"走到下面；结果是过程卡写着「结论见下方卡片」、而下面**根本没有那张卡**
          //    （日志特征：`conclusion card opened … card=-`）＝结论只靠纯文本兜底、卡片链条断掉。
          //    ⇒ 必须自己检查 token，未拿到就抛进 catch 走单卡回退。
          if (!conclusion.token) throw new Error('conclusion card not created (createFailed/circuitOpen)')
          rememberRecentTurnCard(turnAgent.id, { card: conclusion, bot, chatId, sealedAt: Date.now() })
          console.log('[fs] conclusion card opened: agent=' + turnAgent.id
            + ' card=' + (conclusion.token || '-'))
          return {
            card: conclusion,
            reply,
            hadOutput: true,
            waitError: null,
            failure,
            split: true,
          }
        } catch (error) {
          // 建结论卡失败绝不能把回复弄丢：退回单卡（过程卡里补回完整结论）
          console.log('[fs] conclusion card failed, falling back to single card: '
            + String(error && error.message || error))
          card.blocks = card.blocks.filter((b) => !(b.type === 'message' && b.text === '✅ 本轮完成，结论见下方卡片。'))
          card.blocks.push({ type: 'message', text: reply })
          // 回退**必须把这个改动推上去**：否则飞书上那张过程卡仍停在「结论见下方卡片」，
          // 用户永远等不到下面那张卡（＝结论丢失）。2026-10-01 smoke 34 钉住这条。
          card.footerMode = 'full'   // 它现在就是结论卡 ⇒ 该摆状态栏（与"不分卡"路径一致）
          try { await syncCard(bot, chatId, card, true) } catch {}
        }
      }
      return {
        card,
        reply,
        hadOutput: lastSeq !== undefined || card.tools.size > 0,
        waitError: null,
        failure,
      }
    }

    let turn = await runTurn(commandHold && commandHold.agent ? commandHold.agent : agent,
      commandHold ? { skipSend: true, seqBefore: commandHold.seqBefore } : undefined)
    if (!turn.hadOutput && turn.failure) {
      // 上游已经明确报错（402 欠费／401 密钥／429 限流…）⇒ **重建会话修不好它**。
      // 旧行为：照样重建会话＋重试一次 —— 白跑一轮、二次失败，还把真正的报错
      // 换成「已自动重建会话重试」（用户 2026-09-21：「它不会提示我欠费…就直接显示
      // 说本轮没有回复」）。现在：原因留在卡上（runTurn 已写），**不自愈**。
      console.log('[fs] skip self-heal: upstream failure (' + turn.failure.text + ')')
    } else if (!turn.hadOutput && sessionReused) {
      // Reused/resumed session produced nothing at all — the signature of a
      // session whose turn was killed by a dsh web restart (2026-09-08). Drop
      // it and answer from a brand-new session so the user never gets a blank
      // reply; keep the old entry's history in DSH storage, just unbind it.
      const failedTurn = turn
      const stale = chat.sessions[chat.activeIndex]
      console.log('[fs] session ' + (stale && stale.id || '?') + ' produced no output; recreating session and retrying once')
      // 旧卡不能停在「正在工作中…」：它已经被 runTurn 封口（状态 + 失败原因都在卡对象里），
      // 但旧的调用路径只在**重试后的**新卡上 sync → 旧卡在飞书里永远转圈（真机 14:35:28 那张）。
      // 这里把它封口后的状态推上去；建卡本来就失败（createFailed/无 token）时 syncCard 会自行跳过。
      try { await syncCard(bot, chatId, failedTurn.card, true) } catch { /* 推送失败不影响重试 */ }
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
        // 提示必须**上卡**：旧实现只把它拼进 turn.reply，而卡片送达时用的是卡对象的 blocks
        // → 走卡片路径的用户根本看不到这句（只有卡片失败退化成纯文本时才带）。
        // 原因用上游给的真实原因（有的话），不再一律猜「可能被 dsh 重启打断」。
        const why = failedTurn.failure ? '（' + failedTurn.failure.text + '）' : ''
        const notice = '⚠️ 上一会话本轮没有产生回复' + why + '，已自动重建会话重试。'
        turn.reply = notice + '\n\n' + turn.reply
        turn.card.blocks.unshift({ type: 'message', text: notice })
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

  async function spawnHelper(bot) {
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
    // 2026-10-02 升级 dsh 0.2.0-rc.2 的真机抓出：`ctx.shell.start(spec)` 已被改名。
    // 0.2 的 ShellExecutor（@deepseek-ai/dsh-shell）抽象方法是 resolve(request) / execute(spec)；
    // 返回的 ShellExecution **形状与旧句柄兼容**（status / kill() / readOutput().delta 都在）。
    // ⚠️ 另一处必须适配的是**超时**：0.2 的 resolve() 会填 timeoutMs 并按 onExpiry 处理，
    // **默认 'kill' 会把我们这种长驻 helper 直接杀掉** ⇒ 必须显式 onExpiry:'none'
    //（官方注释：none 不设截止时间，只能由调用方 signal 或 kill() 停止）。
    // 老版本没有 execute ⇒ 自动退回 start，两个版本都能跑。
    const useExecute = typeof ctx.shell.execute === 'function'
    const shellRequest = {
      command: 'node ' + quoteArg(HELPER_PATH) + ' ' + quoteArg(appId) + ' ' + quoteArg(appSecret),
    }
    if (useExecute) shellRequest.onExpiry = 'none'
    const spec = ctx.shell.resolve(shellRequest)
    try {
      bot.proc = useExecute ? await ctx.shell.execute(spec) : await ctx.shell.start(spec)
    } catch (error) {
      console.log('[fs] helper start failed: ' + (error && error.message ? error.message : String(error)))
      bot.proc = undefined
      return
    }
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
      spawnHelper(bot).catch(error => {
        console.log('[fs] spawnHelper failed: ' + String((error && error.message) || error))
      })
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
      // 改造⑤：登记 CM 这条消息，便于他之后引用自己的消息时也能带上下文
      rememberMessage(evt.message_id, 'CM 的消息：' + String(text || '(非文本消息)'))
      const cmd = text ? splitCommand(text) : undefined
      if (cmd) {
        const chatId = evt.chat_id
        const chat = bot.chats.get(chatId) || { sessions: [], activeIndex: 0 }
        bot.chats.set(chatId, chat)
        // 2026-10-01 修复①（真实入口）：命令**可能在会话里起一个真回合**（/plan <正文>）。
        // 那种情况绝不能在这里 return —— 要落回 handleInbound 走「建卡 → 等回合 → 封口」，
        // 否则那一整轮没有任何卡片持有它（CM 报障「飞书上没有看到卡片」的根因）。
        handleCommand(bot, chat, chatId, cmd).then((outcome) => {
          if (!outcome || !outcome.turnStarted) return
          bot.chain = bot.chain.then(() => handleInbound(bot, evt, outcome.turnStarted)).catch((error) => {
            console.log('[fs] handler error: ' + String(error && error.stack || error))
          })
        }).catch((error) => {
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
        // 2026-10-02 代码审查 medium#3：这条是**文字回答的主路径**（飞书每条纯文本都走这里），
        // 原来漏了 splitLiveCardAfterAnswer ⇒ 回了"批准"之后，上面那张流式卡不被冻结，
        // 整轮后续内容继续堆到他已经划过去的那张卡上（＝"我答了，它却没动"那次回归）。
        // 顺序与 handleInbound 的文字路径一致：先换卡，再改「已收到」态，最后 resolve。
        splitLiveCardAfterAnswer(pendingQ.agentId)
        // 2026-10-02：卡片要跟着变成「✅ 已收到」态（否则按钮仍可点、点了报 record not found）
        finalizeQuestionCard(pendingQ, text)
        pendingQ.resolve(buildQuestionAnswer(pendingQ.questions, text))
        console.log('[fs] question answered via chat: ' + chatId)
        sendPlainText(bot, chatId, '✅ 已收到你的回答。').catch(() => {})
        return
      }
      // 回合进行中 ⇒ 直接插话（steer），不再排到 bot.chain 后面等整轮跑完。
      // 见 steerActiveTurn：只有「活跃回合 + 普通消息」才走这条，其余（含无活跃回合）
      // 一律落回原来的串行链，行为不变。
      if (steerActiveTurn(bot, evt, text)) return
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
    if (!agent) return undefined
    const key = String(agent.id || '')
    for (const bot of bots.values()) {
      for (const [chatId, chat] of bot.chats) {
        for (const s of chat.sessions || []) {
          // 2026-10-02 真机诊断（日志：[fs] agent/status skip: no chat owner fs-main-muppqw21）：
          // 原来**只按活着的 handle 匹配**，而 handle **不落盘** —— HMR 重载/重启一重建插件内存态就丢；
          // 目标轮又不经过消息路径去 resolveAgent 补 handle ⇒ 认不出归属 ⇒ 目标卡被静默跳过。
          // 会话 id 就是 agent id（生产实测两者同为 fs-main-*）且**已落盘**，按它匹配跨重载稳定。
          if (key && String(s.id) === key) return { bot, chatId }
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

  // ─── 工作区 / 会话 两级切换（CM 2026-10-02 定稿 A 方案，与 GUI 同源）────────────
  // CM 原话：「切换会话 = 可以切到**任何一个工作区**；会话列表 = **同一个工作区里面的不同会话**」——
  // 这正是 DSH 自己的模型：**工作区是 `workspaceRegistry` 里的注册实体**
  //（`{path,title,sessionIds[]}`，GUI 侧边栏用的就是它），**会话挂在它下面**（实体的 `sessionIds`）。
  // 旧实现把两个概念混在一张卡里：第③组标题写"其它工作区"，列的其实是"别的工作区里的会话"，
  // 而且是**从会话 cwd 反推、从不读注册表**（旧代码里 `workspaceRegistry` 零命中）⇒ 飞书与 GUI 可能各说各话。
  // 现在分两级：
  //   ① `/switch` → **工作区卡**（注册表优先 + 会话里出现过的目录兜底），每行「进入看会话」/「在这里新建」；
  //   ② 点「进入」（或 `/switch <工作区序号>`）→ **该工作区的会话卡**，每行「接管」/「新建」，
  //      底部有「← 返回工作区列表」；
  //   ③ `/list` = **当前工作区的会话**（当前工作区 ＝ 活跃会话的 cwd）。
  // 两个安全约束（写进卡面，不让 CM 猜）：
  //  · 正在别处运行的会话（🟡）**不给"接管"** —— DSH 里同一会话被两处同时驱动会写坏历史，
  //    只允许"在该工作区新建"。
  //  · "新建"不碰任何旧会话：只是在该工作区开一个全新会话（cwd = 那个工作区），
  //    并**顺手挂进 `workspaceRegistry`**（best-effort）⇒ GUI 侧边栏也立刻看得到它。
  const SWITCH_CARD_TTL_MS = 15 * 60 * 1000
  const SWITCH_SUMMARY_MAX_BYTES = 4 * 1024 * 1024   // 只对小于此体积的日志读"首条消息"当摘要
  const SWITCH_SUMMARY_TIMEOUT_MS = 1500
  const SWITCH_WS_LIMIT = 12          // 工作区最多列几个（注册表之外从会话兜底补的也算在里面）
  const SWITCH_SESS_LIMIT = 12        // 单个工作区的会话最多列几行（卡片行数有上限）
  const SWITCH_SESS_PAGE = 5          // CM 2026-10-02：「只显示 5 个会话，每一页显示 5 个，做一个翻页」
  const SWITCH_SESS_MAX = 50          // 翻页也只翻最近 50 个（避免为一个工作区读上百条会话）
  const pendingSwitchCards = new Map()   // token -> { bot, chatId, wsRows, ws, sessRows, timer }

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
  // ---- 只读回填会话标题（2026-10-02 CM 选方案 A）----------------------------------
  // 场景：会话表里那些**当前没有活句柄**的历史会话（/list 显示「主会话 / 会话 N」）。
  // 为什么不去 resume：resume 会重放整个会话日志（实测最大 9.98 MB），还可能撞上
  // 「会话被另一个实例持有」；而 **session/title 事件在 seq 14~18（非常靠前）**
  // ⇒ 只读文件**前 512 KB**、逐帧解压就够，全程**不动任何 DSH 状态**。
  // v4/v3 的文件名都认，另兼容 0.1.x 的旧名 session.jsonl.zstd。
  const logTitleCache = new Map()     // sessionId -> title（含空串；避免每次 /list 重复读盘）

  function sessionLogDirs(sessionId) {
    const out = []
    try {
      const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
      for (const proj of readdirSync(root)) {
        const dir = join(root, proj, String(sessionId))
        if (existsSync(dir)) out.push(dir)
      }
    } catch { /* 目录读不到就当作没有 */ }
    return out
  }

  function titleFromLogFile(file) {
    try {
      if (typeof zstdDecompressSync !== 'function') return ''
      const size = statSync(file).size
      const want = Math.min(size, 512 * 1024)
      if (want <= 0) return ''
      const fd = openSync(file, 'r')
      const buf = Buffer.allocUnsafe(want)
      let got = 0
      try { got = readSync(fd, buf, 0, want, 0) } finally { closeSync(fd) }
      const data = buf.subarray(0, got)
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
      let last = ''
      let i = 0
      for (;;) {
        const k = data.indexOf(magic, i)
        if (k < 0) break
        const next = data.indexOf(magic, k + 4)
        const end = next < 0 ? data.length : next
        i = k + 4
        let text = ''
        try { text = zstdDecompressSync(data.subarray(k, end)).toString('utf8') } catch { continue }
        if (text.indexOf('session/title') < 0) continue
        for (const line of text.split('\n')) {
          if (line.indexOf('session/title') < 0) continue
          try {
            const rec = JSON.parse(line)
            const t = rec && rec.type === 'session/title' && rec.data && rec.data.title
            if (typeof t === 'string' && t.trim()) last = t.trim()
          } catch { /* 被截断的半行，跳过 */ }
        }
      }
      return last
    } catch { return '' }
  }

  function titleFromLogs(sessionId) {
    const key = String(sessionId || '')
    if (!key) return ''
    if (logTitleCache.has(key)) return logTitleCache.get(key)
    let found = ''
    outer:
    for (const dir of sessionLogDirs(key)) {
      let files = []
      try {
        files = readdirSync(dir)
          .filter((f) => /^session(\.v\d+)?\.jsonl\.zstd$/.test(f))
          .sort()
          .reverse()          // v4 > v3 > 旧名（字符串降序即可）
      } catch { continue }
      for (const f of files) {
        found = titleFromLogFile(join(dir, f))
        if (found) break outer
      }
    }
    logTitleCache.set(key, found)
    if (found) console.log('[fs] session title backfilled from log: ' + key + ' -> ' + found)
    return found
  }

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
    // 2026-10-02 A 方案：调用方现在会传"只有活会话、没有持久化快照"的行（meta === undefined），
    // 以及注册表/持久化服务缺失的情况 ⇒ 这里必须先挡住，否则整张会话卡会崩在 `meta.id` 上。
    if (!sp || !meta || !meta.id) return ''
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

  // 工作区注册表（DSH 原生，GUI 侧边栏用的就是它）。宿主侧服务名 `workspaceRegistry`，
  // 客户端侧叫 `workspaces` —— 两个都试；拿不到就退回"从会话 cwd 反推"（见 buildWorkspaceRows）。
  function registryEntities() {
    try {
      const reg = ctx.get('workspaceRegistry') || ctx.get('workspaces')
      if (!reg || typeof reg.list !== 'function') return []
      const list = reg.list()
      return Array.isArray(list) ? list : []
    } catch (error) {
      console.log('[fs] switch: workspace registry list failed: ' + String(error && error.message || error))
      return []
    }
  }

  function cwdOfEntry(entry, live) {
    const agent = live.get(String(entry && entry.id)) || (entry && entry.handle && entry.handle.agent)
    const header = agent && agent.session && agent.session.header
    return String((header && header.cwd) || (entry && entry.cwd) || '')
  }

  // **当前工作区 ＝ 活跃会话的 cwd**（插件里没有"当前工作区"这个独立状态；见背景事实库第九节）。
  // ⚠️ 口径必须与 sessionCandidates **完全一致**（门槛第三轮 medium#1）：
  // 那边是"持久化值优先、活 header 只兜底"，这里原来只看活 header/handle ——
  // 而 `persistChats` 只存 id/label/title/type/gen，**不存 cwd** ⇒ 插件重启后、第一条消息之前，
  // 活跃会话既没有活 agent 也没有 handle，cwdOfEntry 返回空 ⇒ 退回 bot 默认工作区，
  // 与同一条会话的候选（有真实持久化 cwd）**不一致** ⇒ /list 会指到默认工作区、
  // 卡上"当前工作区"也标错，连"当前工作区必在卡上"那条兜底都会找不到对象而静默跳过。
  // ⇒ 优先用候选集合里那条会话的 cwd（已经过同一套"持久化优先"规则）。
  function currentWorkspaceOf(bot, chat, cands) {
    const live = liveAgentsById()
    const active = chat && chat.sessions && chat.sessions[chat.activeIndex]
    const id = active ? String(active.id) : ''
    let cwd = ''
    if (cands && id) {
      const hit = cands.find((c) => String(c.id) === id)
      if (hit && hit.cwd) cwd = String(hit.cwd)
    }
    if (!cwd) cwd = active ? cwdOfEntry(active, live) : ''
    return { cwd: cwd || String((bot.cfg && bot.cfg.workspace) || '') }
  }

  // 会话候选三源合并（活 agent / 持久化快照 / 本聊天会话），按 id 去重。
  // ⚠️ 为什么不能只信注册表：`entity.sessionIds` 是**落盘列表**（只在 bootstrap 重建），
  //   刚新建的会话不会自动进去 ⇒ 只读注册表会把"刚切过去的那个会话"漏掉。
  async function sessionCandidates(bot, chat) {
    const live = liveAgentsById()
    const out = new Map()
    for (const [id, agent] of live) {
      const header = agent && agent.session && agent.session.header
      // ⚠️ 兜底时间戳**必须稳定**（门槛第二轮 medium）：原来这里写 Date.now()，
      // 于是"有活会话、但没有持久化快照"的会话每次调用都换时间 ⇒ ① 会话行排序会漂移
      // （卡片序号与文字命令序号对不上）② 工作区卡上的"最近活动"永远显示当前时刻。
      // 活性由 🟡 表达就够，时间戳只用 id 里能还原的那部分（认不出＝0，交给 id 字典序兜底）。
      out.set(String(id), {
        id: String(id), cwd: String((header && header.cwd) || ''),
        mtime: sessionIdTime(String(id)), meta: undefined, size: undefined,
      })
    }
    const sp = ctx.get('sessionPersistence')
    if (sp && typeof sp.list === 'function') {
      let all = []
      try { all = await sp.list() } catch (error) {
        console.log('[fs] switch: persistence.list failed: ' + String(error && error.message || error))
      }
      for (const meta of all || []) {
        if (!meta || !meta.id) continue
        if (meta.origin === 'subagent' || (meta.delegationDepth || 0) > 0) continue   // 子代理子会话不是可切换目标
        const id = String(meta.id)
        const info = artifactInfo(sp, meta)
        const prev = out.get(id)
        out.set(id, {
          id,
          cwd: String(meta.cwd || (prev && prev.cwd) || ''),
          mtime: (info && info.mtime) || (prev && prev.mtime) || Number(meta.createdAt) || 0,
          meta,
          size: info && info.size,
        })
      }
    }
    for (const s of (chat && chat.sessions) || []) {
      const id = String((s && s.id) || '')
      if (!id) continue
      const prev = out.get(id)
      // 会话属于哪个工作区：**持久化值优先**（一旦有快照就以它为准），活 header 只当兜底。
      // 理由（2026-10-02 冒烟实测）：活 header 是"当前状态"，若被别的东西改过（测试里多个会话
      // 共用一个 agent 对象、或 resume 后 header 变化），用它覆盖会把会话挪到错误的工作区行下
      // ⇒ 分组与序号一起错。生产里两者本应一致，一旦不一致也以**落盘的那份**为准。
      const cwd = (prev && prev.cwd) || cwdOfEntry(s, live)
      out.set(id, {
        id,
        // 空 cwd 的会话（活 agent 没 header.cwd / 快照没 meta.cwd）原来会**从所有列表里消失**
        // （sameWorkspace('', …) 恒假、make('') 又直接跳过）⇒ 兜到 bot 的默认工作区，
        // 与 currentWorkspaceOf 同一条兜底规则（门槛第二轮 low）。
        cwd: cwd || (prev && prev.cwd) || String((bot.cfg && bot.cfg.workspace) || ''),
        // ⚠️ 兜底时间戳**必须稳定**（2026-10-02 冒烟实测）：原来这里写 Date.now()，
        // 于是"没有持久化快照的会话"每次调用都拿到新时间 ⇒ 卡片序号与文字命令
        // `/switch <工作区> <序号>` 重建出来的序号会漂移（同一行指到不同会话）。
        // 我们自己的会话 id 形如 `fs-main-<base36 时间戳>` ⇒ 直接从 id 里还原真实创建时间。
        mtime: (prev && prev.mtime) || sessionIdTime(id),
        meta: prev && prev.meta,
        size: prev && prev.size,
      })
    }
    return [...out.values()]
  }

  function dirExists(path) {
    try { return Boolean(path) && existsSync(String(path)) } catch { return false }
  }

  // 从我们自己的会话 id 里还原创建时间（`fs-main-<Date.now().toString(36)>`）——
  // 用于给"没有持久化快照"的会话一个**稳定**的排序时间（见下面那处注释）。认不出就返回 0。
  function sessionIdTime(id) {
    const m = /^fs-main-([0-9a-z]+)$/.exec(String(id || ''))
    if (!m) return 0
    const t = parseInt(m[1], 36)
    return Number.isFinite(t) && t > 0 ? t : 0
  }

  // 第一级：**工作区行**。注册表优先（与 GUI 同源），再用"会话里出现过的目录"兜底
  //（注册表只在 bootstrap 重建，运行期新建的会话目录可能还没被收录）。
  async function buildWorkspaceRows(bot, chat, precomputed) {
    const live = liveAgentsById()
    // cands 可由调用方传入：/list 与 /switch 都会紧接着再算一次会话行，
    // 不传的话每次命令都要把 sp.list() + 逐会话 artifactInfo 干两遍（门槛第二轮 medium#2）。
    const cands = precomputed || await sessionCandidates(bot, chat)
    const current = currentWorkspaceOf(bot, chat, cands)
    const regRows = []
    const fbRows = []
    const seen = new Set()
    const make = (path, rec) => {
      const key = String(path || '').replace(/[\\/]+$/, '').toLowerCase()
      if (!key || seen.has(key)) return null
      seen.add(key)
      return {
        workspaceId: rec.id || '',
        workspace: String(path),
        path: String(path),
        title: rec.title || workspaceLeaf(path),
        entity: rec.entity,
        sessionIds: rec.sessionIds || [],
      }
    }
    for (const e of registryEntities()) {
      let path = ''
      try { path = String(e.path || '') } catch { }
      if (!path) continue
      let ids = []
      try { ids = Array.isArray(e.sessionIds) ? e.sessionIds.map(String) : [] } catch { }
      const row = make(path, { id: e.id, title: e.title, sessionIds: ids, entity: e })
      if (row) regRows.push(row)
    }
    for (const c of cands) {
      const row = make(c.cwd, { id: '', title: '', sessionIds: [] })
      if (row) fbRows.push(row)
    }
    // 兜底行按**规范化路径**排序（门槛第二轮 medium#5）：注册表顺序本身是稳定的，但兜底行
    // 原来按 sessionCandidates 的枚举顺序追加 ⇒ 卡片序号与 `/switch <工作区序号>`、`/list` 里的
    // 「第 N 个」会在两次构建之间漂移（与会话行要修的是同一类缺陷）。
    fbRows.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()) || a.path.localeCompare(b.path))
    // 上限对**注册表行也生效**（门槛第二轮 low#4），但**两段分别限流**（第二轮 medium#1）：
    // 原来 `[...regRows, ...fbRows].slice(0, 12)` 在注册表 ≥12 条时会把**兜底行全部挤掉**
    // —— 包括"只从会话 cwd 出现的工作区"，甚至可能是当前工作区 ⇒ 那些工作区再也点不到。
    // ⚠️ FB_RESERVE 是**下限保留**，不是"兜底行封顶"（门槛第三轮 medium#3）：
    // 原来写成 `fbRows.slice(0, FB_RESERVE)` ⇒ 注册表只有 1 条时，兜底行也被压到 ≤4 席，
    // 剩下 7 个空位白白浪费、那些工作区既上不了卡也选不到（只有"当前工作区"靠兜底append 幸存）。
    // ⇒ 兜底行先占满注册表没用到的那部分预算，再按下限补齐。
    const FB_RESERVE = Math.min(fbRows.length, Math.max(2, Math.floor(SWITCH_WS_LIMIT / 3)))
    const regTake = regRows.slice(0, SWITCH_WS_LIMIT - FB_RESERVE)
    // regTake 已被 12-FB_RESERVE 压住 ⇒ 12-regTake.length 恒 ≥ FB_RESERVE，
    // "下限保留"其实是 regTake 那一刀保证的（门槛第四轮 low：原来写成 Math.max(...) 是永远不成立的分支）。
    const fbTake = fbRows.slice(0, SWITCH_WS_LIMIT - regTake.length)
    let rows = [...regTake, ...fbTake]
    // 当前工作区**必须在卡上**（哪怕它在注册表里排得很后）——不然用户看不到"我在哪、怎么回来"。
    if (current.cwd && !rows.some((r) => sameWorkspace(r.path, current.cwd))) {
      const cur = [...regRows, ...fbRows].find((r) => sameWorkspace(r.path, current.cwd))
      if (cur) rows = [...rows.slice(0, SWITCH_WS_LIMIT - 1), cur]
    }
    for (const row of rows) {
      const ids = new Set(row.sessionIds)
      let mtime = 0
      for (const c of cands) {
        if (!sameWorkspace(c.cwd, row.path)) continue
        ids.add(String(c.id))
        mtime = Math.max(mtime, Number(c.mtime) || 0)
      }
      row.sessionIds = [...ids]
      row.sessionCount = row.sessionIds.length
      row.liveCount = row.sessionIds.filter((id) => live.has(String(id))).length
      row.mtime = mtime
      row.current = sameWorkspace(row.path, current.cwd)
    }
    // 健康判定（门槛第二轮 medium#6）：**本地目录检查说了算** —— 原来只认 `status()` 返回的
    // 'missing-dir' 这个 token，上游一旦换了别的值（或返回 undefined）而目录已经没了，
    // 卡面照样渲染成健康 🟢。⇒ 目录不在就是 ⚠️；目录在但上游说 missing-dir 也按 ⚠️ 处理。
    // 探活**并发**做（门槛第二轮 low）：串行 await 会把工作区卡的延迟随注册表条数线性拉长。
    await Promise.all(rows.map(async (row) => {
      let missing = !dirExists(row.path)
      try {
        if (!missing && row.entity && typeof row.entity.status === 'function') {
          missing = (await row.entity.status()) === 'missing-dir'
        }
      } catch { /* 判活失败 ⇒ 以目录检查结果为准 */ }
      row.status = missing ? 'missing-dir' : 'ok'
    }))
    return rows
  }

  // 第二级：**某个工作区里的会话行**。
  async function buildSessionRows(bot, chat, ws, precomputed) {
    const live = liveAgentsById()
    const all = precomputed || await sessionCandidates(bot, chat)
    const cands = all.filter((c) => sameWorkspace(c.cwd, ws && ws.path))
    // 排序必须**确定**（2026-10-02 冒烟实测）：卡片上的序号就是 `/switch <工作区> <序号>` 的入参，
    // 两次构建若排出不同顺序，CM 按卡面序号发文字就会接管到另一个会话。
    // ⇒ 三级稳定键：当前会话最前 → 最近活动在前 → 会话 id 字典序（兜底，保证全序）。
    // activeId 提到排序外（门槛第二轮 low）：排序期间 chat.activeIndex 不会变，放进比较器等于白算 O(n log n) 次。
    const activeId = String(((chat.sessions || [])[chat.activeIndex] || {}).id || '')
    cands.sort((a, b) => {
      const ca = String(a.id) === activeId ? 1 : 0
      const cb = String(b.id) === activeId ? 1 : 0
      const ma = Number(a.mtime) || 0
      const mb = Number(b.mtime) || 0
      return (cb - ca) || (mb - ma) || String(a.id).localeCompare(String(b.id))
    })
    // titleFromLogs 是**同步读盘**（每个项目目录 readdirSync + 读日志头）；旧实现只在"本聊天那几条"
    // 上用它。这里最多回填 TITLE_BACKFILL_MAX 条，其余留给下面的首条消息摘要（异步）（门槛第二轮 low#6）。
    const TITLE_BACKFILL_MAX = 5
    let backfilled = 0
    const rows = cands.slice(0, SWITCH_SESS_LIMIT).map((c) => {
      const idx = (chat.sessions || []).findIndex((s) => String(s.id) === String(c.id))
      const agent = live.get(String(c.id))
      let title = agent ? liveTitle(agent) : ''
      if (!title && backfilled < TITLE_BACKFILL_MAX) {
        backfilled += 1
        title = titleFromLogs(String(c.id))
      }
      return {
        sessionId: String(c.id),
        workspace: (ws && ws.path) ? String(ws.path) : '',
        // path 与 workspace 同值：attachSessionToWorkspace 的兜底链（resolveByPath / create）
        // 认的是 path，缺了它"注册表里没有的工作区"就永远挂不上（门槛第二轮 medium#3）。
        path: (ws && ws.path) ? String(ws.path) : '',
        workspaceId: (ws && ws.workspaceId) || '',
        inChat: idx >= 0,
        current: idx >= 0 && idx === chat.activeIndex,
        live: Boolean(agent),
        title,
        label: idx >= 0 ? String((chat.sessions[idx] && chat.sessions[idx].label) || '') : '',
        mtime: Number(c.mtime) || 0,
        summary: '',
        meta: c.meta,
        size: c.size,
      }
    })
    // 没标题的补"首条消息"当摘要（认得出是哪一个）；读盘有代价，最多 8 条
    const need = rows.filter((r) => !r.title).slice(0, 8)
    if (need.length) {
      const sp = ctx.get('sessionPersistence')
      const texts = await Promise.all(need.map((r) => firstUserText(sp, r.meta, r.size)))
      need.forEach((r, i) => { r.summary = texts[i] || '' })
    }
    return rows
  }

  // ---- schema 2.0 的按钮行（2026-10-02 血泪）------------------------------------------
  // 旧版 1.0 用 `{ tag: 'action', actions: [...] }` 包按钮；**schema 2.0 不再支持 action**
  // ——飞书直接拒建卡：`code 230099 / ErrCode 200861  ErrPath: ROOT -> body -> elements -> [3](tag: action)
  //   ErrMsg: cards of schema V2 no longer support this capability; unsupported tag action`（真机日志）。
  // 2.0 的写法（照抄本仓库**已在生产跑通**的提问卡 questionOptionRow）：
  //   column_set → column → button，且按钮回调走 `behaviors: [{ type: 'callback', value }]`。
  function switchButtonsRow(buttons, flexMode) {
    const list = buttons || []
    return {
      tag: 'column_set',
      // CM 2026-10-02：「两个按钮要**同一排**，不要分成两行」。
      // 两个按钮时用飞书文档里的 **bisect（二等分）** —— 这是"固定两列并排"的语义；
      // 其它数量退回 stretch。另：不写 background_style（默认值没必要，少一个不确定项）。
      flex_mode: flexMode || (list.length === 2 ? 'bisect' : 'stretch'),
      columns: list.map((b) => ({
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [{
          tag: 'button',
          type: b.type || 'default',
          width: 'fill',
          text: { tag: 'plain_text', content: b.label },
          behaviors: [{ type: 'callback', value: b.value }],
        }],
      })),
    }
  }

  // CM 2026-10-02 选定 **一级 F 版式**（在三个候选里挑的）：
  //   每个工作区两行 —— ① 名字 + 会话数（+ 真的有时才显示 🟡 运行中）
  //                     ② 「进入」「新建」两个按钮**并排**（bisect 等分，不会再被挤成省略号）
  //   卡片底部一个「✕ 取消」（撤销整张卡）。
  // 按他三条原则：**不显示**完整路径、时间戳、短 id、目录健康标记（除非真的有问题 ——
  // 目录不存在时把那一条的路径显示出来，因为那时"是哪个目录"才是必要信息）。
  function buildWorkspaceCard(rows, current) {
    const curName = current && current.cwd ? workspaceLeaf(current.cwd) : '（未定）'
    const elements = [{
      tag: 'markdown',
      content: '**第一步：选工作区**（共 ' + rows.length + ' 个）　当前：**' + curName + '**',
    }]
    rows.forEach((row, i) => {
      const bits = []
      if (row.sessionCount) bits.push(row.sessionCount + ' 个会话')
      if (row.liveCount) bits.push('🟡 ' + row.liveCount + ' 运行中')
      let line = (row.current ? '▶ ' : '') + (i + 1) + '. **' + row.title + '**'
      if (bits.length) line += '　' + bits.join(' · ')
      if (row.status === 'missing-dir') line += '　⚠️ 目录不存在\n　　`' + row.path + '`'
      elements.push({ tag: 'markdown', content: line })
      elements.push(switchButtonsRow([
        { label: '进入', type: 'primary', value: { fs_switch: row.token, fs_level: 'ws', fs_i: i } },
        { label: '新建', type: 'default', value: { fs_switch: row.token, fs_level: 'ws-new', fs_i: i } },
      ], 'bisect'))
    })
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'markdown',
      content: '<font color=\'grey\'>也可以发文字：`/switch <序号>` 看它的会话 ｜ `/switch <序号> new` 在该工作区新建</font>',
    })
    // CM：「加一个取消按钮，一按取消的话，这个卡片就撤销掉」
    elements.push(switchButtonsRow([
      { label: '取消', type: 'default', value: { fs_switch: (rows[0] && rows[0].token) || '', fs_level: 'cancel', fs_i: 0 } },
    ]))
    return {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '🗂 选择工作区' }, template: 'blue' },
      body: { elements },
    }
  }

  // 二级卡片（CM 2026-10-02 选定 C 版式 + 当晚三条修改）：
  //   · 一行一个会话：「序号. 标题 (+状态徽标)」 ｜ 右侧「切换」
  //   · **会话之间加一条分隔线**（CM：「这样看起来就更好看」）
  //   · **每页 5 个**，底部给「← 上一页 / 下一页 →」（翻页是 PATCH 同一张卡，不弹新卡）
  //   · 底部**只留 返回 / 取消**（新建收回到一级菜单的那个按钮上）
  // 会话名进按钮前的截断（CM 2026-10-02：按钮里的文字一旦超长就会被截成省略号）
  const SESSION_NAME_MAX = 16
  function clipSessionName(name) {
    const chars = [...String(name || '')]
    return chars.length > SESSION_NAME_MAX ? chars.slice(0, SESSION_NAME_MAX).join('') + '…' : chars.join('')
  }

  function buildSessionCard(ws, rows, pageInfo) {
    const info = pageInfo || { page: 0, pages: 1, total: rows.length }
    const elements = [{
      tag: 'markdown',
      content: '**第二步：选会话** —— **' + ws.title + '**'
        + '　' + info.total + ' 个会话（第 ' + (info.page + 1) + '/' + info.pages + ' 页）'
        + '\n<font color=\'grey\'>▶ 当前 ｜ 按最近活跃排序 ｜ 🟡 正在别处运行（不能切换）</font>',
    }]
    if (!rows.length) {
      elements.push({ tag: 'markdown', content: '（这个工作区还没有会话）' })
    }
    // CM 2026-10-02 选定 **L1 版式**：**会话名直接做成整行按钮**（点名字即切换）。
    // 为什么不是"左名字 + 右按钮"：真机实测（K1 左边只 3 个字）也会被渲染成**上下两行** ——
    // 手机端「文字 + 按钮」同行排不了，而**纯按钮行**能并排（K4 并排）。所以让按钮自己承载名字。
    rows.forEach((row, j) => {
      const n = j + 1
      const what = clipSessionName(row.title || row.summary || row.label || '（未命名会话）')
      const blocked = row.live && !row.inChat && !row.current
      if (j > 0) elements.push({ tag: 'hr' })      // CM：会话之间要分隔线
      if (blocked) {
        // 不能切换的行**不给按钮**（给了只会点出一句"不能接管"），用一行文字写清
        elements.push({
          tag: 'markdown',
          content: n + '. **' + what + '**　<font color=\'grey\'>🟡 正在别处运行，不能切换</font>',
        })
        return
      }
      elements.push({
        tag: 'button',
        type: row.current ? 'default' : 'primary',
        width: 'fill',
        text: { tag: 'plain_text', content: (row.current ? '▶ ' : '') + n + '. ' + what },
        behaviors: [{
          type: 'callback',
          value: { fs_switch: ws.token, fs_level: 'sess', fs_i: ws.index, fs_j: j, fs_mode: 'takeover' },
        }],
      })
    })
    elements.push({ tag: 'hr' })
    // 翻页（有第二页才出现）：一排两个等分；只有一侧可点时用 stretch 单个铺满
    if (info.pages > 1) {
      const pageBtns = []
      if (info.page > 0) {
        pageBtns.push({ label: '上页', type: 'default', value: { fs_switch: ws.token, fs_level: 'page', fs_i: ws.index, fs_page: info.page - 1 } })
      }
      if (info.page < info.pages - 1) {
        pageBtns.push({ label: '下页', type: 'default', value: { fs_switch: ws.token, fs_level: 'page', fs_i: ws.index, fs_page: info.page + 1 } })
      }
      elements.push(switchButtonsRow(pageBtns, pageBtns.length === 2 ? 'bisect' : 'stretch'))
    }
    // 底部整卡动作：**只留 返回 / 取消**（CM：「下面新建不要、只留返回、取消」）
    elements.push(switchButtonsRow([
      { label: '返回', type: 'default', value: { fs_switch: ws.token, fs_level: 'ws-back', fs_i: ws.index } },
      { label: '取消', type: 'default', value: { fs_switch: ws.token, fs_level: 'cancel', fs_i: ws.index } },
    ], 'bisect'))
    return {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '💬 ' + ws.title + ' 的会话' }, template: 'turquoise' },
      body: { elements },
    }
  }

  // 渲染二级卡片的**某一页**（翻页/首次进入都走这里；翻页＝PATCH 同一张卡）
  async function showSessionPage(bot, chatId, ws, record, all, page) {
    const total = (all || []).length
    const pages = Math.max(1, Math.ceil(total / SWITCH_SESS_PAGE))
    const p = Math.min(Math.max(0, Number(page) || 0), pages - 1)
    const rows = (all || []).slice(p * SWITCH_SESS_PAGE, p * SWITCH_SESS_PAGE + SWITCH_SESS_PAGE)
    const wsRef = { ...ws, token: record.token, index: Number.isInteger(ws.index) ? ws.index : 0 }
    record.sessAll = all || []
    record.page = p
    record.sessRows = rows
    const hadCard = Boolean(record.cardId)
    const cardId = await pushSwitchCard(bot, chatId, record, buildSessionCard(wsRef, rows, { page: p, pages, total }))
    console.log('[fs] /switch session card ' + (hadCard ? 'updated' : 'sent') + ': ws=' + wsRef.path
      + ' page=' + (p + 1) + '/' + pages + ' total=' + total + ' card=' + String(cardId || ''))
    return cardId
  }

  function registerPendingSwitchCard(record) {
    if (typeof record.cardId !== 'string') record.cardId = ''
    record.timer = setTimeout(() => pendingSwitchCards.delete(record.token), SWITCH_CARD_TTL_MS)
    pendingSwitchCards.set(record.token, record)
    return record
  }

  // ---- 卡片**原地更新**（CM 2026-10-02 实测：「这卡片就不能更新吗？我点了一下，它会弹一张新卡片出来。
  // 我切换个会话，就可能弹三四个卡片，然后按返回还继续弹新的卡片」）--------------------------
  // 卡片当然能更新 —— 本插件早就在这么干（提问卡、流式卡都是 PATCH 同一条消息）。
  // 原来我把"进入工作区 / 返回 / 结果提示"全写成"发一张新卡" ⇒ 切一次会话能弹三四张。
  // ⇒ 现在整条链路**只用一张卡**：进入 / 返回 / 结果都 PATCH 同一条消息（message_id 记在 pending 记录里）。
  // 兜底：消息太老或被删（PATCH 失败）时退回"发一张新的"，绝不让用户点了没反应。
  async function pushSwitchCard(bot, chatId, record, payload) {
    if (record && record.cardId) {
      try {
        await updateInteractive(bot, record.cardId, payload)
        return record.cardId
      } catch (error) {
        console.log('[fs] /switch card patch failed, falling back to a new card: '
          + String(error && error.message || error))
        record.cardId = ''
      }
    }
    const cardId = await sendInteractive(bot, chatId, payload)
    if (record) record.cardId = cardId
    return cardId
  }

  // 操作结果也**写回同一张卡**（不再另发一条纯文本）。
  // 🔴 CM 2026-10-02：「切换完了之后，你画蛇添足搞一个返回按钮干什么？切换了，你就直接的卡，
  //    那个卡片就是已切换就行了，就不要有一个返回按钮啊。他再切换的时候就再输入命令了」
  //    ⇒ 结果卡＝**终态卡：不带任何按钮**；要再切换就重新发 `/switch`。
  //    （旧写法是"结果卡上保留『← 回到工作区列表』"，已被上面这句话推翻 ⇒ 直接删，不留旧锚。）
  function buildSwitchResultCard(kind, message) {
    const ok = kind === 'ok'
    return {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: ok ? '✅ 已切换' : '⚠️ 没能切换' },
        template: ok ? 'green' : 'orange',
      },
      body: {
        elements: [
          { tag: 'markdown', content: message },
        ],
      },
    }
  }

  // current 由调用方传入（调用方手上已经有 cands）——**别在这里重算一遍候选**：
  // 那等于每次 /switch、每次"返回"都要把 sp.list() + 逐会话 statSync 再干一遍。
  async function sendWorkspaceCard(bot, chatId, rows, existing, current) {
    const record = existing || { token: randomUUID(), bot, chatId, timer: undefined, cardId: '' }
    if (!existing) registerPendingSwitchCard(record)
    for (const row of rows) row.token = record.token
    record.wsRows = rows
    record.sessRows = []
    const cardId = await pushSwitchCard(bot, chatId, record, buildWorkspaceCard(rows, current || {}))
    console.log('[fs] /switch workspace card ' + (existing ? 'updated' : 'sent')
      + ': workspaces=' + rows.length + ' card=' + String(cardId || ''))
    return cardId
  }

  function switchRowByIndex(rows, index) {
    const n = Number(index)
    if (!Number.isInteger(n) || n < 0 || n >= rows.length) return undefined
    return rows[n]
  }

  // 「取消」＝撤销整张卡（CM 2026-10-02 要求）。优先**删消息**；删不掉就 PATCH 成一张"已取消"小卡，
  // 至少不会留一张还能点的旧卡在那儿。
  async function cancelSwitchCard(bot, chatId, record) {
    const gone = (record && record.cardId) ? await deleteMessage(bot, record.cardId) : false
    if (record) pendingSwitchCards.delete(record.token)
    if (gone) {
      console.log('[fs] /switch card cancelled (message deleted)')
      return
    }
    try {
      if (record && record.cardId) {
        await updateInteractive(bot, record.cardId, buildSwitchResultCard('warn', '已取消。要再切就发 `/switch`。'))
        console.log('[fs] /switch card cancelled (patched to cancelled state)')
        return
      }
    } catch (error) {
      console.log('[fs] /switch cancel patch failed: ' + String(error && error.message || error))
    }
    await sendPlainText(bot, chatId, '已取消。要再切就发 `/switch`。')
  }

  // 把会话挂进 DSH 的工作区注册表（best-effort）——**"与 GUI 同源"的关键一步**：
  // 不挂的话，我们新建的会话在 GUI 侧边栏看不到（`sessionIds` 是落盘列表，只在 bootstrap 重建）。
  // 任何失败都不影响切换本身（注册表不在、路径不是目录、会话 header 还没 cwd 都会抛）。
  async function attachSessionToWorkspace(row, sessionId) {
    try {
      // 门槛第二轮 medium#3：**服务名要与 registryEntities() 用同一套**（宿主侧 workspaceRegistry、
      // 客户端侧 workspaces），否则在只暴露后者的环境里，工作区行读得到、会话却一个都挂不上，
      // 「与 GUI 同源」静默降级成空操作。另外原来用 `reg.get` 一刀切，缺 `get` 的实现连
      // resolveByPath/create 兜底链都用不上 ⇒ 改成逐个方法判可用。
      const reg = ctx.get('workspaceRegistry') || ctx.get('workspaces')
      if (!reg) return false
      const path = String((row && (row.path || row.workspace)) || '')
      let entity = (row && row.workspaceId && typeof reg.get === 'function') ? reg.get(row.workspaceId) : undefined
      if (!entity && typeof reg.resolveByPath === 'function' && path) entity = await reg.resolveByPath(path)
      // 门槛第二轮 medium#4：会话行的 title 是**某个会话**的标题，拿它去 create 工作区会把工作区
      // 命名成那个会话的名字。工作区名一律取路径末段（与 DSH 的 defaultWorkspaceTitle 同口径）。
      if (!entity && typeof reg.create === 'function' && path) entity = await reg.create(path, workspaceLeaf(path))
      if (!entity || typeof entity.attachSession !== 'function') return false
      await entity.attachSession(String(sessionId))
      console.log('[fs] workspace registry: attached session ' + sessionId + ' to '
        + String((row && (row.workspace || row.path)) || '?'))
      return true
    } catch (error) {
      console.log('[fs] workspace registry attach skipped: ' + String(error && error.message || error))
      return false
    }
  }

  // feedback(text, kind)：点卡片进来时为"把结果写回那张卡"，发文字命令时为 undefined（走纯文本回复）。
  async function applySwitch(bot, chat, chatId, row, mode, feedback) {
    const cwd = String((row && (row.workspace || row.path)) || '').trim() || ((bot.cfg && bot.cfg.workspace) || '')
    const say = async (text, kind) => {
      if (typeof feedback === 'function') { await feedback(text, kind || 'ok'); return }
      await sendPlainText(bot, chatId, text)
    }
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
      await attachSessionToWorkspace(row, sessionId)
      console.log('[fs] /switch new session ' + sessionId + ' cwd=' + cwd)
      await say('✅ 已在工作区 `' + cwd + '` **新建会话并切过去**（旧会话一个都没动，会话 id `'
        + shortSessionId(sessionId) + '`）。接着往下说就行。')
      return
    }
    const idx = chat.sessions.findIndex((s) => String(s.id) === String(row && row.sessionId))
    if (idx >= 0) {
      chat.activeIndex = idx
      persistChats(bot, bot.chats)
      await say('✅ 已切到本聊天已有的会话「' + (chat.sessions[idx].label || shortSessionId(row.sessionId)) + '」。')
      return
    }
    if (row.live) {
      await say('🟡 这个会话**正在别处运行**，不能同时接管（会把同一份历史写坏）。'
        + '等它结束再来；或者重新发 `/switch`，在该工作区用「新建」开一个新会话。', 'warn')
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
    await attachSessionToWorkspace(row, row.sessionId)
    console.log('[fs] /switch takeover session ' + row.sessionId + ' cwd=' + cwd)
    await say('✅ 已接管会话 `' + shortSessionId(row.sessionId) + '`'
      + (cwd ? '（工作目录 `' + cwd + '`）' : '') + '，接着往下说就行。')
  }

  async function handleSwitchAction(bot, chatId, value) {
    const record = pendingSwitchCards.get(String(value.fs_switch || ''))
    if (!record) {
      // 记录已过期（>15 分钟）：没有 message_id 可改，只能发一条提示（这是唯一会"另起一条"的情况）。
      await sendPlainText(bot, chatId, '这张切换卡片已过期（超过 ' + Math.round(SWITCH_CARD_TTL_MS / 60000) + ' 分钟）。'
        + '重新发一个 /switch 即可。')
      return
    }
    const chat = bot.chats.get(chatId) || { sessions: [], activeIndex: 0 }
    bot.chats.set(chatId, chat)
    const level = String(value.fs_level || '')
    const i = Number(value.fs_i)
    if (level === 'cancel') {
      await cancelSwitchCard(bot, chatId, record)
      return
    }
    // 反馈一律**写回这张卡**（不再另发消息）——见 pushSwitchCard 上方说明。
    const feedback = (text, kind) => pushSwitchCard(bot, chatId, record,
      buildSwitchResultCard(kind || 'ok', text))
    const wsRows = record.wsRows || []
    if (level === 'ws-back') {
      // 返回：重新读一次工作区（可能已有新会话/新目录），再 PATCH 回第一级
      const cands = await sessionCandidates(bot, chat)
      const fresh = await buildWorkspaceRows(bot, chat, cands)
      console.log('[fs] /switch back to workspace list (card updated in place)')
      await sendWorkspaceCard(bot, chatId, fresh, record, currentWorkspaceOf(bot, chat, cands))
      return
    }
    const ws = switchRowByIndex(wsRows, i)
    if (!ws) {
      await feedback('这张卡片里的序号已经对不上了，重新发 `/switch` 再选一次。', 'warn')
      return
    }
    ws.index = i
    if (level === 'ws') {
      const cands = await sessionCandidates(bot, chat)
      const sessRows = await buildSessionRows(bot, chat, ws, cands)
      console.log('[fs] /switch open workspace: ' + ws.path + ' sessions=' + sessRows.length
        + ' (card updated in place)')
      await showSessionPage(bot, chatId, ws, record, sessRows, 0)
      return
    }
    if (level === 'page') {
      // 翻页：同一张卡 PATCH 成下一页（CM：「每一页显示 5 个，做一个翻页」）
      console.log('[fs] /switch page: ws=' + ws.path + ' -> page ' + (Number(value.fs_page) + 1))
      await showSessionPage(bot, chatId, ws, record, record.sessAll || [], Number(value.fs_page))
      return
    }
    if (level === 'ws-new') {
      console.log('[fs] /switch click: ws=' + ws.path + ' mode=new')
      await applySwitch(bot, chat, chatId, ws, 'new', feedback)
      return
    }
    if (level === 'sess') {
      const row = switchRowByIndex(record.sessRows || [], Number(value.fs_j))
      if (!row) {
        await feedback('这张卡片里的会话序号已经对不上了，重新发 `/switch` 再选一次。', 'warn')
        return
      }
      const mode = value.fs_mode === 'new' ? 'new' : 'takeover'
      console.log('[fs] /switch click: ws=' + ws.path + ' session=' + row.sessionId + ' mode=' + mode)
      await applySwitch(bot, chat, chatId, row, mode, feedback)
      return
    }
    await feedback('这张卡片已过期，重新发 `/switch` 再选一次。', 'warn')
  }

  // ---- /model：飞书侧切换模型（CM 2026-10-02）---------------------------------
  // 飞书原本切不了模型（只有 GUI 有那个面板）。语义与 GUI **同源**，不自己发明：
  //   · 取当前：`sessionController.selectionFor(agent)`（退回 `agentDefaultModel`）；
  //   · 列可选：`ctx.llm.listProviders()` → `listModels(provider.id)`；
  //   · 切换　：`sessionController.selectForNextRequest(agent, {provider, model})`
  //             —— 它内部就是 `agent.session.append('model/selection', …)`，**按会话**生效、
  //             从下一次请求开始用；拿不到服务时退回直接 append 同一条事件。
  // 全部 try 包住：服务不在就明说"拿不到清单"，绝不炸掉整条命令通道。
  function liveAgentForChat(chat) {
    const active = chat && chat.sessions && chat.sessions[chat.activeIndex]
    if (!active) return null
    try {
      const agents = ctx.get('agents')
      const list = agents && typeof agents.list === 'function' ? agents.list() : []
      const hit = list.find((a) => a && a.id === active.id)
      if (hit) return hit
    } catch { }
    return active.handle ? active.handle.agent : null
  }

  function currentModelOf(agent) {
    try {
      const sc = ctx.get('sessionController')
      if (sc && typeof sc.selectionFor === 'function') {
        const sel = sc.selectionFor(agent)
        const cur = sel && (sel.current || sel.picked || sel.assembled)
        if (cur && cur.provider) return { provider: cur.provider, model: cur.model }
      }
    } catch { }
    try {
      const dm = ctx.get('agentDefaultModel')
      const sel = dm && typeof dm.currentSelection === 'function' ? dm.currentSelection() : undefined
      if (sel && sel.provider) return { provider: sel.provider, model: sel.model }
    } catch { }
    return null
  }

  async function listModelChoices() {
    const out = []
    try {
      const llm = ctx.get('llm')
      if (!llm || typeof llm.listProviders !== 'function') return out
      const providers = llm.listProviders() || []
      for (const p of providers) {
        const pid = p && (p.id || p.name)
        if (!pid) continue
        let models = []
        try { models = (await llm.listModels(pid)) || [] } catch { models = [] }
        for (const m of models) {
          const mid = m && (m.id || m.name)
          if (mid) out.push({ provider: pid, model: mid, label: (m && m.name) || mid })
        }
      }
    } catch (error) {
      console.log('[fs] /model 列表失败: ' + String(error && error.message || error))
    }
    return out
  }

  function modelCardPayload(choices, current) {
    const cur = current ? current.provider + '/' + current.model : '未知'
    const elements = [{
      tag: 'div',
      text: { tag: 'lark_md', content: '🧠 **切换模型**（按会话生效，从下一次请求开始用）\n当前：`' + cur + '`' },
    }]
    if (choices.length === 0) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: '拿不到模型清单（宿主没暴露 `llm` 服务）。可以直接发：`/model <provider>/<model>`' } })
      return { config: { wide_screen_mode: true }, elements }
    }
    const actions = choices.map((c) => {
      const isCur = current && current.provider === c.provider && current.model === c.model
      return {
        tag: 'button',
        text: { tag: 'plain_text', content: (isCur ? '▶ ' : '') + c.model },
        type: isCur ? 'primary' : 'default',
        value: { fs_model: c.provider + '|' + c.model },
      }
    })
    for (let i = 0; i < actions.length; i += 2) elements.push({ tag: 'action', actions: actions.slice(i, i + 2) })
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '点一下即切换；也可发文字：`/model <provider>/<model>`' } })
    return { config: { wide_screen_mode: true }, elements }
  }

  async function sendModelPicker(bot, chatId, agent) {
    const current = currentModelOf(agent)
    const choices = await listModelChoices()
    console.log('[fs] /model: choices=' + choices.length + ' current=' + JSON.stringify(current))
    await sendInteractive(bot, chatId, modelCardPayload(choices, current))
    if (choices.length === 0) {
      await sendPlainText(bot, chatId, '（模型清单为空 —— 见上一条卡的说明；仍可用 /model <provider>/<model> 直切）')
    }
    return choices
  }

  function switchModelForAgent(agent, provider, model) {
    const sc = ctx.get('sessionController')
    if (sc && typeof sc.selectForNextRequest === 'function') {
      sc.selectForNextRequest(agent, { provider, model })
      console.log('[fs] /model: selectForNextRequest ' + provider + '/' + model + ' agent=' + agent.id)
      return 'sessionController'
    }
    agent.session.append('model/selection', { provider, model })
    console.log('[fs] /model: append(model/selection) ' + provider + '/' + model + ' agent=' + agent.id)
    return 'append'
  }

  // 命令通道取 agent（2026-10-02 CM：「隔一段时间没说话，发 /goal /plan /model 都回我
  // 『先发一条普通消息』」）—— **根因**：命令分支原来只看 `entry.handle`（**内存里的活句柄**），
  // 空闲久了 / dsh 重启 / 插件热重载之后它就不在了；而**普通消息走的是 `resolveAgent()`**
  // （先复用活会话，否则 resume 持久化会话）⇒ 命令照走同一条路，就不会再要求"先发一条消息"。
  async function commandAgent(bot, chat) {
    const live = liveAgentForChat(chat)
    if (live) return live
    try {
      const resumed = await resolveAgent(bot, chat)
      if (resumed) {
        console.log('[fs] command channel: resumed session for command (agent=' + resumed.id + ')')
        return resumed
      }
    } catch (error) {
      console.log('[fs] command channel resume failed: ' + String(error && error.message || error))
    }
    return null
  }

  function handleCardAction(data) {
    console.log('[fs] card action event received: tag=' + (data && data.action && data.action.tag || '?'))
    const action = data && data.action ? data.action : {}
    const value = action.value || {}
    // 演示/候选卡片的「✕ 取消」：把**这张**消息直接删掉 —— 让 CM 真能体验"一按取消就撤销"
    // （正式卡片的取消走 fs_level='cancel' + pendingSwitchCards 里的 message_id）。
    if (value.fs_demo_cancel) {
      const chatId = data && data.context && data.context.open_chat_id
      const msgId = data && data.context && data.context.open_message_id
      const ownerBot = chatId ? findBotForChat(chatId) : undefined
      console.log('[fs] demo card cancel: chat=' + String(chatId || '') + ' msg=' + String(msgId || ''))
      if (ownerBot && msgId) {
        void deleteMessage(ownerBot, msgId).then((okDel) => {
          if (!okDel) console.log('[fs] demo card cancel failed (delete rejected)')
        })
      }
      return
    }
    // Model-switch buttons (the /model card) — CM 2026-10-02.
    if (value.fs_model !== undefined) {
      const chatId = data && data.context && data.context.open_chat_id
      const ownerBot = chatId ? findBotForChat(chatId) : undefined
      const chat = ownerBot && chatId ? ownerBot.chats.get(chatId) : undefined
      const parts = String(value.fs_model).split('|')
      const provider = parts[0]
      const model = parts[1]
      if (!chatId || !ownerBot) return
      // 2026-10-02：卡片点击也走 commandAgent（活会话 → resume），空闲久了点击同样生效。
      void (async () => {
        const agent = await commandAgent(ownerBot, chat)
        console.log('[fs] /model click: ' + String(value.fs_model) + ' chat=' + String(chatId)
          + ' agent=' + String(agent && agent.id || 'none'))
        if (!agent || !provider || !model) {
          await sendPlainText(ownerBot, chatId, '切换失败：当前没有可用会话（先发一条普通消息建立会话，再 /model）。')
          return
        }
        try {
          const how = switchModelForAgent(agent, provider, model)
          await sendPlainText(ownerBot, chatId, '✅ 模型已切换为 `' + provider + '/' + model
            + '`（按会话生效，下一次请求开始用；via ' + how + '）')
        } catch (error) {
          console.log('[fs] /model 切换失败: ' + String(error && error.stack || error))
          await sendPlainText(ownerBot, chatId, '切换失败：' + String(error && error.message || error))
        }
      })().catch((error) => {
        console.log('[fs] /model 点击处理异常: ' + String(error && error.message || error))
      })
      return
    }
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
      const opts = Array.isArray(q.options) ? q.options : []
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
      // 2026-10-01（CM 回归红线）：入站轮**和**自动轮（回执/目标轮）都必须换新卡 ——
      // 旧实现只查 activeTurns，自动轮点了按钮内容会继续写在旧卡上（用户看到"点了没动"）。
      splitLiveCardAfterAnswer(record.agentId)
      record.resolve(buildQuestionAnswer(record.questions, opt.label))
      if (record.cardId) {
        updateInteractive(record.bot, record.cardId, questionResultCardPayload(q, optionDisplayLabel(q, opt)))
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
  // 2026-10-02（CM 实测后定）：**只挂根级不够**。只要浏览器端连着，
  // dsh-api-remotes 的 forwarded waterfall（lib/index.js:215-232）会先把请求转给
  // GUI 客户端，**只有远端不接时才 next()** ⇒ 根级监听永远轮不到。
  // 实证：CM 把权限改成 workspace-write 后，越权升级那次（06:0x）日志里
  // **一条 [fs] approval/request 都没有**，提示只弹在电脑上；
  // 而历史上（未连 GUI 时）这条通道发过 99 张卡 ⇒ 通道本身是好的，是被抢答。
  // 修法：与 user-questions 同一套路 —— 把监听**同时**挂到 agent 自己的 scope
  // （agent.ctx 就是 Cordis Context，dsh-api-remotes 也用它做 scope 载体），
  // 同一条水位线上里层 scope 先于根级执行，于是飞书会话的审批先落到我们手上。
  function handleApprovalRequest(request, next, hop) {
    const agentId = request && request.agent ? request.agent.id : '?'
    console.log('[fs] approval/request[' + hop + '] received: tool=' + (request && request.toolName)
      + ' agent=' + agentId + ' callId=' + (request && request.callId || 'none')
      + ' reason=' + String((request && request.reason) || '').slice(0, 140))
    const owner = findChatForAgent(request.agent)
    if (!owner) {
      console.log('[fs] approval/request[' + hop + ']: no chat owner for agent ' + agentId + ', delegating')
      return next()
    }
    console.log('[fs] approval/request[' + hop + ']: owner found, asking via card')
    return askApprovalCard(owner.bot, owner.chatId, request)
  }

  // 每个飞书 agent 只挂一次；WeakSet 随 agent 回收失效，不泄漏、不需手工注销。
  const approvalBoundAgents = new WeakSet()
  function bindFeishuAgentApproval(agent) {
    if (!agent || typeof agent !== 'object') return
    if (approvalBoundAgents.has(agent)) return
    const scope = agent.ctx
    if (!scope || typeof scope.on !== 'function') return
    approvalBoundAgents.add(agent)
    // 2026-10-02 代码审查 high#1：**必须**留住 disposer —— agent.ctx 活得比插件代际长，
    // 不注销就是每次热重载都往同一个 agent 上再叠一条（老闭包钉住整代插件状态，
    // 且瀑布流里最早的监听先被调用 ⇒ 可能是上一代在应答）。注销点见 ctx.effect。
    // cordis 的 `Scope#on` **确实返回 disposer**（`@deepseek-ai/cordis/lib/index.js:371` 的 JSDoc：
    // "@returns a disposer removing the listener; `true` if it was still registered"）⇒ 这不是猜的 API。
    // 但**取不到时必须喊出来**（2026-10-02 审查 medium#1）：一旦上游改了返回值，
    // 监听会在每一代静默叠加，而日志里一个字都没有 —— 那样这条修复就成了"沉默的空操作"。
    const off = scope.on('approval/request', (request, next) => handleApprovalRequest(request, next, 'agent-scope'))
    if (typeof off === 'function') agentScopeDisposers.push(off)
    else console.log('[fs] approval/request: ⚠️ agent 作用域 disposer 不可用（监听可能跨代叠加）')
    console.log('[fs] approval/request: bound to agent scope for ' + agent.id)
  }

  ctx.on('approval/request', (request, next) => handleApprovalRequest(request, next, 'root'))

  // ---- 审批服务直连：绕开 GUI 桥接的抢答（2026-10-02，CM 报障后定）------------------
  // 现象：CM 把权限改成 workspace-write + ask 后，越权请求**只弹电脑、飞书收不到卡**。
  // 取证（都可复现）：
  //   · 本会话日志里策略确实是 `ask`（`approval/policy` seq=3017），**不是 never 短路**；
  //   · 升级 0.2 之后 `[fs] approval/request received` 出现 **0 次**（0.1.x 时代有 70 次）；
  //   · 根级挂过、agent scope 也挂过（`bound to agent scope for …` 有行），**都没轮到**；
  //   · CM 明确确认：那两次越权请求他都是**在电脑上**看到的。
  // 原因：dsh-api-remotes 的 forwarded waterfall（lib/index.js:215-232）在根级**更早注册**，
  //   只要浏览器端连着就把请求收进队列交给 GUI 客户端，**只有远端不接才 next()**
  //   ⇒ 插件监听永远排在它后面（0.2 新增的转发是这次倒退的来源）。
  // 破法（不改 harness 一行）：工具取审批服务是**按对象**取的 ——
  //   `dsh-tool-pwsh/lib/index.js:341`、`dsh-tool-bash`、`dsh-tool-fs` 都是
  //   `approver: ctx.get("approval")` ⇒ 把这个服务实例的 `decide` 包一层就够了。
  //   **只包 `decide`**（政策判定 + 征求答案那一步）；`request()` 原样保留 ——
  //   它负责写 `approval/asked` / `approval/decided` 审计对，绝不能绕过。
  //   重载安全：包装只装一次，`decide` 这个 relay 每次 apply 都被重新赋值，
  //   因此 HMR 后不会指向上一代插件的旧状态。
  // 红线：非飞书会话（GUI / 子代理）一律 return null 交回原逻辑，绝不吞别人的审批。
  const FS_APPROVAL_BRIDGE = globalThis.__fsApprovalBridge
    || (globalThis.__fsApprovalBridge = { decide: null, original: null, service: null })

  // 判断"这个方法是不是本桥包出来的"（2026-10-02 真机取证后补）：
  // 判据**不能落在对象身份上** —— 实测每次热重载 `ctx.get('approval')` 都给出**新的代理对象**
  // （日志里 `实例已更换，重新包装 decide()` 每代都打一次），而属性写入落到**同一个底层服务**上。
  // 若照"身份不同就重包"办，`original` 会指向上一代自己那个 wrapper，**每代再叠一层**
  // （层数＝热重载次数；非飞书审批要逐层下沉，且最老那层理论上仍可能应答 —— 正是 high#1 的同类隐患）。
  // ⇒ 三重判据：① 我们打的标记 ② 就是我们上一次装的那个函数 ③ 兜底看函数源码里的标识符
  //   （③ 只为认领**加标记之前**那几代已经装进去的旧包装层，认出来就补标记、绝不再包）。
  function isOurApprovalWrapper(fn) {
    if (typeof fn !== 'function') return false
    if (fn.__fsApprovalBridgeWrapped) return true
    if (FS_APPROVAL_BRIDGE.wrapper && fn === FS_APPROVAL_BRIDGE.wrapper) return true
    try { return /FS_APPROVAL_BRIDGE/.test(Function.prototype.toString.call(fn)) } catch { return false }
  }

  function installApprovalBridge() {
    const approval = ctx.get('approval')
    if (!approval || typeof approval.decide !== 'function') return false
    const current = approval.decide
    // ① 已经包过了（同一个底层服务，只是代理对象又换了新的）⇒ 只刷新指向，**绝不叠第二层**。
    if (isOurApprovalWrapper(current)) {
      try { current.__fsApprovalBridgeWrapped = true } catch { }
      FS_APPROVAL_BRIDGE.service = approval
      return true
    }
    // ② 真换了一个**没被包过的**实例（审批插件重载/升级）⇒ 依实例重包（low#4 原意）。
    if (FS_APPROVAL_BRIDGE.original) console.log('[fs] approval[service]: 发现未被包装的实例，重包 decide()')
    FS_APPROVAL_BRIDGE.service = approval
    FS_APPROVAL_BRIDGE.original = current.bind(approval)
    const wrapper = function (req, session) {
      const relay = FS_APPROVAL_BRIDGE.decide
      if (typeof relay === 'function') {
        let out
        try { out = relay(req, session) } catch (error) {
          console.log('[fs] approval[service] relay error, delegating: ' + String(error && error.message || error))
          out = null
        }
        if (out) return out
      }
      return FS_APPROVAL_BRIDGE.original(req, session)
    }
    wrapper.__fsApprovalBridgeWrapped = true
    FS_APPROVAL_BRIDGE.wrapper = wrapper
    approval.decide = wrapper
    console.log('[fs] approval[service]: decide() wrapped for Feishu（只包一层）')
    return true
  }

  FS_APPROVAL_BRIDGE.decide = (req, session) => {
    if (!APPROVAL_ON_FEISHU) return null
    const agent = req && req.agent
    if (!agent) return null
    try {
      const service = FS_APPROVAL_BRIDGE.service
      // 策略 = never 时交回原逻辑（它会直接返回 rejected）—— 不替 harness 改语义。
      if (service && typeof service.effectivePolicy === 'function'
        && service.effectivePolicy(session) === 'never') return null
    } catch { }
    if (req.signal && req.signal.aborted) return Promise.resolve('cancelled')
    const owner = findChatForAgent(agent)
    if (!owner) return null                            // GUI / 子代理：交回原链路
    console.log('[fs] approval[service] asking on Feishu: tool=' + req.toolName
      + ' agent=' + agent.id + ' reason=' + String(req.reason || '').slice(0, 140))
    return askApprovalCard(owner.bot, owner.chatId, req)
  }

  installApprovalBridge()

  // ---- 审批前置拦截：把"审计类 ask"搬到飞书（2026-09-16 CM 拍板）--------------------
  // 为什么要自己拦：审计插件返回 {kind:"ask"} 后，主程序走它自己的 `ctx.approval`
  // （PC 一次性提示），**绕开**我们已有的 `approval/request` 卡片链路 —— 实机日志已验证：
  // 5 次 `sentinel: ask`（01:49 / 05:50 / 05:55 / 05:56×2）**没有一次**走到 approval/request，
  // 所以飞书上根本收不到卡，CM 只能在电脑上点。
  // 修法：在**更前面的** `tools/pre-execute` 自己拦 —— 发飞书卡、等点击、再决定放行/拦截。
  // 这样 `ctx.approval` 根本不会被触发，审批只出现在飞书。
  // 开关（2026-10-02 **CM 改口径**）：原话「手机上得要能审批才行，**不可以关了**」
  // ⇒ **默认开启**。显式关闭：设 DSH_FEISHU_APPROVAL=0（或 false/off/no）。
  // 旧口径（2026-09-16「他给的是 danger-full-access，审批不该由插件再加一道，
  // 默认关闭」）已按 A20-⑤ 作废：现在默认值为 on，且不再依赖环境变量。
  const APPROVAL_ON_FEISHU = !/^(0|false|off|no)$/i.test(String(process.env.DSH_FEISHU_APPROVAL ?? '1').trim())
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
  // 读取该 agent **本会话当前**的沙箱档位（dsh-sandbox-policy 的服务 API）。
  // 用途：判断"用户是不是已经授了全权" —— 是的话插件就不该再加一道审批。
  function currentSandboxMode(agent) {
    try {
      const sp = ctx.get('sandboxPolicy')
      if (!sp || typeof sp.resolve !== 'function') return undefined
      const session = agent && agent.session
      const policy = sp.resolve(session === undefined ? {} : { session })
      return policy && policy.mode
    } catch { return undefined }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const pass = () => (typeof next === 'function' ? next() : undefined)
    // 2026-10-02：审批服务可能在本插件 apply 之后才就绪 ⇒ 每次执行工具前补装一次（幂等）。
    installApprovalBridge()
    // 2026-10-02：**最关键的一处挂载点**。越权升级的审批请求是在**工具执行过程中**
    // 由工具自己发起的（dsh-sandbox 的 approveEscalation → ctx.approval.request），
    // 所以只要在 pre-execute 时把审批水位线挂到该 agent 的 scope 上，
    // 那一次 escalation 就一定落在我们手上（WeakSet 幂等，不会重复挂）。
    bindFeishuAgentApproval(exec && exec.agent)
    if (!APPROVAL_ON_FEISHU) return pass()
    // 🔴 2026-10-02 CM 质问「为什么推送到仓库要我审批呢？我已经给了全部权限给你了呀」：
    // 这道闸（外发命令 / 工作区外写入）过去**不看会话档位**，于是在 `danger-full-access`
    // （用户已授全权）下也照弹。实证：那次 `git push` 里
    // `$env:GIT_SSH_COMMAND = 'ssh …'` 命中 `\bssh\b` ⇒ 连发两张卡
    // （token `4438db21` / `92b5e4b3`），而 CM 根本没授权过任何限制。
    // ⇒ **用户已授全权时，插件不再加一道**（恢复 2026-09-16「他给的是完全访问，
    //   审批不该由插件再加一道」的本意）。
    // ⚠️ 真正的"越权升级"审批**不受影响**：那种请求只在会话来**受限**时才产生，
    //    走的是上面的审批服务 `decide()` 直连（`sandbox_permissions` ⇒ 请求升级 ⇒ 弹卡）。
    if (currentSandboxMode(exec && exec.agent) === 'danger-full-access') return pass()
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

  // ---- 计划审查（plan review）----------------------------------------------------
  // 2026-10-01 CM 报障：「计划模式退出的时候，我收不到你的退出申请」。
  // 根因：`exit_plan_mode` 调的是 `ctx.userQuestions.ask(...)` **服务**
  // （`dsh-plan-mode/lib/index.js:261`），**不经过** `ask_user_question` 工具 ⇒
  // 本插件原先只拦 `tools/execute` 那条（见本文件末尾），拦不到它 ⇒ 申请只发给了
  // 连着长连接的 GUI 客户端，飞书这边什么都收不到。
  // 修法：补一条与 `approval/request` **同构**的水位线 `user-questions/request`
  // （见下面的监听）；`userQuestions` 服务正是从这条水位线取答案
  // （`dsh-user-questions/lib/index.js:69`）。
  function isPlanReview(q) {
    return Boolean(q && q.intent && q.intent.kind === 'plan-review')
  }
  /** harness 判"批准"判的是**选项 label 本身**（plan-mode 里硬约定为 `Approve`）。 */
  function planApproveLabel(q) {
    const label = q && q.intent ? q.intent.approve : undefined
    return typeof label === 'string' && label !== '' ? label : undefined
  }
  /** 卡面文案可以中文化，但回传 harness 的 `selected` 必须仍是**原 label**。 */
  function optionDisplayLabel(q, option) {
    const label = String(option && option.label || '')
    if (!isPlanReview(q)) return label
    if (label === planApproveLabel(q)) return '批准并执行（退出计划模式）'
    if (/keep planning/i.test(label)) return '继续修改（留在计划模式，回我文字即可）'
    return label
  }
  function questionHint(q) {
    return isPlanReview(q)
      ? '点「批准」＝ 我退出计划模式、按这份计划开工；点「拒绝」或直接回我文字 ＝ 我按你的意见改（留在计划模式）。'
      : '点右侧「选它」按钮，或直接回复文字。'
  }
  // 批准标签是英文 `Approve`（harness 硬约定），而 CM 习惯回中文 ⇒ **整条消息精确命中**
  // 下面这几个词时按批准处理；带任何补充说明（例："同意，但第 2 步改一下"）都不算，
  // 仍按"继续修改"的反馈回给模型。方向是刻意选的：误判成"留在计划模式"可恢复，
  // 误判成"已批准"不可恢复（会立刻开工）。
  const PLAN_APPROVE_ALIASES = ['approve', '批准', '同意', '确认']

  function buildQuestionAnswer(questions, text) {
    return {
      answers: questions.map((q) => {
        const opts = q.options || []
        const trimmed = String(text || '').trim()
        if (opts.length === 0) return { id: q.id, selected: [], custom: text }
        const approve = isPlanReview(q) ? planApproveLabel(q) : undefined
        if (approve !== undefined
          && PLAN_APPROVE_ALIASES.includes(trimmed.replace(/[。．.!！,，\s]+$/, '').toLowerCase())) {
          return { id: q.id, selected: [approve] }
        }
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

  // Question card (option rows). 2026-10-01（改造④，CM 定稿 A4）：
  // 飞书**按钮文字只能是 plain_text、单行、≤100 字符**（官方 JSON 2.0 文档），
  // 把选项做成按钮必然被截断成 `…`（CM 实测"按钮上面全部都是显示三个点"）。
  // 改法：选项**正文**交给 markdown（自动换行、无长度限制），按钮只负责"选这一项"；
  // 每选项一行分栏，`flex_mode:'stretch'` ⇒ 宽屏并排、**窄屏自动上下堆叠**（按钮占整行，不可能被挤）。
  // 同时**去掉旧的 5 个按钮上限**：布局不再依赖 action 行的容量，选项再多也不会被静默丢弃。
  const QUESTION_TEXT_WEIGHT = 4
  const QUESTION_BUTTON_WEIGHT = 1

  function questionOptionRow(option, token, index, displayLabel) {
    const shown = displayLabel !== undefined
      ? String(displayLabel)
      : String(option && option.label || '（无标签）')
    return {
      tag: 'column_set',
      flex_mode: 'stretch',
      background_style: 'default',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: QUESTION_TEXT_WEIGHT,
          vertical_align: 'center',
          elements: [{ tag: 'markdown', content: '**' + (index + 1) + '.** ' + shown }],
        },
        {
          tag: 'column',
          width: 'weighted',
          weight: QUESTION_BUTTON_WEIGHT,
          vertical_align: 'center',
          elements: [{
            tag: 'button',
            type: 'primary',
            width: 'fill',
            text: { tag: 'plain_text', content: '选它' },
            behaviors: [{ type: 'callback', value: { fs_question: token, fs_option: index } }],
          }],
        },
      ],
    }
  }

  // 计划审批卡专用的「两个按钮」布局（2026-10-02 CM：「审批文字+按钮+拒绝文字+按钮 ⇒
  // 文字放到按钮上，审批绿、拒绝红」）。为什么是这个形状：
  //   · 飞书 2.0 按钮**没有绿色**（官方枚举 default / primary / danger / text / primary_text /
  //     danger_text / primary_filled / danger_filled / laser）⇒「绿」只能落在**绿底块**上：
  //     column.background_style='green-50'（区块背景语义，本仓 steer 提示已在用同一套色板）；
  //   · 两个按钮**同一排**（flex_mode:'bisect' 两等分）—— CM 2026-10-02 定的口径；
  //   · 文案固定 2 字（窄列按钮超过 2 字会被截成省略号，见 smoke 用例 48）；
  //   · 回调**协议不动**：仍是 { fs_question, fs_option }，回传 harness 的仍是原 label
  //     （Approve / Keep planning，由 buildQuestionAnswer 负责中文别名映射）。
  // 找不到 approve 标签、或凑不出第二项时返回 null ⇒ 调用方回退旧布局（绝不把审批卡搞成没按钮）。
  // 审批按钮文案（2026-10-02 真机定稿：绿块 + 白字，居中）。
  // ⚠️ 加粗必须在 `<font>` 外面 —— 写成 `<font color='white'>**批准</font>**` 会在真机上
  // 把标签原文当普通文字漏出来（CM 看到的"一串英文"）。
  const PLAN_APPROVE_TEXT = "**<font color='white'>批准</font>**"

  function planReviewButtonsRow(q, token) {
    const opts = Array.isArray(q.options) ? q.options : []
    if (opts.length < 2) return null
    const approveLabel = String(planApproveLabel(q) || '')
    const approveIndex = opts.findIndex((o) => String((o && o.label) || '') === approveLabel)
    if (approveIndex < 0) return null
    const rejectIndex = opts.findIndex((_, i) => i !== approveIndex)
    if (rejectIndex < 0) return null
    // 「批准」= **整个色块可点击**（interactive_container）+ 深绿底 —— 两处实测教训（CM 真机）：
    //   ① `column.background_style` 官方注明"**需客户端 v7.9+**"，CM 手机上根本没渲染；
    //   ② 就算渲染了也被 `width:'fill'` 的按钮整列铺满盖住 ⇒ 一样看不到绿。
    //   ⇒ 绿只能靠"整块可点击的容器"来做（容器内部没有按钮，绿底不会被盖）。
    // 文字两个坑（第一版真机都踩了，CM 逐条指出）：
    //   · 必须 `text_align:'center'`，否则左对齐；
    //   · 加粗必须写在 `<font>` **外面**：`<font color='white'>**批准</font>**` 这种跨标签嵌套
    //     不合法，飞书会把标签原文当普通文字显示出来（CM 看到的"一串英文"）。
    const approveBlock = {
      tag: 'interactive_container',
      width: 'fill',
      background_style: 'green-600',
      corner_radius: '6px',
      padding: '8px 12px 8px 12px',
      horizontal_align: 'center',
      vertical_align: 'center',
      behaviors: [{ type: 'callback', value: { fs_question: token, fs_option: approveIndex } }],
      elements: [{ tag: 'markdown', content: PLAN_APPROVE_TEXT, text_align: 'center' }],
    }
    const rejectBtn = {
      tag: 'button', type: 'danger_filled', width: 'fill',
      text: { tag: 'plain_text', content: '拒绝' },
      behaviors: [{ type: 'callback', value: { fs_question: token, fs_option: rejectIndex } }],
    }
    return {
      tag: 'column_set',
      flex_mode: 'bisect',
      columns: [
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [approveBlock] },
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [rejectBtn] },   // 「拒绝红」＝ 红底白字
      ],
    }
  }

  function questionCardPayload(q, token) {
    const opts = Array.isArray(q.options) ? q.options : []
    const plan = isPlanReview(q)
    const planButtons = plan ? planReviewButtonsRow(q, token) : null
    return {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: plan ? '📋 计划已写好，等你批准' : '❓ 需要你的回答',
        },
        template: plan ? 'orange' : 'blue',
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: '**' + (plan ? '批准后我退出计划模式、按这份计划开工' : q.question) + '**'
              + (q.detail ? '\n\n' + q.detail : '')
              + '\n\n' + questionHint(q),
          },
          ...(planButtons
            ? [planButtons]
            : opts.map((option, index) => questionOptionRow(option, token, index, optionDisplayLabel(q, option)))),
        ],
      },
    }
  }

  function questionResultCardPayload(q, label) {
    return {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: isPlanReview(q) ? '📋 计划已写好，等你批准' : '❓ 需要你的回答',
        },
        template: 'green',
      },
      body: {
        elements: [
          { tag: 'markdown', content: '**' + (isPlanReview(q) ? '计划审查' : q.question) + '**\n\n✅ 已收到：' + label },
        ],
      },
    }
  }

  // 文字回答后把问题卡**就地改成「✅ 已收到」态**（2026-10-02 CM 实测：原先只有**按钮**路径
  // 会更新卡片，文字回答后卡片原封不动 ⇒ 按钮仍可点、点了报
  // 「question button: record not found for chat …」，用户以为没生效）。
  // 复用按钮路径同一套 payload 与 recentQuestions 登记。
  function finalizeQuestionCard(record, text) {
    try {
      const answered = buildQuestionAnswer(record.questions, text)
      const first = (answered.answers && answered.answers[0]) || {}
      const opt = ((record.q && record.q.options) || []).find((o) => first.selected[0] === o.label)
      const label = opt ? optionDisplayLabel(record.q, opt) : (first.custom || '（已收到）')
      if (record.cardId) {
        void updateInteractive(record.bot, record.cardId,
          questionResultCardPayload(record.q, label)).catch(() => {})
      }
      // 登记"最后回答过的 token"：再点这张旧卡时给友好提示，而不是静默失败。
      recentQuestions.set(record.chatId, { token: record.token, answeredAt: Date.now() })
    } catch (error) {
      console.log('[fs] finalize question card failed: ' + String(error && error.message || error))
    }
  }

  function askUserQuestion(bot, chatId, questions, signal, agentId) {
    return new Promise((resolve, reject) => {
      const q = questions[0]
      const opts = Array.isArray(q.options) ? q.options : []
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
            // 2026-10-01 真机抓出：问题卡**没进消息索引** ⇒ CM 引用它时只能看到「内容未登记」。
            // 这里补登记（与纯文本/流式卡同一套 rememberMessage）。
            try { rememberMessage(msgId, 'bot 的问题卡：' + String(q.question || '').replace(/\s+/g, ' ').slice(0, 60)) } catch {}
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
  // ---- 计划审查：在【工具层】拦 exit_plan_mode（2026-10-02 换的通道）-------------------
  // 背景：把 user-questions/request 监听下沉到 agent.ctx **仍然拿不到** ——
  // 真机实测（2026-10-02 00:4x）日志里只有注册行
  // 「user-questions/request: bound to agent scope for fs-main-muppqw21」，
  // **没有任何** [agent-scope] / [root] 的接管行；harness 侧收到的是
  // 「The user dismissed the plan review to speak instead」⇒ 请求被 GUI 侧整条吃掉
  // （dsh-api-remotes 的 forwarded waterfall 先答，只有远端不接才 next()）。
  // exit_plan_mode 是 **工具**（dsh-plan-mode/lib/index.js:231 的 ctx.tools.register），
  // 与 ask_user_question 同一个 dispatch；而本插件在 tools/execute 上拦 ask_user_question
  // 是**线上验证过可用**的 ⇒ 换到这条通道，飞书侧 100% 拿得到。
  // 红线：非飞书会话（GUI／子代理）一律 next()，绝不吞别人的提问。
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'exit_plan_mode') return next()
    const owner = findChatForAgent(exec.agent)
    if (!owner) return next()
    const plan = String((exec.arguments && exec.arguments.plan) || '')
    if (!plan.trim()) return next()
    console.log('[fs] exit_plan_mode intercepted for ' + exec.agent.id + ' plan_len=' + plan.length)
    const answer = await askUserQuestion(owner.bot, owner.chatId, [{
      id: 'plan-review',
      header: 'Plan review',
      question: 'Approve this plan and leave plan mode?',
      detail: plan,
      options: [
        { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
        { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
      ],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }], exec.signal, exec.agent.id)
    const item = (Array.isArray(answer.answers) ? answer.answers : []).find((e) => e.id === 'plan-review')
    const approved = Boolean(item) && Array.isArray(item.selected) && item.selected.length === 1
      && item.selected[0] === 'Approve' && item.custom === undefined
    if (approved) {
      // 退出计划模式：**必须让 harness 自己记一笔**（它会 append plan/mode 事件）。
      // 2026-10-02 真机抓出：ctx.inject(['planMode']) 在本环境**从不触发**
      //（profile bundle 跨 scope ⇒ planModeRef 恒为 null），日志实证
      //   plan approved on Feishu … exit=unavailable(planMode 服务未注入)
      // ⇒ 那样只是"我口头告诉模型已退出"，会话里并没有真的退出
      //   （下一轮系统提示仍会写 You are in plan mode，等于把模型骗了）。
      // 改走**命令注册表**的 /plan off —— 与 /plan 命令同一条**已验证可用**的通道
      // （handleCommand 的 plan 分支就是这么调的），由 dsh-plan-mode 自己执行 set(agent,false)。
      let exitNote = ''
      try {
        const commands = ctx.get('commands')
        if (commands && typeof commands.execute === 'function') {
          const r = await commands.execute(exec.agent, '/plan off', [], new AbortController().signal)
          const txt = r && r.result && r.result.text ? r.result.text : 'ok'
          exitNote = 'exit via /plan off: ' + txt
        } else if (planModeRef && typeof planModeRef.set === 'function') {
          exitNote = 'exit=' + String(planModeRef.set(exec.agent, false))
        } else {
          exitNote = 'exit=unavailable(既无 commands 也无 planMode)'
        }
      } catch (error) {
        exitNote = 'exit failed: ' + String(error && error.message || error)
      }
      console.log('[fs] plan approved on Feishu: agent=' + exec.agent.id + ' ' + exitNote)
      return {
        isError: false,
        value: { approved: true },
        content: [{
          type: 'text',
          text: 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
            + (exitNote.indexOf('failed') >= 0 || exitNote.indexOf('unavailable') >= 0
              ? ' (note: ' + exitNote + ')'
              : ''),
        }],
      }
    }
    const feedback = (item && typeof item.custom === 'string') ? item.custom : ''
    console.log('[fs] plan kept in planning on Feishu: agent=' + exec.agent.id
      + ' feedback_len=' + feedback.length)
    // ⚠️ 这里**必须抛错**，不能返回 { isError: true }：
    // dsh-tools 的 materializeFinalResult() 在 isError===true 时会**无条件**写入
    //   error: result.error
    // 而我们不提供 error ⇒ 其值为 undefined ⇒ dsh-util-values 的 walkJsonValue() 对
    //   typeof current !== 'object'（undefined 命中）
    // 直接判"不可序列化" ⇒ harness 抛
    //   tool result must be losslessly JSON-serializable
    //（2026-10-02 真机实测：我收到的就是这个报错，**不是**用户的反馈。）
    // dsh-plan-mode 自己的 execute 走「继续修改」时也是抛错 ⇒ 与它完全同路，
    // 由 harness 统一转成合法的错误工具结果。
    // 文案与 dsh-plan-mode 原文逐字一致，模型行为不变。
    throw new Error(feedback === ''
      ? 'The user chose to keep planning; revise the plan and present it again.'
      : 'The user chose to keep planning; their feedback: ' + feedback)
  })

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

  // ---- 计划审查 / 其它 UI 提问：接管 `user-questions/request` 水位线 ----------------
  // 与上面那条 `tools/execute` 拦截的分工：
  //   · `ask_user_question` **工具** → 工具层拦（上面那条，走 exec.arguments）
  //   · `exit_plan_mode` 等直接调 `ctx.userQuestions.ask()` 的调用方 → 服务层拦（这条）
  // `userQuestions.ask` 的派发方式是 `ctx.waterfall(scopeTarget(agent, agent),
  // 'user-questions/request', …)`（dsh-user-questions/lib/index.js:69），与本插件已线上
  // 验证可用的 `approval/request` 完全同构（dsh-user-approval/lib/index.js:179）⇒
  // 根级 `ctx.on` 能收到。只接管飞书自己的会话：`findChatForAgent` 找不到 owner
  // （GUI 会话、子代理等）一律 `next()` 交回 harness，绝不吞掉别人的提问。
  // 2026-10-01 真机复现（CM 报障「计划在电脑端有、飞书收不到」）：**只挂根级 ctx 不够**。
  // user-questions/request 同时被 GUI 桥接（dsh-api-remotes 的 forwarded waterfall：
  // 事件白名单 lib/index.js:17-25，转发实现 forwardWaterfall lib/index.js:187-204）——
  // 桥接把请求转给浏览器客户端，**只有远端不接时才 next()** ⇒ 只要 GUI 连着，根级监听
  // 永远轮不到（实测：本实例日志里 [fs] user-questions/request 出现 **0 次**）。
  // 修法：把监听**同时**挂到 agent 自己的 scope（agent.ctx.on；Agent 接口里
  // readonly ctx: Context 就是 Cordis Context，dsh-api-remotes 也用它做 scope 载体）
  // —— 同一条水位线上里层 scope 先于根级执行，于是飞书会话的提问先落到我们手上；
  // 非飞书 agent 依旧 next() 交回，绝不吞别人的提问（红线，smoke 42 守着）。
  function handleUserQuestionRequest(request, next, hop) {
    const agent = request && request.agent
    const questions = Array.isArray(request && request.questions) ? request.questions : []
    const kind = questions[0] && questions[0].intent && questions[0].intent.kind
    console.log('[fs] user-questions/request[' + hop + ']: agent=' + (agent && agent.id || '?')
      + ' n=' + questions.length + ' kind=' + (kind || 'plain')
      + ' plan_len=' + String((questions[0] && questions[0].detail) || '').length)
    if (!agent || questions.length === 0) return next()
    const owner = findChatForAgent(agent)
    if (!owner) {
      console.log('[fs] user-questions/request[' + hop + ']: no chat owner for agent ' + agent.id + ', delegating')
      return next()
    }
    console.log('[fs] user-questions/request[' + hop + ']: owner found, asking via card'
      + (kind === 'plan-review' ? ' (plan review)' : ''))
    return askUserQuestion(owner.bot, owner.chatId, questions, request.signal, agent.id)
  }

  // 每个飞书 agent 只挂一次；WeakSet 随 agent 回收失效，不泄漏、不需手工注销。
  const questionBoundAgents = new WeakSet()
  function bindFeishuAgentQuestions(agent) {
    if (!agent || typeof agent !== 'object') return
    if (questionBoundAgents.has(agent)) return
    const scope = agent.ctx
    if (!scope || typeof scope.on !== 'function') return
    questionBoundAgents.add(agent)
    // 2026-10-02 代码审查 high#1：同 approval —— agent.ctx 长生命周期，disposer 必须留住。
    const off = scope.on('user-questions/request', (request, next) => handleUserQuestionRequest(request, next, 'agent-scope'))
    if (typeof off === 'function') agentScopeDisposers.push(off)
    else console.log('[fs] user-questions/request: ⚠️ agent 作用域 disposer 不可用（监听可能跨代叠加）')
    console.log('[fs] user-questions/request: bound to agent scope for ' + agent.id)
  }

  ctx.on('user-questions/request', (request, next) => handleUserQuestionRequest(request, next, 'root'))

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
    // 改造①：子代理回执轮询（1s）——必须在**回合状态之外**独立跑，
    // 否则又回到"只在回合启动那一拍判定"的老毛病。
    const stopNoticeTimer = ctx.interval(() => {
      void pollSubagentNotices().catch(() => {})
    }, NOTICE_POLL_MS)
    return () => {
      stopping = true
      stopNoticeTimer()
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
        // 2026-10-02 T11 真机失败（该跳过却发出去了）⇒ 把判定入参打出来，只加日志不改行为。
        // 判定是三个条件的与：entry 存在、entry.chatId===targetChat、entry.card.status!=='sealed'，
        // 打全了才能定位是哪一个没中。
        const detail = [...activeTurns.values()].map((e) => String(e.chatId) + '/' + String(e.card && e.card.status)).join(' | ')
        console.log('[fs] feishu_send NOT skipped: target=' + targetChat + ' activeTurns=' + activeTurns.size + ' [' + detail + ']')
      } else {
        // 2026-10-02 结构性漏洞（T11 第 1 次失败的最强嫌疑；**机制本身已从代码确证**）：
        // `bot.lastChatId` 只在**入站消息**时写入，而每次 HMR 重载都会重建 bots
        //（日志可见每次 apply 后紧跟 bridge active + helper spawned ×3）⇒ lastChatId 归零。
        // 于是「重载之后、下一条入站消息之前」这个窗口里 targetChat 为空 ⇒
        // 原来整个 if (targetChat) 块被绕过 ⇒ **跳过逻辑完全失效、直接发出去**。
        // 修法：targetChat 为空时回退到"当前有活跃卡的会话" —— 此时也无处可指定收件人，
        // 而"这个对话正在被回答"本身就是不该另发一条的充分理由。
        // 模型显式传了 chatId 的情况不受影响（那时 targetChat = chatId，走上面那条）。
        const live = [...activeTurns.values()].filter((e) => e && e.card && e.card.status !== 'sealed')
        if (live.length > 0) {
          console.log('[fs] feishu_send skipped (active card; lastChatId 为空): ' + String(live[0].chatId))
          return {
            ok: true,
            status: 200,
            detail: '（已跳过）当前对话的回复会自动显示为飞书卡片，无需调用 feishu_send；'
              + '请直接把要说的内容作为最终回答输出。若确实要发到别的会话，请显式传 chatId。',
          }
        }
        console.log('[fs] feishu_send NOT skipped: no targetChat 且无活跃卡')
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
  // 2026-09-21 新增：**后台回执轮**（子代理／后台 job 完成通知把模型唤醒继续干活）也要上卡。
  // 这一类轮次没有飞书入站消息 ⇒ 旧实现没有任何卡承接 ⇒ CM 在飞书里看不到"我在继续干活"，
  // 也收不到这一轮的结论（他只能再发一条消息把我戳醒）。env / per-bot 都可关。
  const NOTICE_CARDS_ON = String(process.env.DSH_FEISHU_NOTICE_CARDS ?? '1').trim() !== '0'
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

  // 本轮由什么驱动？看会话事件里**最后一条** user/message 的来源标记。
  //   · source.kind === 'goal' → 目标轮（dsh-goal-round-driver 注入）
  //   · source.kind === 'plugin' 且正文是**后台回执**（子代理／后台 job 完成通知）
  //     → "自动回合"：模型被唤醒继续干活，但**没有飞书入站消息** ⇒ 旧实现没有卡承接，
  //       CM 在飞书里**什么都看不到**（2026-09-21 反馈：「拍了子代理以后…你也不会自动唤醒…
  //       我要子代理回来，就会发信息激活你，你就继续工作并发信息我」）。
  //       ⚠️ 注意 source.kind==='plugin' 也包含会话启动时的 system-reminder／技能目录等，
  //       那些**不能**建卡（会刷屏），所以这里必须按正文形态白名单匹配，不许按 kind 一刀切。
  const NOTICE_RE = /^\s*(background\s+job\b|background\s+subagent\b|后台任务\b|子代理\b)/i
  function autoTurnInfo(agent) {
    try {
      const events = sessionEvents(agent.session)
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (!e || e.type !== 'user/message') continue
        const src = (e.data && e.data.source) || {}
        if (src.kind === 'goal') {
          const round = Number(src.round) || 0
          return { kind: 'goal', round, title: '🎯 目标模式 · 第 ' + (round || 1) + ' 轮开始，正在工作…' }
        }
        // ⚠️ user/message 的正文在 `data.content`（不是 `data.message.content`）——
        // 两种形态都读一遍（2026-09-21 写用例 22 时踩到：只读 data.message ⇒ 通知正文读成空串、
        // 于是回执轮永远不建卡）。
        const content = (e.data && e.data.content) || (e.data && e.data.message && e.data.message.content) || []
        const text = extractProcessText({ content }) || ''
        if (NOTICE_RE.test(text)) {
          const isSub = /subagent|子代理/i.test(text)
          const label = isSub ? '子代理回执到了' : '后台任务回执到了'
          return { kind: 'notice', round: 0, title: '🔔 ' + label + ' · 正在继续工作…', label }
        }
        return { kind: null, round: 0 }
      }
    } catch (error) {
      console.log('[fs] auto turn probe failed: ' + String(error && error.message || error))
    }
    return { kind: null, round: 0 }
  }

  function openGoalCard(agent, bot, chatId, info, existing) {
    // state.rotate：把"表格额度换卡"那条通道交出去（见 makeAutoCardEntry.split —— 评审 low#7）
    const state = { card: null, stop: null, rotate: null }
    // 表格额度换卡：与普通回合的 rotateTables 同机制（旧卡留表格，后续写新卡，游标接续不丢不重）
    const rotate = () => {
      if (!state.stop || !state.card || state.card.status !== 'running') return
      const carry = Number.isFinite(state.card.cursor) ? state.card.cursor : 0
      state.stop()
      state.card.status = 'sealed'
      void syncCard(bot, chatId, state.card, true).catch(() => {})
      const fresh = makeCardState(agent)
      fresh.cursor = carry
      fresh.blocks.push({ type: 'message', text: '📊 上一张卡的表格已满（飞书单卡最多 5 张），后续内容在这张新卡继续。' })
      state.card = fresh
      void syncCard(bot, chatId, fresh, true).catch(() => {})
      state.stop = startCardWatcher(agent, fresh, bot, chatId, rotate)
      const live = autoCards.get(agent.id)
      if (live) live.card = fresh
    }
    state.rotate = rotate
    const card = existing || makeCardState(agent)
    if (existing) {
      // 2026-09-27（CM 实证"一个内容发两次"）：复用同一轮刚封口的那张回合卡 ——
      // 不另开新卡，同一批会话事件就只会出现在一张卡上。游标沿用原卡（继续往下镜像）。
      card.status = 'running'
      card.retryUntil = 0
    } else {
      card.cursor = sessionEvents(agent.session).length    // 只镜像本轮**后续**事件（goal 提示词本身不搬上卡）
    }
    card.blocks.push({ type: 'message', text: info.title || ('🎯 目标模式 · 第 ' + (info.round || 1) + ' 轮开始，正在工作…') })
    state.card = card
    void syncCard(bot, chatId, card, true).catch(() => {})
    state.stop = startCardWatcher(agent, card, bot, chatId, rotate)
    if (existing) {
      console.log('[fs] auto card reused chat=' + chatId + ' msg=' + (card.token || '-')
        + ' kind=' + ((info && info.kind) || 'goal'))
    }
    return state
  }

  // ---- 子代理回执「到点即播报」（改造①，CM 2026-10-01 定稿）--------------------
  // 旧实现只在 `agent/status === 'running'` 那一拍回扫"最后一条 user/message"，
  // 而回执要等 `turn/start` **之后**才写进会话 ⇒ 判成普通回合 ⇒ 不开卡（CM 实测"没弹"）。
  // 反向样本（DSH-BA）：回执已落盘却被**下一轮**误认 ⇒ 偶尔"撞对"发卡，但归因/时机不可靠。
  // 现在改为**直接盯事件本身**：1s 轮询各飞书会话的事件尾部，命中
  // `user/message` + `source.kind === 'subagent-settled'` 就立刻播报 —— 与父回合状态无关。
  // 双层播报：① 纯文本（载荷最简、失败面最小，必达）→ ② 详情卡（复用同一套流式卡）。
  const noticeCursor = new Map()      // agentId -> 已扫过的事件下标
  // 2026-10-02 代码审查 low#5：这张表按"每个子代理回执一条"增长、**从不清理**，
  // 而桥是奔着连跑几天的 ⇒ 慢速无界内存增长。改成 FIFO 上限（只留最近若干条去重键）。
  const noticeSeen = new Set()        // childId#seq 去重（进程内；重启后新的回执才有新 seq）
  const NOTICE_SEEN_MAX = 500
  function rememberNoticeSeen(key) {
    noticeSeen.add(key)
    while (noticeSeen.size > NOTICE_SEEN_MAX) {
      const oldest = noticeSeen.values().next().value
      noticeSeen.delete(oldest)
    }
  }

  // 枚举"绑定了飞书会话的 live agent"（与 findChatForAgent 用同一套注册表结构）
  // ⚠️ 这个函数跑在 1s 定时器里：任何异常都必须在这里吃掉，
  // 否则会冒泡成定时器回调的未捕获异常（Node 默认直接结束进程）。
  function feishuChatAgents() {
    const out = []
    try {
      // 2026-10-02 代码审查 medium#2：**句柄是不持久化的**（handle 只在内存里有），
      // 热重载 / 重启后 `s.handle` 还没被下一条入站消息重建，旧实现就整段跳过
      // ⇒ `pollSubagentNotices` 与 `refreshLiveCards` 对着空集合空转，回执播报和目标条
      // 刷新静默失效（正是这次要修的那一类缺陷）。改为**先按 session id 找活 agent**
      //（`ctx.get('agents').list()`，与 resolveAgent 的活会话复用同一条判据），
      // 找不到才退回句柄。
      const live = liveAgentsById()
      for (const bot of bots.values()) {
        if (!bot || !bot.chats || typeof bot.chats[Symbol.iterator] !== 'function') continue
        for (const [chatId, chat] of bot.chats) {
          for (const s of (chat && chat.sessions) || []) {
            if (!s || !s.id) continue
            const agent = live.get(String(s.id)) || (s.handle && s.handle.agent)
            if (agent && agent.id) out.push({ agent, bot, chatId })
          }
        }
      }
    } catch (error) {
      console.log('[fs] enumerate chat agents failed: ' + String(error && error.message || error))
    }
    return out
  }

  // 回执正文第 1 段是 "Background subagent <id> finished…"，之后是
  // "Its closing message:" + 子代理收尾正文 → 取正文做一行摘要。
  function noticeBodyOf(event) {
    try {
      const content = (event.data && event.data.content) || []
      const parts = Array.isArray(content)
        ? content.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')) : []
      const idx = parts.findIndex((t) => /closing message/i.test(t))
      const body = idx >= 0 ? parts.slice(idx + 1).join('\n') : parts.slice(1).join('\n')
      return body.replace(/\s+/g, ' ').trim()
    } catch (error) {
      return ''
    }
  }

  // 把回执**并进**一张已经在跑的卡（不新增消息）。
  // CM 2026-10-01：「它弹出来以后就一直沉在活跃卡片的下面，这样不好看」——
  // 独立消息永远排在**创建时刻**的位置，而上面那张卡还在原地 PATCH ⇒ 通知会被"钉"在下面像块贴纸。
  // 所以只要有活跃卡，就并进去；只有会话真的空闲时才发独立通知。
  function mergeNoticeIntoCard(card, bot, chatId, line, tag, agentId) {
    if (!card || card.circuitOpen || card.createFailed || !card.token) return false
    try {
      appendNote(card, line, undefined)
      void syncCard(bot, chatId, card, true).catch(() => {})
      console.log('[fs] notice merged into ' + tag + ' card: agent=' + agentId + ' chat=' + chatId)
      return true
    } catch (error) {
      console.log('[fs] notice merge failed (' + tag + '): ' + String(error && error.message || error))
      return false
    }
  }

  async function announceSubagentNotice(agent, bot, chatId, event, src) {
    const childId = String(src.senderSessionId || '')
    const short = childId ? childId.slice(0, 8) : '未知'
    const summary = noticeBodyOf(event)
    const line = '🔔 子代理 `' + short + '` 已完成' + (summary ? '：' + summary.slice(0, 200) : '')
    // ① 有活跃卡（飞书入站回合 / 自动轮卡）⇒ **并进去**，不发任何独立消息
    const active = activeTurns.get(agent.id)
    if (active && mergeNoticeIntoCard(active.card, active.bot, active.chatId, line, 'active-turn', agent.id)) return
    const live = autoCards.get(agent.id)
    if (live && live.card && live.card.status === 'running'
      && mergeNoticeIntoCard(live.card, live.bot, live.chatId, line, 'auto', agent.id)) return
    // ② 会话不活跃（没有卡在跑）⇒ 双层播报：纯文本必达 + 详情卡
    void sendPlainText(bot, chatId, line + '\n\n_这是通知，不用回这条；直接说你的想法即可。_')
      .then(() => console.log('[fs] notice plain text sent: agent=' + agent.id + ' child=' + short))
      .catch((error) => {
        console.log('[fs] notice plain text failed: ' + String(error && error.message || error))
      })
    const info = { kind: 'notice', round: 0, title: '🔔 子代理 `' + short + '` 已完成 · 正在继续工作…' }
    const state = openGoalCard(agent, bot, chatId, info, null)
    autoCards.set(agent.id, makeAutoCardEntry(agent, bot, chatId, state, 'notice'))
    console.log('[fs] notice card opened (broadcast): agent=' + agent.id + ' child=' + short)
  }

  async function pollSubagentNotices() {
    try {
      await pollSubagentNoticesInner()
    } catch (error) {
      // 定时器里的异常绝不能逃出去（未捕获异常 = 进程结束）
      console.log('[fs] notice poll failed: ' + String(error && error.stack || error))
    }
  }

  async function pollSubagentNoticesInner() {
    if (stopping) return
    if (!NOTICE_CARDS_ON) return
    for (const item of feishuChatAgents()) {
      const { agent, bot, chatId } = item
      let events
      try { events = sessionEvents(agent.session) } catch { continue }
      if (!Array.isArray(events)) continue
      const from = noticeCursor.get(agent.id)
      // 首次见到该 agent（或会话被换掉）：只登记当前位置，**不回放历史** ——
      // 否则重启后会把很久以前的回执全部重播一遍（刷屏）。
      if (from === undefined || from > events.length) {
        noticeCursor.set(agent.id, events.length)
        continue
      }
      if (from === events.length) continue
      for (let i = from; i < events.length; i++) {
        const event = events[i]
        if (!event || event.type !== 'user/message') continue
        const src = (event.data && event.data.source) || {}
        if (src.kind !== 'subagent-settled') continue
        const key = String(src.senderSessionId || '?') + '#' + String(event.seq)
        if (noticeSeen.has(key)) continue
        rememberNoticeSeen(key)
        if (bot.cfg && bot.cfg.notifyAgentNotices === false) continue   // per-bot 开关
        try {
          await announceSubagentNotice(agent, bot, chatId, event, src)
        } catch (error) {
          console.log('[fs] notice broadcast failed: ' + String(error && error.stack || error))
        }
      }
      noticeCursor.set(agent.id, events.length)
    }
  }

  // 目标状态变化 → 刷新活跃卡片，让底部「目标条」跟着变（改造③）。
  // `goal/changed` 只带 change（无 sessionId），`goal/activation-changed` 带 sessionId；
  // 数量很小，直接刷新所有飞书活跃卡最稳（漏刷比多刷一次贵得多）。
  function refreshLiveCards() {
    for (const item of feishuChatAgents()) {
      const live = autoCards.get(item.agent.id)
      if (live && live.card && live.card.status === 'running') {
        void syncCard(live.bot, live.chatId, live.card, true).catch(() => {})
      }
      const active = activeTurns.get(item.agent.id)
      if (active && active.card && active.card.status !== 'sealed') {
        void syncCard(active.bot, active.chatId, active.card, true).catch(() => {})
      }
    }
  }

  ctx.on('goal/changed', () => {
    try { refreshLiveCards() } catch (error) {
      console.log('[fs] goal/changed refresh failed: ' + String(error && error.message || error))
    }
  })

  ctx.on('goal/activation-changed', () => {
    try { refreshLiveCards() } catch (error) {
      console.log('[fs] goal/activation-changed refresh failed: ' + String(error && error.message || error))
    }
  })

  // 2026-10-01（CM 回归红线）：**用户点过卡片之后，后续内容一律写到新卡上。**
  // 旧实现只在 `activeTurns`（飞书**入站**轮）里找 split；自动轮（回执轮/目标轮）不在那张表里
  // ⇒ 点完按钮，内容却继续写进他已经划过去的那张旧卡 ⇒ 用户观感＝"我点了，它却没动"。
  // CM 原话：「我看到的最后一条消息就是你给我选择的东西……你在旧卡片上面持续的去新增」。
  function makeAutoCardEntry(agent, bot, chatId, state, kind) {
    const entry = {
      card: state.card,
      bot,
      chatId,
      agent,
      kind,
      openedAt: Number.isFinite(state.card && state.card.cursor) ? state.card.cursor : 0,
      stop: () => (state.stop ? state.stop() : undefined),
      split: () => {
        try {
          if (state.stop) state.stop()
          const old = entry.card
          if (!old) return
          // 1) 冻结旧卡：它停在用户刚点过的那张选择卡**上面**，后续内容不能再往上堆
          old.status = 'sealed'
          old.blocks = (old.blocks || []).filter((b) => !(b.type === 'message' && b.text === '正在工作中…'))
          old.blocks.push({ type: 'message', text: '✅ 已收到你的选择，继续处理中…' })
          void syncCard(entry.bot, entry.chatId, old, true).catch(() => {})
          // 2) 新卡接在当前事件位置：split 之前的内容已经在旧卡上，绝不重放
          const fresh = makeCardState(agent)
          fresh.cursor = sessionEvents(agent.session).length
          fresh.blocks.push({ type: 'message', text: '继续处理中…' })
          state.card = fresh
          // 必须**立刻**把新卡建出来：只登记不建卡的话，用户点完按钮会看到"什么都没发生"，
          // 直到下一个事件才冒出新卡（runTurn 的 split 也是先 syncCard 再挂 watcher）。
          void syncCard(entry.bot, entry.chatId, fresh, true).catch(() => {})
          // 2026-10-02 代码审查 low#7：这里原来传 null ⇒ 答题后新开的这张卡**没有换卡通道**，
          // 一旦满 5 张表还有待镜像事件，demoteOverflowTables() 就会把多出来的表降级成代码块，
          // 破坏"表格额度换卡…永远不降级表格"那条不变量。改成接上 openGoalCard 的 rotate。
          state.stop = startCardWatcher(agent, fresh, entry.bot, entry.chatId, state.rotate || null)
          entry.card = fresh
          console.log('[fs] auto card split after answer: agent=' + agent.id + ' chat=' + entry.chatId)
        } catch (error) {
          console.log('[fs] auto card split failed: ' + String(error && error.message || error))
        }
      },
    }
    return entry
  }

  // 答题后统一找"当前该被冻结的那张卡"：入站轮优先，其次自动轮。
  // 两条路都找不到时**明确留痕**（不再静默跳过 —— 静默跳过正是这次回归的根因）。
  function splitLiveCardAfterAnswer(agentId) {
    if (!agentId) return false
    const turn = activeTurns.get(agentId)
    if (turn && typeof turn.split === 'function') {
      try { turn.split(); return true } catch (error) {
        console.log('[fs] question split failed (turn): ' + String(error && error.message || error))
        return false
      }
    }
    const auto = autoCards.get(agentId)
    if (auto && typeof auto.split === 'function') {
      try { auto.split(); return true } catch (error) {
        console.log('[fs] question split failed (auto): ' + String(error && error.message || error))
        return false
      }
    }
    console.log('[fs] question split skipped: no live card for agent=' + agentId)
    return false
  }

  ctx.on('agent/status', ({ agent, status }) => {
    try {
      if (!agent || !agent.id) return
      // 2026-10-02：审批水位线随**任何** agent 状态变化补挂一次（WeakSet 幂等）。
      // 不依赖「先来一条飞书消息」——插件重载后已存在的老 agent 不会再走
      // handleInbound，只靠那条路径会漏挂 ⇒ 审批又被 GUI 桥接抢答。
      bindFeishuAgentApproval(agent)
      // 2026-10-02（第三轮门槛 medium#1）：**这是上一轮"注销旧监听"修复带出来的新缺口** ——
      // 提问/计划审查那条 agent 作用域监听原本只从 handleInbound 与 /plan 补挂；
      // 以前"从不注销"把这个不对称掩盖住了，现在每次重载都会拆掉旧监听，于是
      // **老 agent 起自动轮（goal/notice，不走 handleInbound）时手上没有 agent 作用域监听**，
      // 而根级监听又被 GUI 桥接抢在前面 ⇒ 提问/计划审查只弹电脑、飞书收不到卡。
      // 两条水位线必须共用同一个补挂点（agent/status 是唯一"与入站无关"的那一个）。
      bindFeishuAgentQuestions(agent)

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
          // 失败轮不能谎报成功（2026-09-18，与普通回合 runTurn 同源的问题）：
          // 上游报错（如 402 余额不足）会让整轮**没有任何产出**，旧实现照样写「✅ 本轮结束」+
          // status='sealed' → 目标模式下同样"看不出为什么不动了"。失败标记只认上游显式 reason。
          const failure = turnFailureReason(sessionEvents(agent.session), live.openedAt || 0)
          if (failure && !closing.text) {
            card.blocks.push({ type: 'message', text: '⚠️ 本轮没有产生回复：' + failure.text })
          } else if (!closing.text && card.tools.size === 0) {
            // 与普通回合同源（2026-09-21）：没有产出、也没有失败标记时，**不许**写「✅ 本轮结束」装成功。
            card.blocks.push({ type: 'message', text: '⚠️ 本轮没有产生回复：上游没有给出失败标记（原因未上报 —— 见 dsh 日志／GUI）' })
          }
          const silent = !closing.text && card.tools.size === 0
          card.status = (failure || silent) ? 'error' : 'sealed'
          card.blocks.push({ type: 'message', text: (failure || silent) ? '❌ 本轮失败' : '✅ 本轮结束' })
          console.log('[fs] auto card sealed: agent=' + agent.id + ' kind=' + (live.kind || 'goal') + ' failure=' + (failure ? failure.text : 'none') + ' silent=' + silent
            + ' closing_hash=' + shortHash(String(closing.text || '')) + ' closing_len=' + String(closing.text || '').length
            + ' card=' + (card.token || '-') + ' blocks=' + card.blocks.length)
          void syncCard(live.bot, live.chatId, card, true).catch(() => {})
        }
        console.log('[fs] auto card sealed: agent=' + agent.id + ' kind=' + (live.kind || 'goal'))
        return
      }
      if (status !== 'running') return
      // 2026-10-02 诊断（T8 失败）：目标轮**没有**建卡，而下面全是**静默 return** ——
      // 不把跳过原因打出来就只能猜（A24 不许猜）。这里只加日志、不改任何分支行为。
      if (autoCards.has(agent.id)) { console.log('[fs] agent/status skip: already tracking ' + agent.id); return }        // 已在跟踪这一轮
      if (activeTurns.has(agent.id)) { console.log('[fs] agent/status skip: feishu turn owns card ' + agent.id); return } // 普通飞书回合持有卡，绝不抢
      const where = findChatForAgent(agent)
      if (!where) { console.log('[fs] agent/status skip: no chat owner ' + agent.id); return }                           // 不是飞书会话（GUI/其它通道）
      const cfg = where.bot && where.bot.cfg
      const info = autoTurnInfo(agent)
      if (info.kind === 'goal') {
        if (!GOAL_CARDS_ON) { console.log('[fs] agent/status skip: GOAL_CARDS_ON=false'); return }
        if (cfg && cfg.notifyGoalRounds === false) { console.log('[fs] agent/status skip: notifyGoalRounds=false'); return }
      } else if (info.kind === 'notice') {
        // 子代理／后台 job 把模型唤醒的"自动回合"：建卡，让 CM 看得到并且收到这一轮的结论
        if (!NOTICE_CARDS_ON) { console.log('[fs] agent/status skip: NOTICE_CARDS_ON=false'); return }
        if (cfg && cfg.notifyAgentNotices === false) { console.log('[fs] agent/status skip: notifyAgentNotices=false'); return }
      } else {
        console.log('[fs] agent/status skip: autoTurn kind=' + String(info.kind))  // 其它自动回合（system-reminder 等）不建卡，噪声最低
        return
      }
      // 2026-09-27（CM 实证"一个内容发两次"）：**目标轮**在同一轮里紧跟着普通回合卡起来时，
      // 接在那张卡上、**不再另开**（两张卡同源镜像同一批事件 = 用户看到同内容两张卡）。
      // 回执轮（notice）保持原行为 —— 它是子代理/后台 job 唤起的独立一轮，单独一张卡更好认（smoke 22/23 覆盖）。
      pruneRecentTurnCards()      // 读之前先剔过期项（见 pruneRecentTurnCards 上方说明）
      const recent = recentTurnCards.get(agent.id)
      const reuse = (info.kind === 'goal' && recent && recent.chatId === where.chatId
        && (Date.now() - recent.sealedAt) <= AUTO_CARD_REUSE_MS
        && recent.card && recent.card.token && !recent.card.circuitOpen)
        ? recent.card : null
      if (reuse) recentTurnCards.delete(agent.id)
      const state = openGoalCard(agent, where.bot, where.chatId, info, reuse)
      autoCards.set(agent.id, makeAutoCardEntry(agent, where.bot, where.chatId, state, info.kind))
      console.log('[fs] auto card opened: agent=' + agent.id + ' kind=' + info.kind
        + ' round=' + (info.round || 1) + ' chat=' + where.chatId)
    } catch (error) {
      console.log('[fs] agent/status handler error: ' + String(error && error.stack || error))
    }
  })

  console.log('[fs] bridge active. config: ' + configPath())
  // 上一代若因热重载打断了回合，这里立刻在**该会话里**说明白（见 announceReloadInterrupts）。
  announceReloadInterrupts(0)
  void ensureHelpers()
}
