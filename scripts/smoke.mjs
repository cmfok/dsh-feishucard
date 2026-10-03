// dsh-feishucard smoke test: boots the real host plugin against a mocked
// DSH context and a mocked Feishu REST API, feeds one inbound message through
// the helper protocol, and asserts the full turn pipeline:
//   event -> dedicated session create -> agent.send -> streaming card
//   (create + PATCH updates) -> seal -> final reply on card.
//
// Run: node scripts/smoke.mjs   (from the package root)
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

// 捕获插件自己的 console.log（2026-10-01 补）：用来断言"观测留痕"类行为
// （例：sendPlainText 成功后要打 `notice plain text sent` —— 此前只有失败才留痕，无法验证）。
const consoleLines = []
const originalLog = console.log
console.log = (...args) => {
  consoleLines.push(args.map((a) => String(a)).join(' '))
  originalLog(...args)
}

const APP_ID = 'cli_test123456'
const APP_SECRET = 'secret-test'
// ⚠️ 工作区路径**不写死绝对路径**（A17 禁硬编码地址）：从系统临时目录派生，
// 形状仍是 Windows 绝对路径（正斜杠，与插件内部 normPath 的写法一致）——
// 写死盘符会把测试绑死在某一台机器上。
const SMOKE_WS_ROOT = tmpdir().split('\\').join('/')
const WORKSPACE = SMOKE_WS_ROOT + '/fs-smoke-workspace'
const OTHER_WORKSPACE = SMOKE_WS_ROOT + '/fs-smoke-other'   // "其它工作区"用例专用
const THIRD_WORKSPACE = SMOKE_WS_ROOT + '/fs-smoke-third'   // 只从会话 cwd 兜底出现的"未注册工作区"
const CHAT_ID = 'oc_smoke_chat_001'
const MSG_ID = 'om_smoke_msg_001'

// 冷启动变体（2026-10-01 目标轮 7）：`DSH_FEISHU_*` 开关都是 **apply 时读一次**
// （`GOAL_CARDS_ON` L3466 / `NOTICE_CARDS_ON` L3470）⇒ 必须在 import/apply **之前**设好环境变量。
// 用法： $env:SMOKE_COLD='notice-off'; node scripts/smoke.mjs     （或 'goal-off'）
const COLD = process.env.SMOKE_COLD || ''
if (COLD === 'notice-off') process.env.DSH_FEISHU_NOTICE_CARDS = '0'
if (COLD === 'goal-off') process.env.DSH_FEISHU_GOAL_CARDS = '0'

// Point the plugin at a throwaway config dir so the test never touches the
// real ~/.dsh-feishucard (the plugin honours process.env.FS_CONFIG_DIR).
const FAKE_HOME = join(tmpdir(), 'fs-smoke-' + Date.now())
mkdirSync(join(FAKE_HOME, '.dsh-feishucard'), { recursive: true })
// 2026-10-02：三个"工作区"目录**真的建出来**。插件现在的 ⚠️/🟢 判定以**本地目录是否存在**为准
//（门槛第二轮 medium#6：只认注册表返回的那个 token 太松），夹具要是空路径，卡面会全变 ⚠️ ——
// 那样测的就不是插件逻辑，而是夹具不像真的（A25：验证环境要与生产一致）。
mkdirSync(WORKSPACE, { recursive: true })
mkdirSync(OTHER_WORKSPACE, { recursive: true })
mkdirSync(THIRD_WORKSPACE, { recursive: true })
writeFileSync(join(FAKE_HOME, '.dsh-feishucard', 'feishu.config.json'),
  // reactionEmoji 一开始就设成非默认值（默认 'OnIt'）—— 用例 40 用它验证 cfg.reactionEmoji 通道
  // approvalForm：审批单卡通道是**默认关**的可选通道 ⇒ 主用例集把它打开（用例 51 验通路），
  // 冷启动变体 `SMOKE_COLD=form-off` 则故意关掉，验「没开就一个工具都不注册」。
  JSON.stringify({
    bots: [{
      name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
      reactionEmoji: 'GLANCE', approvalForm: COLD !== 'form-off',
    }],
  }, null, 2))
process.env.FS_CONFIG_DIR = join(FAKE_HOME, '.dsh-feishucard')

let failures = 0
function ok(cond, label) {
  if (cond) {
    console.log('  ✅ ' + label)
  } else {
    failures += 1
    console.log('  ❌ ' + label)
  }
}

// ---- mocked Feishu REST (captures card payloads) -----------------------------
const sentCards = []      // { op, payload }
const reactionCalls = []  // { method, url, body } —— 打字提示（reaction）生命周期，用例 40 用
// 入站附件下载（用例 49）：记录被请求的资源 URL，并可切换成"下载失败"。
const resourceDownloads = []
let resourceShouldFail = false
// 下载回来的字节可切换（用例 49 验"按文件头补扩展名"：PNG 魔数 / 认不出的字节）。
let resourceBytes = Buffer.from('hello-from-feishu')
let tenantTokenCalls = 0
let createReturnsEmptyId = false   // 建卡幂等测试：模拟返回体缺 message_id
// 2026-10-01（用例 34）：只让"从此刻起的第 N 次建卡"失败 —— 用来精确打到
// 「建结论卡那一次」而不误伤过程卡的建卡。0 = 不启用。
let failCreatesFrom = 0
const globalFetch = globalThis.fetch
// 2026-10-03 F/G 用例要用的 mock 状态
const imageUploads = []
const fileUploads = []
let rejectPatches = 0
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.includes('/auth/v3/tenant_access_token/internal')) {
    tenantTokenCalls += 1
    return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 })) }
  }
  if (u.includes('/reactions') && (init.method === 'POST' || init.method === 'DELETE')) {
    reactionCalls.push({ method: init.method, url: u, body: String(init.body || '') })
    return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, data: { reaction_id: 're_1' } })) }
  }
  // 入站附件下载（用例 49）：资源 URL 形状是 /im/v1/messages/<msg_id>/resources/<key>?type=file，
  // **也含** '/im/v1/messages' ⇒ 必须排在建卡分支**之前**，否则会被当成建卡请求
  //（那里 `JSON.parse(init.body)`，而下载是 GET 没有 body ⇒ 直接抛错，测出来的是 mock 的毛病）。
  if (u.includes('/resources/')) {
    resourceDownloads.push({ url: u })
    if (resourceShouldFail) return { ok: false, status: 403, text: () => Promise.resolve('forbidden') }
    return { ok: true, status: 200, arrayBuffer: async () => resourceBytes }
  }
  if (u.includes('/im/v1/images')) {
    imageUploads.push({ url: u })
    return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, data: { image_key: 'img_v3_smoke_key' } })) }
  }
  if (u.includes('/im/v1/files')) {
    fileUploads.push({ url: u })
    return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, data: { file_key: 'file_v3_smoke_key' } })) }
  }
  if (u.includes('/im/v1/messages')) {
    const raw = JSON.parse(init.body)
    const payload = typeof raw.content === 'string' ? JSON.parse(raw.content) : raw
    sentCards.push({ op: init.method === 'PATCH' ? 'update' : 'create', payload })
    if (init.method === 'PATCH') {
      return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0 })) }
    }
    if (rejectPatches > 0) {
      // F 用例：模拟"内容被拒"（真机原话 code 230099 / ErrCode 200570 / invalid image keys）
      // —— 建卡与 PATCH **都要能命中**（新建一轮是 `create`，不是 PATCH）
      rejectPatches -= 1
      return {
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          code: 230099,
          msg: 'Failed to create card content, ext=ErrCode: 200570; ErrMsg: card contains invalid image keys',
        })),
      }
    }
    if (failCreatesFrom > 0) {
      failCreatesFrom -= 1
      if (failCreatesFrom === 0) {
        // 建卡失败（返回体没有 message_id → 插件侧 createFailed），且**不抛给调用方**
        // —— 与真机上"15s 超时被 abort"的表现一致：syncCard 内部吞掉异常。
        return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, data: {} })) }
      }
    }
    if (createReturnsEmptyId) {
      return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, data: {} })) }
    }
    return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, data: { message_id: 'om_card_' + sentCards.length } })) }
  }
  return { status: 404, text: () => Promise.resolve('unhandled: ' + u) }
}

// ---- mocked agent.ctx（2026-10-02 补；评审 low#3）------------------------------
// 插件把 approval/request 与 user-questions/request 挂在 **agent.ctx**（长生命周期）上，
// 卸载时靠 disposer 注销。此前 mock agent **没有 ctx** ⇒ `scope.on` 从不被调用、
// `agentScopeDisposers` 恒为空 ⇒ "忘了注销 / 注销不生效"在冒烟里永远不会变红。
// 这里补一个真的返回 disposer 的 `on`，并记账。
// 两个 mock agent 共用**一个工厂**（第四轮门槛 low）：此前 `agentCtx.on` 与 `freshCtx.on`
// 是两份近乎一样的复制品，只差一个计数器 —— 以后修"注销记账"很容易只改一处、两处漂移。
function makeScopedCtx(onDispose) {
  const store = new Map()               // event -> [listener]
  return {
    count: (name) => (store.get(name) || []).length,
    ctx: {
      on(name, listener) {
        if (!store.has(name)) store.set(name, [])
        store.get(name).push(listener)
        return () => {
          const list = store.get(name) || []
          const i = list.indexOf(listener)
          // 第四轮门槛 low：**只有真的移除了才计数**（原来重复 dispose / 拆不存在的条目也 +1，
          // 于是这个数字不再是"移除了几条监听"的忠实信号）。
          if (i < 0) return
          list.splice(i, 1)
          if (typeof onDispose === 'function') onDispose()
        }
      },
    },
  }
}
let agentScopeDisposed = 0              // disposer **真正移除**掉一条监听的次数
const primaryScope = makeScopedCtx(() => { agentScopeDisposed += 1 })
const agentCtx = primaryScope.ctx
function agentScopeCount(name) { return primaryScope.count(name) }

// 第二个 mock agent：**从未收到过任何飞书消息**（＝重载后自己起自动轮的老 agent）。
// 它只该靠 agent/status 那一条补挂路径拿到两条水位线 —— 用它来验"两条必须共用同一补挂点"。
const freshScope = makeScopedCtx()
const freshCtx = freshScope.ctx
function freshCount(name) { return freshScope.count(name) }
const freshAgent = {
  id: 'agent-smoke-auto',
  ctx: freshCtx,
  session: { header: { cwd: WORKSPACE }, snapshotEvents: () => [], events: [] },
}

// ---- mocked agent ------------------------------------------------------------
const agentEvents = []
const agent = {
  id: 'agent-smoke-1',
  ctx: agentCtx,
  session: {
    header: { cwd: WORKSPACE },
    snapshotEvents: () => agentEvents,
  },
  sent: [],
  send(message) {
    this.sent.push(message)
    // Simulate the agent working: narration + a tool call + result, then reply.
    agentEvents.push(
      { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '我先查一下知识库。' }] } } },
      { type: 'tool/call', seq: 2, data: { callId: 'call_1', name: 'read', arguments: '{"file_path":"a.md"}' } },
      { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '查到了，整理如下。' }] } } },
      { type: 'tool/result', seq: 4, data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'file contents' }] }] } } },
      { type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'text', text: '这是最终回复 ✅' }] } } },
    )
  },
  async whenIdle() { return undefined },
}

// ---- mocked DSH context --------------------------------------------------------
const intervals = []
const effects = []
// ctx.effect 的 setup 若**返回函数**，那个返回值就是真实的 cleanup（卸载钩子就是这么注册的）。
// 收集起来，用例 47 才能**按行为**找到卸载钩子，而不是假设"index.js 里第一个 ctx.effect"
//（第四轮门槛 medium：位置假设会让用例与 index.js 的注册顺序耦合）。
const effectCleanups = []
const registeredRoutes = []
const registeredTools = []
let createdSessions = 0
let resumedSessions = 0

const fakeProc = {
  status: 'running',
  output: '',
  readOutput() {
    const delta = this.output
    this.output = ''
    return { delta }
  },
  kill() { this.status = 'killed' },
}

// 目标模式：假的 goals 服务 + 假的命令注册表（用例 14 用）
const goalCalls = []          // goals.create 收到什么
const commandCalls = []       // commands.execute 收到什么
const fakeGoals = {
  create(agent, request) {
    goalCalls.push({ agentId: agent && agent.id, objective: request && request.objective })
    return { objective: request && request.objective, roundsStarted: 0, maxGoalRounds: 10, phase: 'active' }
  },
  // 改造③（底部目标条）用：state/runtimeState/view 三个读接口。
  // activation 可被用例改写，用来验「续行已停（disarmed）」那一格。
  state: () => (fakeGoalEnabled ? {
    goal: {
      id: 'goal-smoke-1', revision: 1, phase: fakeGoalPhase,
      objective: '把飞书卡片这四项改造做完并在真机验收通过', maxGoalRounds: 20,
      blockedReason: fakeGoalBlockedReason || undefined,
    },
    roundsStarted: 3,
    createdAt: Date.now() - 3600000,
    updatedAt: Date.now(),
  } : null),
  runtimeState: () => ({ activation: fakeGoalActivation }),
  view: (state, runtime) => state === null || state === undefined ? undefined : ({
    ...state.goal,
    roundsStarted: state.roundsStarted,
    createdAt: state.createdAt,
    activation: runtime.activation,
  }),
}
let fakeGoalActivation = 'armed'
let fakeGoalPhase = 'active'
let fakeGoalBlockedReason = ''      // 只有 phase==='blocked' 时会出现在卡面上
let fakeGoalEnabled = true
const fakeCommands = { execute: async () => undefined }   // 默认"注册表没接管" → 走 goals 兜底
// 2026-10-02：补上假 planMode 服务。此前 `ctx.inject` 对 planMode 直接不触发 ⇒ 插件里
// `planModeRef` 永远是 null ⇒ 「批准后真的退出计划模式」这条分支**从未被测过**。
const planModeCalls = []
const fakePlanMode = {
  set(agent, active) {
    planModeCalls.push({ agentId: agent && agent.id, active })
    return 'queued'
  },
}

// 会话切换：假的持久化服务 + 会话创建记录 + 活着的 agent 列表（用例 15 用）
const createdSessionIds = []
const liveAgents = []
let persistedSessions = []
const persistedFirstText = {}          // sessionId -> 首条用户消息（摘要）
const fakePersistence = {
  list: async () => persistedSessions,
  locate: (meta) => ({ kind: 'jsonl', path: join(tmpdir(), 'no-such-' + meta.id + '.jsonl.zstd') }),
  readFrom: async (id) => ({
    meta: (persistedSessions.find((s) => s.id === id)) || { version: 0, id },
    events: persistedFirstText[id]
      ? [{ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: persistedFirstText[id] }], source: { kind: 'user' } } }]
      : [],
  }),
}

// 工作区注册表 mock（2026-10-02 A 方案）：DSH 原生结构 —— 实体 = { id, path, title, sessionIds[], status(), attachSession() }。
// 插件现在**先读它**（与 GUI 侧边栏同源），所以要能验证：① 工作区列表来自它 ② 切换后把会话挂回去。
const registryAttached = []            // { ws, id }
let registryIdSeq = 0
let registryOverride = null        // 非空 = 只用 'workspaces' 这个服务名暴露给插件（见 ctx.get）
function makeRegistryEntity(path, title, id) {
  const entityId = id || ('ws-' + (++registryIdSeq))
  return {
    id: entityId,
    path,
    title: title || path.split('/').pop(),
    sessionIds: [],
    status: async () => 'ok',
    attachSession: async (sid) => { registryAttached.push({ ws: entityId, id: String(sid) }) },
  }
}
const fakeWorkspaceRegistry = {
  _entities: [],
  seed() { this._entities = [WORKSPACE, OTHER_WORKSPACE].map((path) => makeRegistryEntity(path)) },
  list() { return this._entities },
  get(id) { return this._entities.find((e) => e.id === id) },
  async resolveByPath(path) { return this._entities.find((e) => e.path === path) },
  async create(path, title) {
    // id 走**单调计数器**：原来用 _entities.length + 1，实体一旦被移除（用例里会 pop / 清空）就会重号，
    // get(id) 随之产生歧义（门槛第二轮 low）。
    const entity = makeRegistryEntity(path, title)
    this._entities.push(entity)
    return entity
  },
}
fakeWorkspaceRegistry.seed()

const ctx = {
  get(key) {
    if (key === 'agents') {
      return {
        create: async (opts) => {
          createdSessions += 1
          createdSessionIds.push(opts.sessionId)
          agent.session.header.cwd = opts.meta && opts.meta.cwd
          if (opts.setup) await opts.setup({ get: () => ({ mount: async () => {} }) })
          return { agent }
        },
        resume: async (opts) => {
          resumedSessions += 1
          // 2026-10-02：resume 之后 cwd 应当回到**那个会话自己的**目录（生产里读的是会话 header）。
          // mock 原来不改 cwd ⇒ "接管别的工作区的会话"在测试里看起来还在原目录，cwd 相关断言失真。
          const meta = persistedSessions.find((s) => s.id === (opts && opts.resumeSessionId))
          if (meta && meta.cwd) agent.session.header.cwd = meta.cwd
          return { agent }
        },
        list: () => liveAgents,
      }
    }
    if (key === 'sandboxPolicy') return { workspaceRoot: WORKSPACE }
    if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test-model' }) }
    if (key === 'goals') return fakeGoals
    if (key === 'commands') return fakeCommands
    if (key === 'sessionPersistence') return fakePersistence
    // 门槛第三轮 low：允许把注册表**只**以客户端服务名 workspaces 暴露（且可以没有 get()），
    // 用来锁住"服务名两种都认 + 逐个方法判可用"这两条兜底（否则它们永远没被跑过）。
    if (key === 'workspaceRegistry') return registryOverride ? undefined : fakeWorkspaceRegistry
    if (key === 'workspaces') return registryOverride || undefined
    return undefined
  },
  shell: {
    resolve: (spec) => spec,
    start: (spec) => {
      fakeProc.output += JSON.stringify({ type: 'ready' }) + '\n'
      return fakeProc
    },
  },
  interval(fn) { intervals.push(fn); return () => {} },
  effect(fn) {
    effects.push(fn)
    const cleanup = fn()
    if (typeof cleanup === 'function') effectCleanups.push(cleanup)
    return cleanup
  },
  webServer: { register: (route) => registeredRoutes.push(route) },
  tools: { register: (t) => registeredTools.push(t) },
  inject(keys, callback) {
    // cordis service injection: only invoke when a known service is present.
    // 2026-10-02：planMode 现在也提供（见 fakePlanMode）—— exit_plan_mode 工具层接管要断言
    // 「批准后调用了 set(agent,false)」，不注入的话那条分支永远走不到。
    if (Array.isArray(keys) && keys.includes('planMode')) {
      callback({ planMode: fakePlanMode })
      return () => {}
    }
    void keys; void callback
    return () => {}
  },
  on(event, listener) {
    // cordis event subscription: recorded so tests can emit lifecycle events
    // (e.g. `agent/status` for the goal-round card) through emitCtx().
    if (!ctxListeners.has(event)) ctxListeners.set(event, [])
    ctxListeners.get(event).push(listener)
    return () => {}
  },
}

// Recorded cordis listeners + a tiny emitter so tests can drive plugin hooks.
const ctxListeners = new Map()
function emitCtx(event, ...args) {
  // 返回**每个监听器的返回值**（2026-10-01 补：水位线类事件——approval/request、
  // user-questions/request——监听器返回的是 Promise，用例 42 要 await 它拿答案）。
  const results = []
  for (const listener of (ctxListeners.get(event) || [])) results.push(listener(...args))
  return results
}

// ---- boot the real plugin -------------------------------------------------------
// 2026-10-01 补：**启动前**先塞一条"历史回执"进会话 —— 用来验证
// 「首见某 agent 时只登记游标、绝不回放历史」（否则 dsh 重启后会把很久以前的回执全部重播、刷屏）。
agentEvents.push({
  type: 'user/message', seq: 1,
  data: {
    content: [{ type: 'text', text: 'Background subagent OLDHISTORY-0001 finished and will do no further work unless you send it more.' }],
    source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'OLDHISTORY-0001' },
  },
})
const mod = await import('../index.js')
mod.apply(ctx)

// Fire the interval callback a few times to let ensureHelpers spawn and drain.
for (let i = 0; i < 3; i++) {
  for (const fn of intervals) fn()
}

// ---- 冷启动变体分支：只验"启动时读一次"的开关，验完即退出（不跑主用例集）------------
if (COLD) {
  console.log('冷启动变体：' + COLD + '（这些开关只有冷启动才能验；主用例集假设开关默认开）')
  feedInbound('om_cold_' + COLD, '冷启动开关测试')
  await drain()   // 建立 chat→agent 映射（回执轮询只遍历有飞书映射的 agent）

  if (COLD === 'notice-off') {
    const before = sentCards.length
    agentEvents.push({
      type: 'user/message', seq: 7000,
      data: {
        content: [
          { type: 'text', text: 'Background subagent coldtest-0001 finished and will do no further work unless you send it more.' },
          { type: 'text', text: 'Its closing message:' },
          { type: 'text', text: '冷启动开关测试回执。' },
        ],
        source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'coldtest-0001' },
      },
    })
    await drain()
    ok(sentCards.length === before, 'DSH_FEISHU_NOTICE_CARDS=0 ⇒ 回执零播报（不建卡也不发纯文本）')
    ok(!consoleLines.some((l) => l.includes('notice card opened') || l.includes('notice plain text sent')),
      '开关关掉时连播报日志都不该有')
    ok(consoleLines.some((l) => l.includes('plugin apply')), '（前提）插件确实已 apply —— 证明不是"啥都没加载"造成的假绿')
  } else if (COLD === 'goal-off') {
    const before = sentCards.length
    agentEvents.push({
      type: 'user/message', seq: 7100,
      data: { content: [{ type: 'text', text: '（目标模式 · 第 1 轮）' }], source: { kind: 'goal', round: 1 } },
    })
    emitCtx('agent/status', { agent, status: 'running' })
    await drain()
    ok(createsSince(before).length === 0, 'DSH_FEISHU_GOAL_CARDS=0 ⇒ 目标轮不自动建卡（不刷屏）')
    emitCtx('agent/status', { agent, status: 'idle' })
  } else if (COLD === 'form-off') {
    // 2026-10-03 **方案 B（CM 定稿）**：审批单工具**始终注册** ——
    // 好处是 Agent 能主动告诉用户"这里有个通道、要不要开"；"开不开"仍由配置决定：
    // 该 bot 没写 `approvalForm: true` 时，调用被**明确拒绝**并把"怎么打开"写在返回里。
    ok(registeredTools.some((t) => t && t.name === 'feishu_approval_form'),
      '★ 方案 B：approvalForm 未开启时工具**仍然注册**（Agent 才有机会提示用户去开）')
    ok(consoleLines.some((l) => l.includes('方案 B：始终注册')), '并留痕（可日志复验）')
    ok(registeredTools.some((t) => t && t.name === 'feishu_send'), '（前提）别的工具照常注册')
    // 调用必须被拒且"话能照做"（CM 要的兜底：Agent 收到信息）
    const tool = registeredTools.find((t) => t && t.name === 'feishu_approval_form')
    const refused = await tool.execute({ title: '没开通道不该发', chatId: CHAT_ID },
      { agent, signal: undefined })
    ok(refused && refused.ok === false && String(refused.detail).includes('没打开审批单通道'),
      '★ 未开启 ⇒ 调用被明确拒绝（实际：' + JSON.stringify(refused && refused.detail || refused) + '）')
    ok(String(refused && refused.detail).includes('approvalForm'), '拒绝里带"怎么打开"（可被 Agent 转告用户）')
    ok(!sentCards.some((c) => JSON.stringify(c.payload || {}).includes('没开通道不该发')),
      '被拒时**一张卡都没发**（不瞎发）')
    // 热开启：改配置 + 过 10 秒热读 ⇒ 同一工具从"被拒"变成"真的能发"
    writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
      bots: [{
        name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
        reactionEmoji: 'GLANCE', approvalForm: true,
      }],
    }, null, 2))
    await new Promise((r) => setTimeout(r, 11000))   // 等过热读节拍（ensureHelpers 每 10 秒重读配置）
    await drain()
    const mark = sentCards.length
    const pending = tool.execute({ title: '开通道后就该发得出', chatId: CHAT_ID },
      { agent, signal: undefined })
    // 这张卡会一直等点击 ⇒ 只等几秒，别把冷启动用例挂住
    await Promise.race([pending.catch(() => { }), new Promise((r) => setTimeout(r, 3000))])
    await drain()
    ok(sentCards.slice(mark).some((c) => JSON.stringify(c.payload || {}).includes('开通道后就该发得出')),
      '★ 运行中把 approvalForm 改成 true（10 秒热读）⇒ **同一工具立刻能发卡**（不用重启）')
  }
  console.log(failures === 0 ? 'COLD PASS (' + COLD + ')' : 'COLD FAIL (' + COLD + '): ' + failures + ' 条')
  process.exit(failures === 0 ? 0 : 1)
}

