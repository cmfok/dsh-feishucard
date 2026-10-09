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
export const DEFAULT_JOBGRANTS_PATH = '/opt/scripts/G9/job_grants.json'
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
// 岗位授权表（契约 §四：grants/writable_scopes/item_grants 挂岗位，resolveActor 真查它）
const JOBGRANTS_REL = path.join('AIAD', 'G9-Agent基座', 'agent', 'job_grants.json')

export function mapCandidates (workspaceRoot) {
  return assetCandidates(workspaceRoot, 'MAILBOX_IDENTITY_MAP', DEFAULT_MAP_PATH, MAP_REL)
}
export function resolverCandidates (workspaceRoot) {
  return assetCandidates(workspaceRoot, 'MAILBOX_RESOLVER', DEFAULT_RESOLVER_PATH, RESOLVER_REL)
}
export function jobGrantsCandidates (workspaceRoot) {
  return assetCandidates(workspaceRoot, 'MAILBOX_JOB_GRANTS', DEFAULT_JOBGRANTS_PATH, JOBGRANTS_REL)
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
export function pickJobGrantsPath (workspaceRoot) {
  return pickFrom(jobGrantsCandidates(workspaceRoot), DEFAULT_JOBGRANTS_PATH)
}

// 🔑 **本地增量表路径**（第十三轮 MEDIUM#3：导出面，别再让"读不读增量"变成两处各自的私事）
//    每台一份，**放在工作区之外**（`~/.dsh-feishucard/`）⇒ **天然不参与 Syncthing**
//    ⇒ HOME / CM-OFFICE **各写各的**（两台 bot 的 app_id 不同），**不会互相覆盖**
//      （主表是共享的、只读；增量只补 `open_ids{本机 bot 的 app_id}`）。
//    CM 2026-10-04 关切：「表放工作区会同步到公司电脑，那公司和服务器也不会被锁死」——
//    主表共享解决"读得到"，本地增量解决"各自认得出"。
export function localMapPath () {
  if (process.env.MAILBOX_IDENTITY_LOCAL) return process.env.MAILBOX_IDENTITY_LOCAL
  try { return path.join(os.homedir(), '.dsh-feishucard', 'identity_map.local.json') } catch { return '' }
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
//
//    0.8.0（互认改造 P0-5）：**默认走纯 JS 镜像**（resolveActorJs），只有显式设
//    `MAILBOX_RESOLVER_FORCE_PY=1` 才 spawnSync Python —— 服务器上 python3 /
//    resolve_actor.py 只要有一个不在，旧实现就 resolver_missing ⇒ fail-closed 把
//    所有飞书回合拒掉（认人链路被一台机器的环境卡死）。JS 路径零外部依赖；
//    两口径由 `--selftest` 的 parity 断言钉住（漂移当场暴露）。
// ───────────────────────────────────────────────────────────────────────────

const E_MAP_UNAVAILABLE = 'map_unavailable'
const E_NO_OPEN_ID = 'no_open_id'
const E_UNKNOWN_PERSON = 'unknown_person'
const E_DUPLICATE = 'duplicate_open_id'
const E_MISSING = 'open_id_missing'
const E_NOT_GRANTED = 'job_not_granted'
const E_NOT_ACTIVE = 'not_active'
const E_UNKNOWN_STATUS = 'unknown_status'
// 在职口径（契约 §五 V1.2 定死，2026-10-09 收口 #158；与 resolve_actor.py 逐字一致）：
//   离职三态 ⇒ not_active（正常拒绝，≠ 不认识）；
//   「可上岗」只含 在职 —— 兼职/待入职（CM V1.2 裁决均不可上岗）与其余一切状态
//   （未填 / 未来新状态）⇒ unknown_status 拒。旧版「其余一律正常」是 fail-open：
//   HRM 冒出新状态 ⇒ 这人自动获得权限 —— 该断言已翻转，别再改回去。
const INACTIVE_STATUS = new Set(['离职', '终止办理', '兼职终止'])
const ACTIVE_STATUS = new Set(['在职'])

/** 容错读映射表（镜像 py `_load`）：对象直接用；非空字符串按 JSON 解析；其余 = map_unavailable */
function loadMapJs (raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) {
    try { return JSON.parse(raw.replace(/^\uFEFF/, '')) } catch { throw new Error(E_MAP_UNAVAILABLE) }
  }
  throw new Error(E_MAP_UNAVAILABLE)
}
const arrCopyJs = (x) => (Array.isArray(x) ? x.slice() : [])
const objCopyJs = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? { ...x } : {})

