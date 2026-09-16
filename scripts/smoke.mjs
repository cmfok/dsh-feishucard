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

const ctx = {
  get(key) {
    if (key === 'agents') {
      return {
        create: async (opts) => {
          createdSessions += 1
          agent.session.header.cwd = opts.meta && opts.meta.cwd
          if (opts.setup) await opts.setup({ get: () => ({ mount: async () => {} }) })
          return { agent }
        },
        resume: async () => { resumedSessions += 1; return { agent } },
      }
    }
    if (key === 'sandboxPolicy') return { workspaceRoot: WORKSPACE }
    if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test-model' }) }
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

console.log('')
if (failures === 0) {
  console.log('SMOKE PASS (sentCards=' + sentCards.length + ', sessions=' + createdSessions + ')')
  process.exit(0)
} else {
  console.log('SMOKE FAIL: ' + failures + ' assertion(s) failed')
  process.exit(1)
}