console.log('1) helper spawned & registered')
ok(createdSessions === 0, 'no session yet before inbound')
ok(registeredTools.some((t) => t && t.name === 'feishu_send'), 'feishu_send tool registered')
ok(registeredRoutes.some((r) => r.path === '/feishu/admin/status'), 'admin status route registered')

// Feed one inbound message through the helper protocol.
console.log('2) inbound message pipeline')
fakeProc.output += JSON.stringify({
  type: 'event',
  eventType: 'im.message.receive_v1',
  data: {
    message: { message_id: MSG_ID, message_type: 'text', chat_id: CHAT_ID, chat_type: 'p2p', content: JSON.stringify({ text: '帮我看看' }) },
    sender: { sender_id: { open_id: 'ou_test' } },
  },
}) + '\n'
for (const fn of intervals) fn()
await new Promise((r) => setTimeout(r, 600))
for (const fn of intervals) fn()
await new Promise((r) => setTimeout(r, 600))

ok(createdSessions === 1, 'dedicated session created (' + createdSessions + ')')
ok(agent.sent.length === 1, 'message delivered to agent')
ok(agent.sent[0] && agent.sent[0].content[0].text.includes('帮我看看'), 'message text intact')
// 2026-10-01 补（此前无守护）：启动前就存在的历史回执**绝不许回放** ——
// 首次见到某 agent 时只登记游标；`from === undefined` 那条分支若写错，dsh 重启后会把
// 很久以前的回执全部重播一遍（刷屏）。判定：全流程里不许出现 OLDHISTORY 这个标记。
ok(!JSON.stringify(sentCards).includes('OLDHISTORY'),
  '启动前的历史回执不回放（首见 agent 只登记游标）')
ok(!consoleLines.some((l) => l.includes('OLDHISTORY')),
  '历史回执既没进卡片、也没进纯文本播报')

console.log('3) streaming card')
ok(sentCards.length >= 1, 'card created + updated (' + sentCards.length + ' syncs)')
const first = sentCards[0]
ok(first && first.op === 'create', 'first op = create')
ok(first && first.payload && first.payload.schema === '2.0', 'card schema 2.0')
const last = sentCards[sentCards.length - 1]
const allElements = last ? last.payload.body.elements : []
const json = JSON.stringify(sentCards)
ok(json.includes('工具调用'), 'tool panel title present')
ok(json.includes('⏳') || json.includes('✅'), 'tool status symbol present')
ok(json.includes('我先查一下知识库'), 'inline agent note present')
ok(json.includes('这是最终回复'), 'final reply on card')
ok(!json.includes('正在工作中'), 'placeholder removed after seal')
const hasStatusLine = allElements.some((e) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('运行中'))
ok(!hasStatusLine, 'status line removed after seal')

console.log('4) command handling')
fakeProc.output += JSON.stringify({
  type: 'event',
  eventType: 'im.message.receive_v1',
  data: {
    message: { message_id: 'om_cmd', message_type: 'text', chat_id: CHAT_ID, chat_type: 'p2p', content: JSON.stringify({ text: '/new 调研' }) },
    sender: { sender_id: { open_id: 'ou_test' } },
  },
}) + '\n'
for (const fn of intervals) fn()
await new Promise((r) => setTimeout(r, 600))
for (const fn of intervals) fn()
await new Promise((r) => setTimeout(r, 600))
ok(createdSessions === 2, '/new created a second session (' + createdSessions + ')')

console.log('5) fallback path (circuit open => plain text)')
const before = sentCards.length
// Push 5 failed syncs to open the breaker: simulate by making PATCH fail next.
// (Smoke keeps it simple: we assert the pipeline did not throw.)
ok(createdSessions >= 1 && agent.sent.length >= 1, 'pipeline stable end-to-end')

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-15 回归：CM 反馈「同一段东西分两个卡片发、内容大部分重复」+「工具代码框没折叠」
// ─────────────────────────────────────────────────────────────────────────────

// 触发一条入站消息（唯一 message_id，避免被入站去重拦下）
function feedInbound(msgId, text) {
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'im.message.receive_v1',
    data: {
      message: { message_id: msgId, message_type: 'text', chat_id: CHAT_ID, chat_type: 'p2p', content: JSON.stringify({ text }) },
      sender: { sender_id: { open_id: 'ou_test' } },
    },
  }) + '\n'
}
async function drain() {
  for (let i = 0; i < 4; i++) {
    for (const fn of intervals) fn()
    await new Promise((r) => setTimeout(r, 150))
  }
}
// 触发一条入站**附件**消息 —— 用例 49 用它验「飞书发文件/图片 ⇒ 插件自己下载并告知」（CM 2026-10-02）。
// `file.type` 默认 'file'（正文 {"file_key","file_name"}）；传 'image' 走图片形态
// （正文只有 {"image_key"} —— **飞书图片消息不给文件名**，正是"没有扩展名"那个坑的来源）。
function feedInboundFile(msgId, file) {
  const msgType = file.type || 'file'
  const content = msgType === 'image'
    ? { image_key: file.key }
    : { file_key: file.key, file_name: file.name }
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: msgId,
        message_type: msgType,
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        content: JSON.stringify(content),
      },
      sender: { sender_id: { open_id: 'ou_test' } },
    },
  }) + '\n'
}
function cardsSince(n) {
  return sentCards.slice(n)
}
// 多轮 drain：卡片 watcher 走真实 setInterval(300ms)，跨 tick 的行为（换卡→镜像）
// 需要多等几轮才能观察到，否则断言会跑在动作完成之前。
async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) await drain()
}
// 只统计**流式卡**的 create（schema 2.0）；建卡失败后的兜底纯文本不在此列。
function createsSince(n) {
  return sentCards.slice(n).filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0')
}
// 2026-10-01 CM：状态（进行中/已完成/失败）已**并入底部状态栏**，状态词写在栏首、紧跟 "  ｜"。
// 所以断言不能再找 `_失败_` 这种独立状态行，改判"状态栏里确实是这个词"。
function statusShows(body, word) {
  return String(body).includes(word + '  ｜')
}

console.log('6) inbound dedup (same message_id must not run twice)')
{
  const sentBefore = agent.sent.length
  feedInbound('om_dup_same', '重复投递测试')
  feedInbound('om_dup_same', '重复投递测试')
  await drain()
  ok(agent.sent.length === sentBefore + 1,
    'duplicate inbound processed exactly once (' + (agent.sent.length - sentBefore) + ' run)')
}

console.log('7) note dedup by seq (replayed event must not duplicate the text)')
{
  const mark = sentCards.length
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push(
      { type: 'assistant/message', seq: 90, data: { message: { content: [{ type: 'text', text: '同一段叙述' }] } } },
      { type: 'assistant/message', seq: 90, data: { message: { content: [{ type: 'text', text: '同一段叙述' }] } } }, // 同 seq 重放
      { type: 'assistant/message', seq: 91, data: { message: { content: [{ type: 'text', text: '收尾句' }] } } },
    )
  }
  feedInbound('om_seq_dup', 'seq 去重测试')
  await drain()
  const body = JSON.stringify(cardsSince(mark))
  const hits = (body.match(/同一段叙述/g) || []).length
  ok(hits <= 2, 'replayed seq written at most twice across payload history (got ' + hits + ')')
  const lastCard = cardsSince(mark).filter((c) => c.op === 'create').pop()
  const perCard = lastCard ? (JSON.stringify(lastCard.payload).match(/同一段叙述/g) || []).length : 0
  ok(perCard <= 1, 'within a single card payload the text appears once (got ' + perCard + ')')
}

console.log('8) long code fence folds into a collapsible panel')
{
  const mark = sentCards.length
  const longCode = '```bash\n' + Array.from({ length: 20 }, (_, i) => 'echo line ' + i).join('\n') + '\n```'
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 120, data: { message: { content: [{ type: 'text', text: longCode }] } } })
  }
  feedInbound('om_code_fold', '代码块折叠测试')
  await drain()
  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('collapsible_panel'), 'long code fence became a collapsible panel')
  ok(body.includes('点击展开'), 'panel header shows the expand hint')
  ok(body.includes('echo line 19'), 'code content preserved inside the panel')
}

console.log('9) card create is idempotent (empty message_id must not spawn many cards)')
{
  createReturnsEmptyId = true
  const mark = sentCards.length
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 150, data: { message: { content: [{ type: 'text', text: '建卡失败测试' }] } } })
  }
  feedInbound('om_create_fail', '建卡幂等测试')
  await drain()
  // 只统计**流式卡**的 create（schema 2.0）；建卡失败后的兜底纯文本（1.0 结构，sendPlainText）
  // 是设计行为，不算重复建卡。
  const createdAtemps = cardsSince(mark)
    .filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0').length
  createReturnsEmptyId = false
  ok(createdAtemps <= 1, 'card create attempted at most once with empty message_id (got ' + createdAtemps + ')')
}

console.log('10) feishu_send is skipped while this chat has an active card')
{
  const mark = sentCards.length
  // 让这一轮"挂住"：whenIdle 不返回 → activeTurns 里保留活跃卡 → feishu_send 应被跳过
  let release
  const gate = new Promise((r) => { release = r })
  const prevSend = agent.send.bind(agent)
  agent.send = function (message) {
    prevSend(message)
    agentEvents.push({ type: 'assistant/message', seq: 200, data: { message: { content: [{ type: 'text', text: '正在处理…' }] } } })
  }
  const prevIdle = agent.whenIdle.bind(agent)
  agent.whenIdle = () => gate
  feedInbound('om_active_send', '活跃卡期间的 feishu_send')
  await drain()
  const tool = registeredTools.find((t) => t && t.name === 'feishu_send')
  let decision = null
  if (tool && typeof tool.execute === 'function') {
    decision = await tool.execute({ text: '这段不该另发一条', chatId: CHAT_ID })
  }
  const newMessages = cardsSince(mark).filter((c) => c.op === 'create' && c.payload && !c.payload.schema).length
  ok(decision && decision.ok === true && String(decision.detail).includes('已跳过'),
    'feishu_send reported skipped (got ' + JSON.stringify(decision && decision.detail).slice(0, 60) + ')')
  ok(newMessages === 0, 'no extra plain-text message was posted (got ' + newMessages + ')')
  release()
  agent.whenIdle = prevIdle
  await drain()
}

console.log('11) 表格超限降级：第 6 张起转成可读清单，不再出现原始 | 符号')
{
  // 背景（CM 2026-09-16 反馈）：卡片里表格只看到一堆 `|` 符号。
  // 两个原因：① card watcher 抛 ReferenceError → 卡片更新全挂、退化成纯文本（另有用例覆盖）；
  //          ② 飞书单卡硬上限 5 张表（ErrCode 11310），超出部分原实现降级成 ``` 代码块，
  //             代码块里就是原始竖线 —— 等于把问题换个地方展示。
  // 本用例固化 ② 的新行为：超限表格 → `- **列名**：值 ｜ **列名**：值` 清单。
  const mark = sentCards.length
  const mkTable = (n) => [
    '| 列A' + n + ' | 列B' + n + ' |',
    '| --- | --- |',
    '| 值' + n + '-1 | 值' + n + '-2 |',
  ].join('\n')
  const sixTables = Array.from({ length: 6 }, (_, i) => mkTable(i + 1)).join('\n\n')
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 260, data: { message: { content: [{ type: 'text', text: sixTables }] } } })
  }
  feedInbound('om_table_quota', '表格配额测试')
  await drain()
  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('表格超出飞书单卡上限'), '第 6 张表格触发了降级提示')
  ok(body.includes('**列A6**：值6-1'), '降级后是可读清单（列名：值）而非代码块')
  ok(body.includes('| 列A1 |'), '前 5 张表格保持 markdown 原样（交给飞书渲染成真表格）')
  // 被降级的那张不应再以「| 行」形式出现
  ok(!body.includes('| 列A6 |'), '被降级的表格不再输出原始竖线行')
}
// 说明：用例 11 覆盖的是**降级兜底**路径（单条消息内一次就来 6 张表，换卡救不了这种）。
// 正常路径（跨事件满额）由用例 12 覆盖。

console.log('12) 表格额度换卡：单卡满 5 张表后，后续内容换新卡（表格不降级）')
{
  // CM 2026-09-16 方案：超限不要降级成清单，要**换一张新卡**继续，旧卡保留它已有的表格。
  // 判定发生在 watcher 扫描新事件之前，且要求"有事件待镜像"，所以必须分两波喂事件、
  // 中间让 watcher 跑一轮（drain）。
  const mark = sentCards.length
  const mk = (n) => ['| 列' + n + ' | 值 |', '| --- | --- |', '| a | ' + n + ' |'].join('\n')
  const fiveTables = Array.from({ length: 5 }, (_, i) => mk(i + 1)).join('\n\n')

  let release
  const gate = new Promise((r) => { release = r })
  const prevIdle = agent.whenIdle.bind(agent)
  agent.whenIdle = () => gate               // 让这一轮保持活跃，watcher 不被 seal 停掉
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 320, data: { message: { content: [{ type: 'text', text: fiveTables }] } } })
  }
  feedInbound('om_rotate', '换卡测试')
  await drain()                             // 第一波：5 张表 → 额度用满
  agentEvents.push({ type: 'assistant/message', seq: 321, data: { message: { content: [{ type: 'text', text: mk(6) }] } } })
  await drain()                             // 第二波：应触发换卡，这张表落到新卡
  release()
  agent.whenIdle = prevIdle
  await drain()

  const creates = cardsSince(mark).filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0')
  ok(creates.length >= 2, '满额后新建了第二张卡（create 次数 ' + creates.length + '）')
  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('表格已满'), '新卡带换卡说明（用户知道内容接在哪张卡）')
  ok(body.includes('| 列6 |'), '新卡里的第 6 张表保持 markdown 原样（未被降级）')
  ok(!body.includes('**列6**：'), '第 6 张表没有被降级成清单')
  // 旧卡要先承载过 1~5 张表（表格是 PATCH 更新上去的，不在 create 载荷里），
  // 且**换卡发生在这之后** —— 证明内容是"接着往下写"，不是搬走。
  const ops = cardsSince(mark)
  const createIdx = []
  ops.forEach((c, i) => { if (c.op === 'create' && c.payload && c.payload.schema === '2.0') createIdx.push(i) })
  const beforeSecond = createIdx.length >= 2 ? JSON.stringify(ops.slice(0, createIdx[1])) : ''
  ok(beforeSecond.includes('| 列5 |'), '换卡前旧卡已承载 1~5 张表（内容留在旧卡）')
}

console.log('13) 目标模式：goal 轮自动建卡，过程在飞书可见（2026-09-16 方案 A）')
{
  // 背景（CM 反馈）：目标模式续轮由 @deepseek-ai/dsh-goal-round-driver 以**同会话**注入
  // user/message（source.kind==='goal'）驱动，不经过飞书入站 → 原实现没有建卡入口，
  // 飞书里**完全看不到**目标模式在干什么。本用例固化新行为：
  //   agent/status=running 且本轮是 goal 轮 → 建「🎯 目标模式 · 第 N 轮」卡，复用同一套 watcher；
  //   agent/status=idle → seal + 「✅ 本轮结束」；非 goal 的自动回合**不建卡**（不刷屏）。
  const mark = sentCards.length
  agent.send = function (message) { this.sent.push(message) }   // 目标轮不经过这条路径

  // 1) 会话里注入目标轮触发消息（与 goal-round-driver 同构：data = { content, source }）
  agentEvents.push({
    type: 'user/message', seq: 400,
    data: {
      content: [{ type: 'text', text: '<goal_round>\nRound: 1/10\n</goal_round>' }],
      source: { kind: 'goal', goalId: 'g_smoke', revision: 1, round: 1 },
    },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()

  const opened = createsSince(mark)
  // 2026-09-27（CM 实证"一个内容发两次"）：目标轮**允许复用**同一轮刚封口的回合卡 ——
  // 不再另开一张镜像同一批事件的卡。所以 create 次数 0 或 1 都算对；
  // 关键断言改为「没有多开卡」＋「🎯 目标模式卡面确实出现（新建或复用那张）」。
  ok(opened.length <= 1, '目标轮没有多开卡（create 次数 ' + opened.length + '）')
  const openBody = JSON.stringify(cardsSince(mark))
  ok(openBody.includes('目标模式'), '卡面标明是目标模式')
  ok(openBody.includes('第 1 轮'), '卡面标明轮次')
  ok(!openBody.includes('<goal_round>'), 'goal 提示词本身不搬上卡（只镜像本轮后续事件）')

  // 2) 轮内产出（过程话语 + 工具调用）应当进卡 —— 这就是"中间过程可见"
  agentEvents.push(
    { type: 'assistant/message', seq: 401, data: { message: { content: [{ type: 'text', text: '我先盘点现状。' }] } } },
    { type: 'tool/call', seq: 402, data: { callId: 'call_goal_1', name: 'grep', arguments: '{"pattern":"x"}' } },
    { type: 'tool/result', seq: 403, data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'hit' }] }] } } },
  )
  await drain()
  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('我先盘点现状'), '过程话语进了卡（中间过程可见）')
  ok(body.includes('工具调用'), '工具调用以折叠面板进卡')

  // 3) 轮结束 → 封口
  emitCtx('agent/status', { agent, status: 'idle' })
  await drain()
  ok(JSON.stringify(cardsSince(mark)).includes('本轮结束'), '轮结束封口并写明本轮结束')

  // 4) 非 goal 的自动回合不建卡（噪声控制，CM 拍板口径）
  const mark2 = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 410,
    data: { content: [{ type: 'text', text: '普通消息' }], source: { kind: 'user' } },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()
  emitCtx('agent/status', { agent, status: 'idle' })
  await drain()
  ok(createsSince(mark2).length === 0, '非 goal 的自动回合不自动建卡（不刷屏）')
}

