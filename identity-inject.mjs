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
 *   3. **表不可达 ＝ 认不出 ⇒ 拒**（fail-closed）。CM 原话：
 *      「**无表就拒应该是最好的，最稳的。因为你执行不了，总比资料泄露好吧**」。
 *      ⚠️ 本条原先写的是"表不可达**必须降级放行**" —— 那是**裁决之前**的旧口径；
 *      它留在这里会与下文「§3 无 actor 怎么办」的 fail-closed 说明**直接矛盾**，故删。
 *      **唯一仍然放行的**：这个回合**根本不是飞书来的**（GUI／子代理／定时轮）——
 *      否则会把本机自己锁死（2026-10-04 实测过一次）。
 *
 * 自测：`node identity-inject.mjs --selftest`
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** actor 里允许/必须被覆写的身份字段（白名单，规格 §2.5 定死） */
export const IDENTITY_KEYS = Object.freeze([
  'name', 'open_id', 'union_id', 'person_id',
  'level', 'category', 'scopes', 'channels', 'grants', 'source',
])

/** 默认表路径（服务器）；可用环境变量 MAILBOX_IDENTITY_MAP 覆盖 */
export const DEFAULT_MAP_PATH = '/opt/scripts/G9/identity_map.json'
/** 默认 resolver 路径（服务器）；可用环境变量 MAILBOX_RESOLVER 覆盖 */
export const DEFAULT_RESOLVER_PATH = '/opt/scripts/G9/resolve_actor.py'

/**
 * 资产（表 / resolver）路径解析 —— **一律【跟着工作区】走，不写死机器路径**（CM 2026-10-04 要求）。
 *
 * 候选顺序（取第一个存在的）：
 *   1. **环境变量**（`MAILBOX_IDENTITY_MAP` / `MAILBOX_RESOLVER`）—— 部署时覆盖用
 *   2. **服务器固定路径** `/opt/scripts/G9/…` —— 8 个员工 bot 的生产位置
 *   3. 🔑 **`<工作区>/output/g9-identity/…`** —— 任何开发机都成立：
 *        · HOME 工作区 `P:\Qoder\work`
 *        · CM-OFFICE 工作区 `D:\Work`
 *      ⇒ 因为表就放在**工作区里**，**Syncthing 会把它同步到各开发机** ⇒ **各机都不会被锁死**。
 *
 * ⚠️ **必须是"相对工作区"、不是"相对本文件"**：插件代码住在别人的仓库里
 *    （`Ai100/projects/dsh-feishucard/`），而**工作区根才是被同步的那一层**。
 * ⚠️ **也不写死盘符**（`P:` / `D:`）—— 两台开发机的盘符不同，写死等于只在其中一台上有效。
 */
export function assetCandidates (workspaceRoot, envName, serverPath, relPath) {
  const out = []
  const env = process.env[envName]
  if (env) out.push(env)
  out.push(serverPath)
  // ① 调用方给的工作区（最准）
  if (workspaceRoot) out.push(path.join(workspaceRoot, relPath))
  // ② 🔴 **从 cwd 逐级向上找** —— 不能只信调用方：
  //    2026-10-04 实测，`index.js` 的 `workspaceRoot()` 依赖 `ctx.get('sandboxPolicy')`，
  //    取不到就返回 `undefined` ⇒ 回退 `process.cwd()` ⇒ **那不是工作区** ⇒ 找不到表。
  //    逐级向上找（最多 6 层）能覆盖"cwd 在工作区子目录里"的各种情形。
  try {
    let d = process.cwd()
    for (let i = 0; i < 6 && d; i++) {
      out.push(path.join(d, relPath))
      const up = path.dirname(d)
      if (!up || up === d) break
      d = up
    }
  } catch { /* 取不到 cwd 就跳过这一级 */ }
  // ③ **已知工作区兜底**（两台开发机的实际位置；不写死单台 ⇒ 两台都能命中）
  for (const ws of ['P:/Qoder/work', 'D:/Work']) out.push(path.join(ws, relPath))
  return out
}

const MAP_REL = path.join('output', 'g9-identity', 'identity_map.json')
const RESOLVER_REL = path.join('output', 'g9-identity', 'resolve_actor.py')

export function mapCandidates (workspaceRoot) {
  return assetCandidates(workspaceRoot, 'MAILBOX_IDENTITY_MAP', DEFAULT_MAP_PATH, MAP_REL)
}
export function resolverCandidates (workspaceRoot) {
  return assetCandidates(workspaceRoot, 'MAILBOX_RESOLVER', DEFAULT_RESOLVER_PATH, RESOLVER_REL)
}

export function pickFrom (candidates, fallback) {
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c } catch { /* 试下一个 */ }
  }
  return candidates[0] || fallback
}

