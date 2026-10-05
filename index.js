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
  chmodSync, unlinkSync,
} from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
// ── D5（P1.5 身份注入 · 按人判）：内核（可独立单测，见 identity-inject.mjs --selftest）──────
//    规格：NODE1 v3 §2.5 ＋ `P1.5-身份注入-按人判-施工任务书-v1.md` D5（归属：HOME）
import {
  TurnIdentityStore, applyActorToArguments, decideAction, makeResolver, pickMapPath, localMapPath,
} from './identity-inject.mjs'

// D5：进程内单例 —— 「本轮上下文」按 agent.id 存，所以多 bot 实例共享一个 store 也不会串号。
// 表/resolver 路径默认取 /opt/scripts/G9/（服务器），可用 MAILBOX_IDENTITY_MAP 覆盖。
let __turnIdentity = null
let __identityResolver = null
// ⚠️ `workspaceRoot` 是 `apply()` 内的局部（index.js:356），**模块级的本函数访问不到** ——
//    2026-10-04 实测踩过：这里写成 `workspaceRoot()` ⇒ 每次抛 `workspaceRoot is not defined`，
//    而调用处的 try/catch 把它**静默吞掉** ⇒ **身份注入悄悄失效**（`rec` 始终为 null，
//    看起来"没被锁死"很安全，其实**根本没在认人**）。
//    ⇒ **必须由调用方把工作区传进来**（三个调用点都在 `apply()` 作用域内，拿得到）。
function identityCtx (ws) {
  if (!__turnIdentity) __turnIdentity = new TurnIdentityStore()
  // 🔑 表/resolver 的路径**跟着工作区走**（CM 2026-10-04 要求）：
  //    服务器 `/opt/scripts/G9/` 优先，其次 `<工作区>/output/g9-identity/`。
  //    ⇒ 表放在工作区里 ⇒ **Syncthing 会把它同步到各开发机** ⇒ HOME(`P:\Qoder\work`) 与
  //      CM-OFFICE(`D:\Work`) 都找得到，**两台都不会被锁死**。不写死任何盘符。
  if (!__identityResolver) __identityResolver = makeResolver({ workspaceRoot: ws || process.cwd() })
  return { store: __turnIdentity, resolver: __identityResolver }
}

// P1-1（0.8.0 互认出站）：主表路径 —— resolver 已建就直接复用它选定的路径（含工作区探测），
// 没建过则独立探测一次。出站 @ 的 name→id 兜底解析只读这张表。
function identityMapPath () {
  try { return __identityResolver ? __identityResolver.mapPath : pickMapPath(null) } catch { return '' }
}

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
// 0.7.22（独立审查 LOW）：指路语在"上卡/摘卡/降级"多处按**字面全等**匹配。
//   文案一改，filter 就静默不再命中 ⇒ 过程卡上同时留着指路语和结论正文（重复内容）。
//   因此字面量集中到此，所有收发站点引用同一常量。
const CONCLUSION_POINTER = '✅ 本轮完成，结论见下方卡片。'
// 第十二轮门槛（MEDIUM）：同一条理由适用于**另一句指路语**——它在「摘卡/上卡/降级/回填」
//   四处按字面全等匹配（含 CARD_LABEL_SKIP），改文案同样会静默失配。集中到同一个地方。
const ANSWER_POINTER = '✅ 已收到你的选择，继续处理中…'
// 第十四轮门槛（LOW）：同一条理由适用于 0.8.0 互认的**两条明细行标签**。生产者是
//   `mentionFooter`（拼『【本条 @ 的对象】…』）与 `senderLabelFooter`（拼『【发送方】kind=…』），
//   消费者是 `/switch` 摘要那处的剥离正则 —— 三处各写字面量，任一侧改措辞就会**静默失配**
//   （明细行跟着短消息泄漏到卡片灰字上，且不报错，正是那段注释要避免的事）。收成常量。
const SENDER_FOOTER_TAG = '【发送方】'
const MENTION_FOOTER_TAG = '【本条 @ 的对象】'
// 摘要剥离正则由上面两个常量**拼出来**（不是另写一份字面量）：标签一改，正则同步跟上。
//   语义与原来一字不差：从明细行起削到「（你在引用这条消息…」之前（那句是有效上下文，保留）。
// 🔴 第十五轮门槛 LOW（明知并接受，不加转义）：这里把常量直接插进正则，前提是标签里
//   **没有正则元字符**（【】不是）。真改成含 `(`/`+` 的措辞时，本行的拼接会当场产生
//   错误语义 —— 但那两个标签是**给用户看的中文行首标记**，措辞变更必走功能基线，
//   届时按基线补 `escapeRegExp` 而不是现在为假想需求建辅助函数。
//   同一轮的附带风险（用户正文里恰好含「【发送方】」⇒ 摘要从那里截断）**只影响 /switch 卡片
//   灰字显示**，不影响送进模型的上下文（那条走的是另一条路径），故不为此加行首锚定。
const FOOTER_STRIP_RE = new RegExp('\\s*(?:' + SENDER_FOOTER_TAG + '|' + MENTION_FOOTER_TAG
  + ')[\\s\\S]*?(?=\\s*（你在引用这条消息|$)')

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
  // agent / card / bot / chatId 都跨代可用）。
  // 🔴 2026-10-04（独立审查 HIGH-1，0.7.21）：**`rotate` / `split` 不跨代可用** —— 它们是登记那一代
  //   的闭包，里面用的是**那一代的 `generationDisposed`**。调用它们 ⇒ 推送全被代际旗吞掉，
  //   而且旧代的 `startCardWatcher` 会把本代正在跑的 watcher 抢停并覆盖登记 —— 这张卡从此不再更新。
  //   所以跨代条目一律先问 `closuresAreOurs(entry)`（见下），不是本代的就换成本代等价通道。
  const activeTurns = globalThis.__fsActiveTurns
    || (globalThis.__fsActiveTurns = new Map())   // agentId -> { card, bot, chatId, gen, rotate, split }
  // 0.7.16（审查 MED#2）：**代际旗**取代按卡对象登记 —— 0.7.15 的 WeakSet 只能拦 dispose 时**已存在**的卡；
  // dispose 之后本代 runTurn 还会**新建**卡（拆结论卡 makeCardState / 换卡 rotateAdoptedCard），那些新对象
  // 不在集合里、照发（= 野卡漏洞）。旗按「代」判定：dispose 之后本代**一切**推送（封口/新建卡/入队后才执行的
  // 任务体）全部拦下；新代 apply 是新闭包、旗=false ⇒ 接管/续卡照常（无按对象簿记，也无全局累积）。
  let generationDisposed = false

  // 0.7.21（HIGH-1）：**本代编号**。跨代共享表里要靠它分辨"这条记录是谁登记的"，
  //   从而决定 entry.rotate / entry.split 能不能调（只有本代登记的才能调）。
  const GEN_ID = (globalThis.__fsGenSeq = Number(globalThis.__fsGenSeq || 0) + 1)
  const closuresAreOurs = (entry) => Boolean(entry) && entry.gen === GEN_ID
  // 外代闭包被跳过时必须留痕（本文件口径：不许静默跳过），但同一张卡只留一次（每拍都会走到）。
  const foreignClosureLogged = new Set()
  const logForeignClosureSkip = (where, key) => {
    const tag = where + '|' + key
    if (foreignClosureLogged.has(tag)) return
    foreignClosureLogged.add(tag)
    console.log('[fs] foreign-generation closure skipped: ' + where + ' agent=' + key
      + ' (本代改用等价通道，不去调上一代的 rotate/split)')
  }

  // 0.7.21（HIGH-2）：**跨代补发队列（托孤）**。旧代被代际旗拦下的推送绝不能直接丢 ——
  //   丢了就是 CM 报的那张"永远停在正在工作中…"的卡：卡对象已被旧代改成 sealed，
  //   本代 watcher 的 `card.status === 'running'` 分支不再进 ⇒ **没有任何自愈通道**。
  //   旧代把"欠的那一次推送"记在这里，由**本代**的定时器补发（补发时推的是卡片对象的
  //   当前状态，所以收尾内容/封口状态都会一次到位）。
  //   边界（两条，都是刻意的）：
  //   ① 只补发**已经在会话里存在**的卡（`card.token` 非空 = 之前推送成功过 ⇒ 补发是 PATCH）。
  //      旧代 dispose 之后新建的卡没有 token ⇒ 补发等于往会话里凭空**多塞一张卡**（野卡），
  //      那种情况由 runTurn 自己的**单卡回退**负责把结论留在过程卡上
  //      （见 `conclusion card failed, falling back to single card`），指路语会一起改掉。
  //   ② 只有**本代认识这个会话**（能解析出 bot）时才补发，否则 TTL 到点丢弃并留痕。
  const cardRelay = globalThis.__fsCardRelay || (globalThis.__fsCardRelay = [])
  const CARD_RELAY_TTL_MS = 60000   // 60 秒内没人接手就丢弃（本代根本没有这个会话）
  const CARD_RELAY_MAX = 24         // 只留最近的若干条，防跨代累积
  function relayCardPush(card, chatId, bot) {
    if (!card || !chatId) return
    if (cardRelay.some((it) => it.card === card)) return   // 一张卡一次（补发时推的是当前状态）
    // 0.7.22 复跑审查（MEDIUM）：条目**记下归属 bot 的 appId**。队列跨代共享，而 `bots`
    //   是每代各自的 Map ⇒ 只能传 appId，由接手的那代 `bots.get()` 还原。
    //   原来只存 chatId，接手时靠 findBotForChat 猜 —— 同群两个 bot 都认识这个会话，
    //   它返回**配置里第一个**匹配 ⇒ 结论卡可能建在别人的 app 身份上，
    //   真主人后续对这张卡的 PATCH 全部失败。
    cardRelay.push({
      card,
      chatId,
      at: Date.now(),
      appId: String((bot && bot.cfg && bot.cfg.appId) || ''),
    })
    // 0.7.22 复跑审查（LOW）：超过上界时旧实现直接 splice 掉最老的几条 ⇒ 无声丢内容。
    //   建卡意图的结论卡被挤掉就等于一个字都没到，这里给它走一次降级。
    if (cardRelay.length > CARD_RELAY_MAX) {
      const evicted = cardRelay.splice(0, cardRelay.length - CARD_RELAY_MAX)
      for (const it of evicted) {
        const c = it && it.card
        if (c && !c.token && c.createOnRelay === true) {
          const owner = (it.appId && bots.get(it.appId)) || findBotForChat(it.chatId)
          console.log('[fs] relayed card push evicted (queue full), degrading: chat=' + it.chatId)
          relayCreateFallback(owner, it.chatId, c)
        }
      }
    }
    console.log('[fs] card push handed to next generation: chat=' + chatId
      + ' card=' + String(card.token || '-').slice(-8) + ' queued=' + cardRelay.length)
  }
  // 0.7.22（清单#2）：这张卡是否已经在托孤队列里（调用方据此判定"内容已有活着的实例接手"，
  //   不再重复降级成纯文本 —— 否则同一段结论会出现两次，正是 CM 报过的"一个内容发两次"）。
  //   0.7.22（独立审查 MED）：**排队 ≠ 会送达** —— 无 token 又不是建卡意图的条目会被丢、
  //   熔断中的条目 syncCard 会跳过。只有"还能被送出去"的排队才算已交付，否则调用方会
  //   因为这里返回 true 而放弃纯文本兜底 ⇒ 这一轮的回复静默丢失。
  const hasRelayFor = (card) => Boolean(card) && cardRelay.some((it) => it.card === card
    && (it.card.token ? !it.card.circuitOpen : it.card.createOnRelay === true))
  // 建卡意图到期仍建不出来 ⇒ 结论**写回过程卡**（与 runTurn 的单卡回退同一口径：摘掉指路语、
  //   摆上状态栏），这样任何时刻都不会出现"指着一张永远不存在的卡"（smoke 用例 76 的红线）。
  //   连过程卡都没有可写回时才退化成纯文本。
  // ⚠️ 0.7.22（独立审查 HIGH）：bot **由调用方传入**，不在这里重新解析 —— 旧实现在这里
  //   再查一次 findBotForChat，而唯一调用点上一行刚按 `!bot` 分支进来（同拍必然还是 undefined），
  //   于是两条降级路径全是死代码，结论照样静默丢。真正能降级的是"**有 bot 但建卡失败**"那条路。
  function relayCreateFallback(bot, chatId, card) {
    // 0.7.22 复跑审查（MEDIUM）：一条降级只能发生一次。同一张卡可能既走到这里、又被
    //   syncCard 的 dispose 分支**重新托孤**回队列（`handing to next generation`），
    //   重入会把同一段正文往过程卡上 append 两遍 ⇒ 又变成"一个内容发两次"。
    // 🔴 0.8.0 第七轮门槛（MEDIUM）：**读闩在前、上闩在后** —— 旧写法把「查」和「置」写在
    //   一起，放在 `!bot || !text` 那道退回守卫**之前**，于是"这一次根本没降级成功"
    //   （调用方传入的 owner 解析为 undefined 时可达）也把一次性闩消耗掉并锁死该卡 ⇒
    //   结论永久丢失。只有**真正发生了降级**才许占用这个闩。
    if (card && card.relayFallbackDone) return
    const text = String((card && card.relayFallbackText) || '')
    if (!bot || !text) {
      console.log('[fs] relayed card create lost (no bot or no fallback text): chat=' + chatId)
      return
    }
    if (card) card.relayFallbackDone = true
    const holder = card && card.relayFallbackCard
    // 0.7.22 复跑审查（MEDIUM）：过程卡**推不动**时不能只写着"已降级"就算完 ——
    //   syncCard 对 circuitOpen / retryUntil 未到的卡是直接 return（force 也照样被退避拦下），
    //   于是结论 append 进了内存卡却一个字都没到，而 relayFallbackDone 已经锁死，再没机会降级。
    //   判据用"能不能真的推"，推不动就退回纯文本那条路（sendPlainText 不受这两个闸门管）。
    const holderPushable = Boolean(holder && holder.token
      && !holder.circuitOpen && Date.now() >= Number(holder.retryUntil || 0))
    if (holderPushable) {
      holder.blocks = (holder.blocks || [])
        .filter((b) => !(b && b.type === 'message' && b.text === CONCLUSION_POINTER))
      // 闩松开后（见下面的"没送达"处置）同一段结论可能再进来一次 ⇒ append 幂等，
      //   否则卡片里会出现两行一模一样的正文。
      if (!(holder.blocks || []).some((b) => b && b.type === 'message' && b.text === text)) {
        holder.blocks.push({ type: 'message', text })
      }
      holder.footerMode = 'full'   // 它现在就是结论卡 ⇒ 该摆状态栏
      console.log('[fs] relayed card create degraded onto the process card: chat=' + chatId)
      const syncedBefore = Number(holder.lastSyncAt || 0)
      const rescuedBefore = Boolean(holder.rescued)
      try {
        void syncCard(bot, chatId, holder, true)
          .catch(() => { })
          .then(() => {
            // 0.7.22（独立审查 HIGH）：`relayFallbackDone` **不能在 PATCH 确认落达之前就当数**。
            //   过程卡的看门狗在回合封口时已经停了、这张卡也早被移出 recentTurnCards ⇒ 这次 PATCH
            //   要是栽在网络/限流/5xx（不触发 syncCard 内部的 rescueText 救援），就**没有任何人再推它**：
            //   结论 append 在内存里、一个字没到用户手上，而闩已锁死 ⇒ 永久静默丢失。
            //   "字到了"的三条证据（任一成立即可）：
            //   ① 这次同步真的成功过 —— lastSyncAt 前进**且** failCount 归零
            //     （单看 lastSyncAt 不够：并发在前面的那次推送成功也会推进它，而本次可能是
            //      被 circuitOpen/retryUntil 提前拦下的空跑；那两个闸门只可能由失败置位，
            //      所以 `failCount === 0` 正好把"闸门拦下/提前返回"排除掉）；
            //   ② syncCard 内部已用纯文本把整卡正文救回过（rescued，本次新置位）；
            //   ③ 请求在飞途中本代被 dispose ⇒ 卡已重新托孤给活着的实例，这里再降级就是发两次；
            //   ④ 这次失败进了退避窗口，而退避到点有定时器会再推同一张卡（scheduleCardRetry；
            //      判据与它内部的"会不会挂上定时器"三条一致：有 token、未熔断、未被救援）。
            const willBeRetried = Boolean(holder.token) && !holder.circuitOpen && !holder.rescued
              && Number(holder.retryUntil || 0) > Date.now()
            const delivered = (Number(holder.lastSyncAt || 0) > syncedBefore
              && Number(holder.failCount || 0) === 0)
              || Boolean(holder.rescued) !== rescuedBefore
              || cardRelay.some((queued) => queued.card === holder)
              || willBeRetried
            if (delivered) return
            console.log('[fs] relayed card degrade not delivered, falling back to plain text: chat=' + chatId)
            card.relayFallbackDone = false   // 这次降级没生效 ⇒ 松开闩，允许后续路径再试一次
            try { void sendPlainText(bot, chatId, text).catch(() => { }) } catch { }
          })
      } catch { }
      return
    }
    console.log('[fs] relayed card create degraded to plain text: chat=' + chatId)
    try { void sendPlainText(bot, chatId, text).catch(() => { }) } catch { }
  }
  function drainCardRelay() {
    if (!cardRelay.length) return
    const now = Date.now()
    // 0.7.21（独立审查）：**一拍最多补发一条**，通道不可用就**整批停下**（条目留着，TTL 兜底）。
    //   原因：补发走的是真 bot 真凭据 ⇒ 队列里堆几条就一口气往会话里推几张同形卡，
    //   既撞飞书额度（AIAD H1 最小调用量），也容易让 CM 连着看到几张内容相近的卡。
    for (let i = cardRelay.length - 1; i >= 0; i--) {
      const it = cardRelay[i]
      // 本代在托孤**之后**已经推过更新的内容 ⇒ 撤销。
      //   比的是入队时刻 `at`，不是内容水位：旧代欠的那一次通常是**收尾/封口**
      //   （status=sealed、结论由 note 升为 message），这类变化**不产生新事件**
      //   ⇒ lastScannedAt 原地不动，按水位判定会误判"已送达"，卡就永远停在
      //   「正在工作中…」（正是 CM 报的那个障）。
      //   取**严格大于**：`lastPushedAt` 记的是组装载荷那一刻的水位，
      //   一次"恰好在托孤那一瞬组装、送达却在封口之前"的推送，水位可能与 `at` 同值 ⇒
      //   用 `>=` 会把这种没带上新状态的推送当成已送达。宁可多一次幂等 PATCH，不可漏终态。
      if (Number(it.card.lastPushedAt || 0) > it.at) {
        cardRelay.splice(i, 1)
        continue
      }
      // 没有 token ⇒ 这是旧代 dispose **之后**才新建的卡（会话里根本不存在它）。
      //   0.7.22（交接清单#2）：分两种，不再一刀切丢弃 ——
      //   · `createOnRelay`（结论卡这类"内容必须出现"的卡）⇒ 交给下面**真建**（POST）。
      //     旧实现直接丢弃 ⇒ 结论卡形态永久丢失，只剩单卡降级。
      //   · 其余无 token 卡 ⇒ 绝不补发（那等于凭空多塞一张野卡）。
      const createIntent = !it.card.token && it.card.createOnRelay === true
      if (!it.card.token && !createIntent) {
        if (now - it.at > CARD_RELAY_TTL_MS) {
          console.log('[fs] relayed card push dropped (card never existed in this chat): chat=' + it.chatId)
          cardRelay.splice(i, 1)
        }
        continue
      }
      // 这张卡还在**重试退避窗口**里（上次推失败，retryUntil 之前推了也会被 syncCard 拦下）。
      //   0.7.21（独立审查）：必须**留着这条**再看下一张 —— 旧实现直接调 syncCard 并打印
      //   "delivered" 后 splice，而那次调用其实被 retryUntil 挡回 ⇒ **唯一一次自愈机会被
      //   静默吃掉，日志还撒谎**。这里跳过（continue）等退避过去，由 TTL 兜底。
      if (now < Number(it.card.retryUntil || 0)) continue
      // 0.7.22 复跑审查（MEDIUM）：先按条目里记的 appId 还原**这张卡的主人**，
      //   解析不到才退回按会话猜（同群两 bot 时 findBotForChat 返回配置里第一个 ⇒ 会建错身份）。
      const bot = (it.appId && bots.get(it.appId)) || findBotForChat(it.chatId)
      if (!bot) {
        // 本代解析不到这个会话的 bot ⇒ 通道是真坏着：不许把后面的卡继续硬塞，整批停下等下一拍。
        //   0.7.22（独立审查 HIGH）：这里**不做降级** —— 连 bot 都拿不到就没有任何发送通道，
        //   降级照样发不出去；能救结论的是下面"有 bot 但这次建卡失败"那条路。
        if (now - it.at > CARD_RELAY_TTL_MS) {
          console.log('[fs] relayed card push dropped (no bot for this chat within '
            + Math.round(CARD_RELAY_TTL_MS / 1000) + 's): card=' + String(it.card.token || '-').slice(-8)
            + (createIntent ? ' CONCLUSION LOST (no bot channel)' : ''))
          cardRelay.splice(i, 1)
        }
        break
      }
      const push = syncCard(bot, it.chatId, it.card, true).catch(() => { })
      // 0.7.22（独立审查 HIGH+MED#2）：建卡意图**必须看结果**。旧实现 fire-and-forget 后无条件
      //   splice ⇒ 新代这次 POST 若因网络/限流/5xx 失败（不属于 rejected/toolarge 那两类、
      //   不会触发 syncCard 内部的 rescueText 救援），卡被永久放弃而队列条目已删，
      //   结论连一个字都没到 —— 正是本次修复要消灭的"内容静默丢失"。
      //   只在 `!it.card.rescued` 时降级：syncCard 内部已发过纯文本救援就不再重复发
      //  （CM 报过的"一个内容发两次"）。
      if (createIntent) {
        void push.then(() => {
          // 0.7.22 复跑审查（MEDIUM）：本代在请求在飞途中被 dispose ⇒ syncCard 的 catch 已把
          //   这张卡**重新托孤**给下一代并正常返回（`handing to next generation`）。队列里还有它
          //   = 内容照样会送出去，这里再降级就是"同一个结论发两次"。
          if (cardRelay.some((queued) => queued.card === it.card)) {
            console.log('[fs] relayed card push re-queued mid-flight, not degrading: chat=' + it.chatId
              + ' card=' + String(it.card.token || '-').slice(-8))
            return
          }
          // 0.7.22 复跑审查（LOW）：送达日志改到 settle 之后打，并区分"真建出来"与"降级"——
          //   旧实现同步就打 `push delivered`，那次 POST 失败时这句是假的。
          const degraded = !it.card.token && !it.card.rescued
          console.log('[fs] relayed card push ' + (degraded ? 'degraded' : 'delivered')
            + ': chat=' + it.chatId + ' card=' + String(it.card.token || '-').slice(-8))
          if (degraded) relayCreateFallback(bot, it.chatId, it.card)
        }).catch((error) => {
          // 第六轮门槛（LOW）：这个 `.then` 原来没有终点 catch ⇒ 回调里任何异常（例如
          // `relayCreateFallback` 自己抛）都会变成 unhandled rejection，**最后那道纯文本兜底
          // 反而被静默吞掉** —— 正是本版本要消灭的"内容静默丢失"。
          console.log('[fs] relayed card push settle error: ' + String(error && error.message || error))
        })
      } else {
        console.log('[fs] relayed card push delivered: chat=' + it.chatId
          + ' card=' + String(it.card.token || '-').slice(-8))
      }
      cardRelay.splice(i, 1)
      break
    }
  }

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
    CONCLUSION_POINTER, ANSWER_POINTER,
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

  // 未命中的哨兵文案：**惟一定义**（日志判定也用它，避免"改文案就静默把 miss 判成 hit"，审查 LOW#281）
  const QUOTE_MISS_SENTINEL = '（内容未登记，可能是更早的消息）'
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
    const what = hit && hit.label ? '：' + hit.label : QUOTE_MISS_SENTINEL
    return '\n\n（你在引用这条消息' + what + '）'
  }

  // CM 2026-10-03（P1）：引用透传必须**可判定** —— 命中 / 未命中 / **字段为空** 三种都留痕。
  // 背景：helper 原样转发整包 data（helper.cjs），所以字段有就一定到得了这里；"什么都没有"
  // 只可能是飞书没带 parent_id/root_id ⇒ 必须有日志，否则只能靠猜（A24 禁无出处断言）。
  function logQuoteState(evt, hint) {
    const pid = String((evt && evt.parent_id) || '')
    const rid = String((evt && evt.root_id) || '')
    const state = !hint ? 'none' : (hint.includes(QUOTE_MISS_SENTINEL) ? 'miss' : 'hit')
    console.log('[fs] inbound quote: parent_id=' + (pid || 'EMPTY') + ' root_id=' + (rid || 'EMPTY')
      + ' hint=' + state)
    if (state === 'miss') console.log('[fs] quote miss: ' + (pid || rid))
    if (state === 'none' && evt && typeof evt.content === 'string'
      && /(quote|parent_id|root_id)/i.test(evt.content)) {
      // 字段为空、但事件正文里出现引用痕迹 ⇒ 把原始 content 记下来（下次就知道飞书是怎么给的）
      console.log('[fs] quote fields EMPTY but content mentions quoting: ' + evt.content.slice(0, 200))
    }
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
        // 2026-10-03：审批单卡通道开关（**默认关**——不写就是关）。
        // ⚠️ 必须进白名单：本函数是**白名单归一化**，漏在这里 ⇒ 配置里写了也被丢掉
        //（本仓在 splitConclusionMinMs 上踩过一模一样的坑，见上面那条注释）。
        approvalForm: typeof bot.approvalForm === 'boolean' ? bot.approvalForm : undefined,
        // 0.7.17（两模式）：full（缺省＝现状行为）| stable（员工显示层收起）。热读，10 秒生效。
        // ⚠️ 必须进白名单：本函数是白名单归一化，漏在这里 ⇒ 配置里写了也被丢（splitConclusionMinMs 同坑）。
        mode: (typeof bot.mode === 'string' && bot.mode.toLowerCase() === 'stable') ? 'stable' : undefined,
        // 0.7.18（身份闸门）：**默认关** —— 不写就是关（上游用户不一定需要这个功能；CM 2026-10-04 定）。
        // 打开后：入站按 `open_id` 查身份表 ⇒ 工具入参里的身份字段一律被覆写成表里的真值；
        //        拿不到身份则拒绝执行（fail-closed）。
        // ⚠️ 必须进白名单：本函数是白名单归一化，漏在这里 ⇒ 配置里写了也被丢（splitConclusionMinMs 同坑）。
        identityGuard: typeof bot.identityGuard === 'boolean' ? bot.identityGuard : undefined,
        // 0.8.0（P0-6 可选接力）：**默认 self_only = 现状门一字不动**（CM 2026-10-04 防互刷裁决）。
        // mentions_any=转"@了任意其它 bot"的消息；all=全部群消息转发；off=全部丢弃。
        // groupRelayChats 按群覆盖（oc_x -> 模式）。⚠️ 白名单坑同 splitConclusionMinMs。
        groupRelay: ['mentions_any', 'all', 'off', 'self_only'].includes(bot.groupRelay)
          ? bot.groupRelay : undefined,
        groupRelayChats: (bot.groupRelayChats && typeof bot.groupRelayChats === 'object')
          ? Object.fromEntries(Object.entries(bot.groupRelayChats)
            .filter(([, v]) => ['mentions_any', 'all', 'off', 'self_only'].includes(String(v)))
            .map(([k, v]) => [String(k), String(v)]))
          : undefined,
      })
    }
    return cleaned
  }

  // 0.7.22（交接清单#5 安全项）：helper 的凭证改走**文件路径**，不再上命令行。
  //   原因：`node helper.cjs <appId> <appSecret>` 里的 appSecret 原文会被同机任何
  //   账号 `ps aux` 看到（服务器上有 7 个 agt* 账号）。文件落在配置目录内，与
  //   feishu.config.json 同级、同暴露面，权限收紧到 0600。
  //   文件名用 appId 的 sha256（0.7.22 独立审查 LOW）：脱敏字符直接删除会让
  //   `cli_a+1` 与 `cli_a1` 映射到同一个文件 ⇒ 一个 helper 可能读到另一个 bot 的凭证。
  //   保留可读前缀只为便于人工排查，唯一性由哈希保证。
  const credPathFor = (appId) => join(
    configDir(),
    'helper-cred-' + String(appId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)
    + '-' + createHash('sha256').update(String(appId)).digest('hex').slice(0, 12) + '.json',
  )
  function writeHelperCred(appId, appSecret) {
    const target = credPathFor(appId)
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(target, JSON.stringify({ appId, appSecret }), { mode: 0o600 })
    // Windows 忽略 mode，Linux/macOS 上覆盖写也可能沿用旧权限 → 显式 chmod
    try { chmodSync(target, 0o600) } catch { /* 尽力而为 */ }
    return target
  }
  // 只在 bot 从配置里被删除时清 —— **不在 helper 停止/dispose 时清**：
  //   ① 热重载后新代会立刻重新 spawn，而删除与"新代写文件→helper 首次读"之间存在竞争窗口，
  //      删早了会把自家连接打死（实测 --cred 读不到时 helper 直接中止，这是有意为之的 fail-closed）；
  //   ② 同一个 appSecret 本来就明文常驻在同目录的 feishu.config.json 里，
  //      多留一个 0600 副本不增加暴露面。真要收窄得先解决配置本身。
  function removeHelperCred(appId) {
    try { unlinkSync(credPathFor(appId)) } catch { /* 不存在或无权限：无需处理 */ }
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

  // 2026-10-03 F（CM：卡片的任何报错，用户要看得见、**Agent 也要收到**）：
  // 「发送前最后一道保险」。飞书对卡片是**整张卡一起拒**：只要里面有一个非法片段
  //（本地图片路径、不支持的 HTML 标签），正文会**连坐一起丢** —— 真机原话：
  //   `code 230099 / ErrCode 200570 / card contains invalid image keys / image key D:\Work\…\auth-qr2.png`
  // 而 `sendPlainText` **本身也是发卡片**（下面的 elements/tag:'markdown'）⇒ 兜底会**同因再挂**，
  // 于是两条路一起哑、用户那边就是"干着干着突然停了"。
  // ⇒ 所以把清洗放在**这一个唯一收口点**上：任何纯文本兜底都自动免疫。
  // ⚠️ 只剥"飞书真不支持/会整卡被拒"的东西；**`<font>` 是要保留的**（卡片 markdown 支持颜色），
  //    之前那个坑是**跨标签嵌套**（`<font>**X**</font>`），那个在 P1-5 的发卡链里按"已知好形态"修正。
  // 卡片 markdown **不支持**的 HTML 标签（会整卡被拒 / 把标签原文漏给用户）——
  // **一处定义**：stripUnsendable（纯文本兜底）与 sanitizeMarkdownForFeishu（发卡前清洗）共用，
  // 免得两份黑名单各改各的（独立审查 LOW#1576）。
  const UNSUPPORTED_HTML_TAG_RE = /<\/?(?:div|span|table|thead|tbody|tr|td|th|html|body|script|style|iframe)\b[^>]*>/gi
  function stripUnsendable(text) {
    let out = String(text == null ? '' : text)
    // ① 本地图片路径（Windows 盘符 / file:// / POSIX 绝对路径）⇒ 换成看得懂的说明
    out = out.replace(/!\[([^\]]*)\]\(\s*(?:[A-Za-z]:[\\/]|file:\/\/|(?:\/|\\)[^)]*)[^)]*\)/g,
      (m, alt) => '（图片未发送：飞书只接受**已上传**的 image_key' + (alt ? '，原图说明：' + alt : '') + '）')
    // ② 卡片 markdown **不支持**的 HTML 标签（会整卡被拒，或把标签原文漏给用户）
    out = out.replace(UNSUPPORTED_HTML_TAG_RE, '')
    return out
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
    // G（2026-10-03）：纯文本兜底/工具发卡也走**同一条内联链** ——
    // 本地图片引用先上传换 `img_key`（飞书只认 key；本地路径会把**整张卡**拒掉）。
    // ⚠️ 顺序**必须**是"先上传、后剥离"：第一版写反了（先 stripUnsendable）⇒ 本地图片标记
    //    在进 inlineLocalImages 之前就被换成"（图片未发送…）"了，**图永远传不上去**（冒烟抓出）。
    let body = String(text == null ? '' : text)
    try {
      const res = await inlineLocalImages(bot, body)
      body = res.text
    } catch (error) {
      console.log('[fs] inline images (plain) failed: ' + String(error && error.message || error))
    }
    // G-文件：纯文本通道**也**要能发文件（纯文本/卡片都带不了文件 ⇒ 作为独立文件消息发出）。
    // 冒烟抓出：只接在卡路径上 ⇒ `feishu_send` 里的本地文件链接永远发不出去。
    try {
      const files = await sendLocalFiles(bot, target, body)
      body = files.text
    } catch (error) {
      console.log('[fs] local files (plain) failed: ' + String(error && error.message || error))
    }
    body = stripUnsendable(body)
    // P1-1（0.8.0 互认出站）：`@[名]` / `@「名」` / `@all` 在**发送前最后一道**展开成真 @。
    // 未命中只声明不硬发（宁可看到"未能 @ 出"，也不发幽灵 @）。
    body = expandAtTokens(bot, target || cfg.ownerOpenId, body)
    // P1-4：post 降级通道（卡片 at 真机失效时的备胎；V4 实测两种形态都能触发对方）。
    if (String(process.env.DSH_FEISHU_AT_MODE || '').toLowerCase() === 'post') {
      try {
        const pres = await sendPostText(bot, target || cfg.ownerOpenId, receiveIdType, body)
        const pp = parseJson(pres.text)
        if (pres.status >= 200 && pres.status < 300 && pp && pp.code === 0) {
          try { rememberMessage(pp.data && pp.data.message_id, 'bot 的一条消息：' + String(text)) } catch {}
          return pres
        }
        console.log('[fs] post send failed, falling back to card: ' + String(pres.text || '').slice(0, 160))
      } catch (error) {
        console.log('[fs] post send error, falling back to card: ' + String(error && error.message || error))
      }
    }
    const card = {
      config: { wide_screen_mode: true },
      elements: [{ tag: 'markdown', content: body }],
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
    // F（2026-10-03）：**纯文本兜底自己失败也要可见** —— 旧实现只打一行日志，
    //   用户那边就是"什么都没有"（CM 原话："干着干着突然停了"）。
    //   这里的处置：① 留痕（可日志复验）② 用**最保守的纯文本**再试一次（去掉所有 markdown
    //   语法与链接，只剩单行字）—— 因为整卡被拒的头号原因就是里面的非法片段/语法。
    let parsedRes = parseJson(res.text)
    const okSent = res.status >= 200 && res.status < 300 && parsedRes && parsedRes.code === 0
    if (!okSent) {
      console.log('[fs] plain text send failed: status=' + res.status + ' '
        + String(res.text || '').slice(0, 200))
      try {
        const bare = String(text == null ? '' : text)
          .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
          .replace(/[*_`>#\[\]()]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 400)
        if (bare) {
          const retry = await httpJson(
            'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=' + receiveIdType,
            'POST',
            { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await tenantAccessToken(bot, cfg.appId, cfg.appSecret) },
            { receive_id: target || cfg.ownerOpenId, msg_type: 'interactive', content: JSON.stringify({ config: { wide_screen_mode: true }, elements: [{ tag: 'markdown', content: bare }] }) },
          )
          parsedRes = parseJson(retry.text)
          const okRetry = retry.status >= 200 && retry.status < 300 && parsedRes && parsedRes.code === 0
          console.log('[fs] plain text degraded retry: status=' + retry.status + ' ok=' + okRetry)
          return retry
        }
      } catch (error) {
        console.log('[fs] plain text degraded retry failed: ' + String(error && error.message || error))
      }
    }
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
  // 建卡那一刻的**计划模式真值**：回扫会话事件里最后一条 `plan/mode`（一条都没有 ⇒ false）。
  // 计划模式是**会话级**、跨回合存活，而 `plan/mode` 只在"开关那一刻"落一条 ⇒
  // 只按新事件更新会让"开关之后才建的卡"一直显示普通模式（独立审查 MED#645）。
  function lastPlanModeActive(agent) {
    try {
      const events = agent && agent.session ? sessionEvents(agent.session) : []
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e && e.type === 'plan/mode' && e.data) return Boolean(e.data.active)
      }
    } catch (error) {
      console.log('[fs] plan mode probe failed: ' + String(error && error.message || error))
    }
    return false
  }
  // 0.7.8：卡片的**创建序号**（跨代单调，挂 globalThis）—— 用来判"同会话里哪张卡更新"。
  //   为什么不用时间戳：热重载后新实例的计数器会从头开始，同毫秒还会打平；
  //   僵尸卡判据要求"后建的卡序号一定更大"。
  function nextCardStamp() {
    const g = globalThis
    g.__fsCardSeq = Number(g.__fsCardSeq || 0) + 1
    return g.__fsCardSeq
  }
  const WORKING_PLACEHOLDER = '正在工作中…'
  // 封口/换卡前必须摘掉"正在工作中…"占位符（本文件多处已明令：封口后的卡不许留着它）。
  // 审查 MED#7095：换卡路径（rotateTables / openGoalCard.rotate / rotateAdoptedCard）漏了这一步。
  function dropWorkingPlaceholder(card) {
    if (!card || !Array.isArray(card.blocks)) return 0
    const before = card.blocks.length
    card.blocks = card.blocks.filter((b) => !(b.type === 'message' && b.text === WORKING_PLACEHOLDER))
    return before - card.blocks.length
  }
  // 0.7.20：`from` = 被接续的**上一张卡**（换卡/分卡/答题续写都算同一轮的延续）。
  //   只继承一件事：静默提示**已播次数**。否则"提示一发就换卡"会把计数器一起换掉，
  //   上限形同虚设（2026-10-04 独立审查后自查发现：换卡链上的卡每张都从 0 重新数 ⇒ 还是刷屏）。
  function makeCardState(agent, from) {
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
      // 2026-10-03：静默的**种类**（'tools'=工具在跑 / 'silent'=上游没回包）+ 在跑的工具名 +
      // 已发出过"上游没回包"纯文本提示（每轮只发一次）+ 未完成的工具计数。
      idleKind: '',
      idleToolName: '',
      pendingTools: 0,
      // 2026-10-03：上次"长静默播报"的时刻（同一种静默最多每 10 分钟播一条，防刷屏）
      stallNotifiedAt: 0,
      // 0.7.20：这一轮已播过几次静默提示（上限 DSH_STALL_NOTICE_MAX；**换卡时从上一张继承**，
      //   见 makeCardState 的 `from`），以及「agent 已 idle 且无拥有者」的起始时刻
      //   （孤儿卡补封口的宽限计时，见 CARD_ORPHAN_SEAL_MS）。
      stallNoticeCount: Number(from && from.stallNoticeCount || 0),
      idleSince: 0,
      // 0.7.20：内容进卡 / 推送成功 的两个时刻（配对使用，见 scanCard 尾部与 syncCard 成功处）。
      //   热重载接管靠它判定"这张卡欠不欠一次推送"，不靠无脑重推（无脑重推=内容重复）。
      lastScannedAt: 0,
      lastPushedAt: 0,
      // 2026-10-03 H：计划模式开关（读会话 `plan/mode` 事件）—— 状态栏据此显示「📋 计划模式」
      // 初值必须**回扫会话**（见 lastPlanModeActive），不能硬编码 false：否则开关之后建的卡全错。
      planActive: lastPlanModeActive(agent),
      // 2026-10-03 F：这张卡是否已经做过"正文抢救"（内容被拒 ⇒ 摘片段重发纯文本，只做一次）
      rescued: false,
      // 0.7.8：创建序号（跨代单调）—— 判"同会话哪张卡更新"用（僵尸卡闸门 / 单 watcher 不变式）。
      bornSeq: nextCardStamp(),
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
  // a bottom status line until sealed. Overflow is folded into "更早过程" panel(s).
  // ⚠️ 2026-10-03 更正：这里原写 "Feishu limit 50, keep headroom at 40" —— **错的**。
  //    实测上限是 **200 元素**（见 CARD_FOLD_THRESHOLD 处证据），阈值已改为 180。

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
  // 🧪 2026-10-03 实测（官方文档 + cardkit 建卡接口，未发任何消息）：
  //   · 卡片 JSON 2.0 单卡上限 = **200 个元素**（200 → code=0；201 → code=300305 element exceeds the limit）
  //   · 载荷**另有字节上限**（198.5 KB 通过；983 KB → code=200860 card over max size）
  //   ⇒ 折叠阈值从"凭 50 猜的 40"改为 **180**（留 20 元素余量），并对载荷字节加同样含义的护栏。
  //   这条修正直接消除"正常长回合也被折进**默认收起**面板 ⇒ 过程文字看不见"（CM 报障的主症状）。
  const CARD_FOLD_THRESHOLD = 180
  // 超限**换卡续写**的触发线（内容原样留在旧卡、新卡接续 ⇒ 永不隐藏、也不撞上限）：
  const CARD_ROTATE_BLOCKS = 170
  // 体积护栏的**块数粗筛下限**（审查 LOW#2128）：块数不到这里就**不做** JSON.stringify 体积检查（性能）。
  // 必须 <= CARD_ROTATE_BLOCKS —— 否则体积检查会在"真超限"的卡上被跳过、护栏静默失效。
  const CARD_ROTATE_MIN_BLOCKS_FOR_BYTE_CHECK = 60
  // 换卡/侧消息的**共享文案**（审查 MED#2246：三处近乎逐字重复、且硬编码 "约 200 元素 / 200 KB"
  // 与真实阈值 170 块 / 120 KB 矛盾 ⇒ 抽常量并把数字**从阈值派生**）。
  // 0.7.9（CM 2026-10-03 ③ 拍板）：**指路语写在旧卡**（读者就在这张卡上）⇒ 文案用旧卡视角。
  // ⚠️ 这**作废**了 0.7.8 按审查 MED#967/MED#2272 改成"新卡视角"的方向 —— 以 CM 最新口径为准。
  const ROTATE_NOTICE_TABLES = '📊 本卡表格已满（飞书单卡最多 5 张），后续内容见下方新卡；**本卡正文原样保留**。'
  // 侧消息（看门狗/失败提示）是**另发的一条消息**，它排在旧卡**下面**、新卡**上面**。
  // 0.7.9（CM 2026-10-03 ③ 拍板）：**指路语写在旧卡**（读者正看着旧卡）⇒ 必须说"下面那条"。
  const SIDE_NOTICE_OLD = '⬇️ 下面那条是**另发的**提示；后续内容见下方新卡，**本卡正文原样保留**。'
  function rotateNoticeSize() {
    return '📄 本卡内容已达飞书单卡上限（约 ' + CARD_ROTATE_BLOCKS + ' 块 / '
      + Math.round(CARD_ROTATE_BYTES / 1000) + ' KB），后续内容见下方新卡；**本卡正文原样保留**。'
  }
  const CARD_ROTATE_BYTES = 120000        // 120 KB，低于实测通过线 198.5 KB
  // ⚠️ 体积必须按**真字节**量（审查 MED#958）：中文 1 字 ≈ 3 UTF-8 字节，用 String.length
  // 会低估到 ~1/3 —— 150000 "字符" 对 CJK 其实是 ~450 KB，早已越过实测 198.5 KB 的通过线。
  function blocksBytes(blocks) {
    try { return Buffer.byteLength(JSON.stringify(blocks || []), 'utf8') } catch (error) {
      // 审查 LOW#965：静默返回 0 会让"体积护栏"**悄悄失效**（卡越长越炸）⇒ 必须留痕
      console.log('[fs] blocksBytes failed (byte guard disabled this tick): ' + String(error && error.message || error))
      return 0
    }
  }

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

  // 卡片级表格配额：按遍历顺序，第 6 张起的表格降级成可读清单（不再用代码块）。
  // 0.7.9（CM 2026-10-03 P4，BA 回合 11310 实证 web.log 79604）先改成"递归"；
  // 0.7.10（独立审查 LOW#1096 修正）：**不再手维护键白名单** —— 改为复用本文件既有的通用遍历器
  //   `walkContentHolders`（它对**所有**键递归、且有环保护，见其定义处的真机事故注释）。
  //   旧白名单只覆盖"今天用到的键"：任何没列上的容器（1.0 风格 `div.text`、未来新增的包裹层）
  //   都会让 countPayloadTables **静默返回 0** ⇒ 护栏看着"通过"、而飞书那边照样 11310。
  function countPayloadTables(elements) {
    let n = 0
    walkContentHolders(elements, (h) => {
      if (h && h.tag === 'markdown' && typeof h.content === 'string') n += countMarkdownTables(h.content)
    })
    return n
  }
  function demoteOverflowTables(elements, max) {
    let used = 0
    walkContentHolders(elements, (h) => {
      if (!h || h.tag !== 'markdown' || typeof h.content !== 'string') return
      if (countMarkdownTables(h.content) === 0) return
      h.content = demoteTablesInText(h.content, () => (++used > max))
    })
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
  // 2026-10-03（CM）：「我是能看到'多少分钟没动作'这个提示，但我以为你是一直在有做事情」
  // ⇒ 旧那句「已 N 分钟无新动作」**会误导**：它既可能是"工具在跑"，也可能是"上游根本没回包"。
  //    现在按**事件流**区分（不猜）：
  //      · 有 `tool/call` 没等到 `tool/result` ⇒ 工具在跑（正常）
  //      · 最后一步是"请求已发出"、之后零事件 ⇒ **上游没回包**（该动手了）
  //    并且"上游没回包"静默超过 `DSH_STALL_NOTICE_MIN` 分钟会**另发一条纯文本**（新消息才提醒）。
  const DSH_STALL_NOTICE_MIN = 5
  // 2026-10-03 追加（CM：「为什么又卡那么久？」——我跑一个 4 分钟的冒烟命令，他那边**什么都不知道**）：
  // **长工具调用也必须播报**，而且必须是**一条新消息**（只改卡面上那行灰字他看不到通知）。
  // 阈值更低（3 分钟），同一种静默**最多每 10 分钟播一条**（防刷屏）。
  const DSH_TOOL_NOTICE_MIN = 3
  const DSH_NOTICE_REPEAT_MS = 10 * 60 * 1000
  // 0.7.20（CM 2026-10-04 报障「365/375/385/395/405 分钟一直刷」）：**同一轮最多播 2 次**。
  //   计数按「卡」存放，但**换卡时从上一张继承**（见 makeCardState 的 from 参数）——
  //   因为每次播报都会换一张新卡，不继承的话封顶会被自己的换卡动作绕过。
  //   真卡住也只需提醒两次；第三次起只会把会话刷成噪声，而 CM 该做的动作（/stop 或回一句）已经知道。
  const DSH_STALL_NOTICE_MAX = 2
  // 0.7.20：**孤儿卡补封口的宽限**。判据是「agent 已 idle 且没有任何回合拥有者」，
  //   而 runTurn 收尾是 `stopCardWatcher()` → `activeTurns.delete()` → 最后一次封口
  //   （见本文件 runTurn 收尾那段，删除拥有者与封口之间只有几行代码），
  //   不留宽限就可能抢在它前面封口、把「✅ 本轮结束」写两遍。
  //   阈值取 3000ms = **10 拍轮询**（CARD_POLL_INTERVAL 300ms）：远大于上面那几行的间隔，
  //   又不至于让真孤儿卡多挂太久（2026-10-04 独立审查 MED#1 要求加大余量；
  //   原先写 1200ms 只是"连续 3 拍"，余量偏薄）。
  const CARD_ORPHAN_SEAL_MS = 3000
  // H（2026-10-03 CM）：「状态栏这里应该变成三个不同的状态：**普通模式 / 计划模式 / 目标模式**」。
  // 判据全部用**现成的可读源**，不猜：
  //   · 计划：会话事件 `plan/mode`（`dsh-plan-mode` 每次切换都 append，见其 lib/index.js:377/392）
  //   · 目标：`goalSnapshot(agent)` —— 就是底部"目标条"用的同一个读接口（`!view` = 未激活）
  function modeLabelFor(card) {
    if (card && card.planActive) return '📋 计划模式'
    try {
      const agent = card && card.agent
      if (agent && goalSnapshot(agent)) return '🎯 目标模式'
    } catch { /* 读不到就按普通模式，不编 */ }
    return '🧭 普通模式'
  }
  function statusTextFor(card) {
    const mode = modeLabelFor(card)
    if (card.status === 'sealed') return '_' + mode + ' · ✅ 已完成_'
    if (card.status === 'completed') return '_' + mode + ' · 已完成_'
    if (card.status === 'error') return '_' + mode + ' · 失败_'
    if (card.idleMinutes > 0) {
      if (card.idleKind === 'tools') {
        return '_' + mode + ' · 🔧 工具' + (card.idleToolName ? ' `' + card.idleToolName + '`' : '')
          + ' 还在跑：已 ' + card.idleMinutes + ' 分钟没有新动作（**正常**，别急）_'
      }
      return '_' + mode + ' · ⏳ 上游已 ' + card.idleMinutes
        + ' 分钟**没有回包**（模型侧卡住／网络慢，**不是卡片坏了**）_'
    }
    return '_' + mode + ' · 运行中…_'
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
    if (phase === 'complete') return '✅ 已完成 · 共 ' + (Number(view.roundsStarted) || 0) + ' 轮'
    if (phase === 'paused') return '⏸️ 已暂停（发 /goal resume 恢复）· ' + rounds
    // CM 2026-10-01：**状态栏只写「已阻塞」** —— 长原因会把 `🧠 上下文/占比`、`💾 缓存命中`
    // 两栏挤断；原因一律放到**展开面板**的「阻塞原因」一行（见 goalFooterElements 的 detail）。
    if (phase === 'blocked') return '🚫 已阻塞 · ' + rounds
    if (phase === 'active' && String(view.activation || '') !== 'armed') {
      return '⚠️ 已创建但续行已停（发 /goal resume 恢复）· ' + rounds
    }
    return '已激活（续行已开）· ' + rounds
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
            content: '_' + status + (metric ? '  ｜  ' + metric : '') + '_',
          }],
        }],
      }]
    }
    // 0.7.9（CM 2026-10-03 ①）：**一行只允许一个模式位**。statusTextFor 已经写了模式，
    // 所以这里只补"目标状态短语"；且**计划模式优先**时不再显示目标短语（否则又出现两个模式）。
    const planActive = Boolean(card && card.planActive)
    const goalPart = planActive ? '' : goalStateText(view)
    const header = (status + (goalPart ? '  ｜  ' + goalPart : '') + (metric ? '  ｜  ' + metric : '')).replace(/\*\*/g, '')
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

  // P1-3（0.8.0 互认）：带 bot/chatId ⇒ 出卡收口点做**出站 @ 展开**（无 bot 时行为逐字不变）。
  function buildCardPayload(card, bot, chatId) {
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
      // 0.7.17（stable 显示层）：员工只看 状态行＋工具折叠面板（结果在内）＋结论；
      // 过程叙述（note）/指路行 message **不渲染**。blocks 本身一字不动（B7/追加纪律）——
      // 过滤只发生在 payload 渲染层；mode 在 syncCard 入口已解析（card.mode）。
      if (card.mode === 'stable' && block.type === 'note') continue
      if (card.mode === 'stable' && block.type === 'message') {
        const stableText = (block.text || '').trim()
        if (CARD_LABEL_SKIP.has(stableText) || stableText.indexOf('✅ 本卡已收口') === 0) continue
      }
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
            background_style: block.bg || STEER_NOTICE_BG,
            columns: [{
              tag: 'column',
              width: 'weighted',
              weight: 1,
              vertical_align: 'center',
              padding: '6px 10px 6px 10px',
              elements: [{
                tag: 'markdown',
                content: '**' + (block.title || STEER_NOTICE_TITLE) + '**\n\n' + text,
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
    // 0.7.10（独立审查 MED#1413 修正）：这里原先是"再降一次"的第二遍 —— 但两遍用**同一遍历、
    // 同一上限**，第二遍不可能再降（第一遍之后剩下的表要么在前 5 张之内、要么 demoteTablesInText
    // 根本转不了，例如单行/只有分隔线的"伪表"），等于**空转**，还打印了误导性的 `demoted=` 计数。
    // 现在改成**诚实复检**：只报告"降级之后还剩几张表"；若仍超上限 ⇒ 说明有转不了的表格
    // （= 仍有 11310 风险），交给 watcher 的换卡兜底，并留下**可判定**的日志。
    {
      const left = countPayloadTables(elements)
      if (left > CARD_MAX_TABLES) {
        console.log('[fs] payload tables still=' + left + ' (limit ' + CARD_MAX_TABLES
          + ') after demote: unconvertible tables remain, rotation will handle; card='
          + String(card && card.token || '-').slice(-8))
      }
    }

    // Window fold: keep the NEWEST content visible (live progress + conclusion
    // at the bottom), fold the ALREADY-SEEN history into panel(s) at the TOP.
    // The last KEEP_TAIL elements are never folded (2026-08-15 CM design).
    // 审查 MED#1362：折叠只是把文本搬进面板 —— **既不省字节也不省内容** ⇒ 体积超限不能靠它，
    // 走 watcher 里的"换卡续写"（CARD_ROTATE_*）。折叠只负责**元素个数**这条硬限制。
    if (elements.length > CARD_FOLD_THRESHOLD) {
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
            // 0.7.9（CM 2026-10-03 ②）：**默认展开** —— 折叠只用来省"元素个数"，
            // 而 expanded:false 会让读者以为"过程文字突然消失了"（要手动点开才看得到）。
            expanded: true,
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
    // 观测指纹（CM 2026-10-03 §3 指出"看不到日志就没法判定"）：
    //   封口那一帧打印 elements/panels/collapsed/可见字数/payload 指纹 ——
    //   下次任何"文字不见了"都能**一条日志**判定是折叠、换卡还是回退路径。
    if (card && card.status === 'sealed') {
      try {
        const panels = elements.filter((e) => e && e.tag === 'collapsible_panel')
        const visible = elements.map((e) => {
          if (!e) return ''
          if (e.tag === 'markdown') return String(e.content || '')
          if (e.tag === 'collapsible_panel' && e.expanded === true) {
            return String((e.elements && e.elements[0] && e.elements[0].content) || '')
          }
          return ''
        }).join('\n')
        console.log('[fs] card fingerprint: card=' + (card.token || '-')
          + ' status=' + String(card.status)
          + ' elements=' + elements.length
          + ' panels=' + panels.length
          + ' collapsed=' + panels.filter((p) => p.expanded !== true).length
          + ' visible_chars=' + visible.length
          + ' payload_md5=' + createHash('md5').update(JSON.stringify({ elements })).digest('hex').slice(0, 8))
      } catch { /* 指纹只用于留痕，绝不影响发卡 */ }
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
    // P1-5：出卡前**最后一道清洗**（接在表格降级/长文切块之后，见 sanitizeCardElements 注释）
    sanitizeCardElements(elements, bot, chatId)
    return { schema: '2.0', config: { wide_screen_mode: true }, body: { elements } }
  }

  // ---- G · 本地图片/文件上传（2026-10-03）--------------------------------------
  // 为什么必须上传：飞书卡片的图片字段**只认 `img_key`**（官方：「图片的 Key。可通过上传图片接口获得」，
  // `img_key` 必填），本地路径一律被拒、而且是**整张卡一起拒**
  //（真机：`code 230099 / ErrCode 200570 / card contains invalid image keys / image key D:\…\auth-qr2.png`）。
  // 权限：上传走 `im:resource`（本机 work bot 已实测具备）。
  const IMAGE_MAX_BYTES = 10 * 1024 * 1024            // 官方限制：图片 ≤10MB
  const LOCAL_IMAGE_RE = /!\[([^\]]*)\]\(\s*((?:[A-Za-z]:[\\/]|file:\/\/|\/|\\)[^)]*)\)/g
  // G-文件（2026-10-03 独立审查 MED#1410 后补线）：正文里的**本地文件链接** `[报告](D:\x.pdf)`
  //   —— 卡片发不了文件，改走"先上传换 `file_key`，再作为**文件消息**发出"。
  //   `(?<!!)` 排除图片写法（图片走 LOCAL_IMAGE_RE，别重复处理）。
  const LOCAL_FILE_RE = /(?<!!)\[([^\]\n]*)\]\(\s*((?:file:\/\/|[A-Za-z]:[\\/]|\/|\\)[^)\n]*)\)/g
  const FILE_MAX_BYTES = 30 * 1024 * 1024            // 飞书文件（消息）上限 30MB
  // ---- 附件安全闸（独立审查 HIGH#2 的修复）-------------------------------------
  // 卡面正文是 **agent 生成**的 ⇒ 可被提示注入 ⇒ 不设闸就变成"任意本地文件读取 + 外传"通道。
  // 三道：① 扩展名白名单 ② 图片按**文件头**验真 ③ 凭证/密钥类**名字与内容**一律不传。
  const SAFE_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
  const SAFE_FILE_EXT = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.mp4', '.opus', '.txt', '.csv', '.md', '.zip'])
  // 只留"本身就极可疑"的写法；松词（key/env/secret/token/cookie… 的单复数）**一律交给
  // SENSITIVE_STEM 精确判定** —— 两套口径并存会造成不对称（审查第七轮：secrets-budget.md 被拦、
  // 单数 secret-budget.md 却放行）。**唯一信源 = SENSITIVE_STEM**。
  const SENSITIVE_PATH_RE = /(^|[\\/_.-])(id_rsa|id_dsa|id_ecdsa|id_ed25519|\.env|apikey|api[_-]?key|keychain|private[_-]?key|\.ssh|\.aws|\.dsh)([\\/_.-]|$)/i
  // 最松的几个词（key/env/pwd…）只在**文件名主干完全等于它**时才算敏感 ——
  // 否则 `key-notes.pdf` / `env-diff.md` 这类正常文件会被误当成凭证（独立审查 LOW#1412）。
  // ⚠️ 单复数都要在（审查 MED#1412：把松词从正则里挪走后，只剩单数会造成
  // `secrets.txt` / `tokens.txt` / `cookies.txt` **两道闸都过**、真的会被上传）。
  const SENSITIVE_STEM = new Set(['key', 'keys', 'env', 'pwd', 'secret', 'secrets', 'token', 'tokens',
    'password', 'passwords', 'passwd', 'credential', 'credentials', 'cookie', 'cookies'])
  function extOf(p) {
    const m = baseNameOf(p).match(/\.[A-Za-z0-9]+$/)
    return m ? m[0].toLowerCase() : ''
  }
  function sniffImage(buf) {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
    if (buf.length >= 6 && buf.slice(0, 6).toString('latin1') === 'GIF87a') return 'gif'
    if (buf.length >= 6 && buf.slice(0, 6).toString('latin1') === 'GIF89a') return 'gif'
    if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF'
      && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp'
    if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'
    return ''
  }
  function looksLikePrivateKey(buf) {
    // 任何 PEM 私钥标签都拦：含 `BEGIN ENCRYPTED PRIVATE KEY`（openssl pkcs8 -topk8 的产物）
    // 与 `BEGIN SSH2 ENCRYPTED PRIVATE KEY`（审查 MED#1431 指出原先只认 RSA/OPENSSH/EC/DSA/PGP）。
    return /BEGIN(?: [A-Z0-9]+)* PRIVATE KEY/.test(buf.slice(0, 4096).toString('latin1'))
  }
  function assertSafeAttachment(filePath, kind) {
    const p = String(filePath || '')
    if (!p) throw new Error('空路径，拒绝上传')
    const stem = baseNameOf(p).replace(/\.[A-Za-z0-9]+$/, '').toLowerCase()
    if (SENSITIVE_STEM.has(stem) || SENSITIVE_PATH_RE.test(p)) {
      throw new Error('疑似凭证/密钥类文件（' + baseNameOf(p) + '），按 A13 规矩不上传')
    }
    // ⚠️ A29 是**图片**规矩（授权二维码不发图、改发链接）；普通文档叫 `login-notes.md` 不该被拒
    //（独立审查 MED#1436：原来对文件也套这条，理由文案还是错的）。
    if (kind === 'image' && looksLikeAuthArtifact(p)) {
      throw new Error('授权类的图（疑似二维码）按规矩不发图，请改发可点击的授权链接')
    }
    const ext = extOf(p)
    const allow = kind === 'image' ? SAFE_IMAGE_EXT : SAFE_FILE_EXT
    if (!allow.has(ext)) {
      throw new Error((kind === 'image' ? '图片' : '文件') + '扩展名不在允许清单内：'
        + (ext || '(无后缀)') + '，只允许 ' + [...allow].join('/'))
    }
    return ext
  }
  // 同一张图重复同步时别再上传一次（省额度、避免限流）：appId|path -> img_key。
  // ⚠️ 必须带 appId：`img_key` 是**按应用**作用域的，A 应用换来的 key 给 B 应用用 ⇒ invalid image keys ⇒ 整卡被拒。
  const localImageKeyCache = new Map()
  const IMAGE_KEY_CACHE_MAX = 200
  // 同一个文件只发一次（建卡/多次同步会反复走到同一段正文）：chatId|path
  const sentLocalFiles = new Set()
  const SENT_FILES_MAX = 500
  function baseNameOf(p) {
    return String(p || '').replace(/^file:\/\//i, '').split(/[\\/]/).filter(Boolean).pop() || ''
  }
  // `file://` 形式在 existsSync/readFileSync 里**永远失败**（独立审查 LOW#1614）⇒ 统一先归一化成真实路径。
  function localPathOf(p) {
    let s = String(p || '')
    if (/^file:\/\//i.test(s)) {
      s = s.replace(/^file:\/\//i, '')
      if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1)     // file:///C:/x ⇒ C:/x
    }
    return s
  }
  function looksLikeAuthArtifact(filePath) {
    // A29 防呆（CM 2026-10-03 明确规矩）：授权类（二维码等）**不自动上传成图片**，
    // 应该发**可点击的授权链接**。这里挡一道，避免"规矩靠自觉"。
    return /(^|[\\/_.-])(qr|qrcode|auth|login|oauth|scan)([\\/_.-]|$)/i.test(String(filePath || ''))
  }
  async function uploadImage(bot, filePath) {
    assertSafeAttachment(filePath, 'image')
    const buf = readFileSync(localPathOf(filePath))
    if (buf.length > IMAGE_MAX_BYTES) {
      throw new Error('图片 ' + (buf.length / 1048576).toFixed(1) + 'MB 超过飞书上限 10MB')
    }
    if (!sniffImage(buf)) {
      throw new Error('按文件头判断不是有效图片，拒绝上传（防"改名成 .png 的其他文件"）')
    }
    const form = new FormData()
    form.append('image_type', 'message')
    form.append('image', new Blob([buf]), baseNameOf(filePath) || 'image.png')
    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + await tenantAccessToken(bot, bot.cfg.appId, bot.cfg.appSecret) },
      body: form,
    })
    const parsed = parseJson(await res.text())
    const key = parsed && parsed.data && parsed.data.image_key
    if (!(res.status >= 200 && res.status < 300) || !key) {
      throw new Error('图片上传失败：status=' + res.status + ' '
        + JSON.stringify(parsed || {}).slice(0, 180))
    }
    console.log('[fs] image uploaded: ' + baseNameOf(filePath) + ' bytes=' + buf.length + ' key=' + key)
    return key
  }
  async function uploadFile(bot, filePath, displayName) {
    const safeExt = assertSafeAttachment(filePath, 'file')
    const buf = readFileSync(localPathOf(filePath))
    if (buf.length > FILE_MAX_BYTES) {
      throw new Error('文件 ' + (buf.length / 1048576).toFixed(1) + 'MB 超过飞书上限 30MB')
    }
    if (looksLikePrivateKey(buf)) {
      throw new Error('内容疑似私钥（BEGIN … PRIVATE KEY），按 A13 规矩不上传')
    }
    // ⚠️ 类型必须跟随**真实文件**的后缀（审查 LOW#1513：agent 写 `[报告.exe](D:\a.pdf)` 时，
    // 用显示名判类型会把 pdf 发成 stream，与真实文件不符）；显示名只影响用户看到的文件名。
    const realName = baseNameOf(filePath) || ('file' + safeExt)
    const rawName = String(displayName || '').trim()
    const name = extOf(rawName) ? rawName : realName
    const ext = safeExt.replace(/^\./, '').toLowerCase()
    const FILE_TYPES = {
      pdf: 'pdf', doc: 'doc', docx: 'doc', xls: 'xls', xlsx: 'xls',
      ppt: 'ppt', pptx: 'ppt', mp4: 'mp4', opus: 'opus',
    }
    const form = new FormData()
    form.append('file_type', FILE_TYPES[ext] || 'stream')
    form.append('file_name', name)
    form.append('file', new Blob([buf]), name)
    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + await tenantAccessToken(bot, bot.cfg.appId, bot.cfg.appSecret) },
      body: form,
    })
    const parsed = parseJson(await res.text())
    const key = parsed && parsed.data && parsed.data.file_key
    if (!(res.status >= 200 && res.status < 300) || !key) {
      throw new Error('文件上传失败：status=' + res.status + ' '
        + JSON.stringify(parsed || {}).slice(0, 180))
    }
    console.log('[fs] file uploaded: ' + name + ' bytes=' + buf.length + ' key=' + key)
    return key
  }
  async function sendFileMessage(bot, chatId, fileKey, note) {
    const target = chatId || bot.lastChatId || ''
    if (!target) return false
    if (note) await sendPlainText(bot, chatId, note).catch(() => { })
    const res = await httpJson(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      'POST',
      { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await tenantAccessToken(bot, bot.cfg.appId, bot.cfg.appSecret) },
      { receive_id: target, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
    )
    const okSent = res.status >= 200 && res.status < 300
    console.log('[fs] file message sent chat=' + target + ' status=' + res.status + ' key=' + fileKey)
    return okSent
  }
  // 把一段文本里的**本地图片引用**换成真 `img_key`；换不掉的换成一句说明（**绝不整段丢**）
  async function inlineLocalImages(bot, text) {
    const src = String(text == null ? '' : text)
    const matches = [...src.matchAll(LOCAL_IMAGE_RE)]
    if (!matches.length) return { text: src, uploaded: 0, reused: 0, failures: [] }
    let out = src
    const failures = []
    let uploaded = 0
    let reused = 0
    const cachePrefix = String((bot && bot.cfg && bot.cfg.appId) || '') + '|'
    for (const m of matches) {
      try {
        // 键里带**内容身份**（大小+修改时间）：同一路径的图被重画后必须重新上传，
        // 否则卡上会一直显示**旧图**（审查 LOW#1564）。
        let cacheKey = cachePrefix + m[2]
        try {
          const st = statSync(m[2])
          cacheKey += '|' + st.size + '|' + Math.round(st.mtimeMs)
        } catch { /* 读不到 stat 就退化成裸路径（照旧缓存） */ }
        let key = localImageKeyCache.get(cacheKey)
        if (key) {
          reused += 1
        } else {
          key = await uploadImage(bot, m[2])
          localImageKeyCache.set(cacheKey, key)
          if (localImageKeyCache.size > IMAGE_KEY_CACHE_MAX) {
            localImageKeyCache.delete(localImageKeyCache.keys().next().value)
          }
          uploaded += 1
        }
        out = out.replace(m[0], '![' + m[1] + '](' + key + ')')
      } catch (error) {
        const why = String(error && error.message || error)
        failures.push(why)
        out = out.replace(m[0], '（图片未发送：' + why + '）')
      }
    }
    return { text: out, uploaded, reused, failures }
  }
  // **通用递归遍历**：对每个含字符串 `content` 的节点调用 `fn`（对象只访问一次，防环）。
  // 为什么必须递归：笔记/字段/工具面板可能被包在 column_set / collapsible_panel / div.fields 里，
  // 浅层遍历会漏（A29 真机事故 + 独立审查 MED#1582 两次栽在同一处）。
  function walkContentHolders(node, fn, seen) {
    if (!node || typeof node !== 'object') return seen
    const memo = seen || new Set()
    if (memo.has(node)) return memo
    memo.add(node)
    if (typeof node.content === 'string') fn(node)
    for (const key of Object.keys(node)) {
      const v = node[key]
      if (Array.isArray(v)) {
        for (const item of v) walkContentHolders(item, fn, memo)
      } else if (v && typeof v === 'object') {
        walkContentHolders(v, fn, memo)
      }
    }
    return memo
  }
  function hasLocalAttachment(text) {
    const s = String(text || '')
    // ⚠️ 带 g 的正则 `.test()` 会**把 lastIndex 推到匹配末尾**，而 `matchAll` 会**继承当前 lastIndex**
    // ⇒ 若不复位，后面 inlineLocalImages 会从中间开始扫、**漏掉前面的图片引用**（原样进卡 ⇒ 整卡被拒）。
    // 独立审查 HIGH：这是一条"平时看不出来、排序一变就炸"的潜伏 bug。
    LOCAL_IMAGE_RE.lastIndex = 0
    const imageHit = LOCAL_IMAGE_RE.test(s)
    LOCAL_IMAGE_RE.lastIndex = 0
    if (imageHit) return true
    LOCAL_FILE_RE.lastIndex = 0
    const fileHit = LOCAL_FILE_RE.test(s)
    LOCAL_FILE_RE.lastIndex = 0
    return fileHit
  }
  // 本地**文件**链接 ⇒ 上传换 `file_key` ⇒ 作为**文件消息**发出（卡面只留一句"已发送"）。
  // 路径不存在 ⇒ **原样不动**（正常超链接 `[文档](/docs/x.md)` 不能被误改成"发送失败"）。
  // 同一 (chat,path) 只发一次：卡会反复同步，否则会重复发同一份文件。
  async function sendLocalFiles(bot, chatId, text) {
    const src = String(text == null ? '' : text)
    LOCAL_FILE_RE.lastIndex = 0
    const matches = [...src.matchAll(LOCAL_FILE_RE)]
    if (!matches.length) return { text: src, sent: 0, failures: [], skipped: 0 }
    let out = src
    const failures = []
    let sent = 0
    let skipped = 0
    for (const m of matches) {
      const target = localPathOf(m[2])
      const label = String(m[1] || '').trim() || baseNameOf(target)
      if (!existsSync(target)) { skipped += 1; continue }
      // ⚠️ 键里要带**文件身份**（大小+修改时间）：否则同一路径的文件**内容更新后**会被永久
      // 当成"已发过"而不再送达（审查 MED#1634）。同一份文件在多次卡同步中仍只发一次。
      // ⚠️ 2026-10-05：键里**还要带 appId** —— 7 个 bot 收进 1 个进程后这条 Set 是实例级的，
      //   同一群里 A、B 两个 bot 发同一个文件时，B 会被判"已发过"而**不发**（多 bot 单实例串扰第二类）。
      let dedupeKey = String((bot && bot.cfg && bot.cfg.appId) || '') + '|' + String(chatId || '') + '|' + target
      try {
        const st = statSync(target)
        dedupeKey += '|' + st.size + '|' + Math.round(st.mtimeMs)
      } catch { /* 读不到 stat 就退化成裸路径 */ }
      if (sentLocalFiles.has(dedupeKey)) {
        out = out.replace(m[0], '（文件已发送：' + label + '）')
        continue
      }
      try {
        const key = await uploadFile(bot, target, label)
        const okSent = await sendFileMessage(bot, chatId, key, '')
        if (!okSent) throw new Error('文件消息发送失败')
        sentLocalFiles.add(dedupeKey)
        if (sentLocalFiles.size > SENT_FILES_MAX) {
          sentLocalFiles.delete(sentLocalFiles.values().next().value)
        }
        out = out.replace(m[0], '（文件已发送：' + label + '）')
        sent += 1
      } catch (error) {
        const why = String(error && error.message || error)
        failures.push(why)
        out = out.replace(m[0], '（文件未发送：' + why + '）')
      }
    }
    return { text: out, sent, failures, skipped }
  }
  async function inlinePayloadImages(bot, payload, chatId) {
    const holders = []
    walkContentHolders(payload, (h) => { if (hasLocalAttachment(h.content)) holders.push(h) })
    const failures = []
    let uploaded = 0
    let reused = 0
    let filesSent = 0
    for (const holder of holders) {
      const res = await inlineLocalImages(bot, holder.content)
      holder.content = res.text
      uploaded += res.uploaded
      reused += res.reused
      failures.push(...res.failures)
      const files = await sendLocalFiles(bot, chatId, holder.content)
      holder.content = files.text
      filesSent += files.sent
      failures.push(...files.failures)
    }
    if (uploaded || reused || filesSent || failures.length) {
      console.log('[fs] inline attachments: images=' + uploaded + ' reused=' + reused
        + ' files=' + filesSent + ' failed=' + failures.length
        + (failures.length ? ' first=' + failures[0].slice(0, 120) : ''))
    }
    return { payload, failures }
  }

  // ---- F · 卡片失败的**统一出口**（2026-10-03，CM：报错必须让用户看见、**Agent 收到**）----
  // 判重：同一会话 + 同一类原因，**2 分钟窗口内只发一次**（复用 CONCLUSION_DEDUPE 的口径）；
  //       "卡坏了" 优先于 "没动静"（stall 那条是独立机制，两者同命中时只发这条）。
  const FAILURE_NOTICE_WINDOW_MS = 120000
  function failureNotices() {
    return globalThis.__fsFailureNotices || (globalThis.__fsFailureNotices = new Map())
  }
  function classifyCardFailure(text) {
    const s = String(text || '')
    // 0.7.9（CM P5，真机实证 web.log 79604）：**11310 必须先判** ——
    //   飞书的 11310 报文外面裹着 `code:230099`（"表格数超上限"是 230099 的一个 ext 分支），
    //   按旧顺序会先命中 ① 的 `230099` ⇒ 归成 `rejected` ⇒ "表格/元素超限"专路
    //   （不再发用户可见的失败提示）**永远不会触发**。冒烟 59 号用例当场钉住过这个误分类。
    if (/11310|table number over limit|tables?\s+over\s+limit/i.test(s)) return 'toolarge'
    // ① 内容类（写了卡片不支持的写法 / 无效 image key）⇒ 才走"摘掉片段抢救正文"那条路
    if (/230099|invalid image|200570|200861/i.test(s)) return 'rejected'
    // ② **体积类**：内容本身没毛病，但"整卡太长/元素太多" ⇒ 纯文本只有 1 个元素、通常发得出去，
    //    所以照样要**抢救正文**（审查 MED#1676：并进限流类会让用户一直看不到东西）。
    // 11310 = card table number over limit（见本文件 ~934 行的真机记录）⇒ 属**数量/体积**类，不是写法错。
    // ⚠️ 不能只写 `exceed`：`timeout exceeded` / `retries exceeded` 都会被误判成体积类
    // 并触发"正文抢救"（审查 LOW#1711）⇒ 必须紧跟 limit 才算体积。
    if (/too large|exceed\w*.{0,20}limit|element.*limit|content.*limit|11310/i.test(s)) return 'toolarge'
    // ③ **限流类**：重发也会被限 ⇒ 走退避/熔断，别谎报"摘掉片段就好了"（审查 MED#1513）
    if (/frequency|rate limit|rate_limit|99991400/i.test(s)) return 'limited'
    return 'transport'
  }
  function payloadPlainText(payload) {
    try {
      const els = (payload && payload.body && payload.body.elements) || []
      const parts = []
      for (const el of els) {
        if (!el) continue
        if (el.tag === 'markdown' && typeof el.content === 'string') parts.push(el.content)
        else if (el.tag === 'div' && el.text && typeof el.text.content === 'string') parts.push(el.text.content)
      }
      return parts.join('\n\n')
    } catch { return '' }
  }
  // 四类失败的文案**集中在这一张表**（审查 MED#1733/#1745：嵌套三元会随类别增多越写越乱，
  // 而且"给用户看的"与"给 Agent 看的"两处必须同步 ⇒ 一张表解决，两处都从这里取）。
  function failureWordings(klass) {
    if (klass === 'rejected') {
      return {
        tip: '已把**发不出去的片段**（如本地图片路径）摘掉后重发，**正文没有丢**。'
          + '要让图片真的显示，需要先上传到飞书换 `image_key`。',
        note: '常见原因：写了**本地图片路径**（飞书只认已上传的 image_key），或用了卡片不支持的写法。'
          + '请改用可发送的形式；**正文已用纯文本兜底发给用户了**，别重复整段。',
      }
    }
    if (klass === 'toolarge') {
      return {
        tip: '卡片太长/元素太多被拒：**已把正文用纯文本重发**（纯文本只有 1 个元素，通常发得出去）。',
        note: '内容是**太长/元素太多**被拒（不是写法错）；正文已用纯文本兜底发给用户，下次拆短一点。',
      }
    }
    if (klass === 'limited') {
      return {
        tip: '被飞书**限流**了（不是内容问题）：已按退避重试若干次，**不会无限重试**，这张卡之后不再更新。',
        note: '偏**限流**（不是内容问题），稍后重发即可，别去改正文。',
      }
    }
    return {
      tip: '网络/传输类失败：已按退避重试若干次，**不会无限重试**，这张卡之后不再更新。',
      note: '偏网络/传输，稍后重发即可。',
    }
  }
  function notifyCardFailure(bot, chatId, info) {
    try {
      const reason = String((info && info.reason) || '卡片发送失败')
      const klass = classifyCardFailure(reason)
      const codeMatch = reason.match(/"code"\s*:\s*(\d+)/) || reason.match(/\bcode[=: ]+(\d+)/i)
      const code = String((info && info.code) || (codeMatch ? codeMatch[1] : ''))
      const key = String(chatId || '-') + '|' + klass
      const seen = failureNotices()
      const nowMs = Date.now()
      // 审查 LOW#1510：这个 Map 从不清理 ⇒ 进程活久了会随会话数无界增长；顺手淘汰过期项。
      for (const [k, t] of seen) {
        if (nowMs - Number(t || 0) > FAILURE_NOTICE_WINDOW_MS) seen.delete(k)
      }
      if (nowMs - Number(seen.get(key) || 0) < FAILURE_NOTICE_WINDOW_MS) return
      seen.set(key, Date.now())
      const words = failureWordings(klass)
      // 0.7.9（CM 2026-10-03 P5）：**toolarge（11310 表格/元素超限）不再发用户可见的失败提示** ——
      //   正文已经在 syncCard 的 rescue 路径里用纯文本送达（那条是必要的），再叠一条"卡片发送失败"
      //   就变成"通知 + 抢救 + 换卡"三连 ⇒ 用户看到的就是"卡片乱发"（BA 回合实证 web.log 79605-79619）。
      //   Agent 侧的系统回执（下面 note）保留 —— 它不占用户版面，但能让模型知道输出没送达。
      if (klass === 'toolarge') {
        console.log('[fs] card failure notice skipped (toolarge, body already rescued) chat=' + chatId)
        void rotateLiveCardForChat(chatId, SIDE_NOTICE_OLD)
      } else {
        const tip = '⚠️ **卡片发送失败**（' + klass + '）' + (code ? '｜飞书 code=' + code : '') + '\n'
          + '原因：' + reason.slice(0, 220) + '\n'
          + words.tip
        // P2（审查 MED#1841）：同样**等提示发出去之后**再换卡（顺序不保证 = 新卡落到提示上方）
        void sendPlainText(bot, chatId, tip)
          .catch(() => {})
          .then(() => rotateLiveCardForChat(chatId, SIDE_NOTICE_OLD))
        // 0.7.9 P5d：这条日志**只在真的发了提示时**打印 —— 否则日志与事实相反
        //（跳过分支持续打印 sent，会让日后审计误判"提示已发"，也让"留痕可判定"失效）。
        console.log('[fs] card failure notice sent chat=' + chatId + ' kind=' + klass
          + (code ? ' code=' + code : ''))
      }
      // ② 让 **Agent 也收到**（复用入站通道注入系统提示；下一次推理必然看到）
      const note = '（系统提示：你上一步的**输出没有送达用户** —— 卡片被飞书拒了（' + klass
        + (code ? '，code ' + code : '') + '）。'
        + words.note + '）'
      void handleInbound(bot, {
        message_id: 'cardfail-' + Date.now().toString(36),
        message_type: 'text',
        chat_id: chatId,
        _internal: true,   // 审查 LOW#1555：内部系统提示**不是**用户在回答提问卡
        content: JSON.stringify({ text: note }),
      }).catch(() => {})
    } catch (error) {
      console.log('[fs] card failure notice failed: ' + String(error && error.message || error))
    }
  }

  // ---- P1-5 · 发卡前的"清洗"（2026-10-03）--------------------------------------
  // 位置：**接在既有降级链之后**（表格降级 `demoteOverflowTables` → 长文切块 `chunkText` → 这里），
  //       不新开一条链 —— 否则两套降级逻辑会互相打架（查重结论）。
  // 范围：**只治已知会让飞书整卡被拒 / 把标签原文漏给用户的写法**，不做通用重写
  //（避免"清洗过头"把正常内容吃掉；真出问题还能靠 F 的失败出口兜住）。
  function sanitizeMarkdownForFeishu(text) {
    let out = String(text == null ? '' : text)
    // ① 跨标签嵌套（真机踩过：`<font color='white'>**批准</font>**` ⇒ 标签原文漏给用户）
    //    ⇒ 规范成已知好形态：**加粗在外、颜色在内**
    out = out.replace(/<font([^>]*)>\s*(\*\*|__)([\s\S]*?)\2\s*<\/font>/gi, '$2<font$1>$3</font>$2')
    // ② 卡片 markdown **不支持**的 HTML 标签（与 stripUnsendable 共用同一张黑名单）
    out = out.replace(UNSUPPORTED_HTML_TAG_RE, '')
    return out
  }
  function sanitizeCardElements(elements, bot, chatId) {
    let touched = 0
    // **递归**（复用 walkContentHolders）：旧实现只看顶层 + el.text/el.fields，
    // 而 agent 正文常常在 collapsible_panel / column_set 里 ⇒ 恰好漏掉要治的内容，
    // 非法标签照样进飞书、照样**整张卡被拒**（独立审查 MED#1582）。
    for (const el of elements || []) {
      if (!el || typeof el !== 'object') continue
      walkContentHolders(el, (h) => {
        let after = sanitizeMarkdownForFeishu(h.content)
        // P1-3（0.8.0 互认）：流式卡也走出站 @（收口点与清洗同一处）。
        // 展开是**幂等纯函数**、不回写 card.blocks ⇒ 每帧重组装不会累积（用例 76 水位口径不动）。
        if (bot && after.indexOf('@') >= 0) after = expandAtTokens(bot, chatId, after)
        if (after !== h.content) { h.content = after; touched += 1 }
      })
    }
    if (touched) console.log('[fs] sanitized for feishu: ' + touched + ' field(s)')
    return elements
  }

  // Serialized, rate-limited, backoff'd, breakered card sync.
  // 0.7.17（两模式）：mode 判定 —— **群一律 stable**（2030：共享的屏不按人变）；
  // 私聊按 bot 配置（cfg.mode **热读 ≤500ms** —— ensureHelpers 每个 DRAIN_INTERVAL tick 都
  // 无条件 `bot.cfg = cfg`，CONFIG_REFRESH_MS=10s 只 gate helper 拉起；缺省 full ＝ 与 0.7.16 逐字一致）。
  // 一期按 bot；NODE1 身份表就绪后升二期按人（open_id → 人，跨 bot 统一）。
  function resolveCardMode(bot, chatId) {
    const kinds = bot && bot.chatKinds
    if (kinds && kinds.get(chatId) === 'group') return 'stable'
    const m = bot && bot.cfg ? String(bot.cfg.mode || '').toLowerCase() : ''
    return m === 'stable' ? 'stable' : 'full'
  }
  // 0.7.22（独立审查 HIGH 根因）：**退避到点后必须有人再推**。
  //   旧实现把 `retryUntil` 记在卡上就没有下文了 —— 于是"失败一次 → 进入退避 → 之后所有推送
  //   （含封口／降级这类 force 推送，见上面 retryUntil 入口闸）全被静默吞掉"⇒ 这一轮的最终内容
  //   永远停在内存里，用户那边就是"卡片不动了"（用例 82 复现的正是这条路径）。
  //   只挂本代的定时器：dispose 时全部清掉 —— 新实例靠托孤队列自己续推，两边都推会发两次。
  //   不挂的三种情况：① 没有 token（建卡失败；重复建卡会留孤儿卡，兜底另有纯文本路径）；
  //   ② circuitOpen（熔断的语义就是"别再推了"，且失败说明已发给用户）；
  //   ③ rescued（整卡正文已用纯文本救回，再推同一份被拒载荷＝同样内容发两次）。
  const cardRetryTimers = new Map()   // message_id -> 退避到点自重推的定时器
  function scheduleCardRetry(bot, chatId, card) {
    if (!card || !card.token || card.circuitOpen || card.rescued || generationDisposed) return
    if (!(Number(card.retryUntil || 0) > 0)) return
    const key = String(card.token)
    const prev = cardRetryTimers.get(key)
    if (prev) clearTimeout(prev)
    const delay = Math.max(0, Number(card.retryUntil || 0) - Date.now())
    cardRetryTimers.set(key, setTimeout(() => {
      cardRetryTimers.delete(key)
      // 期间只要有推送成功，syncCard 就把 retryUntil 归零 ⇒ 这张卡已经健康，不必再补推。
      if (!(Number(card.retryUntil || 0) > 0) || card.circuitOpen || card.rescued || generationDisposed) return
      console.log('[fs] retrying deferred card sync chat=' + chatId + ' card=' + key.slice(-8))
      void syncCard(bot, chatId, card, true).catch(() => { })
    }, delay + 50))
  }

  function syncCard(bot, chatId, card, force) {
    // 0.7.14（TASK v3 §4 / H3）：**本代已 dispose ⇒ 本代（旧实例）不许再推任何卡**。
    // 0.7.16（审查 MED#2）：判据改**代际旗** —— 按对象登记拦不住 dispose 后本代新建的卡；
    //   旗拦本代一切推送，新代 apply 是新闭包、旗=false ⇒ 接管/续卡照常。留痕不抛错。
    if (card && generationDisposed) {
      console.log('[fs] card sync skipped: generation disposed (interrupted card left for new instance)')
      // 0.7.21（HIGH-2）：**拦下不等于丢掉**。这一轮的收尾只剩这一次推送没发出去，
      // 把它托付给活着的实例补发，否则这张卡就永远停在收尾前的样子（CM 报的"重载后卡片不更新"）。
      relayCardPush(card, chatId, bot)
      return card.queue
    }
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
    // 0.7.17（两模式）：每次推送前重解析一次（cfg 热读 ⇒ 改模式 10 秒内对新推送生效）。
    card.mode = resolveCardMode(bot, chatId)
    const now = Date.now()
    // 0.7.21（独立审查 MEDIUM）：`force`（封口/换卡/补发这类"最后一次机会"的推送）过去会被
    //   退避窗口**静默吞掉** —— 一旦这张卡刚失败过，收尾就再也不有人推（真孤儿卡）。
    //   不改退避策略（那是防刷屏的），但必须留痕，否则排查时看不出"为什么没推"。
    if (now < card.retryUntil) {
      if (force) {
        console.log('[fs] forced card sync deferred by retryUntil (in '
          + (card.retryUntil - now) + 'ms): card=' + String(card.token || '-').slice(-8))
      }
      return card.queue
    }
    if (card.token && !force && now - card.lastSyncAt < CARD_MIN_INTERVAL) return card.queue
    card.queue = card.queue.catch(() => {}).then(async () => {
      // 队列**内部**再检查一次：syncCard 会被多处几乎同时调用（建卡时 force、watcher、
      // seal），它们在入口检查时 createFailed 还是 false → 都排进队列 → 串行执行时各自 create。
      // 队列内检查才能保证"建卡只成功/尝试一次"（2026-09-15 smoke 实测：入口检查漏掉 3 次 create）。
      if (!card.token && card.createFailed) return
      // 0.7.16（审查 LOW）：入口检查在 dispose **之前**通过、任务体在 dispose **之后**才执行的窗口 ——
      // 队列内复检代际旗（与上面 createFailed 的队列内复检同一先例），否则已入队的 PATCH 仍会推出去。
      if (generationDisposed) {
        console.log('[fs] card sync skipped inside queue: generation disposed')
        relayCardPush(card, chatId, bot)   // 同上：入队后才轮到执行才被拦 ⇒ 一样要托孤
        return
      }
      // 0.7.21（MEDIUM）：先记下"这次载荷覆盖到哪条内容"—— 成功后把它写成水位（见下面 lastPushedAt）。
      const deliveredWatermark = Number(card.lastScannedAt || 0)
      const payload = buildCardPayload(card, bot, chatId)
      // G：把 markdown 里的**本地图片引用**换成真 `img_key`（飞书只认 key，本地路径会**整卡被拒**）
      try {
        await inlinePayloadImages(bot, payload, chatId)
      } catch (error) {
        console.log('[fs] inline images failed: ' + String(error && error.message || error))
      }
      // F：留一份"纯文本版"，卡片被拒时用它抢救正文（sendPlainText 内部还会再剥一次非法片段）
      const rescueText = payloadPlainText(payload)
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
        // 0.7.20：这次推送**成功落达** ⇒ 记录"内容已推到哪儿"。
        // 0.7.21（独立审查 MEDIUM）：这里记的**不是时刻而是水位** —— 取"载荷组装那一刻"的
        //   lastScannedAt。原先两处都取 `Date.now()`，于是「推送进行中（T0 起）→ 期间扫进新内容
        //   （T1）→ 推送在 T2>T1 才成功」会把 T1 的内容一起算成"已送达"，而那次载荷里根本没有它
        //   ⇒ 热重载接管时判定 unpushed=false，欠的那一次就永远不补了。
        card.lastPushedAt = deliveredWatermark
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
        const message = String(error && error.message || error)
        // 0.7.22（清单#2）：**自我拦截不计入熔断** —— 请求在飞期间本代被 dispose（热重载），
        //   连接是自家撤的，不是链路坏。旧实现照样 `failCount += 1`，几次连续热重载就把这张
        //   会被后续自动轮复用的卡打进 circuitOpen ⇒ 连累后面好几轮都开不出结论卡（真机日志实证）。
        //   现在：不计数、不置 createFailed，直接把这一次推送托付给活着的实例。
        if (generationDisposed) {
          console.log('[fs] card failure ignored (generation disposed mid-flight), handing to next generation: ' + message)
          relayCardPush(card, chatId, bot)
          return
        }
        card.failCount += 1
        const klass = classifyCardFailure(message)
        if (!wasPatch) card.createFailed = true   // 建卡失败 → 放弃该卡，交给兜底纯文本
        const delay = CARD_RETRY_BASE * 2 ** (card.failCount - 1)
        if (card.failCount >= CARD_MAX_FAILURES) {
          card.circuitOpen = true
          console.log('[fs] card circuit opened chat=' + chatId + ': ' + message)
        } else {
          card.retryUntil = Date.now() + delay
          console.log('[fs] card sync failed chat=' + chatId + ' fail=' + card.failCount
            + ' retry=' + delay + 'ms: ' + message)
        }
        // ---- F（2026-10-03）：失败**不再静默** --------------------------------------
        // ① 内容被拒（230099 类）：**先把正文救回来** —— 摘掉发不出去的片段后重发纯文本。
        //    这一步是"用户那边突然什么都不动了"的直接解药（旧实现让兜底也带着非法片段再挂一次）。
        if ((klass === 'rejected' || klass === 'toolarge') && rescueText && !card.rescued) {
          card.rescued = true
          void sendPlainText(bot, chatId, rescueText)
            .then(() => { console.log('[fs] card body rescued chat=' + chatId) })
            .catch(() => { })
        }
        // 0.7.22（独立审查 HIGH 根因）：退避不是"记在卡上"就完了 —— 挂一个到点自推的定时器，
        //   否则这张卡此后每一次推送（含封口/降级）都会被 retryUntil 入口闸吞掉，内容静默丢失。
        //   放在 rescue 之后：已用纯文本救回正文的（rescued 本次置位）不再补推，免得发两次。
        scheduleCardRetry(bot, chatId, card)
        // ② 统一出口：用户看得见的说明 + **Agent 收得到的回执**（判重窗口内只发一次）。
        if (klass === 'rejected' || klass === 'toolarge' || card.failCount >= CARD_MAX_FAILURES) {
          notifyCardFailure(bot, chatId, { reason: message })
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
  function scanCard(agent, card, eventsArg) {
    // eventsArg：watcher 每轮已经取过快照就直接复用（审查 LOW#2110：热路径不要取两次）
    const events = eventsArg || sessionEvents(agent.session)
    const from = Number.isFinite(card.cursor) ? card.cursor : 0
    let changed = false
    for (let i = from; i < events.length; i++) {
      const event = events[i]
      if (!event || !event.data) continue
      if (event.type === 'plan/mode') {
        // H：计划模式开关落成会话事件 ⇒ 状态栏据此显示「📋 计划模式」（不猜、不额外请求）
        const want = Boolean(event.data && event.data.active)
        if (card.planActive !== want) { card.planActive = want; changed = true }
      } else if (event.type === 'assistant/message') {
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
          // 看门狗判据：有工具在跑 ⇒ 静默属于"正常等工具"，不是"上游没回包"
          card.pendingTools = Number(card.pendingTools || 0) + 1
          card.idleKind = ''
          appendTool(card, id)
          changed = true
        }
      } else if (event.type === 'tool/result' && event.data.message) {
        const id = event.data.message.source && event.data.message.source.callId
        if (id) {
          const tool = card.tools.get(String(id))
          if (tool) {
            if (tool.status === 'running') card.pendingTools = Math.max(0, Number(card.pendingTools || 0) - 1)
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
    // 0.7.20：内容**进卡**的时刻（与"推出去"的时刻配对，见 lastPushedAt）。
    //   热重载接管时要靠这两个时刻判断"上一代攒在内存里的内容推没推出去"——
    //   不看这个的话，要么漏推（CM 报的"重载后卡片不更新"），要么每次重载无脑重推（=重复）。
    if (changed) card.lastScannedAt = Date.now()
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

  // 0.7.20：**回合是否真的还活着** —— 读 dsh agent 自己的状态（`get status` ⇒ 'idle' | 'running'，
  //   见 dsh-agent-loop/lib/index.js:790）。这是**唯一与插件代际无关**的存活判据：
  //   热重载后旧实例的 `await whenIdle()` 链条还在，但它的封口推送被代际旗拦掉，
  //   卡面就永远停在 running —— 只看卡/只看表都会误判，只有问 agent 本身才准。
  //   读不到（对象没这个 getter）时**按活着处理**：宁可少封一张卡，也不许把还在跑的一轮误封成结束。
  function agentIsRunning(agent) {
    try {
      const st = agent && agent.status
      if (st === 'idle') return false
      if (st === 'running') return true
      return true
    } catch { return true }
  }

  // 0.7.20：找"这个会话当前那张还在跑的卡"（本代 watcher ∪ 跨代 registry 都查）。
  //   为什么两张都查：热重载"续卡"发生在 apply 顶层（比播报早），接管成功的话卡就在本代 Set 里；
  //   接管不了（上一代的东西本代看不到）时只能靠 registry —— 只查一张必然漏。
  function liveCardForChat(chatId) {
    const hit = (e) => (e && e.card && e.card.status === 'running'
      && String(e.chatId || '') === String(chatId || '') ? e : null)
    for (const e of liveCardWatchers) { const found = hit(e); if (found) return found }
    for (const e of liveCardRegistry.values()) { const found = hit(e); if (found) return found }
    return null
  }

  // 0.7.8：本卡还是不是"这张会话当前最新的在跑卡"。
  //   判据：同会话里存在**序号更大（＝更晚创建）且仍 running** 的卡 ⇒ 本卡已被顶掉（僵尸卡）。
  //   为什么需要它：热重载"续卡"会接管上一代的卡；若那张卡早已不是会话当前的卡，它就再也扫不到
  //   新事件、却仍按"当前这一轮"的口吻播报（协作信箱报障的"上游 35 分钟没回包"误报源）。
  function isLiveCardForChat(chatId, card) {
    if (!card) return false
    const seen = new Set()
    const stale = (entry) => {
      const oc = entry && entry.card
      if (!oc || oc === card || seen.has(oc)) return false
      seen.add(oc)
      return String(entry.chatId || '') === String(chatId || '')
        && oc.status === 'running'
        && Number(oc.bornSeq || 0) > Number(card.bornSeq || 0)
    }
    for (const entry of liveCardWatchers) { if (stale(entry)) return false }
    for (const entry of liveCardRegistry.values()) { if (stale(entry)) return false }
    return true
  }
  // 0.7.20（CM 批准的方案第 3 点）：给"回合已经不在了、卡却还挂在 running"的孤儿卡**补封口**。
  //   成因（有出处）：上一代 runTurn 收尾时先 `activeTurns.delete()`、再发最后一次 PATCH，
  //   而那一次 PATCH 被 `generationDisposed` 拦掉（见 syncCard 入口）⇒ 卡面永远停在「正在工作中…」，
  //   并且它的定时器还会按 10 分钟一条无限播"上游没回包"（CM 报障的 365→405 分钟）。
  //   文案只写**当场能证实**的事：① 由本实例补的封口（=收尾推送丢了）② 卡上内容就是全部进度
  //   ③ 请求没丢。不写"其实已经跑完"这种无法证实的断言。
  function sealFinishedAfterReload(agent, card, bot, chatId, why) {
    console.log('[fs] orphan card sealed after reload: chat=' + chatId
      + ' card=' + String((card.token || '-')).slice(-8) + ' why=' + why)
    card.sealing = true
    // 补扫一次：把断流期间落在会话里、还没镜像上卡的内容收进来（不补扫 = 白丢尾段）
    try { scanCard(agent, card) } catch (error) {
      console.log('[fs] orphan seal catch-up scan failed: ' + String(error && error.message || error))
    }
    card.status = 'sealed'
    card.idleMinutes = 0
    card.idleKind = ''
    dropWorkingPlaceholder(card)
    card.blocks.push({
      type: 'message',
      text: '♻️ 插件热重载：这一轮此刻已经不在跑了，卡面却还停在「正在工作中…'
        + '」（收尾那次卡片更新丢了，**由本实例补的封口**）。'
        + '卡上的内容就是它跑到哪儿的全部内容；你的请求没有丢，要继续请再发一句。',
    })
    try { void syncCard(bot, chatId, card, true).catch(() => { }) } catch { }
  }

  // 自动轮（目标轮／回执轮）的收口：补扫 → 把最后一段过程话语提升为正文 → 判定成功/失败 → 封口推送。
  // 0.7.21（独立审查 MEDIUM）：从 `agent/status` 的 idle 分支**抽成函数**，因为热重载接管来的
  //   自动卡也要收口（补封口那条），旧实现只会走普通回合的 `sealFinishedAfterReload`
  //   ⇒ 目标卡上写「这一轮收尾被吞了」，而真实原因是「这一轮跑完了／失败了」——文案说假原因。
  // `openedAt` 必须是**这一轮开始时**的事件游标（不是卡面游标），否则"最后一段话/失败标记"
  //   会摘到上一轮的内容。
  function closeAutoRoundCard(agent, card, bot, chatId, openedAt, kind, why, byReload) {
    if (!card) return
    card.sealing = true
    // 封口前**必须补扫**（与普通回合 runTurn 的 catch-up scan 同源）：
    // 目标轮的收尾话语（"进度（第 N 轮）…"）几乎与轮结束同时到达，
    // watcher 一拍（300ms）常常来不及镜像 → 不补扫就会只剩工具记录、
    // 一句话都没有（CM 2026-09-16 反馈，取证：会话里 seq 有整段文字，卡上 notes=0）。
    try { scanCard(agent, card) } catch (error) {
      console.log('[fs] goal catch-up scan failed: ' + String(error && error.message || error))
    }
    // 把本轮最后一段话提升为**正式消息块**：过程话语有 500 字截断，
    // 轮次的进度汇报通常远超这个长度，截断后 CM 看不到实质内容。
    const closing = lastAssistantTextSince(agent, openedAt || 0)
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
    const failure = turnFailureReason(sessionEvents(agent.session), openedAt || 0)
    if (failure && !closing.text) {
      card.blocks.push({ type: 'message', text: '⚠️ 本轮没有产生回复：' + failure.text })
    } else if (!closing.text && card.tools.size === 0) {
      // 与普通回合同源（2026-09-21）：没有产出、也没有失败标记时，**不许**写「✅ 本轮结束」装成功。
      card.blocks.push({ type: 'message', text: '⚠️ 本轮没有产生回复：上游没有给出失败标记（原因未上报 —— 见 dsh 日志／GUI）' })
    }
    const silent = !closing.text && card.tools.size === 0
    card.status = (failure || silent) ? 'error' : 'sealed'
    card.blocks.push({ type: 'message', text: (failure || silent) ? '❌ 本轮失败' : '✅ 本轮结束' })
    if (byReload) {
      // 诚实标注（A24：不许把"我们这边收尾丢了"说成"上游没回包"，也不许假装是正常收尾）
      card.blocks.push({ type: 'message',
        text: '♻️ 插件热重载：这一轮**内容已经跑完**，只是收尾那次卡片更新丢了 ⇒ 由本实例补的封口。' })
    }
    console.log('[fs] auto card sealed: agent=' + String(agent && agent.id) + ' kind=' + (kind || 'goal')
      + ' failure=' + (failure ? failure.text : 'none') + ' silent=' + silent
      + (why ? ' why=' + why : '')
      + ' closing_hash=' + shortHash(String(closing.text || '')) + ' closing_len=' + String(closing.text || '').length
      + ' card=' + (card.token || '-') + ' blocks=' + card.blocks.length)
    try { void syncCard(bot, chatId, card, true).catch(() => { }) } catch { }
  }

  function startCardWatcher(agent, card, bot, chatId, onTableBudget) {
    const entry = { agent, card, bot, chatId, stop: null }
    const sealAsFinished = (why) => {
      // 0.7.21（MEDIUM）：接管来的**自动轮**卡（目标轮／回执轮）收口要走自动轮那套
      //   （补扫→提升正文→失败归因→✅/❌），旧实现一律用普通回合的补封口文案 ⇒
      //   目标卡上写的是"收尾被吞了"，而不是"这一轮跑完了/失败了"，说的不是人话。
      const re = liveCardRegistry.get(String(agent && agent.id))
      if (re && re.card === card && re.autoKind) {
        closeAutoRoundCard(agent, card, bot, chatId, Number(re.autoOpenedAt || 0), re.autoKind, why, true)
      } else {
        sealFinishedAfterReload(agent, card, bot, chatId, why)
      }
      try { stop() } catch { }
    }
    const timer = setInterval(() => {
      if (card.sealing) return
      try {
        // 表格额度换卡（CM 2026-09-16 方案）：飞书单卡硬上限 5 张表（ErrCode 11310）。
        // 本卡已用满且**还有新事件待镜像**时，先换一张新卡 —— 旧卡的表格原样留在旧卡，
        // 新事件由新卡接续（新卡游标 = 旧卡游标，不丢不重）。这样永远不降级表格。
        // 审查 LOW#2110：这段现在**每次 300ms 轮询**都会走到 ⇒ 快照只取一次（下面 scanCard 复用），
        // 且小卡不做 JSON.stringify（体积检查先按块数粗筛）。
        const pendingNow = sessionEvents(agent.session)
        if (typeof onTableBudget === 'function') {
          const pending = pendingNow
          const from = Number.isFinite(card.cursor) ? card.cursor : 0
          if (pending.length > from) {
            // ① 表格额度（飞书单卡硬上限 5 张表，ErrCode 11310）
            if (cardTableCount(card) >= CARD_MAX_TABLES) { onTableBudget('tables'); return }
            // ② 元素/体积额度（实测：200 元素、载荷 ~198.5 KB 通过）⇒ **换卡续写**：
            //    旧卡正文原样保留＋一行说明，新卡从旧卡游标接续（不重放、不丢、不重）。
            //    这样"过程文字默认可见"与"绝不撞上限"同时成立（CM 2026-10-03 口径）。
            if (card.blocks.length > CARD_ROTATE_BLOCKS
              || (card.blocks.length > CARD_ROTATE_MIN_BLOCKS_FOR_BYTE_CHECK
                && blocksBytes(card.blocks) > CARD_ROTATE_BYTES)) {
              onTableBudget('size'); return
            }
          }
        }
        if (scanCard(agent, card, pendingNow)) {
          card.lastEventAt = Date.now()
          card.idleMinutes = 0
          card.idleKind = ''
          card.stallNotifiedAt = 0
          card.idleSince = 0
          void syncCard(bot, chatId, card, false).catch(() => {})
        } else if (card.status === 'running' && card.lastEventAt) {
          // 诚实状态（2026-10-03 改：**有诊断含义**，不再让人误以为"它在忙"）：
          //   · 有工具在跑 ⇒ 说清是哪个工具、并注明"正常"；
          //   · 没有任何动作 ⇒ 说清是**上游没回包**（模型侧卡住/网络慢），且 ≥5 分钟**另发纯文本**。
          const mins = Math.floor((Date.now() - card.lastEventAt) / 60000)
          const pendingTools = Number(card.pendingTools || 0)
          const kind = pendingTools > 0 ? 'tools' : 'silent'
          if (kind === 'tools') {
            const running = [...card.tools.values()].filter((t) => t && t.status === 'running')
            card.idleToolName = running.length ? String(running[running.length - 1].name || '') : ''
          }
          // 0.7.20（CM 报障「卡住就一直刷：365/375/385/395/405 分钟」）：先分清
          //   「**上游真没回包**」和「**这一轮早就跑完了，只是收尾被热重载吞掉**」——
          //   旧实现只看卡片自己，永远分不出来，于是孤儿卡按 10 分钟一条无限播（真机 mins 一路涨到 405）。
          //   判据用 dsh 自己的 `agent.status` + 回合拥有者（两张表都跨代共享），不靠时间猜。
          const ownerAlive = activeTurns.has(String(agent && agent.id))
            || autoCards.has(String(agent && agent.id))
          // 「回合记录还挂着」不能用来给卡面那句话作保 —— 只有 agent **本人**报 running，
          //   「上游没有回包」才是真话（ownerAlive 只说明我们这边还没收尾）。
          const turnAlive = agentIsRunning(agent)
          if (!agentIsRunning(agent) && !ownerAlive) {
            if (!card.idleSince) card.idleSince = Date.now()
            if (Date.now() - card.idleSince >= CARD_ORPHAN_SEAL_MS) {
              sealAsFinished('turn finished but seal lost with the old generation')
              return
            }
          } else {
            card.idleSince = 0
          }
          // 卡面那句「上游已 N 分钟没有回包」**只在回合还活着时写**（0.7.20）：
          //   agent 已 idle、回合却还挂着 ⇒ "没有回包"是假话（它根本不在等回包），
          //   宁可这一格留空，也不能让卡面挂着一句诊断不了的话（E6：提示必须有诊断含义）。
          const next = (mins >= DSH_IDLE_NOTICE_MIN && turnAlive) ? mins : 0
          // ⚠️ 只在"分钟数变化"时同步 —— 别因为 kind 变了就多同步一次：
          //    冒烟里「同一回执不重复播报」那条断言把**卡片 PATCH 更新**也算进长度，
          //    多一次无谓更新就会把它判红（这是真代价，不是测试洁癖）。
          if (next !== card.idleMinutes) {
            card.idleMinutes = next
            card.idleKind = next > 0 ? kind : ''
            void syncCard(bot, chatId, card, false).catch(() => {})
          }
          // 长静默 ⇒ **发一条新消息**（只改卡面他收不到通知）：
          //   · kind='tools'（有工具在跑）阈值 3 分钟 —— 说清"这是正常的，不是卡住"
          //   · kind='silent'（上游没回包）阈值 5 分钟 —— 说清"回我一句就会重新发起"
          const threshold = kind === 'tools' ? DSH_TOOL_NOTICE_MIN : DSH_STALL_NOTICE_MIN
          if (mins >= threshold
            && Date.now() - Number(card.stallNotifiedAt || 0) >= DSH_NOTICE_REPEAT_MS) {
            // 0.7.8 活跃性闸门（协作信箱任务：CM-OFFICE 报的"上游 35 分钟没回包"误报）：
            //   本卡**已不是**该会话当前最新的在跑卡 ⇒ 它是僵尸卡：它扫不到新事件 ⇒ 静默分钟数只涨不落
            //   ⇒ 会一直误报（真机证据：同一 chat 连续 kind=tools mins=3，而同时刻别的卡游标在推进）。
            //   处理：不播报 + 就地收口 + 停掉自己的定时器（留痕，不静默）。
            if (!isLiveCardForChat(chatId, card)) {
              console.log('[fs] stall notice suppressed: stale card chat=' + chatId
                + ' card=' + String((card.token || '-')).slice(-8) + ' kind=' + kind + ' mins=' + mins)
              card.status = 'sealed'
              dropWorkingPlaceholder(card)
              try { void syncCard(bot, chatId, card, true).catch(() => { }) } catch { }
              try { stop() } catch { }
              return
            }
            // 0.7.20 闸门②：**agent 已经不是 running** ⇒ 这句"上游没回包"就是假话
            //   （典型来源：上一代遗留的卡，它那一轮已经结束了）。不播，等上面的补封口处理。
            if (!agentIsRunning(agent)) {
              console.log('[fs] stall notice suppressed: agent idle (turn already over) chat=' + chatId
                + ' card=' + String((card.token || '-')).slice(-8) + ' kind=' + kind + ' mins=' + mins)
              card.stallNotifiedAt = Date.now()
              return
            }
            // 0.7.20 闸门③：**同一轮最多播 DSH_STALL_NOTICE_MAX 次**（计数跨换卡继承），之后只留灰字状态，
            //   不再往会话里发消息（真卡住也不需要刷屏；CM 该做的动作第一条提示里已经写了）。
            if (Number(card.stallNoticeCount || 0) >= DSH_STALL_NOTICE_MAX) {
              console.log('[fs] stall notice suppressed: reached cap chat=' + chatId
                + ' card=' + String((card.token || '-')).slice(-8) + ' kind=' + kind
                + ' mins=' + mins + ' count=' + card.stallNoticeCount)
              card.stallNotifiedAt = Date.now()
              return
            }
            card.stallNotifiedAt = Date.now()
            const running = [...card.tools.values()].filter((t) => t && t.status === 'running')
            const toolName = card.idleToolName || (running.length ? String(running[running.length - 1].name || '') : '')
            const note = kind === 'tools'
              ? '🔧 我还在跑工具' + (toolName ? ' `' + toolName + '`' : '')
                + '（已 ' + mins + ' 分钟）。这是**正常**的，不是卡住 —— 跑完我会继续往下做。'
              : '⏳ 上游已经 ' + mins + ' 分钟**没有回包**（模型侧卡住／网络慢，不是卡片坏了，'
                + '也不是我在埋头干活）。这一轮还挂着：发 /stop 结束它，或者直接再说一句都行。'
                + '（同一轮最多提醒 ' + DSH_STALL_NOTICE_MAX + ' 次，之后不再刷屏。）'
            // P2（审查 MED#1841）：sendPlainText 是"先取 token/传图再 POST"的异步链，
            // 同步紧跟着换卡的话，两条请求顺序不保证 ⇒ 新卡可能落在提示**上方**（正是要修的症状）。
            // ⇒ 必须 **.then() 链在发送成功之后**再换卡。
            // 0.7.21（独立审查 MEDIUM）：**额度也在发送成功之后才扣** —— 原先发送前就 +1，
            //   一条因网络/风控没发出去的消息照样吃掉一次配额 ⇒ CM 一轮里可能只看到 1 条提示。
            //   发送失败则不扣、也不换卡（换卡的唯一理由就是"提示压在长卡上面"，没发出去就不成立）。
            // 2026-10-05（CM 定的分界：**还能不能继续**）：
            //   kind='tools'（有工具在跑）＝ 还能继续 ⇒ **只写回原卡**，不另发消息
            //     （跑完一定会更新结论/发卡，那就是通知；中途另发只是打扰）。
            //   kind='silent'（上游没回包）＝ **不能继续** ⇒ 保持另发（CM 点名「这种必须提示」）。
            if (kind === 'tools') {
              card.stallNoticeCount = Number(card.stallNoticeCount || 0) + 1
              appendCardNotice(bot, chatId, '🔧 还在跑', note, 'grey-50')
              console.log('[fs] stall notice -> card only (tools running): chat=' + chatId + ' mins=' + mins)
            } else {
              void sendPlainText(bot, chatId, note).then(() => {
                card.stallNoticeCount = Number(card.stallNoticeCount || 0) + 1
                console.log('[fs] stall notice sent: chat=' + chatId + ' kind=' + kind + ' mins=' + mins)
                rotateLiveCardForChat(chatId, SIDE_NOTICE_OLD)
              }, (error) => {
                console.log('[fs] stall notice send failed (额度不扣，等下一个静默窗口重试): '
                  + String(error && error.message || error))
              })
            }
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
    // 0.7.8 不变式（CM 2026-10-03 报障「换了新卡，旧卡也一直在更新」）：
    //   同一个 agent（＝同一条会话）同一时刻**只允许一个 watcher**。旧实现只做
    //   liveCardRegistry.set(agent.id, entry) —— 那是**覆盖登记**，旧 watcher 仍在跑，
    //   两张卡各自扫**同一条**事件流 ⇒ 两张卡同步长。
    //   真机证据（本机 web.log L78520-78548）：0c26bbb3 与 09c6d978 游标同步 5405→5445…。
    //   成因：插话 split 之后**又来一条"不能 steer"的入站**（文件消息正文为空，见 steerActiveTurn
    //   的 !text 早退）⇒ handleInbound 又开了一张卡。这里把旧卡就地收口，保证"一张卡一人一事"。
    //   ⚠️ 候选必须**同时**包含本代 liveCardWatchers 与跨代 liveCardRegistry：
    //     热重载后旧卡的 watcher 可能属于**上一代**（本代 Set 看不到它），只扫 Set 会漏掉
    //     "旧卡继续长"这种跨代情况（2026-10-03 自查发现的盲区）。
    const staleCandidates = []
    const staleSeen = new Set()
    for (const e of liveCardWatchers) {
      if (e && e.card && !staleSeen.has(e.card)) { staleSeen.add(e.card); staleCandidates.push(e) }
    }
    for (const e of liveCardRegistry.values()) {
      if (e && e.card && !staleSeen.has(e.card)) { staleSeen.add(e.card); staleCandidates.push(e) }
    }
    for (const old of staleCandidates) {
      const oldCard = old && old.card
      if (!old || old === entry || oldCard === card) continue
      if (String(old.agent && old.agent.id) !== String(agent && agent.id)) continue
      try { old.stop() } catch { }
      if (oldCard && oldCard.status === 'running') {
        oldCard.sealing = true
        oldCard.status = 'sealed'
        dropWorkingPlaceholder(oldCard)
        oldCard.blocks.push({ type: 'message', text: '✅ 本卡已收口，后续内容见下方新卡。' })
        try { void syncCard(old.bot, old.chatId, oldCard, true).catch(() => { }) } catch { }
      }
      // 0.7.13（TODO-0710 #1）：token 首次 sync 成功才有值 ⇒ 真机打出 old=- new=-（web.log L80023）。
      //   bornSeq 建卡即有、跨代单调 ⇒ 留痕补 born=<旧>/<新>，两者都保留。
      const bornOf = (c) => (c && c.bornSeq !== undefined && c.bornSeq !== null ? String(c.bornSeq) : '-')
      console.log('[fs] stale watcher stopped: agent=' + String(agent && agent.id)
        + ' old=' + String((oldCard && oldCard.token) || '-').slice(-8)
        + ' new=' + String((card && card.token) || '-').slice(-8)
        + ' born=' + bornOf(oldCard) + '/' + bornOf(card))
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
    // 0.7.16（审查 MED#2）：**dispose 一进来就置位**（不依赖是否还有活跃回合）——此后本代一切卡片推送
    // （封口 / 新建的结论卡 / 换卡 / 入队后才执行的任务体）全部拦截；新代闭包旗=false 不受影响。
    generationDisposed = true
    console.log('[fs] dispose(热重载): 本代已标记 disposed（此后本代一切卡片推送被拦截）')
    try {
      const interrupted = []
      for (const [agentId, entry] of Array.from(activeTurns)) {
        if (!entry || !entry.bot || !entry.chatId) continue
        // 0.7.16：按卡登记制已由代际旗取代（见上方 generationDisposed —— 拦本代一切推送）。

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
    // 0.7.22（独立审查 HIGH 根因）：本代挂出的"退避到点自推"定时器一并清掉。
    //   不清的话，旧实例会在自己已经作废之后仍然拿着自己的 bot/token 去推卡 —— 而新实例此刻
    //   正在靠托孤队列续同一张卡 ⇒ 同一内容发两次。卡片本身留给新实例，只撤本代的定时器。
    for (const timer of cardRetryTimers.values()) { try { clearTimeout(timer) } catch { } }
    cardRetryTimers.clear()
  })

  // 0.7.21（MEDIUM）：给**跨代 registry** 的那条登记打上"这是一轮自动轮（目标／回执）"的标记。
  //   为什么打在 registry 条目上而不是卡上：`startCardWatcher` 每建一个 watcher 就换一个新的
  //   entry 对象并覆盖登记 ⇒ 标记必须在每次起 watcher 之后重打（见下面三处调用点）。
  //   热重载接管／补封口时靠它决定"用自动轮那套收口"还是"用普通回合那套"（封口文案要说真实原因）。
  function markAutoRound(agent, kind, openedAt) {
    const re = liveCardRegistry.get(String(agent && agent.id))
    if (!re) return
    re.autoKind = kind || 'goal'
    re.autoOpenedAt = Number(openedAt || 0)
  }

  // 表格额度换卡（续卡通道专用）：旧卡保留表格，新卡接续游标，不丢不重。
  function rotateAdoptedCard(agent, reason, oldText) {
    const key = String(agent && agent.id)
    const entry = liveCardRegistry.get(key)
    if (!entry || !entry.card) return
    const old = entry.card
    const fresh = makeCardState(agent, old)
    fresh.cursor = old.cursor
    fresh.footerMode = 'bare'
    old.sealing = true
    old.status = 'sealed'
    dropWorkingPlaceholder(old)
    // 0.7.9（CM 2026-10-03 ③）：指路语写在**旧卡**（读者就在这张卡上）；新卡干净起步。
    old.blocks.push({
      type: 'message',
      text: oldText || (reason === 'size' ? rotateNoticeSize() : ROTATE_NOTICE_TABLES),
    })
    try { void syncCard(entry.bot, entry.chatId, old, true).catch(() => { }) } catch { }
    // 0.7.10（独立审查 LOW#7044）：**不设** rotatedThisTurn —— 该标志只在 runTurn 收尾时读，
    // 而这条（热重载续卡）路径不经过那个判定 ⇒ 设了也是**死存**，反而让人以为"这里会抑制结论卡"。
    try { void syncCard(entry.bot, entry.chatId, fresh, true).catch(() => { }) } catch { }
    entry.card = fresh
    if (entry.stop) { try { entry.stop() } catch { } }
    const keepKind = entry.autoKind
    const keepOpenedAt = entry.autoOpenedAt
    entry.stop = startCardWatcher(agent, fresh, entry.bot, entry.chatId, (r) => rotateAdoptedCard(agent, r))
    if (keepKind) markAutoRound(agent, keepKind, keepOpenedAt)   // 0.7.21：标记随新登记条目带走
    console.log('[fs] 续卡通道：表格换卡 card=' + String(fresh.token || '-').slice(-8))
  }

  // 封口前把卡上被 `MAX_NOTE_CHARS`(500) 截断的**过程正文**按 seq 从会话事件里还原成完整正文。
  // 由来（CM 2026-10-02）：「我发信息给你，若你刚好在应答的时候，你会直接截断掉需要打印结果
  // 的那些回复的内容，导致我看不到」—— 插话会换卡，旧卡就此封口，而新卡游标从当前位置起
  // 不重放 ⇒ 旧卡上那 500 字就是 CM 能看到的全部。2026-10-04 起两处共用（runTurn 的 split
  // 与接管卡的 splitAdoptedCard），所以抽成函数，不复制第二份逻辑。
  function expandTruncatedNotes(agent, card) {
    try {
      const liveEvents = sessionEvents(agent.session)
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
  }

  // 0.7.21（HIGH-1）：**插话/答题换卡落在"接管来的卡"上**时的本代等价通道。
  //   旧实现只在 activeTurns / autoCards 里找 `split()` —— 热重载之后那两条要么没有条目、
  //   要么条目属于**上一代**（闭包已被代际旗封死，调一次这张卡就再也不更新）。结果是
  //   0.7.x 一直在保护的「插话必须换卡」在重载后**静默失效**。
  //   本函数与 rotateAdoptedCard 同构，差别只有 split 的语义：新卡游标 = **当前事件位**
  //   （旧卡已镜像的内容绝不重放），并且带 notice（旧卡留一行指路、新卡首块放醒目正文）。
  function splitAdoptedCard(agent, notice) {
    const entry = liveCardRegistry.get(String(agent && agent.id))
    if (!entry || !entry.card || entry.card.status !== 'running') return false
    const old = entry.card
    expandTruncatedNotes(agent, old)
    const fresh = makeCardState(agent, old)
    fresh.cursor = sessionEvents(agent.session).length
    fresh.footerMode = 'bare'
    old.sealing = true
    old.status = 'sealed'
    dropWorkingPlaceholder(old)
    old.blocks.push((notice && notice.old)
      || { type: 'message', text: ANSWER_POINTER })
    try { void syncCard(entry.bot, entry.chatId, old, true).catch(() => { }) } catch { }
    if (notice && notice.fresh) fresh.blocks.push(notice.fresh)
    fresh.blocks.push({ type: 'message', text: '继续处理中…' })
    try { void syncCard(entry.bot, entry.chatId, fresh, true).catch(() => { }) } catch { }
    entry.card = fresh
    if (entry.stop) { try { entry.stop() } catch { } }
    const keepKind75 = entry.autoKind
    const keepOpenedAt75 = entry.autoOpenedAt
    entry.stop = startCardWatcher(agent, fresh, entry.bot, entry.chatId, (r) => rotateAdoptedCard(agent, r))
    if (keepKind75) markAutoRound(agent, keepKind75, keepOpenedAt75)   // 0.7.21：标记随新登记条目带走
    console.log('[fs] 续卡通道：插话/答题换卡 card=' + String(fresh.token || '-').slice(-8))
    return true
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
      // 0.7.20（CM 报障「卡住就一直刷」的**源头治理**）：接管前先问 agent 本人。
      //   它已经 idle、且这一轮无人认领（`activeTurns` 跨代共享，此刻旧代的 runTurn 早返回了）
      //   ⇒ 这一轮其实已结束，只是收尾推送被代际旗吞掉，卡面才停在 running。
      //   这种卡**绝不接管**（接管=养出一张扫不到新事件、却按"当前这一轮"口吻无限播的僵尸卡），就地补封口。
      // 🔴 0.7.21（独立审查 MEDIUM）：**不能只看一眼就判死**。目标轮／回执轮之间存在
      //   "agent 已经 idle、下一轮还没起"的**正常间隙**，旧实现零宽限 ⇒ 正好落在这个间隙里的
      //   热重载会把刚建好的目标卡当场封口（CM 看到"目标轮刚开就结束"）。
      //   改法：静默时长还没超过 watcher 自己那套孤儿宽限（CARD_ORPHAN_SEAL_MS，连续两拍确认）
      //   ⇒ 先照常接管，交给 watcher 的补封口去判（机制已存在，不新造第二套）。
      const idleFor = Date.now() - Number(card.lastEventAt || 0)
      if (!agentIsRunning(entry.agent) && !activeTurns.has(key) && !autoCards.has(key)
        && idleFor >= CARD_ORPHAN_SEAL_MS) {
        // 自动轮的卡用它自己的收口（补扫+提升正文+失败归因+✅/❌），封口文案才说得出真实原因
        if (entry.autoKind) {
          closeAutoRoundCard(entry.agent, card, entry.bot, entry.chatId,
            Number(entry.autoOpenedAt || 0), entry.autoKind, 'adopt-skip: auto round over', true)
        } else {
          sealFinishedAfterReload(entry.agent, card, entry.bot, entry.chatId,
            'adopt-skip: agent idle and turn not owned')
        }
        liveCardRegistry.delete(key)
        console.log('[fs] 热重载续卡：补封口（不接管）agent=' + key
          + ' card=' + String(card.token || '-').slice(-8) + ' idleFor=' + idleFor + 'ms')
        continue
      }
      // 0.7.8：接管前先判"它还是不是这张会话当前最新的在跑卡"（协作信箱任务③：从源头不产生僵尸卡）。
      //   不是 ⇒ **封口而不接管**（否则新实例会养出一张永远扫不到新事件、却还按"当前这一轮"口吻播报的卡）。
      if (!isLiveCardForChat(entry.chatId, card)) {
        card.sealing = true
        card.status = 'sealed'
        dropWorkingPlaceholder(card)
        card.blocks.push({ type: 'message', text: '♻️ 插件热重载：本卡已不是当前这张，停止更新（后续内容见下方卡片）。' })
        try { void syncCard(entry.bot, entry.chatId, card, true).catch(() => { }) } catch { }
        // 0.7.21（独立审查 LOW）：封口了就必须把登记一起摘掉 —— 旧实现漏了这行，
        //   于是这张**已封口**的卡继续留在跨代 registry 里，下一轮重载的"接管／补封口"
        //   分支还会再看到它（并可能据此判断"上一轮还活着"）。
        liveCardRegistry.delete(key)
        console.log('[fs] 热重载续卡：跳过（已不是当前卡）agent=' + key
          + ' card=' + String(card.token || '-').slice(-8))
        continue
      }
      card.bornSeq = nextCardStamp()   // 接管 ⇒ 它现在才是"当前卡"（跨代序号必须重打，见 isLiveCardForChat）
      // 0.7.20（CM 批准的方案第 2 点）：接管**立刻**补扫 + 强推一次。
      //   旧实现只起定时器 ⇒ 上一代攒在 card.blocks 里、PATCH 被拦的那些内容，要等下一次
      //   有新事件才会被推出去（CM 报的"热重载后卡片不更新"正是这个）。
      //   补扫的结果只用来决定是否刷新"上次活跃时刻"：扫到新事件才算它真的还在动，
      //   扫不到就保留旧时刻（静默时长必须真实，不许为了让提示好看而造假）。
      let caughtUp = false
      try { caughtUp = Boolean(scanCard(entry.agent, card)) } catch (error) {
        console.log('[fs] 热重载续卡补扫失败: ' + String(error && error.message || error))
      }
      if (caughtUp) card.lastEventAt = Date.now()
      // 只在**真的欠一次推送**时才强推：内容进卡的时刻(lastScannedAt) 晚于 推送成功的时刻(lastPushedAt)。
      //   旧代一切正常 ⇒ 两个时刻相等 ⇒ 不推（无脑重推会让卡面内容重复，CM 2026-10-04 独立审查 HIGH#1）。
      const unpushed = Number(card.lastScannedAt || 0) > Number(card.lastPushedAt || 0)
      if (caughtUp || unpushed) {
        try { void syncCard(entry.bot, entry.chatId, card, true).catch(() => { }) } catch { }
      }
      console.log('[fs] 热重载续卡：接管 agent=' + key + ' card=' + String(card.token || '-').slice(-8)
        + ' blocks=' + card.blocks.length + ' catchup=' + caughtUp + ' unpushed=' + unpushed)
      const keepKindAdopt = entry.autoKind
      const keepOpenedAtAdopt = entry.autoOpenedAt
      entry.stop = startCardWatcher(entry.agent, card, entry.bot, entry.chatId, (r) => rotateAdoptedCard(entry.agent, r))
      // 0.7.21：接管不打断自动轮 —— 标记必须跟着搬到新登记条目上，
      //   否则这张目标卡之后的收口又会退回"普通回合"那套文案（同一个 MEDIUM 换个入口复发）。
      if (keepKindAdopt) markAutoRound(entry.agent, keepKindAdopt, keepOpenedAtAdopt)
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

  // 0.7.20（CM 批准的方案第 4 点）：**这一轮还在跑，但一张卡都没跟上**（接管失败／dsh 重启）
  //   ⇒ 新建一张卡，从**当前游标**续镜像。全程不碰 agent：不发消息、不打断、不让它重跑。
  //   游标取"当前事件总数"⇒ 只镜像从现在往后的内容，历史不重放（重放=CM 看到重复）。
  //   返回一个**事实判定**（供播报文案选分支），不返回"我做了什么"的乐观结论。
  function reviveCardForChat(sessionId, chatId, bot) {
    try {
      const agent = liveAgentsById().get(String(sessionId))
      if (!agent) return { kind: 'no-agent' }
      if (!agentIsRunning(agent)) return { kind: 'idle', agent }
      if (liveCardForChat(chatId)) return { kind: 'mirrored', agent }
      // 注意：这里**故意**不传 `from` ⇒ 新卡的 stall 播报额度从 0 重新计。
      //   换卡续写（rotate）继承额度，是因为"同一轮的内容被切到下一张卡"，额度应当连续；
      //   而复活出来的是**一张全新的卡**（旧卡已经不存在了），CM 看到的就是新卡，
      //   再沿用旧额度会让新卡一次都播不出来 —— 卡真的又卡住时反而失声。
      const card = makeCardState(agent)
      card.cursor = sessionEvents(agent.session).length
      card.blocks.push({
        type: 'message',
        text: '♻️ 插件热重载：这一轮仍在进行，旧卡没跟过来 —— 已新建这张卡**从当前进度继续**'
          + '（不重发之前的内容，也不让 agent 重跑）。',
      })
      void syncCard(bot, chatId, card, true).catch(() => { })
      startCardWatcher(agent, card, bot, chatId, (r) => rotateAdoptedCard(agent, r))
      console.log('[fs] reload revive: new card chat=' + chatId + ' agent=' + sessionId
        + ' cursor=' + card.cursor)
      return { kind: 'revived', agent, card }
    } catch (error) {
      console.log('[fs] reload revive failed: ' + String(error && error.message || error))
      return { kind: 'unknown' }
    }
  }

  function reloadNoticeText(kind) {
    if (kind === 'mirrored') {
      return '♻️ 插件已热重载：**这一轮没被打断，还在跑**，卡片继续在原来那张上更新。'
        + '我没有给 agent 发任何消息，也不会让它重跑。'
    }
    if (kind === 'revived') {
      return '♻️ 插件已热重载：这一轮还在跑，但原来的卡片没跟到新实例 —— '
        + '已**新建一张卡从当前进度继续镜像**（之前的内容不重发，agent 也不会重跑）。'
    }
    if (kind === 'idle') {
      return '♻️ 插件已热重载：这一轮此刻已经不在跑了（跑完或被重载打断，dsh 没上报是哪种）。'
        + '卡面若还停在「正在工作中…」，本实例会补一次封口；你的请求没有丢，要继续请再发一句。'
    }
    if (kind === 'no-agent') {
      return '♻️ 插件已热重载：这个会话的 agent 已不在本实例（多半 dsh 也重启了），这一轮我没有接管。'
        + '要继续请再发一句。'
    }
    return '♻️ 插件已热重载：这一轮的接管状态我暂时判不准（原因已记日志 '
      + '`[fs] reload revive failed`）。如果卡片停住了，你回我一句即可。'
  }

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
        // 0.7.20（CM 2026-10-04 拍定）：**先判真实情况，再按情况说话**。
        //   旧实现无条件发"上一轮被打断，我已自动让它接着做"，并且真的注入一条假消息（见下方删除说明）。
        const state = reviveCardForChat(sessionId, chatId, bot)
        // 2026-10-05（CM 定的分界）：mirrored / revived ＝ 还能继续 ⇒ 只写回**原卡**，不另发；
        //   idle / no-agent / 判不准 ＝ 不能继续（等不到结论）⇒ 保持另发。
        const reloadNotice = reloadNoticeText(state.kind)
        if (state.kind === 'mirrored' || state.kind === 'revived') {
          appendCardNotice(bot, chatId, '♻️ 已热重载', reloadNotice, 'grey-50')
        } else {
          void sendPlainText(bot, chatId, reloadNotice).catch(() => { })
        }
        console.log('[fs] hot reload interrupt notice: agent=' + sessionId + ' chat=' + chatId
          + ' state=' + state.kind)
        // ---- 已删除：热重载「假消息注入」（2026-10-04 CM 下令，方案第 1 点）-----------------
        //   旧实现在这里调 `handleInbound` 塞一条 `_internal` 的"（系统提示：请从断点继续）"，
        //   前提是"热重载打断了这一轮"。真机日志否证了这个前提：重载前后会话游标连续推进
        //   （同步根下的 `output/dsh-install/web.log` L85640–L85690）⇒ agent 根本没停。
        //   后果：它跑完真正的一轮之后，把这条假消息当成**新的用户指令**再跑一轮幻影回合
        //   （CM 报障②）。而重载风暴（实测相邻 apply 仅隔 4 秒）会把幻影轮乘倍。
        //   现在：重载只做**卡片侧**的接管/补扫/复活，一律不触碰 agent。
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
      // 0.7.19（审查 MED#1-B）：把落盘的 chat 类型恢复回内存 —— 热重载/重启后 chatKinds 是
      // 空的，没有这步「群 ⇒ 恒 stable」只能靠下一条真消息自愈；无入站的主动推卡（goal/自动轮卡、
      // 换卡）在恢复前会按 cfg（缺省 full）渲染，把过程叙述泄露给群（用例 69 实测红）。
      // 旧 state 没有 kind 字段 ⇒ 不写 ⇒ 与旧行为一致（等下一条带 chat_type 的入站补上）。
      const kind = record && record.kind
      if (kind === 'group' || kind === 'p2p') {
        if (!bot.chatKinds) bot.chatKinds = new Map()
        bot.chatKinds.set(chatId, String(kind))
      }
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
        // 0.7.19（审查 MED#1-B）：chat 类型随 chats 一起落盘（undefined 会被 JSON 丢弃 ⇒
        // 没记过的 chat 不写字段）。kind 只在 bot.chatKinds 里，persistChats 的 9 个调用点
        // 都传 bot ⇒ 这里直接读。用例 68 锚这个字段。
        kind: bot.chatKinds && bot.chatKinds.get(chatId)
          ? String(bot.chatKinds.get(chatId)) : undefined,
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

  // 命令锚点：把**开头**连续的 @ 占位符剥掉，再交给 splitCommand。
  // 🔴 为什么不能直接喂还原后的文本（第十三轮门槛 MEDIUM#2）：`splitCommand` 要求首字符是
  //   `/`，而群里 `@bot /stop` 还原后是 `@名字 /stop` ⇒ 前导的 @ 让命令**永远**识别不了。
  //   （上一轮 P0-2 只解决了「送进解析器的是 `@_user_1` 占位符」这一层，锚点问题原样留着，
  //   注释却写成「命令锚点照旧成立」——那是没验证过的断言。）
  // 🔴 为什么按占位符**精确 token** 剥而不是 `^@\S+\s+`：飞书的 @ 名字可以带空格
  //   （`@DSH 员工bot /stop`），按非空白截会截掉半截、剩下的正文不再是命令。
  // 只剥开头那几个；正文里的 @ 交回 renderMentions 还原成名字 ⇒ `/plan 请 @某人 介入`
  // 的参数不会把占位符漏给 agent（本文件口径：占位符绝不进 agent 上下文）。
  // 🔴 第十五轮门槛 MEDIUM#3（核对为真）：锚点喂的是 `extractText()` 的**输出**，而它
  //   并不总是占位符形态 —— 两种已在生产出现的形态会让 `t.startsWith(m.key)` 永不命中：
  //     ① 手机端纯文本里 content 自带 `mentions:[{key,denote_text}]` ⇒ 占位符**已被换成
  //        denote_text**（`张三 /stop`，连 `@` 都没有）；
  //     ② PC 端 post 富文本的 `at`/`person` 元素没有 key 字段 ⇒ 还原成 `@名字 /stop`。
  //   ⇒ 三种形态都参加匹配：占位符 / `@名字` / **裸名字且紧跟 `/`**（切法见下面第十七轮
  //   LOW#4 —— 同一起始位置取**最长**匹配，不是「先命中先切」）。
  //   第三档为什么要限制紧跟 `/`：不限制就会把 `张三 你好` 这类正文的名字剥掉。
  //   🔴 但"紧跟 `/`"本身**不足以**保证安全 —— 认不出的命令（`@张三/李四 今天值班`）
  //   照样会被判成命令，而命令分支过去是**无条件 return** ⇒ 消息被静默吞。那一条由
  //   第十六轮门槛在**事件入口**统一修（见 `im.message.receive_v1` 里 `cmd && resolveCommandName(...)`
  //   那条守卫），锚点这层不做二次判定 —— 同一个判据放两处会漂移。
  //   ⚠️ 本轮同时纠正上一版注释里的一处**不准**：原先写「否则 `张三 你好` 会被误剥、
  //   把非命令读成命令」，实际 `张三 你好` 剥掉名字后首字符不是 `/`，`splitCommand`
  //   本来就返回 undefined —— 那一例无论有没有守卫都无害，真正会出事的是紧跟 `/`
  //   而命令名不认识的那一类（判据要写对，否则后人会照着错的理由加回缺陷）。
  //   🔴 第十七轮门槛 LOW#4（核对为真）：**按名单顺序先命中先切**会踩「名字互为前缀」——
  //   正文 `@张三丰 /stop`、mentionList 里 `张三` 排在 `张三丰` 前面时，`张三` 这一档先
  //   命中 ⇒ 切成 `丰 /stop` ⇒ 后面谁都匹配不上 ⇒ 命令判成普通消息（用户视角：说了没执行，
  //   只是多回一句）。占位符同理（`@_user_1` 是 `@_user_12` 的前缀，@ 满 10 人以上的群会踩）。
  //   修法：**同一起始位置取最长匹配** —— 三种 token 一起参加比较，谁切得最多用谁。
  //   不给 `@名字` 那一档补右边界（补了会把「名字后紧跟正文」的既有剥法改掉），
  //   前缀问题在前缀层面解决。
  function commandAnchor(rawText, mentionList) {
    let rest = String(rawText || '')
    for (;;) {
      const t = rest.replace(/^[\s　]+/, '')
      let cut = 0
      for (const m of mentionList || []) {
        if (!m) continue
        // 三个候选档位：占位符 → `@名字` → 裸名字且紧跟命令字符
        if (m.key && t.startsWith(m.key) && m.key.length > cut) cut = m.key.length
        if (!m.name) continue
        const at = '@' + m.name
        if (t.startsWith(at) && at.length > cut) cut = at.length
        if (t.startsWith(m.name) && /^[\s　]*\//.test(t.slice(m.name.length)) && m.name.length > cut) {
          cut = m.name.length
        }
      }
      if (!cut) break
      rest = t.slice(cut)
    }
    return renderMentions(rest.trim(), mentionList)
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
          const sel = await switchModelForAgent(agent, direct[1], direct[2])
          if (sel.confirmed) {
            await sendPlainText(bot, chatId, '✅ 模型已切换为 `' + sel.provider + '/' + sel.model
              + '`（下一次请求开始用）')
          } else {
            await sendPlainText(bot, chatId, '⚠️ 切换请求已发给宿主（`' + sel.provider + '/' + sel.model
              + '`），但宿主没有回带确认，无法保证已生效。发 `/model` 看「当前」是不是这条。')
          }
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
        // 2026-10-04（方案 B）：标题与摘要**都显示** —— 原先 `t || r.summary` 是二选一（有标题就看不到内容）。
        const base = t || r.label || shortSessionId(r.sessionId)
        const flags = []
        if (r.current) flags.push('当前')
        else if (r.inChat) flags.push('本聊天')
        if (r.live) flags.push('🟡 运行中')
        // 摘要与主名不同才另起一行（没标题时会退化用 label/id，那种情况也不重复显示）
        const extra = (r.summary && r.summary !== base)
          ? '\n     <font color=\'grey\'>' + r.summary + '</font>' : ''
        return (r.current ? '▶ ' : '  ') + (i + 1) + '. ' + base
          + (flags.length ? '（' + flags.join('·') + '）' : '') + extra
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
      // 0.7.17（stable 门禁）：稳定版不支持切换会话（CM：员工一个会话就够）。
      if (resolveCardMode(bot, chatId) === 'stable') {
        await sendPlainText(bot, chatId, '🔒 稳定版不支持切换会话（该功能未对当前模式开放）。')
        return true
      }
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
      // 2026-10-04：群聊"@ 才回复"判据需要 mentions（消息级；部分客户端只在 content 里带）
      mentions: Array.isArray(message.mentions) ? message.mentions : undefined,
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
            if (!el || typeof el !== 'object') continue
            // P0-7（0.8.0 互认）：post 里的 at/person 元素**没有 text 字段**，
            // 旧实现整段跳过 ⇒ "@ 谁"在正文里凭空消失。还原成 @名字。
            if (el.tag === 'at' || el.tag === 'person') {
              let nm = ''
              if (typeof el.user_name === 'string') nm = el.user_name
              else if (typeof el.name === 'string') nm = el.name
              parts.push('@' + (nm || '某人'))
              continue
            }
            if (typeof el.text === 'string') parts.push(el.text)
          }
        }
        return parts.join(' ').trim()
      }
      return ''
    } catch {
      return ''
    }
  }

  // ---- P0-1 入站互认（0.8.0，2026-10-05 真机取证 V1/V2 定案）------------------
  // 旧实现只替换 content 内嵌 mentions 的 denote_text，而标准事件里该路径从不触发
  // ⇒ 正文残留 `@_user_1` 占位符原样送进 agent。下面三个函数把根级 mentions 接上。

  // mentions[].id 有字符串/对象双形态（与 isBotMentioned 同口径），统一成对象。
  function normalizeMentionList(mentions) {
    if (!Array.isArray(mentions)) return []
    const list = []
    for (const m of mentions) {
      if (!m || typeof m !== 'object') continue
      const id = typeof m.id === 'string' ? { open_id: m.id } : (m.id || {})
      list.push({
        key: typeof m.key === 'string' ? m.key : '',
        name: typeof m.name === 'string' ? m.name.trim() : '',
        openId: typeof id.open_id === 'string' ? id.open_id : '',
        unionId: typeof id.union_id === 'string' ? id.union_id : '',
        type: typeof m.mentioned_type === 'string' ? m.mentioned_type : '',
      })
    }
    return list
  }

  // `@_user_N` 占位符 → `@姓名`；没名字兜底 `@某人`（不许把占位符漏给 agent）。
  function renderMentions(text, list) {
    if (!text || !list || !list.length) return text
    let out = text
    for (const m of list) {
      if (!m.key) continue
      out = out.split(m.key).join(m.name ? '@' + m.name : '@某人')
    }
    return out
  }

  // 「`mentioned_type` 这个值算不算一个 agent（bot/应用）」——🔴 **两处口径必须同源**
  // （第十三轮门槛 LOW#4）：明细行原来只把 `'bot'` 当 bot、`'app'` 落进 `user`，而
  // `mentionIsOtherAgent` 认 `'bot'` 与 `'app'` ⇒ 同一个字段在本文件里被读成两种意思。
  // 真机取证：bot 发消息时 `mentioned_type` 实测为 `'bot'`（见上方 P0-3 注释），`'app'`
  // 是同族值（应用维度回调），两者都不是自然人。
  function mentionedTypeIsAgent(type) {
    const t = String(type || '')
    return t === 'bot' || t === 'app'
  }

  // 明细行：**只**拼进送 agent 的会话文本，绝不进卡片（守 B3/B4 用例 61/57）。
  // 🔴 id 在这里【不截断】（2026-10-05 中台 HOME#DSH 实证）：agent 拿这两个明细去调 contact API
  //    反查身份，截断的 id 必然 99992351 invalid id。截断只适用于卡片与日志 —— 会话文本是给
  //    agent 的输入，不是给用户看的面子；卡片那一侧仍由用例 85/93 钉死「不带 id」。
  function mentionFooter(list) {
    if (!list || !list.length) return ''
    const seg = []
    for (const m of list) {
      const who = m.name || '未署名'
      const kind = mentionedTypeIsAgent(m.type) ? 'bot' : 'user'
      const id = m.openId || m.unionId || ''
      seg.push('@' + who + '(' + kind + (id ? ' id=' + id : '') + ')')
    }
    return '\n' + MENTION_FOOTER_TAG + seg.join('；') + '\n'
  }

  // P0-3（0.8.0 agent 互认）：发送方标注 —— 常规回合 / 插话两处同构逻辑收口在这里。
  // identityGuard 关时不再把裸 ou 贴进 label（agent 分不清人/机器人，且像 id 的文本
  // 容易被模型当"凭据"）；明细行只进送 agent 的会话文本，**卡片链完全不感知**。
  // 🔒 授权不读这里的任何字段，仍只走 resolver.resolve(openId)→store。
  // 取证 V2（2026-10-04 真机）：bot 发的消息 sender_type 实测为 **'bot'**（不是 'app'）。

  // ---- P0-4 bot roster（跨应用 id 目录；由 scripts/collect_bot_roster.mjs 生成）----
  // open_id 是应用视角值 ⇒ "同一个东西在 7 个应用里长 7 个样"。roster 用 union_id 当
  // join 主键（名字实测会漂移，不能当键）。热读节奏对齐 10s 配置重载：mtime 变了才读盘。
  const rosterState = { mtime: 0, data: null, badMtime: 0, missLogged: new Set() }
  function loadBotRoster() {
    const p = join(configDir(), 'bot_roster.json')
    let mtimeMs = 0
    try { mtimeMs = statSync(p).mtimeMs } catch {
      rosterState.mtime = 0
      rosterState.data = null
      return null   // 文件不在 ⇒ 正常降级（认不出名字），不是错误
    }
    if ((rosterState.data && mtimeMs === rosterState.mtime) || mtimeMs === rosterState.badMtime) {
      return rosterState.data
    }
    try {
      rosterState.data = JSON.parse(readFileSync(p, 'utf8'))
      rosterState.mtime = mtimeMs
    } catch (error) {
      // 🔴 门槛（第十二轮 LOW）：失败也要**记下已经试过这一版**。原来只记成功的那版 mtime ⇒
      //   一个长期坏掉的 bot_roster.json 会让**每条入站**都重读一遍文件、重打一行日志
      //   （loadBotRoster 在收信标注与 @ 解析里逐条被调）＝日志刷屏 + 每条消息一次同步 IO。
      //   文件被修好时 mtime 必然再变 ⇒ 既不刷屏也不会漏掉新内容；坏文件仍用上一份好的。
      if (rosterState.badMtime !== mtimeMs) {
        console.log('[fs] roster parse failed: ' + String(error && error.message || error))
        rosterState.badMtime = mtimeMs
      }
      return rosterState.data
    }
    return rosterState.data
  }

  // id → 名字 反查：bots 优先（V4 取证：bot 的寻址 id = 它 bot/v3/info 的自身 ou，
  // 各视角事件里看到的就是它 ⇒ 直接比对 views 值），再 people（本 bot 视角视图）。
  // 查不到返回 '' 并**留痕**（roster miss，同 id 只记一次）—— 不静默：改名失联要能看到。
  function rosterNameFor(bot, openId, unionId) {
    const r = loadBotRoster()
    if (!r) return ''
    const myApp = String((bot && bot.cfg && bot.cfg.appId) || '')
    for (const row of r.bots || []) {
      if (unionId && row.union_id && row.union_id === unionId) return row.name || ''
      for (const v of Object.values(row.views || {})) {
        if (openId && v === openId) return row.name || ''
      }
    }
    for (const row of r.people || []) {
      if (unionId && row.union_id === unionId) return row.name || ''
      const v = row.views && openId ? row.views[myApp] : ''
      if (v && v === openId) return row.name || ''
    }
    const missKey = openId || unionId
    if (missKey && !rosterState.missLogged.has(missKey)) {
      // 只为"同一个 id 不重复刷屏"，不是目录 ⇒ 有界即可（第六轮门槛 LOW：原来只增不减，
      // 长跑进程会每个未识别 id 留一条永久条目，正是 `rememberBounded` 修掉的那类泄漏）。
      if (rosterState.missLogged.size >= 500) rosterState.missLogged.clear()
      rosterState.missLogged.add(missKey)
      console.log('[fs] roster miss (id not in bot_roster.json): ' + missKey.slice(0, 12) + '…')
    }
    return ''
  }

  // P2（0.8.0 agent 互认）：卡片**点击者**身份。
  // 取证 V3（2026-10-05 真机）：`card.action.trigger` 的 `data.operator` =
  //   { user_id, open_id, union_id }，全部是**本应用视角**的值。
  // 🔒 与 P0-3 同口径：这里只作**识别旁证**（把名字带进写回会话的答案），
  //   授权仍只走 resolver.resolve(openId)→store —— 认出点击者 ≠ 给他任何权限。
  // 🔴 第八轮（2026-10-05）判过的那道"截断"在**本函数里不能一刀切**，两个方向都有代价：
  //   · 卡片/日志侧（`dismissApprovalCard` 的追加文本、console 留痕）⇒ **必须截断**，
  //     完整 id 进会话可见文本 = B3 隐私红区、用例 92 第三条钉着日志口径。
  //   · 回给 agent 的那一份（`clicker` 字段 → 工具结果）⇒ **必须完整**，
  //     与第八轮把 `senderLabelFooter`/`mentionFooter` 改成给完整 id 同一个理由：
  //     agent 拿半截 id 去通讯录反查必然 99992351（认不出名字时这条信息等于没有）。
  // ⇒ 用 `full` 参数分流，同一个函数，两个口径，不许再复制出一份漂移。
  function clickerTagFor(bot, data, full) {
    const op = data && data.operator ? data.operator : null
    const ou = String((op && op.open_id) || '')
    const union = String((op && op.union_id) || '')
    if (!ou && !union) return ''
    const name = rosterNameFor(bot, ou, union)
    // 🔴 截断分支同样要 `ou || union`（2026-10-05 门槛第十一轮 LOW#3）：原来写死
    //   `ou.slice(0, 8)` ⇒ 回调只带 union_id 时得到**空串**，卡面/日志渲染成
    //   `[点击者 未署名|]` —— 这一支的目的本来就是"留一个截断 id"，全丢掉等于没留。
    const idTag = full ? (ou || union) : (ou || union).slice(0, 8)
    return '[点击者 ' + (name || '未署名') + '|' + idTag + ']'
  }

  // ---- P1 出站 @（0.8.0 agent 互认）----
  // 取证 V4（2026-10-05 真机）：卡片 markdown `<at id=ou>名</at>` 与 post 的 tag:"at" **都**能
  // 让被 @ 的 bot 收到事件（post 必须包 zh_cn 层，否则 code 230001）。
  // bot 的寻址 id = 它**自己应用视角**的 ou（V2：对方群里认的就是这个值）；
  // 人必须用**本 bot 视角**的 ou —— open_id 是应用视角值，拿错视角 = @ 了个寂寞。
  const identMapState = { mtime: 0, badMtime: 0, people: [] }
  function identityMapPeople() {
    // roster 不在时的 name→id 兜底：identity_map 主表（people[] 带 name/aliases/open_ids{app:ou}）
    const p = identityMapPath()
    if (!p) return []
    let mt = 0
    try { mt = statSync(p).mtimeMs } catch { return [] }
    if (identMapState.mtime === mt || identMapState.badMtime === mt) return identMapState.people
    try {
      const d = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
      identMapState.people = Array.isArray(d.people) ? d.people : []
      identMapState.mtime = mt
    } catch {
      // 同 roster：坏表也要记下试过这一版，否则每个查不到的名字都把整表重读+重 parse 一遍
      //   （这张表是**同步**读的，且发生在卡片每重组一次的路径上）。
      identMapState.badMtime = mt   // 用上一份，不清空
    }
    return identMapState.people
  }

  // 🔴 本地增量表（`identity_map.local.json`）——第十三轮 MEDIUM#3：
  //   「**本机 bot 视角**的 ou」就写在这张表里（每台一份、不参与同步），而内核
  //   `resolveActorJs` 是**主表＋增量合并**后才解析的。出站 @ 的 name→id 兜底原来只读主表
  //   ⇒ 只存在于增量的那个 ou 在这里**永远查不到**，明明认得出的人被发成「（未能 @ 出：X）」。
  //   口径与内核一致：**只按同名补 open_ids，不新增人名**（增量里主表没有的名字一律不算数）。
  const identLocalState = { mtime: 0, badMtime: 0, ids: new Map() }   // name -> open_ids
  function identityLocalIds() {
    const p = localMapPath()
    if (!p) return identLocalState.ids
    let mt = 0
    try { mt = statSync(p).mtimeMs } catch { return new Map() }
    if (identLocalState.mtime === mt || identLocalState.badMtime === mt) return identLocalState.ids
    try {
      const d = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
      const ids = new Map()
      for (const per of (Array.isArray(d.people) ? d.people : [])) {
        const nm = String((per && per.name) || '')
        const o = per && per.open_ids
        if (nm && o && typeof o === 'object' && !Array.isArray(o)) ids.set(nm, o)
      }
      identLocalState.ids = ids
      identLocalState.mtime = mt
    } catch {
      identLocalState.badMtime = mt   // 坏表也记住试过这一版（同主表：整表同步 parse 很贵）
    }
    return identLocalState.ids
  }

  function resolveAtTarget(bot, chatId, name) {
    const r = loadBotRoster()
    const myApp = String((bot && bot.cfg && bot.cfg.appId) || '')
    const hits = new Set()
    if (r && myApp) {
      const chat = chatId ? (r.chats || {})[chatId] : null
      for (const row of r.bots || []) {
        if (!row || String(row.name || '') !== name) continue
        // 群里认得出才 @ 得出：本群 bot 名单存在时按它收窄（防跨群同名误 @）
        if (chat && Array.isArray(chat.bot_app_ids) && chat.bot_app_ids.length
          && !chat.bot_app_ids.includes(row.app_id)) continue
        const v = (row.views && row.views[row.app_id]) || (row.views && row.views[myApp]) || ''
        if (v) hits.add(String(v))
      }
      for (const row of r.people || []) {
        if (!row || String(row.name || '') !== name) continue
        if (chat && Array.isArray(chat.member_unions) && chat.member_unions.length
          && !chat.member_unions.includes(row.union_id)) continue
        const v = row.views && row.views[myApp]
        if (v) hits.add(String(v))
      }
    }
    if (!hits.size) {
      const localIds = identityLocalIds()
      for (const p of identityMapPeople()) {
        if (!p) continue
        const nm = String(p.name || '')
        const aliasHit = Array.isArray(p.aliases) && p.aliases.map(String).includes(name)
        if (nm !== name && !aliasHit) continue
        const v = (p.open_ids || {})[myApp]
        if (v) hits.add(String(v))
        // 本机 app 视角的 ou 往往**只**落在本地增量里 ⇒ 同名补一份（与内核同一口径）
        const lo = localIds.get(nm)
        const lv = lo && lo[myApp]
        if (lv) hits.add(String(lv))
      }
    }
    if (!hits.size) return { ou: '' }
    if (hits.size > 1) return { ou: '', ambiguous: true }
    return { ou: [...hits][0] }
  }

  // agent 写 `@[名字]` / `@「名字」` / `@all` ⇒ 展开成卡片 markdown 的真 @。
  // 🔴 未命中**保留原文并声明**（`（未能 @ 出：X）`），绝不发半截幽灵 @。
  // 幂等纯函数：只改**组装载荷**、不改 card.blocks ⇒ 用例 76 的水位口径不受影响；
  // 展开后的 `<at>` 不再含 token，重复展开是 no-op。

  // 🔴 第十四轮门槛 MEDIUM（核对为真）：原来的正则是**盲扫整篇**，不认识代码区。
  //   `@[名字]`/`@all` 这类字面量在本仓库的文档、工具说明、以及 agent 随手贴进卡片的
  //   diff/README/手册里**原样出现** ⇒ 被展开成一次**真 `<at id=…>`**：(a) 改写了作者写的
  //   内容（卡上的代码样例和源码不再一致）；(b) 真的去 @ 了那个人，而**出站 @ 正是唤醒
  //   对方 bot 入站事件的扳机**（P1 出站 @）。`(?![[(])` 那条已经证明"误命中"这一类被考虑过，
  //   只是漏了围栏/行内代码。⇒ 先切「代码 / 非代码」段，**只在非代码段展开**。
  const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})/
  const INLINE_CODE_RE = /(`+)[^\n]*?\1/g
  // 切成 `{code,text}` 段：围栏（``` / ~~~）整段算代码（含围栏行本身），段内再按行内 `…` 切。
  // 只做「把文本按是否代码分区」，不认识 markdown 的其它语法 —— 够用且不会误伤正文。
  // 🔴 划定的边界（第十五轮门槛 LOW：4 空格/制表符缩进块不算代码，**明知并接受**）：
  //   卡片 markdown 是飞书渲染的，缩进在传输中本就不稳定；把"行首 4 空格"当代码块会
  //   连列表续行/引用正文一起误判成代码 ⇒ **漏展开**（真 @ 出不去，用户看到字面 `@[名字]`）。
  //   两害相权：误展开的代价是"多 @ 一次"，漏展开的代价是"功能不生效"，而缩进形态在
  //   本仓库真实流量里没出现过 ⇒ 只认围栏与行内反引号这两种**显式**标记。
  function splitCodeSegments(raw) {
    const segs = []
    const add = (code, text) => {
      if (!text) return
      const last = segs.length ? segs[segs.length - 1] : null
      if (last && last.code === code) last.text += text
      else segs.push({ code, text })
    }
    const lines = raw.split('\n')
    let buf = ''
    let bufCode = false
    let fence = ''
    const flush = () => { add(bufCode, buf); buf = '' }
    for (let i = 0; i < lines.length; i++) {
      const line = i + 1 < lines.length ? lines[i] + '\n' : lines[i]
      const open = FENCE_LINE_RE.exec(line)
      if (fence) {
        buf += line
        // 收栏：同种字符、不短于开栏长度（CommonMark 口径的简化版）
        if (open && open[1][0] === fence[0] && open[1].length >= fence.length) {
          flush(); bufCode = false; fence = ''
        }
        continue
      }
      if (open) { flush(); fence = open[1]; bufCode = true; buf += line; continue }
      buf += line
    }
    flush()
    const split = []
    for (const seg of segs) {
      if (seg.code) { split.push(seg); continue }
      let rest = seg.text
      let match
      INLINE_CODE_RE.lastIndex = 0
      while ((match = INLINE_CODE_RE.exec(rest))) {
        if (match.index > 0) split.push({ code: false, text: rest.slice(0, match.index) })
        split.push({ code: true, text: match[0] })
        rest = rest.slice(match.index + match[0].length)
        INLINE_CODE_RE.lastIndex = 0
      }
      if (rest) split.push({ code: false, text: rest })
    }
    return split
  }

  function expandAtTokens(bot, chatId, text) {
    const raw = String(text == null ? '' : text)
    if (raw.indexOf('@') < 0) return raw
    const missing = []
    const ambiguous = []
    let expanded = 0
    // 🔴 左右都要边界（第八轮门槛 LOW）：原来只有右侧负向前瞻 ⇒ 邮件地址 `foo@all.com`
    //   里的 `@all` 后面跟 `.` 会命中，被展开成一次**真·@ 全体**。左侧同理挡掉 `x@all`。
    // 🔴 `@[文本](链接)` 是 markdown 链接、不是 @ 人名 ⇒ 加 `(?![[(])` 让它在跟着
    //   `(`/`[`（引用式链接）时整条不匹配，保留原文，别把链接文字吃掉。
    //   🔴 第十一轮 LOW#4：`@「」` 这一支原来**没有左边界**（另两支都有），
    //     `x@「张三」`/`mail@「张」` 照样命中 ⇒ 和这一轮刚立的"左右都要边界"自相矛盾，
    //     幽灵 @ 的风险只堵掉了两支。三支一律补 `(?<![\w$])`。
    //   🔴 第十五轮门槛 LOW（核对为真）：`@all` 的右边界原来只排 `[A-Za-z0-9_]`，
    //     而 `-` 和 `.` **不在**其中 ⇒ `@all-hands`、`@all.png` 照样命中并展开成
    //     **一次真·@ 全体**（出站 @ 是唤醒对方 bot 入站事件的扳机，误触发=群广播）。
    //     注释里"邮箱 foo@all.com 被右边界挡下"的说法也不准确：那一例其实由**左边界**挡下。
    //     右边界收紧为 `(?![\w.\-])`：`@all` 后面只要还跟着 **ASCII** 字母/数字/下划线/点/
    //     连字符就不是一个独立 token（第十七轮 LOW#1 纠正措辞：`\w` 不含中文，原写「字母」
    //     是过度声称）。**中文相邻刻意不挡**，判据是**哪一类误判更常发生**：紧邻 ASCII 标识符
    //     字符 ⇒ 这个 `@all` 属于那个标识符（`@all-hands`/`@all.png`/`@all_x`），不是广播指令；
    //     紧邻中文 ⇒ 是「广播指令 + 正文」的普通写法（本产品中文-first、多数人在 @ 后不打
    //     空格），判成非 token 等于把用户要的全群通知悄悄取消。
    //     ⚠️ 别把上面读成"代价比较"：代价其实**不对称** —— 漏展开看得见、可重发，多广播
    //     唤醒全群、收不回。所以这一档留下的残余风险是「正文里出现字面 `@all` 且后接中文」
    //     （本仓库真实流量里没出现过），而不是常见的中文广播写法被挡。
    const AT_RE = /(?<![\w$])@\[([^\]\n]{1,60})\](?![[(])|(?<![\w$])@「([^」\n]{1,60})」|(?<![\w$])@all(?![\w.\-])/gi
    const expandOne = (whole, sq, cn) => {
      if (sq === undefined && cn === undefined) { expanded++; return '<at id=all>所有人</at>' }
      const name = String(sq !== undefined ? sq : cn).trim()
      if (!name) return whole
      const hit = resolveAtTarget(bot, chatId, name)
      if (hit.ou) {
        expanded++
        return '<at id=' + hit.ou + '>' + name.replace(/[<>&]/g, '') + '</at>'
      }
      const bag = hit.ambiguous ? ambiguous : missing
      if (!bag.includes(name)) bag.push(name)
      return whole
    }
    // 代码区原样保留，只展开非代码段（见上面 MEDIUM 注释）。
    let inCode = 0
    let out = ''
    for (const seg of splitCodeSegments(raw)) {
      if (seg.code) {
        const seen = seg.text.match(/@/g)
        if (seen) inCode += seen.length
        out += seg.text
        continue
      }
      out += seg.text.replace(AT_RE, expandOne)
    }
    if (inCode) {
      console.log('[fs] at tokens 代码区原样保留 n=' + inCode + ' chat=' + String(chatId || '').slice(0, 12))
    }
    if (expanded) {
      console.log('[fs] at tokens expanded=' + expanded + ' chat=' + String(chatId || '').slice(0, 12))
    }
    if (missing.length || ambiguous.length) {
      console.log('[fs] at tokens unresolved chat=' + String(chatId || '').slice(0, 12)
        + ' missing=' + missing.join(',') + ' ambiguous=' + ambiguous.join(','))
      const parts = []
      if (missing.length) parts.push(missing.join('、'))
      if (ambiguous.length) parts.push(ambiguous.map((n) => n + '（重名歧义）').join('、'))
      return out + '\n（未能 @ 出：' + parts.join('；') + '）'
    }
    return out
  }

  // P1-4：`DSH_FEISHU_AT_MODE=post` ⇒ 出站 @ 降级为 post 消息（把已展开的 `<at>` 换回
  // tag:"at" 元素）。V4 实测：post 内容**必须**包 zh_cn 层，裸 content ⇒ code 230001。
  const POST_SEND_MAX_LINES = 30
  async function sendPostText(bot, receiveId, receiveIdType, body) {
    const cfg = bot.cfg
    // 🔴 这条通道是**纯文本兜底链**（卡片全挂时的最后手段，本插件的口径是「内容一个字
    //   都不能丢」）。超过 POST_SEND_MAX_LINES 的行数必须**看得见地**丢：留痕 + 正文里
    //   补一行截断说明。原实现静默 slice ⇒ 调用方拿到 200 成功，尾部内容凭空蒸发。
    const allLines = String(body).split(/\r?\n/)
    const lines = allLines.slice(0, POST_SEND_MAX_LINES)
    if (allLines.length > lines.length) {
      console.log('[fs] post send truncated: ' + allLines.length + ' -> ' + POST_SEND_MAX_LINES
        + ' lines (receive_id=' + String(receiveId).slice(0, 12) + ')')
      if (lines.length) lines.push('…（内容过长，此处起已截断：全文 ' + allLines.length
        + ' 行，仅送达前 ' + POST_SEND_MAX_LINES + ' 行）')
    }
    const content = lines.map((line) => {
      const segs = []
      let last = 0
      for (const m of line.matchAll(/<at id=([A-Za-z0-9_-]+)>[^<]*<\/at>/g)) {
        if (m.index > last) segs.push({ tag: 'text', text: line.slice(last, m.index) })
        segs.push({ tag: 'at', user_id: m[1] })
        last = m.index + m[0].length
      }
      if (line.slice(last)) segs.push({ tag: 'text', text: line.slice(last) })
      return segs.length ? segs : [{ tag: 'text', text: ' ' }]
    })
    return httpJson(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=' + receiveIdType,
      'POST',
      { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await tenantAccessToken(bot, cfg.appId, cfg.appSecret) },
      { receive_id: receiveId, msg_type: 'post', content: JSON.stringify({ zh_cn: { title: '', content } }) },
    )
  }

  function senderLabelFooter(bot, evt, identityActor) {
    const sender = (evt && evt.sender) || {}
    const sid = sender.sender_id || {}
    const openId = typeof sid.open_id === 'string' ? sid.open_id : ''
    const unionId = typeof sid.union_id === 'string' ? sid.union_id : ''
    if (!openId && !unionId) return { label: '[飞书消息] ', footer: '' }
    const kind = String(sender.sender_type || '') === 'bot' ? 'bot' : 'user'
    const who = (identityActor && identityActor.name)
      || rosterNameFor(bot, openId, unionId)
      || (kind === 'bot' ? '机器人' : '用户')
    // 🔴 id **不截断**（2026-10-05 中台 HOME#DSH 实证：agent 拿截断 id 调 contact API 报 99992351）：
    //   这条 footer 是给 agent 的会话输入，卡片与日志那一侧照旧截断（用例 85/93 钉死卡片不带 id）。
    const footer = '\n' + SENDER_FOOTER_TAG + 'kind=' + kind + ' name=' + who
      + ' open_id=' + openId
      + (unionId ? ' union_id=' + unionId : '') + '\n'
    return { label: '[飞书 ' + who + '] ', footer }
  }

  // ---- P0-6（0.8.0）群门**可选**接力通道 ----------------------------------------
  // 🔴 默认 self_only = 现状一字不动（CM 2026-10-04 防互刷裁决不被推翻：实测两个 bot
  //   同群 5 分钟刷出 3666 条事件）。只有 bot 配置/群白名单显式 opt-in 才放宽。
  // 互刷三层防线（**仅**对经 relay 转发的 bot 来源消息计数，人来源消息不吃预算）：
  //   ① 配对预算：90s 内同一 (发送方→本 bot) 接力 >3 条 ⇒ 冻结该配对 10 分钟 + 留痕；
  //   ② 群预算：60s 内经 relay 放行的 bot 消息 >8 条 ⇒ 整群丢弃留痕；
  //   ③ 复臂：该群里出现**任意人**消息 ⇒ 清空计数与冻结（人说一句，循环即止）。
  function relayModeFor(bot, chatId) {
    const cfgv = (bot && bot.cfg) || {}
    const per = cfgv.groupRelayChats && typeof cfgv.groupRelayChats === 'object'
      ? cfgv.groupRelayChats[chatId] : undefined
    const m = String(per || cfgv.groupRelay || 'self_only')
    return ['self_only', 'mentions_any', 'all', 'off'].includes(m) ? m : 'self_only'
  }

  // "@ 了除本 bot 以外的 **bot**" —— 名字兜底参照 isBotMentioned 同口径。
  // 🔴 判据不许用「不是我就算」：真机 `mentions` 里没有可靠的类型字段（`mentioned_type` 只是
  //   "有就记"的可选字段），`cand && !mine` 会把**人 @ 人**也放行 ⇒ 本 bot 闯进没点它的对话、
  //   白烧一个回合并发卡。类型缺失时只认 **bot 目录里查得到的 ou/名字**；没目录就不认
  //   （mentions_any 是防互刷的 opt-in 通道，宁可漏放不可误唤醒）。
  function mentionIsOtherAgent(bot, m) {
    const mine = String((bot && bot.botOpenId) || '')
    const bname = String((bot && bot.botAppName) || '')
    const raw = m.id
    const cand = typeof raw === 'string' ? raw : ((raw && raw.open_id) || '')
    if (cand && mine && cand === mine) return false
    if (bname && m.name && String(m.name) === bname) return false
    const mt = String(m.mentioned_type || '')
    if (mt) return mentionedTypeIsAgent(mt)
    const r = loadBotRoster()
    if (!r) return false
    for (const row of r.bots || []) {
      const views = (row && row.views) || {}
      if (cand && Object.keys(views).some((k) => String(views[k]) === cand)) return true
      if (!cand && m.name && String(row.name || '') === String(m.name)) return true
    }
    return false
  }

  function mentionsOtherAgent(evt, bot) {
    const list = Array.isArray(evt && evt.mentions) ? evt.mentions : []
    if (!list.length) return false
    return list.some((m) => m && typeof m === 'object' && mentionIsOtherAgent(bot, m))
  }

  function relayAllowance(bot, evt) {
    const chatId = String((evt && evt.chat_id) || '')
    const mode = relayModeFor(bot, chatId)
    if (mode === 'self_only' || mode === 'off') return false
    const sender = (evt && evt.sender) || {}
    const fromBot = String(sender.sender_type || '') === 'bot'
    // 防线③：人消息（无论最终放不放行）先复臂。
    if (!fromBot && bot.relayLoop && bot.relayLoop.has(chatId)) bot.relayLoop.delete(chatId)
    if (mode === 'mentions_any' && !mentionsOtherAgent(evt, bot)) return false
    if (!fromBot) return true
    if (!bot.relayLoop) bot.relayLoop = new Map()
    const st = bot.relayLoop.get(chatId) || { pairs: new Map(), win: { n: 0, t0: Date.now() } }
    const now = Date.now()
    const sid = sender.sender_id || {}
    const key = String(sid.union_id || sid.open_id || '') || 'unknown'
    const pair = st.pairs.get(key)
    if (pair && Number(pair.frozenUntil || 0) > now) {
      console.log('[fs] bot-pair loop frozen (drop relayed msg): sender=' + key.slice(0, 12)
        + '… chat=' + chatId.slice(0, 12))
      bot.relayLoop.set(chatId, st)
      return false
    }
    if (now - Number(st.win.t0 || 0) > 60000) st.win = { n: 0, t0: now }
    st.win.n += 1
    if (st.win.n > 8) {
      console.log('[fs] group relay budget exhausted (60s>8): chat=' + chatId.slice(0, 12)
        + ' dropped=' + String((evt && evt.message_id) || ''))
      bot.relayLoop.set(chatId, st)
      return false
    }
    if (!pair || now - Number(pair.t0 || 0) > 90000) {
      st.pairs.set(key, { n: 1, t0: now, frozenUntil: pair ? Number(pair.frozenUntil || 0) : 0 })
    } else {
      pair.n += 1
      if (pair.n > 3) {
        pair.frozenUntil = now + 600000
        console.log('[fs] bot-pair loop frozen 10min: sender=' + key.slice(0, 12)
          + '… relayed=' + pair.n + '/90s chat=' + chatId.slice(0, 12))
        bot.relayLoop.set(chatId, st)
        return false   // 触阈的这条本身也扣下，不等下一轮
      }
      st.pairs.set(key, pair)
    }
    bot.relayLoop.set(chatId, st)
    return true
  }

  // 0.7.9 P6（CM 2026-10-03：转发卡片给 bot "没反应"；协作信箱 15:20 TASK 同）：
  //   转发进来的卡片是 msg_type='interactive'，extractText() 拿不到正文 ⇒ 旧实现走到
  //   handleInbound 的 `if (!text.trim()) return` **静默丢弃**（只留一个表情）。
  //   这个函数把卡片 JSON 里的可读文字**递归抠出来**当正文（去重、限长），抠不到则由调用方回可见提示。
  function salvageTextFromRich(evt) {
    let parsed = null
    try {
      const raw = evt && evt.content
      parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw
    } catch { return '' }
    if (!parsed || typeof parsed !== 'object') return ''
    const out = []
    const push = (s) => {
      const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
      if (t && !out.includes(t)) out.push(t)
    }
    const walk = (node, depth) => {
      if (!node || depth > 6 || out.length >= 80) return
      if (typeof node === 'string') {
        const s = node.trim()
        if ((s.startsWith('{') || s.startsWith('[')) && s.length < 20000) {
          try { walk(JSON.parse(s), depth + 1); return } catch { /* 不是 JSON ⇒ 当普通文字 */ }
        }
        push(s)
        return
      }
      if (Array.isArray(node)) { for (const it of node) walk(it, depth + 1); return }
      if (typeof node !== 'object') return
      // P0-7（0.8.0 互认，2026-10-05 真机取证）：转发进来的卡片里 @ 与按钮/控件是
      // **带 tag 的元素**，旧实现只抠纯文字 ⇒ "卡片内容的 @ 其他 agent 看不到"。
      const tg = typeof node.tag === 'string' ? node.tag : ''
      if (tg === 'at' || tg === 'person' || tg === 'mention') {
        // 名字只认字符串（第十三轮门槛 LOW#3）：富节点里 `user_name`/`name` 偶见对象形态，
        // 拼进送 agent 的会话文本就成 `@[object Object]`（agent 拿它去认人必然认不出）。
        let nm = ''
        if (typeof node.user_name === 'string') nm = node.user_name
        else if (typeof node.name === 'string') nm = node.name
        push(nm ? '@' + nm : '@某人')
        return
      }
      if (tg === 'button' || tg === 'action' || tg === 'select_person' || tg === 'overflow' || tg === 'date_picker') {
        const t = node.text
        // 名字同样只认字符串（第十三轮 LOW#3 的同一族，第十五轮门槛 LOW 补上这一支）：
        //   富节点偶见 `name` 是对象形态，拼进会话文本就成 `【按钮/控件】[object Object]`。
        let inner = typeof node.name === 'string' ? node.name : ''   // 三元的最后一档才是兜底：先给默认值，再逐条覆盖（不用嵌套三元）
        if (typeof t === 'string') inner = t
        else if (t && typeof t.content === 'string') inner = t.content
        push('【按钮/控件】' + (inner || tg))
        return
      }
      if (tg === 'img' || tg === 'media') {
        const a = node.alt
        let alt = ''
        if (typeof a === 'string') alt = a
        else if (a && typeof a.content === 'string') alt = a.content
        push('【' + (tg === 'img' ? '图片' : '视频') + '】' + alt)
        return
      }
      for (const k of ['content', 'text', 'title', 'name', 'user_name', 'file_name', 'tag_name', 'label']) {
        if (typeof node[k] === 'string') push(node[k])
      }
      // 0.7.10（独立审查 MED#3150 修正）：**必须含 body/header** —— schema 2.0 卡片把元素放在
      // `body.elements`（本插件自己发出去的卡就是这个形状）⇒ 少了这两个键，**转发我们自己的卡**
      // 仍然什么都抠不到、只能回"读不到正文"，等于 P6 没修好 CM 报的那条。
      for (const k of ['body', 'header', 'elements', 'fields', 'columns', 'items', 'message_list', 'content', 'title', 'children', 'elements_list']) {
        if (node[k] && typeof node[k] === 'object') walk(node[k], depth + 1)
      }
    }
    walk(parsed, 0)
    return out.join('\n').slice(0, 4000)
  }

  // ---- inbound file inbox (2026-09-09, CM): Feishu file/media messages carry
  // no text, so extractText() returns '' and the old code dropped them
  // silently. Download the resource via the message-resources API and inject a
  // text note with its local path so the agent session can read the file.
  // Destination: bot.fileInbox, else <bot.workspace>/downloaded_files (config
  // driven, never a hardcoded absolute path).
  // 按**文件头**认扩展名（2026-10-03 CM：「修吧」）。
  // 为什么需要：飞书**图片**消息只给 `image_key`、**不给文件名** ⇒ 旧实现写死 'image'，
  // 落盘成 `…_image` 这种"看不出格式"的名字（真机实例：CM 发的截图存成 `2026-10-02-15-52-19_image`，
  // 而内容是 JPEG）。**只认确定无疑的几个魔数**，认不出就 `.bin` —— 不猜、不编。
  function sniffExt(buf) {
    if (!buf || buf.length < 12) return '.bin'
    const hex = (i, n) => buf.slice(i, i + n).toString('hex')
    if (hex(0, 3) === 'ffd8ff') return '.jpg'
    if (hex(0, 8) === '89504e470d0a1a0a') return '.png'
    if (hex(0, 6) === '474946383961' || hex(0, 6) === '474946383761') return '.gif'
    if (hex(0, 4) === '52494646' && hex(8, 4) === '57454250') return '.webp'
    if (hex(0, 2) === '424d') return '.bmp'
    if (hex(0, 4) === '25504446') return '.pdf'
    if (hex(0, 4) === '504b0304') return '.zip'    // 也覆盖 xlsx/docx/pptx（ooxml 就是 zip）
    return '.bin'
  }

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
      const safe = String(fileName || type || 'file').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120)
      // 口径：**已经有扩展名就尊重它**（文件消息带 file_name，pdf/xlsx/pdf 不受影响）；
      //       没有扩展名（图片/语音这类）才**按文件头**补一个。
      const withExt = /\.[A-Za-z0-9]{1,8}$/.test(safe) ? safe : safe + sniffExt(buf)
      // 时间戳用**本地时间**（旧实现用 `toISOString()`＝UTC ⇒ CM 本地 23:52 的图存成 `15-52-19`，
      // 翻目录时对不上时间）。格式 `YYYY-MM-DD-HHMMSS`（秒前不加横杠，一眼能读）。
      const d = new Date()
      const p2 = (n) => String(n).padStart(2, '0')
      const stamp = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
        + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds())
      const path = join(base, stamp + '_' + withExt)
      writeFileSync(path, buf)
      console.log('[fs] inbound file saved: ' + path + ' (' + buf.length + ' bytes)')
      return '📎 收到文件：' + (fileName || withExt) + '\n已保存到：' + path
        + '\n（先只回我一句确认收到即可，等我说要做什么再动它；要读就用文件工具读上面这个路径）'
    } catch (e) {
      console.log('[fs] inbound file handler error: ' + String(e && e.message || e))
      // 同样不许无声：解析/写盘炸了也要让 CM 看到（否则他只会以为"你又不知道"）。
      return '⚠️ 收到一个我没能处理的附件消息：' + String(e && e.message || e)
    }
  }

  // ---- inbound dedup (2026-09-15；2026-10-05 修「多 bot 互相误判重投」) ----------
  // 按 **bot + message_id** 记住最近处理过的入站消息，防"重连重投 / 双 helper"导致整轮重复。
  // ⚠️ 2026-10-05 CM 报障「一条消息里 @ 多个 agent，只有一个回」根因就在这里：
  //    7 个 bot 收进 1 个进程后 `seenInboundIds` 是**实例级**的；同一条群消息会被每个
  //    bot 各收一次，第一个消费掉之后，其余 bot 落到 handleInbound 全被判成
  //    `duplicate inbound skipped` **静默丢弃**（真机：六个 bot 里两个 mentioned=true，
  //    只有一个建了卡，另一个被 duplicate 吞掉）。
  //    去重的本意是防**同一个 bot** 收到重投（长连接 at-least-once / 双 helper），
  //    不是防"别的 bot 也收到同一条群消息"⇒ 键必须带 bot 维度。
  const SEEN_INBOUND_MAX = 200
  const seenInboundIds = new Set()
  function inboundKey(bot, messageId) {
    const id = String(messageId || '')
    if (!id) return ''
    const who = String((bot && bot.cfg && bot.cfg.appId) || (bot && bot.name) || '')
    return who + '|' + id
  }
  function isDuplicateInbound(bot, messageId) {
    const id = inboundKey(bot, messageId)
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
  function inboundAlreadySeen(bot, messageId) {
    const id = inboundKey(bot, messageId)
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
    if (inboundAlreadySeen(bot, evt.message_id)) return true   // 重投：直接吞掉，不重复插话
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
    // ── D5（P1.5 身份注入）· 插话路径也要注入（否则插话进来的那条没有 actor）─────
    //    身份只来自 `evt.sender.sender_id.open_id`（服务端给的、伪造不了）；
    //    认不出**不弹卡片、不问姓名**（CM 2026-10-04）；
    //    拿不到身份 ⇒ 拒绝（CM 2026-10-04 裁决：**无表就拒** —— 执行不了总比资料泄露好）。
    //    🔒 开关 `identityGuard` **默认关**（上游用户不一定需要这个功能）⇒ 关了跳过全部身份逻辑。
    const openId = evt.sender && evt.sender.sender_id && evt.sender.sender_id.open_id || ''
    let identityActor = null
    if (bot.cfg && bot.cfg.identityGuard) {
      try {
        const idc = identityCtx(bot.cfg.workspace || workspaceRoot())
        const r = idc.resolver.resolve(openId)
        identityActor = r.actor
        idc.store.set(entry.agent.id, { actor: r.actor, chatId, messageId: evt.message_id, tableOk: r.tableOk })
        console.log('[fs] identity(steer): agent=' + entry.agent.id
          + ' open_id=' + String(openId).slice(0, 12) + '…'
          + ' -> ' + (r.actor ? ('OK ' + r.actor.name) : String(r.err || 'no_actor'))
          + ' tableOk=' + r.tableOk)
      } catch (error) {
        console.log('[fs] identity(steer) resolve failed (ignored): ' + String(error && error.message || error))
      }
    }
    // P0-3：label/明细统一由 senderLabelFooter 生成（与常规回合同构）。
    const senderMark = senderLabelFooter(bot, evt, identityActor)
    const label = senderMark.label
    const quote = quoteHintFor(evt.parent_id || evt.root_id)
    logQuoteState(evt, quote)
    try {
      entry.agent.steer({
        id: 'fs-' + evt.message_id,
        role: 'user',
        // P0-2/P0-3：发送方明细 + @ 对象明细只进会话文本，不进卡片。
        content: [{ type: 'text', text: label + text + senderMark.footer + (evt.mentionFooter || '') + quote }],
        source: { kind: 'user' },
      })
    } catch (error) {
      console.log('[fs] steer failed, falling back to queue: ' + String(error && error.message || error))
      return false
    }
    // 到这里才算真的投出去了 ⇒ 现在认领 message_id，防止重投被插两次。
    isDuplicateInbound(bot, evt.message_id)
    // 2026-10-02 CM：「我"插话"了以后，你应该新开卡片。不然我说的话全部堆到下面，
    // 但是你一直在旧卡片上更新」⇒ 插话**必须换卡**：复用答题后那套 split()，
    // 旧卡就地封口（留一行指路），后续内容写到下面新卡的第一块（醒目彩色块）。
    try {
      const brief = String(text).replace(/\s+/g, ' ').slice(0, 300)
      const notice = {
        old: { type: 'message', text: '📨 你的消息已插话送达 —— 后续内容见下方新卡。' },
        fresh: { type: 'notice', text: brief },
      }
      // 0.7.21（HIGH-1）：`entry.split` 只有**本代**登记的才可调 —— 热重载之后跨代表里
      //   常留着上一代那条（它那一轮还在跑），调它的后果是"插话换卡换出一张永不更新的卡"。
      //   外代条目改走本代的接管通道 splitAdoptedCard（同样的插话语义），保护不降级。
      const ours = closuresAreOurs(entry)
      if (ours && typeof entry.split === 'function') {
        const ok = entry.split(notice)
        if (ok !== true) {
          console.log('[fs] steer card split skipped (card already sealed); message still delivered')
        }
      } else {
        if (!ours) logForeignClosureSkip('split:steer', String(entry.agent && entry.agent.id))
        if (splitAdoptedCard(entry.agent, notice)) {
          console.log('[fs] steer card split via adopted-card channel')
        } else {
          console.log('[fs] steer card split skipped (no live card this generation); message still delivered')
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
    if (isDuplicateInbound(bot, evt.message_id)) {
      console.log('[fs] duplicate inbound skipped: ' + String(evt.message_id || ''))
      return
    }
    bot.lastChatId = chatId
    // 0.7.17（两模式）：记录 chat 类型（入站事件自带的 chat_type，p2p|group）——
    // 群判据**不信 oc_ 前缀**（2030：飞书单聊与群聊都用 oc_）⇒ 群一律 stable（见 resolveCardMode）。
    // 0.7.19（审查 MED#1-A）：**只在事件真的带 chat_type 时写** —— 内部合成事件（cardfail 报错通知 /
    // 热重载自动续跑）没有这个字段，旧写法 `|| 'p2p'` 会把**已知的群记录覆盖成 p2p** ⇒ 群降级 full
    // ⇒ 过程叙述暴露给群里的员工（用例 66 实测红）。
    if (!bot.chatKinds) bot.chatKinds = new Map()
    if (evt && evt.chat_type) bot.chatKinds.set(chatId, String(evt.chat_type))

    const messageId = evt.message_id
    // P0-2：事件入口已还原过 mentions 的话直接用还原结果（内部合成事件没有该字段，兜底走老路径）。
    let text = typeof evt.textRendered === 'string' ? evt.textRendered : extractText(evt.content)
    if (!text.trim()) {
      const note = await downloadInboundFile(bot, evt)
      if (note) text = note
    }
    if (!text.trim()) {
      // 0.7.9 P6：非文本、非文件的入站（转发卡片 interactive / 合并转发 / 分享名片 / 语音 / 表情…）
      //   旧实现**静默丢弃** ⇒ CM「转发卡片到 dsh，没反应」。
      const kind = String((evt && (evt.msg_type || evt.message_type)) || 'unknown')
      const salvaged = salvageTextFromRich(evt)
      if (salvaged) {
        text = '（飞书**非文本**消息，类型 ' + kind + '；以下是从消息里抽出的正文）\n' + salvaged
        console.log('[fs] inbound rich message salvaged: type=' + kind + ' chat=' + chatId
          + ' message_id=' + String(messageId || '') + ' chars=' + salvaged.length)
      } else {
        // 读不了 ⇒ **必须有可见反馈**（本文件口径：任何"我读不了"都不许静默）
        console.log('[fs] inbound dropped visible: type=' + kind + ' chat=' + chatId
          + ' message_id=' + String(messageId || ''))
        await sendPlainText(bot, chatId, '📎 我收到了一条**非文本**消息（类型 `' + kind + '`），'
          + '但里面没有我能读的正文。\n你可以：① 把要点复制成**文字**发我；'
          + '② 把**文件/图片**直接发我（我能自己下载并读）。')
        return
      }
    }

    // Commands are handled without touching an agent session.
    // 命令解析走**锚点**（与事件入口同一口径，第十三轮 MEDIUM#2）：这里拿到的 text 已还原成
    // `@名字 /stop`，直接 splitCommand 永远判不出命令。内部合成事件没有锚点字段 ⇒ 退回正文本身。
    const cmd = splitCommand(typeof evt.textCommandAnchor === 'string' ? evt.textCommandAnchor : text)
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
    // 审查 LOW#1555：插件**自己注入**的系统提示（卡片失败回执 / 热重载续跑）不是用户回答 ——
    // 否则"有提问卡挂着"时它会被当成回答吃掉，Agent 永远收不到那份回执。
    const pendingQ = (evt && evt._internal) ? undefined : pendingQuestions.get(qKey(chatId, bot))
    if (pendingQ) {
      dropQuestion(pendingQ)
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

    // ── D5（P1.5 身份注入 · 按人判）· CM 2026-10-04 定的三条 ───────────────────
    //  ① 身份【只】来自这里：`event.sender.sender_id.open_id` —— 飞书服务端填的，**伪造不了**；
    //     正文里任何 "[飞书 ou_…]" 都只是旁证（用户能仿造同样的文本），**授权一律不读它**。
    //  ② 认不出**不弹卡片、不问姓名** —— CM 原话：
    //     「不弹卡片啊，你现在都不会认不出人，而且这个链路已经通了，应该直接 ai 处理啊，
    //       为什么还是想着人来介入」⇒ 认人只需 open_id 一个字段。
    //  ③ 🔴 **表不可达 ＝ 认不出 ⇒ 拒（不再放行）** —— CM 2026-10-04 裁决原话：
    //     「**无表就拒应该是最好的，最稳的。因为你执行不了，总比资料泄露好吧**」。
    //     ⚠️ 本条注释原先写的是"表不在本机时记一条日志并**放行**" —— 那是**裁决之前**的旧行为。
    //     实现已经改成 fail-closed（下面 `store.set` **无条件执行** ⇒ 工具侧拿到 `rec` 且 `actor=null`
    //     ⇒ `decideAction({hasOwner:true, actor:null})` ⇒ `deny`，告警区分 `table_unavailable` / `person_unknown`），
    //     但**注释没跟着改** ⇒ 下一个读它的人会以为"表不可达会放行"，把已经修好的东西再改回去。
    //     唯一仍然放行的是**异常路径**（`identityCtx()` 构造抛错 / resolver 抛错 ⇒ 不入 store ⇒ pass-through），
    //     那是"别把本机自己锁死"的兜底；而 `resolver.resolve` 自身【绝不抛】（失败只返回 `{actor:null, err}`），
    //     所以正常的"认不出"走的就是 deny 这条路。
    const openId = evt.sender && evt.sender.sender_id && evt.sender.sender_id.open_id || ''
    let identityActor = null
    // 🔒 身份闸门开关：**默认关**（上游用户不一定需要；CM 2026-10-04）⇒ 关了跳过全部身份逻辑，零开销。
    if (bot.cfg && bot.cfg.identityGuard) {
      try {
        const idc = identityCtx(bot.cfg.workspace || workspaceRoot())
        const r = idc.resolver.resolve(openId)
        identityActor = r.actor
        idc.store.set(agent.id, { actor: r.actor, chatId, messageId, tableOk: r.tableOk })
        console.log('[fs] identity: agent=' + agent.id
          + ' open_id=' + String(openId).slice(0, 12) + '…'
          + ' -> ' + (r.actor ? ('OK ' + r.actor.name + ' source=' + r.actor.source) : String(r.err || 'no_actor'))
          + ' tableOk=' + r.tableOk)
      } catch (error) {
        console.log('[fs] identity resolve failed (ignored): ' + String(error && error.message || error))
      }
    }
    // P0-3：label/明细统一由 senderLabelFooter 生成（与插话路径同构）。
    // 前缀由【服务端算出的 actor】生成；guard 关时 label 只写「用户/机器人」，
    // id 明细进 senderMark.footer（只拼进会话文本）。授权一律不读这些文本。
    const senderMark = senderLabelFooter(bot, evt, identityActor)
    const label = senderMark.label

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
      logQuoteState(evt, quote)
      const message = {
        id: 'fs-' + messageId,
        role: 'user',
        content: [{ type: 'text', text: label + text + senderMark.footer + (evt.mentionFooter || '') + quote }],
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
      // reason: 'tables'（5 表满额）| 'size'（元素/体积接近飞书单卡上限）—— 都是"换卡续写"。
      const rotateTables = (reason, oldText) => {
        if (!stopCardWatcher) return
        if (!card || card.status === 'sealed' || card.status === 'error') return
        const carry = Number.isFinite(card.cursor) ? card.cursor : 0
        stopCardWatcher()
        card.status = 'sealed'
        dropWorkingPlaceholder(card)
        // 0.7.9（CM 2026-10-03 ③）：指路语写在**旧卡**（读者就在这张卡上）；**新卡不带任何指路语**。
        card.blocks.push({
          type: 'message',
          text: oldText || (reason === 'size' ? rotateNoticeSize() : ROTATE_NOTICE_TABLES),
        })
        void syncCard(bot, chatId, card, true).catch(() => {})
        const fresh = makeCardState(turnAgent, card)
        fresh.footerMode = 'bare'      // 换表新卡仍是"过程卡"
        fresh.cursor = carry
        fresh.rotatedThisTurn = true   // P5③：本轮已换过卡 ⇒ 收尾不再另开结论卡
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
        // 0.7.21（HIGH-1）：登记方**代际编号** —— 下面这两个函数是闭包，只有本代能调。
        gen: GEN_ID,
        // notice（可选）：{ old, fresh } —— 插话走这条时，旧卡留一行、新卡顶部放醒目块；
        // 答题路径不传（保持原样「✅ 已收到你的选择，继续处理中…」）。
        // 侧消息换卡通道（P2）：走换卡路径（carry = 旧卡游标），**不是**答题路径的 split()
        rotate: (reason, oldText) => rotateTables(reason, oldText),
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
          // （0.7.21 起与接管卡的 splitAdoptedCard 共用同一个函数。）
          expandTruncatedNotes(turnAgent, card)
          card.blocks.push(notice && notice.old
            ? notice.old
            : { type: 'message', text: ANSWER_POINTER })
          void syncCard(bot, chatId, card, true).catch(() => {})
          // 2) Open a fresh card below for the rest of this turn. Resume the
          // watcher from the CURRENT event position so events already shown
          // on the old card are not replayed onto the fresh one.
          const fresh = makeCardState(turnAgent, card)
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
      // 0.7.10（独立审查 MED#3677）：删掉 `crossedTool` —— 0.7.9 把"跨过工具调用继续收"改成
      // **跨过第一个工具调用就 break**，该变量再也不会被赋成 true（死代码 + 与注释自相矛盾）。
      for (let i = events.length - 1; i >= seqBefore; i--) {
        const event = events[i]
        if (!event) continue
        // 0.7.9（CM 2026-10-03 ②）：**跨过第一个工具调用就停** —— 结论只取"最后一段连续叙述"，
        // 不再把整轮过程话语 join 进 reply（否则结论卡会夹带过程卡的文字）。
        if (event.type === 'tool/call' || event.type === 'tool/result') {
          // 0.7.13（TODO-0710 #2）：**末尾连续的工具事件先跳过**（还没收集到文本时 continue）——
          //   "答复在前、工具在后"的回合旧判据在第一个工具处 break ⇒ spokenBlocks 空 ⇒
          //   narrationOnlyTurn ⇒ 不拆结论卡（结论退到过程卡末尾）。
          //   已有文本后再遇工具 ⇒ 维持 0.7.9 语义（只取"最后一段连续叙述"）。
          if (spokenBlocks.length === 0) continue
          break
        }
        if (event.type !== 'assistant/message') continue
        const spoken = extractProcessText(event.data && event.data.message)
        if (!spoken) continue
        if (isNarrationOnly(spoken)) break
        // 只收"最后一段连续叙述"：一旦已经收到过一段、又碰到没被工具隔开的第二段 ⇒ 停
        if (spokenBlocks.length > 0) break
        if (event.seq !== undefined && spokenSeqs.has(event.seq)) continue
        if (event.seq !== undefined) spokenSeqs.add(event.seq)
        spokenBlocks.unshift({ seq: event.seq, text: spoken })
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
      // 0.7.9 P5③：本轮已经换过卡（表格/体积换卡或热重载续卡）⇒ **结论留在当前卡**，
      // 不再另开一张 —— 否则一轮里会出现"过程卡 + 换卡 + 结论卡"三张（CM 说的"卡片乱发"）。
      const splitConclusion = conclusionEligible && !duplicateConclusion && !card.rotatedThisTurn
      // A 方案：**不分卡**时这张卡本身就是结论卡 ⇒ 升级成完整状态栏；
      // 分卡时它只是过程卡 ⇒ 保持 bare（状态栏由下面新开的结论卡承担）。
      if (!splitConclusion) card.footerMode = 'full'
      let replaced = false
      // 🔴 CM 2026-10-03 P0（真机理，代码实证）：这里原先把 `replySeqs` 覆盖的 note **从过程卡删掉**
      //    （`card.blocks.filter(...)`），而 `replySeqs` 是"从末尾往前扫、**跨过工具调用继续收**"
      //    得来的 ⇒ 一轮里被收进去的叙述可能覆盖**整轮** ⇒ 过程卡被清空成一句指路、
      //    那些文字全部出现在结论卡里。CM 的验收①是"过程卡的文字和步骤**不动**" ⇒
      //    **过程卡只允许追加，绝不允许删块**（正文保住；结论卡仍自包含，代价是两卡重复同一段）。
      if (duplicateConclusion) {
        // 重复链条：**不再重复发送结论**（也不新开卡），只在末尾追加一行指路。
        card.blocks.push({ type: 'message', text: '✅ 本轮已完成，结论见上方卡片。' })
        replaced = true
      } else if (splitConclusion) {
        // 0.7.14（CM 指定 TASK v3「一条回复发两张卡」· B3 总纲）：**把结论段从过程卡搬走** ——
        //   恢复本函数上方英文注释的原设计（promote the last note … so the reply is not duplicated）。
        //   0.7.5 P0 的「绝不删块」防的是**过程叙述被清空**；0.7.9 收紧后 replySeqs 只含最后那段
        //   连续答复、碰不到过程叙述 ⇒ 搬走它不再有副作用。只移 replySeqs 命中的 note，
        //   其余 note（🎯 行/进度旁白）一条不动（B1）。
        const moveSeqs = new Set(replySeqs)
        card.blocks = card.blocks.filter(
          (b) => !(b && b.type === 'note' && b.seq !== undefined && moveSeqs.has(b.seq)))
        card.blocks.push({ type: 'message', text: CONCLUSION_POINTER })
        replaced = true
      } else if (replySeqs.length > 0) {
        // 0.7.17（stable seal）：渲染层隐藏镜像 note ⇒ 去重失去意义；整条答复直接作为 message 上卡
        //（结论可见 = V2）。full 模式走原去重逻辑，一字不改（下方 else 全体原样保留）。
        // 0.7.19（审查 LOW#2）：**当场重解析，不读 card.mode** —— 那是上一次 sync 存下的值，
        // 而紧随其后的渲染（buildCardPayload）每次都会重解析；两帧之间 cfg/chatKinds 变了就错位：
        // seal 按 stable 推了 reply、渲染却按 full 画 ⇒ 同段答复显示两次（反向则答复消失）。
        if (resolveCardMode(bot, chatId) === 'stable') {
          card.blocks.push({ type: 'message', text: reply })
          replaced = true
        } else {
        // 🔴 0.7.9（CM 2026-10-03 ②「过程卡文字突然消失」）：**只追加，绝不覆盖 note、绝不删块**。
        //    旧实现在这里把 replySeqs 命中的 note 覆盖成整段 reply、其余同批 note 全删 ——
        //    而 replySeqs 是"从末尾往前扫、跨过工具调用继续收"得来的（见上方 L3563-3579），
        //    一轮里它能覆盖**整轮**叙述 ⇒ 过程卡的分步叙述被吞成一段（就是"文字消失"的观感）。
        //    这一分支的触发面比 0.7.5 修的分卡路径更宽：**所有 <30s 回合、纯旁白回合、notSpoken 回合**
        //    都走这里（conclusionEligible = !notSpoken && !narrationOnlyTurn && elapsed>=30s）。
        // 0.7.10（独立审查 MED#3799 修正）：**不能按"整段相等"判重** —— 镜像 note 走 appendNote 时会被
        //   `clipNoteText(…, MAX_NOTE_CHARS=500)` 处理，而它**不是纯截断**：它在 500 字附近**按换行切**、
        //   去掉尾部表格行、**补一个 `…`**、还可能把被切掉的 🎯 目的行**前置**到 note 开头 ⇒ 剪过的 note
        //   **不是 reply 的前缀**（我第一版用 startsWith 判，仍然失配 —— 自查时当场发现并改掉）。
        //   判据改为**最长公共前缀**：
        //     · 没被截断（整段已在卡上）⇒ 公共前缀 = 整段 ⇒ 尾部为空 ⇒ 一个字都不追加（零重复）
        //     · 被截断/换行切过 ⇒ 公共前缀 ≈ 500 ⇒ 只补 `…` 之后那半段（不丢字、也不重复前 500 字）
        const replyRaw = String(reply)
        const commonPrefixLen = (a, b) => {
          const n = Math.min(a.length, b.length)
          let i = 0
          while (i < n && a[i] === b[i]) i++
          return i
        }
        // 0.7.11（独立审查 0.7.10：HIGH#3823 / MED#3825 / MED#3819，逐条核对 0 误报）三处修正：
        // ① 「整段已在卡上」（公共前缀 = 整段）必须**显式**判「无需追加」，不受 120 阈值闸限制 ——
        //    否则 <120 字的短回复整段重追加（**最高频**路径，恰是本去重要消灭的重复，HIGH#3823）。
        // ② 归一化会折叠空白（\n\n→空格、首尾 trim）⇒ 归一化长度 ≠ 原文长度；切原文必须用
        //    「归一化下标 → 原文下标」映射（normWithMap 的 ends），不能拿归一化长度直接 slice（MED#3825）。
        // ③ clipNoteText 会把被截掉的 🎯 目的行**前置**到镜像 note 开头（见上方 missing 分支：
        //    `missing… + '\n' + clipped`，0.7.10 注释写"补回末尾"系笔误）⇒ 比较前两侧都要剥掉
        //    前置 🎯 行，否则"🎯 在末尾"的长回复（smoke 28 形状）公共前缀 = 0，整段重追加（MED#3819）。
        // 安全阀：凡这次"不再追加"的部分（前置行、已展示前缀）必须逐段确认真的在卡上；
        // 任何一段查不到 ⇒ 放弃去重整段照发 —— 宁可重复，不可丢字（CM 红线）。
        // 0.7.12（审查 2m+3low 全收）：归一化单一信源（normWithMap 兼供 note 侧）/ onCard 整行比较 /
        //   严格判空 / WS_RE 提升。
        const LEADING_PURPOSE_RE = /^(?:[^\S\n]*(?:[-*][^\S\n]*)?🎯[^\n]*(?:\n|$))+/
        const WS_RE = /\s/
        const normWithMap = (s) => {
          const raw = String(s === null || s === undefined ? '' : s)
          const chars = []
          const ends = []
          let i = 0
          while (i < raw.length) {
            if (WS_RE.test(raw[i])) {
              let j = i
              while (j < raw.length && WS_RE.test(raw[j])) j++
              chars.push(' '); ends.push(j)
              i = j
            } else {
              chars.push(raw[i]); ends.push(i + 1)
              i++
            }
          }
          let a = 0, z = chars.length
          while (a < z && chars[a] === ' ') a++
          while (z > a && chars[z - 1] === ' ') z--
          return { n: chars.slice(a, z).join(''), ends: ends.slice(a, z) }
        }
        const stripLeadingPurpose = (s) => {
          const t = String(s || '')
          const m = t.match(LEADING_PURPOSE_RE)
          return m ? { text: t.slice(m[0].length), stripped: m[0] } : { text: t, stripped: '' }
        }
        const noteTexts = card.blocks.filter((b) => b && typeof b.text === 'string' && b.text).map((b) => b.text)
        const onCard = (line) => {
          const t = line.trim()
          // 0.7.12（审查 MED#3853）：**整行**比较 —— 子串命中会把"卡上有更长的行"误当"这条短目的行已展示"，
          // 在非镜像巧合路径上从尾部丢字（违反"宁可重复，不可丢字"）。
          return Boolean(t) && noteTexts.some((tx) => tx.split('\n').some((l) => l.trim() === t))
        }
        const replyStripped = stripLeadingPurpose(replyRaw)
        const stripOffset = replyStripped.stripped.length
        const rm = normWithMap(replyStripped.text)
        const replyNorm = rm.n
        let shownChars = -1
        for (const b of card.blocks) {
          if (!b || typeof b.text !== 'string' || !b.text) continue
          const nn = stripLeadingPurpose(b.text)
          const n = normWithMap(nn.text).n
          if (!n) continue
          const c = commonPrefixLen(n, replyNorm)
          const fullShown = c === replyNorm.length && replyNorm.length > 0
          // 阈值 120：避免把"一句短旁白恰好与开头相同"误判成"这段已经展示过了"（整段命中不受此限）
          if (!fullShown && c < 120) continue
          const strippedLines = (replyStripped.stripped + '\n' + nn.stripped).split('\n').filter((x) => x.trim())
          if (!strippedLines.every(onCard)) continue
          const rawEnd = c > 0 ? rm.ends[c - 1] : 0
          const abs = fullShown ? replyRaw.length : stripOffset + rawEnd
          shownChars = Math.max(shownChars, abs)
          if (fullShown) break
        }
        let tail
        if (shownChars < 0) {
          tail = replyRaw
        } else {
          // 已在卡上的目的行不随尾部重复（clipNoteText 的 kept/missing 保证它们全部可见过）；
          // 卡上查不到的目的行保留 —— 宁可重复，不可丢字。
          tail = replyRaw.slice(shownChars).split('\n')
            .filter((line) => (/^\s*(?:[-*][^\S\n]*)?🎯/.test(line) ? !onCard(line) : true))
            .join('\n').trim()
        }
        if (tail) card.blocks.push({ type: 'message', text: tail })
        replaced = true
        } // 0.7.17 stable else-end
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
          // 0.7.22（交接清单#2）：结论卡是"内容必须出现"的卡 —— 万一这次推送撞上热重载的
          //   自我拦截（本代已 dispose），把**建卡**这件事一起交给活着的实例做（见 drainCardRelay
          //   的 createIntent），并把兜底正文挂在卡上，建不出来时降级成纯文本也不丢字。
          conclusion.createOnRelay = true
          conclusion.relayFallbackText = reply
          conclusion.relayFallbackCard = card   // 建不出来时结论写回这张过程卡
          await syncCard(bot, chatId, conclusion, true)     // 新消息 = 新卡 ⇒ 飞书会提醒
          // ⚠️ 2026-10-01 审计实测（smoke 34）：`syncCard` **内部把异常吞掉了**
          //    （catch 里只置 `createFailed`／`circuitOpen`，不往外抛）⇒ 建卡失败时这里
          //    依旧会"顺利"走到下面；结果是过程卡写着「结论见下方卡片」、而下面**根本没有那张卡**
          //    （日志特征：`conclusion card opened … card=-`）＝结论只靠纯文本兜底、卡片链条断掉。
          //    ⇒ 必须自己检查 token，未拿到就抛进 catch 走单卡回退。
          //    0.7.22（清单#2）例外：这次推送是**被热重载自我拦截**、已进托孤队列的，
          //    不算"建卡失败"—— 由活着的实例真建，别在这里降级。
          if (!conclusion.token && !hasRelayFor(conclusion)) {
            throw new Error('conclusion card not created (createFailed/circuitOpen)')
          }
          if (!conclusion.token) {
            console.log('[fs] conclusion card handed to next generation: agent=' + turnAgent.id)
          }
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
          card.blocks = card.blocks.filter((b) => !(b.type === 'message' && b.text === CONCLUSION_POINTER))
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
      // 0.7.22（清单#2）：已进托孤队列 = 有活着的实例接手，**不再另发纯文本**（否则同一段
      //   结论出现两次，正是 CM 报过的"一个内容发两次"）。
      cardDelivered = (!!turn.card.token && !turn.card.circuitOpen) || hasRelayFor(turn.card)
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
    // 0.7.22（清单#5 安全项）：凭证不上命令行 —— 走 0600 凭证文件，只把**路径**交给 helper。
    // 0.7.22（独立审查 LOW）：写文件失败时**不再退回 argv**。旧实现只在日志里说一句就照发
    //   `node helper.cjs <appId> <appSecret>` —— 那正是本项要消灭的 `ps aux` 明文暴露，
    //   一次瞬时文件系统错误就能把它降级回来。这里改成 fail-closed（不 spawn）：
    //   会话照常由 API 通道工作，只是 helper 不自启，日志会给出明确的重启方式。
    let credArg = ''
    try {
      credArg = ' --cred ' + quoteArg(writeHelperCred(appId, appSecret))
    } catch (error) {
      console.log('[fs] helper cred file write failed, refusing to spawn '
        + '(启动长连接请手动执行：node helper.cjs --cred <凭证文件路径>；'
        + '禁止把 appSecret 放上命令行): '
        + String((error && error.message) || error))
      // 🔴 0.8.0 第七轮门槛（MEDIUM）：**不要把 spawningAt 清成 0** —— 那是每 bot 的 5 秒
      //   起连冷却（`ensureHelpers` 每 500ms 跑一轮）。清零＝凭证**持续**写盘失败（配置目录
      //   只读等）时变成每 500ms 重试 + 每次刷这条多行日志的无界风暴；保留开头写入的时间戳，
      //   重试节奏自然回到 5 秒一次。顺手清掉 `bot.proc`（此时它指向刚 kill 的死句柄），
      //   与下面 `helper start failed` 那条路径保持一致。
      bot.proc = undefined
      return
    }
    const shellRequest = {
      command: 'node ' + quoteArg(HELPER_PATH) + credArg,
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
        removeHelperCred(appId)
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

  // 身份未解析期间最多扣住多少条群消息（防"永远取不到 open_id"时无界堆积）
  const GROUP_HOLD_MAX = 20

  // 2026-10-04：取本 bot 的 open_id / app_name（群聊"@ 才回复"的判据）。缓存；失败留空。
  // 0.7.21：**并发去重** —— 入站预热和群判据的"扣住等重投"会在同一拍各调一次，
  //   不去重就是每条冷启动群消息白发两个请求；失败时清掉在途标记，下一条允许重试。
  async function ensureBotOpenId(bot) {
    if (bot.botOpenId) return bot.botOpenId
    if (bot.botOpenIdInFlight) return bot.botOpenIdInFlight
    bot.botOpenIdInFlight = (async () => {
      try {
        const accessToken = await tenantAccessToken(bot, bot.cfg.appId, bot.cfg.appSecret)
        const res = await httpJson(
          'https://open.feishu.cn/open-apis/bot/v3/info',
          'GET',
          { Authorization: 'Bearer ' + accessToken },
        )
        const parsed = parseJson(res.text)
        const oid = parsed && parsed.bot && parsed.bot.open_id
        if (typeof oid === "string" && oid) {
          bot.botOpenId = oid
          bot.botAppName = (parsed.bot && parsed.bot.app_name) || ''
          console.log('[fs] bot open_id resolved: ' + oid.slice(0, 12) + ' name=' + bot.botAppName)
        } else {
          console.log('[fs] bot open_id NOT resolved: ' + String(res.text || '').slice(0, 160))
        }
      } catch (error) {
        console.log('[fs] bot open_id fetch failed: ' + String(error && error.message || error))
      } finally {
        bot.botOpenIdInFlight = null
      }
      return bot.botOpenId || ''
    })()
    return bot.botOpenIdInFlight
  }

  // 群聊里这条消息是否 @ 了本 bot。
  // 飞书 mention 的 `id` 有两种形态：① 字符串 open_id ② 对象 {open_id,...}；
  // 且 open_id 是"应用视角"的值（跨应用/跨查询方不同）⇒ 再加 app_name 兜底。
  function isBotMentioned(evt, bot) {
    if (!bot) return false
    const oid = bot.botOpenId || ''
    const bname = bot.botAppName || ''
    if (!oid && !bname) return false
    const list = []
    if (Array.isArray(evt.mentions)) list.push(...evt.mentions)
    if (!list.length && evt.content) {
      try {
        const p = JSON.parse(evt.content)
        if (p && Array.isArray(p.mentions)) list.push(...p.mentions)
      } catch { /* 非 JSON content 无 @ 信息 */ }
    }
    for (const m of list) {
      if (!m || typeof m !== "object") continue
      const raw = m.id
      const cand = typeof raw === 'string' ? raw : ((raw && raw.open_id) || '')
      if (oid && cand && cand === oid) return true
      if (bname && m.name && String(m.name) === bname) return true
    }
    return false
  }
    if (!msg || typeof msg !== 'object') return
    // 2026-10-04：收到任何 helper 消息就预热本 bot 的 open_id/app_name（@ 判据要用）
    if (!bot.botOpenId) ensureBotOpenId(bot).catch(() => {})
    // Raw debug events from the helper's invoke hook are observation-only —
    // the same event is re-emitted by the registered handler right after.
    if (msg.raw) {
      console.log('[fs] helper event (raw debug): ' + msg.eventType)
      return
    }
    if (msg.type === 'event' && msg.eventType === 'im.message.receive_v1') {
      const evt = normalizeEvent(msg.data)
      // 2026-10-04（CM 定的规则）：**群聊里只有 @ 本 bot 才处理**；单聊（p2p）照旧全处理。
      // 为什么：群里多个 bot 彼此都会收到对方的消息，无差别处理就会互相回复 ⇒ 无限互刷
      // （实测两个 bot 在同一群 5 分钟刷出 3666 条事件、上百张卡片）。只认 @ 既止住互刷，
      // 又保留"@ 一下来协作"（人对 bot、bot 对 bot 都靠 @ 触发）。
      // 注意：本块必须位于 `const evt = normalizeEvent(...)` **之后** —— 早于它引用 evt
      //       会抛 `Cannot access 'evt' before initialization`（2026-10-04 踩过，全员不响应）。
      if (String(evt.chat_type) === 'group') {
        const senderType = String((evt.sender && evt.sender.sender_type) || '')
        const mentioned = isBotMentioned(evt, bot)
        if (!bot.botOpenId) ensureBotOpenId(bot).catch(() => {})
        let rawMentions = evt.mentions
        if (!rawMentions && evt.content) {
          try { rawMentions = JSON.parse(evt.content).mentions } catch { rawMentions = undefined }
        }
        console.log('[fs] group msg diag: sender_type=' + senderType
          + ' mentioned=' + mentioned
          + ' botOpenId=' + String(bot.botOpenId || '').slice(0, 16)
          + ' botName=' + String(bot.botAppName || '')
          + ' mentions=' + JSON.stringify(rawMentions || []).slice(0, 260))
        if (!mentioned) {
          // 0.7.21：`!bot.botOpenId` 时这条**不是**"没 @"，而是"还不知道自己是谁"。
          //   直接 return 会让每次重启/热重载后的**第一条群消息即使 @ 了也无声消失**
          //   （真机表现＝"群里 @ 它第一次没反应，第二次才理"）。冒烟实证：移植这道门后
          //   13 条群用例全红，全红在同一条缝上。
          //   修法：身份解析完成前把该 bot 的群消息**按到达顺序扣住**（只有第一条触发取身份，
          //   所以重投顺序＝到达顺序），解析成功后原样重投；**取不到身份**才按"没 @"丢弃
          //   （保持 CM 定的 fail-closed，不放大互刷风险）。
          if (!bot.botOpenId) {
            const held = bot.pendingGroupMsgs || (bot.pendingGroupMsgs = [])
            if (held.length >= GROUP_HOLD_MAX) {
              console.log('[fs] group msg dropped (bot open_id unresolved and hold queue full): '
                + String(evt.message_id || ''))
              return
            }
            held.push(msg)
            console.log('[fs] group msg held pending bot open_id: ' + String(evt.message_id || '')
              + ' queued=' + held.length)
            if (held.length === 1) {
              ensureBotOpenId(bot).then(() => {
                const list = bot.pendingGroupMsgs || []
                bot.pendingGroupMsgs = []
                if (!bot.botOpenId) {
                  console.log('[fs] group msgs dropped (bot open_id unresolved): count=' + list.length)
                  return
                }
                console.log('[fs] replaying held group msgs: count=' + list.length)
                for (const item of list) handleHelperMessage(bot, item)
              }).catch((error) => {
                console.log('[fs] group msg hold failed: ' + String(error && error.message || error))
                bot.pendingGroupMsgs = []
              })
            }
            return
          }
          if (relayAllowance(bot, evt)) {
            // P0-6：opt-in 接力通道放行（默认 self_only 到不了这里；计数/冻结在内部处理）
            console.log('[fs] group msg relayed (groupRelay): ' + String(evt.message_id || ''))
          } else {
            console.log('[fs] group msg without @bot ignored: ' + String(evt.message_id || ''))
            return
          }
        }
      }
      // 0.7.19（审查 MED#1-C）：**早记 chat 类型** —— 命令（/switch 等）在 handleInbound 之前
      // 就从这条链分流走了（`!outcome.turnStarted` 直接 return，见下方 then），永远走不到
      // handleInbound 里的记录 ⇒ 热重载后群的第一条命令必然绕过 stable 门禁（fail-open，
      // 用例 67 实测红：/switch 在群里照常出切换卡）。与 handleInbound 同款守卫：带字段才写。
      if (evt.chat_type) {
        if (!bot.chatKinds) bot.chatKinds = new Map()
        bot.chatKinds.set(evt.chat_id, String(evt.chat_type))
      }
      // Control commands (/stop etc.) bypass the serial chain so they can
      // interrupt a running turn immediately — queuing them behind the turn
      // makes /stop arrive only after the turn finished (2026-08-15).
      // P0-2（0.8.0 互认）：根级 mentions 先解析、占位符先还原，**然后**分两路：
      //   ① 给 agent 的正文用**还原后**的文本（占位符绝不进上下文）；
      //   ② 命令解析用**锚点**（从原始文本剥掉前导 @ 占位符）——第十三轮 MEDIUM#2：
      //      还原后的 `@名字 /stop` 首字符不是 `/`，`splitCommand` 照样判不出命令，
      //      所以群里 `@bot /命令` 此前**一直**是"当普通消息处理"（旧注释声称已修复，
      //      实际没修 —— 现已由用例 97 钉住）。
      const mentionList = normalizeMentionList(evt.mentions)
      const rawText = extractText(evt.content)
      let text = rawText
      if (mentionList.length) {
        text = renderMentions(rawText, mentionList)
        evt.textRendered = text
        evt.mentionFooter = mentionFooter(mentionList)
      }
      evt.textCommandAnchor = commandAnchor(rawText, mentionList)
      // 改造⑤：登记 CM 这条消息，便于他之后引用自己的消息时也能带上下文
      rememberMessage(evt.message_id, 'CM 的消息：' + String(text || '(非文本消息)'))
      const cmd = evt.textCommandAnchor ? splitCommand(evt.textCommandAnchor) : undefined
      // 🔴 第十六轮门槛 MEDIUM（核对为真，而且比那条 finding 的范围更大）：**只有 `resolveCommandName`
      //   认得出的才进命令分支**。旧写法对任何以 `/` 开头的文本都 `handleCommand(...)` + 无条件
      //   `return`，而 `handleCommand` 第一行就是 `if (!resolved) return false`（什么都不做）
      //   ⇒ 认不出的斜杠文本被**静默吞掉**：没有卡、没有回合、连一句回执都没有。
      //   命中形状：群里 `@bot /help2`（命令打错一个字）、手机端 `@张三/李四 今天值班`
      //   （名字紧跟斜杠，锚点第三档剥出 `/李四 …`）、单聊里手打一句 `/tmp/x.txt 看一下`。
      //   内部入口 `handleInbound`（本文件 4914-4924）**早就有正确口径** —— `handled` 为假就
      //   不 return、继续当普通消息处理；真机事件入口缺同一判据 ⇒ 同一条消息走内部有回、
      //   走真机没回（这种"两个入口口径不一致"是静默丢失的温床）。
      //   修法取**同步判据**而不是等 `handleCommand` 回来再决定：未识别的文本原样落到下面
      //   「提问卡 → 插话 → chain」的普通通道，既不会把已知命令执行两遍，也不改变已知命令的行为。
      if (cmd && resolveCommandName(cmd.name)) {
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
      const pendingQ = pendingQuestions.get(qKey(chatId, bot))
      if (pendingQ && text) {
        dropQuestion(pendingQ)
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
        handleCardAction(msg.data, bot)
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
    if (msg.type === 'warn') {
      // helper 的**劝告**（如「凭据走了 argv 明文通道」）不是故障：原先它发 type:'error'
      // ⇒ 这里按 `helper error` 打，运维会当真去查，还会淹没真正的 helper 故障。
      console.log('[fs] helper warn: ' + String(msg.message))
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

  // J（2026-10-03 CM）：「审批卡它是一个**特殊的存在**，点了以后**不应该把旧的内容清掉**，
  //   就应该把**两个按钮那个位置**变成"你已经审批过了"」。
  // ⇒ 所有审批类卡片点完之后：**正文原样保留**，只把 `action` 那一行换成状态行。
  //   （旧实现两处都不对：计划/工具审批卡**直接撤回消息**；审批单卡**整卡重建成两行回执**。）
  function settledActionElements(elements, statusLine) {
    const out = (Array.isArray(elements) ? elements : []).map((el) => (el && typeof el === 'object' ? { ...el } : el))
    const line = { tag: 'markdown', content: String(statusLine || '') }
    // 判据要兼容**三种**动作行写法（本仓历史上都出现过）：
    //   · `tag:'action'`（+actions[]）· `tag:'column_set'`（列里装 button）· 单个 button / interactive_container
    const isActionRow = (el) => {
      if (!el || typeof el !== 'object') return false
      if (el.tag === 'action' || el.tag === 'button' || el.tag === 'interactive_container') return true
      if (el.tag === 'column_set' && Array.isArray(el.columns)) {
        return el.columns.some((c) => Array.isArray(c && c.elements)
          && c.elements.some((e) => e && (e.tag === 'button' || e.tag === 'interactive_container')))
      }
      return false
    }
    for (let i = out.length - 1; i >= 0; i--) {
      if (isActionRow(out[i])) {
        out[i] = line
        return out
      }
    }
    out.push(line)
    return out
  }
  function settledStamp() {
    try {
      return new Date().toLocaleString('zh-CN', { hour12: false })
    } catch { return new Date().toISOString() }
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

  function approvalResultCardPayload(toolName, label, originalElements) {
    const status = '**' + String(label) + '**\n_' + settledStamp() + '_'
    if (Array.isArray(originalElements) && originalElements.length) {
      // J：正文留着，只换按钮行（CM 2026-10-03）
      return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '🔒 需要你的确认' }, template: 'blue' },
        elements: settledActionElements(originalElements, status),
      }
    }
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

  // J（2026-10-03 CM 定稿）：审批卡点完**不再撤回消息**、也不再重建卡 ——
  //   就地 PATCH 同一张卡：**正文原样**，只把 action 行换成「你已经审批过了」。
  //   （旧实现是 DELETE 撤回；撤回失败时走的那条"就地更新"分支调的 `updateApprovalCard` **全文件未定义**
  //    ⇒ 真机一旦撤回失败就会抛 ReferenceError、卡停在原样、还留一条 unhandled rejection。）
  async function updateApprovalCard(bot, record, label) {
    if (!record || !record.cardId) return
    try {
      await updateInteractive(bot, record.cardId,
        approvalResultCardPayload(record.request && record.request.toolName, label, record.elements))
      console.log('[fs] approval card updated in place: '
        + String((record.request && record.request.toolName) || '') + ' -> ' + String(label))
    } catch (error) {
      // 审查 MED#3724：就地更新失败时卡上**按钮还在**、但 token 已被 settle 清掉 ⇒ 再点就是
      // "点了没反应"。补一条纯文本回执（与提问卡/审批单卡两条路一致）：总要有人告诉用户"记下了"。
      console.log('[fs] approval card update failed: ' + String(error && error.message || error))
      const chatId = record.chatId || bot.lastChatId || ''
      if (chatId) {
        void sendPlainText(bot, chatId, '✅ 已记录你的审批：' + String(label || '')).catch(() => { })
      }
    }
  }

  async function dismissApprovalCard(bot, record, label) {
    if (!record || !record.cardId) return
    await updateApprovalCard(bot, record, label)
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
      // J：留一份**原始正文**（点完之后只把 action 行换成状态行，别的原样保留）
      const cardPayload = approvalCardPayload(request.toolName, request.reason, token)
      record.elements = cardPayload.elements
      sendInteractive(bot, chatId, cardPayload)
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
  // 摘要显示多少字。CM 2026-10-04：「摘要不够长啊，能搞长一点吗？」（实测 lens 全是 61 ⇒ 全部撞上限）。
  // 前缀去掉后正文能显示更多，这里给 120 字（约两行）；要调只改这一个数。
  const SWITCH_SUMMARY_CHARS = 120
  // 摘要读取的**单条超时**。CM 2026-10-04 实测：8 条会话里 5 条拿到 `no snapshot …(timeout?)`
  //   ⇒ 1.5 秒对"加载整份会话日志"（几十 MB）太短 ⇒ 放宽到 5 秒。
  const SWITCH_SUMMARY_TIMEOUT_MS = 5000
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

  // 读一份会话日志快照（调用方只用 `{ events }`）。
  // 跨版本策略：**先试 DSH 0.1.6+ 的 `sessionQuery.readSession`，失败再退回旧的 `sessionPersistence.readFrom`**。
  //   2026-10-04 实测（dsh 0.2.0-rc.2）：`dsh-session-persistence` 里**已无 `readFrom`**
  //   ⇒ 旧调用必然失败 ⇒ `/switch` 每条会话后面的「首条消息摘要」**一直是空的**（被 catch 吞掉，静默）。
  //   思路来自外部 PR #1（作者 j4y89tnywy），本实现【在其基础上放宽了 `sp` 为空的限制】：
  //   新接口只用 `sessionQuery`、不需要 `sp` ⇒ 即使持久化服务已改名/缺失，摘要也能读到。
  async function readSessionLog(sp, sessionId) {
    const sq = ctx.get('sessionQuery')
    if (!sq || typeof sq.readSession !== 'function') {
      // 可见诊断：区分「服务名不对/未注册」与「接口调用失败」——
      // 这两者的现象都是"摘要为空"，但修法完全不同（前者要换服务名，后者要修调用）。
      console.log('[fs] switch: sessionQuery unavailable (got=' + (sq ? typeof sq : 'null')
        + ', hasReadSession=' + Boolean(sq && sq.readSession) + ')')
    }
    if (sq && typeof sq.readSession === 'function') {
      try {
        const snap = await sq.readSession(sessionId)
        if (!snap || !Array.isArray(snap.events)) {
          // 诊断：区分「返回 null」「缺 events 字段」「events 不是数组」——三者修法不同。
          // （CM 2026-10-04 实测：8 条会话里 5 条拿不到快照，而超时阈值当时只有 1.5 秒。）
          console.log('[fs] switch: readSession odd shape for ' + sessionId
            + ' got=' + (snap === null ? 'null' : typeof snap)
            + (snap && typeof snap === 'object' ? ' keys=' + Object.keys(snap).join('|') : '')
            + ' eventsType=' + (snap ? (Array.isArray(snap.events) ? 'array' : typeof snap.events) : '-'))
        }
        if (snap && Array.isArray(snap.events)) return snap
      } catch (error) {
        console.log('[fs] switch: sessionQuery.readSession failed for ' + sessionId + ': '
          + String(error && error.message || error))
      }
    }
    if (sp && typeof sp.readFrom === 'function') return sp.readFrom(sessionId, 0)
    return undefined
  }

  // 首条用户消息（摘要）：只对**体积可控**的日志读，绝不为列个表去解析几百 MB 的历史。
  // ⚠️ 2026-10-04（**第四层**，也是真正一直在静默返回的那层）：**改为接收 `sessionId` 而不是 `meta`** ——
  //   调用方在"只有活会话、没有持久化快照"的行上 `meta` 为 undefined（见 buildSessionRows 里的注释），
  //   而本函数开头 `if (!meta || !meta.id) return ''` ⇒ **立刻返回、连一条日志都没有**（纯静默）。
  //   新接口 `sessionQuery.readSession(sessionId)` 只需要会话 id ⇒ **根本不需要 meta**，
  //   所以这里的 meta 依赖纯属历史包袱。三处静默返回也都补上了可见诊断。
  async function firstUserText(sp, sessionId, size) {
    if (!sessionId) {
      console.log('[fs] switch: summary skipped (no sessionId)')
      return ''
    }
    if (Number.isFinite(size) && size > SWITCH_SUMMARY_MAX_BYTES) {
      console.log('[fs] switch: summary skipped for ' + sessionId + ' size=' + size + ' > ' + SWITCH_SUMMARY_MAX_BYTES)
      return ''
    }
    try {
      const pending = Promise.resolve(readSessionLog(sp, sessionId))
      pending.catch(() => {})                       // 超时后仍会 reject：先挂上处理器
      const raced = await Promise.race([
        pending,
        new Promise((resolve) => { setTimeout(() => resolve(undefined), SWITCH_SUMMARY_TIMEOUT_MS) }),
      ])
      if (!raced || !Array.isArray(raced.events)) {
        console.log('[fs] switch: no snapshot for ' + sessionId
          + ' raced=' + (raced === undefined ? 'undefined(timeout?)' : typeof raced))
        return ''
      }
      // CM 2026-10-04 决策：**摘要用【最近一句】，不用第一句** ——
      //   ① 会话标题本来就是按开头/主题生成的 ⇒ 摘要再用第一句＝重复；最近一句才互补；
      //   ② 认出会话靠的是"我刚在聊什么" ⇒ 长会话里第一句早忘了，最近一句才是记忆锚点。
      //   实现：**从后往前扫，命中即返回**（即最后一条真实用户消息）。
      for (let i = raced.events.length - 1; i >= 0; i--) {
        const ev = raced.events[i]
        if (!ev || ev.type !== 'user/message') continue
        // ⚠️ 两种事件结构都要兼容（2026-10-04 实测差异）：
        //   · 旧 `sessionPersistence.readFrom`：{ type, data: { source, content: [{ text }] } }
        //   · 新 `sessionQuery.readSession`：payload 就是 UserMessage 本体（**不一定有 `data` 包装**）
        const d = (ev.data && typeof ev.data === 'object') ? ev.data : ev
        const src = (d && d.source) || {}
        if (src.kind && src.kind !== 'user') continue
        const raw = (d && d.content) || (d && d.message && d.message.content) || []
        let text = (Array.isArray(raw) ? raw : [])
          .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        // 去掉【插件自己加的投递前缀】（`[飞书 ou_…] ` / `[飞书 姓名] ` / `[飞书消息] `）——
        // 那是给人看的标记，**不该占据摘要**（CM 2026-10-04：「它显示的是飞书开头的那串代码」）。
        text = text.replace(/^\[飞书[^\]]*\]\s*/, '')
        // 0.8.0 互认的两条**明细行**（【发送方】/【本条 @ 的对象】）同理只该进模型上下文：
        //   它们被拼进会话文本后会持久化成 user/message，而摘要只剥开头前缀的话，
        //   尾巴上的 `kind=… open_id=…` 会跟着短消息一起显示到 /switch 卡片的灰字上
        //   （第五轮门槛 MEDIUM）。上面的 /\s+/ 归一已把换行折成空格，故按空格版匹配；
        //   末尾的「（你在引用这条消息…）」是有效上下文，**保留**，所以只削到它为止。
        text = text
          .replace(FOOTER_STRIP_RE, '')
          .trim()
        if (text) return text.length > SWITCH_SUMMARY_CHARS ? text.slice(0, SWITCH_SUMMARY_CHARS) + '…' : text
      }
      // 一条**可见诊断**：本会话里一个 user/message 的正文都没取到时，把实际见到的事件类型打出来。
      // （避免再次出现"摘要为空但日志全绿"的静默失败）
      const kinds = {}
      for (const ev of raced.events) { const t = (ev && ev.type) || '?'; kinds[t] = (kinds[t] || 0) + 1 }
      console.log('[fs] switch: no user text for ' + sessionId
        + ' events=' + raced.events.length + ' types=' + JSON.stringify(kinds).slice(0, 220))
    } catch (error) {
      console.log('[fs] switch: summary read failed for ' + sessionId + ': ' + String(error && error.message || error))
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
    // 2026-10-04（CM 选定方案 B）：**改为"所有行都取摘要"** ——
    //   原先是 `filter(r => !r.title)`，只有【没标题】的会话才去读；而 DSH 现在几乎每个会话都有标题
    //   ⇒ need 恒为空 ⇒ 首条消息摘要**从来没被读过**（CM 实测：「显示的是标题，但是没有显示会话内容」）。
    //   上限仍是 8 条（读盘开销由它兜住，未变）。
    const need = rows.slice(0, 8)
    if (need.length) {
      const sp = ctx.get('sessionPersistence')
      // ⚠️ 传 `r.sessionId`（**不是 `r.meta`**）—— meta 在"只有活会话"的行上是 undefined，
      //   而 firstUserText 原先第一行就 `if (!meta …) return ''` ⇒ **摘要从不产生、且连日志都没有**
      //   （2026-10-04 找到的第四层，也是这次"改了三刀仍无摘要"的真正原因）。
      const texts = await Promise.all(need.map((r) => firstUserText(sp, r.sessionId, r.size)))
      console.log('[fs] switch: summary fill need=' + need.length
        + ' lens=[' + texts.map((t) => (t ? String(t).length : 0)).join(',') + ']')
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
      // 2026-10-04（CM 选定方案 B）：**标题在按钮上，首条消息摘要另起一行灰色小字**。
      //   原实现是 `title || summary` 二选一 ⇒ 标题非空时永远看不到摘要（CM：「没有显示会话内容」）。
      //   出卡前会经 sanitizeCardElements → sanitizeMarkdownForFeishu 统一清洗 ⇒ 这里不必手工转义。
      const sub = row.summary ? '<font color=\'grey\'>' + clipSessionName(row.summary) + '</font>' : ''
      const blocked = row.live && !row.inChat && !row.current
      if (j > 0) elements.push({ tag: 'hr' })      // CM：会话之间要分隔线
      if (blocked) {
        // 不能切换的行**不给按钮**（给了只会点出一句"不能接管"），用一行文字写清
        elements.push({
          tag: 'markdown',
          content: n + '. **' + what + '**　<font color=\'grey\'>🟡 正在别处运行，不能切换</font>'
            + (sub ? '\n' + sub : ''),
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
      if (sub) elements.push({ tag: 'markdown', content: sub })
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
    // 0.7.19（审查 LOW#4）：F6 的 stable 门禁原来只拦**文字命令** /switch —— 这里是切换卡的
    // **按钮回调**，同一能力的另一入口，stable 下同样拒绝（正常路径拿不到切换卡，但
    // fail-open 场景曾经放行过一次 ⇒ 按钮路径必须自己也有一道门，不能依赖上游没漏）。
    if (resolveCardMode(bot, chatId) === 'stable') {
      console.log('[fs] switch card action refused: stable mode chat=' + chatId)
      return
    }
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
  // 飞书原本切不了模型（只有 GUI 有那个面板）。语义与 GUI **同源**，不自己发明。
  // 🔴 2026-10-05 把这段口径按**宿主源码 + 本机运行日志**重写（原来写的两条都不成立，
  //   属于 A24「无出处的断言」：把内部类的方法当成了服务方法，于是代码恒走兜底、恒报成功）：
  //   · 列可选：`ctx.llm.listProviders()` → `listModels(provider.id)`（与 GUI 的
  //     `buildModelCatalog` 同源：`dsh-api-session-controller/lib/types/catalog.js`）；
  //     但要去掉本机 profile 插件 dsh-vision-router 挂的 `<provider>-vision` 影子路由
  //     （见 isVisionShadowRoute 的取证）。
  //   · 取当前：`ctx.sessionProjections.stateOf(agent.session, 'modelSelection')`
  //     → `pending ?? lastUsed`（宿主 `selectionFor().current` 的同源口径），退回 `agentDefaultModel`。
  //   · 切换　：`await sessionController.selectModel({ sessionId, provider, model })`
  //     —— 宿主 GUI 走的就是它：内部 `llm.resolveCallConfig` 归一化+校验 → `agents.selectForNextRequest`
  //     改到**活 agent** 上 → 顺带存默认；不行就抛 `session/model-unavailable`。
  //     ⚠️ `selectForNextRequest` / `selectionFor` 都在**内部类** `ApiSessionAgentController`
  //     （服务的 `this.agents`）上，`ctx.get('sessionController')` 那个服务对象**没有**这两个方法。
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

  // 「当前模型」读**会话投影**，不读全局默认。
  // 🔴 CM 2026-10-05 取证（output/dsh-install/web.log）：点了三次卡片，卡上的
  //   `current=` 三次都是 `{"provider":"zai","model":"GLM-4.5-Air"}` —— 正是 profile 里
  //   `agent-default-model` 配的全局默认值。原来这里先试 `sessionController.selectionFor(agent)`，
  //   而 `selectionFor` 长在**内部** `ApiSessionAgentController`（`this.agents`）上，
  //   `ctx.get('sessionController')` 那个服务对象只有 create/selectModel/modelCatalog 等
  //   远程方法（typert: service='sessionController'）⇒ 那一支**永远走不到**，静默退回全局默认，
  //   于是卡面永远显示默认模型、看不出切换有没有生效。
  //   改读宿主的 `modelSelection` 投影（`dsh-api-session-controller/lib/types/
  //   model-selection-projection.js`）：`pending`＝已选但还没用上的，`lastUsed`＝上一次请求真用的
  //   ⇒ 与宿主 `selectionFor().current` 同源口径（picked ?? 请求头 ?? 默认）。
  function currentModelOf(agent) {
    try {
      const sp = ctx.get('sessionProjections')
      const session = agent && agent.session
      const st = sp && session && typeof sp.stateOf === 'function'
        ? sp.stateOf(session, 'modelSelection') : undefined
      const sel = st && (st.pending || st.lastUsed)
      if (sel && sel.provider) return { provider: sel.provider, model: sel.model }
    } catch { }
    try {
      const dm = ctx.get('agentDefaultModel')
      const sel = dm && typeof dm.currentSelection === 'function' ? dm.currentSelection() : undefined
      if (sel && sel.provider) return { provider: sel.provider, model: sel.model }
    } catch { }
    return null
  }

  // 🔴 CM 2026-10-05：「自动视图（卡上写作 `X + 自动识图`）先把它删掉」。
  // 取证（本机 dsh web 日志 output/dsh-install/web.log）：一张 /model 卡列出 8 段
  //   `deepseek-official=2, mimo-vision=1, zai-coding-cn-vision=3, deepseek-vision=2,
  //    mimo=1, zai-coding-cn=3, zai=1, zai-vision=1`
  //   —— 后四段不是宿主的 provider，是 profile 插件 **dsh-vision-router** 给每条真路由
  //   再挂的影子路由：`twinRoute = <provider>-vision`（其 index.js:1249），显示名固定拼成
  //   `<源名> + 自动识图`（同文件 1087/1275），包装路由默认 id `deepseek-vision`（:166）。
  //   ⇒ 同一批模型在卡上出现两遍，这才是「模型名称重复了两次」的真根因；上一轮按 provider
  //   分组只把重复**摆整齐**了，没把重复**去掉**。
  // 判据照抄该插件自己的约定（后缀 / 字样），不猜别的形状；服务器那台没装这个插件 ⇒ 过滤为空操作。
  const VISION_SHADOW_SUFFIX = '-vision'
  const VISION_SHADOW_MARK = '自动识图'
  function isVisionShadowRoute(providerId, providerName) {
    return String(providerId || '').endsWith(VISION_SHADOW_SUFFIX)
      || String(providerName || '').indexOf(VISION_SHADOW_MARK) >= 0
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
        if (isVisionShadowRoute(pid, p && p.name)) {
          // 🔴 第十四轮门槛 LOW（判据是「命名巧合」，真路由命中同样形状会被无声摘掉）：
          //   留痕必须**带得上命中的是哪一条**，否则用户侧只看到「模型凭空消失」而日志查不出所以然。
          console.log('[fs] /model: 跳过视觉影子路由 id=' + String(pid)
            + ' name=' + String(p && p.name || '')
            + ' 判据=' + (String(pid).endsWith(VISION_SHADOW_SUFFIX) ? 'id 后缀 ' + VISION_SHADOW_SUFFIX
              : '显示名含「' + VISION_SHADOW_MARK + '」') + '（源自 dsh-vision-router 的 <provider>-vision 影子路由）')
          continue
        }
        let models = []
        try { models = (await llm.listModels(pid)) || [] } catch { models = [] }
        for (const m of models) {
          const mid = m && (m.id || m.name)
          // providerName：宿主 provider 路由的显示名（GUI 分组标题用的就是它，见下方 modelCardPayload）。
          if (mid) out.push({ provider: pid, providerName: (p && p.name) || pid, model: mid, label: (m && m.name) || mid })
        }
      }
    } catch (error) {
      console.log('[fs] /model 列表失败: ' + String(error && error.message || error))
    }
    return out
  }

  // 🔴 分组不是装饰，是**语义**：宿主允许同一条 model id 挂在多条 provider 路由上
  // （`dsh-llm` 只在**单个 provider 内**去重并抛 INVALID_CATALOG，跨 provider 不去重），
  // 宿主 GUI 因此按 provider 分组渲染（`dsh-api-session-controller/lib/types/catalog.js`
  // 的 buildModelCatalog 返回 kind='group' + group.name）。本卡早期把这些**拉平成一层按钮、
  // 标题只写 model 名** ⇒ CM 2026-10-05 实测「模型名称重复了两次」。改法与 GUI 同源：
  // 一个 provider 一段，段标题给 provider 显示名，按钮 value 仍是 provider|model（切换逻辑不动）。
  function groupChoicesByProvider(choices) {
    // 段标题直接进 lark_md 的 `**…**`，而 `providerName` 来自宿主 `listProviders()` 的
    // `p.name`（第八轮门槛 LOW）：不受我们控制 —— 可能是非字符串（拼进模板变
    // `[object Object]`）、可能带 `*`/`_`/换行（把标题排版顶穿）。
    // ⇒ 非字符串一律当"没有显示名"（回退 provider id，而不是拼出 `[object Object]`），
    //   字符串则剥掉 lark_md 元字符 + 折行，全空再回退 provider id。
    const label = (v) => (typeof v === 'string'
      ? v.replace(/[*_~`<>]/g, '').replace(/[\r\n]+/g, ' ').trim() : '')
    const order = []
    const byId = new Map()
    for (const c of choices) {
      let g = byId.get(c.provider)
      if (!g) {
        g = { provider: c.provider, name: label(c.providerName) || label(c.provider) || '（未命名路由）', items: [] }
        byId.set(c.provider, g)
        order.push(g)
      }
      g.items.push(c)
    }
    return order
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
    for (const g of groupChoicesByProvider(choices)) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: '**' + g.name + '**' } })
      const actions = g.items.map((c) => {
        const isCur = current && current.provider === c.provider && current.model === c.model
        return {
          tag: 'button',
          text: { tag: 'plain_text', content: (isCur ? '▶ ' : '') + c.model },
          type: isCur ? 'primary' : 'default',
          value: { fs_model: c.provider + '|' + c.model },
        }
      })
      for (let i = 0; i < actions.length; i += 2) elements.push({ tag: 'action', actions: actions.slice(i, i + 2) })
    }
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '点一下即切换；也可发文字：`/model <provider>/<model>`' } })
    return { config: { wide_screen_mode: true }, elements }
  }

  // 切换结果**写回同一张卡**（CM 2026-10-05：「点击了，卡片不懂但是发一条提示，卡片应该更新成
  // 已经切换到XX模型的提示，不是另外发卡片」）—— 与 /switch 的 buildSwitchResultCard 同口径：
  // 终态卡**不带任何按钮**，要再切就重发 `/model`。
  // 形状跟着本卡走 1.0（`header` + 顶层 `elements`，与审批单卡同源、已在生产验证），
  // 不套 `buildSwitchResultCard` 的 2.0（`body.elements`）：PATCH 是整条 content 替换，
  // 拿 2.0 去盖一张 1.0 卡是没验过的形状，没必要在这里冒险。
  function modelResultCardPayload(kind, message) {
    const ok = kind === 'ok'
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: ok ? '✅ 已切换模型' : '⚠️ 没能切换模型' },
        template: ok ? 'green' : 'orange',
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: message } },
      ],
    }
  }

  async function sendModelPicker(bot, chatId, agent) {
    const current = currentModelOf(agent)
    const choices = await listModelChoices()
    console.log('[fs] /model: choices=' + choices.length
      + ' providers=' + groupChoicesByProvider(choices).map((g) => g.provider + '=' + g.items.length).join(',')
      + ' current=' + JSON.stringify(current))
    await sendInteractive(bot, chatId, modelCardPayload(choices, current))
    if (choices.length === 0) {
      await sendPlainText(bot, chatId, '（模型清单为空 —— 见上一条卡的说明；仍可用 /model <provider>/<model> 直切）')
    }
    return choices
  }

  // 🔴 CM 2026-10-05：「我在这个卡片里面去切换模型，现在切换失败的，就是没有切换成功过」。
  // 取证（本机 dsh web 日志 output/dsh-install/web.log，三次真实点击）：
  //   `[fs] /model click: zai|GLM-4.5-Air … agent=fs-main-muv8bkcg`
  //   `[fs] /model: append(model/selection) zai/GLM-4.5-Air agent=fs-main-muv8bkcg`
  //   —— 每一次都走 `append` 那条兜底，**一次都没走成** `selectForNextRequest`，
  //   而卡上「当前」始终是全局默认值（见 currentModelOf 的取证）。
  // 根因：`ctx.get('sessionController')` 拿到的是**远程服务对象**，它只有
  //   create / selectModel / modelCatalog / prompt … 这些方法（typert: service='sessionController'）；
  //   `selectForNextRequest` 长在**内部**的 `ApiSessionAgentController`（服务的 `this.agents`）上
  //   ⇒ `typeof sc.selectForNextRequest === 'function'` 恒为 false ⇒ 恒降级成
  //   `agent.session.append('model/selection', …)`。而 append 只写**持久事件**：
  //   活 agent 的选择状态早在建会话时就被 `installModelSelection` 装好了
  //   （`selectionFor()` 命中缓存的 `this.selections`，只有 `selectForNextRequest` 会改它的
  //   `picked`）⇒ 事件写进去了，下一次请求照用旧模型。**却回了「✅ 已切换」＝假成功**。
  // 修法：走宿主 GUI 同一条路 `sessionController.selectModel({sessionId, provider, model})`
  //   —— 它内部先 `llm.resolveCallConfig` 归一化并校验、再 `agents.selectForNextRequest(agent, …)`
  //   真正改到活 agent 上、顺带存默认；不可用时抛 `session/model-unavailable`
  //   ⇒ 成功/失败都是**宿主说了算**，本函数不再有"看起来成功了"的分支。
  //   兜底 append 直接删掉：留着它就等于留一条永远报喜不报忧的路（A25／假绿灯）。
  async function switchModelForAgent(agent, provider, model) {
    const sc = ctx.get('sessionController')
    if (!sc || typeof sc.selectModel !== 'function') {
      throw new Error('宿主没有暴露 sessionController.selectModel（这台 dsh 版本切不了模型）')
    }
    // agent.id 就是 sessionId（宿主 `ctx.sessions.get(agent.id) === agent.session`；
    // 本机 ~/.dsh/sessions/--P-Qoder-work--/fs-main-muv8bkcg/ 与日志里的 agent=fs-main-muv8bkcg 同名可证）。
    const res = await sc.selectModel({ sessionId: agent.id, provider, model })
    // 🔴 第十四轮门槛 MEDIUM：宿主 resolve 了但**没回带 `selected`** 时，原来这里把
    //   **请求值**当成**宿主确认的结果**回显（日志打 `selectModel ok`、卡片回「✅ 已切换为 …」）
    //   —— 正是本轮要消灭的"假成功"形状；宿主若做了归一化（把请求的 model 归到别的 id），
    //   还会把一个**没生效的名字**报成已生效。⇒ 两条来源分开：有 `selected` 才算确认。
    //   不确认时**不谎报成功也不谎报失败**：如实说"宿主没回带确认"，并让用户用 `/model` 自查。
    const sel = res && res.selected
    const out = sel
      ? { provider: sel.provider, model: sel.model, confirmed: true }
      : { provider, model, confirmed: false }
    console.log('[fs] /model: selectModel ' + (out.confirmed ? 'ok' : 'ok-but-unconfirmed')
      + ' ' + String(out.provider) + '/' + String(out.model)
      + ' session=' + String(agent.id)
      + (out.confirmed ? '' : '（宿主响应里没有 selected，回显的是请求值）'))
    return out
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

  // 卡片回调的**发起会话**校验。
  // 背景（0.7.22 坑 2 的修法留下的口子）：提问卡/审批单原来按 `chatId` 单键查找，
  // 同群两个 bot 时会互相抢答案 ⇒ 改成按卡里的 `token`（randomUUID）查。
  // 但 token 只回答“这是哪一张卡”，不回答“点的人该不该算”：卡被**转发**到别的会话后，
  // 那条新消息带着同一个 `value`，在那边点一下照样能答掉原会话这张单。
  // ⇒ 两个判据都要：token 认卡，`record.chatId` 认会话。命中不一致时**可见地**拒绝
  //   （不许静默吞点击，与 stale 卡那条同口径）。
  // 🔴 第十一轮 LOW#5：`bot` 由调用方传**连接自带的 `evtBot`**。原来这里用
  //   `findBotForChat(chatId)` 猜"哪个 bot 来说这句拒绝" —— 正是本次改动在点击者取数
  //   上刚否掉的同源形状（单实例多 bot 同群 ⇒ 返回该群配置里的第一个 bot），
  //   拿错应用身份发消息 = 又造一次 0.7.22 坑 2。传不到才降级去猜。
  function cardClickOutsideOriginChat(record, chatId, bot) {
    if (!record || !record.chatId || !chatId || record.chatId === chatId) return false
    console.log('[fs] card click ignored (not the originating chat): card='
      + record.chatId + ' click=' + chatId)
    const ownerBot = bot || findBotForChat(chatId)
    if (ownerBot) {
      sendPlainText(ownerBot, chatId, '⚠️ 这张卡不是在**本会话**发起的（转发过来的卡在这里点不动）。'
        + '请回到原来的会话点，或让 AI 在这个会话重新发一张。').catch(() => {})
    }
    return true
  }

  function handleCardAction(data, evtBotFromConn) {
    console.log('[fs] card action event received: tag=' + (data && data.action && data.action.tag || '?'))
    const action = data && data.action ? data.action : {}
    const value = action.value || {}
    // P2（0.8.0 互认）：先把**点击者**取出来并留痕 —— 下面每条把选择写回会话的落点
    // 都带上这个标注（认不出名字也要带 id，绝不静默丢点击者身份）。
    const evtChatId = data && data.context ? String(data.context.open_chat_id || '') : ''
    // 点击者名字要用**收到这条事件的那个 bot** 的视角去查目录（open_id 是应用视角值）。
    // 单实例多 bot 同群时 `findBotForChat(chatId)` 只会返回该群配置里的**第一个** bot
    // （第六轮门槛 LOW：按会话猜身份 = 0.7.22 坑 2 的同源形状）⇒ 优先用连接自带的 bot。
    const evtBot = evtBotFromConn || (evtChatId ? findBotForChat(evtChatId) : undefined)
    const clickerTag = clickerTagFor(evtBot, data)
    // `clickerRef` = 只给 **agent**（工具结果/答案对象）的那一份，带完整 open_id；
    // `clickerTag` 会继续出现在卡片追加文本和日志上，那份保持截断。
    const clickerRef = clickerTagFor(evtBot, data, true)
    {
      const op = data && data.operator ? data.operator : {}
      console.log('[fs] card action operator: ou=' + String(op.open_id || '').slice(0, 12)
        + ' union=' + String(op.union_id || '').slice(0, 10)
        + ' who=' + (clickerTag || '（事件里没有 operator）'))
    }
    // 演示/候选卡片的「✕ 取消」：把**这张**消息直接删掉 —— 让 CM 真能体验"一按取消就撤销"
    // （正式卡片的取消走 fs_level='cancel' + pendingSwitchCards 里的 message_id）。
    if (value.fs_demo_cancel) {
      const chatId = data && data.context && data.context.open_chat_id
      const msgId = data && data.context && data.context.open_message_id
      // 🔴 同 `fs_switch` / `fs_model` 两条：要删的是**这张被点的卡**那条消息 ⇒ 必须用收到
      //   事件的连接 bot（`evtBot` 内部已带「按会话猜」的兜底），否则同实例两 bot 时恒取
      //   配置第一个 ⇒ 跨应用删别人的消息真机必被拒。
      const ownerBot = evtBot
      console.log('[fs] demo card cancel: chat=' + String(chatId || '') + ' msg=' + String(msgId || ''))
      if (ownerBot && msgId) {
        void deleteMessage(ownerBot, msgId).then((okDel) => {
          if (!okDel) console.log('[fs] demo card cancel failed (delete rejected)')
        })
      }
      return
    }
    // Model-switch buttons (the /model card) — CM 2026-10-02；2026-10-05 改成原地更新同一张卡。
    if (value.fs_model !== undefined) {
      const chatId = data && data.context && data.context.open_chat_id
      // 🔴 用**收到这条事件的那个 bot**（连接自带），不按会话猜：单实例多 bot 同群时
      //   `findBotForChat(chatId)` 只返回该群配置里的第一个 bot（第六轮 LOW／第十一轮 LOW#5 同源形状）。
      //   这次尤其要命 —— 下面要 PATCH 的正是**这个 bot 自己发出去的那条卡片消息**，
      //   拿别的应用身份去 PATCH 必被拒（消息不属于它），表现就是"点了卡片不动"。
      // 🔴 第二十轮门槛 LOW（核对为真）：原来这里还挂着 `|| (chatId ? findBotForChat(chatId) : undefined)`，
      //   与同文件 `fs_switch` 支（第十九轮删掉兜底的那处）是**同一个形状**。它惰性可证：
      //   本分支的 `chatId` 与上面 `evtChatId` 读的是同一个 `data.context.open_chat_id`，
      //   而 `evtBot` 内部已经用同一个 id 调过 `findBotForChat` ⇒ `evtBot` 为空时那截兜底必然也为空。
      //   第十九轮删掉 `fs_switch` 那处时的判据（「按会话猜 ⇒ 恒取第一个 bot，留着更坏」）在这里同样成立，
      //   ⇒ 同判据不能只落一处，一并删净。
      const ownerBot = evtBot
      // 被点的这张卡的 message_id：结果直接写回它（与「✕ 取消」删卡用的是同一个字段）。
      const clickedCardId = data && data.context ? String(data.context.open_message_id || '') : ''
      const chat = ownerBot && chatId ? ownerBot.chats.get(chatId) : undefined
      const parts = String(value.fs_model).split('|')
      const provider = parts[0]
      const model = parts[1]
      if (!chatId || !ownerBot) return
      // CM 2026-10-05：「卡片应该更新成已经切换到XX模型的提示，不是另外发卡片」
      //   ⇒ 成功/失败都 PATCH 这一张；只有拿不到 message_id 或 PATCH 被拒时才退回发文本
      //   （绝不允许"点了没反应"）。
      const replyInCard = async (kind, message) => {
        if (clickedCardId) {
          try {
            await updateInteractive(ownerBot, clickedCardId, modelResultCardPayload(kind, message))
            return
          } catch (error) {
            console.log('[fs] /model card patch failed, falling back to a text reply: '
              + String(error && error.message || error))
          }
        }
        await sendPlainText(ownerBot, chatId, (kind === 'ok' ? '✅ ' : '⚠️ ') + message)
      }
      // 2026-10-02：卡片点击也走 commandAgent（活会话 → resume），空闲久了点击同样生效。
      void (async () => {
        const agent = await commandAgent(ownerBot, chat)
        console.log('[fs] /model click: ' + String(value.fs_model) + ' chat=' + String(chatId)
          + ' agent=' + String(agent && agent.id || 'none') + ' card=' + (clickedCardId || '（事件没给 message_id）'))
        if (!agent || !provider || !model) {
          await replyInCard('warn', '当前没有可用会话（先发一条普通消息建立会话，再 /model）。')
          return
        }
        try {
          const sel = await switchModelForAgent(agent, provider, model)
          if (sel.confirmed) {
            await replyInCard('ok', '已切换为 `' + sel.provider + '/' + sel.model
              + '`（按会话生效，下一次请求开始用）。要再切就发 `/model`。')
          } else {
            // 宿主收了请求但**没回带确认** ⇒ 不拿请求值冒充已生效（第十四轮门槛 MEDIUM）。
            await replyInCard('warn', '切换请求已发给宿主（`' + sel.provider + '/' + sel.model
              + '`），但宿主没有回带确认，我无法保证它已生效。发 `/model` 看「当前」是不是这条。')
          }
        } catch (error) {
          console.log('[fs] /model 切换失败: ' + String(error && error.stack || error))
          await replyInCard('warn', String(error && error.message || error) + '\n要重试就发 `/model`。')
        }
      })().catch((error) => {
        console.log('[fs] /model 点击处理异常: ' + String(error && error.message || error))
      })
      return
    }
    // Session/workspace switch buttons (the /switch picker card).
    if (value.fs_switch !== undefined) {
      const chatId = data && data.context && data.context.open_chat_id
      // 🔴 与上面 `fs_model` 那条**同一条判据**：用收到这条事件的连接自带 bot，不按会话猜。
      //   原来无条件 `findBotForChat(chatId)` ⇒ 同实例配两个 bot 时恒取配置里第一个，
      //   而下面 DELETE/PATCH 的都是**这张卡自己**那条消息 ⇒ 真机跨应用改删别人的消息必被拒，
      //   表现就是「点了「✕ 取消」卡片不动」。（闸门 V 用例 100 实测红：卡挂在第二个 bot 上、
      //   删卡身份却是 `cli_test123456`；这条判据在第十八轮之前被一处恒真断言盖住了。）
      // 第十九轮门槛 LOW（核对为真）：这里原来还挂着一截 `|| findBotForChat(chatId)` 兜底 ——
      //   `chatId` 与 `evtBot` 内部分支用的是同一个 `data.context.open_chat_id`，兜底能命中的时候
      //   `evtBot` 早已命中，命中不了的时候它自己也返回 undefined ⇒ 死代码。留着更坏：万一哪天
      //   条件变了让它真跑起来，就正好把本次要删掉的「按会话猜 ⇒ 恒取第一个 bot」放回来。
      const ownerBot = evtBot
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
    // 审批单卡的三个按钮（feishu_approval_form / 卡片适配通道）：value = { fs_form, fs_choice }
    // —— **只新增**这一条分派，既有 fs_switch / fs_question / fs_approval 一行不动。
    if (value.fs_form !== undefined && value.fs_choice !== undefined) {
      const chatId = data && data.context && data.context.open_chat_id
      const record = pendingForms.get(value.fs_form)
      if (!record) {
        // stale 点击**绝不静默**（照抄 fs_question 那条的做法）。
        console.log('[fs] form button: record not found for chat ' + chatId + ' token=' + value.fs_form)
        const hint = recentForms.get(value.fs_form)
          ? '这张审批单已经处理过了（点过即生效，重复点击不会再变）。'
          : '这张审批单已过期或已作废。请看我最新一条卡片，或让 AI 重新发一张。'
        if (chatId) {
          const ownerBot = evtBot
          if (ownerBot) sendPlainText(ownerBot, chatId, '⚠️ ' + hint).catch(() => {})
        }
        return
      }
      if (cardClickOutsideOriginChat(record, chatId, evtBot)) return
      const choice = String(value.fs_choice)
      pendingForms.delete(record.token)
      if (record.timer) clearTimeout(record.timer)
      console.log('[fs] approval form decided: ' + String((record.form && record.form.title) || '')
        + ' -> ' + choice + ' chat=' + chatId)
      rememberAnsweredForm(record.token)
      // `clicker`：**新增键**，既有消费方只读 choice/timedOut/cardId ⇒ 零影响；
      // 两个把结果回给 agent 的落点（feishu_approval_form 工具 / askUserQuestion 卡片适配）都带上它。
      // 用 `clickerRef`（完整 id）而不是 `clickerTag`（截断）：这一份是**给 agent 反查用的**。
      try { record.resolve({ choice, timedOut: false, form: record.form, cardId: record.cardId, clicker: clickerRef }) } catch { }
      if (record.cardId) {
        updateInteractive(record.bot, record.cardId, formResultCardPayload(record.form, choice, undefined, record.elements))
          .catch((error) => {
            console.log('[fs] form card update failed: ' + String(error && error.message || error))
            // 兜底：卡改不动也必须有一条可见反馈，绝不让点击看起来"死了"。
            sendPlainText(record.bot, chatId, '✅ 已记录你的选择：' + choice).catch(() => {})
          })
      }
      return
    }
    // Question-option buttons (ask_user_question card).
    // ---- I（2026-10-03 CM）：计划审批卡第二行「以目标模式跑」------------------------------
    // **只新增**这一条分派（fs_switch / fs_question / fs_approval 一行不动）。
    // 语义：① 先按「批准」回答（⇒ harness 退出计划模式）② 用**计划全文**建目标
    //       ③ 卡片就地变回执（正文保留，只换按钮区 —— 与 J 同口径）
    if (value.fs_plan_goal !== undefined) {
      const chatId = data && data.context && data.context.open_chat_id
      const record = questionByToken.get(value.fs_plan_goal)
      if (!record) {
        console.log('[fs] plan goal button: record not found for chat ' + chatId
          + ' token=' + value.fs_plan_goal)
        if (chatId) {
          const ownerBot = evtBot   // 🔴 收到事件的连接 bot（同 `fs_switch` 那条判据），不按会话猜
          if (ownerBot) {
            sendPlainText(ownerBot, chatId, '⚠️ 这张计划卡已经处理过了。看我最新一条消息，或直接回我文字。')
              .catch(() => { })
          }
        }
        return
      }
      if (cardClickOutsideOriginChat(record, chatId, evtBot)) return
      const q = (record.questions && record.questions[0]) || {}
      const approve = String(planApproveLabel(q) || '')
      dropQuestion(record)
      rememberAnsweredQuestion(value.fs_plan_goal)
      console.log('[fs] plan goal: approved + starting goal mode for chat=' + chatId
        + ' planChars=' + String(q.detail || '').length)
      // ② 用计划全文建目标 + ③ 卡就地变回执（`handleCardAction` **不是 async** ⇒ 放异步 IIFE 里，
      //    先把「批准」答出去让会话继续，建目标失败**可见地**告诉用户，绝不留半截状态）
      const planText = String(q.detail || q.question || '按已批准的计划执行')
      void (async () => {
        let goalOk = false
        let goalWhy = ''
        try {
          const goals = ctx.get('goals')
          // 🔴 这一段下面 PATCH 卡片用的是 `record.bot`（卡的主人），而建目标要解析的 agent
          //   存在**同一个 bot** 的会话表里 ⇒ 两条路径必须同一个身份。原来这里用
          //   `findBotForChat(chatId)` 猜 ⇒ 同实例两 bot 时会在"另一个 bot"的会话上开目标。
          const bot = (record && record.bot) || evtBot
          const chat = bot && bot.chats && typeof bot.chats.get === 'function' ? bot.chats.get(chatId) : undefined
          const agent = (bot && chat) ? await resolveAgent(bot, chat) : undefined
          if (!goals || typeof goals.create !== 'function') {
            goalWhy = '没有 goals 服务'
          } else if (!agent) {
            goalWhy = '拿不到这个会话的 agent'
          } else {
            goals.create(agent, { objective: planText })
            goalOk = true
            console.log('[fs] plan goal created: chat=' + chatId + ' planChars=' + planText.length)
          }
        } catch (error) {
          goalWhy = String(error && error.message || error)
        }
        if (!goalOk) {
          console.log('[fs] plan goal failed: ' + goalWhy)
          try {
            const bot = (record && record.bot) || evtBot   // 🔴 同上：与 PATCH 卡片同一个身份
            if (bot) {
              await sendPlainText(bot, chatId, '✅ 计划已批准；但**目标没建起来**（' + goalWhy
                + '）—— 回我一句我立刻按这份计划开跑。')
            }
          } catch { /* 提示失败也不能影响批准本身 */ }
        }
        if (record.bot && record.cardId) {
          const status = goalOk
            ? '**🎯 已切到目标模式，按这份计划开跑**\n_' + settledStamp() + '_'
            : '**✅ 已批准；目标未建起来（' + goalWhy + '）**\n_' + settledStamp() + '_'
          const kept = [{ tag: 'markdown', content: '**计划（已批准）**\n\n' + planText }]
          try {
            await updateInteractive(record.bot, record.cardId, {
              schema: '2.0',
              config: { wide_screen_mode: true },
              header: {
                title: { tag: 'plain_text', content: goalOk ? '🎯 已进入目标模式' : '📋 计划已批准' },
                template: goalOk ? 'green' : 'orange',
              },
              body: { elements: settledActionElements(kept, status) },
            })
          } catch (error) {
            console.log('[fs] plan goal card update failed: ' + String(error && error.message || error))
          }
        }
      })()
      // ① 先按「批准」回答 ⇒ 退出计划模式（与点「批准」同一条路）
      splitLiveCardAfterAnswer(record.agentId)
      // ① 先按「批准」回答 ⇒ 退出计划模式（与点「批准」同一条路）
      // `clicker` 挂在答案对象顶层 ⇒ `exit_plan_mode` 那条的结构判据
      //（`item.selected[0]==='Approve' && item.custom===undefined`）一个字不受影响。
      {
        const ans = buildQuestionAnswer(record.questions, approve)
        if (clickerRef) ans.clicker = clickerRef
        record.resolve(ans)
      }
      return
    }

    if (value.fs_question !== undefined && value.fs_option !== undefined) {
      const chatId = data && data.context && data.context.open_chat_id
      const record = questionByToken.get(value.fs_question)
      if (!record) {
        // Stale-card click (already answered / superseded) must never be a
        // silent no-op: tell the user visibly instead of dropping the tap.
        // (2026-09-08 CM: clicked a stale card button -> nothing happened.)
        console.log('[fs] question button: record not found for chat ' + chatId + ' token=' + value.fs_question)
        const stale = recentQuestions.get(value.fs_question)
        const hint = stale
          ? '该选项已经处理过了（点过即生效）。请看我最新一条消息，或直接回复文字。'
          : '这张卡片已过期（可能已经回答过）。请看我最新一条卡片，或直接回复文字即可。'
        if (chatId) {
          const ownerBot = evtBot   // 🔴 收到事件的连接 bot（同 `fs_switch` 那条判据），不按会话猜
          if (ownerBot) {
            sendPlainText(ownerBot, chatId, '⚠️ ' + hint).catch(() => {})
          }
        }
        return
      }
      if (cardClickOutsideOriginChat(record, chatId, evtBot)) return
      const q = record.questions[0]
      const opts = Array.isArray(q.options) ? q.options : []
      const opt = opts[Number(value.fs_option)]
      if (!opt) {
        console.log('[fs] question button: bad option index ' + value.fs_option)
        if (chatId) {
          const ownerBot = evtBot   // 🔴 同上
          if (ownerBot) {
            sendPlainText(ownerBot, chatId, '⚠️ 无法识别该选项，请直接回复文字。').catch(() => {})
          }
        }
        return
      }
      dropQuestion(record)
      console.log('[fs] question answered via button: ' + q.id + ' -> ' + opt.label)
      // Keep the last answered token so a second tap on the same
      // (now stale) card gets a friendly hint instead of silence.
      rememberAnsweredQuestion(value.fs_question)
      // Split the streaming card: the old one sits above this question card,
      // so the rest of the turn must continue on a NEW card below it
      // (2026-09-08 CM report). Do this before resolve() so post-answer
      // narration lands on the fresh card.
      // 2026-10-01（CM 回归红线）：入站轮**和**自动轮（回执/目标轮）都必须换新卡 ——
      // 旧实现只查 activeTurns，自动轮点了按钮内容会继续写在旧卡上（用户看到"点了没动"）。
      splitLiveCardAfterAnswer(record.agentId)
      // P2（0.8.0 互认）：`ask_user_question` 的返回整份 JSON.stringify 给 agent
      //（见本文件 `tools/execute` 那条拦截）⇒ 顶层 `clicker` 键就是 agent 看到的点击者。
      {
        const ans = buildQuestionAnswer(record.questions, opt.label)
        if (clickerRef) ans.clicker = clickerRef
        record.resolve(ans)
      }
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
    // 与上面三处同一口径：这张卡给的是**工具权限**（allow-once），被转发到别的会话后
    // 照样一点就放行，比答错一道题更严重 ⇒ 同样只认发起会话里的点击。
    // 🔴 这里必须用函数级 `evtChatId`：上面三处各自的 `const chatId` 都声明在**自己那个
    //   if 块**里，本分支在块外 ⇒ 写 `chatId` 是未声明标识符，ESM 严格模式直接抛
    //   ReferenceError，被调用方 try/catch 吞掉后 `record.settle()` 永不执行
    //   ＝**所有**审批卡点击失效（2026-10-05 门槛第九次跑抓出，冒烟结构上碰不到这条通道，见用例 96）。
    if (cardClickOutsideOriginChat(record, evtChatId, evtBot)) return
    if (value.fs_action === 'allow') {
      console.log('[fs] approval allowed (once): ' + record.request.toolName + ' by ' + (clickerTag || '未知点击者'))
      record.settle('allowed-once')
      dismissApprovalCard(record.bot, record, '✅ 已允许（仅本次）' + (clickerTag ? ' ｜' + clickerTag : ''))
    } else if (value.fs_action === 'reject') {
      console.log('[fs] approval rejected: ' + record.request.toolName + ' by ' + (clickerTag || '未知点击者'))
      record.settle('rejected')
      dismissApprovalCard(record.bot, record, '❌ 已拒绝' + (clickerTag ? ' ｜' + clickerTag : ''))
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
  // 0.7.22（交接清单#3）：**多 bot 同群串扰**修复。原先两张表都按 `chatId` 索引 ——
  //   同一个群里 A、B 两个 bot 各弹一张提问卡时，后弹的 `set(chatId)` 直接**覆盖**前一张的
  //   record，于是先那张卡无论点按钮还是回文字都"没反应"（record 已经不是它的了）。
  //   按可用信息分两条通道：
  //   · 文字回答路径（只有 bot+chat 可用，拿不到 token）⇒ 键加 **appId**（与 0b13f1d 的
  //     入站/文件去重同一口径）。
  //   · 卡片按钮路径 ⇒ 改按 **token** 索引。卡片里本来就嵌了 `randomUUID` 的 token，
  //     它是唯一键，天然不串；`findBotForChat(chatId)` 在同群两 bot 下本身就是猜的。
  const pendingQuestions = new Map()    // qKey(chatId, bot) -> { resolve, reject, questions, timer, token, bot }
  const questionByToken = new Map()     // token -> record（卡片按钮回调的唯一真相）
  const recentQuestions = new Map()     // token -> { answeredAt }（点已处理过的旧卡时给友好提示）
  const qKey = (chatId, bot) => String((bot && bot.cfg && bot.cfg.appId) || '') + '|' + String(chatId || '')
  function putQuestion(record) {
    pendingQuestions.set(qKey(record.chatId, record.bot), record)
    questionByToken.set(record.token, record)
  }
  function dropQuestion(record) {
    if (!record) return
    const k = qKey(record.chatId, record.bot)
    if (pendingQuestions.get(k) === record) pendingQuestions.delete(k)
    questionByToken.delete(record.token)
    if (record.timer) clearTimeout(record.timer)
  }
  // 0.7.22（独立审查 LOW）：这张表按 token 键后**只增不删**（旧实现按 chatId，天然有界），
  //   长驻进程会随问答数无限增长。它只影响"点旧卡"时的提示措辞 ⇒ TTL 回收 + 数量上限兜底。
  //   同一套上界也给审批单的 recentForms 用（0.7.22 同类修复后它也变成 token 键）。
  const RECENT_ANSWER_TTL_MS = 24 * 60 * 60 * 1000
  const RECENT_ANSWER_MAX = 200
  // 0.7.22 复跑审查（LOW）：TTL 清扫 + 上限淘汰抽成一个函数 —— 提问卡与审批单两张表
  //   共用同一套上界，各写一份的话改常量时要改两处（必然漏一处）。
  function rememberBounded(map, token) {
    const now = Date.now()
    for (const [key, value] of Array.from(map)) {
      if (now - (Number(value && value.answeredAt) || 0) > RECENT_ANSWER_TTL_MS) map.delete(key)
    }
    while (map.size >= RECENT_ANSWER_MAX) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
    // 同一个 token 被重复回答时，`map.set` 只改值**不改插入位置** ⇒ 这个刚被点过的
    // token 会排在队首，下次超限先把它淘汰掉（「你已回答过」的提示就此失效）。
    // 先删后插 = 位置跟着最近一次回答走。
    map.delete(token)
    map.set(token, { answeredAt: now })
  }
  function rememberAnsweredQuestion(token) { rememberBounded(recentQuestions, token) }

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

  // 选项按钮的**颜色规则**（2026-10-03 任务③）：飞书按钮带 `type` 才有色（不传就是灰的）。
  //   优先级：option 上显式写的 > 「否定/危险」词义 > 第一个选项 primary > 其余 default。
  // 向后兼容：不传任何字段也不报错（走下面的默认规则）；显式值只认飞书支持的枚举。
  const QUESTION_BUTTON_TYPES = ['default', 'primary', 'danger', 'primary_filled', 'danger_filled', 'text']
  function optionButtonType(option, displayLabel, index) {
    const explicit = String((option && (option.buttonType || option.button_type || option.type)) || '').toLowerCase()
    if (QUESTION_BUTTON_TYPES.includes(explicit)) return explicit
    const label = String(displayLabel !== undefined ? displayLabel : ((option && option.label) || ''))
    if (/驳回|拒绝|拒绝|取消|不同意|不批|否决|reject|deny|refuse|cancel|no\b/i.test(label)) return 'danger'
    return index === 0 ? 'primary' : 'default'
  }

  // I（2026-10-03 CM）：「做完计划以后习惯性地想让你以这个计划为准、去开目标模式，但现在这个承接链是断的」
  //   ⇒ 计划审批卡**另开一行**放整行按钮「以目标模式跑」；点它 = ① 先按「批准」回答（退出计划模式）
  //     ② 用**计划全文**建目标 ③ 卡片就地变回执（正文保留，只换按钮区 —— 与 J 同一口径）。
  function planGoalRow(token) {
    return {
      tag: 'column_set',
      flex_mode: 'stretch',
      columns: [{
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [{
          tag: 'button',
          type: 'primary',
          width: 'fill',
          text: { tag: 'plain_text', content: '🎯 以目标模式跑' },
          behaviors: [{ type: 'callback', value: { fs_plan_goal: token } }],
        }],
      }],
    }
  }

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
            type: optionButtonType(option, shown, index),
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
            // 行1＝批准/拒绝（原样）· 行2＝整行「以目标模式跑」（I，2026-10-03）
            ? [planButtons, planGoalRow(token)]
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

  // ---- 审批单卡（approval form）· 2026-10-03 新增通道 --------------------------------
  // 需求方原话：AI 要发「权限变更审批单」，需要**在飞书里可读、可点**；而 ask_user_question 发出来的
  // 简卡是「一个问题 + 一排无色按钮」，信息全堆成一坨，读不了。
  // 硬要求（逐条落在下面）：**一张卡只装一个人、一件事**；30 分钟超时要**可见地**说明（不静默）；
  // 点击后卡必须变（回执卡），旧卡再点给可见提示而不是静默失败。
  // 与既有三类分派（`fs_switch` / `fs_question` / `fs_approval`）**完全并存** —— 只新增 `fs_form` / `fs_choice`。
  const FORM_TIMEOUT_MIN = 30
  // ⚠️ 两张表都挂 `globalThis`（**跨插件代际**）—— 与 `activeTurns` / `liveCardRegistry` /
  //    `recentTurnCards` 同一套理由：热重载会重建每代的模块状态，而**卡片留在飞书上**。
  //    若只放本代闭包：重载后用户点那张单子 ⇒ 新一代的 handleCardAction 查不到 token ⇒
  //    「这张单已过期」——可他明明刚要处理它（真机里每一次保存都会造成这种窗口）。
  //    挂全局后：点击仍被认出、**真实选择写回卡面**（唯一拿不到的是"上一代那条工具调用的返回值"，
  //    因为那一轮早被重载掐断了）。
  const pendingForms = globalThis.__fsPendingForms || (globalThis.__fsPendingForms = new Map())
  const recentForms = globalThis.__fsRecentForms || (globalThis.__fsRecentForms = new Map())
  // 0.7.22 同类修复：审批单也改成按 **token** 索引（原来按 chatId 单键 ⇒ 同群两 bot、或同一会话
  //   两张单时，后一张 `set` 覆盖前一张的 record ⇒ 先那张单点按钮必判 "record not found"，
  //   用户点了没反应、AI 那头干等到 30 分钟超时）。token 是 randomUUID，本身就是唯一键。
  //   代价是这张表不再天然有界 ⇒ 与 recentQuestions 同一套 TTL + 上限回收。
  function rememberAnsweredForm(token) { rememberBounded(recentForms, token) }
  // 操作按钮（2026-10-03 CM 真机反馈：**只要两个** —— 「✍️ 我要改」已删，有意见直接回消息）。
  const FORM_ACTIONS = [
    { label: '✅ 采纳', choice: '采纳', type: 'primary' },
    { label: '❌ 驳回', choice: '驳回', type: 'danger' },
  ]
  // 变化图标：🔹不变 / 🔸收窄 / 🔷放宽 / ➕新增 / ➖取消（技能那条用 ✅ 表示不变）
  const FORM_CHANGE_ICON = { same: '🔹', narrow: '🔸', expand: '🔷', add: '➕', remove: '➖' }

  function formLineText(item) {
    const it = (item && typeof item === 'object') ? item : { text: item }
    const kind = String(it.change || it.kind || 'same')
    const icon = FORM_CHANGE_ICON[kind] || '🔹'
    return icon + ' ' + String(it.text || it.label || '')
  }

  function formSectionText(title, lines, render) {
    const list = (Array.isArray(lines) ? lines : [])
      .filter((x) => String((x && typeof x === 'object') ? (x.text || x.label || '') : x || '').trim() !== '')
    if (!list.length) return null
    return { title, body: list.map(render).join('\n') }
  }

  /** 审批单卡的版式（需求方给定：卡头蓝 · 双列字段 · ①~⑥ 分区 · 带色操作行）。 */
  function approvalFormCardPayload(form, token) {
    const f = (form && typeof form === 'object') ? form : {}
    const elements = []
    // 字段区（2026-10-03 CM 真机反馈）：
    //   · **短值**（单号 / 置信度…）⇒ `div + fields(is_short:true)` 两列并排，省地方；
    //   · **长值**（变更类型 / 证据来源…）⇒ **单独一行**（挤在框里读不了，CM 原话"因为它是长文本，
    //     不要在那个框里面"）。
    //   判定：字段显式给 `short: true/false` 就听它的；没给就按"值是否短且单行"自动判。
    const meta = (Array.isArray(f.meta) ? f.meta : []).filter((p) => p && (p.label || p.value))
    const fieldValue = (p) => String(p && p.value === undefined ? '' : p.value)
    const fieldLabel = (p) => String((p && p.label) || '')
    // 短/长 的判据（CM 真机例子：`单号=BG-2026-1003-01` 要与「置信度」并排，而
    //   `变更类型=身份标签（数据域收窄）` 要独占一行 —— **按纯长度分不开**（16 字 vs 11 字））：
    //   ① 字段显式给 `short: true/false` ⇒ 听它的；
    //   ② 否则：**含中日韩文字 ⇒ 当长文本**（独占一行）；纯 ASCII/数字且 ≤24 字 ⇒ 短值（两列并排）。
    //      ⇒ 单号/置信度/日期/编号这类天然并排，句子类的中文值天然独占一行。
    const CJK_RE = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/
    const isShortField = (p) => {
      if (p && typeof p.short === 'boolean') return p.short
      const v = fieldValue(p)
      if (!v || v.includes('\n')) return false
      if (CJK_RE.test(v)) return false
      return v.length <= 24
    }
    const shortFields = meta.filter(isShortField)
    const longFields = meta.filter((p) => !isShortField(p))
    if (shortFields.length) {
      elements.push({
        tag: 'div',
        fields: shortFields.map((p) => ({
          is_short: true,
          text: { tag: 'lark_md', content: '**' + fieldLabel(p) + '**\n' + fieldValue(p) },
        })),
      })
    }
    for (const p of longFields) {
      elements.push({ tag: 'markdown', content: '**' + fieldLabel(p) + '**\n' + fieldValue(p) })
    }
    // 分区（2026-10-03 泛化）：调用方可以直接给 `sections: [{title, lines}]` 用**任意**审批单，
    // 也可以只用本仓的「身份标签」预设字段（categories/skills/evidence/impact/risk）。
    // 两者都给时以 `sections` 为准；泛化的 title 若没自带序号，自动补 ①~⑩（保持同一种观感）。
    const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']
    const generic = (Array.isArray(f.sections) ? f.sections : [])
      .map((s, i) => {
        const rawTitle = String((s && s.title) || '')
        const lines = (Array.isArray(s && s.lines) ? s.lines : []).map((x) => String(x))
        if (!rawTitle && !lines.length) return null
        const title = /^[①-⑩]/.test(rawTitle) ? rawTitle : ((CIRCLED[i] || String(i + 1)) + ' ' + rawTitle).trim()
        return { title, body: lines.join('\n') }
      })
      .filter(Boolean)
    const preset = [
      formSectionText('① 类别 × L 档 变化', f.categories, formLineText),
      formSectionText('② 技能变化', f.skills, formLineText),
      formSectionText('③ 证据（原文）', f.evidence, (s) => '> ' + String(s).split('\n').join('\n> ')),
      formSectionText('④ 影响面（改完他获得什么）', f.impact, (s) => '• ' + String(s)),
      formSectionText('⑤ 不批的后果', f.risk, (s) => '• ' + String(s)),
    ].filter(Boolean)
    const sections = generic.length ? generic : preset
    for (const s of sections) {
      if (elements.length) elements.push({ tag: 'hr' })
      elements.push({ tag: 'markdown', content: '**' + s.title + '**' })
      elements.push({ tag: 'markdown', content: s.body })
    }
    // 操作行（2026-10-03 CM 真机反馈）：**不要「⑥ 操作」这行标题**，按钮也**只留两个** ——
    //   `采纳`(primary 蓝) / `驳回`(danger 红)。「✍️ 我要改」已删（CM 要提意见直接回消息即可）。
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'column_set',
      flex_mode: 'bisect',
      columns: FORM_ACTIONS.map((a) => ({
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [{
          tag: 'button',
          type: a.type,
          width: 'fill',
          text: { tag: 'plain_text', content: a.label },
          behaviors: [{ type: 'callback', value: { fs_form: token, fs_choice: a.choice } }],
        }],
      })),
    })
    elements.push({
      tag: 'markdown',
      content: '<font color=\'grey\'>⏰ ' + FORM_TIMEOUT_MIN + ' 分钟内未操作将**自动作废**（会在这里说明，不会替你默认通过）。'
        + '一张卡只装一个人、一件事。</font>',
    })
    return {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '📋 ' + String(f.title || '审批单') },
        template: 'blue',
      },
      body: { elements },
    }
  }

  /** 点完后的回执卡（就地替换，旧卡不再可点）。 */
  function formResultCardPayload(form, choice, note, originalElements) {
    const f = (form && typeof form === 'object') ? form : {}
    const status = '**✅ 你已经审批过了：' + String(choice) + '**'
      + (note ? '\n' + String(note) : '')
      + '\n_' + settledStamp() + '_'
    const template = choice === '驳回' ? 'red' : (choice === '改' ? 'orange' : 'green')
    // J（2026-10-03 CM）：「点了以后不应该把旧的内容清掉，就应该把两个按钮那个位置变成
    //   '你已经审批过了'」⇒ 审批单卡**正文（字段区 + ①~⑤ 分区）全部保留**，只换掉 action 行。
    if (Array.isArray(originalElements) && originalElements.length) {
      return {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: '📋 ' + String(f.title || '审批单') },
          template,
        },
        body: { elements: settledActionElements(originalElements, status) },
      }
    }
    return {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '📋 ' + String(f.title || '审批单') },
        template,
      },
      body: {
        elements: [
          { tag: 'markdown', content: '**已记录你的选择：' + String(choice) + '**' },
          {
            tag: 'markdown',
            content: String(note || (choice === '改'
              ? '请直接把要改的地方回复给我（例如"只加台账回填，别动舆情抓取"）。'
              : '这张单已回执 —— 重复点击不会再生效。')),
          },
        ],
      },
    }
  }

  // 发一张审批单卡并**等他点选**（Promise 模式仿 askUserQuestion；30 分钟定时器）。
  // 超时/中止都**可见**：既把卡改成回执/超时态，也发一条纯文本说明（硬要求：不许静默）。
  function askApprovalForm(bot, chatId, form, signal) {
    return new Promise((resolve, reject) => {
      const record = {
        resolve, reject, form, timer: undefined, token: randomUUID(), cardId: undefined, bot, chatId,
      }
      pendingForms.set(record.token, record)
      record.timer = setTimeout(() => {
        if (pendingForms.get(record.token) === record) pendingForms.delete(record.token)
        console.log('[fs] approval form timed out: ' + String((form && form.title) || '') + ' chat=' + chatId)
        if (record.cardId) {
          void updateInteractive(record.bot, record.cardId, formResultCardPayload(form, '（超时未操作）',
            '⏰ 已超过 ' + FORM_TIMEOUT_MIN + ' 分钟未操作，这张单**自动作废**。要办的话请让 AI 重新发一张。',
            record.elements)).catch(() => {})
        }
        void sendPlainText(record.bot, chatId, '⏰ 审批单「' + String((form && form.title) || '') + '」超过 '
          + FORM_TIMEOUT_MIN + ' 分钟未操作，**已自动作废**（没有替你默认通过或驳回）。').catch(() => {})
        resolve({ choice: '', timedOut: true })
      }, FORM_TIMEOUT_MIN * 60 * 1000)
      if (signal && typeof signal.addEventListener === 'function') {
        const onAbort = () => {
          if (pendingForms.get(record.token) === record) pendingForms.delete(record.token)
          clearTimeout(record.timer)
          if (record.cardId) {
            void updateInteractive(record.bot, record.cardId, formResultCardPayload(form, '（已作废）',
              '这一轮已经结束了，这张单作废 —— 要办的话请让 AI 重新发一张。', record.elements)).catch(() => {})
          }
          reject(new Error('approval form aborted'))
        }
        signal.addEventListener('abort', onAbort)
      }
      // J：留一份原始正文（点完/超时/作废都只换 action 行，正文不清）
      const formCard = approvalFormCardPayload(form, record.token)
      record.elements = formCard && formCard.body && formCard.body.elements
      sendInteractive(bot, chatId, formCard)
        .then((msgId) => {
          record.cardId = msgId
          try { rememberMessage(msgId, 'bot 的审批单：' + String((form && form.title) || '')) } catch { }
          console.log('[fs] approval form sent: ' + String((form && form.title) || '')
            + ' token=' + record.token + ' msg=' + String(msgId || ''))
        })
        .catch((error) => {
          console.log('[fs] approval form send failed: ' + String(error && error.message || error))
          if (pendingForms.get(record.token) === record) pendingForms.delete(record.token)
          clearTimeout(record.timer)
          reject(new Error('approval form send failed: ' + String(error && error.message || error)))
        })
    })
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
      rememberAnsweredQuestion(record.token)
    } catch (error) {
      console.log('[fs] finalize question card failed: ' + String(error && error.message || error))
    }
  }

  function askUserQuestion(bot, chatId, questions, signal, agentId) {
    // 卡片适配通道（任务④ 的第二条入口，2026-10-03）：`questions[0].card` 存在时渲染成**审批单卡**
    // （而不是"文字 + 选它"的简卡），点击结果仍按 question-answer 的形状回传
    // （`selected: [选择]`）—— 这样走 askUserQuestion 的调用方**零改动**就能拿到选择。
    // 向后兼容：只有显式带 `card` 才走这条；不带一个字都不受影响。
    // 开关（2026-10-03）：审批单是**可选通道**，默认关 —— 只有该 bot 在
    // `feishu.config.json` 里显式写了 `"approvalForm": true` 才认这条 `card` 适配；
    // 没开的 bot 原样走普通提问卡（与 0.6.0 之前完全一致）。
    const formOn = Boolean(bot && bot.cfg && bot.cfg.approvalForm === true)
    const qCard = questions && questions[0] && questions[0].card
    if (qCard && typeof qCard === 'object' && formOn) {
      const q0 = questions[0]
      return askApprovalForm(bot, chatId, qCard, signal).then((out) => {
        const choice = out && out.choice ? String(out.choice) : ''
        console.log('[fs] approval form answered: ' + String(q0.id || '') + ' -> ' + (choice || '（未操作）'))
        return {
          answers: [choice
            ? { id: q0.id, selected: [choice] }
            : { id: q0.id, selected: [], custom: out && out.timedOut ? '（超时未操作）' : '（未操作）' }],
          // P2（0.8.0 互认）：点击者随答案回给 agent（顶层新键，既有判据不看它）。
          ...(out && out.clicker ? { clicker: out.clicker } : {}),
        }
      })
    }
    return new Promise((resolve, reject) => {
      const q = questions[0]
      const opts = Array.isArray(q.options) ? q.options : []
      const record = {
        resolve, reject, questions, timer: undefined, token: randomUUID(),
        cardId: undefined, bot, chatId, q, agentId,
      }
      putQuestion(record)
      record.timer = setTimeout(() => {
        dropQuestion(record)
        reject(new Error('question timed out (30 min, no reply)'))
      }, 30 * 60 * 1000)
      if (signal && typeof signal.addEventListener === 'function') {
        const onAbort = () => {
          dropQuestion(record)
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
            dropQuestion(record)
            clearTimeout(record.timer)
            reject(new Error('question card send failed: ' + String(error && error.message || error)))
          })
        return
      }
      const lines = ['❓ **需要你的回答**', '', '**' + q.question + '**']
      if (q.detail) lines.push('', q.detail)
      lines.push('', '直接回复即可。')
      sendPlainText(bot, chatId, lines.join('\n')).catch((error) => {
        dropQuestion(record)
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
  // ── D5（P1.5 身份注入）· 通用身份覆写拦截（2026-10-04）──────────────────────
  //  与下面两条的分工：那两条是【专用】拦截（第一行就 `if (exec.name !== 'xxx') return next()`），
  //  **不覆盖所有工具**；本条**不拦任何工具**，只把 agent 传来的身份字段【覆写】成服务端算出的
  //  actor，然后**一律 next()**。⇒ 注册在它们【之前】，保证先跑。
  //
  //  边界（内核 `decideAction`，已单测）：
  //    · 非飞书回合（没有 chat owner：GUI／子代理／定时轮）  ⇒ pass-through（**不许锁死 CM 自己的电脑**）
  //    · 飞书回合 ＋ 有 actor                              ⇒ overwrite（**这才是 A3 的真正落点**）
  //    · 飞书回合 ＋ 无 actor（**表在不在都一样**）          ⇒ deny ＋ ALERT
  //        ↑ **CM 2026-10-04 裁决：「无表就拒…执行不了总比资料泄露好」**；救急走主 A 准 / SSH 修表
  //
  //  ⚠️ 两个【已踩过】的坑，别再犯：
  //  ① `identityCtx()` 必须能拿到工作区 —— 它在 `apply()` 外，拿不到里面的 `workspaceRoot`；
  //     早先写成 `identityCtx()` ⇒ 构造器抛错被 catch 吞掉 ⇒ **注入静默失效**（日志里全是
  //     `workspaceRoot is not defined`，但外面看起来"没锁死"，很安全 —— 其实根本没认人）。
  //  ② 表路径**不许依赖运行时那个值**（`workspaceRoot()` 取 `ctx.get('sandboxPolicy')`，常为 undefined）
  //     ⇒ 内核已加"cwd 逐级向上 6 层 ＋ 已知工作区兜底（P:/Qoder/work、D:/Work）"。
  ctx.on('tools/execute', async (exec, next) => {
    try {
      const owner = findChatForAgent(exec.agent)
      // 🔒 开关 `identityGuard` **默认关**（上游用户不一定需要这个功能；CM 2026-10-04 定）
      //    ⇒ 关着就直接 next()，**零开销、零副作用**（连 store 都不查）。
      if (!(owner && owner.bot && owner.bot.cfg && owner.bot.cfg.identityGuard)) return next()
      // ⚠️ 此处作用域里没有 `bot`（全局注册）⇒ 只能给 `workspaceRoot()`；内核有多级兜底，给 undefined 也不怕。
      const rec = identityCtx(workspaceRoot()).store.get(exec.agent.id)
      // 🔴 2026-10-04 复核发现的**口径偏差**（先只观测，**不改行为**）：
      //    内核给 `decideAction` 的定义是「hasOwner=true ＋ 无 actor（**表在不在都一样**）⇒ deny」。
      //    而代码走到这里时 **owner 必定存在**（上面那行已经 `return next()`）⇒ 按理应传 `hasOwner: true`。
      //    现在的写法用 `!rec` 当"这不是飞书回合"的替身 ⇒ **有 owner、但 store 里没有这一轮的记录 ⇒ 放行**。
      //    可达路径（**逻辑成立、真机尚未实证**）：`/switch` 把 handle 挂到新 session id、而 store 记的是旧 id；
      //    卡片回调起的轮次也不经过入站注入。
      //    ⇒ 先打点把"实际有多少这种轮次"量出来，**再决定是否收紧成 deny** ——
      //      收紧会波及卡片交互与 `/switch` 之后的正常使用，不该拍脑袋改。
      if (!rec) {
        console.log('[fs] identity NOTE[no-record-allow]: tool=' + exec.name + ' agent=' + exec.agent.id
          + ' ⇒ 飞书回合但无身份记录，按当前实现放行（口径偏差·待裁；见冒烟用例 70 的注释）')
      }
      const action = !rec
        ? 'pass-through'                                  // 非飞书回合 ⇒ 不要求飞书身份
        : decideAction({ hasOwner: true, actor: rec.actor })
      if (action === 'overwrite') {
        const r = applyActorToArguments(exec.arguments, rec.actor)
        if (r.overwritten.length || r.dropped.length) {
          console.log('[fs] identity overwrite: tool=' + exec.name + ' agent=' + exec.agent.id
            + ' set=[' + r.overwritten.join(',') + '] drop=[' + r.dropped.join(',') + ']')
        }
      } else if (action === 'deny') {
        // 🔴 告警要【显眼】且区分原因（CM 2026-10-04 关心"留痕"）：
        //    table_unavailable ＝ 表丢了/读不到（**运维事件** ⇒ 去修表，不许静默降级）
        //    person_unknown    ＝ 表在、但这个人不在册（**业务事件** ⇒ 去补人）
        const why = rec.tableOk === false ? 'table_unavailable' : 'person_unknown'
        console.log('[fs] identity ALERT[' + why + '] DENY: tool=' + exec.name
          + ' agent=' + exec.agent.id + ' tableOk=' + rec.tableOk)
        // ⚠️ 必须带 `error`：isError===true 时 harness 会**无条件**读 result.error，
        //    不给就是 undefined ⇒ 抛 "tool result must be losslessly JSON-serializable"。
        return {
          isError: true,
          error: 'identity_unresolved',
          value: { error: 'identity_unresolved' },
          content: [{ type: 'text', text: '身份未通过校验，已拒绝执行本次工具调用（identity_unresolved）。' }],
        }
      }
    } catch (error) {
      // ⚠️ 这里**不许静默**：注入/覆写自身出错必须留痕 ——
      //    否则就会像 2026-10-04 那次一样"悄悄失效"，外面完全看不出来。
      console.log('[fs] identity ALERT[internal_error] ' + String(error && error.message || error))
    }
    return next()
  })
 
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
      // 0.7.21（HIGH-2）：跨代补发队列（托孤）就挂在这个既有节拍上 —— 不新开定时器。
      try { drainCardRelay() } catch (error) {
        console.log('[fs] card relay drain failed: ' + String(error && error.message || error))
      }
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
      at: { type: 'string', description: '0.8.0 互认：要 @ 的对象，逗号分隔的名字（人或另一个 bot，须能在 bot_roster.json / identity_map 解析到），或 "all"。会展开成真 @ 并唤醒被 @ 的 agent；解析不到只留原文并声明，不发幽灵 @。正文里手写 @[名字] / @「名字」 同样生效。' },
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
        // P1-2（0.8.0 互认）：`at` 参数换成正文前导的 @ token（`@[名]` / `@all`），
        // 真正的解析与展开在 sendPlainText 的收口点（expandAtTokens）做 —— 只此一条通道。
        let outText = String(args.text)
        const atSpec = typeof args.at === 'string' ? args.at.trim() : ''
        if (atSpec) {
          const toks = atSpec.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean)
            // 🔴 第十一轮 LOW#6：token 组装要**剥掉控制字符和方括号再 trim**。原来只剥
            //   `[`/`]` ⇒ 名字里带换行时拼出的 `@[...]` 违反 expandAtTokens
            //   的 `@[^\]\n]{1,60}` 语法，**整条不匹配**：@ 静默没展开、原文照发，
            //   连「（未能 @ 出：X）」那句声明都不会出现（比声明失败更糟的是无声失败）。
            //   ⚠️ 口径要说准（第十二轮门槛 LOW 指出上一版注释说过头了）：真正**违反这个字符类**的
            //   只有 `]` 与 `\n`；`\r`/`\t` 是能过的，剥它们只因那已经不是"一个名字"的形状。
            //   **名字中间的空格合法**（如「张 三」），照常送去解析 ⇒ 不在这里动它。
            .map((n) => (n === 'all' || n === '所有人') ? '@all'
              : '@[' + n.replace(/[[\]\r\n\t]/g, '').trim() + ']')
          if (toks.length) outText = toks.join(' ') + '\n' + outText
        }
        const res = await sendPlainText(bot, chatId, outText)
        return { ok: (() => { const p = parseJson(res.text); return res.status >= 200 && res.status < 300 && p && p.code === 0 })(), status: res.status, detail: String(res.text || '').slice(0, 1000) }
      } catch (error) {
        return { ok: false, status: 0, detail: String(error && error.message || error) }
      }
    },
  })
  ctx.effect(() => ctx.tools.register(tool))

  // ---- 审批单卡工具（`feishu_approval_form`）· 2026-10-03 任务④ 方案 a ----------------
  // AI 显式调它 → 本插件发卡 → **等点击**（最长 30 分钟）→ 把选择当**工具结果**返回给 AI。
  // 目标会话自动取「调用方 agent 所在的飞书会话」（`exec.agent` → `findChatForAgent`）——
  // AI 不用传 chatId；拿不到飞书归属就明确报错，**绝不瞎发到别人的会话**。
  // 规矩：**一张卡只装一个人、一件事**（description 里写给 AI 看）。
  const approvalFormTool = defineTool({
    name: 'feishu_approval_form',
    description: 'Send one "approval form" card to the Feishu chat of the calling agent and WAIT for the human to tap '
      + '采纳 / 驳回; the tapped choice is returned as this tool\'s result. '
      + 'One card = ONE person and ONE matter (never pack several people\'s changes into one card). '
      + 'Layout: short meta fields (单号/置信度…) sit two-per-row, long values (变更类型/证据来源…) each get their own line, '
      + 'then sections ① category × L-level changes ② skill changes ③ evidence quotes ④ impact ⑤ consequence of not approving, '
      + 'then a two-button action row. '
      + 'If nobody taps within 30 minutes the form is voided (and that is said visibly in the chat).',
    parameters: {
      title: { type: 'string', required: true, description: 'Card title incl. the person, e.g. 身份标签变更单 · 曹伟轩' },
      meta: {
        type: 'array',
        description: 'Field pairs (单号 / 变更类型 / 置信度 / 证据来源 …): [{label, value}]. '
          + 'Short ASCII-ish values (单号/置信度/日期…) are laid out two-per-row; CJK sentence-like values '
          + '(变更类型/证据来源…) each get their own full-width line. Set short:true/false to force either way.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', required: true },
            value: { type: 'string', required: true },
            short: { type: 'boolean', description: 'optional: force two-per-row (true) or own line (false)' },
          },
          additionalProperties: false,
        },
      },
      categories: {
        type: 'array',
        description: '① category × L-level changes: [{text, change}] with change = same(🔹unchanged) | narrow(🔸narrowed) | expand(🔷widened)',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', required: true },
            change: { type: 'string', description: 'same | narrow | expand (default same)' },
          },
          additionalProperties: false,
        },
      },
      skills: {
        type: 'array',
        description: '② skill changes: [{text, change}] with change = add(➕) | remove(➖) | same(✅)',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', required: true },
            change: { type: 'string', description: 'add | remove | same (default same)' },
          },
          additionalProperties: false,
        },
      },
      evidence: {
        type: 'array',
        description: '③ evidence quotes — each item is rendered as a block quote',
        items: { type: 'string' },
      },
      impact: { type: 'array', description: '④ impact — what he gains after the change (one line each)', items: { type: 'string' } },
      risk: { type: 'array', description: '⑤ consequence of NOT approving (one line each)', items: { type: 'string' } },
      preset: {
        type: 'string',
        description: 'Optional preset for the section titles: "identity-tag" (default when the domain fields below are used) '
          + 'or "custom" (use `sections` instead).',
      },
      sections: {
        type: 'array',
        description: 'Generic alternative to the ①~⑤ domain fields: [{title, lines}] — any approval type. '
          + 'Titles get an automatic ①~⑩ prefix when they do not carry one. When given, it replaces the domain sections.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', required: true },
            lines: { type: 'array', items: { type: 'string' }, required: true },
          },
          additionalProperties: false,
        },
      },
      chatId: { type: 'string', description: 'Optional explicit target chat (oc_...); defaults to the calling agent\'s Feishu chat.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          choice: { type: 'string', required: true },
          timedOut: { type: 'boolean', required: true },
          cardId: { type: 'string', required: true },
          // P2（0.8.0 互认）：execute() 会返回 clicker，schema 不声明它 ⇒ additionalProperties:false
          //   直接把这一项判成非法输出（严格校验时整条结果被丢）。不声明=契约撒谎。
          clicker: { type: 'string' },
          detail: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{
        type: 'text',
        text: 'feishu_approval_form -> ' + JSON.stringify(value),
      }],
    },
    timeoutMs: (FORM_TIMEOUT_MIN + 2) * 60 * 1000,
    async execute(args, exec) {
      const a = (args && typeof args === 'object') ? args : {}
      const owner = findChatForAgent(exec && exec.agent)
      const explicit = typeof a.chatId === 'string' && a.chatId.trim() ? a.chatId.trim() : ''
      const target = explicit || (owner && owner.chatId) || ''
      // bot 解析：**只认"这个会话属于哪个 bot"**（调用方 agent 给的 / 按 chatId 查）。
      // ⚠️ 故意**不**沿用 feishu_send 那条"最近收到消息的 bot"兜底：那条会把非飞书会话
      //    （GUI／子代理）的调用发到**别人的**会话去 —— 审批单是给具体某个人的，
      //    发错人比不发严重得多（需求原文：绝不瞎发到别人的会话）。
      let bot = (owner && owner.bot) || (target ? findBotForChat(target) : undefined)
      if (!bot) {
        // 兜底（严格、不猜）：**只配了一个 bot** 时"发给谁"没有歧义 ⇒ 用它；
        // 多个 bot 而认不出归属 ⇒ 直接拒绝（宁可让 AI 拿到明确失败，也不发错人）。
        // 这一段同时修掉一个真实场景：bot 刚从配置里增删过、`chats` 还没回填的空窗。
        try {
          const list = await readConfig()
          if (Array.isArray(list) && list.length === 1) {
            bot = bots.get(list[0].appId) || { cfg: list[0], lastChatId: '' }
          }
        } catch { /* 读配置失败就走下面的明确报错 */ }
      }
      console.log('[fs] approval form target: agent=' + String((exec && exec.agent && exec.agent.id) || '-')
        + ' owner=' + String((owner && owner.chatId) || '-') + ' explicit=' + String(explicit || '-')
        + ' chat=' + String(target || '-') + ' bot=' + (bot ? String((bot.cfg && bot.cfg.appId) || 'yes') : 'no'))
      if (!target || !bot) {
        return {
          ok: false, choice: '', timedOut: false, cardId: '',
          detail: '这个会话不是飞书会话（或拿不到飞书归属），审批单卡无处可发。'
            + '（chatId=' + String(explicit || '-') + ' bot=' + (bot ? 'yes' : 'no') + '）',
        }
      }
      // 可选通道（2026-10-03）：**默认关** —— 对外发布时"多一个工具、多一种卡"对别人是噪声，
      // 所以配置里没显式打开 `approvalForm` 的 bot 一律拒绝（连卡都不发）。
      // 注意：bot.cfg 由 `ensureHelpers()` 每 10 秒重读一次 ⇒ 改配置**不用重启**就生效。
      if (bot.cfg && bot.cfg.approvalForm !== true) {
        console.log('[fs] approval form refused: bot=' + String((bot.cfg && bot.cfg.appId) || '?')
          + ' approvalForm 未开启')
        return {
          ok: false, choice: '', timedOut: false, cardId: '',
          detail: '这个会话的 bot 没打开审批单通道：在 ~/.dsh-feishucard/feishu.config.json 里给该 bot 加 '
            + '"approvalForm": true（改完 10 秒内自动生效，不用重启）。',
        }
      }
      const form = {
        title: String(a.title || '审批单'),
        meta: a.meta, categories: a.categories, skills: a.skills,
        evidence: a.evidence, impact: a.impact, risk: a.risk,
        preset: a.preset, sections: a.sections,
      }
      try {
        const out = await askApprovalForm(bot, target, form, exec && exec.signal)
        const choice = out && out.choice ? String(out.choice) : ''
        return {
          ok: true,
          choice,
          timedOut: Boolean(out && out.timedOut),
          cardId: String((out && out.cardId) || ''),
          // P2（0.8.0 互认）：谁点的这张单，agent 必须能看到（认不出名字也要带 id 前缀）。
          clicker: String((out && out.clicker) || ''),
          detail: choice
            ? '他点了：' + choice + '（卡已就地改成回执卡）'
              + (out && out.clicker ? ' ' + out.clicker : '')
            : '超过 ' + FORM_TIMEOUT_MIN + ' 分钟没操作，这张单已作废（现场有可见说明）。',
        }
      } catch (error) {
        return {
          ok: false, choice: '', timedOut: false, cardId: '',
          detail: String(error && error.message || error),
        }
      }
    },
  })
  // 注册策略（2026-10-03 CM 定稿 **方案 B**）：**始终注册**这个工具 ——
  // 这样 Agent 能**主动告诉用户**"这里有个审批单通道、要不要开"；"开不开"仍由**用户/配置**决定：
  // 该 bot 没写 `approvalForm: true` 时，调用会被**明确拒绝**，并把"怎么打开"写在返回里（AI 可直接转告）。
  //（0.6.2～0.6.4 是"没开就不注册"＝零噪声，但 Agent 无从提示 ⇒ CM 明确切到 B。）
  ctx.effect(() => {
    try {
      const disposer = ctx.tools.register(approvalFormTool)
      console.log('[fs] approval form tool registered（方案 B：始终注册；是否可用按各 bot 的 approvalForm 判定）')
      return () => { try { if (typeof disposer === 'function') disposer() } catch { /* 卸载失败不影响别的 */ } }
    } catch (error) {
      console.log('[fs] approval form tool registration failed: ' + String(error && error.message || error))
      return () => { }
    }
  })


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
    // state.openedAt（0.7.21）：这一轮**开始时**的事件游标 —— 收口时靠它把"最后一段话/失败标记"
    //   限定在本轮之内；换卡会重起 watcher，所以必须存在 state 上而不是卡上（卡的游标会变）。
    const state = { card: null, stop: null, rotate: null, openedAt: 0 }
    // 表格额度换卡：与普通回合的 rotateTables 同机制（旧卡留表格，后续写新卡，游标接续不丢不重）
    const rotate = (reason, oldText) => {
      if (!state.stop || !state.card || state.card.status !== 'running') return
      const carry = Number.isFinite(state.card.cursor) ? state.card.cursor : 0
      state.stop()
      state.card.status = 'sealed'
      dropWorkingPlaceholder(state.card)
      // 0.7.9（CM 2026-10-03 ③）：指路语写在旧卡；新卡干净起步。
      state.card.blocks.push({
        type: 'message',
        text: oldText || (reason === 'size' ? rotateNoticeSize() : ROTATE_NOTICE_TABLES),
      })
      void syncCard(bot, chatId, state.card, true).catch(() => {})
      const fresh = makeCardState(agent, state.card)
      fresh.cursor = carry
      // 0.7.10（独立审查 LOW#7044）：**不设** rotatedThisTurn —— 自动卡换卡不经过 runTurn 的收尾判定（死存）。
      state.card = fresh
      void syncCard(bot, chatId, fresh, true).catch(() => {})
      state.stop = startCardWatcher(agent, fresh, bot, chatId, rotate)
      markAutoRound(agent, info && info.kind, state.openedAt)   // 0.7.21：换卡 ⇒ 新 entry 要重打标记
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
    // 0.7.21：本轮开始的事件游标（= 此刻卡上的游标）。收口时"最后一段话/失败标记"
    //   都按它裁剪到本轮之内 —— 换卡不改这个值（卡的游标会变，本轮的起点不会）。
    state.openedAt = Number(card.cursor) || 0
    void syncCard(bot, chatId, card, true).catch(() => {})
    state.stop = startCardWatcher(agent, card, bot, chatId, rotate)
    markAutoRound(agent, info && info.kind, state.openedAt)   // 0.7.21：见 markAutoRound 说明
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
      // 0.7.21（HIGH-1）：同 activeTurns —— rotate/split 是**本代**闭包，跨代条目一律不许调。
      gen: GEN_ID,
      openedAt: Number.isFinite(state.openedAt) ? state.openedAt
        : (Number.isFinite(state.card && state.card.cursor) ? state.card.cursor : 0),
      stop: () => (state.stop ? state.stop() : undefined),
      // 侧消息换卡通道（P2）：转交给自动卡的 rotate（同为 carry 语义）
      rotate: (reason, oldText) => (typeof state.rotate === 'function' ? state.rotate(reason, oldText) : undefined),
      split: () => {
        try {
          if (state.stop) state.stop()
          const old = entry.card
          if (!old) return
          // 1) 冻结旧卡：它停在用户刚点过的那张选择卡**上面**，后续内容不能再往上堆
          old.status = 'sealed'
          old.blocks = (old.blocks || []).filter((b) => !(b.type === 'message' && b.text === '正在工作中…'))
          old.blocks.push({ type: 'message', text: ANSWER_POINTER })
          void syncCard(entry.bot, entry.chatId, old, true).catch(() => {})
          // 2) 新卡接在当前事件位置：split 之前的内容已经在旧卡上，绝不重放
          const fresh = makeCardState(agent, old)
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
          markAutoRound(agent, kind, entry.openedAt)   // 0.7.21：新 watcher ⇒ 新登记条目，标记要重打
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
  // CM 2026-10-03：「这种卡片一直在最底部，有问题 —— 发了以后就自动换新卡，不能一直在最底。」
  //   侧消息（看门狗/失败提示等**另发的**消息）会把"还在跑的那张卡"留在它上面，后续更新全写在上方，
  //   用户看到的是最底下那条提示、以为我们停了。与"插话必须换卡"同源（CM 2026-10-02）⇒
  //   发完侧消息就把该会话正在跑的卡**换到下面新卡继续**（旧卡就地封口＋一行说明、正文原样保留）。
  //   复用答题/插话那套 `entry.split()`：新卡游标 = 当前事件位 ⇒ 不重放、不丢。
  // 2026-10-05（CM 定的分界：**还能不能继续**）：还能继续的状态提示**只写回原卡**、不另发消息。
  //   · 为什么不发也安全：它还在工作 ⇒ 收尾一定会更新/发结论卡 ⇒ 那本身就是通知
  //     （CM 原话：「他还在工作，就一定会发结论卡，我等着结论卡就有提示了」）。
  //   · 用 notice 块（醒目、不参与 cardTableCount、不进结论摘要）—— 正好是「状态行」该有的隔离性。
  //   · 定位方式与 rotateLiveCardForChat 同源（activeTurns → autoCards → liveCardRegistry），
  //     但**不换卡**：只 push 一行后 sync。
  //   · 同一 title 只保留一条（stall 会按分钟反复走到，不能刷出一堆块）。
  function appendCardNotice(bot, chatId, title, text, bg) {
    const tt = String(title || '').trim()
    const tx = String(text || '').trim()
    if (!tt || !tx) return false
    const put = (card, label) => {
      if (!card || card.status !== 'running' || !Array.isArray(card.blocks)) return false
      const block = { type: 'notice', title: tt, text: tx }
      if (bg) block.bg = bg
      const idx = card.blocks.findIndex((b) => b && b.type === 'notice' && String(b.title || '') === tt)
      if (idx >= 0) card.blocks[idx] = block
      else card.blocks.push(block)
      void syncCard(bot, chatId, card, false).catch(() => { })
      console.log('[fs] status notice -> card only (' + label + '): chat=' + chatId + ' title=' + tt)
      return true
    }
    for (const e of activeTurns.values()) {
      if (e && String(e.chatId || '') === String(chatId || '') && put(e.card, 'turn')) return true
    }
    for (const e of autoCards.values()) {
      if (e && String(e.chatId || '') === String(chatId || '') && put(e.card, 'auto')) return true
    }
    for (const e of liveCardRegistry.values()) {
      if (e && String(e.chatId || '') === String(chatId || '') && put(e.card, 'adopted')) return true
    }
    console.log('[fs] status notice -> no live card, nothing appended: chat=' + chatId + ' title=' + tt)
    return false
  }

  function rotateLiveCardForChat(chatId, label) {
    const text = label || SIDE_NOTICE_OLD
    try {
      // ⚠️ 审查 MED#7069：**不能**用 `entry.split()` —— 那是"答题路径"语义（新卡游标 = 事件末尾），
      //    会**跳过还没镜像的事件**；换卡路径（rotateTables/rotate）用的是 carry = 旧卡当前游标，
      //    才满足"不重放、不丢"。所以这里调 entry.rotate()。
      // 🔴 0.7.21（HIGH-1）：`entry.rotate` 是**登记那一代的闭包** —— 外代的调了就废（推送被代际旗
      //    全吞，且旧代的 startCardWatcher 会抢停本代 watcher）⇒ 只调本代登记的条目，
      //    外代条目一律跳过，让它落到下面 registry 那条**本代**通道（rotateAdoptedCard）。
      for (const [key, entry] of activeTurns.entries()) {
        if (!entry || String(entry.chatId || '') !== String(chatId || '')) continue
        if (!entry.card || entry.card.status !== 'running') continue
        if (typeof entry.rotate !== 'function') continue
        if (!closuresAreOurs(entry)) { logForeignClosureSkip('rotate:turn', key); continue }
        entry.rotate('side', text)
        console.log('[fs] side notice -> live card rotated: chat=' + chatId + ' kind=turn')
        return true
      }
      // ⚠️ 审查 MED#7063：看门狗/失败提示**也会**从自动卡（目标轮/回执轮）的 watcher 发出 ⇒
      //    那些轮同样要覆盖，否则症状照旧（且不许静默）。
      for (const [key, entry] of autoCards.entries()) {
        if (!entry || String(entry.chatId || '') !== String(chatId || '')) continue
        if (!entry.card || entry.card.status !== 'running') continue
        if (typeof entry.rotate !== 'function') continue
        if (!closuresAreOurs(entry)) { logForeignClosureSkip('rotate:auto', key); continue }
        entry.rotate('side', text)
        console.log('[fs] side notice -> live card rotated: chat=' + chatId + ' kind=' + String(entry.kind || 'auto'))
        return true
      }
      // 0.7.20：热重载「接管／复活」的卡**只存在于跨代 registry**（既不在 activeTurns 也不在 autoCards）。
      //   旧实现在这里打 "nothing to rotate" ⇒ 这类卡发完静默提示后不换卡，提示压在长卡下面（症状照旧）。
      //   走续卡通道自己的 rotateAdoptedCard —— 同样是"旧卡留内容 + 新卡按游标接续"，不重放、不丢。
      for (const entry of liveCardRegistry.values()) {
        if (!entry || String(entry.chatId || '') !== String(chatId || '')) continue
        if (!entry.agent || !entry.card || entry.card.status !== 'running') continue
        rotateAdoptedCard(entry.agent, 'side', text)
        console.log('[fs] side notice -> live card rotated: chat=' + chatId + ' kind=adopted')
        return true
      }
      // 没有"正在跑的卡"⇒ 没有可换的卡：明确留痕（本文件口径：不许静默跳过）
      console.log('[fs] side notice: no running card for chat=' + chatId + ' (nothing to rotate)')
    } catch (error) {
      console.log('[fs] side notice rotate failed: ' + String(error && error.message || error))
    }
    return false
  }

  function splitLiveCardAfterAnswer(agentId) {
    if (!agentId) return false
    // 0.7.21（HIGH-1）：三条通道按"本代优先"排 —— 跨代表里属于**上一代**的条目一律跳过
    //   （它的 split 是旧闭包，调了就把这张卡的镜像链路打死），最后落到本代的接管通道。
    const turn = activeTurns.get(agentId)
    if (turn && typeof turn.split === 'function' && closuresAreOurs(turn)) {
      try { turn.split(); return true } catch (error) {
        console.log('[fs] question split failed (turn): ' + String(error && error.message || error))
        return false
      }
    }
    if (turn && typeof turn.split === 'function') logForeignClosureSkip('split:turn', String(agentId))
    const auto = autoCards.get(agentId)
    if (auto && typeof auto.split === 'function' && closuresAreOurs(auto)) {
      try { auto.split(); return true } catch (error) {
        console.log('[fs] question split failed (auto): ' + String(error && error.message || error))
        return false
      }
    }
    if (auto && typeof auto.split === 'function') logForeignClosureSkip('split:auto', String(agentId))
    // 热重载接管来的卡：只存在于跨代 registry ⇒ 走本代的等价通道（语义与 split 完全一致）
    const adopted = liveCardRegistry.get(String(agentId))
    if (adopted && adopted.agent) {
      try { if (splitAdoptedCard(adopted.agent, null)) return true } catch (error) {
        console.log('[fs] question split failed (adopted): ' + String(error && error.message || error))
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
        if (live.card) {
          closeAutoRoundCard(agent, live.card, live.bot, live.chatId,
            Number(live.openedAt || 0), live.kind, 'auto round finished')
        }
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
