#!/usr/bin/env node
// V0.1.1-26100603 — collect_bot_roster.mjs 的写盘判据守护用例（dsh-feishucard 0.8.2）
// 变更：-26100603 第十九轮门槛 LOW×3 + 新格×2 —— ①路由改为**锚定**匹配，未建模的接口
//       不再回 `{code:0}`（原来 `u.includes('/im/v1/chats')` 连 `/chats/<id>/members` 一起吞，
//       一旦某格真返回群，成员请求就会拿到"群列表"这份驴唇不对马嘴的载荷还被判成功 ——
//       正是本套用例要防的"绿机器"形态）；②`mode` 改成**逐格可注入**的群列表（原来三格
//       恒为 `items: []`，"旧文件坏 + 本次采到群"这一形态根本没被跑过）；③补 try/finally
//       收桩服务器与临时目录、`listen` 失败走 reject；④新增 S4（钉 MEDIUM#1 提闸）与
//       S5（钉 MEDIUM#2：发过 HTTP 后的失败出口必须是干净 rc=1，不是 libuv 断言中止 3221226505）。
// 变更：-26100602 首建（第十八轮门槛 MEDIUM 的取证夹具转正）。
//
// 为什么要转正（而不是当一次性夹具删掉）：`collect_bot_roster.mjs` 长期**零冒烟覆盖**
//   （功能基线「缺口 #7」），它「什么时候拒绝覆盖上一版名单」这条判据此前只被
//   `node --check` 过语法、被注释和人相信过。第十八轮门槛就是在这条缝里报出 MEDIUM 的
//   （旧文件坏掉读不出时，一份空 chats 会把可能有效的名单覆盖掉）。修完如果不留用例，
//   下一次改这个脚本照样可能把它改回去 —— 与本仓库「先红后绿 + 守护用例」的口径一致。
//
// 五格各钉什么：
//   S1 旧文件**存在但解析失败** + 本次没采到群 ⇒ 非零退出、**不写文件**（旧字节一字不动）。
//   S2 旧文件**根本不存在** + 本次没采到群 ⇒ rc=0、照常写盘、chats=0
//      （第十五轮那条合法降级不能被 S1 的收紧打死）。
//   S3 旧文件可读且有一个群 + 本次没采到群 ⇒ rc=0、旧群并回来（幂等合并主路径）。
//   S4 旧文件**存在但解析失败** + 本次**采到 1 个群** ⇒ 仍然非零退出、旧字节一字不动
//      （第十九轮 MEDIUM#1：闸门原来嵌在"chats 为空"里面 ⇒ 部分覆盖照样放行。
//        这一格在修前的字节上必红 —— 反证见功能基线该轮记录）。
//   S5 接口在**已发过请求之后**抛错（bot/v3/info 回非零 code）⇒ 干净 rc=1 且日志里
//      没有 libuv 断言（MEDIUM#2 与 `bots 为空` 那处的同源修法）。
//
// 打的是**桩**：接口基址由 `FS_OPEN_API_BASE` 注入（被测脚本里的唯一出口），默认值仍是真接口。
// 🔴 必须用**异步** spawn：桩服务器跑在本进程里，`spawnSync` 会阻塞事件循环 ⇒
//   子进程的请求没人应答，全部超时（首版就栽在这，红的是夹具不是被测代码）。
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const COLLECTOR = join(HERE, 'collect_bot_roster.mjs')
const DIR = join(tmpdir(), 'dsh-roster-guard-' + process.pid)
mkdirSync(DIR, { recursive: true })
const CFG = join(DIR, 'feishu.config.json')
const OUT = join(DIR, 'bot_roster.json')
writeFileSync(CFG, JSON.stringify({
  bots: [{ name: 'guard', appId: 'cli_guard_bot', appSecret: 'secret-guard' }],
}))

// 每格先设置 mode，再由桩按它决定应答形态：
//   no-chats   ⇒ 会话列表为空（"本次一个群也没采到"）
//   one-chat   ⇒ 会话列表给一个群，成员两遍各给一个人（S4 需要的"部分覆盖"靶心）
//   fail-bot   ⇒ token 正常拿到、`bot/v3/info` 回非零 ⇒ 采集**发过 HTTP 之后**抛错（S5）
let mode = 'no-chats'

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const srv = createServer((req, res) => {
  const u = req.url || ''
  const send = (obj, status) => {
    res.writeHead(status || 200, JSON_HEADERS)
    res.end(JSON.stringify(obj))
  }
  // 🔴 锚定匹配，不用 `includes`（第十九轮门槛 LOW）：`includes('/im/v1/chats')` 会同时
  //   命中 `/im/v1/chats/<id>/members` ⇒ 成员请求被回一份"群列表"，而那份载荷的
  //   `items: []` 会被当成"这个群没有成员"并置上 `members_collected` —— 假绿灯。
  if (/^\/open-apis\/auth\/v3\/tenant_access_token\/internal/.test(u)) {
    return send({ code: 0, tenant_access_token: 't_guard', expire: 100 })
  }
  if (/^\/open-apis\/bot\/v3\/info(\?|$)/.test(u)) {
    if (mode === 'fail-bot') return send({ code: 9999991, msg: 'stub forced failure (bot/v3/info)' })
    return send({ code: 0, bot: { open_id: 'ou_guardbot', union_id: 'on_guardbot', app_name: 'guard bot' } })
  }
  if (/^\/open-apis\/im\/v1\/chats\/[^/]+\/members(\?|$)/.test(u)) {
    const idType = /member_id_type=union_id/.test(u) ? 'union_id' : 'open_id'
    return send({
      code: 0,
      data: {
        items: [{
          member_id: idType === 'union_id' ? 'on_guardmember' : 'ou_guardmember',
          member_id_type: idType, name: '张三',
        }],
        has_more: false,
      },
    })
  }
  if (/^\/open-apis\/im\/v1\/chats(\?|$)/.test(u)) {
    return send({
      code: 0,
      data: {
        items: mode === 'one-chat' ? [{ chat_id: 'oc_guard_live', name: '本次群' }] : [],
        has_more: false,
      },
    })
  }
  // 未建模的接口 ⇒ 明确失败（非零 code，且带 HTTP 404），让被测脚本抛错、用例转红，
  //   而不是回 `{code:0}` 把"调错了接口"洗成成功。
  return send({ code: 40400, msg: 'UNMODELLED ROUTE ' + u }, 404)
})