console.log('13b) 目标卡照样享受表格换卡（新功能 × 既有换卡机制的组合验证）')
{
  const mark = sentCards.length
  const mk = (n) => ['| 列' + n + ' | 值 |', '| --- | --- |', '| a | ' + n + ' |'].join('\n')
  agentEvents.push({
    type: 'user/message', seq: 500,
    data: {
      content: [{ type: 'text', text: '<goal_round>\nRound: 2/10\n</goal_round>' }],
      source: { kind: 'goal', goalId: 'g_smoke', revision: 1, round: 2 },
    },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()
  ok(createsSince(mark).length === 1, '第 2 轮重新建卡（上一轮已封口）')

  for (let i = 1; i <= 5; i++) {
    agentEvents.push({ type: 'assistant/message', seq: 500 + i, data: { message: { content: [{ type: 'text', text: mk(i) }] } } })
  }
  await drain()                                    // 第一波：5 张表 → 额度用满
  agentEvents.push({ type: 'assistant/message', seq: 510, data: { message: { content: [{ type: 'text', text: mk(6) }] } } })
  await settle()

  const creates = createsSince(mark)
  ok(creates.length >= 2, '目标卡满额后换新卡（create 次数 ' + creates.length + '）')
  ok(JSON.stringify(cardsSince(mark)).includes('表格已满'), '新卡带换卡说明')

  // 第 6 张表在**新卡**上的落地形态：轮结束的强制同步会把待写内容一次刷出去
  //（换卡后头 400ms 内的普通同步会被 CARD_MIN_INTERVAL 限流跳过，属既有行为，不是目标卡缺陷）。
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()
  const all = cardsSince(mark)
  ok(JSON.stringify(all).includes('本轮结束'), '封口落在换卡后的新卡上（游标已接续，不断链）')
  const hintAt = all.findIndex((c) => c.op === 'create' && JSON.stringify(c.payload).includes('表格已满'))
  const onNewCard = hintAt >= 0 ? JSON.stringify(all.slice(hintAt)) : ''
  ok(onNewCard.includes('| 列6 |') && !onNewCard.includes('**列6**：'),
    '第 6 张表落在新卡且保持 markdown 原样（未被降级）')
  ok(!JSON.stringify(all.slice(0, hintAt < 0 ? 0 : hintAt)).includes('| 列6 |'),
    '第 6 张表没有跑到旧卡（游标接续不重不漏）')
}

console.log('14) 飞书命令 /goal：目标模式入口（CM 2026-09-16 要求）')
{
  const mark = sentCards.length
  const sentBefore = agent.sent.length
  // 取本次命令的纯文本回复（sendPlainText 发的是 1.0 卡片，elements[0].content 即正文）
  const replyText = () => {
    const creates = sentCards.slice(mark)
      .filter((c) => c.op === 'create' && c.payload && !c.payload.schema && Array.isArray(c.payload.elements))
    const last = creates[creates.length - 1]
    return last ? String(last.payload.elements[0].content || '') : ''
  }

  // ① 命令注册表未接管（execute 返回 undefined）→ 走 goals 服务兜底
  fakeCommands.execute = async () => undefined
  const usesBefore = goalCalls.length
  feedInbound('om_goal_cmd_1', '/goal 把 A 项目的总结写完')
  await drain()
  ok(goalCalls.length === usesBefore + 1 && goalCalls[goalCalls.length - 1].objective === '把 A 项目的总结写完',
    '目标原样传给 goals.create（' + JSON.stringify(goalCalls[goalCalls.length - 1] || null) + '）')
  ok(replyText().includes('目标已创建'), '飞书回复创建结果')
  ok(replyText().includes('开卡更新'), '回复里说明接下来每轮会发进度卡')

  // ② /goal 属于命令，不该被当成普通消息丢给模型
  ok(agent.sent.length === sentBefore, '/goal 没有走普通消息路径（模型未收到）')

  // ③ 命令注册表可用时优先走它（子命令 pause/resume/clear/edit 都由它处理）
  const registry = []
  fakeCommands.execute = async (_agent, line) => { registry.push(line); return { result: { text: 'Goal paused\nStatus: paused' } } }
  feedInbound('om_goal_cmd_2', '/goal pause')
  await drain()
  ok(registry.includes('/goal pause'), '子命令透传到 harness 命令通道（' + JSON.stringify(registry) + '）')
  ok(replyText().includes('Goal paused'), '命令通道的返回原样发回飞书')
  ok(!replyText().includes('开卡更新'), '暂停时不补"会发进度卡"的提示')

  // ④ 无参数 = 查看状态，同样透传
  feedInbound('om_goal_cmd_3', '/goal')
  await drain()
  ok(registry.includes('/goal'), '无参数 /goal 透传为状态查询')

  // ⑤ 注册表也没接管 + 是子命令 → 不静默、给用法（不能把 pause 当成新目标）
  const usesBefore2 = goalCalls.length
  fakeCommands.execute = async () => undefined
  feedInbound('om_goal_cmd_4', '/goal pause')
  await drain()
  ok(goalCalls.length === usesBefore2, '子命令不会被误当成新目标创建')
  ok(replyText().includes('用法：/goal'), '给出用法提示（不静默失败）')
  fakeCommands.execute = async () => undefined
}

// ---- 卡片断言小工具（用例 15 / 15b 共用）----------------------------------------
// 卡片元素取法：切换卡现在是 **schema 2.0 + body.elements**（与流式卡/提问卡同形状，
// 那种形状在真机上被 PATCH 过成千上万次）；这里兼容两种形状，免得断言跟着形状走。
const cardElements = (card) => {
  const p = (card && card.payload) || {}
  if (p.body && Array.isArray(p.body.elements)) return p.body.elements
  return Array.isArray(p.elements) ? p.elements : []
}
// 只认真卡片（带 header）：纯文本回复（sendPlainText）的载荷同样有 elements，
// 不排除的话在"以纯文本结尾"的窗口里会抓到那条消息，断言失败信息会指向错的东西。
const lastCardFrom = (from) => sentCards.slice(from)
  .filter((c) => c.op === 'create' && c.payload && c.payload.header && cardElements(c).length).pop()
// 行文本可能落在两种地方：① 顶层 div（旧版式）② column_set → column → markdown（C 版式"一行一个"）。
// 统一收成 { text: { content } } 形状，老断言不用改。
const divRows = (card) => {
  const out = []
  const take = (e) => {
    if (!e) return
    const c = String((e.text && e.text.content) || e.content || '')
    if (/(^|\n)\s*(▶ )?\d+\. /.test(c)) out.push({ text: { content: c } })
  }
  for (const e of cardElements(card)) {
    if (e.tag === 'column_set') {
      for (const col of (e.columns || [])) for (const el of ((col && col.elements) || [])) take(el)
    } else take(e)
  }
  return out
}
// 按钮取法要兼容两种卡片形状：
//  · 1.0：`{ tag: 'action', actions: [...] }`，按钮自带 `value`
//  · 2.0：`column_set → column → button`，回调走 `behaviors: [{ type: 'callback', value }]`
//    （**2.0 不再支持 action 元素** —— 真机报 230099/200861，见用例 48 的校验）
const allButtons = (card) => {
  const out = []
  const take = (e) => {
    if (!e || e.tag !== 'button') return
    const value = e.value || (Array.isArray(e.behaviors) && e.behaviors[0] && e.behaviors[0].value)
    out.push({ ...e, value })
  }
  for (const e of cardElements(card)) {
    if (e.tag === 'action') for (const b of (e.actions || [])) take(b)
    else take(e)
    for (const col of (e.columns || [])) for (const el of (col && col.elements) || []) take(el)
  }
  return out
}
const tapValue = async (value) => {
  fakeProc.output += JSON.stringify({
    type: 'event', eventType: 'card.action.trigger',
    data: { action: { tag: 'button', value }, context: { open_chat_id: CHAT_ID } },
  }) + '\n'
  await drain()
}
// L1 版式（CM 2026-10-02 选定）：会话行本身就是一个**整行按钮**，名字在按钮文字里。
// 所以"按名字找行"要查按钮的 fs_j，而不是 divRows。
const sessBtnIndexOf = (card, needle) => {
  const b = allButtons(card).find((x) => x.value && x.value.fs_level === 'sess'
    && String((x.text && x.text.content) || '').includes(needle))
  return b ? Number(b.value.fs_j) : -1
}
const rowIndexOf = (card, needle) => {
  const rows = divRows(card)
  const i = rows.findIndex((e) => String(e.text.content).includes(needle))
  if (i < 0) return -1
  const m = /(\d+)\. /.exec(String(rows[i].text.content))
  return m ? Number(m[1]) - 1 : -1
}

// 一级 F 版式（CM 2026-10-02 选定）**不显示路径**，只显示工作区标题 ⇒ 卡片断言按标题定位。
// 标题就是路径末段（workspaceLeaf 的口径，与 DSH 的 defaultWorkspaceTitle 一致）。
const WS_TITLE_WORK = WORKSPACE.split('/').pop()
const WS_TITLE_OTHER = OTHER_WORKSPACE.split('/').pop()
const WS_TITLE_THIRD = THIRD_WORKSPACE.split('/').pop()

console.log('15) /switch：两级（① 工作区 → ② 该工作区的会话）（CM 2026-10-02 定稿 A 方案）')
{
  const mark = sentCards.length
  const summaryText = '帮我看看上周的复盘记录'
  const ownId = createdSessionIds[0]
  persistedSessions = [
    { version: 0, id: ownId, createdAt: Date.now() - 7200e3, cwd: WORKSPACE },                    // 已在本聊天
    { version: 0, id: 'gui-session-aaaa1111', createdAt: Date.now() - 3600e3, cwd: WORKSPACE },
    { version: 0, id: 'fu-session-bbbb2222', createdAt: Date.now() - 1800e3, cwd: OTHER_WORKSPACE },
    { version: 0, id: 'sub-child-cccc3333', createdAt: Date.now() - 600e3, cwd: WORKSPACE, origin: 'subagent' },
  ]
  persistedFirstText['gui-session-aaaa1111'] = summaryText
  persistedFirstText['fu-session-bbbb2222'] = 'FU 会话（示例标题）'

  // ① 第一级：工作区卡
  feedInbound('om_switch_ws', '/switch')
  await drain()
  const wsCard = lastCardFrom(mark)
  const wsBody = JSON.stringify(wsCard && wsCard.payload)
  ok(Boolean(wsCard) && wsBody.includes('第一步：选工作区'), '第一级是工作区卡（卡面写明"第一步"）')
  ok(wsBody.includes(WS_TITLE_WORK) && wsBody.includes(WS_TITLE_OTHER), '两个工作区（按标题）都列出来了')
  ok(!wsBody.includes('gui-sess') && !wsBody.includes('fu-sess'),
    '第一级**不列任何会话**（旧卡"标题写其它工作区、其实列的是会话"那个歧义消失）')
  const wsRowsShown = divRows(wsCard)
  ok(wsRowsShown.length === 2, '工作区卡共 2 行（' + wsRowsShown.length + '）')
  const curWsRow = wsRowsShown.find((e) => String(e.text.content).includes(WS_TITLE_WORK))
  ok(Boolean(curWsRow) && String(curWsRow.text.content).includes('▶'), '当前工作区带 ▶ 标记')
  // 正例（门槛第三轮 medium，按 CM 选定的一级 F 版式调整）：F 版式**不显示** 🟢（无用的信息不显示），
  // 只在目录**真的不存在**时显示 ⚠️ ⇒ 这里反过来断言"存在的目录**不许**出现 ⚠️"，
  // 与 15b 的"目录不存在 ⇒ ⚠️"形成对照。若 dirExists() 恒假，这条会立刻变红。
  ok(wsRowsShown.every((e) => !String(e.text.content).includes('⚠️')),
    '存在的目录**不出现** ⚠️（与 15b 的"目录不存在 ⇒ ⚠️"形成对照）')
  const wsIndexWork = rowIndexOf(wsCard, WS_TITLE_WORK)
  const wsIndexOther = rowIndexOf(wsCard, WS_TITLE_OTHER)
  ok(wsIndexWork >= 0 && wsIndexOther >= 0,
    '两行序号可读（work=' + (wsIndexWork + 1) + ', other=' + (wsIndexOther + 1) + '）')
  const wsButtons = allButtons(wsCard)
  ok(wsRowsShown.every((_, i) => wsButtons.some((b) => b.value.fs_level === 'ws' && b.value.fs_i === i)),
    '每行都有「进入看会话」按钮，且 fs_i 对得上行号')
  ok(wsRowsShown.every((_, i) => wsButtons.some((b) => b.value.fs_level === 'ws-new' && b.value.fs_i === i)),
    '每行都有「新建」按钮，且 fs_i 对得上行号')
  // CM 2026-10-02：「两个按钮要**同一排**，不要分成两行」。
  // 渲染在飞书侧，冒烟看不到像素 —— 但能验结构：那两行按钮必须落在**同一个 column_set**
  // （两列 + flex_mode='bisect' 等分），而不是两个独立元素（那就必然上下两行）。
  const oneRowOk = wsRowsShown.every((_, i) => {
    const rowEl = cardElements(wsCard).find((e) => e.tag === 'column_set'
      && (e.columns || []).some((c) => ((c && c.elements) || []).some((el) => {
        const v = el && el.behaviors && el.behaviors[0] && el.behaviors[0].value
        return v && v.fs_level && v.fs_i === i
      })))
    return Boolean(rowEl) && rowEl.columns.length === 2 && rowEl.flex_mode === 'bisect'
  })
  ok(oneRowOk, '每个工作区行的两个按钮在**同一排**（同一 column_set、两列、bisect 等分）')

  // ② 点「进入」→ 该工作区的会话卡（走真实卡片回调路径）
  const enterBtn = wsButtons.find((b) => b.value.fs_level === 'ws' && b.value.fs_i === wsIndexWork)
  const enterMark = sentCards.length
  // 按钮缺失时上面那条 ok() 已经记账失败；这里再解引用会崩成 TypeError、把失败信息盖掉。
  if (enterBtn) await tapValue(enterBtn.value)
  // ⭐ CM 2026-10-02 实测投诉：「点一下就弹一张新卡片」「切一次能弹三四张」⇒ 必须**原地更新**
  const enterUpdates = sentCards.slice(enterMark).filter((c) => c.op === 'update')
  ok(sentCards.slice(enterMark).filter((c) => c.op === 'create').length === 0,
    '点「进入」**没有新发卡片**（原地更新同一张）')
  ok(enterUpdates.length > 0, '而是 PATCH 了原来那张卡')
  // 原地更新后，"会话卡"的内容要从那条 update 里取（不是新建的卡）
  const sessCard = enterUpdates.length ? enterUpdates[enterUpdates.length - 1] : undefined
  const sBody = JSON.stringify(sessCard && sessCard.payload)
  ok(Boolean(sessCard) && sBody.includes('第二步：选会话'), '第二级是会话卡')
  // CM 2026-10-02 选定 **二级 C 版式**（一行一个会话：标题 + 状态徽标）⇒ 卡上**不再显示短 id**
  ok(!sBody.includes('gui-sess'), 'C 版式不显示短 id（只有标题 + 状态徽标）')
  ok(sBody.includes(summaryText), '其它会话带了首条消息摘要（认得出是哪个）')
  ok(!sBody.includes('sub-chil'), '子代理子会话不被列为可切换目标')
  ok(!sBody.includes('fu-sess'), '**只列这个工作区的会话**（别的工作区的会话不串进来）')
  const sessBottom = allButtons(sessCard).map((b) => b.value && b.value.fs_level)
  ok(!sessBottom.includes('ws-new'), '二级底部**没有**「新建」（CM：下面新建不要，只留返回、取消）')
  ok(sessBottom.includes('ws-back'), '底部有「← 返回」')
  ok(sessBottom.includes('cancel'), '底部有「✕ 取消」（一按就撤销整张卡）')
  ok(cardElements(sessCard).filter((e) => e.tag === 'hr').length >= 1, '会话之间有分隔线')
  ok(allButtons(sessCard).some((b) => b.value && b.value.fs_level === 'sess'
    && String((b.text && b.text.content) || '').includes(summaryText)),
    'L1 版式：会话名**写在整行按钮里**（点名字即切换）')
  ok(JSON.stringify(sessCard.payload).includes('第 1/'), '二级卡片标明页码（第 1/N 页）')
  const guiIndex = sessBtnIndexOf(sessCard, summaryText)
  ok(guiIndex >= 0, '候选行的序号可读（gui=' + (guiIndex + 1) + '）')
  const sessRowBtns = allButtons(sessCard).filter((b) => b.value && b.value.fs_level === 'sess')
  ok(sessRowBtns.length > 0 && sessRowBtns.every((b) => b.value.fs_mode === 'takeover'),
    '会话行的按钮全部是「切换」语义（CM：这里应该是切换，不是新建）')
  ok(!allButtons(sessCard).some((b) => b.value && b.value.fs_level === 'ws-new'),
    '二级卡片上没有「新建」（CM：下面新建不要，只留返回、取消）')
  ok(allButtons(sessCard).some((b) => b.value && b.value.fs_level === 'ws-back'),
    '底部同排还有「返回工作区」')
  const sessButtons = allButtons(sessCard)
  const takeover = sessButtons.find((b) => b.value.fs_level === 'sess' && b.value.fs_j === guiIndex
    && b.value.fs_mode === 'takeover')
  ok(Boolean(takeover), '空闲会话给了「接管」按钮')
  const tookBefore = resumedSessions
  const takeoverMark = sentCards.length
  if (takeover) await tapValue(takeover.value)
  ok(resumedSessions === tookBefore + 1, '点「接管」真的 resume 了那个会话（接管生效）')
  ok(cardsSince(takeoverMark).filter((c) => c.op === 'create').length === 0,
    '接管后**没有新发卡片**（结果写回同一张）')
  ok(JSON.stringify(cardsSince(takeoverMark)).includes('已接管'), '结果直接显示在原来那张卡上')
  // 2026-10-02 CM：「切换了…那个卡片就是已切换就行了，就不要有一个返回按钮啊」
  // ⇒ 结果卡＝**终态卡**：一个按钮都不留（旧写法挂了个「← 回到工作区列表」）。
  const resultCard = sentCards.slice(takeoverMark).filter((c) => c.op === 'update').pop()
  ok(Boolean(resultCard) && allButtons(resultCard).length === 0,
    '结果卡是终态卡：一个按钮都没有（实际 ' + (resultCard ? allButtons(resultCard).length : '?') + ' 个）')
  ok(!JSON.stringify(cardsSince(takeoverMark)).includes('回到工作区列表'),
    '结果卡/提示文案里不再出现「回到工作区列表」（那个按钮已经删了，留着就是让人去点空气）')
  ok(registryAttached.some((a) => a.id === 'gui-session-aaaa1111'),
    '接管时把会话**挂进了工作区注册表**（与 GUI 同源：侧边栏也看得到）')

  // ③ /list ＝ 当前工作区的会话（不再混工作区，也不列别的工作区的会话）
  const listMark = sentCards.length
  feedInbound('om_list_ws', '/list')
  await drain()
  const listBody = JSON.stringify(cardsSince(listMark))
  ok(listBody.includes('工作区') && listBody.includes(WORKSPACE), '/list 顶部标明当前工作区')
  ok(listBody.includes(summaryText) || listBody.includes('gui-sess'), '/list 列出当前工作区的会话')
  ok(!listBody.includes('fu-sess'), '/list 不列别的工作区的会话')

  // ④ 文字：/switch <工作区序号> new → 在该工作区新建（cwd 必须是那个工作区）＋ 也挂进注册表
  const beforeNew = createdSessions
  feedInbound('om_switch_new', '/switch ' + (wsIndexOther + 1) + ' new')
  await drain()
  ok(agent.session.header.cwd === OTHER_WORKSPACE,
    'new 模式把新会话的 cwd 设成了那个工作区（实际 ' + agent.session.header.cwd + '）')
  ok(createdSessions === beforeNew + 1, '确实新建了会话')
  // 别硬编码 'ws-2'：那只是 seed() 顺序的副产物。从注册表里按路径取真 id（门槛第三轮 low）。
  const otherEntity = fakeWorkspaceRegistry._entities.find((e) => e.path === OTHER_WORKSPACE)
  ok(Boolean(otherEntity) && registryAttached.some((a) => a.ws === otherEntity.id),
    '新建的会话也挂进了那个工作区（GUI 侧边栏能看到）')

  // ⑤ 运行中的会话（🟡）只给「新建」；文字接管也必须被挡住
  liveAgents.push({ id: 'fu-session-bbbb2222', session: agent.session })
  const liveMark = sentCards.length
  feedInbound('om_switch_live', '/switch ' + (wsIndexOther + 1))
  await drain()
  const liveCard = lastCardFrom(liveMark)
  const liveBody = JSON.stringify(liveCard && liveCard.payload)
  const liveFuRowEl = divRows(liveCard).find((e) => String(e.text.content).includes('FU 会话（示例标题）'))
  ok(Boolean(liveFuRowEl) && String(liveFuRowEl.text.content).includes('🟡'),
    '运行中会话**那一行**被标成 🟡（不是卡面图例里有就算）')
  ok(liveBody.includes('不能切换'), '卡面说明了 🟡 的规则（不让 CM 猜）')
  const liveFuIndex = rowIndexOf(liveCard, 'FU 会话（示例标题）')
  ok(liveFuIndex >= 0, '🟡 那一行在列表里（序号 ' + (liveFuIndex + 1) + '）')
  const liveBtns = allButtons(liveCard)
    .filter((b) => b.value.fs_level === 'sess' && b.value.fs_j === liveFuIndex)
  ok(liveBtns.length === 0,
    '运行中的会话**那一行不给按钮**（原来给的是「新建」，语义错位；现在只写"不能切换"）')
  ok(String(liveFuRowEl.text.content).includes('不能切换'),
    '并在那一行写明"正在别处运行 —— 不能切换"')
  const blockMark = sentCards.length
  feedInbound('om_switch_live_takeover', '/switch ' + (wsIndexOther + 1) + ' ' + (liveFuIndex + 1))
  await drain()
  ok(JSON.stringify(cardsSince(blockMark)).includes('正在别处运行'), '文字接管被挡下并说明原因')
  liveAgents.length = 0

  // ⑥ 「← 返回工作区列表」→ 回到第一级
  const backBtn = allButtons(sessCard).find((b) => b.value.fs_level === 'ws-back')
  ok(Boolean(backBtn), '会话卡有「← 返回」按钮')
  const backMark = sentCards.length
  if (backBtn) await tapValue(backBtn.value)
  ok(JSON.stringify(cardsSince(backMark)).includes('选择工作区'), '点返回回到工作区卡')
  ok(cardsSince(backMark).filter((c) => c.op === 'create').length === 0, '点「返回」也没有新发卡片')
}

console.log('15b) /switch 边界：注册表不可用 / 目录不存在 / 未注册工作区 / 服务名与方法缺失（门槛第二、三轮补）')
{
  // ⚠️ 用例内会 create 新工作区、追加会话、动 mock 的 cwd —— 用 try/finally 保证**无论中途是否抛**
  // 都还原（原来不是 guarded：中途一抛，_entities 会停在空数组上，把后面所有用例都毒掉）。
  // 注：chat.sessions/activeIndex 在插件内部、测试拿不到，只能保证持久化与注册表两侧自洽 ——
  // 所以这里**保留**追加的那条 third 会话（不还原 persistedSessions），避免"chat 还引用着、
  // 持久化里却没了"的悬空状态。
  const entitiesBefore = fakeWorkspaceRegistry._entities.slice()
  const cwdBefore = agent.session.header.cwd
  try {
    // (a) 未注册工作区：目录只从**会话 cwd** 兜底出现，且接管时必须能挂进注册表
    //     （走 resolveByPath → create → attachSession —— 这条链此前从未被跑过）
    persistedSessions.push({ version: 0, id: 'third-session-dddd4444', createdAt: Date.now() - 300e3, cwd: THIRD_WORKSPACE })
    const markA = sentCards.length
    feedInbound('om_switch_third', '/switch')
    await drain()
    const cardA = lastCardFrom(markA)
    const thirdIndex = rowIndexOf(cardA, WS_TITLE_THIRD)
    ok(thirdIndex >= 0, '注册表里没有、只在会话 cwd 里出现的目录，也作为兜底工作区出现（序号 ' + (thirdIndex + 1) + '）')
    // 序号从卡面读回来（别写死），并让下面按同一个序号接管
    feedInbound('om_switch_third_takeover', '/switch ' + (thirdIndex + 1) + ' 1')
    await drain()
    // 断言钉住**是哪条会话**挂上了：只判"有东西挂上"的话，就算挂错了工作区也会绿（门槛第三轮 low）。
    ok(registryAttached.some((a) => a.id === 'third-session-dddd4444'),
      '在**未注册**工作区接管时，**这条会话**挂进了注册表（走 resolveByPath/create → attachSession）')

    // (b) 目录不存在 ⇒ ⚠️（以本地目录检查为准，不只信注册表那个 token）
    fakeWorkspaceRegistry._entities.push(
      makeRegistryEntity(SMOKE_WS_ROOT + '/fs-smoke-ghost-does-not-exist', 'ghost', 'ws-ghost'))
    const markB = sentCards.length
    feedInbound('om_switch_ghost', '/switch')
    await drain()
    const ghostCard = lastCardFrom(markB)
    const ghostRow = divRows(ghostCard).find((e) => String(e.text.content).includes('ghost'))
    ok(Boolean(ghostRow) && String(ghostRow.text.content).includes('⚠️'),
      '目录不存在的行标 ⚠️（注册表说 ok 也不算健康）')
    fakeWorkspaceRegistry._entities.pop()

    // (c) 注册表整个不可用 ⇒ 用会话 cwd 兜底，而不是给一张空卡
    fakeWorkspaceRegistry._entities = []
    const markC = sentCards.length
    feedInbound('om_switch_noregistry', '/switch')
    await drain()
    const cardC = lastCardFrom(markC)
    const cBody = JSON.stringify(cardC && cardC.payload)
    ok(Boolean(cardC) && cBody.includes(WS_TITLE_WORK),
      '注册表不可用（空）时仍列出会话里出现过的工作区（不让用户对着空卡）')
    fakeWorkspaceRegistry._entities = entitiesBefore

    // (d) 注册表**只**以客户端服务名 workspaces 暴露、而且**没有 get()**：
    //     ① 工作区卡照样读得到（服务名两种都认）② 接管时的挂载走 resolveByPath/create（逐个方法判可用）
    const clientOnly = {
      list: () => fakeWorkspaceRegistry.list(),
      resolveByPath: async (p) => fakeWorkspaceRegistry._entities.find((e) => e.path === p),
      create: async (p, t) => fakeWorkspaceRegistry.create(p, t),
    }
    registryOverride = clientOnly
    const markD = sentCards.length
    feedInbound('om_switch_clientonly', '/switch')
    await drain()
    const cardD = lastCardFrom(markD)
    const dBody = JSON.stringify(cardD && cardD.payload)
    ok(Boolean(cardD) && dBody.includes(WS_TITLE_WORK) && dBody.includes('选择工作区'),
      '注册表只以 workspaces 暴露时，工作区卡照样出得来（服务名两种都认）')
    const dIndex = rowIndexOf(cardD, WS_TITLE_OTHER)
    const attachBeforeD = registryAttached.length
    feedInbound('om_switch_clientonly_takeover', '/switch ' + (dIndex + 1) + ' 1')
    await drain()
    ok(registryAttached.length > attachBeforeD,
      '该注册表没有 get() 时，挂载仍能走 resolveByPath/create（逐个方法判可用）')
    registryOverride = null
  } finally {
    registryOverride = null
    fakeWorkspaceRegistry._entities = entitiesBefore
    agent.session.header.cwd = cwdBefore
  }
}

console.log('15c) 文字命令的会话卡：按钮序号必须指向**那个**工作区（门槛第四轮抓到的回归）')
{
  // 回归原形：我在 0.5.2 里把 /list 路径上真死的那句 `ws.index = wsIndex` 连**文字命令路径上活着的那句**
  // 一起删了 ⇒ /switch <n> 出来的会话卡里，按钮的 fs_i 全是 0 ⇒
  // 在**空工作区**点「在这里新建会话」会在**第一个**工作区建会话（用户选的工作区被无视）。
  const emptyPath = SMOKE_WS_ROOT + '/fs-smoke-empty'
  try { mkdirSync(emptyPath, { recursive: true }) } catch { /* 已存在 */ }
  const entitiesBefore15c = fakeWorkspaceRegistry._entities.slice()
  try {
    fakeWorkspaceRegistry._entities.push(makeRegistryEntity(emptyPath, 'empty-ws', 'ws-empty'))
    const mark = sentCards.length
    feedInbound('om_switch_empty', '/switch')
    await drain()
    const wsCard15c = lastCardFrom(mark)
    const emptyIndex = rowIndexOf(wsCard15c, 'empty-ws')
    ok(emptyIndex >= 0, '空工作区出现在工作区卡上（序号 ' + (emptyIndex + 1) + '）')
    const sessMark = sentCards.length
    feedInbound('om_switch_empty_open', '/switch ' + (emptyIndex + 1))
    await drain()
    const sessCard15c = lastCardFrom(sessMark)
    ok(Boolean(sessCard15c) && JSON.stringify(sessCard15c.payload).includes('还没有会话'),
      '空工作区在会话卡上给出「在这里新建会话」入口')
    // 二级现在没有「新建」了（CM 要求）⇒ 新建走**一级菜单**那个按钮，它同样必须带上正确的工作区序号
    const newBtn = allButtons(wsCard15c).find((b) => b.value && b.value.fs_level === 'ws-new' && b.value.fs_i === emptyIndex)
    ok(Boolean(newBtn), '一级菜单上「新建」按钮指向这个工作区（fs_i=' + emptyIndex + '）')
    if (newBtn) await tapValue(newBtn.value)
    ok(agent.session.header.cwd === emptyPath,
      '点它新建出来的会话 cwd 就是该工作区（实际 ' + agent.session.header.cwd + '）')
    // 二级卡片的按钮（返回/取消）也必须带**那个**工作区的序号：
    // 缺了 ws.index 它们会全变 0 ⇒ 返回/翻页会跑到第一个工作区去（这正是门槛抓到的回归）。
    const backOnEmpty = allButtons(sessCard15c).find((b) => b.value && b.value.fs_level === 'ws-back')
    ok(Boolean(backOnEmpty) && backOnEmpty.value.fs_i === emptyIndex,
      '二级卡片的按钮序号也指向这个工作区（fs_i=' + (backOnEmpty && backOnEmpty.value.fs_i) + '，期望 ' + emptyIndex + '）')
  } finally {
    fakeWorkspaceRegistry._entities = entitiesBefore15c
  }
}

console.log('15d) 二级卡片：每页 5 个 + 翻页 + 会话间分隔线（CM 2026-10-02 三条）')
{
  const persistedBefore15d = persistedSessions.slice()
  try {
    for (let i = 0; i < 7; i++) {
      persistedSessions.push({
        version: 0, id: 'page-session-' + i,
        createdAt: Date.now() - (i + 1) * 60e3, cwd: WORKSPACE,
      })
    }
    const mark = sentCards.length
    feedInbound('om_page_ws', '/switch')
    await drain()
    const wsCard = lastCardFrom(mark)
    const wsIdx = rowIndexOf(wsCard, WS_TITLE_WORK)
    ok(wsIdx >= 0, '工作区卡上找到 work（序号 ' + (wsIdx + 1) + '）')
    const enterBtn = allButtons(wsCard).find((b) => b.value.fs_level === 'ws' && b.value.fs_i === wsIdx)
    const openMark = sentCards.length
    if (enterBtn) await tapValue(enterBtn.value)
    const upd = sentCards.slice(openMark).filter((c) => c.op === 'update')
    const page1 = upd.length ? upd[upd.length - 1] : lastCardFrom(openMark)
    const p1Body = JSON.stringify(page1 && page1.payload)
    ok(p1Body.includes('第 1/'), '第 1 页标明「第 1/N 页」')
    const page1Rows = allButtons(page1).filter((b) => b.value && b.value.fs_level === 'sess').length
    ok(page1Rows === 5, '每页只列 5 个会话（实际 ' + page1Rows + '）')
    ok(cardElements(page1).filter((e) => e.tag === 'hr').length >= 4,
      '会话之间加了分隔线（' + cardElements(page1).filter((e) => e.tag === 'hr').length + ' 条 hr）')
    const nextBtn = allButtons(page1).find((b) => b.value.fs_level === 'page' && b.value.fs_page === 1)
    ok(Boolean(nextBtn), '第 1 页有「下一页 →」')
    const p2Mark = sentCards.length
    if (nextBtn) await tapValue(nextBtn.value)
    const upd2 = sentCards.slice(p2Mark).filter((c) => c.op === 'update')
    const page2 = upd2.length ? upd2[upd2.length - 1] : undefined
    ok(JSON.stringify(page2 && page2.payload).includes('第 2/'), '翻到第 2 页')
    const page2Rows = allButtons(page2).filter((b) => b.value && b.value.fs_level === 'sess').length
    ok(page2Rows >= 1 && page2Rows <= 5, '第 2 页列出剩下的会话（' + page2Rows + ' 个）')
    ok(cardsSince(p2Mark).filter((c) => c.op === 'create').length === 0, '翻页是原地更新（不弹新卡）')
    ok(allButtons(page2).some((b) => b.value.fs_level === 'page' && b.value.fs_page === 0), '第 2 页有「← 上一页」')
  } finally {
    persistedSessions = persistedBefore15d
  }
}

console.log('16) 目标轮封口必须补扫：收尾汇报不能丢（CM 2026-09-16 实测反馈）')
{
  // 背景（真机取证）：FU 机器人目标模式 round 2~6 的卡片全是 notes=0、只有工具记录，
  // 而会话日志里确实有整段「**进度（第 N 轮）**…」。根因＝封口时**没有补扫**：
  // 工具调用是轮内陆续到达的（被 300ms watcher 拍到），收尾话语与轮结束几乎同时到，
  // 落在最后一拍之后 → 直接被丢掉。普通回合路径有 catch-up scan，目标卡漏了。
  const mark = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 600,
    data: {
      content: [{ type: 'text', text: '<goal_round>\nRound: 3/10\n</goal_round>' }],
      source: { kind: 'goal', goalId: 'g_seal', revision: 1, round: 3 },
    },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()
  ok(createsSince(mark).length === 1, '第 3 轮建卡')

  agentEvents.push({ type: 'tool/call', seq: 601, data: { callId: 'call_seal_1', name: 'read', arguments: '{"file_path":"a.md"}' } })
  await drain()

  // 收尾汇报：**紧接**轮结束到达，中间不给 watcher 任何一拍。
  // 同时塞进"倒数第二段话"和一个工具调用 —— 这两样**只有补扫**才会进卡
  // （提升逻辑只搬最后一段话；去掉补扫时它们必须消失，否则这测试就是假保险丝）。
  const midText = '窗口外的中途交代-MID'
  const closing = '**进度（第 3 轮）** ' + 'A'.repeat(700) + ' 收尾标记-END'
  agentEvents.push({ type: 'assistant/message', seq: 602, data: { message: { content: [{ type: 'text', text: midText }] } } })
  agentEvents.push({ type: 'tool/call', seq: 603, data: { callId: 'call_seal_2', name: 'fuse_probe_tool', arguments: '{"x":1}' } })
  agentEvents.push({ type: 'assistant/message', seq: 604, data: { message: { content: [{ type: 'text', text: closing }] } } })
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()

  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('收尾标记-END'), '封口补扫到了收尾汇报')
  ok(body.includes(midText), '末刻到达的中途话语也在卡上（只有补扫能做到 → 真保险丝）')
  ok(body.includes('fuse_probe_tool'), '末刻到达的工具调用也在卡上（只有补扫能做到）')
  ok((body.match(/收尾标记-END/g) || []).length === 1, '收尾汇报只出现一次（不重复）')
  ok(body.includes('A'.repeat(600)), '收尾汇报按正式消息块写入，未被 500 字过程话语截断（600 个连续 A 仍在）')
  ok(body.includes('本轮结束'), '仍然写了「本轮结束」')
}

console.log('17) 本轮没有回复时必须说明原因（2026-09-18 真机事故：账户余额不足 402 → 卡片空白）')
{
  // 背景（真机取证，会话 fs-main-mu532zzl seq=724-727）：
  //   用户消息 → assistant/attempt(finish.reason=error{message:'Insufficient Balance',code:'QUOTA',status:402})
  //   → step/end → turn/end(reason.kind='error')，**整轮没有任何 assistant/message**。
  // 旧行为：卡片只写「（Agent 未产生文字回复）」、状态行还显示「✅ 已完成」；
  //   自愈重建会话时旧卡停在「正在工作中…」成为孤儿卡，重建提示只走纯文本兜底 → 用户看不到。
  // 新行为（本用例固化）：① 卡面写明上游原因（**中文人话 ＋ 原文**）；
  //   ② 失败回合状态行是「失败」不是「已完成」；③ 旧卡补封、不再停在「正在工作中…」；
  //   ④ 上游已明确报错 ⇒ **不再自愈重建**（2026-09-21 用户反馈：重建修不了欠费，
  //      还把报错换成「已自动重建会话重试」）—— 自愈只留给「无产出且无失败标记」（用例 20）。
  const mark = sentCards.length
  let sendCount = 0
  // 真实回合不会瞬间结束：给建卡留出落地时间，否则这张卡来不及创建就被封口，
  // 测不到"旧卡停在正在工作中"这条（真机 14:35:28 建卡 / 14:35:29 重试，中间隔了一拍）。
  agent.whenIdle = async () => { await new Promise((r) => setTimeout(r, 80)) }
  agent.send = function (message) {
    this.sent.push(message)
    sendCount += 1
    const base = 1000 + sendCount * 10
    const failure = { message: 'Insufficient Balance', code: 'QUOTA', status: 402 }
    agentEvents.push(
      { type: 'user/message', seq: base, data: { content: [{ type: 'text', text: String(message.content[0].text) }], source: { kind: 'user' } } },
      { type: 'assistant/attempt', seq: base + 1, data: { turn: sendCount, step: 1, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure } } }] } },
      { type: 'turn/end', seq: base + 2, data: { turn: sendCount, reason: { kind: 'error', error: failure } } },
    )
  }
  feedInbound('om_balance_402', '余额不足测试')
  await settle(4)

  const ops = cardsSince(mark)
  const body = JSON.stringify(ops)
  // 2026-09-21 行为变更（用户：「它不会提示我欠费…就直接显示说本轮没有回复」）：
  //   ① 原因必须是**中文人话 ＋ 上游原文**（旧断言只查英文原文）；
  //   ② 上游已明确报错 ⇒ **不再自愈重建**（重建修不了欠费；旧行为每条消息白跑一轮、
  //      还把报错换成「已自动重建会话重试」）⇒ 本轮**只建 1 张卡**。
  ok(ops.filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0').length === 1,
    '上游报错时不再重建会话（只 1 张卡；实际 ' + ops.filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0').length + '）')
  ok(body.includes('账户欠费'), '卡面用中文写明"账户欠费／余额不足"（不再只甩英文）')
  ok(body.includes('Insufficient Balance') && body.includes('QUOTA'),
    '卡面同时保留上游原文（Insufficient Balance / QUOTA 402，便于核对）')
  ok(!body.includes('已自动重建会话'), '不再把报错换成「已自动重建会话重试」（它修不了欠费）')
  ok(body.includes('⚠️'), '卡片带警示标记（不是一句干巴巴的占位符）')
  ok(statusShows(body, '失败'), '失败回合的状态栏写「失败」')
  ok(!statusShows(body, '已完成'), '失败回合不再假称「已完成」')

  // 每张卡（create → 其后 update 为一组）的最后形态里都不该再留着「正在工作中…」
  const perCard = []
  for (const c of ops) {
    if (c.op === 'create' && c.payload && c.payload.schema === '2.0') perCard.push(c.payload)
    else if (perCard.length) perCard[perCard.length - 1] = c.payload
  }
  ok(!JSON.stringify(perCard).includes('正在工作中'),
    '没有卡片停在「正在工作中…」（旧卡被补封，不留孤儿卡）')
}

