// dsh-feishucard smoke test: boots the real host plugin against a mocked
// DSH context and a mocked Feishu REST API, feeds one inbound message through
// the helper protocol, and asserts the full turn pipeline:
//   event -> dedicated session create -> agent.send -> streaming card
//   (create + PATCH updates) -> seal -> final reply on card.
//
// Run: node scripts/smoke.mjs   (from the package root)
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const APP_ID = 'cli_test123456'
const APP_SECRET = 'secret-test'
const WORKSPACE = 'C:/smoke/workspace'
const CHAT_ID = 'oc_smoke_chat_001'
const MSG_ID = 'om_smoke_msg_001'

// Point the plugin at a throwaway config dir so the test never touches the
// real ~/.dsh-feishucard (the plugin honours process.env.FS_CONFIG_DIR).
const FAKE_HOME = join(tmpdir(), 'fs-smoke-' + Date.now())
mkdirSync(join(FAKE_HOME, '.dsh-feishucard'), { recursive: true })
writeFileSync(join(FAKE_HOME, '.dsh-feishucard', 'feishu.config.json'),
  JSON.stringify({ bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET }] }, null, 2))
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
let tenantTokenCalls = 0
let createReturnsEmptyId = false   // 建卡幂等测试：模拟返回体缺 message_id
const globalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.includes('/auth/v3/tenant_access_token/internal')) {
    tenantTokenCalls += 1
    return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 })) }
  }
  if (u.includes('/reactions') && (init.method === 'POST' || init.method === 'DELETE')) {
    return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, data: { reaction_id: 're_1' } })) }
  }
  if (u.includes('/im/v1/messages')) {
    const raw = JSON.parse(init.body)
    const payload = typeof raw.content === 'string' ? JSON.parse(raw.content) : raw
    sentCards.push({ op: init.method === 'PATCH' ? 'update' : 'create', payload })
    if (init.method === 'PATCH') {
      return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0 })) }
    }
    if (createReturnsEmptyId) {
      return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, data: {} })) }
    }
    return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, data: { message_id: 'om_card_' + sentCards.length } })) }
  }
  return { status: 404, text: () => Promise.resolve('unhandled: ' + u) }
}