/**
 * resolve_actor.py::resolveActor 的**逐行镜像**（不读文件/不起进程）。
 * ⚠️ 不是"纯"：会把 `localMap` 的 `open_ids` **就地合并进传进来的 `identityMap.people`**
 *   （镜像 py 的 setdefault+update 语义）。调用方必须传**当场 parse 出来的**映射，
 *   不许复用/缓存同一份对象（第六轮门槛 LOW）。
 * `localMap` 对应 identity_map.local.json 的合并（按 name 匹配、只补 open_ids，
 * 镜像 makeResolver 内嵌 Python 的 lp 段）。返回 { actor, err }，绝不抛。
 */
export function resolveActorJs (openId, identityMap, localMap, jobGrants) {
  // ① open_id 本身缺失
  if (!openId || !String(openId).trim()) return { actor: null, err: E_NO_OPEN_ID }
  // ② 映射表可用性
  let m
  try { m = loadMapJs(identityMap) } catch (e) { return { actor: null, err: String(e && e.message || e) } }
  if (!m || typeof m !== 'object' || !Array.isArray(m.people)) return { actor: null, err: E_MAP_UNAVAILABLE }
  // 本地增量合并（镜像 py：后出现的同名覆盖 byname；只 setdefault+update open_ids）
  if (localMap && typeof localMap === 'object' && Array.isArray(localMap.people)) {
    const byName = new Map()
    for (const p of m.people) byName.set((p && p.name !== undefined ? p.name : null), p)
    for (const per of localMap.people) {
      const tgt = byName.get((per && per.name !== undefined ? per.name : null))
      if (!tgt) continue
      if (!tgt.open_ids || typeof tgt.open_ids !== 'object' || Array.isArray(tgt.open_ids)) tgt.open_ids = {}
      Object.assign(tgt.open_ids, objCopyJs(per && per.open_ids))
    }
  }
  // ③ open_ids 缓存反查（app 无关：扫所有人的所有 app；同一人多 app 命中只算一条）
  const hits = []
  for (const person of m.people) {
    const ids = (person && person.open_ids) || {}
    for (const ou of Object.values(objCopyJs(ids))) {
      if (ou === openId) { hits.push(person); break }
    }
  }
  if (hits.length > 1) return { actor: null, err: E_DUPLICATE }   // ≥2 人 ⇒ 判表损坏
  if (!hits.length) {
    // pending 里显式列出的人 ⇒ open_id_missing（等补），否则彻底未知
    for (const p of (Array.isArray(m.pending) ? m.pending : [])) {
      if (p && p.open_id === openId) return { actor: null, err: E_MISSING }
    }
    return { actor: null, err: E_UNKNOWN_PERSON }
  }
  const person = hits[0]
  // ④ 在职校验（契约 §五 V1.2：离职三态 ⇒ not_active；其余必须是在职，否则 unknown_status）
  const st = String(person.status || '').trim()
  if (INACTIVE_STATUS.has(st)) return { actor: null, err: E_NOT_ACTIVE }
  if (!ACTIVE_STATUS.has(st)) return { actor: null, err: E_UNKNOWN_STATUS }
  // ⑤ 岗位授权：job_id 真查岗位表（契约 §三：非空即过 = 空判，作废；卡号 ≠ 岗位）。
  //    岗位表缺失/坏表 ⇒ 集合为空 ⇒ 全拒（fail-closed，不许因缺表放行）。
  const jid = String(person.job_id || '').trim()
  let job = null
  if (jid && jobGrants && typeof jobGrants === 'object' && Array.isArray(jobGrants.jobs)) {
    for (const j of jobGrants.jobs) {
      if (j && typeof j === 'object' && String(j.id || '').trim() === jid) { job = j; break }
    }
  }
  if (!job) return { actor: null, err: E_NOT_GRANTED }
  // ⑥ 组装 actor（键序与 py 逐字一致，parity 断言直接 stringify 比对）——契约 §二 13 字段：
  //    判定 8（grants/writable_scopes/item_grants 从岗位表现取，人级不存 grants，§四）＋
  //    标识/追溯 5。🔴 open_id 必须回带：不带会被内核【删除】而非覆写。
  return {
    actor: {
      name: (person.name === undefined || person.name === null) ? '' : person.name,
      scopes: arrCopyJs(person.scopes),
      grants: objCopyJs(job.grants),
      extra_grants: objCopyJs(person.extra_grants),
      extra_grants_until: objCopyJs(person.extra_grants_until),
      writable_scopes: arrCopyJs(job.writable_scopes),
      is_cm: Boolean(person.is_cm),
      item_grants: objCopyJs(job.item_grants),
      open_id: String(openId),
      union_id: String(person.union_id || ''),
      person_id: String(person.person_id || ''),
      job_id: jid,
      source: 'identity_map@v' + String(m.v === undefined || m.v === null ? '?' : m.v),
    },
    err: null,
  }
}