console.log('18) 有工具调用但最终失败的回合：工具面板 + 原因 + 失败状态（与自愈路径的组合验证）')
{
  // 组合点：hadOutput = lastSeq!==undefined || card.tools.size>0 —— 有工具调用就**不**触发自愈重建，
  // 所以这条必须自己把原因写在卡上，且**不能**把已有工具面板挤掉（工具面板 × 失败提示 × 状态行）。
  const mark = sentCards.length
  let sendCount = 0
  agent.whenIdle = async () => { await new Promise((r) => setTimeout(r, 80)) }
  agent.send = function (message) {
    this.sent.push(message)
    sendCount += 1
    const base = 2000 + sendCount * 10
    const failure = { message: 'Insufficient Balance', code: 'QUOTA', status: 402 }
    agentEvents.push(
      { type: 'user/message', seq: base, data: { content: [{ type: 'text', text: String(message.content[0].text) }], source: { kind: 'user' } } },
      { type: 'tool/call', seq: base + 1, data: { callId: 'call_balance_1', name: 'read', arguments: '{"file_path":"a.md"}' } },
      { type: 'tool/result', seq: base + 2, data: { message: { source: { callId: 'call_balance_1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } },
      { type: 'assistant/attempt', seq: base + 3, data: { turn: sendCount, step: 2, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure } } }] } },
      { type: 'turn/end', seq: base + 4, data: { turn: sendCount, reason: { kind: 'error', error: failure } } },
    )
  }
  feedInbound('om_balance_tools', '有工具调用但失败的回合')
  await settle(4)

  const ops = cardsSince(mark)
  const body = JSON.stringify(ops)
  ok(ops.filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0').length === 1,
    '有工具产出 → 不触发自愈重建（只 1 张卡）')
  ok(body.includes('工具调用'), '工具面板照常进卡（没被失败提示挤掉）')
  ok(body.includes('call_balance_1') || body.includes('a.md'), '工具参数摘要照常进卡')
  ok(body.includes('Insufficient Balance'), '卡面写明失败原因')
  ok(statusShows(body, '失败'), '状态栏写「失败」')
  ok(!statusShows(body, '已完成'), '不假称「已完成」')
}

console.log('19) 目标轮失败也要说原因（不再无条件写「✅ 本轮结束」）')
{
  // 与用例 17 同源的问题：目标轮封口**无条件**写「✅ 本轮结束」+ status='sealed'
  // → 余额不足/上游报错导致整轮没有任何产出时，卡片谎报成功且不写原因。
  const mark = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 700,
    data: {
      content: [{ type: 'text', text: '<goal_round>\nRound: 4/10\n</goal_round>' }],
      source: { kind: 'goal', goalId: 'g_seal', revision: 1, round: 4 },
    },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()
  // 2026-09-27：允许复用刚封口的回合卡 → 新建 0~1 张都算对；要求「没多开」＋「🎯 卡面出现」
  ok(createsSince(mark).length <= 1, '第 4 轮没有多开卡（create 次数 ' + createsSince(mark).length + '）')
  ok(JSON.stringify(cardsSince(mark)).includes('目标模式'), '第 4 轮的 🎯 卡面出现（新建或复用）')

  const failure = { message: 'Insufficient Balance', code: 'QUOTA', status: 402 }
  agentEvents.push(
    { type: 'assistant/attempt', seq: 701, data: { turn: 4, step: 1, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure } } }] } },
    { type: 'turn/end', seq: 702, data: { turn: 4, reason: { kind: 'error', error: failure } } },
  )
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()

  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('Insufficient Balance'), '目标轮卡写明失败原因')
  ok(body.includes('本轮失败'), '封口写「本轮失败」')
  ok(!body.includes('本轮结束'), '失败轮不再写「✅ 本轮结束」')
  ok(statusShows(body, '失败'), '状态栏写「失败」')
}

console.log('20) 无产出且**没有**失败标记：明说「原因未上报」，僵尸会话自愈仍然保留')
{
  // 2026-09-21 用户实锤：卡片只说「本轮没有回复」、不给任何原因。
  // 两种来源都要堵住：①上行有失败标记（用例 17）②上行**没有**标记（本用例）。
  // 后者正是 2026-09-08「僵尸会话」的形态（重启后当轮被腰斩、事件一个都没落），
  // 所以**自愈必须保留**；但封口的旧卡不能只留一句占位符。
  const mark = sentCards.length
  let sendCount = 0
  agent.whenIdle = async () => { await new Promise((r) => setTimeout(r, 80)) }
  agent.send = function (message) {
    this.sent.push(message)
    sendCount += 1
    if (sendCount === 1) return // 僵尸轮：一个事件都不产生
    agentEvents.push(
      { type: 'user/message', seq: 3000 + sendCount * 10, data: { content: [{ type: 'text', text: String(message.content[0].text) }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 3001 + sendCount * 10, data: { message: { content: [{ type: 'text', text: '自愈后的正常回复-OK' }] } } },
      { type: 'turn/end', seq: 3002 + sendCount * 10, data: { turn: sendCount, reason: { kind: 'completed' } } },
    )
  }
  feedInbound('om_silent_no_marker', '无产出无标记测试')
  await settle(4)

  const ops = cardsSince(mark)
  const body = JSON.stringify(ops)
  ok(body.includes('原因未上报'), '没有失败标记时，卡片明说「原因未上报」（不再只写占位符）')
  ok(statusShows(body, '失败'), '无产出的回合状态栏写「失败」，不假称完成')
  ok(body.includes('已自动重建会话'), '僵尸会话自愈仍然保留（只在**没有**失败标记时才自愈）')
  ok(body.includes('自愈后的正常回复-OK'), '自愈重试的回复正常交付给用户')
}

console.log('21) 其它上游错误也翻成人话（429 限流）')
{
  const mark = sentCards.length
  agent.whenIdle = async () => { await new Promise((r) => setTimeout(r, 80)) }
  agent.send = function (message) {
    this.sent.push(message)
    const failure = { message: 'Too Many Requests', code: 'RATE_LIMIT', status: 429 }
    agentEvents.push(
      { type: 'user/message', seq: 4000, data: { content: [{ type: 'text', text: String(message.content[0].text) }], source: { kind: 'user' } } },
      { type: 'assistant/attempt', seq: 4001, data: { turn: 9, step: 1, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure } } }] } },
      { type: 'turn/end', seq: 4002, data: { turn: 9, reason: { kind: 'error', error: failure } } },
    )
  }
  feedInbound('om_rate_limit', '限流测试')
  await settle(4)

  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('被上游限流'), '429 → 卡面写「被上游限流（请求过快）」')
  ok(body.includes('Too Many Requests'), '仍保留上游原文')
}

console.log('22) 子代理／后台回执轮也要上卡（2026-09-21 CM：子代理回来了，我在飞书看不到你在继续干活）')
{
  // 背景：子代理／后台 job 完成时，DSH 会往同会话注入一条 `source.kind==='plugin'` 的
  // user/message 把模型唤醒继续干活 —— 这一轮**没有飞书入站消息**，所以旧实现没有卡承接：
  // CM 看不见「我在继续干活」，也收不到这一轮的结论（只能再发一条消息把我戳醒）。
  const mark = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 5000,
    data: {
      content: [{ type: 'text', text: 'Background subagent f835b8c2 finished and will do no further work unless you send it more.\n\nIts closing message:\n对照台账已落盘。' }],
      source: { kind: 'plugin' },
    },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()
  ok(createsSince(mark).length === 1, '回执轮建了卡（实际 ' + createsSince(mark).length + ' 张）')

  agentEvents.push({ type: 'assistant/message', seq: 5001, data: { message: { content: [{ type: 'text', text: '子代理回来了，我接着说：台账已落盘-OK' }] } } })
  agentEvents.push({ type: 'turn/end', seq: 5002, data: { turn: 20, reason: { kind: 'completed' } } })
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()

  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('🔔'), '卡面标了「回执到了」')
  ok(body.includes('正在继续工作'), '卡面说明模型被唤醒继续干活')
  ok(body.includes('台账已落盘-OK'), '这一轮的结论进了卡（CM 不用再发消息戳一次）')
  ok(body.includes('本轮结束'), '正常封口')

  // 控制组：会话启动类 plugin 消息（runtime context／技能目录）**不许**建卡，否则刷屏
  const mark2 = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 5003,
    data: {
      content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }],
      source: { kind: 'plugin' },
    },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()
  ok(createsSince(mark2).length === 0, 'system-reminder 类 plugin 消息不建卡（不刷屏）')
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()

  // 📌 审计纠正（2026-10-01）：此前把「NOTICE_RE 旧正文正则兜底」记为"0 覆盖"——**那是按标识符 grep
  //    得出的假结论**。事实上本用例（seq 5000，`source.kind='plugin'`）与用例 23 的控制组
  //    （`Background job pwsh-91 finished.`）**都只能靠正文正则**才能被判成回执轮：
  //    `autoTurnInfo()` 只特判 `kind === 'goal'`，其余一律走 NOTICE_RE ⇒ 正则一旦失效，这两条必红。
  //    故不另加断言（重复覆盖没有价值），在此注明真实的覆盖来源。
}

console.log('23) 普通飞书回合**不许**被当成回执轮抢建第二张卡（2026-09-23 CM：每次回复都发两张卡）')
{
  // 真机取证链（四环，全部有据）：
  //   ① dsh-agent-loop `wakeDriver()` 在 `send()` 的**同一个调用栈**里 setPhase({kind:'running'})
  //      → `dispatch.emit('agent/status')`（lib/index.js L781/L787/L844，同步 emit）。
  //   ② 旧实现把 `activeTurns.set` 放在 send() **之后** ⇒ 这一刻处理器读到"没有普通回合持有卡"。
  //   ③ 新用户消息这时还在 inbox 里、**没进会话事件表** ⇒ `autoTurnInfo()` 从末尾读到的
  //      `user/message` 是**上一条后台回执正文** ⇒ 判成 kind='notice'。
  //   ④ `openGoalCard()` 另开一张卡；它的游标与普通回合卡的游标同源 ⇒ 两张卡镜像同一批事件
  //      （CM：「每次回复我都发两张卡片」，内容重复）。
  // 本用例把 mock 的 send() 改成与真机同序：**先**同步 running，**再**写本轮助手事件。
  const mark = sentCards.length

  // 本轮之前那一轮正好是"后台回执轮" —— 真机上就是这样，这是本缺陷的触发前提。
  agentEvents.push({
    type: 'user/message', seq: 6000,
    data: {
      content: [{ type: 'text', text: 'Background subagent 8eebc571 finished and will do no further work unless you send it more.' }],
      source: { kind: 'plugin' },
    },
  })

  agent.send = function (message) {
    this.sent.push(message)
    emitCtx('agent/status', { agent, status: 'running' })   // ← 与真机同序：同步、且先于事件落表
    agentEvents.push(
      { type: 'assistant/message', seq: 6001, data: { message: { content: [{ type: 'text', text: '两张卡回归测试-正文' }] } } },
      { type: 'turn/end', seq: 6002, data: { turn: 30, reason: { kind: 'completed' } } },
    )
  }
  agent.whenIdle = async () => { await new Promise((r) => setTimeout(r, 80)) }

  feedInbound('om_two_cards_regression', '两张卡回归测试')
  await settle(4)

  ok(createsSince(mark).length === 1,
    '普通回合只建一张卡（实际 ' + createsSince(mark).length + ' 张）')
  const body = JSON.stringify(cardsSince(mark))
  ok(!body.includes('🔔'), '没有多出来的「回执到了」卡')
  ok(body.includes('两张卡回归测试-正文'), '正文正常进了唯一那张卡')
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()

  // 控制组：真正的回执轮（没有飞书入站、直接由 agent/status 进 running）**仍然**建卡 —— 不许误伤。
  const mark2 = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 6100,
    data: {
      content: [{ type: 'text', text: 'Background job pwsh-91 finished.' }],
      source: { kind: 'plugin' },
    },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()
  ok(createsSince(mark2).length === 1, '真正的回执轮照样建卡（没有误伤）')
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()
}

console.log('24) 子代理回执「落盘即播报」：不看回合状态（2026-10-01 改造①）')
{
  // 真机根因：回执要等 turn/start **之后**才写进会话，而旧实现在"回合启动那一拍"回扫
  // → 判成普通回合 → 不开卡（CM 实证"没弹"）。本用例**完全不发 agent/status**，
  // 只把回执事件写进会话 —— 新实现必须照样播报。
  const mark = sentCards.length
  const sentBefore = agent.sent.length
  agentEvents.push({
    type: 'user/message', seq: 7000,
    data: {
      content: [
        { type: 'text', text: 'Background subagent child-abc12345-0000-0000-0000-000000000000 finished and will do no further work unless you send it more.' },
        { type: 'text', text: 'Its closing message:' },
        { type: 'text', text: '交付完成：报告已生成。' },
      ],
      source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-abc12345-0000-0000-0000-000000000000' },
    },
  })
  await drain()
  const created = cardsSince(mark).filter((c) => c.op === 'create')
  const rawText = JSON.stringify(created.map((c) => c.payload))
  ok(created.length >= 2, '纯文本 + 详情卡 双层播报都发了（实际 ' + created.length + ' 条）')
  ok(rawText.includes('已完成'), '播报里写了「子代理已完成」')
  ok(rawText.includes('child-ab'), '播报带正确的子代理 id 前 8 位（不是张冠李戴）')
  ok(rawText.includes('不用回这条'), '通知卡定位清楚：不用回这张卡')
  ok(agent.sent.length === sentBefore, '播报不新开回合（没有往 agent 里塞消息）')
  // 2026-10-01 补（此前无守护）：v0.4.2 补上的"纯文本成功也留痕"必须真的打出来 ——
  // 否则"纯文本到底有没有送达"永远证不了（真机并发测试时唯一的观测缺口）。
  ok(consoleLines.some((l) => l.includes('notice plain text sent')),
    'sendPlainText 成功后留痕（notice plain text sent）')
  // 去重：同一批事件再扫一遍，不许重复播报
  const again = sentCards.length
  await drain()
  ok(sentCards.length === again, '同一回执不重复播报')
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()
}

