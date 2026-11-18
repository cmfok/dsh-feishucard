/**
 * evalchat-route.mjs —— [RC-004-F085-20261117] 评价追问回复路由内核（「注入即声明回填通道」）
 *
 * 背景（G5-F085，生产实证 2026-10-23：/tool/evaluation_chat 端点在册零调用、审计零
 * evaluation_answer_filled/unmatched ⇒ 面试官回复 hrbot 的文字从未进 v2 接收链）：
 *   · RC-004 v2（2026-10-23 方向）＝发卡程序经桥 /feishu/admin/inject-context 向会话注入
 *     上下文，让模型自己调 evaluation_chat 回填——已实现（桥端点 index.js:12453＋a4_evaluate
 *     _inject_context），但存在结构性缺口：注入文本让模型填 `sender_open_id`，而模型在会话里
 *     **拿不到**用户的 open_id（identity 覆写只罩 tools/execute 工具入参面）。
 *   · 本模块补「确定性接住」：发卡程序在 inject-context 载荷里**顺带声明回填通道**
 *     （route_endpoint / route_token / route_ttl_s）⇒ 桥登记之；该用户的下一条 p2p 文本由桥以
 *     **桥侧真值 sender_open_id**（入站事件服务端字段）优先调 v2 evaluation_chat：
 *       - 端点非空回复 ⇒ 回执用户并消费登记（hijack）；
 *       - 端点空回复（v2 无话可说＝无待答轮次）⇒ 不劫持，走原对话，消费登记；
 *       - 端点失败/超时 ⇒ 降级原对话＋日志留痕，登记放回待重试（TTL 兜底）。
 *     注入上下文（模型面）原样保留 ⇒ 成为降级路径的兜底，两方案互补。
 *   · 通用性（维护者 作废首版「每卡一条路由规则」的关切）：桥**不查任何业务库**、不认识任何卡型；
 *     通道由发卡程序在注入时自声明，端点白名单（默认仅本机回环）控制可调面。
 *
 * 纯逻辑＋零依赖（node:http 直连，不假设 global fetch），自测：
 *   `node evalchat-route.mjs --selftest`（起 127.0.0.1 随机端口替身端点，三例＋边界全绿）
 *
 * 版本：V0.1-26111701（2026-11-17，G5 内部记录 / G5-F085 首版）
 */

import http from 'node:http'

/** 登记条目默认存活：72h（覆盖 a4 首追＋24h 催办窗口；a4 每次发卡/催办都会重登记刷新） */
export const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000
/** TTL 上下限（防手滑传 0 或万年登记）：60s ～ 7d */
export const TTL_MIN_MS = 60 * 1000
export const TTL_MAX_MS = 7 * 24 * 60 * 60 * 1000
/** 端点调用超时（v2 网关同族口径；超时＝失败降级，不能让面试官的消息卡死） */
export const CALL_TIMEOUT_MS = 8000
/** 调用方文本截断（与 v2 tool_evaluation_chat 的 text[:2000] 同口径） */
export const TEXT_MAX = 2000
/** 端点 URL / token 长度上限（登记面输入校验） */
export const ENDPOINT_MAX = 512
export const TOKEN_MAX = 256

/**
 * 登记表：key = `appId|openId`（open_id 是应用视角值，跨 app 不同值 ⇒ 按 app 隔离；
 * 单 open_id 只留一条——a4 对同一面试官再发卡＝刷新登记，不吃内存）。
 * 内存态：桥重启/热重载由 index.js 挂 globalThis 跨代；重启丢登记＝下次发卡重登记，
 * 不丢面试官已回复的存量数据（evaluation 在 v2 库里）。
 */
export class EvalRouteRegistry {
  constructor () { this.byKey = new Map() }

  static key (appId, openId) { return String(appId) + '|' + String(openId) }