// 端口要等 `listen` 之后才知道 ⇒ BASE 在 try 里面赋值（早先写在顶层会在 listen 前
//   拿到 `address() === null` 而抛 TypeError）。
let BASE = ''

function runCollector() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COLLECTOR, '--config', CFG, '--out', OUT], {
      env: Object.assign({}, process.env, { FS_OPEN_API_BASE: BASE }),
    })
    let log = ''
    child.stdout.on('data', (d) => { log += d })
    child.stderr.on('data', (d) => { log += d })
    // 超时护栏（A19）：桩在本地，正常一格秒级；卡住必须杀进程报错，不能让整套餐死。
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('采集子进程 30 秒未退出（桩接口卡住？）日志：' + log.trim()))
    }, 30000)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, log }) })
  })
}

const CORRUPT = '{ 这不是 JSON'
const VALID_OLD = JSON.stringify({
  generated_at: 'x', bots: [], people: [],
  chats: { oc_guard_old: { name: '老群', bot_app_ids: ['cli_guard_bot'], member_unions: ['on_a'] } },
})

let fail = 0
const check = (label, cond, detail) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (cond ? '' : '｜' + detail))
  if (!cond) fail += 1
}

async function cell(name, seed, stubMode, expect) {
  mode = stubMode
  if (existsSync(OUT)) rmSync(OUT)
  if (seed !== null) writeFileSync(OUT, seed)
  const before = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null
  const r = await runCollector()
  const after = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null
  let chats = 'NO-FILE'
  if (after !== null) {
    try { chats = Object.keys(JSON.parse(after).chats || {}).length } catch { chats = 'UNPARSEABLE' }
  }
  console.log(name)
  check('退出码 ' + r.code + '（期望 ' + expect.rc + '）', r.code === expect.rc,
    '日志末尾：' + r.log.trim().split('\n').slice(-1)[0])
  if (expect.logIn) {
    check('日志写明「' + expect.logIn + '」', r.log.includes(expect.logIn), '实际日志：' + r.log.trim())
  }
  // Windows 上 `process.exit` 在发过 HTTP 之后会撞 libuv 断言（rc 变 3221226505）——
  //   这条检查把它钉死：非零必须是**干净**的非零。
  if (expect.cleanExit) {
    check('干净退出（无 libuv 断言中止）', r.code !== 3221226505 && !r.log.includes('Assertion failed'),
      'rc=' + r.code + '｜' + r.log.trim().split('\n').slice(0, 2).join(' / '))
  }
  if (expect.unchanged) {
    check('旧文件字节一字未动（没被本次采集覆盖）', after === before, '写盘后 chats=' + chats)
  }
  if (expect.chats !== undefined) {
    check('写盘后 chats=' + chats + '（期望 ' + expect.chats + '）', chats === expect.chats, '实际 chats=' + chats)
  }
}

try {
  await new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', resolve)
  })
  BASE = 'http://127.0.0.1:' + srv.address().port + '/open-apis'

  // S1：旧名单在、但这一遍读不出 ⇒ 无法判断里面有没有群 ⇒ 宁可不写
  await cell('S1 旧文件读不出 + 本次没有群 ⇒ 拒绝写盘、非零退出', CORRUPT, 'no-chats', {
    rc: 1, logIn: '无法判断旧文件里是否有群', unchanged: true,
  })
  // S2：纯单聊/新装的 bot 一个群也没有，是**合法状态**（第十五轮 MEDIUM#2）
  await cell('S2 旧文件根本没有 + 本次没有群 ⇒ 合法，必须写盘', null, 'no-chats', {
    rc: 0, logIn: '本次没有任何群', chats: 0,
  })
  // S3：本次没采到不等于「群没了」，旧条目要并回来（幂等合并）
  await cell('S3 旧文件可读且有一个群 + 本次没有群 ⇒ 旧群并回来', VALID_OLD, 'no-chats', {
    rc: 0, chats: 1,
  })
  // S4：闸门必须**不看 chats 是否为空**——采到 1 个群也替代不了一份读不出的旧名单
  await cell('S4 旧文件读不出 + 本次采到 1 个群 ⇒ 仍然拒绝写盘、旧字节不动', CORRUPT, 'one-chat', {
    rc: 1, logIn: '无法判断旧文件里是否有群', unchanged: true,
  })
  // S5：失败路径要在发过 HTTP 之后仍然干净退出
  await cell('S5 发过请求后接口抛错 ⇒ 非零且不出现 libuv 断言中止', VALID_OLD, 'fail-bot', {
    rc: 1, logIn: '采集失败（不写文件）', unchanged: true, cleanExit: true,
  })
} finally {
  srv.close()
  rmSync(DIR, { recursive: true, force: true })
}

if (fail) {
  console.log('ROSTER GUARD FAIL (' + fail + ' 项不通过)')
  process.exitCode = 1
} else {
  console.log('ROSTER GUARD PASS (5/5 格)')
}
