#!/usr/bin/env node
// V0.1.3-26100801 — collect_bot_roster.mjs 的写盘判据守护用例（dsh-feishucard 0.8.4）
// 变更：-26100801 第四十二轮 LOW#7 + 第五十一轮 LOW#3/#4 —— ①新增 S11（people 行"新值赢陈旧
//       种子"的正向半边）；②新增 S12 驱动 `token-stream-error` 出口（此前该出口无任何格子演到，
//       删掉它整套照样绿 ⇒ 补驱动并断 `code=9999996`）；③加 `collectorRunning` 串行护栏
//       （桩按模块级 `mode` 路由，两格并发会互相串味＝误导性绿灯）；④陈旧/种子身份守卫的
//       报错文案改为点名**实际被守护的格集**（S6/S7/S11）。
// 变更：-26100701 第二十二~二十六轮门槛 —— ①补 S6/S7（C4：views 旧为底合并 + 群级正向标记）
//       并格数改动态计数；②token 按 app_id 签发、bot/v3/info 删静默降级改 9999994 显式失败、
//       缺 app_id ⇒ 9999990（S8 驱动）、S6/S7 补前提断言 logIn；③第二十六轮：S6 种子 views
//       补陈旧他键（整行覆盖必红）、新增 S9（并回分支正向对照，M#1）与 S10（身份守卫驱动，L#6）。
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
// 十二格各钉什么：
//   S1 旧文件**存在但解析失败** + 本次没采到群 ⇒ 非零退出、**不写文件**（旧字节一字不动）。
//   S2 旧文件**根本不存在** + 本次没采到群 ⇒ rc=0、照常写盘、chats=0
//      （第十五轮那条合法降级不能被 S1 的收紧打死）。
//   S3 旧文件可读且有一个群 + 本次没采到群 ⇒ rc=0、旧群并回来（幂等合并主路径）。
//   S4 旧文件**存在但解析失败** + 本次**采到 1 个群** ⇒ 仍然非零退出、旧字节一字不动
//      （第十九轮 MEDIUM#1：闸门原来嵌在"chats 为空"里面 ⇒ 部分覆盖照样放行。
//        这一格在修前的字节上必红 —— 反证见功能基线该轮记录）。
//   S5 接口在**已发过请求之后**抛错（bot/v3/info 回非零 code）⇒ 干净 rc=1 且日志里
//      没有 libuv 断言（MEDIUM#2 与 `bots 为空` 那处的同源修法）。
//   S6 open 遍失败 + union 遍成功 ⇒ people/bot 行的 views 旧为底合并、新值赢同名键（C4/M3）。
//   S7 双 bot 同群：A union 失败 + B 全成功 ⇒ 已退群者不被并回（C4/M1 群级正向标记）。
//   S8 token 请求体被弄坏 ⇒ 桩的"缺 app_id ⇒ 显式失败"分支被真的演到（第二十三轮 LOW#2）。
//   S9 单 bot union 遍失败 ⇒ 旧群名单**并回来**（第二十六轮 MEDIUM#1：S7 只钉"不许并"，
//      并回那条正向分支删掉也全绿 ⇒ 这里补正向对照，判别力闭环到 collect 侧合并处）。
//   S10 bot appId 不以 cli_ 开头 ⇒ 桩的"bearer 推不出身份 ⇒ 9999994 显式失败"分支被演到
//      （第二十六轮 LOW#6：该分支是"删静默降级"的替代品，没格子驱动＝回退也不会红）。
//   S11 people 行两遍采全 ⇒ 同键**新值赢**陈旧种子、他键存活（第四十二轮 LOW#7：S6 只演了
//      "旧为底不被抹"半边，"新赢旧"对 people 行从没被驱动——方向放反（旧赢）整套照样绿）。
//   S12 token 请求**流中途 error**（桩在 `res.end` 之前 `req.emit('error')`）⇒ 采集脚本按
//      `code=9999996` 显式失败、非零退出、旧文件字节不动（第五十一轮 LOW#3：这个出口此前
//      没有任何格子演到 ⇒ 删掉它（等于恢复"请求永不应答、整轮等 30 秒护栏"的挂死形状）
//      十一格照样全绿。补驱动是为了让**桩的每条出口都有格子负责**，不是为新增业务判据）。
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
// 🔴 第四十一轮门槛 LOW#1（核对为真，**按建议改 unconditional**）：上一轮的 exit 兜底带
//   `!setupOk` 门——setupOk 置真后只剩主 try 的 finally 护着，而**桩回调里的抛错**
//   （双 send/流分支）与任何旁路 process.exit 都不走 finally，凭证形状配置照样泄漏。
//   rmSync(force) 幂等，兜底改**无条件**：exit 就清，finally 清过也是空转；
//   setupOk 与守卫里的原地 rmSync（撞车 exit(2) 同样触发 exit 兜底）随之删除。
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }) } catch { /* 尽力而为 */ } })
mkdirSync(DIR, { recursive: true })
const CFG = join(DIR, 'feishu.config.json')
const OUT = join(DIR, 'bot_roster.json')
// 🔴 第三十六轮门槛 LOW#1（核对为真）：同一组夹具标识符原来在桩应答、种子、断言三处
//   **各抄一份字面量**——改一处忘别处 ⇒ 桩载荷和格子判定的对象悄悄错开，红了指向错误
//   根因（甚至把要演分支洗成恒真）。与本文件 TOKEN_PREFIX/openIdOf 的单一来源纪律对齐。
const APP_GUARD = 'cli_guard_bot'
const CHAT_LIVE = 'oc_guard_live'
const MEMBER_UNION = 'on_guardmember'
const MEMBER_OPEN = 'ou_guardmember'
// 🔴 第三十七轮门槛 MEDIUM#2/LOW#2（核对为真）：种子与判据共享的其余标识符同样收源；
//   两个"陈旧值"**必须**与当场新采值不相等（S6 靠差值判别"新赢旧"，写成 openIdOf(APP_GUARD)
//   同值就把合并方向判别洗成恒真——改名/漂移时这里先红）。
const STALE_OPEN_GUARD = 'ou_guardbot'
const STALE_KEY = 'cli_other_bot'
const STALE_OTHER_OPEN = 'ou_stale_other'
const MEMBER_LEFT = 'on_already_left'
const MEMBER_KEEP = 'on_left_but_keep'
// 🔴 第四十二轮门槛 LOW#3（核对为真）：ghost 夹具身份原来只在内联字面量里活着——本文件
//   的单一来源纪律（APP_GUARD/MEMBER_OPEN/openIdOf 全收源）不该有例外，将来任何种子/
//   断言复用这个值时字面量必漂移。收源。
const GHOST_MEMBER_ID = 'ou_ghost_a'
// 🔴 第四十二轮门槛 LOW#7（核对为真）：people 行的**陈旧种子值**——原来 S6 直接拿
//   MEMBER_OPEN（open 遍新采值）当种子，"保留旧值"和"新值写入"在这个形状里同值不可分；
//   且"新赢旧"方向对 people 行从来没被任何格子演过。单立种子值并补 S11 正向格。
const STALE_PEOPLE_OPEN = 'ou_stale_person'
const STALE_PEOPLE_OTHER = 'ou_stale_person_other'
writeFileSync(CFG, JSON.stringify({
  bots: [{ name: 'guard', appId: APP_GUARD, appSecret: 'secret-guard' }],
}))
// S7 需要**两个 bot 在同一个群**（M1 的靶心形状）⇒ 单独一份配置；每格经 `cell(..., expect.cfgPath)`
//   按路径选用（`runCollector` 透传给 `--config`），不存在"跑前换入跑完换回"的全局动作。
// 🔴 第二十四轮门槛 LOW（核对为真）：bots 数组留成常量，bot A 的 bearer 由它**真实派生**
//   （旧写法是手抄字面量冒充"派生"，改了 CFG2 忘改字面量 ⇒ S7 静默不演目标分支）。
const TWO_BOTS = [
  { name: 'botA', appId: 'cli_a1', appSecret: 'secret-a' },
  { name: 'botB', appId: 'cli_b1', appSecret: 'secret-b' },
]
// 🔴 第二十八轮门槛 LOW#1：token 的**签发形状**收单一来源——桩签发（`tenant_access_token`）
//   与 bot A 的 bearer 都由 TOKEN_PREFIX 拼出，改签名格式只会两边同改，不会让 S7 的
//   ghost 判定静默失配（失配＝union 失败分支没被演、断言退化成恒真）。
const TOKEN_PREFIX = 't_'
const BOT_A_AUTH = 'Bearer ' + TOKEN_PREFIX + TWO_BOTS[0].appId
// 🔴 第三十一轮门槛 LOW#2（核对为真）：两个桩处理分支（bot/v3/info 的身份正则、members 的
//   ghost 判定）原本各抄一份同款取值表达式——本文件对共享值讲究单一来源，header 取值也一样，
//   收进 authOf 一处。
const authOf = (req) => String((req.headers && req.headers.authorization) || '')
// 🔴 第三十三轮门槛 LOW#1（核对为真）：bot 身份形状（`ou_`/`on_` + appId）此前**桩与断言各抄
//   一份字面量**——默认 appId 或前缀哪天改名，断言红得与它测的东西无关。与本文件
//   TOKEN_PREFIX/authOf/ERR 同一套单一来源纪律：形状只在这两个 helper 里定义。
const openIdOf = (appId) => 'ou_' + appId
const unionIdOf = (appId) => 'on_' + appId
// 🔴 第三十七轮门槛 MEDIUM#2：判别力前提机器化——陈旧种子值一旦和新采值同形，
//   S6"新赢旧"就退化成恒真；当场拦下（放在 helper 之后，之前踩过 TDZ 引用坑）。
// 🔴 第三十八轮门槛 LOW#1（核对为真）：原第二子句 `STALE_OTHER_OPEN === openIdOf(STALE_KEY)`
//   防的是**不存在的碰撞**（STALE_KEY 从来不是被采集的 appId）。真不变量＝陈旧键不许和
//   任何**真被采集**的 appId 撞车——按真实不变量改写，不留假保险。
// 🔴 第四十一轮门槛 LOW#3（核对为真）：S7 的新种子 MEMBER_LEFT 同属"必须与新采值相异"
//   的判别力前提——它与 MEMBER_UNION 撞车时 S7 首条判据当场退化；同口径一并机器化。
// 🔴 第四十二轮门槛 LOW#2 的 MEMBER_KEEP 子句已由第四十六轮 LOW#3 删除（核对为真）：
//   S9 走 fail-union，union 遍恒空 ⇒ "并回"的新采侧**没有任何值**可能满足 includes(MEMBER_KEEP)，
//   撞车也不退化——这条防的是不存在的碰撞，属第三十八轮钉过的"假保险"同类，不留。
//   STALE_PEOPLE_OPEN（撞 open 遍新采值 MEMBER_OPEN 时 S6/S11 双双退化成恒真）是真前提，保留。
//   第三十九轮 LOW#2 的原地 rmSync 已删：exit 兜底改无条件后 process.exit(2) 必触发它。
if (STALE_OPEN_GUARD === openIdOf(APP_GUARD)
  || STALE_KEY === APP_GUARD || TWO_BOTS.some((b) => b.appId === STALE_KEY)
  || MEMBER_LEFT === MEMBER_UNION
  || STALE_PEOPLE_OPEN === MEMBER_OPEN) {
  console.error('ROSTER GUARD SETUP ERROR: 陈旧/种子身份与真采集值碰撞，S6/S7/S11 判别力退化成恒真')
  process.exit(2)
}
const CFG2 = join(DIR, 'feishu.two-bots.json')
writeFileSync(CFG2, JSON.stringify({
  bots: TWO_BOTS,
}))
// S10（第二十六轮 LOW#6）需要一个 **appId 不以 cli_ 开头**的 bot：token 分支照样签发
//   `t_zz_notcli`，但 bot/v3/info 的 `/^Bearer t_(cli_.+)$/` 不命中 ⇒ 桩显式 9999994。
//   这一格专吃"删掉静默降级后新加的身份守卫"——没有它，守卫被回退也不会红。
const CFG3 = join(DIR, 'feishu.noncli.json')
writeFileSync(CFG3, JSON.stringify({
  bots: [{ name: 'legacy', appId: 'zz_notcli', appSecret: 'secret-x' }],
}))

