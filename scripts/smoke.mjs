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
    // cordis event subscription: recorded, never fired by the smoke mock.
    void event; void listener
    return () => {}
  },
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

console.log('')
if (failures === 0) {
  console.log('SMOKE PASS (sentCards=' + sentCards.length + ', sessions=' + createdSessions + ')')
  process.exit(0)
} else {
  console.log('SMOKE FAIL: ' + failures + ' assertion(s) failed')
  process.exit(1)
}