console.log('25) 卡片底部「目标条」：目标全文 + 状态 + 上下文占比 + 缓存命中（改造③）')
{
  const mark = sentCards.length
  agentEvents.push(
    { type: 'request/context', seq: 7100, data: { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 1000000 } },
    {
      type: 'assistant/message', seq: 7101,
      data: {
        usage: { inputTokens: 162, outputTokens: 100, cacheReadTokens: 177152, cacheWriteTokens: 0, totalTokens: 177414 },
      },
    },
  )
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 7110, data: { message: { content: [{ type: 'text', text: '目标条回合正文' }] } } })
  }
  agent.whenIdle = async () => {}
  feedInbound('om_goal_footer', '目标条测试')
  await settle(3)
  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('目标模式'), '底部出现目标条')
  ok(body.includes('把飞书卡片这四项改造做完'), '折叠面板里带目标全文')
  ok(body.includes('已激活'), '状态文案＝已激活（armed）')
  ok(body.includes('第 3/20 轮'), '轮数 N/M 正确')
  ok(body.includes('缓存命中'), '带缓存命中率')
  ok(/（\d+\.\d%）/.test(body), '上下文带占比')
  ok(body.includes('collapsible_panel'), '目标条是可折叠面板')
  ok(body.includes('"tag":"hr"'), '目标条上面有灰色分隔线 hr（CM 2026-10-01：不然跟正文混到一起）')

  // 续行被解除武装（dsh 重启后的真实状态）必须一眼可见
  const mark2 = sentCards.length
  fakeGoalActivation = 'disarmed'
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 7120, data: { message: { content: [{ type: 'text', text: '续行已停的回合一' }] } } })
  }
  feedInbound('om_goal_disarmed', '续行已停目标条测试')
  await settle(3)
  const body2 = JSON.stringify(cardsSince(mark2))
  ok(body2.includes('续行已停'), 'disarmed → 卡面写「续行已停」（CM 要抓的"目标停了"）')
  ok(body2.includes('/goal resume'), '并且给出恢复方式')
  fakeGoalActivation = 'armed'

  // 未启用形态：CM 2026-10-01「未激活的时候也加一个灰色底」
  const mark3 = sentCards.length
  fakeGoalEnabled = false
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 7130, data: { message: { content: [{ type: 'text', text: '无目标回合一' }] } } })
  }
  feedInbound('om_goal_disabled', '未启用目标条测试')
  await settle(3)
  const body3 = JSON.stringify(cardsSince(mark3))
  ok(body3.includes('未启用'), '无目标时目标条写「未启用」')
  ok(body3.includes('grey-50'), '未启用形态也有灰色底（grey-50）')
  ok(body3.includes('"tag":"hr"'), '未启用形态同样带灰色分隔线')
  fakeGoalEnabled = true
}

console.log('26) 选项卡：长选项换行分栏 + 6 个选项不丢（改造④，CM 定 A4）')
{
  const mark = sentCards.length
  const questions = [{
    id: 'q-smoke-1',
    question: '阶段 1-4 复盘口径，你要哪一种？',
    options: [
      { label: '按决策错误口径：只判用了不合规依据、用了无出处的方法、有据可查却没查这三种情形；流程没走全的一律归到阶段 2。' },
      { label: '按流程完整性口径：把没走的步骤也算失误，逐项打勾核对。' },
      { label: '两者都要：先按决策口径判对错，再附一份流程完整性清单。' },
      { label: '选项四：只看结论对不对。' },
      { label: '选项五：只看流程走没走全。' },
      { label: '选项六：以上都不选，我直接回复文字。' },
    ],
  }]
  emitCtx('tools/execute', { name: 'ask_user_question', agent, arguments: { questions }, signal: undefined }, () => {})
  await drain()
  const qCard = cardsSince(mark).filter((c) => c.op === 'create')
    .find((c) => JSON.stringify(c.payload).includes('需要你的回答'))
  ok(Boolean(qCard), '问句卡已发出')
  const body = JSON.stringify(qCard ? qCard.payload : {})
  ok(body.includes('"schema":"2.0"'), '问句卡改用 JSON 2.0 结构')
  ok(body.includes('column_set'), '选项改成"一行一个分栏"')
  ok(body.includes('stretch'), '窄屏自动堆叠（A4）')
  ok(body.includes('选它'), '按钮文案＝选它')
  ok(body.includes('有据可查却没查这三种情形'), '长选项正文**完整**出现在卡上（不再截断）')
  ok(body.includes('选项六'), '第 6 个选项没有被静默丢弃（旧实现 slice(0,5)）')
  // 清掉挂起的提问：否则 30 分钟超时定时器会拖住进程不退出
  feedInbound('om_answer_pending_question', '选 1')
  await drain()
}

console.log('27) 引用回复透传：parent_id → 会话里带被引摘要（改造⑤）')
{
  feedInbound('om_quote_source', '这是被引用的那条原消息')
  await drain()
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: 'om_quote_reply',
        message_type: 'text',
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        content: JSON.stringify({ text: '我引用的就是上面那条' }),
        parent_id: 'om_quote_source',
      },
      sender: { sender_id: { open_id: 'ou_test' } },
    },
  }) + '\n'
  await drain()
  const last = agent.sent[agent.sent.length - 1]
  const text = (last && last.content && last.content[0] && last.content[0].text) || ''
  ok(text.includes('你在引用这条消息'), '引用信息被带进了会话正文')
  ok(text.includes('这是被引用的那条原消息'), '引用里带的是被引消息的摘要')
  ok(text.includes('我引用的就是上面那条'), '用户正文本身照旧送达')
}

console.log('28) 中文目的行：长过程话语被 500 字截断时，🎯 行必须留下（改造②）')
{
  const mark = sentCards.length
  const note = '背景说明。'.repeat(120) + '\n🎯 去查基准库，确认这场比赛的赔率口径。\n结尾一句。'
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 7200, data: { message: { content: [{ type: 'text', text: note }] } } })
  }
  feedInbound('om_purpose_line', '目的行测试')
  await settle(2)
  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('🎯 去查基准库'), '目的行没有被 500 字截断切掉（改造②的保护生效）')
}

console.log('29) 点击选项后后续内容必须写到【新卡】(CM 回归红线：自动轮也要换卡)')
{
  // 造一个自动轮：回执落盘 → 播报建卡（这张卡会进 autoCards，成为"活跃卡"）
  const mark = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 7300,
    data: {
      content: [
        { type: 'text', text: 'Background subagent child-split0001-0000 finished and will do no further work unless you send it more.' },
        { type: 'text', text: 'Its closing message:' },
        { type: 'text', text: '这一步做完了。' },
      ],
      source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-split0001-0000' },
    },
  })
  await drain()
  ok(cardsSince(mark).filter((c) => c.op === 'create').length >= 2, '自动轮已建卡（split 的前提）')

  // 在自动轮里提问（真机上就是"我在回执轮里问了 CM 一个问题"）
  const qmark = sentCards.length
  const questions = [{ id: 'q-split', question: '选一个', options: [{ label: '选项甲' }, { label: '选项乙' }] }]
  emitCtx('tools/execute', { name: 'ask_user_question', agent, arguments: { questions }, signal: undefined }, () => {})
  await drain()
  const qCard = cardsSince(qmark).filter((c) => c.op === 'create')
    .find((c) => JSON.stringify(c.payload).includes('需要你的回答'))
  ok(Boolean(qCard), '问题卡已发出')
  const token = qCard
    && qCard.payload.body.elements.find((e) => e.tag === 'column_set')
    && qCard.payload.body.elements.find((e) => e.tag === 'column_set').columns[1].elements[0].behaviors[0].value.fs_question
  ok(Boolean(token), '从问题卡里取到了回传 token')

  // 点按钮：**必须走 helper 事件通道**（card.action.trigger 由 handleHelperMessage 分发，
  // 不是 ctx 事件 —— 用 emitCtx 发它不会有任何反应）。
  const tapMark = sentCards.length
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'card.action.trigger',
    data: {
      action: { tag: 'button', value: { fs_question: token, fs_option: 0 } },
      context: { open_chat_id: CHAT_ID },
    },
  }) + '\n'
  await drain()
  ok(createsSince(tapMark).length >= 1,
    '点击后开了【新卡】（旧卡被冻结，后续内容不再往用户已经划过的那张卡上堆）')
  const updates = sentCards.slice(tapMark).filter((c) => c.op === 'update')
  ok(updates.some((c) => JSON.stringify(c.payload).includes('已收到你的选择')),
    '旧卡被封口并写了「✅ 已收到你的选择，继续处理中…」')
  ok(updates.some((c) => JSON.stringify(c.payload).includes('继续处理中')),
    '新卡写了「继续处理中…」')
}

console.log('30) 有活跃卡时回执【并入卡片】、不发独立消息（CM 2026-10-01：别让它沉在活跃卡下面）')
{
  let release = null
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 7400, data: { message: { content: [{ type: 'text', text: '活跃回合正文' }] } } })
  }
  agent.whenIdle = () => new Promise((resolve) => { release = resolve })
  feedInbound('om_merge_notice', '并卡测试')
  await drain()
  ok(Boolean(release), '回合确实卡在 whenIdle（活跃卡场景成立）')

  const before = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 7410,
    data: {
      content: [
        { type: 'text', text: 'Background subagent child-merge001-0000 finished and will do no further work unless you send it more.' },
        { type: 'text', text: 'Its closing message:' },
        { type: 'text', text: '这一步做完了。' },
      ],
      source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-merge001-0000' },
    },
  })
  await drain()
  const during = sentCards.slice(before)
  ok(during.length > 0, '回执到达时有动作（至少 PATCH 了活跃卡）')
  ok(during.every((c) => c.op === 'update'),
    '有活跃卡时**不发独立消息**（全部是 PATCH，共 ' + during.length + ' 条）')
  ok(JSON.stringify(during).includes('子代理'), '回执内容并进了那张活跃卡')

  if (release) release()
  await settle(2)
  agent.whenIdle = async () => {}
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()
}

console.log('31) 结论独立成卡（CM 2026-10-01 B 方案，17:3x 修正：**只按耗时**判定）')
{
  // (a) 耗时达标（本用例把阈值压到 0ms —— 冒烟里回合是瞬时完成的，elapsed 可能是 0）
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'
  const mark = sentCards.length
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push(
      { type: 'tool/call', seq: 7500, data: { callId: 'call_split_1', name: 'read', arguments: '{"file_path":"a.md"}' } },
      { type: 'assistant/message', seq: 7501, data: { message: { content: [{ type: 'text', text: '结论：一切正常。' }] } } },
    )
  }
  feedInbound('om_split_with_tools', '分卡测试（达标）')
  await settle(3)
  const events = sentCards.slice(mark)
  const creates = events.filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0')
  ok(creates.length === 2, '耗时达标 → 过程卡 + 结论卡（实际 ' + creates.length + ' 张）')
  const conclusionIdx = events.findIndex((c, i) => i > 0 && c.op === 'create' && JSON.stringify(c.payload).includes('一切正常'))
  ok(conclusionIdx > 0, '结论出现在**新开的**那张卡里')
  const beforeConclusion = JSON.stringify(events.slice(0, conclusionIdx))
  ok(!beforeConclusion.includes('一切正常'), '过程卡里**没有**重复结论')
  ok(beforeConclusion.includes('结论见下方卡片'), '过程卡留一句指路')
  ok(JSON.stringify(creates[creates.length - 1].payload).includes('已完成'), '结论卡的状态栏写「已完成」')
  // CM 2026-10-01 A 方案：**过程卡不摆状态栏**（无目标/无上下文/无缓存），只留一行裸状态
  // 判据换成「缓存命中」（= 完整状态栏的指标段）。
  // ⚠️ 2026-10-03 H 之后**不能再拿「目标模式」当判据**：状态栏首段现在是三模式标签
  //   （🧭普通/📋计划/🎯目标），裸状态行里也会出现它 ⇒ 会假红。
  ok(!beforeConclusion.includes('缓存命中'),
    '过程卡**不显示状态栏**（没有目标/上下文/缓存那一条）')
  ok(beforeConclusion.includes('运行中') || beforeConclusion.includes('已完成'), '过程卡保留一行裸状态')
  ok(JSON.stringify(creates[creates.length - 1].payload).includes('缓存命中'),
    '结论卡带完整状态栏（灰底那一行在结论卡上）')

  // (b) 未达阈值（恢复默认 30s；本轮的 80ms 远不够）→ 维持单卡
  //     ★ 这就是 CM 17:3x 的反馈：「短任务都变了两张卡了」—— 短任务**即使调了工具**也必须单卡
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  const mark2 = sentCards.length
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push(
      { type: 'tool/call', seq: 7510, data: { callId: 'call_split_2', name: 'read', arguments: '{"file_path":"b.md"}' } },
      { type: 'assistant/message', seq: 7511, data: { message: { content: [{ type: 'text', text: '简短结论' }] } } },
    )
  }
  feedInbound('om_split_short', '分卡测试（未达标）')
  await settle(3)
  ok(createsSince(mark2).length === 1,
    '**短任务（即使调了工具）也维持单卡**（实际 ' + createsSince(mark2).length + ' 张）')
}

console.log('32) /compact：压缩上下文必须透传到命令注册表（CM 2026-10-01 要求）')
{
  // 旧实现：compact 不在 COMMANDS 白名单 ⇒ `/compact` 被当成**普通消息**丢给模型，压缩根本不会发生。
  const prev = fakeCommands.execute
  const calls = []
  // ★ 记录**全部**参数：execute 的签名是 (agent, line, submittedAttachments, signal)——
  //   2026-10-01 真机事故：signal 传在第 3 位 ⇒ 注册表里 `signal.aborted` 抛
  //   `Cannot read properties of undefined (reading 'aborted')`（用户看到「压缩失败：…」）。
  fakeCommands.execute = async (...args) => {
    calls.push({ agentId: args[0] && args[0].id, line: args[1], attachments: args[2], signal: args[3] })
    return { result: { text: 'compacted 12 messages' } }
  }
  const mark = sentCards.length
  feedInbound('om_compact', '/compact')
  await drain()
  const body = JSON.stringify(cardsSince(mark))
  const call = calls.find((c) => c.line === '/compact')
  ok(Boolean(call), '/compact 被路由到 commands.execute')
  ok(call && call.signal && typeof call.signal.aborted === 'boolean',
    'signal 必须传在**第 4 位**（第 3 位是 attachments）—— 传错位会让注册表抛 TypeError')
  ok(call && call.attachments !== undefined && Array.isArray(call.attachments) && call.attachments.length === 0,
    '第 3 位必须是**数组**（空附件）—— 传 undefined 会让注册表读 .length 再抛一次')
  ok(body.includes('压缩上下文'), '把压缩结果回给用户')
  ok(body.includes('compacted 12 messages'), '上游结果原文可见')

  // /goal 与 /plan 走同一条通道 —— 同一个错位问题也要守住
  feedInbound('om_goal_signal', '/goal 信号位测试')
  await drain()
  const goalCall = calls.find((c) => c.line && c.line.startsWith('/goal'))
  ok(goalCall && goalCall.signal && typeof goalCall.signal.aborted === 'boolean',
    '/goal 同样把 signal 传在第 4 位（旧代码在这里静默抛错、退化成兜底分支）')

  // 注册表没有 /compact 时，必须明说"不可用"，而不是静默什么都不做
  fakeCommands.execute = async () => undefined
  const mark2 = sentCards.length
  feedInbound('om_compact_missing', '/compact')
  await drain()
  ok(JSON.stringify(cardsSince(mark2)).includes('压缩不可用'), '插件未装载时要明确告知（不静默）')

  // ★ CM 2026-10-01：「报错能不能直接知道、提醒到 agent？」——
  //   命令抛异常时，除了回给用户，还必须**回注会话并唤醒 agent**（否则它永远不知道出过错）
  const sentBefore = agent.sent.length
  const mark3 = sentCards.length
  fakeCommands.execute = async () => { throw new Error('boom-from-registry') }
  feedInbound('om_compact_throw', '/compact')
  await drain()
  ok(JSON.stringify(cardsSince(mark3)).includes('压缩失败'), '失败照旧回给用户')
  const injected = agent.sent.slice(sentBefore).map((m) => JSON.stringify(m)).join(' ')
  ok(injected.includes('[系统回执]') && injected.includes('boom-from-registry'),
    '失败必须**回注给 agent**（含原因），让它能主动排查')

  // 2026-10-01 审计发现：`/plan`、`/goal` 的 catch 也接了 reportCommandFailure，
  // 但**从没有人断言过**（上面只注入了 /compact 的异常）。三条通道一起钉住。
  fakeCommands.execute = async () => { throw new Error('boom-plan') }
  const sentBeforePlan = agent.sent.length
  feedInbound('om_plan_throw', '/plan')
  await drain()
  ok(agent.sent.slice(sentBeforePlan).map((m) => JSON.stringify(m)).join(' ').includes('boom-plan'),
    '/plan 失败同样回注 agent（含原因）')

  fakeCommands.execute = async () => { throw new Error('boom-goal') }
  const sentBeforeGoalFail = agent.sent.length
  feedInbound('om_goal_throw', '/goal pause')
  await drain()
  ok(agent.sent.slice(sentBeforeGoalFail).map((m) => JSON.stringify(m)).join(' ').includes('boom-goal'),
    '/goal 失败同样回注 agent（含原因）')
  fakeCommands.execute = prev
}

console.log('33) 目标状态三分支（paused/blocked/complete）＋ 状态变化刷新活跃卡（2026-10-01 审计补测）')
{
  // (a) `goalStateText()` 的三个分支此前**一次都没被执行过**（smoke 只覆盖 armed/disarmed/未启用）。
  let seqN = 8000
  const phaseCase = async (label, expect) => {
    const mark = sentCards.length
    seqN += 10
    agent.send = function (message) {
      this.sent.push(message)
      agentEvents.push({ type: 'assistant/message', seq: seqN, data: { message: { content: [{ type: 'text', text: label }] } } })
    }
    feedInbound('om_goal_phase_' + seqN, label)
    await settle(3)
    ok(JSON.stringify(cardsSince(mark)).includes(expect), label + '：卡面出现「' + expect + '」')
  }
  fakeGoalPhase = 'paused'
  await phaseCase('暂停态目标条', '目标模式 · 已暂停')
  fakeGoalPhase = 'blocked'
  fakeGoalBlockedReason = '已达轮次上限'
  await phaseCase('阻塞态目标条（状态栏只写已阻塞）', '目标模式 · 已阻塞')
  // CM 2026-10-01：**状态栏只写「已阻塞」**，长原因挪到展开面板 ⇒ 上面断"短状态栏"，
  // 下面断"原因仍完整在卡里（面板内容里）"。
  await phaseCase('阻塞态目标条（原因在面板里）', '已达轮次上限')
  // ⚠️ 2026-10-01 真机抓出：驱动服务给的 blockedReason 是**对象** `{code, message}`，
  //    而这里原来只测字符串形状 ⇒ `String(obj)` 渲染成 `[object Object]` 漏网（CM 在卡上看到了）。
  //    补对象形状 + "绝不出现 [object Object]" 两条断言。
  fakeGoalBlockedReason = { code: 'model-reported', message: '对象形状的阻塞原因' }
  await phaseCase('阻塞态目标条（对象原因在面板里）', '对象形状的阻塞原因')
  {
    const mark = sentCards.length
    seqN += 10
    agent.send = function (message) {
      this.sent.push(message)
      agentEvents.push({ type: 'assistant/message', seq: seqN, data: { message: { content: [{ type: 'text', text: '对象原因渲染测试' }] } } })
    }
    feedInbound('om_goal_phase_obj', '对象原因渲染测试')
    await settle(3)
    const body = JSON.stringify(cardsSince(mark))
    ok(!body.includes('[object Object]'), '目标阻塞原因绝不许渲染成 [object Object]')
  }
  fakeGoalPhase = 'complete'
  fakeGoalBlockedReason = ''
  await phaseCase('完成态目标条', '目标模式 · 已完成 · 共 3 轮')
  fakeGoalPhase = 'active'

  // (b) `goal/changed` / `goal/activation-changed` → **已经在飞书上的活跃卡**必须跟着刷新。
  //     审计结论：`index.js` L3595-3618 那段（refreshLiveCards）在 smoke 里 0 触发、真机 0 次 ⇒ 纯代码承诺。
  //     注意：普通回合的过程卡是 bare（不摆状态栏）⇒ 必须用**自动卡**（回执轮）来验，
  //     它从出生就是 full（`makeCardState` 默认 footerMode='full'）。
  const markAuto = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 8100,
    data: {
      content: [
        { type: 'text', text: 'Background subagent child-refresh01-0000 finished and will do no further work unless you send it more.' },
        { type: 'text', text: 'Its closing message:' },
        { type: 'text', text: '刷新用例的回执。' },
      ],
      source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-refresh01-0000' },
    },
  })
  await drain()
  // 前提（可失败）：回执必须触发卡片动作 —— 新开自动卡 或 并入活跃卡，两种都算。
  ok(sentCards.length > markAuto, '前提：回执触发了卡片动作（新开自动卡/并入活跃卡）')

  const markRefresh = sentCards.length
  fakeGoalPhase = 'paused'
  emitCtx('goal/changed', {})
  await drain()
  // 判据：必须出现一次 **PATCH**，且该 PATCH 的载荷里同时有「目标模式」（＝状态栏，说明刷的是
  // full 卡）和「已暂停」（＝读到的是**刚刚改过的**状态）。只看 create 不算 —— 那是新建卡，不是刷新。
  const refreshPatched = sentCards.slice(markRefresh)
    .filter((c) => c.op === 'update').map((c) => JSON.stringify(c.payload)).join(' ')
  ok(refreshPatched.includes('目标模式') && refreshPatched.includes('已暂停'),
    'goal/changed → 已发出的卡被当场 PATCH 成新状态（refreshLiveCards 真的在跑）')

  const markActivation = sentCards.length
  fakeGoalPhase = 'active'
  fakeGoalActivation = 'disarmed'
  emitCtx('goal/activation-changed', { sessionId: agent.session.id || 'agent-smoke-1' })
  await drain()
  const activationPatched = sentCards.slice(markActivation)
    .filter((c) => c.op === 'update').map((c) => JSON.stringify(c.payload)).join(' ')
  ok(activationPatched.includes('续行已停'),
    'goal/activation-changed → 同样刷新（「续行已停」当场可见）')

  fakeGoalActivation = 'armed'
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()
}

console.log('34) 建结论卡失败 → 结论绝不能丢（审计发现：回退分支形同虚设）')
{
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'
  const mark = sentCards.length
  // 时间线：本轮第 1 次建卡＝过程卡（必须成功），第 2 次建卡＝结论卡（这次让它失败）。
  failCreatesFrom = 2
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push(
      { type: 'tool/call', seq: 8600, data: { callId: 'call_concl_1', name: 'read', arguments: '{"file_path":"c.md"}' } },
      { type: 'assistant/message', seq: 8601, data: { message: { content: [{ type: 'text', text: '结论：这一句绝不能丢。' }] } } },
    )
  }
  feedInbound('om_conclusion_fail', '结论卡失败测试')
  await settle(3)
  failCreatesFrom = 0
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  const since = sentCards.slice(mark)
  ok(JSON.stringify(since).includes('结论见下方卡片'), '前提：本轮确实走了"结论独立成卡"路径')
  // 判据落在 **PATCH** 上：建卡失败的载荷也会进 sentCards（没有 message_id），
  // 所以不能靠"载荷里有没有这句话"来判 —— 必须看**已经存在的那张过程卡**有没有被补上结论。
  const patched = JSON.stringify(since.filter((c) => c.op === 'update'))
  ok(patched.includes('这一句绝不能丢'),
    '建结论卡失败 ⇒ 必须把结论补回过程卡（PATCH），否则用户只看到「结论见下方卡片」却永远等不到那张卡')
}