function readTextNoBom (p) {
  return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
}

export function makeResolver ({ mapPath = null,
                              resolverPath = null,
                              jobGrantsPath = null,
                              workspaceRoot = null,
                              python = null, timeoutMs = 8000 } = {}) {
  const cache = new Map()
  let cachedTableSig = null

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
  function currentJobGrantsPath () {
    if (jobGrantsPath) return jobGrantsPath
    if (process.env.MAILBOX_JOB_GRANTS) return process.env.MAILBOX_JOB_GRANTS
    return pickJobGrantsPath(workspaceRoot)
  }
  function currentResolverPath () {
    if (resolverPath) return resolverPath
    if (process.env.MAILBOX_RESOLVER) return process.env.MAILBOX_RESOLVER
    return pickResolverPath(workspaceRoot)
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
      const forcePy = process.env.MAILBOX_RESOLVER_FORCE_PY === '1'
      const rp = currentResolverPath()
      if (forcePy && !fs.existsSync(rp)) return { actor: null, err: 'resolver_missing', tableOk: true }
      // 表换了（mtime 变）⇒ 清缓存，避免"旧身份"
      // 输入换了 ⇒ 清缓存，避免"旧身份"。签名要覆盖**四样**：主表 mtime、本地增量 mtime、
      // 岗位表 mtime、forcePy。（岗位表进签名：改岗位授权必须在换缓存前生效，#158 真查链路）
      try {
        let sig = String(fs.statSync(mp).mtimeMs)
        const lp0 = localMapPath()
        if (lp0) {
          try { if (fs.statSync(lp0).isFile()) sig += '|local=' + fs.statSync(lp0).mtimeMs } catch { /* 无增量表 */ }
        }
        const jp0 = currentJobGrantsPath()
        if (jp0) {
          try { if (fs.statSync(jp0).isFile()) sig += '|jg=' + fs.statSync(jp0).mtimeMs } catch { /* 无岗位表 */ }
        }
        sig += '|py=' + (forcePy ? '1' : '0')
        if (cachedTableSig !== null && sig !== cachedTableSig) cache.clear()
        cachedTableSig = sig
      } catch { /* 读不到 mtime 就用旧缓存 */ }
      if (cache.has(openId)) return { ...cache.get(openId), tableOk: true }
      // 岗位授权表加载（契约 §三：job_id 真查；读不到 ⇒ {} ⇒ fail-closed 全拒 job_not_granted）
      let jg = null
      {
        const jp = currentJobGrantsPath()
        try {
          if (jp && fs.statSync(jp).isFile()) jg = JSON.parse(readTextNoBom(jp))
        } catch { jg = null }
      }
      if (!forcePy) {
        // 0.8.0（P0-5）：默认纯 JS —— 主表 ＋ 本地增量（增量只补 open_ids）解析后直调镜像函数。
        let res
        try {
          const mainMap = loadMapJs(readTextNoBom(mp))
          let local = null
          const lp = localMapPath()
          if (lp) {
            try { if (fs.statSync(lp).isFile()) local = loadMapJs(readTextNoBom(lp)) } catch { local = null }
          }
          const r = resolveActorJs(openId, mainMap, local, jg)
          res = { actor: r.actor || null, err: r.err || null, tableOk: true }
        } catch (e) {
          // 🔴 错误码归一（第十一轮门槛 LOW#2）：`loadMapJs` 抛的就是文档里的
          //   `map_unavailable`（README「解析接口」错误码清单）。原来无条件加前缀 ⇒
          //   同一份坏主表，JS 通道吐 `resolver_js_failed:map_unavailable`、
          //   Python 通道吐 `map_unavailable`，两条通道的口径**不等价**。
          //   现在：文档内的码原样透出，其它异常才带 `resolver_js_failed:` 前缀（那是"意外"，本来就该可见）。
          const msg = String(e && e.message || e)
          res = {
            actor: null,
            err: msg === E_MAP_UNAVAILABLE ? E_MAP_UNAVAILABLE
              : 'resolver_js_failed:' + msg.slice(0, 60),
            tableOk: true,
          }
        }
        cache.set(openId, res)
        return res
      }
      // 主表 ＋ **本地增量** 合并后再解析（增量只补 `open_ids`；其余字段以主表为准）；
      // 岗位授权表路径一并传入（resolveActor 第三参，契约 §三 真查岗位）
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
        'jg = {}',
        'jp = sys.argv[5] if len(sys.argv) > 5 else ""',
        'if jp and os.path.isfile(jp):',
        '    try: jg = json.load(open(jp, encoding="utf-8-sig"))',
        '    except Exception: jg = {}',
        'a, e = resolveActor(sys.argv[3], m, jg)',
        'print(json.dumps({"actor": a, "err": e}, ensure_ascii=True))',
      ].join('\n')
      let out
      try {
        const r = spawnSync(currentPython(), ['-c', code, path.dirname(rp), mp, openId, localMapPath(), currentJobGrantsPath()],
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

  console.log('── 6) resolveActorJs：resolve_actor.py 的纯 JS 镜像（无 python3 也能认人）──')
  // 夹具与 resolve_actor.py __main__ 的 MAP **逐字段一致** —— 两边同一套题才算镜像。
  // 岗位授权夹具 JOBG 同理镜像 py 的 JG（契约 §三：job_id 真查 jobs[].id，卡号≠岗位）。
  const JOBG = {
    v: 1, jobs: [
      { id: '电商运营助理', card: 'CR-POST-20261003-01', grants: { 销售: 'L2', 财务: 'L1' },
        item_grants: { '财务|净利': 'L2' }, writable_scopes: [] },
      { id: '运营', card: 'CR-POST-20261003-02', grants: { 销售: 'L2', 财务: 'L1' },
        item_grants: {}, writable_scopes: ['业务线:天猫'] },
    ],
  }
  const FIX6 = {
    v: 1, people: [
      { union_id: 'on_cm', open_ids: { cli_main: 'ou_cm_main', cli_hr: 'ou_cm_hr' },
        person_id: 'P-001', name: '陈明', job_id: '电商运营助理',
        channels: ['main'], is_cm: true,
        status: '在职', scopes: ['公司'], extra_grants: {}, extra_grants_until: {} },
      { union_id: 'on_wgh', open_ids: { cli_main: 'ou_wgh_main' }, name: '伍国衡', job_id: '', status: '在职' },
      { union_id: 'on_gone', open_ids: { cli_main: 'ou_gone_main' }, name: '离职者', status: '离职' },
      { union_id: 'on_pt', open_ids: { cli_main: 'ou_pt_main' }, name: '兼职者', job_id: 'J-PT', status: '兼职' },
      { union_id: 'on_pre', open_ids: { cli_main: 'ou_pre_main' }, name: '待入职者', job_id: 'J-PRE', status: '待入职' },
      { union_id: 'on_new', open_ids: { cli_main: 'ou_new_main' }, name: '新状态者', job_id: '电商运营助理', status: '停薪留职' },
    ],
    pending: [{ name: '李四', open_id: 'ou_lisi_unk', reason: 'union_id 未取到' }],
  }
  const CASES6 = [
    ['ou_cm_main', 'OK:陈明'], ['ou_cm_hr', 'OK:陈明'],
    ['ou_pt_main', 'unknown_status'], ['ou_pre_main', 'unknown_status'],
    ['ou_new_main', 'unknown_status'],
    ['ou_unk', 'unknown_person'], ['ou_lisi_unk', 'open_id_missing'],
    ['', 'no_open_id'], ['ou_wgh_main', 'job_not_granted'],
    ['ou_gone_main', 'not_active'], ['ou_nobody_main', 'unknown_person'],
  ]
  const cloneFix = () => JSON.parse(JSON.stringify(FIX6))
  for (const [ou, want] of CASES6) {
    const rr = resolveActorJs(ou, cloneFix(), null, JOBG)
    const got = rr.err || ('OK:' + rr.actor.name)
    ok(got === want, 'JS 镜像：' + (ou || '(空)') + ' → ' + got + (got === want ? '' : '（期望 ' + want + '）'))
  }
  {
    const dup = cloneFix(); dup.people.push(JSON.parse(JSON.stringify(FIX6.people[0])))
    ok(resolveActorJs('ou_cm_main', dup, null, JOBG).err === 'duplicate_open_id', 'JS 镜像：两人共用 open_id ⇒ duplicate_open_id（判表损坏）')
    const withOpenId = resolveActorJs('ou_cm_main', cloneFix(), null, JOBG)
    ok(withOpenId.actor.open_id === 'ou_cm_main', 'JS 镜像：🔴 actor 必须回带 open_id（不带会被内核【删除】而非覆写）')
    // #158 收口：13 字段不多不少（契约 §二；channels 已移除）
    ok(Object.keys(withOpenId.actor).length === 13 &&
       withOpenId.actor.writable_scopes.length === 0 &&
       withOpenId.actor.is_cm === true &&
       withOpenId.actor.item_grants['财务|净利'] === 'L2' &&
       withOpenId.actor.union_id === 'on_cm' && withOpenId.actor.job_id === '电商运营助理',
      'JS 镜像：13 字段（挂岗位现取 grants/writable_scopes/item_grants ＋ is_cm/union_id/job_id）')
    // V4：审批卡号冒充 job_id ⇒ 必须拒（卡号在 jobs[].card，不在 .id）
    const cardFix = cloneFix(); cardFix.people[0].job_id = 'CR-POST-20261003-01'
    ok(resolveActorJs('ou_cm_main', cardFix, null, JOBG).err === 'job_not_granted',
      'V4：卡号冒充 job_id ⇒ job_not_granted（真查岗位表，不再非空即过）')
    // fail-closed：岗位表缺失 ⇒ 即使在职＋真岗位也拒
    ok(resolveActorJs('ou_cm_main', cloneFix(), null, null).err === 'job_not_granted',
      '岗位表缺失 ⇒ fail-closed 全拒（不许因缺表放行）')
    ok(resolveActorJs('ou_cm_main', '\uFEFF' + JSON.stringify(FIX6), null, JOBG).actor.name === '陈明',
      'JS 镜像：字符串表带 BOM（utf-8-sig 落盘）也能解析')
    const merged = resolveActorJs('ou_cm_local', cloneFix(),
      { people: [{ name: '陈明', open_ids: { cli_local2: 'ou_cm_local' } }] }, JOBG)
    ok(merged.actor && merged.actor.name === '陈明', 'JS 镜像：本地增量按 name 合并 open_ids（本机 bot 的 ou 也能认）')
    ok(resolveActorJs('ou_cm_local', cloneFix(), null, JOBG).err === 'unknown_person',
      'JS 镜像：不合并本地增量时该 ou 仍是 unknown_person（合并没漏判成放行）')
  }

  console.log('── 7) parity：JS 与 Python 同夹具逐字段一致（漂移当场暴露）──')
  {
    const pyScript = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
      'scripts', 'resolve_actor.py')
    let pyBin = ''
    for (const c of ['python3', 'python', 'py']) {
      try {
        const pr = spawnSync(c, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 5000 })
        if (String(pr.stdout || '').trim() === '1') { pyBin = c; break }
      } catch { /* 试下一个 */ }
    }
    if (!pyBin || !fs.existsSync(pyScript)) {
      console.log('  ⚠️ 本机没有可用的 python / resolve_actor.py ⇒ parity 对照**跳过**'
        + '（JS 夹具断言照常全跑；服务器定版前需在有 python 的机器上补跑一次）')
    } else {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-parity-'))
      const mapFile = path.join(tmp, 'identity_map.json')
      const localFile = path.join(tmp, 'identity_map.local.json')
      const jgFile = path.join(tmp, 'job_grants.json')
      fs.writeFileSync(mapFile, JSON.stringify(FIX6), 'utf8')
      fs.writeFileSync(localFile, JSON.stringify({ people: [{ name: '陈明', open_ids: { cli_local2: 'ou_cm_local' } }] }), 'utf8')
      fs.writeFileSync(jgFile, JSON.stringify(JOBG), 'utf8')
      const prevLocal = process.env.MAILBOX_IDENTITY_LOCAL
      process.env.MAILBOX_IDENTITY_LOCAL = localFile
      try {
        const rJs = makeResolver({ mapPath: mapFile, resolverPath: pyScript, python: pyBin, jobGrantsPath: jgFile })
        const rPy = makeResolver({ mapPath: mapFile, resolverPath: pyScript, python: pyBin, jobGrantsPath: jgFile })
        // ⚠️ FORCE_PY 是**每次 resolve() 调用时**读的 ⇒ 必须逐条切换，不能全程挂着
        //   （否则 JS 那半边也走了 Python 进程，比对的是「自己 vs 自己」= 假绿灯）。
        const prevForce = process.env.MAILBOX_RESOLVER_FORCE_PY
        const restoreForce = () => {
          if (prevForce) process.env.MAILBOX_RESOLVER_FORCE_PY = prevForce
          else delete process.env.MAILBOX_RESOLVER_FORCE_PY
        }
        const norm = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v))
          ? Object.fromEntries(Object.keys(v).sort().map((kk) => [kk, v[kk]])) : v)
        let drift = 0; let checked = 0
        for (const ou of ['ou_cm_main', 'ou_cm_hr', 'ou_pt_main', 'ou_new_main', 'ou_unk', 'ou_lisi_unk', 'ou_gone_main', 'ou_wgh_main', 'ou_cm_local']) {
          delete process.env.MAILBOX_RESOLVER_FORCE_PY
          const a = rJs.resolve(ou)
          process.env.MAILBOX_RESOLVER_FORCE_PY = '1'
          let b
          try { b = rPy.resolve(ou) } finally { restoreForce() }
          checked++
          const same = norm({ actor: a.actor, err: a.err }) === norm({ actor: b.actor, err: b.err })
          if (!same) { drift++; console.log('    差异 ' + ou + '：JS=' + norm({ actor: a.actor, err: a.err }) + ' PY=' + norm({ actor: b.actor, err: b.err })) }
        }
        ok(drift === 0, 'JS/Py 同夹具 ' + checked + ' 条逐字段一致（含本地增量合并的 ou_cm_local）'
          + (drift ? '：漂移 ' + drift + ' 条' : ''))
        restoreForce()
      } finally {
        if (prevLocal === undefined) delete process.env.MAILBOX_IDENTITY_LOCAL
        else process.env.MAILBOX_IDENTITY_LOCAL = prevLocal
        try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 临时目录留给系统回收 */ }
      }
    }
  }

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
