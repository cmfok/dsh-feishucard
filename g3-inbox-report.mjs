// g3-inbox-report.mjs — G3 员工会话「工具调用失败」接入收件箱（#514 / D38=H-D95 路径A）
// 纯逻辑模块，独立自测：`node g3-inbox-report.mjs --selftest`
// index.js 只在 scanCard 的 tool/result failed 分支调 reportG3Failure()，复用现有 300ms
// 扫描（CARD_POLL_INTERVAL），不新增轮询、不注册任何 agent 工具（员工面零命令能力）。
//
// 接口契约：AIAD/G10-收件箱/INTERFACE.md I3-G3 ＋ WO-38（接口约定单）：
//   只投 H-D2 六个脱敏元数据（agent/tool/occurred_at/exit_status/error_category/short_summary），
//   不带会话正文、工具参数、凭证；脱敏/五段详情/0600/冷却合并/fallback 由 G10 受控入口
//   inbox_signal.py::post_g3_failure 统一负责（经 G3 侧 wrapper 调用，spawn 细节见 index.js）。
//
// 🔴 默认零触发（D38：核定前不接生产、不改权限，其他 bot 写入为零）：
//   - AIAD_G3_REPORT_CWD_ALLOW 未注入（空）⇒ 永不触发 —— 本机桥/其他 workspace 一个字节都不写；
//   - AIAD_INBOX_ROOT 未注入 ⇒ 永不投递 —— 生产根目录由启动配置显式给，代码不给默认值；
//   - AIAD_G3_REPORT_WRAPPER 未注入 ⇒ 不 spawn（只在日志留一行"未接线"）。
//   三者均由生产启动配置（G11 审批批后）一并注入。

import { execFile } from 'node:child_process'

// 与 G10 inbox_signal.py 的 redact 同源的三条正则（JS 侧先粗防一道，入口侧还会再脱敏）。
const SECRET_RE = /((?:authorization\s*[:=]\s*bearer\s+|access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|password|passwd|api[_-]?key|secret|token)\s*[:=]\s*)[^\s,;]+/gi
const SK_TOKEN_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g

const SUMMARY_MAX = 200          // short_summary 截断（入口侧还有自己的校验与脱敏）
const DEDUPE_WINDOW_MS = 60000   // 桥侧进程内防抖：同指纹 60s 内只 spawn 一次（入口侧另有分钟级冷却合并）

// 路径规范化：反斜杠→斜杠、去尾斜杠、trim —— 服务器 cwd 与白名单 env 的书写形态无关比较。
export function normalizeCwd (value) {
  const text = String(value || '').trim()
  if (!text) return ''
  let out = text.replace(/\\/g, '/')
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

// 错误归类（WO-38 枚举五类；工具调用失败只落两档）：
// 权限类命中 ⇒ 「权限被拒」——🔴 只归类，不改写、不重试、不自动申请权限（红线：自动加权限＝自涨权限）。
// 其余一律「失败-运行错」——不猜更细的分类（错误类型是开放集，环节字段才是有限集）。
const PERMISSION_HINT_RE = /permission\s*denied|access\s*denied|forbidden|\b403\b|权限不足|权限被拒|没有权限|无权限|拒绝访问/i
export function classifyError (errorText) {
  return PERMISSION_HINT_RE.test(String(errorText || '')) ? '权限被拒' : '失败-运行错'
}

export function redactShort (errorText) {
  let text = String(errorText || '')
  text = text.replace(/\s+/g, ' ').trim()
  text = text.replace(SECRET_RE, '$1[REDACTED]')
  text = text.replace(SK_TOKEN_RE, '[REDACTED]')
  text = text.replace(PHONE_RE, '[PHONE]')
  // 截断放在脱敏后：半截密钥比完整密钥更糟的不是泄露而是不可读，这里两者都不发生。
  return text.length > SUMMARY_MAX ? text.slice(0, SUMMARY_MAX) : text
}

function workspaceAllowList (raw) {
  const text = String(raw || '').trim()
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const values = JSON.parse(text)
      return Array.isArray(values) ? values.map(normalizeCwd).filter(Boolean) : []
    } catch {
      return []
    }
  }
  // POSIX uses ':'. Windows drive letters also contain ':', so Windows-style
  // lists must use ';' to keep each workspace exact.
  const separator = text.includes(';') ? ';' : ':'
  return text.split(separator).map(normalizeCwd).filter(Boolean)
}

// The bridge calls this before entering the report path; reportG3Failure()
// repeats the same check as a defense-in-depth gate for direct callers.
export function isG3OkrWorkspace ({ env, cwd }) {
  const allowList = workspaceAllowList((env || {}).AIAD_G3_REPORT_CWD_ALLOW)
  const normCwd = normalizeCwd(cwd)
  return Boolean(normCwd && allowList.includes(normCwd))
}

