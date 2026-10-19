// #1532/#1533 自测（2026-10-16）——只依赖 Node 内建模块，不启桥本体。
// 方法：从 index.js **原文**抽出真实的 fetchWithDeadline/httpJson/tokenDigest 源码，
// 用 new Function 以真实 fetch/AbortSignal/createHash 注入求值后直测（不是抄副本）；
// 另做源码级静态断言（无整串令牌直出日志、外呼全部走带时限包装器）。
// 全绿 exit 0；任何一条失败 exit 1。

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const srcPath = join(root, 'index.js')
const src = readFileSync(srcPath, 'utf8')

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('[PASS] ' + name) }
  else { fail += 1; console.log('[FAIL] ' + name + (detail ? ' —— ' + detail : '')) }
}

// ---- 从源码原文抽取被测函数 -------------------------------------------------
const httpStart = src.indexOf('  const HTTP_JSON_TIMEOUT_MS = 15000')
const httpEnd = src.indexOf('  function parseJson(text)')
ok('S0 抽取标记存在（HTTP 区块）', httpStart >= 0 && httpEnd > httpStart,
  'httpStart=' + httpStart + ' httpEnd=' + httpEnd)
const httpSnippet = httpStart >= 0 && httpEnd > httpStart ? src.slice(httpStart, httpEnd) : ''
const httpFactory = httpSnippet
  ? new Function('fetch', 'AbortSignal', httpSnippet
    + '\nreturn { httpJson, fetchWithDeadline, HTTP_JSON_TIMEOUT_MS, HTTP_UPLOAD_TIMEOUT_MS };')
  : null
const httpApi = httpFactory ? httpFactory(fetch, AbortSignal) : null

const tdStart = src.indexOf('  function tokenDigest(token) {')
const tdEnd = tdStart >= 0 ? src.indexOf('\n  }\n', tdStart) + 4 : -1
ok('S0 抽取标记存在（tokenDigest）', tdStart >= 0 && tdEnd > tdStart,
  'tdStart=' + tdStart + ' tdEnd=' + tdEnd)
const tdSnippet = tdStart >= 0 && tdEnd > tdStart ? src.slice(tdStart, tdEnd) : ''
const tdFactory = tdSnippet
  ? new Function('createHash', tdSnippet + '\nreturn { tokenDigest };')
  : null
const tokenDigest = tdFactory ? tdFactory(createHash).tokenDigest : null

// ---- 假慢服务器：接受连接但永不响应 ------------------------------------------
const slowServer = createServer(() => { /* 收下请求，一个字节都不回 */ })
await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', resolve))
const slowUrl = 'http://127.0.0.1:' + slowServer.address().port + '/hang'

// ---- 快服务器：立即响应（成功路径不破） --------------------------------------
const fastServer = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok') })
await new Promise((resolve) => fastServer.listen(0, '127.0.0.1', resolve))
const fastUrl = 'http://127.0.0.1:' + fastServer.address().port + '/fast'

// ---- T1：慢服务器 + 包装器超时（可在约定时限内失败，报文可识别） -------------
if (httpApi) {
  const t0 = Date.now()
  const res = await httpApi.httpJson(slowUrl, 'GET', {}, undefined, undefined, 1200)
  const elapsed = Date.now() - t0
  ok('T1 超时在约定时限内失败（约 1.2s）', res.status === 0 && elapsed >= 1100 && elapsed <= 4500,
    'status=' + res.status + ' elapsed=' + elapsed + 'ms text=' + String(res.text).slice(0, 120))
  ok('T1 超时报文含「超时」与 timeout 字样', /超时/.test(res.text) && /timeout/i.test(res.text),
    'text=' + String(res.text).slice(0, 160))
} else {
  ok('T1 超时在约定时限内失败（约 1.2s）', false, 'httpApi 未抽取到')
  ok('T1 超时报文含「超时」与 timeout 字样', false, 'httpApi 未抽取到')
}

// ---- T2：默认时限值与工单口径一致（从真实源码取值） ---------------------------
if (httpApi) {
  ok('T2 默认 15s / 上传 60s', httpApi.HTTP_JSON_TIMEOUT_MS === 15000
    && httpApi.HTTP_UPLOAD_TIMEOUT_MS === 60000,
    'json=' + httpApi.HTTP_JSON_TIMEOUT_MS + ' upload=' + httpApi.HTTP_UPLOAD_TIMEOUT_MS)
}

// ---- T3：成功路径不受影响 -----------------------------------------------------
if (httpApi) {
  const res = await httpApi.httpJson(fastUrl, 'GET', {}, undefined, undefined, 5000)
  ok('T3 快服务器正常返回 200', res.status === 200 && res.text === 'ok',
    'status=' + res.status + ' text=' + String(res.text).slice(0, 80))
}

// ---- T4：调用方 signal 的既有语义保留（自定义中止原因原样透传，不加超时前缀） --
if (httpApi) {
  const controller = new AbortController()
  const reason = new Error('card request timed out')
  controller.abort(reason)
  const res = await httpApi.httpJson(slowUrl, 'GET', {}, undefined, controller.signal, 60000)
  ok('T4 调用方中止原因原样透传', res.status === 0 && res.text === 'card request timed out',
    'text=' + String(res.text).slice(0, 120))
}

