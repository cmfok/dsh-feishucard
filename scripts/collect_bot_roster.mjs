#!/usr/bin/env node
// V0.1.0-26100503 — bot roster 采集器（dsh-feishucard 0.8.0 P0-4「Agent 互认」）
// 变更：-26100503 第十二轮门槛 LOW×2 —— ①`--config`/`--out` 必须校验后面真的跟了值，
//       落在末尾时用 `undefined` 静默退回默认路径去读凭证（对读凭证、写 0600 名单的脚本
//       是「以为指了别处、其实用的默认那份」）；②写盘前 `mkdirSync(dirname(out), {recursive:true})`，
//       与插件侧写配置的口径一致（原来目录不存在只抛 ENOENT，归因困难）。
//       变更：-26100502 第八/九轮门槛 MEDIUM×2 —— 兼容插件支持的 legacy 单 bot 配置形态
//       （原来只读 `{bots:[…]}`，legacy 部署下名单**永远采不出来**）；
//       分页截断（`has_more` 却没给 `page_token`）改为**抛错**，让成员名单落入
//       `members_incomplete` 的「沿用旧名单」分支，而不是当成「就这些人」。
//
// 为什么需要：open_id 是"应用视角"的值 —— 同一个 bot/同一个人，在 7 个飞书应用里
// 有 7 个不同的 ou_（2026-10-05 真机取证：MAIN 一个 union 对应 6 个 ou_）。agent 之间
// 要互相 @、要认出"发这条的是谁"，必须有一张 **跨应用 id 目录**。名字不可靠（实测
// 同一 open_id 三天内换过两次名），所以 join 主键用 union_id。
//
// 产出：FS_CONFIG_DIR（默认 ~/.dsh-feishucard）/bot_roster.json，0600，工作区外。
// 结构：
//   bots[]   { name, app_id, union_id, views: { <appId>: <open_id> } }
//   people[] { name, union_id, views: { <appId>: <open_id> } }
//   chats{}  { <chat_id>: { name, bot_app_ids[], member_unions[] } }
//
// 用法：node scripts/collect_bot_roster.mjs [--config <path>] [--out <path>] [--dry-run]
// 纪律（沿 build_identity_map.py 的约束）：调用频率 ≤3 次/天（挂服务器 cron）；
// 任一 bot 采集失败 ⇒ 明确报错且**不写**空文件（宁可用旧目录，不可用空目录）。

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync } from 'node:fs'

const API = 'https://open.feishu.cn/open-apis'
const PAGE = 100

function parseArgs(argv) {
  const out = { dryRun: false }
  // 🔴 带值参数必须校验"后面真的跟了值"（第十二轮门槛 LOW）：原来 `--config` 落在末尾时
  //   `argv[++i]` 是 undefined ⇒ 静默退回**默认配置路径**去读凭证。对读凭证、写 0600 名单的
  //   脚本来说，"以为指了别处、其实用的默认那份"比直接报错坏得多。
  const needValue = (name, raw) => {
    if (raw === undefined || String(raw).startsWith('--')) {
      console.error(name + ' 缺少参数值（后面没有跟路径，或跟的是另一个选项）')
      process.exit(2)
    }
    return String(raw)
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--config') out.config = needValue(a, argv[++i])
    else if (a === '--out') out.out = needValue(a, argv[++i])
    else if (a === '--help' || a === '-h') { console.log('用法见文件头注释'); process.exit(0) }
    else { console.error('未知参数: ' + a); process.exit(2) }
  }
  return out
}

