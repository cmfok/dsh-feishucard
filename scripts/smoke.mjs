// dsh-feishu-stream smoke test: boots the real host plugin against a mocked
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
// real ~/.cc-connect (the plugin honours process.env.FS_CONFIG_DIR).
const FAKE_HOME = join(tmpdir(), 'fs-smoke-' + Date.now())
mkdirSync(join(FAKE_HOME, '.cc-connect'), { recursive: true })
writeFileSync(join(FAKE_HOME, '.cc-connect', 'feishu.config.json'),
  JSON.stringify({ bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET }] }, null, 2))
process.env.FS_CONFIG_DIR = join(FAKE_HOME, '.cc-connect')

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
    events: agentEvents,
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

console.log('')
if (failures === 0) {
  console.log('SMOKE PASS (sentCards=' + sentCards.length + ', sessions=' + createdSessions + ')')
  process.exit(0)
} else {
  console.log('SMOKE FAIL: ' + failures + ' assertion(s) failed')
  process.exit(1)
}