  register ({ appId, openId, endpoint, token, tag = '', ttlMs = DEFAULT_TTL_MS, now = Date.now() }) {
    if (!appId || !openId || !endpoint || !token) throw new Error('register: appId/openId/endpoint/token required')
    const ttl = Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, Number(ttlMs) || DEFAULT_TTL_MS))
    const entry = { appId: String(appId), openId: String(openId), endpoint: String(endpoint),
      token: String(token), tag: String(tag || ''), expiresAt: now + ttl }
    this.byKey.set(EvalRouteRegistry.key(appId, openId), entry)
    return entry
  }

  /** 同步领取（防同拍双 claim）：命中且未过期 ⇒ 移除并返回；否则 null。 */
  take (appId, openId, now = Date.now()) {
    const k = EvalRouteRegistry.key(appId, openId)
    const e = this.byKey.get(k)
    if (!e) return null
    this.byKey.delete(k)
    if (now - 0 >= e.expiresAt) return null   // 过期＝领取失败（条目已删，不回灌）
    return e
  }

  /** 失败降级时放回（保留原 expiresAt，TTL 兜底自然清）。 */
  reinsert (entry) {
    if (!entry || !entry.appId || !entry.openId) return false
    this.byKey.set(EvalRouteRegistry.key(entry.appId, entry.openId), entry)
    return true
  }

  peek (appId, openId, now = Date.now()) {
    const e = this.byKey.get(EvalRouteRegistry.key(appId, openId))
    return (e && now < e.expiresAt) ? e : null
  }

  size () { return this.byKey.size }
}

/**
 * 端点白名单：默认仅本机回环（生产形态＝a4 与 v2 同机，127.0.0.1:8703）。
 * env `FEISHU_ROUTE_ENDPOINT_ALLOWLIST`（逗号分隔 `host` 或 `host:port`）可扩；
 * 解析失败/空串的 URL 一律拒（fail-closed，不猜）。
 */
export function isAllowedEndpoint (rawUrl, allowlistEnv = process.env.FEISHU_ROUTE_ENDPOINT_ALLOWLIST) {
  let u
  try { u = new URL(String(rawUrl || '')) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return true
  const list = String(allowlistEnv || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const hp = host + ':' + String(u.port || '')
  return list.some((ent) => ent === host || ent === hp)
}

/**
 * 校验 inject-context 载荷里的 route 声明。
 * 返回 {ok:true, route:{endpoint,token,ttlMs}} 或 {ok:false, reason}（reason 可直接落日志，不含 token）。
 */
export function sanitizeRoutePayload (body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'body-not-object' }
  const endpoint = typeof body.route_endpoint === 'string' ? body.route_endpoint.trim() : ''
  if (!endpoint) return { ok: false, reason: 'route_endpoint missing' }
  if (endpoint.length > ENDPOINT_MAX) return { ok: false, reason: 'route_endpoint too long' }
  const token = typeof body.route_token === 'string' ? body.route_token.trim() : ''
  if (!token) return { ok: false, reason: 'route_token missing' }
  if (token.length > TOKEN_MAX) return { ok: false, reason: 'route_token too long' }
  let ttlS = Number(body.route_ttl_s)
  if (!Number.isFinite(ttlS) || ttlS <= 0) ttlS = DEFAULT_TTL_MS / 1000
  const ttlMs = Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, ttlS * 1000))   // 夹进 [60s, 7d]
  return { ok: true, route: { endpoint, token, ttlMs } }
}

/**
 * 调 v2 evaluation_chat（POST {token, sender_open_id, text}）。
 * 返回 {ok:true, reply}（HTTP 200 且 body.ok===true；reply 已 trim）或 {ok:false, status|err}。
 * 不抛——网络/超时/坏 JSON 全部落 {ok:false, err}（调用侧据此降级留痕）。
 */