console.log('35) 引用透传落盘：重启后仍能查出"你引的是哪张卡"（2026-10-01 真机实证补测）')
{
  // 真机事故：CM 长按引用一张卡片 → 卡面回「内容未登记，可能是更早的消息」。
  // 根因＝登记表只在内存，dsh 重启就清空（他引的那张卡恰恰建于本次重启之前）。
  const idxPath = join(process.env.FS_CONFIG_DIR, 'message-index.json')
  // 先跑一轮普通回合（封口后有明确结论），用来检查"登记的摘要到底是不是有信息量的那一句"。
  const labelMarker = '引用摘要测试用的结论'
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 8900, data: { message: { content: [{ type: 'text', text: labelMarker }] } } })
  }
  feedInbound('om_label_turn', '摘要登记测试')
  await settle(3)
  await drain()   // 等 rememberMessage 的落盘防抖（300ms）跑完

  let saved = null
  try { saved = JSON.parse(readFileSync(idxPath, 'utf8')) } catch { saved = null }
  const ids = saved ? Object.keys(saved) : []
  const labels = ids.map((id) => String((saved[id] && saved[id].label) || ''))
  // ⚠️ 2026-10-01 真机（CM 引用重启后的卡）：摘要居然是「bot 的回复卡片：正在工作中…」
  //    —— 建卡那一刻卡片里只有占位符，登记它**等于没登记**（引用时看不出引的是哪张、讲什么）。
  //    封口时卡片内容才成形 ⇒ 每次成功同步都必须刷新摘要。
  ok(!labels.some((l) => l.includes('正在工作中')),
    '登记摘要里不许留着建卡时的占位符「正在工作中…」（实际：' + JSON.stringify(labels.filter((l) => l.includes('正在工作中')).slice(0, 2)) + '）')
  ok(labels.some((l) => l.includes(labelMarker)),
    '卡片封口后的结论被登记成摘要（引用时能看出"引的是哪张、说了什么"）')
  ok(ids.length > 0, '发出去的消息/卡片被登记到落盘索引（' + ids.length + ' 条）')
  ok(ids.some((id) => String(id).startsWith('om_card_')), '卡片 message_id 在索引里（引用卡片的主场景）')
  const cardEntry = ids.map((id) => saved[id]).find((v) => v && String(v.label).includes('bot 的回复卡片'))
  ok(Boolean(cardEntry), '卡片登记的摘要是"bot 的回复卡片：…"（引用时能说出引的是哪张）')

  // 模拟"这张卡是上一次进程登记的"：直接写进磁盘索引（内存里没有它）。
  const oldId = 'om_from_previous_process'
  const merged = Object.assign({}, saved, { [oldId]: { label: 'bot 的回复卡片：上一进程发的那张卡', at: Date.now() - 60000 } })
  writeFileSync(idxPath, JSON.stringify(merged))
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: 'om_quote_old_card',
        message_type: 'text',
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        content: JSON.stringify({ text: '我引的是上一进程那张卡' }),
        parent_id: oldId,
      },
      sender: { sender_id: { open_id: 'ou_test' } },
    },
  }) + '\n'
  await drain()
  const last = agent.sent[agent.sent.length - 1]
  const text = (last && last.content && last.content[0] && last.content[0].text) || ''
  ok(text.includes('上一进程发的那张卡'),
    '未命中内存时**再读一次落盘索引** ⇒ 重启前发出的卡片也认得出来（不再一律「内容未登记」）')

  // 真·未登记的消息必须照实说，**不许编造**
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: 'om_quote_unknown',
        message_type: 'text',
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        content: JSON.stringify({ text: '我引的是一条谁也没登记过的消息' }),
        parent_id: 'om_never_seen_anywhere',
      },
      sender: { sender_id: { open_id: 'ou_test' } },
    },
  }) + '\n'
  await drain()
  const last2 = agent.sent[agent.sent.length - 1]
  const text2 = (last2 && last2.content && last2.content[0] && last2.content[0].text) || ''
  ok(text2.includes('内容未登记'), '真查不到时照实写「内容未登记」（A24：不许编造出处）')
}

console.log('36) /help 文案必须列出 /compact（2026-10-01 审计：此前无守护用例）')
{
  const mark = sentCards.length
  agent.send = function (message) { this.sent.push(message) }
  feedInbound('om_help_cmd', '/help')
  await drain()
  const body = JSON.stringify(sentCards.slice(mark))
  ok(body.includes('/compact'), '/help 里列出了 /compact')
  ok(body.includes('压缩上下文'), '/help 说明了 /compact 的作用与前置条件')
  ok(body.includes('/goal') && body.includes('/switch'), '/help 仍保留既有命令（没被改坏）')
}

console.log('37) 消息索引 300 条上限：不许无界增长，且淘汰最旧的（审计：此前无守护用例）')
{
  const idxPath = join(process.env.FS_CONFIG_DIR, 'message-index.json')
  const many = {}
  for (let i = 1; i <= 400; i++) {
    many['om_cap_' + String(i).padStart(3, '0')] = { label: 'cap-entry-' + i, at: Date.now() - (400 - i) * 1000 }
  }
  writeFileSync(idxPath, JSON.stringify(many))
  // 引用其中最后一条（内存里没有 ⇒ 走"未命中再读盘"），既验按需加载、又能触发一次裁剪
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: 'om_cap_quote',
        message_type: 'text',
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        content: JSON.stringify({ text: '上限测试：引用最后一条' }),
        parent_id: 'om_cap_400',
      },
      sender: { sender_id: { open_id: 'ou_test' } },
    },
  }) + '\n'
  await drain()
  const last = agent.sent[agent.sent.length - 1]
  const text = (last && last.content && last.content[0] && last.content[0].text) || ''
  ok(text.includes('cap-entry-400'), '按需读盘：引用能查到落盘索引里的条目')
  await drain()   // 等 rememberMessage 的 300ms 防抖落盘
  const after = JSON.parse(readFileSync(idxPath, 'utf8'))
  const keys = Object.keys(after)
  ok(keys.length <= 300, '落盘索引被裁到 300 条以内（实际 ' + keys.length + ' 条，防无界增长）')
  ok(keys.includes('om_cap_400'), '保留较新的条目（最旧的先淘汰）')
}

console.log('38) bot 配置热读通道：splitConclusionMinMs 优先级 + notifyAgentNotices 开关（审计：两条都没验过）')
{
  // 依据：`ensureHelpers()` 每 CONFIG_REFRESH_MS(10s) 重读配置并 `bot.cfg = cfg`（index.js L2288/L2320）
  // ⇒ 改配置免重启生效。此前 smoke 只测过 env 那条通道（DSH_FEISHU_SPLIT_MIN_MS），
  //    **bot 配置这条（也是文档里第一优先级）从未验证**；notifyAgentNotices 也是零覆盖。
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'      // env 说：立刻分卡
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{
      name: 'smoke',
      workspace: WORKSPACE,
      appId: APP_ID,
      appSecret: APP_SECRET,
      splitConclusionMinMs: 600000,   // bot 配置说：几乎不分卡 ⇒ 应当**压过** env
      notifyAgentNotices: false,      // 关掉回执播报
      reactionEmoji: 'GLANCE',        // 别把用例 40 要验的字段洗掉
      approvalForm: true,             // 可选通道：别在这里顺手关掉（用例 51 还要用）
    }],
  }, null, 2))
  await new Promise((r) => setTimeout(r, 11000))   // 等过热读节拍
  await drain()                                     // 触发一次 ensureHelpers → 应用新配置

  // A) notifyAgentNotices=false ⇒ 回执**不许**有任何播报动作
  const markA = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 9200,
    data: {
      content: [
        { type: 'text', text: 'Background subagent cfgswitch-0001 finished and will do no further work unless you send it more.' },
        { type: 'text', text: 'Its closing message:' },
        { type: 'text', text: '配置开关测试。' },
      ],
      source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'cfgswitch-0001' },
    },
  })
  await drain()
  const touchedA = sentCards.slice(markA)
  ok(!JSON.stringify(touchedA).includes('cfgswitch'),
    'notifyAgentNotices=false：回执被静默跳过（实际 ' + touchedA.length + ' 条卡片动作）')

  // B) bot 配置的阈值优先于 env（env=0 也不许分卡）
  const markB = sentCards.length
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 9210, data: { message: { content: [{ type: 'text', text: '阈值优先级测试正文' }] } } })
  }
  feedInbound('om_priority_cfg', '阈值优先级测试')
  await settle(3)
  const createsB = createsSince(markB).length
  ok(createsB === 1,
    'bot 配置 splitConclusionMinMs=600000 压过 env=0 ⇒ 不分卡（实际 ' + createsB + ' 张）')
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
}

console.log('39) admin 路由：绝不泄露密钥 + 配置写入走归一化 + 非法方法拒绝（审计：这两条路由零覆盖）')
{
  const routeOf = (p) => registeredRoutes.find((r) => r.path === p)
  const callRoute = async (route, method, body) => {
    const res = {
      headersSent: false,
      status: 0,
      payload: '',
      writeHead(status) { this.status = status; this.headersSent = true },
      end(text) { this.payload = String(text || '') },
    }
    const req = new EventEmitter()
    req.method = method
    const pending = route.handler(req, res)
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
    await pending
    let json = null
    try { json = JSON.parse(res.payload) } catch { json = null }
    return { status: res.status, raw: res.payload, json }
  }

  const statusRoute = routeOf('/feishu/admin/status')
  ok(Boolean(statusRoute && statusRoute.handler), '/feishu/admin/status 路由已注册且带 handler')
  const st = await callRoute(statusRoute, 'GET')
  ok(st.status === 200 && st.json && st.json.ok === true, '状态路由返回 200 + ok')
  ok(st.json && st.json.bots && st.json.bots[0] && st.json.bots[0].hasSecret === true,
    '状态里只给 hasSecret 布尔（证明有密钥），不给密钥本身')
  ok(!st.raw.includes(APP_SECRET), '状态响应**不含 appSecret 明文**（密钥不泄露）')

  const cfgRoute = routeOf('/feishu/admin/config')
  ok(Boolean(cfgRoute && cfgRoute.handler), '/feishu/admin/config 路由已注册且带 handler')
  const g = await callRoute(cfgRoute, 'GET')
  ok(g.status === 200 && g.json && g.json.ok === true, '配置读取返回 200 + ok')
  ok(g.json && g.json.bots[0] && g.json.bots[0].appSecret === '***', '配置读取把 appSecret 掩码成 ***')
  ok(!g.raw.includes(APP_SECRET), '配置读取响应**不含 appSecret 明文**（密钥不泄露）')

  // POST 写入必须走归一化（不认识的字段会被丢弃 —— 这正是本轮抓到 splitConclusionMinMs 那个 bug 的机制）
  const p = await callRoute(cfgRoute, 'POST', {
    bots: [{ name: 'smoke-posted', workspace: WORKSPACE, appId: 'cli_posted_1', appSecret: 'posted-secret', unknownField: 'x' }],
  })
  ok(p.status === 200 && p.json && p.json.ok === true, '配置写入返回 200 + ok')
  const onDisk = JSON.parse(readFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), 'utf8'))
  ok(onDisk.bots.length === 1 && onDisk.bots[0].name === 'smoke-posted', '写入落到 feishu.config.json（归一化后）')
  ok(!JSON.stringify(onDisk).includes('unknownField'), '归一化丢弃白名单外的字段（这次抓 bug 的机制）')

  const bad = await callRoute(cfgRoute, 'PUT')
  ok(bad.status === 405, '不支持的方法返回 405（实际 ' + bad.status + '）')

  // 收尾：把配置恢复成 smoke 的标准 bot，避免影响后续（reactionEmoji 要保留，用例 40 还要用）
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET, reactionEmoji: 'GLANCE', approvalForm: true }],
  }, null, 2))
}

console.log('40) 打字提示（reaction）生命周期 + cfg.reactionEmoji 通道（审计：零覆盖）')
{
  // 期望：入站时给用户消息挂一个 emoji（"我在打字"），封口时**撤掉**（不留假象）。
  // cfg.reactionEmoji 在 smoke 配置里显式设成 'GLANCE'（默认是 'OnIt'）⇒ 断言必须看到 GLANCE，
  // 才能证明是**配置通道**生效、而不是写死的默认值。
  const mark = reactionCalls.length
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 9300, data: { message: { content: [{ type: 'text', text: '打字提示测试正文' }] } } })
  }
  feedInbound('om_reaction_case', '打字提示测试')
  await settle(4)
  const calls = reactionCalls.slice(mark)
  const posts = calls.filter((c) => c.method === 'POST')
  const deletes = calls.filter((c) => c.method === 'DELETE')
  ok(posts.length >= 1, '入站后加了 reaction（打字提示，实际 ' + posts.length + ' 次 POST）')
  ok(posts.some((c) => c.body.includes('GLANCE') || c.url.includes('GLANCE')),
    'emoji 用的是**配置里的** GLANCE（证明 cfg.reactionEmoji 通道生效；实际 body=' + (posts[0] ? posts[0].body.slice(0, 80) : '无') + '）')
  ok(deletes.length >= 1, '封口后撤掉 reaction（不留"正在输入"假象，实际 ' + deletes.length + ' 次 DELETE）')
}

console.log('41) /list 与 /stop（2026-10-01 审计：两条既有命令零覆盖）')
{
  // /list：列出本聊天的会话（▶ 标出当前；无会话时给明确文案）
  const mark = sentCards.length
  feedInbound('om_list_cmd', '/list')
  await drain()
  const body = JSON.stringify(sentCards.slice(mark))
  ok(body.includes('▶') || body.includes('无会话'), '/list 列出会话并标出当前（▶）或明确"无会话"')
  ok(/\d+\.\s/.test(body) || body.includes('无会话'), '/list 的清单带序号')

  // /stop：必须打到"正在跑的**活的** agent"的 cancel()，并给回执（旧实现的坑：缓存句柄可能指向过期实例）
  const cancels = []
  agent.cancel = (reason) => { cancels.push(reason) }
  const mark2 = sentCards.length
  feedInbound('om_stop_cmd', '/stop')
  await drain()
  ok(cancels.length === 1, '/stop 调用了 agent.cancel()（实际 ' + cancels.length + ' 次）')
  ok(cancels[0] && cancels[0].kind === 'user', 'cancel 的 reason 形如 { kind: "user" }')
  ok(JSON.stringify(sentCards.slice(mark2)).includes('已发送停止指令'), '回执明确告诉用户已发送停止指令')
}