// 每格先设置 mode，再由桩按它决定应答形态：
//   no-chats   ⇒ 会话列表为空（"本次一个群也没采到"）
//   one-chat   ⇒ 会话列表给一个群，成员两遍各给一个人（S4 需要的"部分覆盖"靶心）
//   fail-bot   ⇒ token 正常拿到、`bot/v3/info` 回非零 ⇒ 采集**发过 HTTP 之后**抛错（S5）
//   fail-open  ⇒ open 遍成员接口回非零、union 遍正常（S6：钉 M3 的 `views` 旧为底合并）
//   fail-union ⇒ 给一个群但 **union 遍恒失败**（S9：钉"members_incomplete ⇒ 并回旧名单"正向分支）
//   m1-two-bot ⇒ 双 bot 同群：bot A 的 union 遍失败、bot B 两遍全成功（S7：钉 M1 群级正向标记）
//   bad-token  ⇒ token 请求体被弄坏 ⇒ 桩显式拒绝签发（S8：钉住"缺 app_id ⇒ 9999990"分支本身）
// （bot A 的 bearer 常量 BOT_A_AUTH 在文件头部由 TWO_BOTS 真实派生，两处判等共用。）
// 🔴 第二十七轮门槛 MEDIUM#1（核对为真）：**哪些 mode 要给一个群**原来是 chats 分支里的
//   内联枚举——和 mode 语义分居两处，新增需要群的 mode 一旦忘了登记，格子静默不演目标分支。
//   收成唯一来源：mode 文档改一处 + Set 加一项，chats 分支只查集合。
const CHAT_MODES = new Set(['one-chat', 'fail-open', 'm1-two-bot', 'fail-union'])
// 🔴 第二十七轮门槛 LOW#1：桩的"显式失败"错误码在 handler 与格子 logIn 断言两处各写一遍
//   字面量 ⇒ 收成命名常量，断言由**同一常量**拼出，改号必同改、漂移当场红。
const ERR = {
  missingAppId: 9999990,   // token 请求体没有 app_id（S8 驱动）
  forcedBotInfo: 9999991,  // fail-bot：bot/v3/info 恒失败（S5 驱动）
  forcedOpenPass: 9999992, // fail-open：open 遍失败（S6 前提）
  ghostUnionA: 9999993,    // m1-two-bot：仅 bot A 的 union 遍失败（S7 前提）
  underivableBearer: 9999994, // bearer 推不出身份（S10 驱动）
  forcedUnionPass: 9999995, // fail-union：union 遍恒失败（S9 前提）
  // 🔴 第四十轮门槛 LOW#2（核对为真）：流中断支原来借 9999990（missingAppId）作答——
  //   两个不同成因共用一个码，将来哪格真演流中断，logIn 判据在"缺 app_id"支下也照样绿，
  //   违反本文件"一分支一码、断言可判别"的 ERR 纪律。单立一号。
  // 🔴 第四十三轮门槛 LOW#2 曾"判不修、如实挂账"说这个出口从 harness 侧够不着；
  //   第五十一轮 LOW#3 **改判并已驱动**（桩在 data/end 之前同步 emit error，S12 钉 code=9999996）。
  tokenStreamError: 9999996, // token 请求流中途 error（S12 驱动，第五十一轮 LOW#3）
}
// 🔴 第二十八轮门槛 LOW#2：采集器的"成员拉取失败(idType)"留痕文案被 S6/S7/S9 三格当**前提断言**
//   逐字重复——采集侧改一个词三格同红但没人知道该改哪。收成一份，断言由它拼出。
const LOG_MEMBER_FAIL = '成员拉取失败'
let mode = 'no-chats'

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const srv = createServer((req, res) => {
  const u = req.url || ''
  const send = (obj, status) => {
    // 🔴 第四十二轮门槛 MEDIUM（核对为真）：token 支的 error 出口与 end 支可对**同一个 res**
    //   各调一次 send（流先 error、随后 end 照常到达的形状真实存在），第二次
    //   writeHead 抛 ERR_HTTP_HEADERS_SENT——它从请求回调里冒出来，主 try/finally 抓不到，
    //   整轮守护在 PASS/FAIL 打印**前**崩掉＝红得没头没尾。send 幂等化，二次调用直接吃下。
    if (res.headersSent || res.writableEnded) return
    res.writeHead(status || 200, JSON_HEADERS)
    res.end(JSON.stringify(obj))
  }
  // 🔴 锚定匹配，不用 `includes`（第十九轮门槛 LOW）：`includes('/im/v1/chats')` 会同时
  //   命中 `/im/v1/chats/<id>/members` ⇒ 成员请求被回一份"群列表"，而那份载荷的
  //   `items: []` 会被当成"这个群没有成员"并置上 `members_collected` —— 假绿灯。
  // token 按 app_id 签发（`t_<appId>`），让桩能区分"是哪个 bot 在调成员接口"——
  //   S7 需要 A 失败、B 成功，单 token 分不开两个 bot。
  if (/^\/open-apis\/auth\/v3\/tenant_access_token\/internal/.test(u)) {
    // 🔴 第三十九轮门槛 LOW#1（核对为真）：①原来只挂 data/end——请求流中途 error ⇒ 这一路
    //   **永不作答**，采集器干等 30 秒护栏，CI 红得看不懂；补 error 出口。
    //   ②`body += chunk` 逐块 toString，UTF-8 多字节被块边界劈开会碎码（当前 body 是
    //   ASCII 碰不到，但属埋雷）；改成攒块、end 时**一次**解码。
    const chunks = []
    req.on('data', (chunk) => { chunks.push(chunk) })
    req.on('error', () => send({ code: ERR.tokenStreamError, msg: 'stub: token request stream errored' }, 400))
    // 🔴 第五十一轮 LOW#3（核对为真，**改判**第四十三轮那条"判不修挂账"）：这个出口一直没有
    //   格子驱动＝把 `req.on('error')` 整行删掉全套照样绿（第二十三轮 LOW#1 立的
    //   "新加的显式失败分支若没格子驱动，回退掉也不会红"）。驱动方式其实够得着：
    //   在 data/end 之前**同步**把 error 事件打出来（监听器已挂上、请求体还没开始流），
    //   桩就按单立的 9999996 作答 ⇒ S12 钉的是**具体错误码**（不是泛用失败文案，24 轮 MEDIUM#2 口径）。
    //   随后真 end 到达时那一次 send 被幂等守卫吃下——顺带把第四十二轮的幂等也演到了。
    if (mode === 'token-stream-error') req.emit('error', new Error('stub: forced token stream error'))
    req.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8')
      // 🔴 第二十三轮门槛 LOW#2：`bad-token` 格故意弄坏请求体 ⇒ 真正走到下面"缺 app_id ⇒ 显式
      //   失败"那条分支（S8 钉它；此前这条守卫没被任何格子演过，回退掉也没人变红）。
      if (mode === 'bad-token') body = '{broken'
      let appId = ''
      try { appId = String(JSON.parse(body).app_id || '') } catch { appId = '' }
      // 🔴 第二十二轮门槛 LOW#1（核对为真）：原注释说"坏 body 让脚本自己报"，实际是
      //   appId 留空 ⇒ 回 `t_` ⇒ bot/info 的 `/^Bearer t_(cli_.+)$/` 不命中 ⇒ 静默降级回
      //   ou_guardbot 形状，采集器哪天不发 app_id 都不会有人发现。改成桩显式失败。
      if (!appId) return send({ code: ERR.missingAppId, msg: 'stub: token request missing app_id' })
      send({ code: 0, tenant_access_token: TOKEN_PREFIX + appId, expire: 100 })
    })
    return
  }
  if (/^\/open-apis\/bot\/v3\/info(\?|$)/.test(u)) {
    if (mode === 'fail-bot') return send({ code: ERR.forcedBotInfo, msg: 'stub forced failure (bot/v3/info)' })
    // 🔴 第二十三轮门槛 MEDIUM#1（核对为真）：删掉"bearer 不匹配就回 guard-bot 形状"的静默
    //   降级——token 分支只拦**空** app_id，夹具里一个不以 cli_ 开头的 appId 就会拿着
    //   `t_<appId>` 落到兜底身份上，身份断言验的却是**错的人**。不匹配 ⇒ 桩显式失败。
    // 🔴 第二十九轮门槛 MEDIUM#1（核对为真）：这里曾是 TOKEN_PREFIX 的**第三份未同步拷贝**
    //   （字面 `t_` 焊在正则里）——前缀哪天改了，普通 cli_ bot 反而全被打成 9999994，
    //   S6/S7 红得与它们测的东西毫无关系。正则由 TOKEN_PREFIX 构造，签名只此一处。
    // 🔴 第三十轮门槛 LOW#1（核对为真）：TOKEN_PREFIX 嵌进正则前必须**转义**——它一旦含
    //   正则元字符（`.` `+` `(` …），身份守卫会静默错配/漏配，所有 cli_ bot 被打成
    //   9999994，恰好砸掉这块想保的健壮性。
    const bearerRe = new RegExp('^Bearer ' + TOKEN_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(cli_.+)$')
    const bi = bearerRe.exec(authOf(req))
    if (!bi) return send({ code: ERR.underivableBearer, msg: 'stub: bot/v3/info cannot derive identity from bearer' })
    return send({
      code: 0,
      bot: {
        open_id: openIdOf(bi[1]),
        union_id: unionIdOf(bi[1]),
        app_name: 'guard bot',
      },
    })
  }
  if (/^\/open-apis\/im\/v1\/chats\/[^/]+\/members(\?|$)/.test(u)) {
    const idType = /member_id_type=union_id/.test(u) ? 'union_id' : 'open_id'
    // 🔴 第二十九轮门槛 LOW#2 ⇒ 第三十一轮 LOW#2：取值收进 authOf（两处共用一个来源）。
    const auth = authOf(req)
    const isGhost = mode === 'm1-two-bot' && auth === BOT_A_AUTH
    if (mode === 'fail-open' && idType === 'open_id') return send({ code: ERR.forcedOpenPass, msg: 'stub forced open-pass failure' })
    // 🔴 第二十六轮门槛 MEDIUM#1：S9 需要"单 bot、本遍 union 恒失败"⇒ members_incomplete
    //   置位且无人采全，把 collect 侧"并回旧名单"的正向分支真的演一遍（S7 只有负向）。
    if (mode === 'fail-union' && idType === 'union_id') return send({ code: ERR.forcedUnionPass, msg: 'stub forced union failure' })
    if (isGhost && idType === 'union_id') {
      return send({ code: ERR.ghostUnionA, msg: 'stub union failure from bot A only' })
    }
    // 🔴 第二十二轮门槛 MEDIUM#1（核对为真）：拆开 (mode, auth) 判定，消掉嵌套三元与
    //   重复字面量——同一份成员对象只在一处构造，改夹具时不会静默翻转某个分支。
    // 🔴 同轮 LOW#2：A 的 union 遍已在上面提前返回 ⇒ 走到这里的 A 只可能是 open 遍。
    // 🔴 第三十轮门槛 LOW#2（核对为真）：ghost 分支改为**提前返回**——旧写法在 ternary 外
    //   恒计算 liveMemberId，ghost 支路根本用不到，与第二十七轮 LOW#2 注释（"身份值只在
    //   非 ghost 分支内算"）相矛盾。提前返回让代码与注释一致，顺带消掉外层三元。
    if (isGhost) {
      // A 的 open 遍：给一个**无 name** 的成员 ⇒ 即使并 view 也因无名而落不进 byName，
      //   这一格要钉的是群级名单合并，不是人名配对。
      return send({ code: 0, data: { items: [{ member_id: GHOST_MEMBER_ID, member_id_type: idType, name: '' }], has_more: false } })
    }
    const liveMemberId = idType === 'union_id' ? MEMBER_UNION : MEMBER_OPEN
    const member = { member_id: liveMemberId, member_id_type: idType, name: '张三' }
    return send({ code: 0, data: { items: [member], has_more: false } })
  }
  if (/^\/open-apis\/im\/v1\/chats(\?|$)/.test(u)) {
    return send({
      code: 0,
      data: {
        items: CHAT_MODES.has(mode)
          ? [{ chat_id: CHAT_LIVE, name: '本次群' }] : [],
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

// 🔴 第五十一轮 LOW#4（核对为真）：桩的路由读的是**模块级 `mode`**（由 cell() 在 spawn 前设置）、
//   且所有格子共用同一个 server 实例 ⇒ 两格并发就会让其中一格拿另一格的 mode 作答，
//   红/绿都不可信。现在每格确实 `await cell(...)`，但那是**约定**不是**约束**——
//   加一道闸：同一时刻只许有一个采集子进程，违者当场 exit 2（响亮失败，别等漂移后静默冒名）。
let collectorRunning = false
function runCollector(cfgPath) {
  if (collectorRunning) {
    console.error('ROSTER GUARD SETUP ERROR: 上一格的采集子进程还没退出就起了下一格——'
      + '桩按全局 mode 路由，并发会让两格互相冒名作答（判据红绿都不可信）')
    process.exit(2)
  }
  collectorRunning = true
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COLLECTOR, '--config', cfgPath || CFG, '--out', OUT], {
      env: Object.assign({}, process.env, { FS_OPEN_API_BASE: BASE }),
    })
    let log = ''
    child.stdout.on('data', (d) => { log += d })
    child.stderr.on('data', (d) => { log += d })
    // 超时护栏（A19）：桩在本地，正常一格秒级；卡住必须杀进程报错，不能让整套餐死。
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      collectorRunning = false
      reject(new Error('采集子进程 30 秒未退出（桩接口卡住？）日志：' + log.trim()))
    }, 30000)
    child.on('error', (e) => { clearTimeout(timer); collectorRunning = false; reject(e) })
    child.on('close', (code) => { clearTimeout(timer); collectorRunning = false; resolve({ code, log }) })
  })
}