// 🔴 每个请求**必须带超时**（第十一轮门槛 MEDIUM#0）：本脚本全程串行
//   （token → bot/v3/info → 会话列表 → 每个会话两遍成员），一个卡住的飞书端点靠
//   undici 的默认超时要 5 分钟级，乘进循环里能把整轮 cron 挂死。
//   而"只在全部成功时写文件"意味着挂死的后果是 **roster 长期陈旧** —— 出站 @ 和
//   点击者认名整条静默降级，日志里一个字都没有。
async function api(method, url, headers, body) {
  const res = await fetch(url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  let parsed = null
  try { parsed = await res.json() } catch { /* 非 JSON ⇒ 下面按失败处理 */ }
  if (!parsed || parsed.code !== 0) {
    throw new Error(url.split('/open-apis')[1] + ' -> code='
      + (parsed && parsed.code) + ' msg=' + (parsed && parsed.msg || ('HTTP ' + res.status)))
  }
  // 🔴 飞书这两个接口**没有 `data` 信封**（字段在顶层）：
  //   `auth/v3/tenant_access_token/internal` → `tenant_access_token` / `expire`（生产侧 index.js:755 同读法）
  //   `bot/v3/info` → `bot.open_id`（生产侧 index.js:5505 同读法）
  // 只取 `parsed.data` 会让采集脚本在**第一个 bot 就抛** `tenant_token empty` ⇒ 整条互认名单来源不可用。
  // 走 `data` 信封的是 `im/v1/chats`、`im/v1/chats/:id/members` 这类，`parsed.data` 命中时行为不变。
  return parsed.data || parsed
}

async function tenantToken(appId, appSecret) {
  const d = await api('POST', API + '/auth/v3/tenant_access_token/internal', null,
    { app_id: appId, app_secret: appSecret })
  if (!d.tenant_access_token) throw new Error('tenant_token empty for ' + appId)
  return d.tenant_access_token
}

// 🔴 `has_more: true` 却没带 `page_token` ⇒ 分页被**截断**（接口违约，正常不会发生）。
//   静默退出循环等于把「这一页之前的人」当成「全部人」：下游 `resolveAtTarget` 按
//   `member_unions` 收窄 @ 目标 ⇒ 正当成员被悄悄丢掉，比采不到更坏。
//   所以这里**抛错**，让调用方走失败分支（成员侧置 `members_incomplete`、
//   合并时沿用旧名单 —— 本文件头部「宁可用旧的」那条纪律）。
function takePageToken(d, what) {
  if (!d || !d.has_more) return ''
  if (!d.page_token) throw new Error(what + ' 分页截断（has_more 却没有 page_token）')
  return String(d.page_token)
}

async function listChats(token) {
  const chats = []
  let pageToken = ''
  do {
    const q = 'page_size=' + PAGE + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '')
    const d = await api('GET', API + '/im/v1/chats?' + q, { Authorization: 'Bearer ' + token })
    for (const c of d.items || []) chats.push({ chat_id: c.chat_id, name: c.name || '' })
    pageToken = takePageToken(d, '会话列表')
  } while (pageToken)
  return chats
}

// 2026-10-05 服务器实测：members item = {member_id, member_id_type, name, tenant_key}；
// member_id **跟随** member_id_type ⇒ 同一请求只能要一种视角，两种视角要各拉一遍。
async function listMembers(token, chatId, idType) {
  const members = []
  let pageToken = ''
  do {
    const q = 'member_id_type=' + idType + '&page_size=' + PAGE
      + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '')
    const d = await api('GET', API + '/im/v1/chats/' + encodeURIComponent(chatId) + '/members?' + q,
      { Authorization: 'Bearer ' + token })
    for (const m of d.items || []) members.push(m)
    pageToken = takePageToken(d, '群 ' + chatId + ' 成员(' + idType + ')')
  } while (pageToken)
  return members
}

function mergeViews(existing, key, addViews, addFields) {
  const row = existing.get(key) || {}
  row.views = Object.assign({}, row.views || {}, addViews || {})
  Object.assign(row, addFields || {})
  existing.set(key, row)
  return row
}