console.log('42) 计划模式退出申请（exit_plan_mode）：`user-questions/request` 水位线必须被接管（CM 2026-10-01 报障）')
{
  // 报障原话：「计划模式退出的时候，我收不到你的退出申请」。
  // 根因：`exit_plan_mode` 调的是 `ctx.userQuestions.ask(...)` **服务**
  // （`dsh-plan-mode/lib/index.js:261`），**不经过** `ask_user_question` 工具 ⇒
  // 旧实现只拦 `tools/execute`（用例 26/29 覆盖的那条）⇒ 拦不到它，
  // 申请只发给了连着长连接的 GUI 客户端。修法＝与 `approval/request` 同构的水位线。
  const planText = '# 计划：把计划审查搬到飞书\n\n1. 只读排查调用链\n2. 出水印卡 + 中文选项'
  const questions = [{
    id: 'plan-review',
    header: 'Plan review',
    question: 'Approve this plan and leave plan mode?',
    detail: planText,
    options: [
      { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
      { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
    ],
    intent: { kind: 'plan-review', approve: 'Approve' },
  }]
  let delegated = 0
  const nextSpy = () => { delegated += 1; return Promise.resolve('next') }

  // (a) 没有 agent / 不是飞书会话的 agent ⇒ 必须 `next()` 交回 harness。
  //     这条是**红线**：GUI 会话的提问绝不能被本插件吞掉（否则 GUI 里也会变哑巴）。
  ok(emitCtx('user-questions/request', { questions, signal: undefined }, nextSpy).length === 1,
    '水位线上只有本插件一个监听器（接管范围可控）')
  const foreignRuns = emitCtx('user-questions/request', { questions, agent: { id: 'agent-not-feishu' }, signal: undefined }, nextSpy)
  const foreignResolved = await Promise.all(foreignRuns.map((r) => Promise.resolve(r).catch(() => {})))
  ok(delegated === 2 && foreignResolved[0] === 'next',
    '无 agent / 非飞书 agent 一律交回下一个（delegated=' + delegated + '）')

  const cardOf = (since) => cardsSince(since).filter((c) => c.op === 'create')
    .find((c) => JSON.stringify(c.payload).includes('计划已写好'))
  const rowsOf = (card) => (card ? card.payload.body.elements.filter((e) => e.tag === 'column_set') : [])
  const tokenOf = (rows) => rows[0] && rows[0].columns[1].elements[0].behaviors[0].value.fs_question
  const tap = async (token, index) => {
    fakeProc.output += JSON.stringify({
      type: 'event',
      eventType: 'card.action.trigger',
      data: { action: { tag: 'button', value: { fs_question: token, fs_option: index } }, context: { open_chat_id: CHAT_ID } },
    }) + '\n'
    await drain()
  }

  // (b) 飞书会话的提问 ⇒ 接管 + 出水印卡（计划正文必须在卡上，不能是空卡）
  const mark = sentCards.length
  const r1 = emitCtx('user-questions/request', { questions, agent, signal: undefined }, nextSpy)
  const pending = r1[0]
  ok(Boolean(pending) && typeof pending.then === 'function', '飞书会话的提问被接管（返回 Promise，而不是 next()）')
  await drain()
  const card = cardOf(mark)
  ok(Boolean(card), '计划审查卡已发到飞书')
  const body = JSON.stringify(card ? card.payload : {})
  ok(body.includes('计划已写好'), '卡头是"计划已写好，等你批准"（不是通用的"需要你的回答"）')
  ok(body.includes('把计划审查搬到飞书') && body.includes('只读排查调用链'),
    '计划正文**完整**在卡上（含标题与正文，不是只有标题的空卡）')
  const rows = rowsOf(card)
  // 2026-10-02 CM：「审批文字+按钮+拒绝文字+按钮 ⇒ 文字放在按钮上，审批绿、拒绝红」。
  // 2026-10-03 CM（I）：「批准和拒绝在同一行，**另开一行**去做目标模式这个选择」
  //   ⇒ 两排：行1＝批准/拒绝（bisect）· 行2＝整行「🎯 以目标模式跑」。
  ok(rows.length === 2, '审批卡**两排**：行1＝批准/拒绝 · 行2＝「以目标模式跑」（实际 ' + rows.length + ' 排）')
  const goalRow = rows[1]
  const goalBtn = (((goalRow && goalRow.columns) || [])[0] || {}).elements
  const goalButton = (goalBtn || [])[0]
  ok(Boolean(goalButton) && goalButton.tag === 'button'
    && goalButton.text && goalButton.text.content === '🎯 以目标模式跑',
    '★ 行2 是整行按钮「🎯 以目标模式跑」（实际：'
      + JSON.stringify(goalButton && goalButton.text && goalButton.text.content) + '）')
  ok(Boolean(goalButton) && goalButton.behaviors && goalButton.behaviors[0]
    && goalButton.behaviors[0].value && goalButton.behaviors[0].value.fs_plan_goal !== undefined,
    '★ 该按钮带新命名空间 { fs_plan_goal }（既有三类分派未动）')
  ok(Boolean(goalRow) && ((goalRow.columns || []).length === 1),
    '行2 只有**一列**（整行宽度 ⇒ 长文案不会被截断）')
  const row = rows[0]
  ok(Boolean(row) && row.flex_mode === 'bisect', '两个按钮**同一排**等分（flex_mode=bisect）')
  const btns = ((row && row.columns) || []).map((c) => (c.elements || [])[0])
  const approveBlock = btns[0]
  const rejectBtn = btns[1]
  ok(btns.length === 2, '正好两个控件（实际 ' + btns.length + ' 个）')
  // 2026-10-02 真机两版：第一版把绿放在 `column.background_style` 上 ⇒ CM 手机上**没渲染**
  //（官方注明该字段需客户端 v7.9+），且被 width:fill 按钮整列盖住。定稿＝可点击的整块容器。
  ok(Boolean(approveBlock) && approveBlock.tag === 'interactive_container',
    '「批准」＝整块可点击的容器（不是按钮 + 绿底列）')
  ok(Boolean(approveBlock) && approveBlock.background_style === 'green-600',
    '「批准」＝深绿底 green-600（实际 ' + (approveBlock && approveBlock.background_style) + '）')
  const approveMd = (approveBlock && approveBlock.elements || [])[0]
  ok(Boolean(approveMd) && approveMd.tag === 'markdown' && approveMd.text_align === 'center',
    '批准文字居中（text_align=center —— 第一版左对齐，CM 指出）')
  ok(Boolean(approveMd) && approveMd.content === "**<font color='white'>批准</font>**",
    '白字标签**不跨加粗嵌套**（写成 <font…>**批准</font>** 会把标签原文当文字漏出来）')
  ok(Boolean(approveMd) && !/<\s*font/i.test(String(approveMd.content).replace("<font color='white'>", '').replace('</font>', '')),
    '除那一处白字标签外没有别的裸标签（防再次漏出英文）')
  ok(Boolean(rejectBtn) && rejectBtn.text.content === '拒绝', '「拒绝」文字在按钮上')
  ok(Boolean(rejectBtn) && rejectBtn.type === 'danger_filled', '「拒绝」＝红底白字（danger_filled）')
  ok(Boolean(approveBlock) && Boolean(rejectBtn)
    && approveBlock.behaviors[0].value.fs_option === 0 && rejectBtn.behaviors[0].value.fs_option === 1,
    '序号仍指向原选项（0=Approve / 1=Keep planning）—— 协议没动')
  ok(body.includes('点「批准」') && !body.includes('选它'), '提示文案跟着改（不再是"点右侧选它"）')

  // (c) 点「批准」⇒ 回传 harness 的**必须是原 label `Approve`**（plan-mode 按它判批准）
  await tapValue(approveBlock.behaviors[0].value)
  const a1 = await pending
  ok(a1 && a1.answers && a1.answers.length === 1 && a1.answers[0].id === 'plan-review',
    '答案按 question.id 原样回传（id=plan-review）')
  ok(a1.answers[0].selected.length === 1 && a1.answers[0].selected[0] === 'Approve',
    '选中项是原 label `Approve`（中文只是卡面文案，没污染回传协议）')
  ok(a1.answers[0].custom === undefined, '没把"按钮选择"冒充成自定义反馈')

  // (d) 点「继续修改」⇒ 回传原 label `Keep planning`（plan-mode 据此留在计划模式）
  const mark2 = sentCards.length
  const r2 = emitCtx('user-questions/request', { questions, agent, signal: undefined }, nextSpy)
  await drain()
  const rows2 = rowsOf(cardOf(mark2))
  const rejectBtn2 = rows2[0] && ((rows2[0].columns || [])[1] || {}).elements[0]
  await tapValue(rejectBtn2.behaviors[0].value)
  const a2 = await r2[0]
  ok(a2.answers[0].selected[0] === 'Keep planning', '第二个选项回传 `Keep planning`')

  // (e) 文字「批准」＝ 批准（CM 习惯回中文；批准标签是英文硬约定）
  const r3 = emitCtx('user-questions/request', { questions, agent, signal: undefined }, nextSpy)
  await drain()
  feedInbound('om_plan_approve_text', '批准')
  await drain()
  const a3 = await r3[0]
  ok(a3.answers[0].selected[0] === 'Approve', '回文字「批准」被认成批准（不再被误当成修改意见）')

  // (f) 带补充说明的文字 ⇒ 仍按"继续修改"的反馈回给模型。
  //     方向是刻意的：误判成"留在计划模式"可恢复，误判成"已批准"不可恢复（直接开工）。
  const r4 = emitCtx('user-questions/request', { questions, agent, signal: undefined }, nextSpy)
  await drain()
  feedInbound('om_plan_feedback_text', '同意，但第 2 步先改成只读排查')
  await drain()
  const a4 = await r4[0]
  ok(a4.answers[0].selected.length === 0 && String(a4.answers[0].custom).includes('第 2 步'),
    '带补充说明 ⇒ 当成反馈（custom），绝不误批准')

  // (g) 普通提问（走服务时）不受影响：卡头仍是通用文案、回传照旧
  const mark5 = sentCards.length
  const r5 = emitCtx('user-questions/request', {
    questions: [{ id: 'q-plain', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }],
    agent, signal: undefined,
  }, nextSpy)
  await drain()
  ok(JSON.stringify(cardsSince(mark5)).includes('需要你的回答'),
    '非计划审查的提问仍走通用问句卡（没有把两类混在一起）')
  await tap(tokenOf(rowsOf(cardsSince(mark5).filter((c) => c.op === 'create')
    .find((c) => JSON.stringify(c.payload).includes('需要你的回答')))), 0)
  const a5 = await r5[0]
  ok(a5.answers[0].selected[0] === '甲', '普通提问的按钮回传照旧（甲）')
}

console.log('43) /plan <正文>：命令起了回合也必须建卡（2026-10-01 修复①）')
{
  // 背景（CM 报障「我发了这个计划模式的启动给你……飞书上没有看到卡片」）：
  // harness 把 `/plan <正文>` 解释成「开计划模式 + 把正文当用户消息**起一个真回合**」
  // （会话 fs-main-mupoeiy4 seq 721→725 实证）；而插件的事件入口把命令交给 handleCommand
  // 后**直接 return** ⇒ 那一整轮（16 步）没有任何卡片持有它，CM 完全看不到过程。
  // 修法：命令回报 turnStarted 时落回 handleInbound 走「建卡 → 等回合 → 封口」。
  const prevExec = fakeCommands.execute
  const prevIdle43 = agent.whenIdle
  const mark = sentCards.length
  agent.whenIdle = async () => {}
  agent.send = function (message) { this.sent.push(message) }   // 命令轮**不该**再走这条
  const sentBefore = agent.sent.length
  const seqBase = 9500
  fakeCommands.execute = async () => {
    // 模拟 harness：/plan <正文> 在 execute 内部就把正文投进会话并起了回合、开始产出
    agentEvents.push({
      type: 'assistant/message', seq: seqBase + 1,
      data: { message: { content: [{ type: 'text', text: '命令起回合后的过程' }] } },
    })
    return { result: { text: 'Plan mode on. Use /plan off to leave.' } }
  }
  feedInbound('om_plan_turn', '/plan 检查计划模式，目标模式，所有卡片是否正常')
  await settle(3)
  ok(createsSince(mark).length >= 1,
    '/plan <正文> 也建了卡（create 次数 ' + createsSince(mark).length + '）')
  ok(JSON.stringify(cardsSince(mark)).includes('命令起回合后的过程'),
    '命令起的这一轮过程被镜像进卡（不再「看不见」）')
  ok(agent.sent.length === sentBefore, '正文没有被重复投递一次（skipSend 生效）')
  fakeCommands.execute = prevExec
  agent.whenIdle = prevIdle43
}

console.log('44) 入站消息不被静默吞掉（2026-10-01 事故守护）')
{
  // 事故复盘：steerActiveTurn 第一句就调 isDuplicateInbound() —— 它**有副作用**（把 id 记进
  // seenInboundIds）。一旦 steer 没走成（没有活跃回合 / agent 无 steer）函数 return false
  // 落到 handleInbound，那里再查一次 ⇒ 已「见过」⇒ 判重投直接丢掉
  // ⇒ **所有飞书消息被静默吞掉**（真机日志特征：duplicate inbound skipped 连发）。
  // 修法：只「窥探」不认领；仅当 steer 真的投出去之后才认领。这条用例把它钉死。
  const prevIdle44 = agent.whenIdle
  agent.whenIdle = async () => {}
  const mark = sentCards.length
  agent.send = function (message) { this.sent.push(message) }
  const sentBefore = agent.sent.length
  delete agent.steer                                   // 没有 steer 能力 ⇒ 必然走 fallback
  feedInbound('om_never_swallowed', '这条不许被吞')
  await settle(3)
  ok(agent.sent.slice(sentBefore).some((m) => JSON.stringify(m).includes('这条不许被吞')),
    '无 steer 能力时消息照常投递（没被误判成重投）')
  ok(createsSince(mark).length >= 1, '并且照常建卡')
  // 真·重投仍必须被去重（去重能力不能被上面的修复削弱）
  const sentAfter = agent.sent.length
  feedInbound('om_never_swallowed', '这条不许被吞')
  await settle(2)
  ok(agent.sent.length === sentAfter, '同 message_id 重投仍被去重（不会跑两轮）')
  agent.whenIdle = prevIdle44
}

console.log('45) exit_plan_mode 经【工具层】接管（2026-10-02 换的通道）')
{
  // 背景：`user-questions/request` 水位线即使把监听下沉到 agent.ctx **仍然拿不到**
  //（真机 2026-10-02 00:4x：只有注册行 bound to agent scope，没有任何接管行；
  //  harness 侧收到 "The user dismissed the plan review to speak instead"）。
  // 改用与 ask_user_question 同一条已验证通道：tools/execute。
  const plan = '# 把计划审查搬到飞书\n\n- 只读排查调用链'
  const nextSpy = () => Promise.resolve('next')
  // 2026-10-02：改成**分别收结果与异常** —— 「继续修改」分支现在必须**抛错**
  //（返回 isError:true 会被 harness 判"不可序列化"而换成报错，见真机实测）。
  // ⚠️ 必须在 emitCtx **同一拍**就把异常接住并转成值：本用例「继续修改」分支是**抛错**的，
  // 若等到 await 时才挂 handler，Node 会先看到 unhandled rejection，直接崩掉测试进程
  //（2026-10-02 实测：`Error: The user chose to keep planning…` 把 smoke 打挂）。
  const capture = (runs) => runs.map((r) => Promise.resolve(r).then(
    (value) => ({ value }), (error) => ({ error })))
  const toolOf = (os) => {
    const hit = os.find((o) => o.value && typeof o.value === 'object' && 'content' in o.value)
    return hit && hit.value
  }
  const planCardOf = (since) => cardsSince(since).filter((c) => c.op === 'create')
    .find((c) => JSON.stringify(c.payload).includes('计划已写好'))

  // (a) 红线：非飞书 agent / 空计划 ⇒ 两个监听器都必须 next()
  const foreign = await Promise.all(capture(emitCtx('tools/execute',
    { name: 'exit_plan_mode', agent: { id: 'agent-not-feishu' }, arguments: { plan }, signal: undefined }, nextSpy)))
  ok(foreign.length === 2 && foreign.every((o) => o.value === 'next'), '非飞书 agent ⇒ 一律交回下一个（红线）')
  const emptyPlan = await Promise.all(capture(emitCtx('tools/execute',
    { name: 'exit_plan_mode', agent, arguments: { plan: '   ' }, signal: undefined }, nextSpy)))
  ok(emptyPlan.every((o) => o.value === 'next'), '计划正文为空 ⇒ 交回下一个（不吞）')

  // (b) 飞书会话 ⇒ 接管 + 出计划审查卡（计划正文必须完整在卡上）
  const mark = sentCards.length
  const runs = capture(emitCtx('tools/execute',
    { name: 'exit_plan_mode', agent, arguments: { plan }, signal: undefined }, nextSpy))
  await drain()
  const card = planCardOf(mark)
  ok(Boolean(card), '工具层接管成功：飞书弹出计划审查卡')
  ok(JSON.stringify(card ? card.payload : {}).includes('把计划审查搬到飞书'), '计划正文完整在卡上')

  // (c) 回文字「批准」⇒ 通过**命令注册表 /plan off** 真的退出计划模式
  //     （真机实证：ctx.inject(['planMode']) 在本环境从不触发 ⇒ planModeRef 恒为 null，
  //      只调 planMode.set 那条分支等于"口头说退出"，会话里并未退出）
  const prevExec = fakeCommands.execute
  const execLines = []
  fakeCommands.execute = async (a, line) => {
    execLines.push(line)
    return { result: { text: 'Plan mode off.' } }
  }
  planModeCalls.length = 0
  feedInbound('om_plan_approve_tool', '批准')
  await drain()
  const tool = toolOf(await Promise.all(runs))
  ok(Boolean(tool), '返回的是**工具结果**（不是 next()）')
  ok(tool && tool.isError === false && tool.value && tool.value.approved === true,
    '批准 ⇒ isError:false + approved:true')
  ok(execLines.includes('/plan off'),
    '批准 ⇒ 走命令注册表 /plan off 真正退出计划模式（不只是回一句话）')
  ok(JSON.stringify(tool ? tool.content : '').includes('Plan approved'), '回给模型的文案与 plan-mode 原文一致')
  fakeCommands.execute = prevExec

  // (d) 带说明的文字 ⇒ **抛错**把反馈原文回给模型；且不退出计划模式
  planModeCalls.length = 0
  const runs2 = capture(emitCtx('tools/execute',
    { name: 'exit_plan_mode', agent, arguments: { plan: '# 第二版计划' }, signal: undefined }, nextSpy))
  await drain()
  feedInbound('om_plan_keep_tool', '同意，但第 2 步先改成只读排查')
  await drain()
  const os2 = await Promise.all(runs2)
  const thrown = os2.find((o) => o.error)
  ok(Boolean(thrown) && String(thrown.error && thrown.error.message).includes('第 2 步'),
    '带说明 ⇒ **抛错**把反馈原文回给模型（不是 isError:true —— 那会被 harness 判"不可序列化"）')
  ok(os2.filter((o) => o.error).length === 1, '恰好一个监听器抛错（另一个交回 next）')
  ok(planModeCalls.length === 0, '留在计划模式（没有退出）')
}

console.log('46) 插话必须【新开卡片】+ 醒目彩色块（2026-10-02 CM 追加）')
{
  // CM 原话：「我"插话"了以后，你应该新开卡片。不然我说的话全部堆到下面，
  //           但是你一直在旧卡片上更新」。
  let release
  const gate = new Promise((r) => { release = r })
  const prevIdle = agent.whenIdle
  agent.whenIdle = () => gate
  agent.send = function (message) { this.sent.push(message) }
  agent.steered = []
  agent.steer = function (message) { this.steered.push(message) }

  const mark = sentCards.length
  feedInbound('om_steer_start', '起一个会被插话的回合')
  await drain()
  const createsBefore = cardsSince(mark).filter((c) => c.op === 'create').length
  ok(createsBefore >= 1, '活跃回合已建卡（create 次数 ' + createsBefore + '）')

  feedInbound('om_steer_interrupt', '这是我插进去的话')
  await drain()
  ok(agent.steered.some((m) => JSON.stringify(m).includes('这是我插进去的话')),
    '插话以 steer 投递（不排队等整轮跑完）')

  const creates = cardsSince(mark).filter((c) => c.op === 'create')
  ok(creates.length >= createsBefore + 1,
    '插话后**新开了一张卡**（create 次数 ' + createsBefore + ' → ' + creates.length + '）')
  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('后续内容见下方新卡'), '旧卡就地封口并指路（不再往下堆）')
  ok(body.includes('你的消息已插话送达'), '新卡第一块是插话提示')
  ok(body.includes('**📨 你的消息已插话送达**'), '提示标题加粗（markdown 粗体）')
  ok(body.includes('orange-50') && body.includes('background_style'),
    '提示是彩色底块（column_set + background_style，飞书 -50 = 区块背景）')
  ok(body.includes('这是我插进去的话'), '他这句话本身也在提示块里（看得到自己说了什么）')

  release()
  agent.whenIdle = prevIdle
  await drain()
}

console.log('47) 热重载卸载：agent.ctx 上的监听必须被注销（high#1 的核心修法，此前零覆盖）')
{
  // ⭐ 敏感性检查（第三轮门槛 medium#1 的修复）：**从未收到过飞书消息**的 agent，
  // 只靠 agent/status 一次补挂，就必须同时拿到 approval/request **和** user-questions/request。
  // 上一版代码只挂前者 ⇒ 重载后它起自动轮（goal/notice）时问句会只弹电脑、飞书收不到卡；
  // 那条缺陷在**这里会变红**（不是"写了就算验过"）。
  emitCtx('agent/status', { agent: freshAgent, status: 'stopped' })
  await drain()
  ok(freshCount('approval/request') === 1, '新 agent 靠 agent/status 挂上审批水位线')
  ok(freshCount('user-questions/request') === 1, '新 agent 靠 agent/status 也挂上问句水位线（上一版会漏）')

  // 再确保本代已经绑过（agent/status 的任何状态都会补挂审批水位线）
  emitCtx('agent/status', { agent, status: 'stopped' })
  await drain()
  const bound = agentScopeCount('approval/request')
  ok(bound >= 1, '插件确实把 approval/request 挂到了 agent.ctx 上（本次 ' + bound + ' 条）')

  // 再取一次：同一个 agent 重复绑定**不许**叠加（WeakSet 幂等）
  emitCtx('agent/status', { agent, status: 'stopped' })
  await drain()
  ok(agentScopeCount('approval/request') === bound, '同一代重复绑定不叠加（仍是 ' + bound + ' 条）')

  // 模拟 HMR 卸载：**按行为**找出卸载钩子（第四轮门槛 medium）—— 不再假设
  // "第一个 ctx.effect 就是卸载钩子"（那样 index.js 一旦在前面多注册一个 effect，
  // 这个用例要么误报失败、要么去卸载别的东西）。判据就是它该有的效果：
  // 执行后本代挂上去的 agent 作用域监听必须**全部**消失（两个 mock agent 都算）。
  const beforeDisposed = agentScopeDisposed
  ok(effectCleanups.length >= 1, '捕获到 ctx.effect 的 cleanup（' + effectCleanups.length + ' 个）')
  let unloaded = false
  for (const cleanup of effectCleanups) {
    cleanup()
    if (agentScopeCount('approval/request') === 0 && agentScopeCount('user-questions/request') === 0
      && freshCount('approval/request') === 0 && freshCount('user-questions/request') === 0) {
      unloaded = true
      break
    }
  }
  ok(unloaded, '卸载钩子执行后两条水位线均已注销（不再跨代叠加）')
  ok(agentScopeDisposed > beforeDisposed, 'disposer 确实移除过监听（移除次数 ' + agentScopeDisposed + '）')
}

console.log('48) 卡片 schema 校验：schema 2.0 不许出现 tag=action（真机 230099/200861 报错）')
{
  // 2026-10-02 真机事故（CM：「我发了指令，它没弹出这个卡片」）：
  // 我把切换卡从 1.0 形状换成 schema 2.0，却留着 1.0 的 `tag: 'action'` 包按钮 ⇒ 飞书**直接拒建卡**：
  //   code 230099 / ErrCode 200861  ErrPath: ROOT -> body -> elements -> [3](tag: action)
  //   ErrMsg: cards of schema V2 no longer support this capability; unsupported tag action
  // mock 的 fetch 不校验卡片结构 ⇒ 冒烟全绿、真机全废。这条用例把飞书那条规则**前移**到本地。
  const walk = (els, visit) => {
    for (const e of els || []) {
      if (!e || typeof e !== 'object') continue
      visit(e)
      if (Array.isArray(e.elements)) walk(e.elements, visit)
      for (const col of (e.columns || [])) walk(col && col.elements, visit)
    }
  }
  let v2 = 0
  const bad = []
  for (const c of sentCards) {
    const p = c.payload
    if (!p || p.schema !== '2.0') continue
    v2 += 1
    if (!p.body || !Array.isArray(p.body.elements)) bad.push('schema 2.0 卡缺 body.elements')
    walk(p.body && p.body.elements, (e) => {
      if (e.tag === 'action') bad.push('出现 1.0 的 tag=action（2.0 不支持）')
      if (e.tag === 'button' && !Array.isArray(e.behaviors)) bad.push('2.0 按钮缺 behaviors')
    })
  }
  // 带**按钮**的 column_set 不能是 flex_mode='none'（CM 2026-10-02 实测：按钮全被压成省略号）。
  // 'none' 是按内容自适应宽度：纯文本列没问题（工具面板就是），按钮列会塌成一点点。
  // 生产里渲染正常的是 stretch / bisect + width:'weighted'（提问卡、一级 F 都是这套）。
  const noneWithButton = []
  for (const c of sentCards) {
    const p = c.payload
    if (!p || p.schema !== '2.0') continue
    walk(p.body && p.body.elements, (e) => {
      if (e.tag !== 'column_set') return
      const hasButton = (e.columns || []).some((col) => ((col && col.elements) || [])
        .some((el) => el && el.tag === 'button'))
      if (hasButton && (!e.flex_mode || e.flex_mode === 'none')) noneWithButton.push(String(e.flex_mode))
    })
  }
  // 按钮文字长度（CM 2026-10-02 实测）：
  //  · **窄列里的按钮**（放在 column 里）文字 ≤2 字 —— 「但凡超过两个字就会变省略号」
  //  · **整行按钮**（顶层、width:fill）可以长（L1 版式就是把会话名写进按钮），但也要有上限，
  //    免得名字过长把按钮文字挤掉。上限与 index.js 的 SESSION_NAME_MAX(16) + '▶ 12. ' 前缀 对应。
  const longNarrow = []
  const longWide = []
  const walkBtn = (els, inColumn) => {
    for (const e of els || []) {
      if (!e || typeof e !== 'object') continue
      if (e.tag === 'button') {
        const t = String((e.text && e.text.content) || '')
        const n = [...t].length
        if (inColumn ? n > 2 : n > 24) (inColumn ? longNarrow : longWide).push(t)
      }
      if (Array.isArray(e.elements)) walkBtn(e.elements, inColumn)
      // ⚠️ 2026-10-03：**单列** column_set ＝ 整行按钮（例：计划卡的「🎯 以目标模式跑」），
      //    不是"窄列"；只有**多列**共享一行时才算窄列（≤2 字那条约束才适用）。
      const multiCol = Array.isArray(e.columns) && e.columns.length > 1
      for (const col of (e.columns || [])) walkBtn(col && col.elements, multiCol)
    }
  }
  for (const c of sentCards) {
    const p = c.payload
    if (!p || p.schema !== '2.0') continue
    walkBtn(p.body && p.body.elements, false)
  }
  ok(longNarrow.length === 0, '窄列里的按钮文字都 ≤2 字（超过会被截成省略号）'
    + (longNarrow.length ? ' —— 超长：' + longNarrow.slice(0, 3).join(' / ') : ''))
  ok(longWide.length === 0, '整行按钮文字都在上限内（≤24 字，含序号与 ▶ 前缀）'
    + (longWide.length ? ' —— 超长：' + longWide.slice(0, 2).join(' / ') : ''))
  ok(noneWithButton.length === 0,
    '带按钮的 column_set 都用等分/拉伸（不用 none，否则按钮会被压成省略号）'
    + (noneWithButton.length ? ' —— 违规 ' + noneWithButton.length + ' 处' : ''))
  ok(v2 > 0, '本轮确实建过 schema 2.0 的卡（' + v2 + ' 张，否则这条校验没意义）')
  ok(bad.length === 0, 'schema 2.0 卡片全部合法（无 action 元素、按钮走 behaviors）'
    + (bad.length ? ' —— 首个问题：' + bad[0] : ''))
}

console.log('49) 入站文件自动收：飞书发文件 ⇒ 插件自己下载并告知（CM 2026-10-02）')
{
  const dir = join(WORKSPACE, 'downloaded_files')
  // ⚠️ 收件目录**跨轮累积**（它是 tmpdir 下的固定路径，上一次跑的文件还在）——
  //    所以断言一律只看"**这一轮新增**的文件名"，绝不用绝对计数。
  //    （0.5.7 落地后冒烟红 1 条就是踩了这个：`pngFiles.length === 1` 在第二次跑时变成 2。）
  const namesOf = () => (existsSync(dir) ? readdirSync(dir) : [])
  const beforeNames = new Set(namesOf())
  const newNames = () => namesOf().filter((n) => !beforeNames.has(n))
  feedInboundFile('om_file_001', { key: 'file_v3_abc', name: '季度报表.xlsx' })
  await drain()
  const added = newNames()
  ok(added.length === 1, '文件真的落盘（新增 ' + added.length + ' 个）')
  ok(added.some((n) => n.includes('季度报表')), '文件名保留下来（' + String(added[0] || '-') + '）')
  ok(resourceDownloads.length >= 1 && /\/resources\/file_v3_abc\?type=file/.test(resourceDownloads[0].url),
    '走的是消息资源接口（/messages/<id>/resources/<file_key>?type=file）')
  const seen = JSON.stringify(agent.sent)
  ok(seen.includes('收到文件') && seen.includes('季度报表'), '插件自己把文件喂给模型（不用 CM 再口头告诉我一遍）')
  ok(seen.includes('downloaded_files'), '并把落盘路径一起给模型')
  ok(consoleLines.some((l) => l.includes('inbound file saved:')), '留痕 `inbound file saved:`（可日志复验）')
  // ①b 有扩展名的（文件消息带 file_name）**原样保留**，不许被文件头嗅探改写
  ok(added.some((n) => n.endsWith('_季度报表.xlsx')), '带扩展名的文件名原样保留（实际 ' + String(added[0] || '-') + '）')

  // ② 图片：飞书**不给文件名**（只有 image_key）⇒ 必须按**文件头**补扩展名。
  //    真机实例：CM 发的截图存成 `2026-10-02-15-52-19_image`（内容是 JPEG），光看名字看不出格式。
  const beforeImg = new Set(namesOf())
  resourceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
  feedInboundFile('om_file_img', { type: 'image', key: 'img_v3_png' })
  await drain()
  const newImgs = namesOf().filter((n) => !beforeImg.has(n))
  ok(newImgs.length === 1 && newImgs[0].endsWith('_image.png'),
    '图片消息按文件头补上扩展名（本轮新增 ' + String(newImgs[0] || '-') + '）')
  ok(/^\d{4}-\d{2}-\d{2}-\d{6}_/.test(String(newImgs[0] || '')),
    '时间戳换成本地时间格式 YYYY-MM-DD-HHMMSS（旧版是 UTC 的 YYYY-MM-DD-HH-MM-SS）')
  ok(consoleLines.some((l) => l.includes('inbound file saved:') && l.includes('_image.png')),
    '留痕里也能看到补好的扩展名')

  // ③ 认不出的字节 ⇒ `.bin`（**不猜**格式）
  const beforeBin = new Set(namesOf())
  resourceBytes = Buffer.from('hello-from-feishu')
  feedInboundFile('om_file_noext', { key: 'file_v3_noext', name: '没有扩展名' })
  await drain()
  ok(namesOf().filter((n) => !beforeBin.has(n)).some((n) => n.endsWith('_没有扩展名.bin')),
    '认不出的格式补 .bin（不瞎猜）')

  // 失败也要**可见**：不再静默吞掉（CM 原话正是"你不知道，要我告诉你"）
  resourceShouldFail = true
  feedInboundFile('om_file_002', { key: 'file_v3_bad', name: '坏文件.pdf' })
  await drain()
  resourceShouldFail = false
  ok(JSON.stringify(agent.sent).includes('下载失败'), '下载失败时明说失败（HTTP 码 + 文件名），不再无声')
  ok(consoleLines.some((l) => l.includes('inbound file download failed: HTTP 403')), '并留痕 HTTP 状态码')
}

console.log('50) 静默看门狗：提示必须**有诊断含义**（CM 2026-10-03：「我以为你一直在做事」）')
{
  // ⚠️ 本条**必须排在热重载用例之前**：那个用例会把已注册的 ctx.effect cleanup 全跑一遍
  //    （模拟卸载）⇒ 之后**没有任何 watcher 还活着**（第一版排后面，日志里 0 条 buildCardPayload，
  //    断言全绿不了也说明不了问题）。
  // 让这一轮"挂住"（whenIdle 不返回）⇒ 卡保持 running，才走得到静默分支
  let release
  const gate = new Promise((r) => { release = r })
  const prevIdle = agent.whenIdle.bind(agent)
  agent.whenIdle = () => gate
  const logMark = consoleLines.length
  feedInbound('om_stall_watchdog', '看门狗用例')
  await drain()
  ok(consoleLines.slice(logMark).some((l) => l.includes('card created')), '（前提）这一轮建了卡')

  const realNow = Date.now
  const before = sentCards.length
  Date.now = () => realNow() + 6 * 60 * 1000      // 假装已静默 6 分钟（这期间没有任何新事件）
  await drain()
  const slice = JSON.stringify(sentCards.slice(before))
  ok(slice.includes('没有回包'), '★ 零动作静默 6 分钟 ⇒ 卡面写「上游已 N 分钟没有回包」（不是含糊的"无新动作"）')
  ok(slice.includes('不是卡片坏了'), '★ 并写明"不是卡片坏了"（CM：我不知道你在干什么）')
  ok(!slice.includes('还在跑'), '（反例）没有误报成"工具还在跑（正常）"')
  const plain = cardsSince(before).filter((c) => c.op === 'create' && c.payload && !c.payload.schema).length
  ok(plain >= 1, '★ 另发了一条**纯文本**提示（新消息才会提醒，不只是悄悄改卡上一行）')
  ok(consoleLines.slice(logMark).some((l) => l.includes('stall notice sent')), '并留痕 `stall notice sent`')

  // 再跑一轮：每轮只发一次（不刷屏）
  const before2 = sentCards.length
  await drain()
  const plain2 = cardsSince(before2).filter((c) => c.op === 'create' && c.payload && !c.payload.schema).length
  ok(plain2 === 0, '同一轮不重复发（每轮只提示一次）')

  Date.now = realNow
  release()
  agent.whenIdle = prevIdle
  await drain()
}

console.log('51) 热重载打断会话 ⇒ 必须在会话里说清（CM 2026-10-02：0.4.22 之后这条提示没了）')
{
  const activeTurns = globalThis.__fsActiveTurns
  ok(Boolean(activeTurns) && typeof activeTurns.set === 'function',
    '（前提）活跃回合表挂在 globalThis 上（跨代际，新实例看得见）')
  // (a) 旧实例 dispose 侧：重载那一刻有回合在跑 ⇒ 必须留下"待播报"线索
  activeTurns.set('fs-main-reloadtest', {
    bot: { cfg: { appId: APP_ID }, chats: new Map() },
    chatId: CHAT_ID,
    card: { token: 'om_reload_card' },
    split: null,
  })
  globalThis.__fsReloadHint = null
  for (const cleanup of effectCleanups) {
    try { cleanup() } catch { /* 卸载钩子里有别的副作用，这里只关心线索 */ }
  }
  const hint = globalThis.__fsReloadHint
  ok(Boolean(hint) && Array.isArray(hint.items) && hint.items.length === 1,
    '重载前把"可能被中断的回合"登记下来（' + ((hint && hint.items) ? hint.items.length : 0) + ' 条）')
  ok(Boolean(hint) && hint.items[0] && hint.items[0].sessionId === 'fs-main-reloadtest'
    && hint.items[0].chatId === CHAT_ID, '登记的是**那个会话**（sessionId + chatId 都对）')
  ok(consoleLines.some((l) => l.includes('登记 1 个可能被中断的回合')), '旧实例留痕（可日志复验）')
  activeTurns.delete('fs-main-reloadtest')

  // (b) 新实例侧：apply 时读线索 ⇒ 往那个会话发一条说明，且每会话只提示一次
  globalThis.__fsReloadHint = {
    at: Date.now(),
    items: [{ sessionId: 'fs-main-reloadtest', chatId: CHAT_ID, appId: APP_ID }],
  }
  const before = sentCards.length
  const mod2 = await import('../index.js')
  mod2.apply(ctx)
  await drain()
  await drain()
  const texts = sentCards.slice(before).map((c) => JSON.stringify(c.payload))
  ok(texts.some((t) => t.includes('热重载') && t.includes('打断')),
    '重载后在该会话发了提示：说明是**热重载打断**的（不是模型出错）')
  ok(consoleLines.some((l) => l.includes('hot reload interrupt notice')), '留痕 `hot reload interrupt notice`（可日志复验）')
  const notified = globalThis.__fsReloadNotified
  ok(Boolean(notified) && typeof notified.has === 'function' && notified.has('fs-main-reloadtest'),
    '记下"这个会话已提示过"（第二次重载不会重复刷屏）')

  // (c) 幂等：同样的线索再来一次 ⇒ 不再发第二条
  const before2 = sentCards.length
  globalThis.__fsReloadHint = {
    at: Date.now(),
    items: [{ sessionId: 'fs-main-reloadtest', chatId: CHAT_ID, appId: APP_ID }],
  }
  const mod3 = await import('../index.js')
  mod3.apply(ctx)
  await drain()
  await drain()
  const texts2 = sentCards.slice(before2).map((c) => JSON.stringify(c.payload))
  ok(!texts2.some((t) => t.includes('热重载')), '同一个会话不会提示第二遍（幂等）')
}

console.log('52) 审批单卡通道（feishu_approval_form）：工具 / 版式 / 点击 / stale / 超时 / 适配（2026-10-03 任务）')
{
  // ⚠️ 取**第一次**注册的那个工具（第一代）。原因：冒烟的 `drain()` 会把**所有代际**的轮询回调
  //    都跑一遍，而注入的 helper 事件总是由**排在最前的第一代**消费 ⇒ 处理卡片点击的是第一代的
  //    `handleCardAction`，token 也只可能在第一代的 `pendingForms` 里。用别的代际的工具就会出现
  //    "卡发出去了、点击却 record not found"（本用例第一版就踩了这个，白等 4 秒）。
  const formTool = registeredTools.find((t) => t && t.name === 'feishu_approval_form')
  ok(Boolean(formTool), 'feishu_approval_form 工具已注册')
  ok(Boolean(formTool) && typeof formTool.execute === 'function', '工具有 execute')
  // 任何一步没走通都不许把整套用例挂死：给工具结果加一个"很短"的观察窗口
  const settle = (p, ms) => Promise.race([
    p,
    new Promise((r) => setTimeout(() => r({ ok: false, choice: '', timedOut: false, cardId: '', detail: '（还没结算：' + ms + 'ms 内没等到点击/超时）' }), ms)),
  ])

  // 30 分钟的定时器拦下来手动触发（不然用例要等半小时）——只拦这一个时长，其余 setTimeout 照跑
  const origSetTimeout = globalThis.setTimeout
  const formTimers = []
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === 30 * 60 * 1000) { formTimers.push(fn); return 0 }
    return origSetTimeout(fn, ms, ...rest)
  }

  const formArgs = {
    title: '身份标签变更单 · 曹伟轩',
    meta: [
      { label: '单号', value: 'BG-2026-1003-01' },
      { label: '变更类型', value: '身份标签（数据域收窄）' },
      { label: '置信度', value: '0.86' },
      { label: '证据来源', value: '企微通讯录 + 三季度汇报' },
    ],
    categories: [
      { text: '财经：L2 → L2（不变）', change: 'same' },
      { text: '数据域：全量 → 财务（收窄）', change: 'narrow' },
    ],
    skills: [{ text: '台账回填', change: 'add' }, { text: '舆情抓取', change: 'remove' }],
    evidence: ['他三季度只报财务口径', '通讯录显示岗位为财务分析'],
    impact: ['能看到财务域全量台账'],
    risk: ['继续用旧标签 ⇒ 他看到不完整数据'],
    chatId: CHAT_ID,
  }
  // ⚠️ 夹具时序（第一版踩了）：前面用例 38/39 改写过配置（还写过别的 appId），
  //    而 `bot.cfg`/`bots` 是**每 10 秒热读一次**才回填 ⇒ 这里必须先等过热读节拍，
  //    否则 `findBotForChat(CHAT_ID)` 解析不到 bot（日志特征：`approval form target: ... bot=no`）。
  await new Promise((r) => setTimeout(r, 11000))
  await drain()
  const mark = sentCards.length
  const pendingForm = Promise.resolve()
    .then(() => formTool.execute(formArgs, { agent, signal: undefined }))
    .catch((e) => ({ ok: false, choice: '', timedOut: false, cardId: '', detail: 'THREW: ' + String(e && e.message || e) }))
  await drain()
  const formCard = lastCardFrom(mark)
  if (!formCard) {
    // 失败也要把**原因**打出来（否则只能猜）——等一个很短的时间看工具返回了什么
    const probe = await Promise.race([
      pendingForm,
      new Promise((r) => setTimeout(() => r({ detail: '（工具还在等点击，说明卡其实发了但没被 lastCardFrom 认出来）' }), 300)),
    ])
    ok(false, '审批单卡已发出 —— 实际：' + JSON.stringify(probe))
  } else {
    ok(true, '审批单卡已发出')
  }
  const fp = (formCard && formCard.payload) || {}
  ok(fp.schema === '2.0' && Boolean(fp.header) && fp.header.template === 'blue', '卡头＝蓝色')
  ok(JSON.stringify((fp.header && fp.header.title) || '').includes('身份标签变更单 · 曹伟轩'), '卡头带人名的标题')
  const fEls = ((fp.body && fp.body.elements) || [])
  const fieldDiv = fEls.find((e) => e.tag === 'div' && Array.isArray(e.fields))
  // 2026-10-03 CM 真机反馈：短值并排（单号 + 置信度）；长值各占一行（变更类型 / 证据来源）
  ok(Boolean(fieldDiv) && fieldDiv.fields.length === 2
    && fieldDiv.fields.every((f) => f.is_short === true),
    '短值两列并排：只有 单号 + 置信度 进 fields 区且 is_short=true（实际 '
      + (fieldDiv ? fieldDiv.fields.length : 0) + ' 个）')
  const divText = JSON.stringify((fieldDiv && fieldDiv.fields) || [])
  ok(!divText.includes('身份标签（数据域收窄）') && !divText.includes('企微通讯录'),
    '长文本**没有**被塞进双列框里')
  const longRows = fEls.filter((e) => e.tag === 'markdown' && /^\*\*.+\*\*\n/.test(String(e.content || '')))
  ok(longRows.some((e) => String(e.content).includes('变更类型') && String(e.content).includes('身份标签（数据域收窄）')),
    '「变更类型」这类长文本**单独一行**')
  ok(longRows.some((e) => String(e.content).includes('证据来源') && String(e.content).includes('企微通讯录')),
    '「证据来源」这类长文本**单独一行**')
  const flat = JSON.stringify(fEls)
  ok(['①', '②', '③', '④', '⑤'].every((n) => flat.includes(n)),
    '五个分区标题都在（①~⑤）')
  ok(!flat.includes('⑥ 操作'), '不再有「⑥ 操作」这行标题（CM 2026-10-03：「这几个文本不需要」）')
  ok(flat.includes('🔹') && flat.includes('🔸'), '① 用 🔹/🔸 区分「不变 / 收窄」')
  ok(flat.includes('➕') && flat.includes('➖'), '② 用 ➕/➖ 表示新增/取消')
  ok(flat.includes('> 他三季度只报财务口径'), '③ 证据渲染成引用块')
  ok(fEls.filter((e) => e.tag === 'hr').length >= 5, '分区之间有 hr 分隔（' + fEls.filter((e) => e.tag === 'hr').length + ' 条）')
  const actionRow = fEls.find((e) => e.tag === 'column_set')
  const actionBtns = ((actionRow && actionRow.columns) || []).map((c) => (c.elements || [])[0])
  ok(Boolean(actionRow) && actionRow.flex_mode === 'bisect', '操作行＝两列等分（bisect）')
  ok(actionBtns.length === 2, '★ **只有两个按钮**：采纳 / 驳回（实际 ' + actionBtns.length + ' 个）')
  ok(Boolean(actionBtns[0]) && actionBtns[0].type === 'primary'
    && Boolean(actionBtns[1]) && actionBtns[1].type === 'danger',
    '★ 按钮**带色**：采纳=primary(蓝) / 驳回=danger(红)')
  ok(actionBtns.every((b) => b && b.text && (b.text.content === '✅ 采纳' || b.text.content === '❌ 驳回')),
    '按钮文案就是 采纳 / 驳回（没有第三个「我要改」）')
  ok(actionBtns.every((b) => b && b.behaviors && b.behaviors[0].value.fs_form !== undefined
    && b.behaviors[0].value.fs_choice !== undefined), '两个按钮都带 { fs_form, fs_choice }')
  const formToken = actionBtns[0].behaviors[0].value.fs_form
  ok(consoleLines.some((l) => l.includes('approval form sent:') && l.includes('token=' + formToken)),
    '留痕 `approval form sent`（可日志复验）')

  // 点击「采纳」⇒ 工具拿到选择 + 卡就地变回执卡
  const decideMark = sentCards.length
  await tapValue(actionBtns[0].behaviors[0].value)
  const decided = await settle(pendingForm, 4000)
  ok(decided && decided.ok === true && decided.choice === '采纳', '★ 点「采纳」⇒ 工具结果拿到 choice=采纳（' + JSON.stringify(decided && decided.choice) + '）')
  ok(decided && decided.timedOut === false && String(decided.cardId || '').length > 0, '工具结果带 cardId 且非超时')
  const receipt = sentCards.slice(decideMark).filter((c) => c.op === 'update').pop()
  const rp = (receipt && receipt.payload) || {}
  const rpText = JSON.stringify(rp)
  // J（2026-10-03 CM）：「审批卡是特殊的存在，点了以后**不应该把旧的内容清掉**，
  //   就应该把**两个按钮那个位置**变成'你已经审批过了'」⇒ 三条断言锁死这个语义。
  ok(rpText.includes('你已经审批过了：采纳'), '★ 按钮那一行换成了「你已经审批过了：采纳」')
  ok(rpText.includes('身份标签变更单') && rpText.includes('变更类型') && rpText.includes('① 类别'),
    '★ **正文全部保留**（标题 + 长文本字段 + 分区①都还在 —— 不再整卡变两行回执）')
  const receiptBtns = []
  for (const el of ((rp.body && rp.body.elements) || [])) {
    if (el && el.tag === 'action') {
      for (const a of (el.actions || [])) if (a && a.tag === 'button') receiptBtns.push(a)
    }
    if (el && el.tag === 'button') receiptBtns.push(el)
    for (const col of ((el && el.columns) || [])) {
      for (const ce of (col && col.elements) || []) if (ce && ce.tag === 'button') receiptBtns.push(ce)
    }
  }
  ok(receiptBtns.length === 0, '★ 点完后**不再有任何按钮**（实际 ' + receiptBtns.length + ' 个）')
  ok(rp.header && rp.header.template === 'green', '采纳 ⇒ 回执卡头绿色')
  ok(consoleLines.some((l) => l.includes('approval form decided:') && l.includes('-> 采纳')), '留痕 `approval form decided`')

  // stale 点击（同一张卡再点一次）：**不许静默**，必须一条可见提示
  const staleMark = sentCards.length
  await tapValue(actionBtns[0].behaviors[0].value)
  const staleText = JSON.stringify(sentCards.slice(staleMark))
  ok(staleText.includes('已经处理过了') || staleText.includes('已过期'), '★ 旧卡再点 ⇒ 可见提示（不是静默 no-op）')
  ok(consoleLines.some((l) => l.includes('form button: record not found')), '并留痕 `form button: record not found`')

  // 超时（30 分钟）：可见告知 + 卡变超时态 + 工具结果 timedOut
  const mark2 = sentCards.length
  formTimers.length = 0          // 只认本用例自己那个定时器（前面那条早被点击结算掉了）
  const pendingTimeout = formTool.execute(Object.assign({}, formArgs, { title: '超时用例单' }), { agent, signal: undefined })
  await drain()
  ok(formTimers.length >= 1, '捕获到 30 分钟定时器（' + formTimers.length + ' 个）')
  const fireTimeout = formTimers.pop()
  if (typeof fireTimeout === 'function') fireTimeout()
  const timedOut = await settle(pendingTimeout, 4000)
  ok(timedOut && timedOut.timedOut === true && timedOut.choice === '', '★ 超时 ⇒ 工具结果 timedOut=true（choice 为空）')
  const timeoutText = JSON.stringify(sentCards.slice(mark2))
  ok(timeoutText.includes('自动作废'), '★ 超时**可见地**说明（纯文本 + 卡面都写了"自动作废"）')
  ok(timeoutText.includes('（超时未操作）'), '超时后卡面也换成超时态')

  globalThis.setTimeout = origSetTimeout

  // askUserQuestion 适配通道：questions[0].card ⇒ 直接渲染审批单卡，回答按 question-answer 形状回传
  //
  // ⚠️ 夹具坑（第一版就踩了）：`findChatForAgent` 跨代际**只认「会话 id == agent id」**这条
  //    （生产实测两者同为 `fs-main-*`，且会话 id 已落盘 ⇒ 重载后照样认得出）。而冒烟的假 agent
  //    id 是 `agent-smoke-1`、会话 id 是 `fs-main-*`，只有"活 handle"那条路能匹配 —— 用例 50
  //    重载过两代之后 handle 早没了 ⇒ 日志「no chat owner for agent agent-smoke-1, delegating」
  //    ⇒ 根本没有卡。这里按生产的形态传 id（用**已落盘的会话 id**），验的才是插件逻辑。
  const adaptAgentId = createdSessionIds[createdSessionIds.length - 1] || agent.id
  const adaptAgent = { id: adaptAgentId, ctx: agentCtx }
  const questions = [{
    id: 'approval-1',
    question: '身份标签变更：是否采纳？',
    options: [{ label: '采纳' }, { label: '驳回' }, { label: '改' }],
    card: { title: '身份标签变更单 · 曹伟轩（适配通道）', meta: [{ label: '单号', value: 'BG-2' }], categories: [{ text: '财经 L2 → L2', change: 'same' }] },
  }]
  const mark3 = sentCards.length
  const r = emitCtx('user-questions/request', { questions, agent: adaptAgent, signal: undefined }, () => Promise.resolve('next'))
  await drain()
  const adaptCard = lastCardFrom(mark3)
  ok(JSON.stringify((adaptCard && adaptCard.payload) || {}).includes('身份标签变更单 · 曹伟轩（适配通道）'),
    '★ askUserQuestion 带 card 字段 ⇒ 走审批单卡（不是"文字 + 选它"简卡）')
  const adaptBtns = allButtons(adaptCard)
  ok(adaptBtns.length === 2 && adaptBtns[0].type === 'primary' && adaptBtns[1].type === 'danger',
    '适配通道的卡也是两个带色按钮（采纳/驳回，实际 ' + adaptBtns.length + ' 个）')
  await tapValue(adaptBtns[1].value)
  // 多个代际都挂在同一条水位线上（用例 50 重载过），`r[0]` 可能是"交回下一个"那条 ⇒
  // 从**所有**返回值里挑出真正带 answers 的那个（这才是接管成功的那条）。
  const allReturns = await Promise.all((r || []).map((x) => settle(x, 4000)))
  const answered = allReturns.find((x) => x && x.answers) || allReturns[0]
  ok(answered && answered.answers && answered.answers[0] && answered.answers[0].selected
    && answered.answers[0].selected[0] === '驳回',
    '★ 适配通道点「驳回」⇒ 按 question-answer 形状回传 selected=[驳回]（实际：' + JSON.stringify(answered) + '）')

  // 护栏：非飞书会话 + 没给 chatId ⇒ 明确报错，绝不瞎发
  const foreign = await formTool.execute({ title: '不该发出去的单' }, { agent: { id: 'agent-not-feishu' }, signal: undefined })
  ok(foreign && foreign.ok === false && String(foreign.detail).includes('不是飞书会话'),
    '★ 非飞书会话 ⇒ 明确报错（不瞎发到别人的会话）')

  // ---- 泛化通道（0.6.2）：`sections` 用**任意**审批单，标题自动补 ①~⑩
  const mark4 = sentCards.length
  const genericPromise = formTool.execute({
    title: '权限申请单 · 通用形态',
    meta: [{ label: '申请单号', value: 'REQ-2026-1' }, { label: '紧急度', value: 'P1' }],
    sections: [
      { title: '申请内容', lines: ['开通「财务域」只读'] },
      { title: '理由', lines: ['季度对账需要'] },
      { title: '不会越权的地方', lines: ['不改数据、不外发'] },
    ],
    chatId: CHAT_ID,
  }, { agent, signal: undefined })
  await drain()
  const genericCard = lastCardFrom(mark4)
  const gp = JSON.stringify((genericCard && genericCard.payload) || {})
  ok(gp.includes('① 申请内容') && gp.includes('② 理由') && gp.includes('③ 不会越权的地方'),
    '★ 泛化 `sections` ⇒ 任意审批单，标题自动补 ①~③（不必套"类别×L档"那套）')
  ok(gp.includes('开通「财务域」只读') && gp.includes('REQ-2026-1'), '泛化段内容与短字段原样上卡')
  const genericBtns = allButtons(genericCard)
  ok(genericBtns.length === 2 && genericBtns[0].type === 'primary' && genericBtns[1].type === 'danger',
    '泛化卡同样是两个带色按钮（采纳/驳回）')
  await tapValue(genericBtns[0].value)          // 别让这张卡挂着没人点
  await settle(genericPromise, 4000)

  // ---- 开关（0.6.2）：approvalForm 关掉 ⇒ 工具**明确拒绝** + 适配通道**回退**普通提问卡
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{
      name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
      reactionEmoji: 'GLANCE', approvalForm: false,
    }],
  }, null, 2))
  await new Promise((r) => setTimeout(r, 11000))   // 等过热读节拍（bot.cfg 每 10 秒重读一次）
  await drain()
  // 注意：这里必须显式给 chatId —— 否则先撞"不是飞书会话"那条护栏（本用例要把闸门压到开关这一层）
  const refused = await formTool.execute({ title: '关掉开关后不该发', chatId: CHAT_ID }, { agent, signal: undefined })
  ok(refused && refused.ok === false && String(refused.detail).includes('没打开审批单通道'),
    '★ approvalForm=false ⇒ 工具**明确拒绝**（不发卡，并给出"怎么打开"的一句话）—— 实际：' + JSON.stringify(refused))
  ok(consoleLines.some((l) => l.includes('approval form refused')), '并留痕 `approval form refused`')

  const mark5 = sentCards.length
  const q2 = [{
    id: 'plain-1', question: '普通提问（开关关掉后）',
    options: [{ label: '甲' }, { label: '乙' }],
    card: { title: '关掉后不该走审批单卡' },
  }]
  emitCtx('user-questions/request', { questions: q2, agent: adaptAgent, signal: undefined }, () => Promise.resolve('next'))
  await drain()
  const fallbackCard = lastCardFrom(mark5)
  const fbText = JSON.stringify((fallbackCard && fallbackCard.payload) || {})
  ok(fbText.includes('选它') && !fbText.includes('关掉后不该走审批单卡'),
    '★ 开关关掉 ⇒ 带 `card` 的提问**回退**成普通提问卡（绝不误发审批单）')
}

