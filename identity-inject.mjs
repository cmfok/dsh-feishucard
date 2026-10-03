/**
 * identity-inject.mjs —— D5「身份注入」内核（ESM 版，插件仓库内可 import）
 *
 * 来源：`P:\Qoder\work\output\g9-identity\identity-inject.js`（已自证 18/18），
 *       本文件只是把导出方式换成 ESM（本仓库是 `export function apply` 的 ESM 插件）。
 *
 * 规格依据：NODE1 v3 §2.5
 *   · 入站：handleInbound 取 event.sender.sender_id.open_id → resolveActor → 存【本轮上下文】
 *   · 工具：ctx.on('tools/execute') 把 agent 传来的任何身份字段【覆写】成该 actor
 *
 * 🔴 安全边界（CM 2026-10-04 亲自定，三条）：
 *   1. **身份识别不发审批卡**（"你是谁"不问 CM；"你能看什么"才问）
 *   2. **认不出不弹卡片、不问姓名** —— AI 自己解决（CM 原话：
 *      「不弹卡片啊，你现在都不会认不出人，而且这个链路已经通了，应该直接 ai 处理啊，
 *        为什么还是想着人来介入」）
 *   3. **表不可达 ≠ 认不出** —— 前者是基础设施问题（例：本机没有 /opt/scripts/G9/），
 *      **必须降级放行**，否则一上线就把本机所有工具锁死（事故级）。
 *
 * 自测：`node identity-inject.mjs --selftest`
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** actor 里允许/必须被覆写的身份字段（白名单，规格 §2.5 定死） */
export const IDENTITY_KEYS = Object.freeze([
  'name', 'open_id', 'union_id', 'person_id',
  'level', 'category', 'scopes', 'channels', 'grants', 'source',
])

/** 默认表路径（服务器）；可用环境变量 MAILBOX_IDENTITY_MAP 覆盖 */
export const DEFAULT_MAP_PATH = '/opt/scripts/G9/identity_map.json'
/** 默认 resolver 路径（服务器）；可用 node --experimental 无关，纯 python 脚本调用 */
export const DEFAULT_RESOLVER_PATH = '/opt/scripts/G9/resolve_actor.py'

// ───────────────────────────────────────────────────────────────────────────
// 1) 本轮上下文：索引 agentId；`(chat_id, message_id)` 作溯源字段
//    ⚠️ 只活在内存，**不掺进 bot.chats / persistChats**（那是 per-chat 的持久结构）
// ───────────────────────────────────────────────────────────────────────────
export class TurnIdentityStore {
  constructor ({ ttlMs = 30 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs
    this.byAgent = new Map()
  }

  set (agentId, { actor, chatId, messageId, tableOk }) {
    this.byAgent.set(String(agentId), {
      actor: actor || null,
      chatId: chatId || '',
      messageId: messageId || '',
      tableOk: tableOk !== false,
      at: Date.now(),
    })
  }

  get (agentId, now = Date.now()) {
    const rec = this.byAgent.get(String(agentId))
    if (!rec) return null
    if (now - rec.at > this.ttlMs) { this.byAgent.delete(String(agentId)); return null }
    return rec
  }

  clear (agentId) { this.byAgent.delete(String(agentId)) }
  size () { return this.byAgent.size }
}

// ───────────────────────────────────────────────────────────────────────────
// 2) 覆写逻辑（纯函数 —— 单测主战场）
//    · 只碰 IDENTITY_KEYS，不动其它入参（不误伤工具）
//    · agent 传了、actor 也有的 ⇒ 以 actor 为准
//    · agent 传了、actor **没有**的 ⇒ **删除**（不许用 actor 里没有的字段绕过）
//    · agent 没传的 ⇒ **不新增**
// ───────────────────────────────────────────────────────────────────────────
export function applyActorToArguments (args, actor, keys = IDENTITY_KEYS) {
  const overwritten = []
  const dropped = []
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { args, overwritten, dropped, reason: 'arguments-not-an-object' }
  }
  if (!actor || typeof actor !== 'object') {
    return { args, overwritten, dropped, reason: 'no-actor' }
  }
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(args, k)) continue
    const has = Object.prototype.hasOwnProperty.call(actor, k) && actor[k] !== undefined && actor[k] !== null
    if (has) {
      if (args[k] !== actor[k]) overwritten.push(k)
      args[k] = actor[k]
    } else {
      delete args[k]
      dropped.push(k)
    }
  }
  return { args, overwritten, dropped, reason: null }
}