async function main() {
  const args = parseArgs(process.argv)
  const cfgDir = process.env.FS_CONFIG_DIR || join(homedir(), '.dsh-feishucard')
  const cfgPath = args.config || join(cfgDir, 'feishu.config.json')
  const outPath = args.out || join(cfgDir, 'bot_roster.json')
  if (!existsSync(cfgPath)) { console.error('找不到配置: ' + cfgPath); process.exit(1) }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  // 🔴 必须和插件 `normalizeConfig`（index.js:614-619）**同形态**：那边除了 `{bots:[…]}`
  //   还接受 legacy 单 bot（顶层直接 `appId`/`appSecret`；`migrateLegacyConfig` 从
  //   `~/.cc-connect` 抄过来的就是这一份）。原来这里只读 `cfg.bots` ⇒ 那种部署
  //   插件跑得好、采集脚本却报「配置里没有带 appId/appSecret 的 bot」，
  //   互认名单**永远生成不了**（拿旧名单顶着，跨应用 @ 与认人静默失效）。
  let bots = Array.isArray(cfg.bots) ? cfg.bots : []
  if (!bots.length && cfg && typeof cfg.appId === 'string' && cfg.appId) bots = [cfg]
  const usable = bots.filter(b => b && b.appId && b.appSecret)
  if (!usable.length) { console.error('配置里没有带 appId/appSecret 的 bot'); process.exit(1) }

  const botRows = new Map()    // union_id（缺则 app:<appId>）-> row
  const peopleRows = new Map() // union_id -> row
  const chatRows = {}

  for (const bot of usable) {
    const label = bot.name || bot.appId
    const token = await tenantToken(bot.appId, bot.appSecret)
    const info = await api('GET', API + '/bot/v3/info', { Authorization: 'Bearer ' + token })
    const b = info.bot || {}
    if (!b.open_id) throw new Error('bot/v3/info 没给 open_id: ' + label)
    const bkey = b.union_id || ('app:' + bot.appId)
    // 名字会漂移：views 里记的是 id（稳定），name 只作展示、总用最新值覆盖。
    mergeViews(botRows, bkey, { [bot.appId]: b.open_id }, {
      name: b.app_name || b.name || label,
      app_id: bot.appId,
      union_id: b.union_id || '',
    })
    const chats = await listChats(token)
    for (const c of chats) {
      const rec = chatRows[c.chat_id] || (chatRows[c.chat_id] = { name: c.name, bot_app_ids: [], member_unions: [] })
      rec.name = c.name || rec.name
      if (!rec.bot_app_ids.includes(bot.appId)) rec.bot_app_ids.push(bot.appId)
      // 取证 V5 + 实测：members API 只列**人**不列 bot ⇒ bot 寻址 id 靠 bot/v3/info 自身 ou（V4 实证）。
      // open/union 两遍之间唯一公共键是 name ⇒ 按 name join；**同名歧义不硬并**（宁可缺视角，不可并错人）。
      let openPass = []
      let unionPass = []
      // 🔴 成员拉不下来**不能**当成"这个群没有成员"：下游 `resolveAtTarget` 的空数组短路
      //   （index.js:4134 `chat.member_unions.length && …`）＝**不收窄** ⇒ 跨群同名的人会被误 @。
      //   所以失败要标记，合并时沿用旧目录里该群已采到的名单（本文件头部的纪律：宁可用旧的）。
      // 🔴 标记只跟 **union 遍**（第十一轮门槛 MEDIUM#9）：`rec.member_unions` 是**只由
      //   union 遍**填的（下面 176-195 行），而这条标记唯一的用途就是决定「要不要把旧名单并回来」。
      //   原来任何一遍失败都置位 ⇒ open 遍失败（union 遍**已经采全**）时照样并旧名单，
      //   把**已退群的人**重新请回收窄集合 —— 恰好把这条保险丝本身给削弱了。
      //   open 遍失败的代价是 `views[appId]` 缺一角，那由下面「旧 views 为底」的合并兜，
      //   不需要这个标记，所以这里不为它设第二个标记。
      let membersFailed = false
      try { openPass = await listMembers(token, c.chat_id, 'open_id') }
      catch (e) { console.error('  ! 成员拉取失败(open_id)，本群视角 id 沿用旧目录 ' + c.chat_id + ' @ ' + label + ': ' + e.message) }
      try { unionPass = await listMembers(token, c.chat_id, 'union_id') }
      catch (e) { membersFailed = true; console.error('  ! 成员拉取失败(union_id) ' + c.chat_id + ' @ ' + label + ': ' + e.message) }
      if (membersFailed) rec.members_incomplete = true
      const byName = new Map()
      for (const m of openPass) {
        const nm = String(m.name || '')
        if (!nm) continue
        if (!byName.has(nm)) byName.set(nm, [])
        byName.get(nm).push(String(m.member_id || ''))
      }
      for (const m of unionPass) {
        const uid = String(m.member_id || '')
        if (!uid) continue
        const nm = String(m.name || '')
        const candidates = (byName.get(nm) || []).filter(Boolean)
        const views = {}
        // 🔴 残余风险（如实记，别把注释写成"保证不并错人"）：`candidates.length === 1` 只挡得住
        //   **同一遍内**的重名。若成员 X 在 open 遍叫 A、union 遍已改名 B，而另有成员本名 B
        //   （open 遍 B→ou_Y），union 遍就会把 ou_Y 挂到 X 的 union_id 上。
        //   两遍之间没有公共稳定键（member_id 跟随 id_type，只有 name 可变），
        //   彻底防住要么改抓 `user_id` 第三遍、要么在检测到"两遍人数不一致"时拒绝并 view。
        //   本脚本按后者从严：**人数不一致时不并 view**（宁可缺视角，不可并错人）。
        // 🔴 这条人数检查**挡不住上面那个改名场景**（第七轮门槛 LOW#2）：两遍是背靠背连发，
        //    中途改名时两遍**人数仍然相等** ⇒ 检查为真、照样并错。它只挡得住"某一遍被截断"。
        //    所以这里不是改名保险，别把它当保险读；改名风险的真正闭环要么抓第三遍 `user_id`，
        //    要么比较两遍的**姓名集合**（本次不改行为，留作已知残余风险，见 CHANGELOG）。
        if (candidates.length === 1 && openPass.length === unionPass.length) views[bot.appId] = candidates[0]
        mergeViews(peopleRows, uid, views, { name: nm || peopleRows.get(uid)?.name || '', union_id: uid })
        if (!rec.member_unions.includes(uid)) rec.member_unions.push(uid)
      }
    }
    console.log('  ✓ ' + label + ' 采完：chats=' + chats.length)
  }

  // 幂等合并：旧文件里已有、这次没采到的条目**保留**（某 bot 临时不在群里≠它不存在）。
  const merged = { generated_at: new Date().toISOString(), bots: [], people: [], chats: {} }
  if (existsSync(outPath)) {
    try {
      const old = JSON.parse(readFileSync(outPath, 'utf8'))
      for (const row of old.bots || []) {
        const k = row.union_id || ('app:' + row.app_id)
        const cur = botRows.get(k)
        if (!cur) { botRows.set(k, row); continue }
        // 🔴 0.8.0 第七轮门槛（MEDIUM）：本次**采到的条目也不能整行丢掉旧 views**。
        //   旧写法只在"这次没采到"时保留旧行 ⇒ 采到即覆盖。而采到不等于采全：
        //   open 遍失败、union 遍成功时，本条目的 views 是**空的**，照旧写法会把
        //   上一次采到的 open_id 一起抹掉（`resolveAtTarget` 只认 views[myApp] ⇒ 人变成点不了名）。
        //   合并方向：**旧为底、本次覆盖**（新数据优先，旧数据兜底）。
        cur.views = Object.assign({}, row.views || {}, cur.views || {})
        if (!cur.name && row.name) cur.name = row.name
      }
      for (const row of old.people || []) {
        const cur = peopleRows.get(row.union_id)
        if (!cur) { peopleRows.set(row.union_id, row); continue }
        cur.views = Object.assign({}, row.views || {}, cur.views || {})
        if (!cur.name && row.name) cur.name = row.name
      }
      for (const [k, v] of Object.entries(old.chats || {})) {
        if (!chatRows[k]) { chatRows[k] = v; continue }
        // 本次 **union 遍**成员没采全 ⇒ 把旧名单并回来，别让一次接口失败把收窄能力清空
        // （open 遍失败不走这里，理由见上面 `membersFailed` 的注释）
        if (chatRows[k].members_incomplete && Array.isArray(v.member_unions) && v.member_unions.length) {
          for (const u of v.member_unions) if (!chatRows[k].member_unions.includes(u)) chatRows[k].member_unions.push(u)
        }
      }
    } catch { console.error('  ! 旧 roster 解析失败，按全新采集覆盖') }
  }
  merged.bots = [...botRows.values()]
  merged.people = [...peopleRows.values()]
  merged.chats = chatRows

  if (!merged.bots.length || !Object.keys(merged.chats).length) {
    console.error('采集结果为空（bots 或 chats 缺失），**不写文件**、保留上一版。')
    process.exit(1)
  }
  if (args.dryRun) {
    console.log('[dry-run] bots=' + merged.bots.length + ' people=' + merged.people.length
      + ' chats=' + Object.keys(merged.chats).length)
    return
  }
  const tmp = outPath + '.tmp'
  // 写之前把目标目录建出来（第十二轮门槛 LOW）：`--out` / `FS_CONFIG_DIR` 指向一个还不存在的
  //   目录时，原来直接 ENOENT，最后只由 main().catch 吐一句「采集失败（不写文件）」+ 栈，
  //   看不出是目录问题。插件侧写配置就是这个口径（mkdirSync recursive）。
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 })
  renameSync(tmp, outPath)
  try { chmodSync(outPath, 0o600) } catch { /* Windows 无 POSIX 权限位，尽力而为 */ }
  console.log('✅ 写入 ' + outPath + '（bots=' + merged.bots.length
    + ' people=' + merged.people.length + ' chats=' + Object.keys(merged.chats).length + '）')
}

main().catch((error) => {
  console.error('采集失败（不写文件）: ' + String(error && error.stack || error))
  process.exit(1)
})