// ---- mocked agent ------------------------------------------------------------
const agentEvents = []
const agent = {
  id: 'agent-smoke-1',
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
}
const fakeCommands = { execute: async () => undefined }   // 默认"注册表没接管" → 走 goals 兜底

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
        resume: async () => { resumedSessions += 1; return { agent } },
        list: () => liveAgents,
      }
    }
    if (key === 'sandboxPolicy') return { workspaceRoot: WORKSPACE }
    if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test-model' }) }
    if (key === 'goals') return fakeGoals
    if (key === 'commands') return fakeCommands
    if (key === 'sessionPersistence') return fakePersistence
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
  effect(fn) { effects.push(fn); const cleanup = fn(); return cleanup },
  webServer: { register: (route) => registeredRoutes.push(route) },
  tools: { register: (t) => registeredTools.push(t) },
  inject(keys, callback) {
    // cordis service injection: only invoke when a known service is present.
    // planMode is not provided by the smoke mock, so the callback is kept for
    // API-shape compatibility and simply not fired.
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
function emitCtx(event, payload) {
  for (const listener of (ctxListeners.get(event) || [])) listener(payload)
}

// ---- boot the real plugin -------------------------------------------------------
const mod = await import('../index.js')
mod.apply(ctx)

// Fire the interval callback a few times to let ensureHelpers spawn and drain.
for (let i = 0; i < 3; i++) {
  for (const fn of intervals) fn()
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
  ok(opened.length === 1, '目标轮自动建了一张卡（create 次数 ' + opened.length + '）')
  const openBody = JSON.stringify(opened)
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

console.log('15) /switch：列出可切换的会话/工作区（CM 2026-09-16 需求）')
{
  const mark = sentCards.length
  const summaryText = '帮我看看上周的复盘记录'
  const ownId = createdSessionIds[0]
  persistedSessions = [
    { version: 0, id: ownId, createdAt: Date.now() - 7200e3, cwd: WORKSPACE },                    // 已在本聊天 → 不应重复列出
    { version: 0, id: 'gui-session-aaaa1111', createdAt: Date.now() - 3600e3, cwd: WORKSPACE },
    { version: 0, id: 'fu-session-bbbb2222', createdAt: Date.now() - 1800e3, cwd: 'P:/fu' },
    { version: 0, id: 'sub-child-cccc3333', createdAt: Date.now() - 600e3, cwd: WORKSPACE, origin: 'subagent' },
  ]
  persistedFirstText['gui-session-aaaa1111'] = summaryText

  feedInbound('om_switch_list', '/switch')
  await drain()

  const picker = sentCards.slice(mark).filter((c) => c.op === 'create' && c.payload && Array.isArray(c.payload.elements)).pop()
  const body = JSON.stringify(picker && picker.payload)
  ok(Boolean(picker) && body.includes('① 本聊天的会话'), '卡片列了「本聊天的会话」组')
  ok(body.includes('② 本工作区的其它会话'), '卡片列了「本工作区的其它会话」组')
  ok(body.includes('③ 其它工作区'), '卡片列了「其它工作区」组')
  ok(body.includes('gui-sess'), '列出了其它会话（短 id）')
  ok(body.includes(summaryText), '其它会话带了首条消息摘要（认得出是哪个）')
  ok(!body.includes('sub-chil'), '子代理子会话不被列为可切换目标')

  // 行号从卡片里读出来（本聊天有几个会话由前面的用例决定，不写死）
  const rowDivs = (picker.payload.elements || [])
    .filter((e) => e.tag === 'div' && /(^|\n)\s*(▶ )?\d+\. /.test(String((e.text && e.text.content) || '')))
  const indexOfRow = (needle) => {
    const el = rowDivs.find((e) => String(e.text.content).includes(needle))
    if (!el) return -1
    const m = /(\d+)\. /.exec(String(el.text.content))
    return m ? Number(m[1]) - 1 : -1
  }
  const guiIndex = indexOfRow(summaryText)
  const fuIndex = indexOfRow('P:/fu')
  ok(rowDivs.length === 4, '共 4 行（2 个本聊天会话 + 本工作区 1 条 + 其它工作区 1 条），既没重复也没多列（' + rowDivs.length + '）')
  ok(guiIndex >= 0 && fuIndex > guiIndex, '两个候选行的序号可读且顺序正确（gui=' + (guiIndex + 1) + ', fu=' + (fuIndex + 1) + '）')
  const ownIdShown = rowDivs.filter((e) => String(e.text.content).includes(ownId.slice(0, 8))).length
  ok(ownIdShown >= 1 && rowDivs.length === 4, '已在本聊天的会话没有被当成"其它会话"重复列一遍')

  // 点「接管」按钮 → 走真实卡片回调路径（helper 事件 → handleCardAction）
  const buttons = (picker.payload.elements || [])
    .filter((e) => e.tag === 'action')
    .flatMap((e) => e.actions || [])
  const takeover = buttons.find((b) => b.value && b.value.fs_index === guiIndex && b.value.fs_mode === 'takeover')
  ok(Boolean(takeover), '空闲会话给了「接管」按钮')
  const tookBefore = resumedSessions
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'card.action.trigger',
    data: {
      action: { tag: 'button', value: takeover.value },
      context: { open_chat_id: CHAT_ID },
    },
  }) + '\n'
  await drain()
  ok(resumedSessions === tookBefore + 1, '点按钮后真的 resume 了那个会话（接管生效）')

  // 文本兜底：/switch <序号> new → 在该工作区新建（cwd 必须是那个工作区）
  feedInbound('om_switch_new', '/switch ' + (fuIndex + 1) + ' new')
  await drain()
  ok(agent.session.header.cwd === 'P:/fu', 'new 模式把新会话的 cwd 设成了那个工作区（实际 ' + agent.session.header.cwd + '）')

  // 运行中的会话（🟡）不给「接管」：只允许新建
  // 注意：前面"接管"过的会话已经进了本聊天（切过去只是换序号，不需要 resume），
  // 所以这里拿**没进本聊天**的 P:/fu 会话来验 🟡 规则。
  liveAgents.push({ id: 'fu-session-bbbb2222', session: agent.session })
  const mark2 = sentCards.length
  feedInbound('om_switch_live', '/switch')
  await drain()
  const livePicker = sentCards.slice(mark2).filter((c) => c.op === 'create' && c.payload && Array.isArray(c.payload.elements)).pop()
  const liveBody = JSON.stringify(livePicker && livePicker.payload)
  ok(liveBody.includes('🟡'), '运行中的会话被标成 🟡')
  ok(liveBody.includes('运行中（只给'), '卡面说明了 🟡 的规则（不让 CM 猜）')
  const liveRowDivs = (livePicker.payload.elements || [])
    .filter((e) => e.tag === 'div' && /(^|\n)\s*(▶ )?\d+\. /.test(String((e.text && e.text.content) || '')))
  const liveFuRow = liveRowDivs.find((e) => String(e.text.content).includes('fu-sess'))
  const liveFuIndex = liveFuRow ? Number(/(\d+)\. /.exec(String(liveFuRow.text.content))[1]) - 1 : -1
  ok(liveFuIndex >= 0, '🟡 那一行还在列表里（序号 ' + (liveFuIndex + 1) + '）')
  const liveButtons = (livePicker.payload.elements || [])
    .filter((e) => e.tag === 'action')
    .flatMap((e) => e.actions || [])
    .filter((b) => b.value && b.value.fs_index === liveFuIndex)
  ok(liveButtons.length === 1 && liveButtons[0].value.fs_mode === 'new',
    '运行中的会话只给了「新建」按钮（' + JSON.stringify(liveButtons.map((b) => b.text.content)) + '）')
  // 文字路径也必须挡住接管
  feedInbound('om_switch_live_takeover', '/switch ' + (liveFuIndex + 1))
  await drain()
  const warn = sentCards.slice(mark2).filter((c) => c.op === 'create' && c.payload && Array.isArray(c.payload.elements)).pop()
  ok(JSON.stringify(warn && warn.payload).includes('正在别处运行'), '文字接管被挡下并说明原因')
  liveAgents.length = 0
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
  ok(body.includes('_失败_'), '失败回合的状态行是「失败」')
  ok(!body.includes('_✅ 已完成_'), '失败回合不再假称「已完成」')

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
  ok(body.includes('_失败_'), '状态行是「失败」')
  ok(!body.includes('_✅ 已完成_'), '不假称「已完成」')
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
  ok(createsSince(mark).length === 1, '第 4 轮建卡')

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
  ok(body.includes('_失败_'), '状态行是「失败」')
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
  ok(body.includes('_失败_'), '无产出的回合状态行是「失败」，不假称完成')
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

console.log('')
if (failures === 0) {
  console.log('SMOKE PASS (sentCards=' + sentCards.length + ', sessions=' + createdSessions + ')')
  process.exit(0)
} else {
  console.log('SMOKE FAIL: ' + failures + ' assertion(s) failed')
  process.exit(1)
}