// ───────────────────────────────────────────────────────────────────────────
// 3) 🔴「无 actor 怎么办」—— 把规格没写清的边界做成纯函数
//
//    hasOwner=false（GUI／子代理／定时轮）        ⇒ pass-through（**不许锁死 GUI**）
//    hasOwner=true ＋ actor                      ⇒ overwrite
//    hasOwner=true ＋ 无 actor ＋ 表可达          ⇒ deny（**这才是要拦的**）
//    hasOwner=true ＋ 无 actor ＋ **表不可达**    ⇒ pass-through ＋ 记警告
//        ↑ 这一条是安全阀：表不在本机（例：家里的 dsh 没有 /opt/scripts/G9/）时，
//          "拿不到 actor" 是**基础设施问题**，不是我方身份问题 ⇒ 拒绝会锁死整机。
// ───────────────────────────────────────────────────────────────────────────
export function decideAction ({ hasOwner, actor, tableOk = true }) {
  if (!hasOwner) return 'pass-through'
  if (actor) return 'overwrite'
  if (!tableOk) return 'pass-through'
  return 'deny'
}

// ───────────────────────────────────────────────────────────────────────────
// 4) 跨语言：resolveActor 是 Python，插件是 Node
//    只在【入站】调一次（不是每次工具调用）＋ 进程内缓存（按 open_id）
//    失败一律返回 { actor:null, err }，**绝不抛**（一条消息失败不该影响整机）
// ───────────────────────────────────────────────────────────────────────────
export function makeResolver ({ mapPath = process.env.MAILBOX_IDENTITY_MAP || DEFAULT_MAP_PATH,
                              resolverPath = process.env.MAILBOX_RESOLVER || DEFAULT_RESOLVER_PATH,
                              python = 'python3', timeoutMs = 8000 } = {}) {
  const cache = new Map()
  let cachedTableMtime = null

  function tableOk () {
    try { return fs.statSync(mapPath).isFile() } catch { return false }
  }

  return {
    mapPath,
    tableOk,
    resolve (openId) {
      if (!openId) return { actor: null, err: 'no_open_id', tableOk: tableOk() }
      if (!tableOk()) return { actor: null, err: 'map_unavailable', tableOk: false }
      if (!fs.existsSync(resolverPath)) return { actor: null, err: 'resolver_missing', tableOk: true }
      // 表换了（mtime 变）⇒ 清缓存，避免"旧身份"
      try {
        const mt = fs.statSync(mapPath).mtimeMs
        if (cachedTableMtime !== null && mt !== cachedTableMtime) cache.clear()
        cachedTableMtime = mt
      } catch { /* 读不到 mtime 就用旧缓存 */ }
      if (cache.has(openId)) return { ...cache.get(openId), tableOk: true }
      const code = [
        'import json,sys',
        'sys.path.insert(0, sys.argv[1])',
        'from resolve_actor import resolveActor',
        'm = json.load(open(sys.argv[2], encoding="utf-8-sig"))',
        'a, e = resolveActor(sys.argv[3], m)',
        'print(json.dumps({"actor": a, "err": e}, ensure_ascii=False))',
      ].join('\n')
      let out
      try {
        const r = spawnSync(python, ['-c', code, path.dirname(resolverPath), mapPath, openId],
          { encoding: 'utf8', timeout: timeoutMs })
        out = String(r.stdout || '').trim()
      } catch (e) {
        return { actor: null, err: 'resolver_failed:' + String(e && e.message || e).slice(0, 60), tableOk: true }
      }
      const i = out.lastIndexOf('{')
      if (i < 0) return { actor: null, err: 'resolver_no_json', tableOk: true }
      let d
      try { d = JSON.parse(out.slice(i)) } catch { return { actor: null, err: 'resolver_bad_json', tableOk: true } }
      const res = { actor: d.actor || null, err: d.err || null, tableOk: true }
      cache.set(openId, res)
      return res
    },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 自测（`node identity-inject.mjs --selftest`）—— 与 resolve_actor.py 一样"自带自测"
// ───────────────────────────────────────────────────────────────────────────
export function selftest () {
  let pass = 0; let fail = 0
  const ok = (c, label) => { if (c) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label) } }

  console.log('── 1) decideAction：无 actor 的边界 ──')
  ok(decideAction({ hasOwner: false, actor: null }) === 'pass-through', '非飞书会话（无 owner）⇒ 放行（不许把 GUI/子代理锁死）')
  ok(decideAction({ hasOwner: true, actor: { name: 'x' } }) === 'overwrite', '有 owner ＋ 有 actor ⇒ 覆写')
  ok(decideAction({ hasOwner: true, actor: null }) === 'deny', '有 owner ＋ 无 actor ＋ 表可达 ⇒ 拒绝（fail-closed 的真正作用域）')
  ok(decideAction({ hasOwner: true, actor: null, tableOk: false }) === 'pass-through',
    '🔴 有 owner ＋ 无 actor ＋ **表不可达** ⇒ 放行（安全阀：表不在本机时不许锁死整机）')

  console.log('── 2) applyActorToArguments：核心自证「塞别人身份必被覆写」──')
  const actor = { name: '陈明', open_id: 'ou_cm', union_id: 'on_cm', scopes: ['公司'] }
  const evil = { name: '老板', open_id: 'ou_boss', scopes: ['全部'], query: 'SELECT 1' }
  const r1 = applyActorToArguments(evil, actor)
  ok(evil.name === '陈明', '① 伪造的 name 被覆写')
  ok(evil.open_id === 'ou_cm', '① 伪造的 open_id 被覆写')
  ok(JSON.stringify(evil.scopes) === JSON.stringify(['公司']), '① 伪造的 scopes 被覆写')
  ok(evil.query === 'SELECT 1', '① 非身份字段（query）原样保留 —— 不误伤工具入参')
  ok(r1.overwritten.sort().join(',') === 'name,open_id,scopes', '① 覆写清单准确：' + r1.overwritten.sort().join(','))

  console.log('── 3) 边界：删除权 / 不新增 / 非对象 ──')
  const evil2 = { name: '陈明', secret_grant: 'super' }
  applyActorToArguments(evil2, actor, ['name', 'secret_grant'])
  ok(evil2.secret_grant === undefined, '② actor 没有的白名单字段 ⇒ 删除（不许绕过）')
  const minimal = { query: 'x' }
  applyActorToArguments(minimal, actor)
  ok(!('name' in minimal), '③ agent 没传的身份字段 ⇒ 不新增（最小惊讶）')
  ok(applyActorToArguments('nope', actor).reason === 'arguments-not-an-object', '④ 非对象 arguments ⇒ 安全返回，不抛')
  ok(applyActorToArguments({ name: 'x' }, null).reason === 'no-actor', '⑤ 无 actor ⇒ 不动入参')

  console.log('── 4) TurnIdentityStore ──')
  const st = new TurnIdentityStore({ ttlMs: 1000 })
  st.set('agent-1', { actor, chatId: 'oc_1', messageId: 'om_1' })
  const rec = st.get('agent-1')
  ok(rec && rec.actor.name === '陈明', '存/取正常')
  ok(rec.chatId === 'oc_1' && rec.messageId === 'om_1', '规格要的 (chat_id, message_id) 作溯源字段保留')
  ok(st.get('agent-1', Date.now() + 5000) === null, '过期即视为"无 actor"')
  ok(st.size() === 0, '过期读取顺手清理，不泄漏')

  console.log('── 5) resolver：失败必须返回错误、不抛 ──')
  const r = makeResolver({ mapPath: '/nonexistent/identity_map.json' })
  ok(r.resolve('ou_x').err === 'map_unavailable', '表不存在 ⇒ map_unavailable（且 tableOk=false ⇒ 上层放行）')
  ok(r.resolve('').err === 'no_open_id', '空 open_id ⇒ no_open_id')

  console.log('')
  console.log('自测通过 ' + pass + ' ｜ 失败 ' + fail)
  return fail === 0 ? 0 : 1
}

// 直接 `node identity-inject.mjs --selftest` 时跑自测（被 import 时不跑）
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
if (invokedDirectly) {
  if (process.argv.includes('--selftest')) process.exit(selftest())
  console.log('用法：node identity-inject.mjs --selftest')
}