export function pickMapPath (workspaceRoot) {
  return pickFrom(mapCandidates(workspaceRoot), DEFAULT_MAP_PATH)
}
export function pickResolverPath (workspaceRoot) {
  return pickFrom(resolverCandidates(workspaceRoot), DEFAULT_RESOLVER_PATH)
}

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
// 3) 🔴「无 actor 怎么办」—— CM 2026-10-04 亲自裁决：**一律拒绝（fail-closed）**
//
//    **CM 原话**：「**无表就拒应该是最好的，最稳的。因为你执行不了，总比资料泄露好吧**」
//    救急手段（CM 同日给出）：①「主 A 准」这个不公开的身份可临时救急
//                            ② 我可以 SSH 上服务器直接修表
//    ⇒ **所以「表不可达」不再是放行理由** —— 它只是"确认不了身份"的一种情形。
//
//    只有一种放行：**这个回合根本不是飞书来的**（GUI／子代理／定时轮）——
//    那时**不要求飞书身份**（否则你本人在自己电脑上会被锁死，2026-10-04 已实测过一次）。
//
//    hasOwner=false（非飞书回合：GUI／子代理／定时轮）      ⇒ pass-through
//    hasOwner=true  ＋ actor                              ⇒ overwrite
//    hasOwner=true  ＋ 无 actor（**无论表在不在**）          ⇒ deny  ← CM 裁决
// ───────────────────────────────────────────────────────────────────────────
/**
 * 🔴 CM 2026-10-04 裁决：**无表就拒**（fail-closed）。
 *    CM 原话：「**无表就拒应该是最好的，最稳的。因为你执行不了，总比资料泄露好吧**」
 *    救急手段（CM 同日给出）：①「主 A 准」这个不公开的身份可临时救急；
 *                            ② 可以 SSH 上服务器直接修表。
 *
 * 只有一种放行：**这个回合根本不是飞书来的**（GUI／子代理／定时轮）——
 * 那时**不要求飞书身份**（否则你本人在自己电脑上会被锁死，2026-10-04 已实测过一次）。
 *
 *   hasOwner=false（非飞书回合：GUI／子代理／定时轮）  ⇒ pass-through
 *   hasOwner=true  ＋ actor                        ⇒ overwrite
 *   hasOwner=true  ＋ 无 actor（**表在不在都一样**）  ⇒ deny
 *
 * ⚠️ `tableOk` **不再参与放行判断** —— 它只用于**告警文案**（区分"表丢了"与"这人不认识"）；
 *    留痕在调用侧（`index.js` 的 `tools/execute` 拦截）做。
 */
export function decideAction ({ hasOwner, actor }) {
  if (!hasOwner) return 'pass-through'
  if (actor) return 'overwrite'
  return 'deny'
}