// ---- T5：fetchWithDeadline 裸包装器（上传链用的就是它）超时抛可识别错误 -------
if (httpApi) {
  let threw = null
  const t0 = Date.now()
  try { await httpApi.fetchWithDeadline(slowUrl, { method: 'POST' }, 1000) } catch (e) { threw = e }
  const elapsed = Date.now() - t0
  ok('T5 裸包装器按时限抛错（约 1s）', Boolean(threw) && elapsed >= 900 && elapsed <= 4000,
    'threw=' + Boolean(threw) + ' elapsed=' + elapsed + 'ms')
  ok('T5 裸包装器报文含「超时」字样', Boolean(threw) && /超时/.test(String(threw.message))
    && /timeout/i.test(String(threw.message)), 'msg=' + String(threw && threw.message).slice(0, 160))
}

// ---- T6：tokenDigest 摘要性质 -------------------------------------------------
if (tokenDigest) {
  const tokA = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
  const tokB = '11111111-2222-3333-4444-555555555555'
  const d1 = tokenDigest(tokA)
  const d2 = tokenDigest(tokA)
  const d3 = tokenDigest(tokB)
  const expect = createHash('sha256').update(tokA).digest('hex').slice(0, 10)
  ok('T6 同一 token 摘要稳定', d1 === d2 && d1 === expect,
    'd1=' + d1 + ' d2=' + d2 + ' expect=' + expect)
  ok('T6 摘要确为 sha256 前 10 位（8-12 区间）', d1 === expect && /^[0-9a-f]{10}$/.test(d1),
    'd1=' + d1)
  ok('T6 不可逆：不回显原文且不同 token 摘要不同',
    d1 !== tokA && !d1.includes(tokA.slice(0, 8)) && d1 !== d3 && d3 !== tokB,
    'd1=' + d1 + ' d3=' + d3)
} else {
  ok('T6 同一 token 摘要稳定', false, 'tokenDigest 未抽取到')
  ok('T6 摘要确为 sha256 前 10 位（8-12 区间）', false, 'tokenDigest 未抽取到')
  ok('T6 不可逆：不回显原文且不同 token 摘要不同', false, 'tokenDigest 未抽取到')
}

// ---- S1：静态断言——日志不再直出整串回调令牌 ---------------------------------
const fullTokenPatterns = [
  /token=' \+ token\)/,
  /token=' \+ value\.fs_[a-z_]+\)/,
  /token=' \+ record\.token\)/,
  /\(already settled\?\)' \+ token\)/,
  /String\(token\)\.slice\(0, 8\)\)/,
]
const patternHits = fullTokenPatterns.flatMap((re) => src.match(new RegExp(re.source, 'g')) || [])
ok('S1 旧的整串/截断令牌日志形态清零', patternHits.length === 0,
  '残留=' + JSON.stringify(patternHits.slice(0, 5)))
const digestCalls = (src.match(/tokenDigest\(/g) || []).length
ok('S1 令牌日志已全部换成摘要形态（定义 1 处 + 调用 ≥9 处）', digestCalls >= 10,
  'tokenDigest( 出现次数=' + digestCalls)

// ---- S2：静态断言——外呼全部带有限时限 ---------------------------------------
const bareFetches = (src.match(/await fetch\(/g) || []).length
const wrapperFetch = /return await fetch\(url, \{ \.\.\.options, signal \}\)/.test(src)
ok('S2 全文件仅剩包装器内 1 处裸 fetch', bareFetches === 1 && wrapperFetch,
  'await fetch( 数=' + bareFetches + ' 包装器形态=' + wrapperFetch)
const uploadWrapped = (src.match(/fetchWithDeadline\('https:\/\/open\.feishu\.cn\/open-apis\/im\/v1\/(images|files)'/g) || []).length
ok('S2 图片/文件上传走 60s 宽限包装器', uploadWrapped === 2
  && /HTTP_UPLOAD_TIMEOUT_MS = 60000/.test(src), '上传包装数=' + uploadWrapped)
const downloadWrapped = /fetchWithDeadline\(url,\s*\n\s*\{ headers: \{ Authorization: 'Bearer ' \+ token \} \}, HTTP_UPLOAD_TIMEOUT_MS\)/.test(src)
ok('S2 入站资源下载走有限时限包装器', downloadWrapped)
ok('S2 默认 15s 时限已定义', /HTTP_JSON_TIMEOUT_MS = 15000/.test(src))
ok('S2 超时失败报文带「超时」字样', /超时（timeout）/.test(src))

// ---- 收尾 ---------------------------------------------------------------------
slowServer.closeAllConnections && slowServer.closeAllConnections()
fastServer.closeAllConnections && fastServer.closeAllConnections()
slowServer.close()
fastServer.close()

console.log('')
console.log('==== selftest-timeout-token-20261016 结果：PASS ' + pass + ' / FAIL ' + fail + ' ====')
process.exit(fail === 0 ? 0 : 1)