export function callEvalChat (entry, openId, text, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(entry.endpoint) } catch { return resolve({ ok: false, err: 'bad endpoint url' }) }
    const payload = JSON.stringify({
      token: entry.token,
      sender_open_id: String(openId || ''),
      text: String(text || '').slice(0, TEXT_MAX),
    })
    const req = http.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: timeoutMs },
      (res) => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { buf += c; if (buf.length > 65536) req.destroy() })
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode })
          let data = null
          try { data = JSON.parse(buf) } catch { return resolve({ ok: false, err: 'bad json' }) }
          if (!data || data.ok !== true) return resolve({ ok: false, err: 'endpoint ok=false', status: 200 })
          resolve({ ok: true, reply: String(data.reply == null ? '' : data.reply).trim() })
        })
      })
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', (e) => resolve({ ok: false, err: String((e && e.message) || e).slice(0, 120) }))
    req.end(payload)
  })
}

/**
 * 三态决策（纯函数，接线侧与自测共用）：
 *   ok＋非空 reply ⇒ {hijack:true,  consume:true}                 回执用户，消费登记
 *   ok＋空 reply   ⇒ {hijack:false, consume:true}                 v2 无话可说（无待答轮次）⇒ 原对话，消费登记
 *   !ok            ⇒ {hijack:false, consume:false, degrade:true}  端点失败 ⇒ 原对话＋留痕，登记放回
 */
export function decideRouteAction (callResult) {
  if (!callResult || callResult.ok !== true) {
    return { hijack: false, consume: false, degrade: true }
  }
  const reply = String(callResult.reply || '').trim()
  return reply
    ? { hijack: true, consume: true, reply }
    : { hijack: false, consume: true }
}