const CORRUPT = '{ 这不是 JSON'
const VALID_OLD = JSON.stringify({
  generated_at: 'x', bots: [], people: [],
  chats: { oc_guard_old: { name: '老群', bot_app_ids: [APP_GUARD], member_unions: ['on_a'] } },
})

let fail = 0
// 🔴 第二十四轮门槛 LOW：通过行的格数**动态计数**（旧写法硬编码 5/5，加减格子忘改
//   这一行就会报出与实际执行不符的总数）。
let cellsDone = 0
const check = (label, cond, detail) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (cond ? '' : '｜' + detail))
  if (!cond) fail += 1
}

async function cell(name, seed, stubMode, expect) {
  cellsDone += 1
  mode = stubMode
  if (existsSync(OUT)) rmSync(OUT)
  if (seed !== null) writeFileSync(OUT, seed)
  const before = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null
  const r = await runCollector(expect.cfgPath)
  const after = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null
  let chats = 'NO-FILE'
  let roster = null
  if (after !== null) {
    try { roster = JSON.parse(after); chats = Object.keys(roster.chats || {}).length } catch { chats = 'UNPARSEABLE' }
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
  // S6/S7 的形状断言：逐条 (路径, 谓词, 说明) 由 expect.shapes 给出，取不到就红。
  if (expect.shapes) {
    for (const [label, pass, got] of expect.shapes(roster)) {
      check(label, pass, '实得 ' + JSON.stringify(got))
    }
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
  // S6（0.8.4 C4，钉第七轮 M3 的 `views` 幂等合并语义）：
  //   open 遍失败、union 遍成功 ⇒ 本次 people 行的 views 是**空的**；旧写法"采到即整行覆盖"
  //   会把上一次采到的 open_id 抹掉（`resolveAtTarget` 只认 views[myApp] ⇒ 人变成点不了名）。
  //   生产取证已过（零副作用探针，功能基线缺口 #7），这一格把同一形状机器化。
  await cell('S6 open 遍失败 + union 遍成功 ⇒ people views 旧为底不被抹掉',
    JSON.stringify({
      generated_at: 'x',
      // 🔴 第二十二轮门槛 LOW#3（核对为真）：桩按 app_id 签发身份 ⇒ 新采到的 guard bot
      //   union 是 `on_cli_guard_bot`。旧种子写 `on_guardbot` 永不匹配，bot 行合并根本没被
      //   这一格演到（孤儿重复进 merged.bots）。对齐种子身份。
      bots: [{ name: 'guard bot', app_id: APP_GUARD, union_id: unionIdOf(APP_GUARD),
        views: { [APP_GUARD]: STALE_OPEN_GUARD, [STALE_KEY]: STALE_OTHER_OPEN } }],
      people: [{ name: '张三', union_id: MEMBER_UNION, views: { [APP_GUARD]: STALE_PEOPLE_OPEN } }],
      chats: {},
    }), 'fail-open', {
      rc: 0,
      // 🔴 第二十二轮门槛 MEDIUM#4（核对为真）：**前提断言**——本格的判别力全部建立在
      //   "open 遍真的失败"上；前提哪天因夹具漂移悄悄不成立，形状断言会退化成假绿灯。
      logIn: LOG_MEMBER_FAIL + '(open_id)',
      shapes: (roster) => {
        const p = ((roster && roster.people) || []).find((r) => r.union_id === MEMBER_UNION)
        const v = p && p.views && p.views[APP_GUARD]
        const bs = (roster && roster.bots) || []
        const b0 = bs.find((b) => b.app_id === APP_GUARD)
        return [
          // 🔴 第四十二轮门槛 LOW#7（核对为真）：种子原来直接拿 MEMBER_OPEN——它同时是
          //   open 遍的**新采值**，"旧值保留"与"新值恰好写入"同形不可分，判别全靠 logIn 前提。
          //   种子改用相异的 STALE_PEOPLE_OPEN（setup 守卫钉两值不等）：本格只证"旧为底不被抹"，
          //   "同键新赢旧"的正向半边由新格子 S11 补演。
          ['★★★ people 行的 views[appId] 保留陈旧 open_id（M3：旧为底合并，采到≠采全；整行覆盖必红）',
            v === STALE_PEOPLE_OPEN, p && p.views],
          ['★★ 本群 union 名单仍在（union 遍成功侧照常填）',
            !!roster && !!(roster.chats && roster.chats[CHAT_LIVE]
              && (roster.chats[CHAT_LIVE].member_unions || []).includes(MEMBER_UNION)),
            roster && roster.chats && roster.chats[CHAT_LIVE]],
          // 🔴 第二十三轮门槛 LOW（核对为真）：种子身份对齐让 bot 行**逐行合并**真的被演到了，
          //   那就把它钉住——只许有一行（不许孤儿重复），且 views 必须是新采值赢过种子旧值。
          // 🔴 第二十六轮门槛 LOW#1（核对为真）：种子 views 补一个**陈旧他键** cli_other_bot——
          //   同名键"新赢旧"对整行覆盖（M3 修前的旧 bug）同样成立、不判别；只有"旧为底"
          //   才留得住这个键 ⇒ 把它删干净才是真合并，整行覆盖在此必红。
          ['★★★ bot 行合并成一行；同名键取新采值、种子他键存活（旧为底+新覆盖同名键＝M3 语义，整行覆盖必红）',
            bs.length === 1 && !!b0 && b0.views && b0.views[APP_GUARD] === openIdOf(APP_GUARD)
            && b0.views[STALE_KEY] === STALE_OTHER_OPEN,
            bs.map((b) => b.app_id + ':' + JSON.stringify(b.views))],
        ]
      },
    })
  // S7（0.8.4 C4，钉第十五轮 M1 的群级正向标记）：
  //   同群两 bot：A 的 union 遍失败、B 的 union 遍成功 ⇒ 名单是**群级**的，B 已采全，
  //   合并**不许**再把旧名单里已退群的人并回来。旧写法（标记只置不清）这一格必红。
  // 🔴 第三十一轮门槛 LOW#1（核对为真）：标题原来写「不退群者不并回」，与本文件头部（§S7）
  //   和下方形状断言的口径**反义**——这一格守的是"已退群的人没有被并回"。
  await cell('S7 双 bot 同群：A union 失败 + B 全成功 ⇒ 已退群者不被并回',
    JSON.stringify({
      generated_at: 'x',
      bots: [], people: [],
      chats: {
        [CHAT_LIVE]: {
          name: '本次群', bot_app_ids: [TWO_BOTS[0].appId],
          // 🔴 第三十八轮门槛 LOW#4（核对为真）：种子里原来同时放 MEMBER_UNION——它正是
          //   本遍新采的人，"本次采到的人仍在"拿种子自身就能满足＝恒真。种子只留**已退群者**，
          //   MEMBER_UNION 只能由新采集进来 ⇒ 正向判据真的有判别力。
          member_unions: [MEMBER_LEFT],
        },
      },
    }), 'm1-two-bot', {
      rc: 0, cfgPath: CFG2,
      // 🔴 第二十二轮门槛 MEDIUM#5（核对为真）：同 S6——"A 的 union 遍真的失败"是
      //   `members_incomplete` 的唯一来源，也是本格合并分支的前提，必须断言到日志。
      logIn: LOG_MEMBER_FAIL + '(union_id)',
      shapes: (roster) => {
        const c = roster && roster.chats && roster.chats[CHAT_LIVE]
        const unions = (c && c.member_unions) || []
        return [
          // 🔴 第四十二轮门槛 LOW#1（核对为真）：上一轮把第二条强化成"恰好只剩新采者"后，
          //   第一条反被它**反向蕴含**（同值碰撞已由 setup 守卫拦下）——留两条就是互含的
          //   假双保险。合成一条 ★★★：M1 语义（不并旧）+ 名单恰好新采一人。
          ['★★★ 已退群的人没有被并回、名单**恰好只剩**新采者（M1 群级采全不并旧）',
            !!c && unions.length === 1 && unions[0] === MEMBER_UNION, unions],
          // 🔴 第四十七轮 LOW#2（核对为真）：标签原本写"无幽灵"，但判据只看 `member_unions`
          //   ——它只由 union 遍填充，而幽灵（GHOST_MEMBER_ID，A 的 open 遍、无 name）既进不了
          //   这条名单、也落不进 people ⇒ 夹具惰性、宣称大于断言。补一条真判据把"幽灵泄漏"
          //   钉住：将来采集器若把无名 open 遍成员也出行（按 open_id 建 people 行），本条必红。
          ['★★★ 幽灵（A 的 open 遍、无名成员）没有泄漏进 people 的任何一行',
            !(roster && (roster.people || []).some((p) => String(p.union_id || '') === GHOST_MEMBER_ID
              || Object.keys(p.views || {}).some((k) => String(p.views[k]) === GHOST_MEMBER_ID))),
            roster && (roster.people || []).map((p) => p.union_id + ':' + JSON.stringify(p.views))],
          ['★★★ 两个 bot 都在表里且各带**自己 appId 下自己的 ou_**（逐 bot 采集主路径；第二十八轮 LOW#7：只数键数会把"全挂到同一个 appId"的回归放过去）',
            !!roster && (roster.bots || []).length === 2
            && (roster.bots || []).every((b) => b.views
              && Object.keys(b.views).length === 1 && b.views[b.app_id] === openIdOf(b.app_id)),
            roster && (roster.bots || []).map((b) => b.app_id + ':' + JSON.stringify(b.views))],
        ]
      },
    })
  // S8（第二十三轮门槛 LOW#2）：钉住桩自己那条"缺 app_id ⇒ 9999990 显式失败"的守卫——
  //   此前没有任何格子走到它，回退成静默空 app_id 也不会红。bad-token 格把请求体弄坏，
  //   采集器拿不到 token ⇒ 走既有失败出口（不写文件、干净 rc=1）。
  await cell('S8 token 请求体被弄坏 ⇒ 桩显式拒绝、采集失败不写盘', VALID_OLD, 'bad-token', {
    rc: 1, logIn: 'code=' + ERR.missingAppId, unchanged: true, cleanExit: true,
  })
  // S9（第二十六轮门槛 MEDIUM#1）：钉 collect 侧「`members_incomplete` ⇒ 并回旧名单」的
  //   **正向**分支（本遍 union 恒失败、无人采全 ⇒ 旧名单必须并回来）。此前 S7 只钉了
  //   负向（有人采全⇒不许并）——把并回分支整个删掉，全套格子照样全绿＝恒真守卫。
  //   判别力口径：这一格在"并回分支被删"的字节上必红（正向），S7 在"标记被删"的字节上必红（负向）。
  await cell('S9 单 bot union 遍失败 ⇒ 旧群名单被并回（合并分支的正向对照）',
    JSON.stringify({
      generated_at: 'x', bots: [], people: [],
      chats: { [CHAT_LIVE]: { name: '本次群', bot_app_ids: [APP_GUARD],
        // 🔴 第四十一轮门槛 LOW#5（核对为真）：旧种子原来是**单条** [KEEP]——并回循环至多
        //   push 一次，幂等断言拿不到第二次迭代**恒真**（去重守卫删掉也不会红）。
        //   留一份重复项驱动 `!includes(u)` 守卫：守卫在 ⇒ 并回后恰好一条；守卫删 ⇒ 塞两遍当场红。
        member_unions: [MEMBER_KEEP, MEMBER_KEEP] } },
    }), 'fail-union', {
      rc: 0,
      logIn: LOG_MEMBER_FAIL + '(union_id)',
      shapes: (roster) => {
        const c = roster && roster.chats && roster.chats[CHAT_LIVE]
        const unions = (c && c.member_unions) || []
        return [
          ['★★★ 旧名单并回来了（删掉并回分支＝这条必红）',
            unions.includes(MEMBER_KEEP), unions],
          ['★★ 并回是幂等的：同一个 union 没有被塞两遍',
            unions.length === new Set(unions).size, unions],
        ]
      },
    })
  // S10（第二十六轮门槛 LOW#6）：驱动桩自己的"bearer 推不出身份 ⇒ 9999994 显式失败"守卫——
  //   非 cli_ 前缀的 appId 让 token 照常签发、但身份正则不命中。旧写法（静默兜回
  //   guard-bot 形状）在这一格会**洗成成功**（rc=0 写盘）⇒ 本格同时钉住"降级不许复发"。
  await cell('S10 非 cli_ 前缀 appId ⇒ 桩身份守卫显式拒绝、采集失败不写盘', VALID_OLD, 'no-chats', {
    rc: 1, cfgPath: CFG3, logIn: 'code=' + ERR.underivableBearer, unchanged: true, cleanExit: true,
  })
  // S11（第四十二轮门槛 LOW#7；🔴 第四十四轮 LOW#3 更正引文）：people 行合并的**另一半**——
  //   "同键新赢旧"。S6 里 open 遍恒失败、people 行拿不到新值，方向判别只演了"旧为底"；
  //   把 `cur.views = Object.assign({}, cur.views, row.views)`（旧值最后盖回＝**旧赢**；
  //   注意生产正确式是 `Object.assign({}, row.views, cur.views)`＝新赢，别引反）这类
  //   people 专属回归藏进 S6 是全绿的。这里 open/union 两遍都成功 ⇒ 新值 MEMBER_OPEN
  //   必须赢过陈旧种子，同时种子他键存活证"旧为底"。
  await cell('S11 people 行两遍采全 ⇒ 同键新值赢陈旧种子、他键存活（新赢旧的正向半边）',
    JSON.stringify({
      generated_at: 'x', bots: [],
      people: [{ name: '张三', union_id: MEMBER_UNION,
        views: { [APP_GUARD]: STALE_PEOPLE_OPEN, [STALE_KEY]: STALE_PEOPLE_OTHER } }],
      chats: {},
    }), 'one-chat', {
      rc: 0,
      shapes: (roster) => {
        const p = ((roster && roster.people) || []).find((r) => r.union_id === MEMBER_UNION)
        const v = p && p.views || {}
        return [
          ['★★★ 同键取新采值（旧赢方向一旦回归＝陈旧值残留，本条必红）',
            v[APP_GUARD] === MEMBER_OPEN, p && p.views],
          ['★★ 种子他键存活（旧为底，不是整行覆盖；覆盖回归在此必红）',
            v[STALE_KEY] === STALE_PEOPLE_OTHER, p && p.views],
        ]
      },
    })
  // S12（第五十一轮 LOW#3，改判第四十三轮的挂账）：驱动 token 请求的**流中途 error** 出口。
  //   此前那条 `req.on('error')` 没有任何格子演过——把它整行删掉，采集器就退回"这一路永不作答、
  //   干等 30 秒护栏"的形状，而全套照样绿（第二十三轮 LOW#1 立的"新分支必须有驱动格"口径）。
  //   判据钉**具体错误码 9999996**（不是泛用失败文案，24 轮 MEDIUM#2）＋ 失败不许动旧文件。
  await cell('S12 token 请求流中途 error ⇒ 按 9999996 显式失败、不写盘（驱动此前无人演过的出口）',
    VALID_OLD, 'token-stream-error', {
      rc: 1, logIn: 'code=' + ERR.tokenStreamError, unchanged: true, cleanExit: true,
    })
} finally {
  srv.close()
  rmSync(DIR, { recursive: true, force: true })
}

if (fail) {
  console.log('ROSTER GUARD FAIL (' + fail + ' 项不通过)')
  process.exitCode = 1
} else {
  console.log('ROSTER GUARD PASS (' + cellsDone + ' 格全过)')
}
