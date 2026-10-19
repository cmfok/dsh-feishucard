// #560 续段自测（2026-10-19）——只依赖 Node 内建模块，不启桥本体。
// 方法：从 index.js **原文**抽出真实的 DM 常量区 + defaultSelectionMatches + verifyDefaultModelLanded
// 源码，用 new Function 注入假 ctx（agentDefaultModel 假服务）后直测（不是抄副本）；
// 另做源码级静态断言（HMR 嵌套重试标记存在）。全绿 exit 0；任何一条失败 exit 1。
//
// 覆盖的故障史（同链路三进宫）：
//   #124（10-07 切换假成功）→ #560（10-13 新会话注入不稳）→ 10-19 直存撞 HMR 嵌套事务。
// 用例 A：直存第一次撞「transactions cannot be nested」被拒 → 退避重试第二次落地 ⇒ persisted=true 且 saveSelection 恰好调 2 次。
// 用例 B：直存报非 HMR 错 → 不重试（saveSelection 只调 1 次）⇒ persisted=false，错误如实带回。
// 用例 C：静态断言——源码含退避重试标记 + 退避常量定义。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(root, 'index.js'), 'utf8')

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('[PASS] ' + name) }
  else { fail += 1; console.log('[FAIL] ' + name + (detail ? ' —— ' + detail : '')) }
}

// ---- 从源码原文抽取被测区块 ---------------------------------------------------
const start = src.indexOf('  const DM_LAND_POLL_TRIES')
const end = src.indexOf('  function modelSwitchReceipt')
ok('S0 抽取标记存在（DM 区块）', start >= 0 && end > start,
  'start=' + start + ' end=' + end)
const snippet = start >= 0 && end > start ? src.slice(start, end) : ''
const factory = snippet
  ? new Function('ctx', snippet + '\nreturn { verifyDefaultModelLanded };')
  : null

function makeCtx(dm) { return { get: (key) => (key === 'agentDefaultModel' ? dm : null) } }

// ---- 用例 A：HMR 嵌套拒收 → 退避重试 → 落地 -----------------------------------
if (factory) {
  let saveCount = 0
  let landed = false
  const dmA = {
    currentSelection() { return landed ? { provider: 'zai', model: 'glm-5.3-flash' } : { provider: 'zai', model: 'GLM-4.5-Air' } },
    async saveSelection() {
      saveCount += 1
      if (saveCount === 1) throw new Error('HMR transactions cannot be nested')
      landed = true
    },
  }
  const t0 = Date.now()
  const resA = await factory(makeCtx(dmA)).verifyDefaultModelLanded('zai', 'glm-5.3-flash')
  ok('A1 撞HMR嵌套后重试落地', resA.persisted === true, JSON.stringify(resA))
  ok('A2 saveSelection 恰好调 2 次', saveCount === 2, 'saveCount=' + saveCount)
  ok('A3 走的是直存落地路径', /直存/.test(resA.persistDetail), resA.persistDetail)
  ok('A4 总耗时有界（<15s，A19）', Date.now() - t0 < 15000, String(Date.now() - t0) + 'ms')
} else {
  ok('A0 抽取成功才能跑用例A', false)
}

// ---- 用例 B：非 HMR 报错不重试 -------------------------------------------------
if (factory) {
  let saveCount = 0
  const dmB = {
    currentSelection() { return { provider: 'zai', model: 'GLM-4.5-Air' } },
    async saveSelection() { saveCount += 1; throw new Error('boom: 保存队列炸了') },
  }
  const resB = await factory(makeCtx(dmB)).verifyDefaultModelLanded('zai', 'glm-5.3-flash')
  ok('B1 非 HMR 错不落地（如实带回）', resB.persisted === false, JSON.stringify(resB))
  ok('B2 只调 1 次不重试', saveCount === 1, 'saveCount=' + saveCount)
  ok('B3 错误原文进 persistDetail', /boom: 保存队列炸了/.test(resB.persistDetail), resB.persistDetail)
} else {
  ok('B0 抽取成功才能跑用例B', false)
}

// ---- 用例 C：源码级静态断言 -----------------------------------------------------
ok('C1 源码含 HMR 嵌套重试标记', /transactions cannot be nested/i.test(snippet))
ok('C2 源码含退避常量', snippet.includes('DM_HMR_RETRY_BACKOFF_MS = 1500'))

console.log('----')
console.log('PASS=' + pass + ' FAIL=' + fail)
process.exit(fail > 0 ? 1 : 0)