// 进程内防抖表：fp → 上次放行时刻。模块级单例 —— 多 bot 共用一个 Map 也按 fp 隔离，不串号。
const recentReports = new Map()

// 仅测试用：清空防抖表，保证 selftest 各组断言互不污染（插件运行期不会调用）。
export function resetG3DedupeForTest () { recentReports.clear() }

function cwdLeaf (cwd) {
  const norm = normalizeCwd(cwd)
  if (!norm) return ''
  const parts = norm.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

// 门禁＋组装（纯函数，可测）。返回 null = 本次不上报；非 null = 待投递 payload。
export function decideG3FailureReport ({ env, cwd, toolName, errorText, nowMs }) {
  const e = env || {}
  // 门禁 1：workspace 白名单 —— 「G3 精确 workspace 门禁」（D38），空 ⇒ 全局关闭。
  const normCwd = normalizeCwd(cwd)
  if (!isG3OkrWorkspace({ env: e, cwd: normCwd })) return null
  // 门禁 2：写入根 —— 生产由启动配置注入；代码不提供默认生产路径（I3-G3 契约）。
  const root = String(e.AIAD_INBOX_ROOT || '').trim()
  if (!root) return null

  const shortSummary = redactShort(errorText)
  // 防抖指纹：同 workspace＋同工具＋同症状前缀，窗口内只放行一次。
  const fp = normCwd + '|' + String(toolName || '') + '|' + shortSummary.slice(0, 80)
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  const last = recentReports.get(fp)
  if (Number.isFinite(last) && now - last < DEDUPE_WINDOW_MS) {
    recentReports.set(fp, now) // 窗口内滚动续期：持续失败的同一问题不反复 spawn
    return null
  }
  recentReports.set(fp, now)
  // 防表无界：只在写入时清理，量级天然小（白名单内 agent 数 × 工具数）。
  if (recentReports.size > 512) {
    for (const [k, t] of recentReports) {
      if (now - t >= DEDUPE_WINDOW_MS) recentReports.delete(k)
    }
  }

  return {
    agent: cwdLeaf(normCwd) || 'unknown',
    tool: String(toolName || 'tool'),
    occurredAt: new Date(now).toISOString(),
    exitStatus: 'failed',
    errorCategory: classifyError(errorText),
    shortSummary,
    root,
    fallback: String(e.AIAD_INBOX_FALLBACK || '').trim(),
  }
}

// index.js 唯一调用点：scanCard 的 tool/result failed 分支。
// 旁路语义：任何异常只 console.log，绝不向上抛 —— 卡片主链路一行都不能被它拖垮。
export function reportG3Failure (agent, tool, envOverride) {
  try {
    const env = envOverride || process.env
    const header = (agent && agent.session && agent.session.header) || {}
    const decision = decideG3FailureReport({
      env,
      cwd: header.cwd,
      toolName: String((tool && tool.name) || 'tool'),
      errorText: String((tool && tool.error) || ''),
      nowMs: Date.now(),
    })
    if (!decision) return
    const wrapper = String(env.AIAD_G3_REPORT_WRAPPER || '').trim()
    if (!wrapper) {
      console.log('[g3-inbox] 门禁命中但 AIAD_G3_REPORT_WRAPPER 未注入，跳过 spawn（未接线态）')
      return
    }
    const args = [
      wrapper,
      '--agent', decision.agent,
      '--tool', decision.tool,
      '--occurred-at', decision.occurredAt,
      '--exit-status', decision.exitStatus,
      '--error-category', decision.errorCategory,
      '--short-summary', decision.shortSummary,
    ]
    const childEnv = { ...env, AIAD_INBOX_ROOT: decision.root }
    if (decision.fallback) childEnv.AIAD_INBOX_FALLBACK = decision.fallback
    // 生产（Linux）默认 python3；本地 Windows 冒烟可注入 G3_REPORT_PYTHON=python。
    const pythonBin = String(env.G3_REPORT_PYTHON || '').trim() || 'python3'
    const child = execFile(pythonBin, args, { env: childEnv, timeout: 15000 }, (err, stdout) => {
      if (err) console.log('[g3-inbox] wrapper 非零退出: ' + String(err && err.message || err).slice(0, 200))
      else console.log('[g3-inbox] 已投递 ' + String(stdout || '').trim().slice(0, 80))
    })
    if (child && typeof child.unref === 'function') child.unref()
  } catch (e) {
    console.log('[g3-inbox] 上报旁路异常（不影响卡片主链路）: ' + String(e && e.message || e))
  }
}

// ---------------------------------------------------------------------------
// 自测（机器检查点，A42）：`node g3-inbox-report.mjs --selftest`
// ---------------------------------------------------------------------------
function selftest () {
  let failed = 0
  const ok = (cond, label) => {
    if (cond) { console.log('  [OK] ' + label) } else { failed += 1; console.log('  [FAIL] ' + label) }
  }
  const allow = '/srv/aiad/agents/analyst:/srv/aiad/agents/okr'
  const base = { env: { AIAD_G3_REPORT_CWD_ALLOW: allow, AIAD_INBOX_ROOT: '/opt/scripts/inbox' }, cwd: '/srv/aiad/agents/analyst', toolName: 'query_orders', errorText: 'boom', nowMs: 1000 }

  console.log('── 1) 默认零触发（其他 bot 写入为零的机器保证）──')
  ok(decideG3FailureReport({ ...base, env: {} }) === null, '白名单未注入 ⇒ null（全局关闭）')
  ok(decideG3FailureReport({ ...base, env: { AIAD_G3_REPORT_CWD_ALLOW: allow } }) === null, '白名单在但 INBOX_ROOT 未注入 ⇒ null（不接生产）')
  ok(decideG3FailureReport({ ...base, cwd: 'P:\\Qoder\\work' }) === null, '白名单在但 cwd 不在名单 ⇒ null（其他 workspace 零写入）')
  ok(decideG3FailureReport({ ...base, cwd: '' }) === null, 'cwd 拿不到 ⇒ null（fail-closed）')

  console.log('── 2) 命中与路径形态无关 ──')
  ok(decideG3FailureReport({ ...base, cwd: '/srv/aiad/agents/okr/' }) !== null, '白名单项带尾斜杠书写、cwd 命中 ⇒ 放行')
  const hit = decideG3FailureReport({ ...base, cwd: '\\srv\\aiad\\agents\\analyst' })
  ok(hit !== null, 'Windows 反斜杠 cwd 规范化后命中 ⇒ 放行')
  ok(hit && hit.agent === 'analyst', 'agent 名取 cwd 尾段')
  ok(hit && hit.exitStatus === 'failed' && hit.tool === 'query_orders' && hit.root === '/opt/scripts/inbox', 'payload 关键字段（exit_status/tool/root）')
  ok(decideG3FailureReport({ ...base, cwd: '/srv/aiad/agents/okr-extra' }) === null, 'workspace 前缀相似但非精确项 ⇒ 拒绝')
  ok(decideG3FailureReport({
    ...base,
    env: { ...base.env, AIAD_G3_REPORT_CWD_ALLOW: 'C:\\aiad\\okr;C:\\aiad\\other' },
    cwd: 'C:\\aiad\\okr',
  }) !== null, 'Windows 分号白名单保留盘符并精确命中')

  console.log('── 3) 归类：权限类只归类 ──')
  ok(classifyError('Permission denied: /opt/scripts/x') === '权限被拒', 'permission denied ⇒ 权限被拒')
  ok(classifyError('E103 权限不足，拒绝访问') === '权限被拒', '中文权限话术 ⇒ 权限被拒')
  ok(classifyError('connection reset by peer') === '失败-运行错', '普通错误 ⇒ 失败-运行错')
  const perm = decideG3FailureReport({ ...base, errorText: 'HTTP 403 Forbidden', nowMs: 2000 })
  ok(perm && perm.errorCategory === '权限被拒', 'payload 携带归类结果（不自动修，处置文案由入口固定）')

  console.log('── 4) 脱敏与截断 ──')
  const r = redactShort('token=abc123 secret=xyz789 sk-abcdefghijklmnop 手机 13812345678')
  ok(!/abc123|xyz789|abcdefghijklmnop/.test(r), '键值密钥/sk- 形态被遮')
  ok(!r.includes('13812345678'), '手机号被遮')
  ok(redactShort('x'.repeat(500)).length === 200, '超长截到 200')

  console.log('── 5) 桥侧防抖（入口冷却之外的第一道）──')
  resetG3DedupeForTest() // 前面各组已写入同一指纹，先清表保证「首次」的观测面干净
  ok(decideG3FailureReport(base) !== null, '首次放行')
  ok(decideG3FailureReport({ ...base, nowMs: 1000 + 59999 }) === null, '60s 内同指纹 ⇒ null')
  // 观测面注意（开发标准 §10.8）：上一条窗口内命中会滚动续期（last 被推到 60999），
  // 「过期」断言必须跳到续期时刻再过一个整窗口（≥ 60999+60000），否则必假红。
  ok(decideG3FailureReport({ ...base, nowMs: 1000 + 59999 + 60000 }) !== null, '窗口过期 ⇒ 放行')
  ok(decideG3FailureReport({ ...base, toolName: 'other_tool', nowMs: 1000 + 60002 }) !== null, '不同工具不互相误挡')

  if (failed) { console.log('SELFTEST FAIL: ' + failed + ' 条未过'); return 1 }
  console.log('SELFTEST ALL PASS')
  return 0
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('g3-inbox-report.mjs')
if (invokedDirectly) {
  if (process.argv.includes('--selftest')) process.exit(selftest())
  console.log('用法：node g3-inbox-report.mjs --selftest')
}