// ───────────────────────────────────────────────────────────────────────────
// 自测：`node evalchat-route.mjs --selftest`
// 替身端点＝127.0.0.1 随机端口 stub（?case=ok|empty|err|badjson|flaky）；
// 三例（正例劫持 / 非登记不劫持 / 失败降级）＋登记校验与边界。测完即杀进程，不留监听。
// ───────────────────────────────────────────────────────────────────────────
export function selftest () {
  let pass = 0; let fail = 0
  const ok = (c, label) => { if (c) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label) } }

  // —— 替身 evaluation_chat：记录收到的 body，按 ?case= 出不同回应 ——
  const seen = []
  const server = http.createServer((req, res) => {
    let buf = ''
    req.on('data', (c) => { buf += c })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(buf) } catch { /* badjson 由 case 出 */ }
      seen.push({ url: req.url, body })
      const cs = new URL(req.url, 'http://127.0.0.1').searchParams.get('case') || 'ok'
      if (cs === 'err') { res.writeHead(500); return res.end('boom') }
      if (cs === 'badjson') { res.writeHead(200); return res.end('{not json') }
      if (cs === 'falseok') { res.writeHead(200); return res.end(JSON.stringify({ ok: false })) }
      if (cs === 'empty') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, reply: '' })) }
      if (cs === 'slow') { res.writeHead(200); return setTimeout(() => res.end(JSON.stringify({ ok: true, reply: 'late' })), 300) }
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, reply: '已收到您的文字评价并记录，谢谢！' }))
    })
  })

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  return new Promise((done) => {
    server.listen(0, '127.0.0.1', async () => {
      const base = 'http://127.0.0.1:' + server.address().port + '/tool/evaluation_chat'
      const appId = 'cli_test_app'
      const ou = 'ou_interviewer_1'
      const entry = { appId, openId: ou, endpoint: base + '?case=ok', token: 'tok-secret', tag: 'a4ask-1' }

      console.log('── 1) 正例：登记→领取→端点非空回复 ⇒ 劫持回执＋消费 ——')
      const reg = new EvalRouteRegistry()
      reg.register({ appId, openId: ou, endpoint: entry.endpoint, token: 'tok-secret', tag: 'a4ask-1' })
      const got = reg.take(appId, ou)
      ok(Boolean(got) && got.tag === 'a4ask-1', 'take 命中登记（同步领取）')
      const r1 = await callEvalChat(got, ou, '表达力强，专业扎实')
      const a1 = decideRouteAction(r1)
      ok(r1.ok === true && a1.hijack === true && a1.consume === true, '端点非空回复 ⇒ hijack＋consume')
      ok(a1.reply === '已收到您的文字评价并记录，谢谢！', '回执文本＝v2 reply 原文（「已记录」闭环）')
      ok(seen.length === 1 && seen[0].body.sender_open_id === ou
        && seen[0].body.token === 'tok-secret' && seen[0].body.text === '表达力强，专业扎实',
        '端点收到桥侧真值 sender_open_id＋token＋用户原话')

      console.log('── 2) 反例：未登记/非本 app/过期 ⇒ 不劫持（take=null，消息走原对话） ——')
      ok(reg.take(appId, ou) === null, '已消费后 take=null（不重复劫持）')
      ok(reg.take(appId, 'ou_stranger') === null, '未登记 open_id ⇒ null（非面试官不劫持）')
      ok(reg.take('cli_other_app', ou) === null, '同 ou 异 app ⇒ null（open_id 应用视角隔离）')
      const reg2 = new EvalRouteRegistry()
      reg2.register({ appId, openId: ou, endpoint: entry.endpoint, token: 't', ttlMs: TTL_MIN_MS })
      await sleep(30)
      ok(reg2.take(appId, ou, Date.now() + TTL_MIN_MS + 1000) === null, 'TTL 过期 ⇒ null（窗口外不劫持）')

      console.log('── 3) 反例：端点失败/超时/坏响应 ⇒ 降级原对话＋登记放回 ——')
      const rErr = await callEvalChat({ ...entry, endpoint: base + '?case=err' }, ou, 'x')
      const aErr = decideRouteAction(rErr)
      ok(rErr.ok === false && aErr.hijack === false && aErr.degrade === true,
        'HTTP 500 ⇒ 不劫持＋degrade（消息回原 agent 链）')
      const rBad = await callEvalChat({ ...entry, endpoint: base + '?case=badjson' }, ou, 'x')
      ok(rBad.ok === false && decideRouteAction(rBad).degrade === true, '坏 JSON ⇒ 失败降级')
      const rFalse = await callEvalChat({ ...entry, endpoint: base + '?case=falseok' }, ou, 'x')
      ok(rFalse.ok === false, 'body.ok=false（如 bad token）⇒ 失败降级')
      const rRefuse = await callEvalChat({ ...entry, endpoint: 'http://127.0.0.1:1/tool/evaluation_chat' }, ou, 'x')
      ok(rRefuse.ok === false && rRefuse.err, '拒连 ⇒ 失败降级（err=' + rRefuse.err + '）')
      const rTmo = await callEvalChat({ ...entry, endpoint: base + '?case=slow' }, ou, 'x', { timeoutMs: 30 })
      ok(rTmo.ok === false, '超时（慢响应替身 300ms＞30ms 窗）⇒ 失败降级（不卡面试官消息）')
      const keep = new EvalRouteRegistry()
      const eKeep = keep.register({ appId, openId: 'ou_r', endpoint: entry.endpoint, token: 't' })
      const taken = keep.take(appId, 'ou_r')
      ok(Boolean(taken), '领取成功待放回')
      keep.reinsert(taken)
      ok(keep.peek(appId, 'ou_r') === eKeep && keep.take(appId, 'ou_r').tag === eKeep.tag,
        'reinsert 后可再领取（失败不丢登记，TTL 兜底）')

      console.log('── 4) 登记面校验：route 载荷与端点白名单 fail-closed ——')
      ok(sanitizeRoutePayload({}).ok === false, '缺 route_endpoint ⇒ 拒登记')
      ok(sanitizeRoutePayload({ route_endpoint: base, route_token: '' }).ok === false, '缺 route_token ⇒ 拒登记')
      ok(sanitizeRoutePayload({ route_endpoint: 'x'.repeat(600), route_token: 't' }).ok === false,
        'endpoint 超长 ⇒ 拒登记')
      const sv = sanitizeRoutePayload({ route_endpoint: base + '?case=ok', route_token: ' t1 ', route_ttl_s: 'abc' })
      ok(sv.ok === true && sv.route.token === 't1' && sv.route.ttlMs === DEFAULT_TTL_MS,
        '合法载荷：token 去空白、非数字 ttl 落默认 72h')
      ok(sanitizeRoutePayload({ route_endpoint: base, route_token: 't', route_ttl_s: 999999999 }).route.ttlMs === TTL_MAX_MS,
        'ttl 封顶 7d（防万年登记）')
      ok(isAllowedEndpoint('http://127.0.0.1:8703/tool/evaluation_chat'), '回环 127.0.0.1 ⇒ 白名单内')
      ok(isAllowedEndpoint('http://localhost:8703/x'), 'localhost ⇒ 白名单内')
      ok(!isAllowedEndpoint('http://evil.example.com/tool/evaluation_chat'), '外域 ⇒ 拒（fail-closed）')
      ok(!isAllowedEndpoint('ftp://127.0.0.1/x'), '非 http(s) ⇒ 拒')
      ok(!isAllowedEndpoint('http://10.0.0.5:8703/x'), '内网非回环 ⇒ 默认拒')
      ok(isAllowedEndpoint('http://10.0.0.5:8703/x', '10.0.0.5:8703'), 'env 白名单命中 host:port ⇒ 放行')
      ok(!isAllowedEndpoint('http://10.0.0.9:8703/x', '10.0.0.5:8703'), 'env 白名单未命中 ⇒ 拒')

      console.log('── 5) 接线形态模拟（index.js 挂点同构）：三态全链 ——')
      const sent = []
      let fellBack = 0
      const fakeHandleInbound = () => { fellBack++ }
      const wire = async (registry, botAppId, senderOu, text) => {
        const e = registry.take(botAppId, senderOu)
        if (!e) { fakeHandleInbound(); return 'pass-through' }
        const r = await callEvalChat(e, senderOu, text)
        const a = decideRouteAction(r)
        if (a.hijack) { sent.push(a.reply); return 'receipt' }
        if (a.consume) { fakeHandleInbound(); return 'stale-drop' }
        registry.reinsert(e); fakeHandleInbound(); return 'degrade'
      }
      const w = new EvalRouteRegistry()
      w.register({ appId, openId: ou, endpoint: base + '?case=ok', token: 't', tag: 'a4ask-9' })
      ok((await wire(w, appId, ou, '诚意足')) === 'receipt' && sent.length === 1, '正例全链＝回执（不进 agent 链）')
      ok((await wire(w, appId, ou, '再回一句')) === 'pass-through' && fellBack === 1, '消费后＝原对话（非面试官同构）')
      w.register({ appId, openId: 'ou_empty', endpoint: base + '?case=empty', token: 't' })
      ok((await wire(w, appId, 'ou_empty', '你好')) === 'stale-drop' && fellBack === 2,
        '空回复＝不劫持走原对话＋消费登记')
      w.register({ appId, openId: 'ou_down', endpoint: base + '?case=err', token: 't' })
      ok((await wire(w, appId, 'ou_down', '评价…')) === 'degrade' && fellBack === 3 && w.peek(appId, 'ou_down'),
        '失败＝降级原对话＋登记保留（留痕面由 index.js 日志行承担）')

      server.close()
      console.log('')
      console.log('自测通过 ' + pass + ' ｜ 失败 ' + fail)
      done(fail === 0 ? 0 : 1)
    })
  })
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (invokedDirectly && process.argv.includes('--selftest')) {
  selftest().then((code) => process.exit(code))
}