// ───────────────────────────────────────────────────────────────────────────
// 4) 跨语言：resolveActor 是 Python，插件是 Node
//    只在【入站】调一次（不是每次工具调用）＋ 进程内缓存（按 open_id）
//    失败一律返回 { actor:null, err }，**绝不抛**（一条消息失败不该影响整机）
// ───────────────────────────────────────────────────────────────────────────
export function makeResolver ({ mapPath = null,
                              resolverPath = null,
                              workspaceRoot = null,
                              python = null, timeoutMs = 8000 } = {}) {
  const cache = new Map()
  let cachedTableMtime = null

  // python 解释器也要探测：服务器叫 `python3`，Windows 上通常只有 `python` / `py`
  //（2026-10-04 实测：写死 `python3` ⇒ 本机 `resolver_no_json`）
  let cachedPython = null
  function currentPython () {
    if (python) return python
    if (process.env.MAILBOX_PYTHON) return process.env.MAILBOX_PYTHON
    if (cachedPython) return cachedPython
    for (const c of ['python3', 'python', 'py']) {
      try {
        const r = spawnSync(c, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 5000 })
        if (String(r.stdout || '').trim() === '1') { cachedPython = c; return c }
      } catch { /* 试下一个 */ }
    }
    return (cachedPython = 'python3')
  }

  // **动态取路径**：显式入参 ＞ 环境变量 ＞ 服务器固定路径 ＞ `<工作区>/output/g9-identity/`
  // ⇒ 每次调用都重新判 ⇒ 表放进来 / 移走立刻生效，不必等热重载；
  // ⇒ **跟着工作区走**，所以 HOME(`P:\Qoder\work`) 与 CM-OFFICE(`D:\Work`) 都能找到（CM 2026-10-04 要求）。
  function currentMapPath () {
    if (mapPath) return mapPath
    if (process.env.MAILBOX_IDENTITY_MAP) return process.env.MAILBOX_IDENTITY_MAP
    return pickMapPath(workspaceRoot)
  }
  function currentResolverPath () {
    if (resolverPath) return resolverPath
    if (process.env.MAILBOX_RESOLVER) return process.env.MAILBOX_RESOLVER
    return pickResolverPath(workspaceRoot)
  }
  // 🔑 **本地增量**：每台一份，**放在工作区之外**（`~/.dsh-feishucard/`）
  //    ⇒ **天然不参与 Syncthing** ⇒ HOME / CM-OFFICE **各写各的**（两台 bot 的 app_id 不同），
  //      **不会互相覆盖**（主表是共享的、只读；增量只补 `open_ids{本机 bot 的 app_id}`）。
  //    CM 2026-10-04 关切：「表放工作区会同步到公司电脑，那公司和服务器也不会被锁死」——
  //    主表共享解决"读得到"，本地增量解决"各自认得出"。
  function currentLocalMapPath () {
    if (process.env.MAILBOX_IDENTITY_LOCAL) return process.env.MAILBOX_IDENTITY_LOCAL
    try { return path.join(os.homedir(), '.dsh-feishucard', 'identity_map.local.json') } catch { return '' }
  }

  function tableOk () {
    try { return fs.statSync(currentMapPath()).isFile() } catch { return false }
  }

  return {
    get mapPath () { return currentMapPath() },
    tableOk,
    resolve (openId) {
      const mp = currentMapPath()
      if (!openId) return { actor: null, err: 'no_open_id', tableOk: tableOk() }
      if (!tableOk()) return { actor: null, err: 'map_unavailable', tableOk: false }
      const rp = currentResolverPath()
      if (!fs.existsSync(rp)) return { actor: null, err: 'resolver_missing', tableOk: true }
      // 表换了（mtime 变）⇒ 清缓存，避免"旧身份"
      try {
        const mt = fs.statSync(mp).mtimeMs
        if (cachedTableMtime !== null && mt !== cachedTableMtime) cache.clear()
        cachedTableMtime = mt
      } catch { /* 读不到 mtime 就用旧缓存 */ }
      if (cache.has(openId)) return { ...cache.get(openId), tableOk: true }
      // 主表 ＋ **本地增量** 合并后再解析（增量只补 `open_ids`；其余字段以主表为准）
      const code = [
        'import json,sys,os',
        'sys.path.insert(0, sys.argv[1])',
        'from resolve_actor import resolveActor',
        'm = json.load(open(sys.argv[2], encoding="utf-8-sig"))',
        'lp = sys.argv[4] if len(sys.argv) > 4 else ""',
        'if lp and os.path.isfile(lp):',
        '    loc = json.load(open(lp, encoding="utf-8-sig"))',
        '    byname = {p.get("name"): p for p in m.get("people", [])}',
        '    for per in loc.get("people", []):',
        '        tgt = byname.get(per.get("name"))',
        '        if tgt is not None:',
        '            tgt.setdefault("open_ids", {}).update(per.get("open_ids") or {})',
        'a, e = resolveActor(sys.argv[3], m)',
        'print(json.dumps({"actor": a, "err": e}, ensure_ascii=True))',
      ].join('\n')
      let out
      try {
        const r = spawnSync(currentPython(), ['-c', code, path.dirname(rp), mp, openId, currentLocalMapPath()],
          { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
        out = String(r.stdout || '').trim()
      } catch (e) {
        return { actor: null, err: 'resolver_failed:' + String(e && e.message || e).slice(0, 60), tableOk: true }
      }
      // ⚠️ 必须取【第一个】`{` —— 2026-10-04 实测：actor 里含 `grants: {}` / `extra_grants: {}`
      //    这类**嵌套空对象**，用 lastIndexOf('{') 会从那个空对象开始切 ⇒ JSON.parse 必失败
      //    （表现为 resolver_bad_json，且**只在"认得人"时出现** —— 认不出的人 payload 里没有 `{}`，
      //     所以症状看起来时好时坏，极易误判成"编码问题"）。
      const i = out.indexOf('{')
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

  console.log('── 1) decideAction：CM 2026-10-04 裁决「无表就拒」──')
  ok(decideAction({ hasOwner: false, actor: null }) === 'pass-through',
    '非飞书回合（GUI/子代理）⇒ 放行（**不许把 CM 自己的电脑锁死** —— 2026-10-04 实测过一次）')
  ok(decideAction({ hasOwner: true, actor: { name: 'x' } }) === 'overwrite', '飞书回合 ＋ 有 actor ⇒ 覆写')
  ok(decideAction({ hasOwner: true, actor: null }) === 'deny', '🔴 飞书回合 ＋ 无 actor ⇒ 拒绝')
  ok(decideAction({ hasOwner: true, actor: null, tableOk: false }) === 'deny',
    '🔴 **表不可达也照样拒**（CM：执行不了总比泄露好；救急走主 A 准 / SSH 修表）')
  ok(decideAction({ hasOwner: true, actor: null, tableOk: true }) === 'deny',
    '🔴 表可达但认不出这个人 ⇒ 同样拒（两者本质一样：拿不到身份）')

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
  ok(r.resolve('ou_x').err === 'map_unavailable', '表不存在 ⇒ map_unavailable（tableOk=false **仅供告警文案**；上层按 fail-closed 拒，不再据此放行）')
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