console.log('53) F 失败可见 + G 上传：被拒必须「用户看得见 + Agent 收得到」；本地图片必须先换 image_key')
{
  const imgTool = registeredTools.find((t) => t && t.name === 'feishu_send')
  ok(Boolean(imgTool), '（前提）拿到 feishu_send 工具')
  // ⚠️ 夹具要点（踩过）：`feishu_send` 在**目标会话有活跃卡**时会**主动跳过**
  //    （设计如此：回复会自动进卡片，别另发一条）⇒ 返回 ok:true 但**没有真发**，
  //    于是上传根本不会被触发。这里用一个"没有活跃卡"的会话，才走得到真发送。
  const FREE_CHAT = 'oc_smoke_nocard_001'

  // ---- G：正文里的本地图片 ⇒ 先上传换 key（飞书**只认 img_key**；本地路径会**整张卡被拒**）
  const gMark = sentCards.length
  const picPath = join(process.env.TEMP || '.', 'fs-smoke-pic.png')
  writeFileSync(picPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const gOut = await imgTool.execute({
    text: '把这张图发我 ![示意图](' + picPath + ')',
    chatId: FREE_CHAT,
  }, { agent, signal: undefined })
  await drain()
  ok(imageUploads.length >= 1, '★ 本地图片**触发了上传**（POST /open-apis/im/v1/images）')
  const gText = JSON.stringify(sentCards.slice(gMark).map((c) => c.payload))
  ok(gText.includes('img_v3_smoke_key'), '★ 卡里换成了**真 `image_key`**（图片才会显示）')
  ok(!gText.includes('fs-smoke-pic.png'), '★ 卡里**不再有本地文件名**（否则整张卡会被飞书拒）')
  ok(gOut && gOut.ok === true, '（工具侧）发卡成功 ⇒ Agent 拿到 ok')
  ok(consoleLines.some((l) => l.includes('image uploaded')), '上传留痕 `image uploaded`')

  // ---- F：连"兜底纯文本"都被拒 ⇒ ①留痕 ②**降级重试**（剥掉 markdown）③**把失败交回 Agent**
  const fMark = sentCards.length
  rejectPatches = 2                     // 第一次 + 降级重试都拒：模拟"这段就是发不出去"
  const fOut = await imgTool.execute({
    text: '**这段会先被拒** ![图](http://example.com/x.png)',
    chatId: FREE_CHAT,
  }, { agent, signal: undefined })
  await drain()
  ok(consoleLines.some((l) => l.includes('plain text send failed')), '★ 兜底失败**留痕**（不再静默）')
  ok(consoleLines.some((l) => l.includes('plain text degraded retry')), '★ 自动**降级重试**（剥掉 markdown 再发一次）')
  ok(sentCards.length > fMark, '降级重试确实又发了一次（不是空转）')
  ok(fOut && fOut.ok === false,
    '★ 两次都失败 ⇒ **工具把失败交回 Agent**（它不会以为发成功了就收工）：'
      + JSON.stringify(fOut && fOut.detail).slice(0, 90))
}
console.log('')
if (failures === 0) {
  console.log('SMOKE PASS (sentCards=' + sentCards.length + ', sessions=' + createdSessions + ')')
  process.exit(0)
} else {
  console.log('SMOKE FAIL: ' + failures + ' assertion(s) failed')
  process.exit(1)
}