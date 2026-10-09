// dsh-feishucard smoke test: boots the real host plugin against a mocked
// DSH context and a mocked Feishu REST API, feeds one inbound message through
// the helper protocol, and asserts the full turn pipeline:
//   event -> dedicated session create -> agent.send -> streaming card
//   (create + PATCH updates) -> seal -> final reply on card.
//
// Run: node scripts/smoke.mjs   (from the package root)
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

// 捕获插件自己的 console.log（2026-10-01 补）：用来断言"观测留痕"类行为
// （例：sendPlainText 成功后要打 `notice plain text sent` —— 此前只有失败才留痕，无法验证）。
const consoleLines = []
const originalLog = console.log
console.log = (...args) => {
  consoleLines.push(args.map((a) => String(a)).join(' '))
  originalLog(...args)
}

const APP_ID = 'cli_test123456'
const APP_SECRET = 'secret-test'
// ⚠️ 工作区路径**不写死绝对路径**（A17 禁硬编码地址）：从系统临时目录派生，
// 形状仍是 Windows 绝对路径（正斜杠，与插件内部 normPath 的写法一致）——
// 写死盘符会把测试绑死在某一台机器上。
const SMOKE_WS_ROOT = tmpdir().split('\\').join('/')
const WORKSPACE = SMOKE_WS_ROOT + '/fs-smoke-workspace'
const OTHER_WORKSPACE = SMOKE_WS_ROOT + '/fs-smoke-other'   // "其它工作区"用例专用
const THIRD_WORKSPACE = SMOKE_WS_ROOT + '/fs-smoke-third'   // 只从会话 cwd 兜底出现的"未注册工作区"
const CHAT_ID = 'oc_smoke_chat_001'
const MSG_ID = 'om_smoke_msg_001'

// 冷启动变体（2026-10-01 目标轮 7）：`DSH_FEISHU_*` 开关都是 **apply 时读一次**
// （`GOAL_CARDS_ON` L3466 / `NOTICE_CARDS_ON` L3470）⇒ 必须在 import/apply **之前**设好环境变量。
// 用法： $env:SMOKE_COLD='notice-off'; node scripts/smoke.mjs     （或 'goal-off'）
const COLD = process.env.SMOKE_COLD || ''
if (COLD === 'notice-off') process.env.DSH_FEISHU_NOTICE_CARDS = '0'
if (COLD === 'goal-off') process.env.DSH_FEISHU_GOAL_CARDS = '0'

// Point the plugin at a throwaway config dir so the test never touches the
// real ~/.dsh-feishucard (the plugin honours process.env.FS_CONFIG_DIR).
const FAKE_HOME = join(tmpdir(), 'fs-smoke-' + Date.now())
mkdirSync(join(FAKE_HOME, '.dsh-feishucard'), { recursive: true })
// 2026-10-02：三个"工作区"目录**真的建出来**。插件现在的 ⚠️/🟢 判定以**本地目录是否存在**为准
//（门槛第二轮 medium#6：只认注册表返回的那个 token 太松），夹具要是空路径，卡面会全变 ⚠️ ——
// 那样测的就不是插件逻辑，而是夹具不像真的（A25：验证环境要与生产一致）。
mkdirSync(WORKSPACE, { recursive: true })
mkdirSync(OTHER_WORKSPACE, { recursive: true })
mkdirSync(THIRD_WORKSPACE, { recursive: true })
writeFileSync(join(FAKE_HOME, '.dsh-feishucard', 'feishu.config.json'),
  // reactionEmoji 一开始就设成非默认值（默认 'OnIt'）—— 用例 40 用它验证 cfg.reactionEmoji 通道
  // approvalForm：审批单卡通道是**默认关**的可选通道 ⇒ 主用例集把它打开（用例 51 验通路），
  // 冷启动变体 `SMOKE_COLD=form-off` 则故意关掉，验「没开就一个工具都不注册」。
  JSON.stringify({
    bots: [{
      name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
      reactionEmoji: 'GLANCE', approvalForm: COLD !== 'form-off',
      // 0.8.4（A2/A3）：plan/goal 是**默认关**的新开关 ⇒ 主夹具显式打开，让历史用例继续测
      // 命令本体逻辑；「不写＝关」这条由用例 108 专门钉（K10 机器守护）。
      // 🔴 第三十七轮门槛 LOW#4：各用例重写 cfg 时逐份重复这三个开关字段，建议抽
      //   botBase() 共享常量判**不修**（与第三十六轮 LOW#2 同族）：定版前冻结窗口里
      //   跨 ~20 处夹具做结构重构，新形状只能靠 diff 验证；63/64 等历史格"省略＝关"
      //   恰好还演了默认关语义。统一基座记下批次观察。
      planEnabled: true, goalEnabled: true,
    }],
  }, null, 2))
process.env.FS_CONFIG_DIR = join(FAKE_HOME, '.dsh-feishucard')

let failures = 0
function ok(cond, label) {
  if (cond) {
    console.log('  ✅ ' + label)
  } else {
    failures += 1
    console.log('  ❌ ' + label)
  }
}

// ---- mocked Feishu REST (captures card payloads) -----------------------------
const sentCards = []      // { op, payload }
const reactionCalls = []  // { method, url, body } —— 打字提示（reaction）生命周期，用例 40 用
// 入站附件下载（用例 49）：记录被请求的资源 URL，并可切换成"下载失败"。
const resourceDownloads = []
let resourceShouldFail = false
// 下载回来的字节可切换（用例 49 验"按文件头补扩展名"：PNG 魔数 / 认不出的字节）。
let resourceBytes = Buffer.from('hello-from-feishu')
// 🔴 第四十九轮 MEDIUM#2（核对为真）：入站尾队列的**刹车豁免**原来没有一格演到"积压"——
//   用例 41 发 /stop 时队列是空的，豁免支与普通支可观察结果相同 ⇒ 把 isBrake 恒写成 false
//   全套照样绿。补一个可控延迟开关：让指定 key 的下载"挂在半路"，才能演"下载进行中来了刹车"。
//   默认 0 ⇒ 其余用例的夹具行为与旧字节逐字一致。
let resourceSlowKey = ''
let resourceSlowMs = 0
// 🔴 第五十二轮 LOW#2（核对为真）：资源 URL 的形状是 `/resources/<file_key>?type=file`，
//   原来判"这个请求是不是我要延迟/统计的那把 key"用的是**子串匹配** ⇒ 前缀遮蔽：
//   `file_v3_redel84` 是 `file_v3_redel84b` 的前缀，两把 key 的请求互相都会被算进去。
//   当前用例顺序（先换 key 再发请求）恰好躲过，但这是**潜伏陷阱**：调整用例顺序或让两把
//   key 并发，就会静默扰动那些对时序敏感的断言（刹车/挂死/重投三格）。按段精确取 key 比对。
const resKeyOf = (url) => {
  const m = String(url).match(/\/resources\/([^?/]+)/)
  return m ? m[1] : ''
}
const dlCountOf = (key) => resourceDownloads.filter((r) => resKeyOf(r.url) === key).length
let tenantTokenCalls = 0
let createReturnsEmptyId = false   // 建卡幂等测试：模拟返回体缺 message_id
// 用例 80：造「托孤的建卡 POST **在飞途中**本代被 dispose」这个交错 ——
//   闸门卡住这次请求，测试在等待期间换代，然后放行并让它抛错（瞬时故障那一类）。
//   shouldThrow 必须在 await **之前**取好：放行后测试会立刻关掉开关，
//   若在 await 之后才读，读到的是"已经关掉"的值 ⇒ 注入失败的那一次根本没失败。
let createHangGate = null
let createThrowAfterHang = false
// 2026-10-01（用例 34）：只让"从此刻起的第 N 次建卡"失败 —— 用来精确打到
// 「建结论卡那一次」而不误伤过程卡的建卡。0 = 不启用。
let failCreatesFrom = 0
const globalFetch = globalThis.fetch
// 假 token 的前缀：发/收两侧都靠它把请求**归属到具体 bot**（`rec.app`，用例 78/80 的判据）。
//   两处各写一遍字面量的话，改了 token 形状 ⇒ 所有 rec.app 静默变成 '' ⇒ 归属类断言
//   会在错误的理由上变绿或变红（复跑审查 LOW）。
const TOKEN_PREFIX = 'tok_'
// 🔴 第十六轮门槛 LOW：`Bearer tok_<app_id>` → `app_id` 的抽取，原来在建卡分支和 DELETE 分支
//   各写一遍字面量，`/im/v1/messages/<id>` → `id` 的抽取同样写了两遍 —— 上面那条注释警告的
//   正是这种漂移（改了 token 形状 ⇒ 所有 `rec.app` 静默变 `''` ⇒ 归属类断言在错误的理由上变绿）。
//   收成一个函数后两侧**不可能不一致**。
//   🔴 第十七轮门槛 LOW#2（核对为真）：抽了函数但**端点字面量**还剩三处（DELETE 的匹配、
//   建卡的匹配、`msgIdOf` 里的切分）—— 路径一旦变，这三处照样各改各的。补 `MESSAGES_PATH`
//   常量，三处统一由它派生。
const appOf = (init) => String((init && init.headers && init.headers.Authorization) || '')
  .replace('Bearer ' + TOKEN_PREFIX, '')
const MESSAGES_PATH = '/im/v1/messages'
const msgIdOf = (url) => decodeURIComponent(String(url).split(MESSAGES_PATH + '/')[1] || '').split('?')[0]
// 2026-10-03 F/G 用例要用的 mock 状态
const imageUploads = []
const fileUploads = []
let rejectPatches = 0
let rejectPatchesBody = null   // 0.7.9：可注入具体错误体（P5 用 11310）
// 0.7.22（第五轮门槛 HIGH 用例）：让**载荷里含指定片段的那一次 PATCH** 抛错（只用一次）。
//   按内容锁定而不是按次数：封口/看门狗/降级都可能是 PATCH，按次数会打错目标（用例 82 的靶心
//   是"结论写回过程卡那一次"，不是封口那一次）。
let failPatchContaining = ''
// 0.8.1（第十五轮门槛 MEDIUM#4）：删卡通道。`messageDeletes` 记每次 DELETE 的 message_id 与
//   发起它的 bot（`app`）；`failDeletes` 让接下来 N 次 DELETE 被**拒绝**（code≠0，走降级分支）。
const messageDeletes = []
let failDeletes = 0
// 0.7.21（用例 77）：群聊"@ 才回复"的判据要先知道"自己是哪个 bot"⇒ bot 身份接口。
// SMOKE_BOT_OPEN_ID 就是夹具里群消息 mentions 要匹配的那个 open_id。
const SMOKE_BOT_OPEN_ID = 'ou_smoke_bot_id'
const SMOKE_BOT_NAME = 'smoke-bot'
const SMOKE_OTHER_BOT_ID = 'ou_other_bot_id'
let botInfoCalls = 0
let botInfoShouldFail = false
// 群消息夹具：0.7.21 起群聊只处理"@ 本 bot"的消息，所以群用例必须带这条 mention。
const GROUP_MENTION = [{ key: '@_user_1', id: SMOKE_BOT_OPEN_ID, name: SMOKE_BOT_NAME }]
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.includes('/auth/v3/tenant_access_token/internal')) {
    tenantTokenCalls += 1
    // token 里带上 app_id ⇒ 下游卡片记录能归属到具体 bot（用例 78：同群两 bot 的串扰判定）。
    // 单 bot 用例不受影响（只是 Bearer 后面的字符串变了）。
    let tokenApp = 'unknown'
    try { tokenApp = String(JSON.parse(String(init && init.body || '{}')).app_id || 'unknown') } catch { /* 保持 unknown */ }
    return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, tenant_access_token: TOKEN_PREFIX + tokenApp, expire: 7200 })) }
  }
  if (u.includes('/bot/v3/info')) {
    botInfoCalls += 1
    if (botInfoShouldFail) {
      return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 99902, msg: 'bot not found' })) }
    }
    return {
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        code: 0, bot: { open_id: SMOKE_BOT_OPEN_ID, app_name: SMOKE_BOT_NAME },
      })),
    }
  }
  if (u.includes('/reactions') && (init.method === 'POST' || init.method === 'DELETE')) {
    reactionCalls.push({ method: init.method, url: u, body: String(init.body || '') })
    return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, data: { reaction_id: 're_1' } })) }
  }
  // 入站附件下载（用例 49）：资源 URL 形状是 /im/v1/messages/<msg_id>/resources/<key>?type=file，
  // **也含** '/im/v1/messages' ⇒ 必须排在建卡分支**之前**，否则会被当成建卡请求
  //（那里 `JSON.parse(init.body)`，而下载是 GET 没有 body ⇒ 直接抛错，测出来的是 mock 的毛病）。
  if (u.includes('/resources/')) {
    resourceDownloads.push({ url: u })
    if (resourceShouldFail) return { ok: false, status: 403, text: () => Promise.resolve('forbidden') }
    if (resourceSlowKey && resourceSlowMs > 0 && resKeyOf(u) === resourceSlowKey) {
      await new Promise((r) => setTimeout(r, resourceSlowMs))
    }
    return { ok: true, status: 200, arrayBuffer: async () => resourceBytes }
  }
  if (u.includes('/im/v1/images')) {
    imageUploads.push({ url: u })
    return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, data: { image_key: 'img_v3_smoke_key' } })) }
  }
  if (u.includes('/im/v1/files')) {
    fileUploads.push({ url: u })
    return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, data: { file_key: 'file_v3_smoke_key' } })) }
  }
  if (u.includes(MESSAGES_PATH + '/') && init.method === 'DELETE') {
    // 🔴 第十五轮门槛 MEDIUM#4：删卡（「✕ 取消」的实现路径）**没有请求体**，原来直落到
    //   下面的建卡分支 ⇒ `JSON.parse(init.body)` 在 `undefined` 上抛 ⇒ httpJson 把**夹具自己
    //   的异常**当成网络失败（status 0）⇒ `deleteMessage` 恒 false ⇒ 「删卡成功」那条分支
    //   在冒烟里**根本不可达**，能测到的只有降级 PATCH。这里显式接住 DELETE。
    const msgId = msgIdOf(u)
    messageDeletes.push({
      msgId,
      app: appOf(init),
    })
    if (failDeletes > 0) {
      failDeletes -= 1
      return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 200001, msg: 'smoke: delete refused' })) }
    }
    return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0 })) }
  }
  if (u.includes(MESSAGES_PATH)) {
    const raw = JSON.parse(init.body)
    const payload = typeof raw.content === 'string' ? JSON.parse(raw.content) : raw
    // 用例 78（双 bot 同群串扰）需要把每次收发**归属到具体 bot**并知道改的是哪张卡：
    //   app    ← Bearer token（上面 tenant_access_token 里带了 app_id）
    //   msgId  ← PATCH 取 URL；create 只有真拿到 message_id 才写（失败分支留空 ⇒ 可判"没建成"）
    const rec = { op: init.method === 'PATCH' ? 'update' : 'create', payload }
    rec.app = appOf(init)
    if (init.method === 'PATCH') {
      rec.msgId = msgIdOf(u)
      // 失败的那一次**不落 sentCards**：用例判的是"内容有没有真的送达"，
      //   把失败的 PATCH 也记进去会让"降级后仍只送达一次"这类断言失去意义。
      if (failPatchContaining && JSON.stringify(payload).includes(failPatchContaining)) {
        failPatchContaining = ''
        throw new Error('smoke: patch transport failure (5xx/connection reset)')
      }
      sentCards.push(rec)
      return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0 })) }
    }
    sentCards.push(rec)
    // 用例 80 的闸门（见上面 flags 声明处的注释）
    if (createHangGate) {
      const shouldThrow = createThrowAfterHang
      await createHangGate.promise
      if (shouldThrow) throw new Error('smoke: transient create failure (mid-flight dispose)')
    }
    if (rejectPatches > 0) {
      // F 用例：模拟"内容被拒"（真机原话 code 230099 / ErrCode 200570 / invalid image keys）
      // ⚠️ 这一支在 PATCH 提前返回**之后** ⇒ 只对 **create** 生效（审查 LOW#124 指出原注释与实现不符）。
      // 0.7.9：新增 rejectPatchesBody —— P5 用例用它注入 **11310 表格超限**（真机 web.log 79604）。
      rejectPatches -= 1
      return {
        status: 200,
        text: () => Promise.resolve(JSON.stringify(rejectPatchesBody || {
          code: 230099,
          msg: 'Failed to create card content, ext=ErrCode: 200570; ErrMsg: card contains invalid image keys',
        })),
      }
    }
    if (failCreatesFrom > 0) {
      failCreatesFrom -= 1
      if (failCreatesFrom === 0) {
        // 建卡失败（返回体没有 message_id → 插件侧 createFailed），且**不抛给调用方**
        // —— 与真机上"15s 超时被 abort"的表现一致：syncCard 内部吞掉异常。
        return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, data: {} })) }
      }
    }
    if (createReturnsEmptyId) {
      return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, data: {} })) }
    }
    rec.msgId = 'om_card_' + sentCards.length
    return { status: 200, text: () => Promise.resolve(JSON.stringify({ code: 0, data: { message_id: rec.msgId } })) }
  }
  return { status: 404, text: () => Promise.resolve('unhandled: ' + u) }
}

// ---- mocked agent.ctx（2026-10-02 补；评审 low#3）------------------------------
// 插件把 approval/request 与 user-questions/request 挂在 **agent.ctx**（长生命周期）上，
// 卸载时靠 disposer 注销。此前 mock agent **没有 ctx** ⇒ `scope.on` 从不被调用、
// `agentScopeDisposers` 恒为空 ⇒ "忘了注销 / 注销不生效"在冒烟里永远不会变红。
// 这里补一个真的返回 disposer 的 `on`，并记账。
// 两个 mock agent 共用**一个工厂**（第四轮门槛 low）：此前 `agentCtx.on` 与 `freshCtx.on`
// 是两份近乎一样的复制品，只差一个计数器 —— 以后修"注销记账"很容易只改一处、两处漂移。
function makeScopedCtx(onDispose) {
  const store = new Map()               // event -> [listener]
  return {
    count: (name) => (store.get(name) || []).length,
    ctx: {
      on(name, listener) {
        if (!store.has(name)) store.set(name, [])
        store.get(name).push(listener)
        return () => {
          const list = store.get(name) || []
          const i = list.indexOf(listener)
          // 第四轮门槛 low：**只有真的移除了才计数**（原来重复 dispose / 拆不存在的条目也 +1，
          // 于是这个数字不再是"移除了几条监听"的忠实信号）。
          if (i < 0) return
          list.splice(i, 1)
          if (typeof onDispose === 'function') onDispose()
        }
      },
    },
  }
}
let agentScopeDisposed = 0              // disposer **真正移除**掉一条监听的次数
const primaryScope = makeScopedCtx(() => { agentScopeDisposed += 1 })
const agentCtx = primaryScope.ctx
function agentScopeCount(name) { return primaryScope.count(name) }

// 第二个 mock agent：**从未收到过任何飞书消息**（＝重载后自己起自动轮的老 agent）。
// 它只该靠 agent/status 那一条补挂路径拿到两条水位线 —— 用它来验"两条必须共用同一补挂点"。
const freshScope = makeScopedCtx()
const freshCtx = freshScope.ctx
function freshCount(name) { return freshScope.count(name) }
const freshAgent = {
  id: 'agent-smoke-auto',
  ctx: freshCtx,
  session: { header: { cwd: WORKSPACE }, snapshotEvents: () => [], events: [] },
}

// ---- mocked agent ------------------------------------------------------------
const agentEvents = []
// 🔴 用例 99 需要**有辨别力**地断言「兜底 append 已删干净」：夹具原来根本没给 mock session
//   挂 append（`agent.session.append` 是 undefined），所以旧实现那句
//   `sc.selectForNextRequest ? … : agent.session.append('model/selection', …)` 在冒烟里
//   **必然抛错**⇒ 断言"没有走兜底"是恒真的假绿灯。挂上这个记录器才测得出真行为。
const sessionAppendCalls = []
const agent = {
  id: 'agent-smoke-1',
  ctx: agentCtx,
  session: {
    header: { cwd: WORKSPACE },
    snapshotEvents: () => agentEvents,
    append(type, data) { sessionAppendCalls.push({ type, data }) },
  },
  sent: [],
  send(message) {
    this.sent.push(message)
    // Simulate the agent working: narration + a tool call + result, then reply.
    agentEvents.push(
      { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '我先查一下知识库。' }] } } },
      { type: 'tool/call', seq: 2, data: { callId: 'call_1', name: 'read', arguments: '{"file_path":"a.md"}' } },
      { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '查到了，整理如下。' }] } } },
      { type: 'tool/result', seq: 4, data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'file contents' }] }] } } },
      { type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'text', text: '这是最终回复 ✅' }] } } },
    )
  },
  async whenIdle() { return undefined },
}

// ---- mocked DSH context --------------------------------------------------------
const intervals = []
const effects = []
// ctx.effect 的 setup 若**返回函数**，那个返回值就是真实的 cleanup（卸载钩子就是这么注册的）。
// 收集起来，用例 47 才能**按行为**找到卸载钩子，而不是假设"index.js 里第一个 ctx.effect"
//（第四轮门槛 medium：位置假设会让用例与 index.js 的注册顺序耦合）。
const effectCleanups = []
const registeredRoutes = []
const registeredTools = []
let createdSessions = 0
let resumedSessions = 0

// 🔴 取「当前这一代」注册的工具（第十三轮门槛 MEDIUM#4 附带收口）：`registeredTools` 跨热重载
//   **累积**，`.find()` 拿到的是**最老**一代的闭包 ⇒ 断言可能在验旧代码（只因身份/@ 解析在调用
//   时才重读配置文件，才碰巧仍然测出新行为——这叫假绿灯，不叫通过）。
//   用例 92/95/96 原来各自写 `.filter(...).pop()`（最新＝当前代），道理是对的但写了三遍
//   ⇒ 收口成这一个函数，全 suite 统一口径。
function toolNow(name) {
  return registeredTools.filter((t) => t && t.name === name).pop()
}

// 假 helper 进程的**唯一**形状来源（第四轮门槛 LOW）：fakeProc 与 extraProcs 各写一份
//   同名契约，一旦轮询代码多读一个字段，两处就会漂移 ⇒ 抽成一个工厂。
function makeFakeProc() {
  return {
    status: 'running',
    output: '',
    readOutput() {
      const delta = this.output
      this.output = ''
      return { delta }
    },
    kill() { this.status = 'killed' },
  }
}
const fakeProc = makeFakeProc()

// 用例 78（清单#3「单独验证」）：同群两个 bot ⇒ 生产上是**两个 helper 进程**，
//   mock 原来只有 fakeProc 单例 ⇒ 第二个 bot 永远拿不到自己的入站通道，串扰根本测不出来。
//   非主 APP_ID 的 helper 走这里（主 bot 仍用 fakeProc，不影响其余 77 组用例）。
const extraProcs = new Map()   // appId -> proc
function procForApp(appId) {
  let proc = extraProcs.get(appId)
  if (!proc) {
    proc = makeFakeProc()
    extraProcs.set(appId, proc)
  }
  return proc
}
// 从 spawn 命令里认回 appId：生产路径是 `--cred <文件>`（文件里有 appId），
//   降级路径才是裸 argv —— 两条都要认，否则用例 78 会把第二个 bot 误当主 bot。
function appOfCommand(command) {
  const text = String(command || '')
  const cred = /--cred\s+"([^"]+)"/.exec(text)
  if (cred) {
    // 这里失败会让第二个 bot 掉回共享 fakeProc ⇒ 串扰场景根本不成立（用例 78 只剩一条软前提）。
    //   静默返回 '' 会把"夹具坏了"伪装成"插件没问题"，必须留痕。
    try { return String(JSON.parse(readFileSync(cred[1], 'utf8')).appId || '') } catch (error) {
      console.log('smoke: appOfCommand could not read --cred file ' + cred[1]
        + ': ' + String((error && error.message) || error))
      return ''
    }
  }
  const bare = /"(cli_[A-Za-z0-9_]+)"/.exec(text)
  return bare ? bare[1] : ''
}

// 目标模式：假的 goals 服务 + 假的命令注册表（用例 14 用）
const goalCalls = []          // goals.create 收到什么
const commandCalls = []       // commands.execute 收到什么
const fakeGoals = {
  create(agent, request) {
    goalCalls.push({ agentId: agent && agent.id, objective: request && request.objective })
    return { objective: request && request.objective, roundsStarted: 0, maxGoalRounds: 10, phase: 'active' }
  },
  // 改造③（底部目标条）用：state/runtimeState/view 三个读接口。
  // activation 可被用例改写，用来验「续行已停（disarmed）」那一格。
  state: () => (fakeGoalEnabled ? {
    goal: {
      id: 'goal-smoke-1', revision: 1, phase: fakeGoalPhase,
      objective: '把飞书卡片这四项改造做完并在真机验收通过', maxGoalRounds: 20,
      blockedReason: fakeGoalBlockedReason || undefined,
    },
    roundsStarted: 3,
    createdAt: Date.now() - 3600000,
    updatedAt: Date.now(),
  } : null),
  runtimeState: () => ({ activation: fakeGoalActivation }),
  view: (state, runtime) => state === null || state === undefined ? undefined : ({
    ...state.goal,
    roundsStarted: state.roundsStarted,
    createdAt: state.createdAt,
    activation: runtime.activation,
  }),
}
let fakeGoalActivation = 'armed'
let fakeGoalPhase = 'active'
let fakeGoalBlockedReason = ''      // 只有 phase==='blocked' 时会出现在卡面上
let fakeGoalEnabled = true
const fakeCommands = { execute: async () => undefined }   // 默认"注册表没接管" → 走 goals 兜底
// 2026-10-02：补上假 planMode 服务。此前 `ctx.inject` 对 planMode 直接不触发 ⇒ 插件里
// `planModeRef` 永远是 null ⇒ 「批准后真的退出计划模式」这条分支**从未被测过**。
const planModeCalls = []
const fakePlanMode = {
  set(agent, active) {
    planModeCalls.push({ agentId: agent && agent.id, active })
    return 'queued'
  },
}

// 会话切换：假的持久化服务 + 会话创建记录 + 活着的 agent 列表（用例 15 用）
const createdSessionIds = []
const liveAgents = []
let persistedSessions = []
const persistedFirstText = {}          // sessionId -> 首条用户消息（摘要）
const fakePersistence = {
  list: async () => persistedSessions,
  locate: (meta) => ({ kind: 'jsonl', path: join(tmpdir(), 'no-such-' + meta.id + '.jsonl.zstd') }),
  readFrom: async (id) => ({
    meta: (persistedSessions.find((s) => s.id === id)) || { version: 0, id },
    events: persistedFirstText[id]
      ? [{ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: persistedFirstText[id] }], source: { kind: 'user' } } }]
      : [],
  }),
}

// 工作区注册表 mock（2026-10-02 A 方案）：DSH 原生结构 —— 实体 = { id, path, title, sessionIds[], status(), attachSession() }。
// 插件现在**先读它**（与 GUI 侧边栏同源），所以要能验证：① 工作区列表来自它 ② 切换后把会话挂回去。
const registryAttached = []            // { ws, id }
let registryIdSeq = 0
let registryOverride = null        // 非空 = 只用 'workspaces' 这个服务名暴露给插件（见 ctx.get）
// 宿主 `llm` 服务 mock（用例 94 的 /model 卡用）：默认 null ⇒ ctx.get('llm') 仍返回 undefined，
// 其余用例跑的是「拿不到清单」那条既有分支，不受影响。
let llmOverride = null
// 🔴 宿主 `sessionController` / `sessionProjections` 夹具（CM 2026-10-05 报「卡片里切模型从来没成功过」）。
//   原来这里**根本没有** `sessionController`，而 mock 的 `agent.session` 也没有 `append`
//   ⇒ 生产里那条"恒降级成 `session.append('model/selection')`、却回 ✅"的死路，在冒烟里只会
//   表现成一个 TypeError 被 catch 掉 ⇒ 用例只验到「切换失败」文案就算过。
//   也就是说：**98 个用例里没有一个照到过"回 ✅ 但模型没变"**（假绿灯，与用例 86 同族）。
//   现在按宿主**真形状**给：服务对象只有 `selectModel`（typert: service='sessionController'），
//   **故意不给** `selectForNextRequest` / `selectionFor` —— 那两个在内部类
//   `ApiSessionAgentController`（服务的 `this.agents`）上，插件取不到。夹具多给一个方法，
//   "把内部方法当服务方法 ⇒ 恒走兜底"这类缺陷就永远测不出来。
let selectModelCalls = []                 // 每次 selectModel 的入参（判"到底调没调、参数对不对"）
let selectModelImpl = null                // 非空 ⇒ 用它（可抛错），钉"宿主拒绝时必须如实报错"
let sessionControllerAvailable = true     // false ⇒ ctx.get('sessionController') 返回 undefined
// 🔴 中台 #124（桥侧落地校验的夹具面）：agentDefaultModel 从"写死返回默认值"升级为**有状态**：
//   currentSelection 读 dmSelection；saveSelection 写它（可模拟宿主 ② 半静默没跑 dmSilentDrop、
//   直存报错 dmSaveFails、直存挂死不返回 dmSaveHangs、服务没这个口 dmNoSaveApi）。
let dmSelection = { provider: 'test', model: 'test-model' }
let dmSaveCalls = []
let dmSilentDrop = false
let dmSaveFails = false
let dmSaveHangs = false
let dmNoSaveApi = false
// 🔴 第四十四轮 MEDIUM#5（核对为真）：#124 各格全在**第一拍**回读就命中（健康桩当场写、
//   静默桩永远不写）⇒ 轮询循环的后续拍与「宿主半拍后落地（第 N 拍读到）」支是死代码。
//   dmDelayedLand=N ⇒ 健康 selectModel 不即时写默认值，前 N 次 currentSelection() 仍读旧值、
//   第 N+1 次才写（模拟宿主②半写完 + profile 热更跟上的"半拍"）。
let dmDelayedLand = 0
let dmPendingLand = null
function dmApplyDefaultHalf(request) {
  if (dmDelayedLand > 0) {
    dmPendingLand = { target: { provider: request.provider, model: request.model }, left: dmDelayedLand }
  } else {
    // 🔴 第四十七轮 MEDIUM#1（核对为真）：这里一度被写成恒 `test/test-model`（复位样式串台）
    //   ⇒ 健康宿主等于"永远没存过本次选择"，落地校验恒走直存兜底，「宿主即时落地」整支变死代码
    //   且**没有任何一格会红**（回执两条路径同字面）——夹具语义漂移机器看不见的活案例。
    dmSelection = { provider: request.provider, model: request.model }
  }
}
// 🔴 第四十六轮 LOW#2（核对为真）：dm* 旗标原来靠 #124 块**尾部内联**逐面复位——ok() 失败不打断
//   流程，块里任何一个 await 抛了旗标就**漏进后续用例**（105-113、peer 格的行为被静默改写，
//   红了也归因不到根上）。收成一个函数：块开头调一次、块体改 try/finally 再兜一次，复位从此单源。
function resetDmFixtures() {
  dmSilentDrop = false
  dmSaveFails = false
  dmSaveHangs = false
  dmNoSaveApi = false
  dmDelayedLand = 0
  dmPendingLand = null
  dmSelection = { provider: 'test', model: 'test-model' }
  dmSaveCalls = []
  selectModelImpl = null
}
let modelSelectionState                   // sessionProjections.stateOf(session,'modelSelection')
// 🔴 中台 #171（per-bot 预设的夹具面）：mount 桩从「无参吞掉」升级为**有状态**——
//   presetMountCalls 记录每次 presets.mount 的第二参（undefined＝未指定 ⇒ registry 回落默认）；
//   presetMountImpl 非空 ⇒ 用它（可抛 agent-preset/not-found，钉「id 写错必须走失败日志、不得静默回落」）；
//   resume 路径同样演练 setup（生产 resume 也走 mount，旧夹具不调＝那一支零覆盖）。
//   presetMountSkipResumeOn=true 时 resume 不调 setup（对照格，钉旧行为边界）。
let presetMountCalls = []
let presetMountImpl = null
let presetMountSkipResumeOn = false
const mountPresetAgentCtx = () => ({ get: () => ({
  mount: async (_agentCtx, id) => {
    presetMountCalls.push(id)
    if (presetMountImpl) return presetMountImpl(_agentCtx, id)
    return { id: id || 'default' }
  },
}) })
function resetPresetMountFixtures() {
  presetMountCalls = []
  presetMountImpl = null
  presetMountSkipResumeOn = false
}
function makeRegistryEntity(path, title, id) {
  const entityId = id || ('ws-' + (++registryIdSeq))
  return {
    id: entityId,
    path,
    title: title || path.split('/').pop(),
    sessionIds: [],
    status: async () => 'ok',
    attachSession: async (sid) => { registryAttached.push({ ws: entityId, id: String(sid) }) },
  }
}
const fakeWorkspaceRegistry = {
  _entities: [],
  seed() { this._entities = [WORKSPACE, OTHER_WORKSPACE].map((path) => makeRegistryEntity(path)) },
  list() { return this._entities },
  get(id) { return this._entities.find((e) => e.id === id) },
  async resolveByPath(path) { return this._entities.find((e) => e.path === path) },
  async create(path, title) {
    // id 走**单调计数器**：原来用 _entities.length + 1，实体一旦被移除（用例里会 pop / 清空）就会重号，
    // get(id) 随之产生歧义（门槛第二轮 low）。
    const entity = makeRegistryEntity(path, title)
    this._entities.push(entity)
    return entity
  },
}
fakeWorkspaceRegistry.seed()

const ctx = {
  get(key) {
    if (key === 'agents') {
      return {
        create: async (opts) => {
          createdSessions += 1
          createdSessionIds.push(opts.sessionId)
          agent.session.header.cwd = opts.meta && opts.meta.cwd
          if (opts.setup) await opts.setup(mountPresetAgentCtx())
          return { agent }
        },
        resume: async (opts) => {
          resumedSessions += 1
          // 2026-10-02：resume 之后 cwd 应当回到**那个会话自己的**目录（生产里读的是会话 header）。
          // mock 原来不改 cwd ⇒ "接管别的工作区的会话"在测试里看起来还在原目录，cwd 相关断言失真。
          const meta = persistedSessions.find((s) => s.id === (opts && opts.resumeSessionId))
          if (meta && meta.cwd) agent.session.header.cwd = meta.cwd
          // #171：resume 也走 setup⇒mount（生产同形）；旗标仅对照格用。
          if (opts.setup && !presetMountSkipResumeOn) await opts.setup(mountPresetAgentCtx())
          return { agent }
        },
        list: () => liveAgents,
      }
    }
    if (key === 'sandboxPolicy') return { workspaceRoot: WORKSPACE }
    if (key === 'agentDefaultModel') {
      // #124 有状态桩：见文件头 dm* 系列开关的注释。
      const dmSvc = {
        currentSelection: () => {
          // dmDelayedLand 语义：前 left 次读返回旧值，之后第一次读才写入目标（半拍落地）。
          // 🔴 第五十一轮 LOW#2（核对为真，**判不改名**）：这个名字是**被测接口**的形状
          //   （index.js 三处直接调 `currentSelection()` 回读默认值），夹具只能照抄；
          //   但它**读一次就推进一格**（有副作用）⇒ 谁为了打日志/诊断多调一次，
          //   ④G 那格的"第 N 拍读到"就会错位。口径：**只许被测路径调它**，别在断言里取样。
          if (dmPendingLand) {
            if (dmPendingLand.left > 0) dmPendingLand.left -= 1
            else { dmSelection = dmPendingLand.target; dmPendingLand = null }
          }
          return Object.assign({}, dmSelection)
        },
      }
      if (!dmNoSaveApi) dmSvc.saveSelection = async (next) => {
        if (dmSaveHangs) return new Promise(() => { })          // 挂死不返回＝模拟宿主保存队列卡死
        // 🔴 第四十四轮 LOW#1（核对为真）：原文案写 `editor.edit 挂死` —— 与本支语义（直存**报错**）
        //   和兄弟开关 dmSaveHangs 相矛盾，报错原文会进回执，排查时误读成"挂死"。
        if (dmSaveFails) throw new Error('宿主直存默认值报错（夹具模拟）')
        dmSaveCalls.push(next)
        dmSelection = { provider: next.provider, model: next.model }
      }
      return dmSvc
    }
    if (key === 'sessionController') {
      if (!sessionControllerAvailable) return undefined
      return {
        selectModel: async (request) => {
          selectModelCalls.push(request)
          // 🔴 第五十轮 LOW#2（核对为真）：两条分支原来**各抄一份**同一条后置
          //   （宿主健康形态②半会写默认值）——半写语义哪天只改一支就漂移。合成一处。
          const r = selectModelImpl
            ? await selectModelImpl(request)
            : { selected: { provider: request.provider, model: request.model } }
          // dmSilentDrop＝#124 的"静默没跑"，那时宿主不写默认值。
          if (!dmSilentDrop) dmApplyDefaultHalf(request)
          return r
        },
      }
    }
    if (key === 'sessionProjections') {
      return {
        stateOf: (_session, projectionKey) => (projectionKey === 'modelSelection'
          ? modelSelectionState : undefined),
      }
    }
    if (key === 'llm') return llmOverride || undefined
    if (key === 'goals') return fakeGoals
    if (key === 'commands') return fakeCommands
    if (key === 'sessionPersistence') return fakePersistence
    // 门槛第三轮 low：允许把注册表**只**以客户端服务名 workspaces 暴露（且可以没有 get()），
    // 用来锁住"服务名两种都认 + 逐个方法判可用"这两条兜底（否则它们永远没被跑过）。
    if (key === 'workspaceRegistry') return registryOverride ? undefined : fakeWorkspaceRegistry
    if (key === 'workspaces') return registryOverride || undefined
    return undefined
  },
  shell: {
    resolve: (spec) => spec,
    start: (spec) => {
      const app = appOfCommand(spec && spec.command)
      const proc = (!app || app === APP_ID) ? fakeProc : procForApp(app)
      proc.output += JSON.stringify({ type: 'ready' }) + '\n'
      return proc
    },
  },
  // 0.7.16 (suite infra): unshift => NEWEST generation polls first. fakeProc is a singleton and
  // the mock interval disposer is a no-op, so after a mid-suite re-apply the old generation would
  // always win the chunk race (and, being disposed, its pushes are blocked by design). Production
  // only ever runs the live generation, so the mock must give it priority.
  interval(fn) { intervals.unshift(fn); return () => {} },
  effect(fn) {
    effects.push(fn)
    const cleanup = fn()
    if (typeof cleanup === 'function') effectCleanups.push(cleanup)
    return cleanup
  },
  webServer: { register: (route) => registeredRoutes.push(route) },
  tools: { register: (t) => registeredTools.push(t) },
  inject(keys, callback) {
    // cordis service injection: only invoke when a known service is present.
    // 2026-10-02：planMode 现在也提供（见 fakePlanMode）—— exit_plan_mode 工具层接管要断言
    // 「批准后调用了 set(agent,false)」，不注入的话那条分支永远走不到。
    if (Array.isArray(keys) && keys.includes('planMode')) {
      callback({ planMode: fakePlanMode })
      return () => {}
    }
    void keys; void callback
    return () => {}
  },
  on(event, listener) {
    // cordis event subscription: recorded so tests can emit lifecycle events
    // (e.g. `agent/status` for the goal-round card) through emitCtx().
    if (!ctxListeners.has(event)) ctxListeners.set(event, [])
    ctxListeners.get(event).push(listener)
    return () => {}
  },
}

// Recorded cordis listeners + a tiny emitter so tests can drive plugin hooks.
const ctxListeners = new Map()
function emitCtx(event, ...args) {
  // 返回**每个监听器的返回值**（2026-10-01 补：水位线类事件——approval/request、
  // user-questions/request——监听器返回的是 Promise，用例 42 要 await 它拿答案）。
  const results = []
  for (const listener of (ctxListeners.get(event) || [])) results.push(listener(...args))
  return results
}

// ---- boot the real plugin -------------------------------------------------------
// 2026-10-01 补：**启动前**先塞一条"历史回执"进会话 —— 用来验证
// 「首见某 agent 时只登记游标、绝不回放历史」（否则 dsh 重启后会把很久以前的回执全部重播、刷屏）。
agentEvents.push({
  type: 'user/message', seq: 1,
  data: {
    content: [{ type: 'text', text: 'Background subagent OLDHISTORY-0001 finished and will do no further work unless you send it more.' }],
    source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'OLDHISTORY-0001' },
  },
})
const mod = await import('../index.js')
mod.apply(ctx)

// Fire the interval callback a few times to let ensureHelpers spawn and drain.
for (let i = 0; i < 3; i++) {
  for (const fn of intervals) fn()
}

// ---- 冷启动变体分支：只验"启动时读一次"的开关，验完即退出（不跑主用例集）------------
if (COLD) {
  console.log('冷启动变体：' + COLD + '（这些开关只有冷启动才能验；主用例集假设开关默认开）')
  feedInbound('om_cold_' + COLD, '冷启动开关测试')
  await drain()   // 建立 chat→agent 映射（回执轮询只遍历有飞书映射的 agent）

  if (COLD === 'notice-off') {
    const before = sentCards.length
    agentEvents.push({
      type: 'user/message', seq: 7000,
      data: {
        content: [
          { type: 'text', text: 'Background subagent coldtest-0001 finished and will do no further work unless you send it more.' },
          { type: 'text', text: 'Its closing message:' },
          { type: 'text', text: '冷启动开关测试回执。' },
        ],
        source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'coldtest-0001' },
      },
    })
    await drain()
    ok(sentCards.length === before, 'DSH_FEISHU_NOTICE_CARDS=0 ⇒ 回执零播报（不建卡也不发纯文本）')
    ok(!consoleLines.some((l) => l.includes('notice card opened') || l.includes('notice plain text sent')),
      '开关关掉时连播报日志都不该有')
    ok(consoleLines.some((l) => l.includes('plugin apply')), '（前提）插件确实已 apply —— 证明不是"啥都没加载"造成的假绿')
  } else if (COLD === 'goal-off') {
    const before = sentCards.length
    agentEvents.push({
      type: 'user/message', seq: 7100,
      data: { content: [{ type: 'text', text: '（目标模式 · 第 1 轮）' }], source: { kind: 'goal', round: 1 } },
    })
    emitCtx('agent/status', { agent, status: 'running' })
    await drain()
    ok(createsSince(before).length === 0, 'DSH_FEISHU_GOAL_CARDS=0 ⇒ 目标轮不自动建卡（不刷屏）')
    emitCtx('agent/status', { agent, status: 'idle' })
  } else if (COLD === 'form-off') {
    // 2026-10-03 **方案 B（CM 定稿）**：审批单工具**始终注册** ——
    // 好处是 Agent 能主动告诉用户"这里有个通道、要不要开"；"开不开"仍由配置决定：
    // 该 bot 没写 `approvalForm: true` 时，调用被**明确拒绝**并把"怎么打开"写在返回里。
    ok(registeredTools.some((t) => t && t.name === 'feishu_approval_form'),
      '★ 方案 B：approvalForm 未开启时工具**仍然注册**（Agent 才有机会提示用户去开）')
    ok(consoleLines.some((l) => l.includes('方案 B：始终注册')), '并留痕（可日志复验）')
    ok(registeredTools.some((t) => t && t.name === 'feishu_send'), '（前提）别的工具照常注册')
    // 调用必须被拒且"话能照做"（CM 要的兜底：Agent 收到信息）
    const tool = toolNow('feishu_approval_form')
    // 审查 MED#475：断言失败后**不能**继续解引用，否则抛 TypeError 把整轮冒烟打断、看不到真因
    const refused = tool
      ? await tool.execute({ title: '没开通道不该发', chatId: CHAT_ID }, { agent, signal: undefined })
      : { ok: false, missing: true, detail: '（feishu_approval_form 未注册）' }
    ok(refused && refused.ok === false && String(refused.detail).includes('没打开审批单通道'),
      '★ 未开启 ⇒ 调用被明确拒绝（实际：' + JSON.stringify(refused && refused.detail || refused) + '）')
    ok(String(refused && refused.detail).includes('approvalForm'), '拒绝里带"怎么打开"（可被 Agent 转告用户）')
    ok(!sentCards.some((c) => JSON.stringify(c.payload || {}).includes('没开通道不该发')),
      '被拒时**一张卡都没发**（不瞎发）')
    // 热开启：改配置 + 过 10 秒热读 ⇒ 同一工具从"被拒"变成"真的能发"
    writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
      bots: [{
        name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
        reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true,
      }],
    }, null, 2))
    await new Promise((r) => setTimeout(r, 11000))   // 等过热读节拍（ensureHelpers 每 10 秒重读配置）
    await drain()
    const mark = sentCards.length
    // 审查 LOW#476：光守住第一处不够 —— 这里再解引用一次，工具没注册照样抛 TypeError 打断整轮
    const pending = tool
      ? tool.execute({ title: '开通道后就该发得出', chatId: CHAT_ID }, { agent, signal: undefined })
      : Promise.resolve({ ok: false, missing: true, detail: '（feishu_approval_form 未注册）' })
    // 这张卡会一直等点击 ⇒ 只等几秒，别把冷启动用例挂住
    await Promise.race([pending.catch(() => { }), new Promise((r) => setTimeout(r, 3000))])
    await drain()
    ok(sentCards.slice(mark).some((c) => JSON.stringify(c.payload || {}).includes('开通道后就该发得出')),
      '★ 运行中把 approvalForm 改成 true（10 秒热读）⇒ **同一工具立刻能发卡**（不用重启）')
  }
  console.log(failures === 0 ? 'COLD PASS (' + COLD + ')' : 'COLD FAIL (' + COLD + '): ' + failures + ' 条')
  process.exit(failures === 0 ? 0 : 1)
}

console.log('1) helper spawned & registered')
ok(createdSessions === 0, 'no session yet before inbound')
ok(registeredTools.some((t) => t && t.name === 'feishu_send'), 'feishu_send tool registered')
ok(registeredRoutes.some((r) => r.path === '/feishu/admin/status'), 'admin status route registered')

// Feed one inbound message through the helper protocol.
console.log('2) inbound message pipeline')
fakeProc.output += JSON.stringify({
  type: 'event',
  eventType: 'im.message.receive_v1',
  data: {
    message: { message_id: MSG_ID, message_type: 'text', chat_id: CHAT_ID, chat_type: 'p2p', content: JSON.stringify({ text: '帮我看看' }) },
    sender: { sender_id: { open_id: 'ou_test' } },
  },
}) + '\n'
for (const fn of intervals) fn()
await new Promise((r) => setTimeout(r, 600))
for (const fn of intervals) fn()
await new Promise((r) => setTimeout(r, 600))

ok(createdSessions === 1, 'dedicated session created (' + createdSessions + ')')
ok(agent.sent.length === 1, 'message delivered to agent')
ok(agent.sent[0] && agent.sent[0].content[0].text.includes('帮我看看'), 'message text intact')
// 2026-10-01 补（此前无守护）：启动前就存在的历史回执**绝不许回放** ——
// 首次见到某 agent 时只登记游标；`from === undefined` 那条分支若写错，dsh 重启后会把
// 很久以前的回执全部重播一遍（刷屏）。判定：全流程里不许出现 OLDHISTORY 这个标记。
ok(!JSON.stringify(sentCards).includes('OLDHISTORY'),
  '启动前的历史回执不回放（首见 agent 只登记游标）')
ok(!consoleLines.some((l) => l.includes('OLDHISTORY')),
  '历史回执既没进卡片、也没进纯文本播报')

console.log('3) streaming card')
ok(sentCards.length >= 1, 'card created + updated (' + sentCards.length + ' syncs)')
const first = sentCards[0]
ok(first && first.op === 'create', 'first op = create')
ok(first && first.payload && first.payload.schema === '2.0', 'card schema 2.0')
const last = sentCards[sentCards.length - 1]
const allElements = last ? last.payload.body.elements : []
const json = JSON.stringify(sentCards)
ok(json.includes('工具调用'), 'tool panel title present')
ok(json.includes('⏳') || json.includes('✅'), 'tool status symbol present')
ok(json.includes('我先查一下知识库'), 'inline agent note present')
ok(json.includes('这是最终回复'), 'final reply on card')
ok(!json.includes('正在工作中'), 'placeholder removed after seal')
const hasStatusLine = allElements.some((e) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('运行中'))
ok(!hasStatusLine, 'status line removed after seal')

console.log('4) command handling')
fakeProc.output += JSON.stringify({
  type: 'event',
  eventType: 'im.message.receive_v1',
  data: {
    message: { message_id: 'om_cmd', message_type: 'text', chat_id: CHAT_ID, chat_type: 'p2p', content: JSON.stringify({ text: '/new 调研' }) },
    sender: { sender_id: { open_id: 'ou_test' } },
  },
}) + '\n'
for (const fn of intervals) fn()
await new Promise((r) => setTimeout(r, 600))
for (const fn of intervals) fn()
await new Promise((r) => setTimeout(r, 600))
ok(createdSessions === 2, '/new created a second session (' + createdSessions + ')')

console.log('5) fallback path (circuit open => plain text)')
const before = sentCards.length
// Push 5 failed syncs to open the breaker: simulate by making PATCH fail next.
// (Smoke keeps it simple: we assert the pipeline did not throw.)
ok(createdSessions >= 1 && agent.sent.length >= 1, 'pipeline stable end-to-end')

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-15 回归：CM 反馈「同一段东西分两个卡片发、内容大部分重复」+「工具代码框没折叠」
// ─────────────────────────────────────────────────────────────────────────────

// 触发一条入站消息（唯一 message_id，避免被入站去重拦下）
// 🔴 第四十六轮 LOW#5（核对为真）：peer 落盘格原来又手抄了一份事件信封（本文件第 4 份）——
//   信封形状一变就要四处找齐，漏一份＝用例悄悄验错夹具。收进本函数：opts 不传时与旧行为**逐字节一致**
//   （undefined 键被 JSON.stringify 丢弃），全部旧调用零改动。
function feedInbound(msgId, text, opts) {
  const o = opts || {}
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: msgId, message_type: o.msgType || 'text',
        chat_id: o.chatId || CHAT_ID,
        // 🔴 第五十一轮 MEDIUM#1：传 `chatType: null` ⇒ **这个字段整个不写**（复现"事件没带 chat_type"
        //   的形状；JSON.stringify 会丢掉值为 undefined 的键）。默认仍按 p2p，其余用例逐字不变。
        chat_type: o.chatType === null ? undefined : (o.chatType || 'p2p'),
        content: JSON.stringify(o.content || { text }),
      },
      sender: { sender_id: { open_id: o.openId || 'ou_test', union_id: o.unionId } },
    },
  }) + '\n'
}
async function drain() {
  for (let i = 0; i < 4; i++) {
    for (const fn of intervals) fn()
    await new Promise((r) => setTimeout(r, 150))
  }
}
// 触发一条入站**附件**消息 —— 用例 49 用它验「飞书发文件/图片 ⇒ 插件自己下载并告知」（CM 2026-10-02）。
// `file.type` 默认 'file'（正文 {"file_key","file_name"}）；传 'image' 走图片形态
// （正文只有 {"image_key"} —— **飞书图片消息不给文件名**，正是"没有扩展名"那个坑的来源）。
function feedInboundFile(msgId, file) {
  const msgType = file.type || 'file'
  const content = msgType === 'image'
    ? { image_key: file.key }
    : { file_key: file.key, file_name: file.name }
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: msgId,
        message_type: msgType,
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        content: JSON.stringify(content),
      },
      sender: { sender_id: { open_id: 'ou_test' } },
    },
  }) + '\n'
}
// 0.7.9 P6：任意 message_type 的入站（interactive = 转发/卡片消息）。
function feedInboundRaw(msgId, msgType, contentObj) {
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: msgId,
        message_type: msgType,
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        content: JSON.stringify(contentObj),
      },
      sender: { sender_id: { open_id: 'ou_test' } },
    },
  }) + '\n'
}
function cardsSince(n) {
  return sentCards.slice(n)
}
// 多轮 drain：卡片 watcher 走真实 setInterval(300ms)，跨 tick 的行为（换卡→镜像）
// 需要多等几轮才能观察到，否则断言会跑在动作完成之前。
async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) await drain()
}
// 只统计**流式卡**的 create（schema 2.0）；建卡失败后的兜底纯文本不在此列。
function createsSince(n) {
  return sentCards.slice(n).filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0')
}
// 2026-10-01 CM：状态（进行中/已完成/失败）已**并入底部状态栏**，状态词写在栏首、紧跟 "  ｜"。
// 所以断言不能再找 `_失败_` 这种独立状态行，改判"状态栏里确实是这个词"。
function statusShows(body, word) {
  return String(body).includes(word + '  ｜')
}

console.log('6) inbound dedup (same message_id must not run twice)')
{
  const sentBefore = agent.sent.length
  feedInbound('om_dup_same', '重复投递测试')
  feedInbound('om_dup_same', '重复投递测试')
  await drain()
  ok(agent.sent.length === sentBefore + 1,
    'duplicate inbound processed exactly once (' + (agent.sent.length - sentBefore) + ' run)')
}

console.log('7) note dedup by seq (replayed event must not duplicate the text)')
{
  const mark = sentCards.length
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push(
      { type: 'assistant/message', seq: 90, data: { message: { content: [{ type: 'text', text: '同一段叙述' }] } } },
      { type: 'assistant/message', seq: 90, data: { message: { content: [{ type: 'text', text: '同一段叙述' }] } } }, // 同 seq 重放
      { type: 'assistant/message', seq: 91, data: { message: { content: [{ type: 'text', text: '收尾句' }] } } },
    )
  }
  feedInbound('om_seq_dup', 'seq 去重测试')
  await drain()
  const body = JSON.stringify(cardsSince(mark))
  const hits = (body.match(/同一段叙述/g) || []).length
  ok(hits <= 2, 'replayed seq written at most twice across payload history (got ' + hits + ')')
  const lastCard = cardsSince(mark).filter((c) => c.op === 'create').pop()
  const perCard = lastCard ? (JSON.stringify(lastCard.payload).match(/同一段叙述/g) || []).length : 0
  ok(perCard <= 1, 'within a single card payload the text appears once (got ' + perCard + ')')
}

console.log('8) long code fence folds into a collapsible panel')
{
  const mark = sentCards.length
  const longCode = '```bash\n' + Array.from({ length: 20 }, (_, i) => 'echo line ' + i).join('\n') + '\n```'
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 120, data: { message: { content: [{ type: 'text', text: longCode }] } } })
  }
  feedInbound('om_code_fold', '代码块折叠测试')
  await drain()
  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('collapsible_panel'), 'long code fence became a collapsible panel')
  ok(body.includes('点击展开'), 'panel header shows the expand hint')
  ok(body.includes('echo line 19'), 'code content preserved inside the panel')
}

console.log('9) card create is idempotent (empty message_id must not spawn many cards)')
{
  createReturnsEmptyId = true
  const mark = sentCards.length
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 150, data: { message: { content: [{ type: 'text', text: '建卡失败测试' }] } } })
  }
  feedInbound('om_create_fail', '建卡幂等测试')
  await drain()
  // 只统计**流式卡**的 create（schema 2.0）；建卡失败后的兜底纯文本（1.0 结构，sendPlainText）
  // 是设计行为，不算重复建卡。
  const createdAtemps = cardsSince(mark)
    .filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0').length
  createReturnsEmptyId = false
  ok(createdAtemps <= 1, 'card create attempted at most once with empty message_id (got ' + createdAtemps + ')')
}

console.log('10) feishu_send is skipped while this chat has an active card')
{
  const mark = sentCards.length
  // 让这一轮"挂住"：whenIdle 不返回 → activeTurns 里保留活跃卡 → feishu_send 应被跳过
  let release
  const gate = new Promise((r) => { release = r })
  const prevSend = agent.send.bind(agent)
  agent.send = function (message) {
    prevSend(message)
    agentEvents.push({ type: 'assistant/message', seq: 200, data: { message: { content: [{ type: 'text', text: '正在处理…' }] } } })
  }
  const prevIdle = agent.whenIdle.bind(agent)
  agent.whenIdle = () => gate
  feedInbound('om_active_send', '活跃卡期间的 feishu_send')
  await drain()
  const tool = toolNow('feishu_send')
  let decision = null
  if (tool && typeof tool.execute === 'function') {
    decision = await tool.execute({ text: '这段不该另发一条', chatId: CHAT_ID })
  }
  const newMessages = cardsSince(mark).filter((c) => c.op === 'create' && c.payload && !c.payload.schema).length
  ok(decision && decision.ok === true && String(decision.detail).includes('已跳过'),
    'feishu_send reported skipped (got ' + JSON.stringify(decision && decision.detail).slice(0, 60) + ')')
  ok(newMessages === 0, 'no extra plain-text message was posted (got ' + newMessages + ')')
  release()
  agent.whenIdle = prevIdle
  await drain()
}

console.log('11) 表格超限降级：第 6 张起转成可读清单，不再出现原始 | 符号')
{
  // 背景（CM 2026-09-16 反馈）：卡片里表格只看到一堆 `|` 符号。
  // 两个原因：① card watcher 抛 ReferenceError → 卡片更新全挂、退化成纯文本（另有用例覆盖）；
  //          ② 飞书单卡硬上限 5 张表（ErrCode 11310），超出部分原实现降级成 ``` 代码块，
  //             代码块里就是原始竖线 —— 等于把问题换个地方展示。
  // 本用例固化 ② 的新行为：超限表格 → `- **列名**：值 ｜ **列名**：值` 清单。
  const mark = sentCards.length
  const mkTable = (n) => [
    '| 列A' + n + ' | 列B' + n + ' |',
    '| --- | --- |',
    '| 值' + n + '-1 | 值' + n + '-2 |',
  ].join('\n')
  const sixTables = Array.from({ length: 6 }, (_, i) => mkTable(i + 1)).join('\n\n')
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 260, data: { message: { content: [{ type: 'text', text: sixTables }] } } })
  }
  feedInbound('om_table_quota', '表格配额测试')
  await drain()
  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('表格超出飞书单卡上限'), '第 6 张表格触发了降级提示')
  ok(body.includes('**列A6**：值6-1'), '降级后是可读清单（列名：值）而非代码块')
  ok(body.includes('| 列A1 |'), '前 5 张表格保持 markdown 原样（交给飞书渲染成真表格）')
  // 被降级的那张不应再以「| 行」形式出现
  ok(!body.includes('| 列A6 |'), '被降级的表格不再输出原始竖线行')
}
// 说明：用例 11 覆盖的是**降级兜底**路径（单条消息内一次就来 6 张表，换卡救不了这种）。
// 正常路径（跨事件满额）由用例 12 覆盖。

console.log('12) 表格额度换卡：单卡满 5 张表后，后续内容换新卡（表格不降级）')
{
  // CM 2026-09-16 方案：超限不要降级成清单，要**换一张新卡**继续，旧卡保留它已有的表格。
  // 判定发生在 watcher 扫描新事件之前，且要求"有事件待镜像"，所以必须分两波喂事件、
  // 中间让 watcher 跑一轮（drain）。
  const mark = sentCards.length
  const mk = (n) => ['| 列' + n + ' | 值 |', '| --- | --- |', '| a | ' + n + ' |'].join('\n')
  const fiveTables = Array.from({ length: 5 }, (_, i) => mk(i + 1)).join('\n\n')

  let release
  const gate = new Promise((r) => { release = r })
  const prevIdle = agent.whenIdle.bind(agent)
  agent.whenIdle = () => gate               // 让这一轮保持活跃，watcher 不被 seal 停掉
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 320, data: { message: { content: [{ type: 'text', text: fiveTables }] } } })
  }
  feedInbound('om_rotate', '换卡测试')
  await drain()                             // 第一波：5 张表 → 额度用满
  agentEvents.push({ type: 'assistant/message', seq: 321, data: { message: { content: [{ type: 'text', text: mk(6) }] } } })
  await drain()                             // 第二波：应触发换卡，这张表落到新卡
  release()
  agent.whenIdle = prevIdle
  await drain()

  const creates = cardsSince(mark).filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0')
  ok(creates.length >= 2, '满额后新建了第二张卡（create 次数 ' + creates.length + '）')
  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('表格已满'), '新卡带换卡说明（用户知道内容接在哪张卡）')
  ok(body.includes('| 列6 |'), '新卡里的第 6 张表保持 markdown 原样（未被降级）')
  ok(!body.includes('**列6**：'), '第 6 张表没有被降级成清单')
  // 旧卡要先承载过 1~5 张表（表格是 PATCH 更新上去的，不在 create 载荷里），
  // 且**换卡发生在这之后** —— 证明内容是"接着往下写"，不是搬走。
  const ops = cardsSince(mark)
  const createIdx = []
  ops.forEach((c, i) => { if (c.op === 'create' && c.payload && c.payload.schema === '2.0') createIdx.push(i) })
  const beforeSecond = createIdx.length >= 2 ? JSON.stringify(ops.slice(0, createIdx[1])) : ''
  ok(beforeSecond.includes('| 列5 |'), '换卡前旧卡已承载 1~5 张表（内容留在旧卡）')
}

console.log('12b) 元素/体积超限 ⇒ **换卡续写**（旧卡正文原样保留、新卡接续；绝不折叠隐藏）')
{
  // 触发线：CARD_ROTATE_BLOCKS=170（块数 ≈ 元素数）。这里喂 175 段叙述 ⇒ 越过触发线；
  // 再喂一波（watcher 判定要求"有事件待镜像"）⇒ 应换卡，旧卡保留全部叙述 + 一行说明。
  const markR = sentCards.length
  let releaseR
  const gateR = new Promise((r) => { releaseR = r })
  const prevIdleR = agent.whenIdle.bind(agent)
  agent.whenIdle = () => gateR
  agent.send = function (message) {
    this.sent.push(message)
    for (let i = 0; i < 175; i++) {
      agentEvents.push({ type: 'assistant/message', seq: 9900 + i, data: { message: { content: [{ type: 'text', text: '长回合叙述 ' + i }] } } })
    }
  }
  feedInbound('om_rotate_size', '超限换卡')
  await drain()
  // 审查 LOW#819：9900+i（i=0..174）已经用到 9990 ⇒ 撞号会被 seenSeqs 去重、把失败归错因
  agentEvents.push({ type: 'assistant/message', seq: 10100, data: { message: { content: [{ type: 'text', text: '换卡后的续写段' }] } } })
  await drain()
  releaseR()
  agent.whenIdle = prevIdleR
  await drain()

  const createsR = cardsSince(markR).filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0')
  ok(createsR.length >= 2, '超限后新建了第二张卡（create 次数 ' + createsR.length + '）')
  const allR = JSON.stringify(cardsSince(markR))
  ok(allR.includes('已达飞书单卡上限'), '★ 旧卡带"换卡续写"说明（用户知道内容接在哪张卡）')
  ok(allR.includes('本卡') || allR.includes('上一张'), '说明里点明"正文原样保留"')
  // 零丢失：换卡前旧卡的载荷里必须还能看到第 0 段叙述（不被折叠隐藏）
  const firstCreateIdx = cardsSince(markR).findIndex((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0')
  const beforeRotate = firstCreateIdx >= 0 ? JSON.stringify(cardsSince(markR).slice(0, firstCreateIdx + 1)) : ''
  ok(beforeRotate.includes('长回合叙述 0') || allR.includes('长回合叙述 0'),
    '★ 第 0 段叙述**没有丢**（要么在旧卡可见区，要么整卡可检索）')
  ok(allR.includes('换卡后的续写段'), '续写内容落到新卡（游标接续、不重放）')

  // 12c/12d（0.7.8：审查 MED#7095 + MED#2272/MED#967 复核）
  //   ① 换卡时旧卡**不许停在「正在工作中…」**（封口后的卡留着占位符 = 用户看到一张永远"在工作"的死卡）；
  //   ② 换卡说明是**新卡视角**（"上一张卡…这张新卡"）⇒ 只许出现在新卡载荷里，写在旧卡上句句自指。
  const opsR = cardsSince(markR)
  const groupR = []
  for (const c of opsR) {
    if (c.op === 'create' && c.payload && c.payload.schema === '2.0') groupR.push([])
    if (groupR.length) groupR[groupR.length - 1].push(JSON.stringify(c.payload || {}))
  }
  const oldCardBody = groupR.length ? groupR[0].join('') : ''
  const newCardBody = groupR.length > 1 ? groupR.slice(1).join('') : ''
  // ⚠️ 12c 只看旧卡的**最后形态**：建卡那一帧**本来就带**占位符（设计如此），拿整段历史判会假红
  //    （第一版就是这么写的，GREEN 也红 —— 夹具的错，不是代码的错）。
  const oldLastBody = groupR.length ? groupR[0][groupR[0].length - 1] : ''
  ok(!oldLastBody.includes('正在工作中…'),
    '★ 12c 换卡后旧卡**最后形态**不再停在「正在工作中…」（MED#7095：换卡前先摘占位符）')
  // 0.7.9（CM 2026-10-03 ③ 拍板）：指路语写在**旧卡**（读者就在这张卡上），**新卡干净起步**。
  // ⚠️ 这作废了 0.7.8 按审查 MED#967/MED#2272 改成"新卡视角"的方向 —— 以 CM 最新口径为准。
  ok(oldCardBody.includes('本卡内容已达飞书单卡上限') && !newCardBody.includes('本卡内容已达飞书单卡上限'),
    '★ 12d 换卡指路语写在**旧卡**上、新卡干净起步（CM 2026-10-03 ③）')
}

console.log('13) 目标模式：goal 轮自动建卡，过程在飞书可见（2026-09-16 方案 A）')
{
  // 背景（CM 反馈）：目标模式续轮由 @deepseek-ai/dsh-goal-round-driver 以**同会话**注入
  // user/message（source.kind==='goal'）驱动，不经过飞书入站 → 原实现没有建卡入口，
  // 飞书里**完全看不到**目标模式在干什么。本用例固化新行为：
  //   agent/status=running 且本轮是 goal 轮 → 建「🎯 目标模式 · 第 N 轮」卡，复用同一套 watcher；
  //   agent/status=idle → seal + 「✅ 本轮结束」；非 goal 的自动回合**不建卡**（不刷屏）。
  const mark = sentCards.length
  agent.send = function (message) { this.sent.push(message) }   // 目标轮不经过这条路径

  // 1) 会话里注入目标轮触发消息（与 goal-round-driver 同构：data = { content, source }）
  agentEvents.push({
    type: 'user/message', seq: 400,
    data: {
      content: [{ type: 'text', text: '<goal_round>\nRound: 1/10\n</goal_round>' }],
      source: { kind: 'goal', goalId: 'g_smoke', revision: 1, round: 1 },
    },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()

  const opened = createsSince(mark)
  // 2026-09-27（CM 实证"一个内容发两次"）：目标轮**允许复用**同一轮刚封口的回合卡 ——
  // 不再另开一张镜像同一批事件的卡。所以 create 次数 0 或 1 都算对；
  // 关键断言改为「没有多开卡」＋「🎯 目标模式卡面确实出现（新建或复用那张）」。
  ok(opened.length <= 1, '目标轮没有多开卡（create 次数 ' + opened.length + '）')
  const openBody = JSON.stringify(cardsSince(mark))
  ok(openBody.includes('目标模式'), '卡面标明是目标模式')
  ok(openBody.includes('第 1 轮'), '卡面标明轮次')
  ok(!openBody.includes('<goal_round>'), 'goal 提示词本身不搬上卡（只镜像本轮后续事件）')

  // 2) 轮内产出（过程话语 + 工具调用）应当进卡 —— 这就是"中间过程可见"
  agentEvents.push(
    { type: 'assistant/message', seq: 401, data: { message: { content: [{ type: 'text', text: '我先盘点现状。' }] } } },
    { type: 'tool/call', seq: 402, data: { callId: 'call_goal_1', name: 'grep', arguments: '{"pattern":"x"}' } },
    { type: 'tool/result', seq: 403, data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'hit' }] }] } } },
  )
  await drain()
  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('我先盘点现状'), '过程话语进了卡（中间过程可见）')
  ok(body.includes('工具调用'), '工具调用以折叠面板进卡')

  // 3) 轮结束 → 封口
  emitCtx('agent/status', { agent, status: 'idle' })
  await drain()
  ok(JSON.stringify(cardsSince(mark)).includes('本轮结束'), '轮结束封口并写明本轮结束')

  // 4) 非 goal 的自动回合不建卡（噪声控制，CM 拍板口径）
  const mark2 = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 410,
    data: { content: [{ type: 'text', text: '普通消息' }], source: { kind: 'user' } },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()
  emitCtx('agent/status', { agent, status: 'idle' })
  await drain()
  ok(createsSince(mark2).length === 0, '非 goal 的自动回合不自动建卡（不刷屏）')
}

console.log('13b) 目标卡照样享受表格换卡（新功能 × 既有换卡机制的组合验证）')
{
  const mark = sentCards.length
  const mk = (n) => ['| 列' + n + ' | 值 |', '| --- | --- |', '| a | ' + n + ' |'].join('\n')
  agentEvents.push({
    type: 'user/message', seq: 500,
    data: {
      content: [{ type: 'text', text: '<goal_round>\nRound: 2/10\n</goal_round>' }],
      source: { kind: 'goal', goalId: 'g_smoke', revision: 1, round: 2 },
    },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()
  ok(createsSince(mark).length === 1, '第 2 轮重新建卡（上一轮已封口）')

  for (let i = 1; i <= 5; i++) {
    agentEvents.push({ type: 'assistant/message', seq: 500 + i, data: { message: { content: [{ type: 'text', text: mk(i) }] } } })
  }
  await drain()                                    // 第一波：5 张表 → 额度用满
  agentEvents.push({ type: 'assistant/message', seq: 510, data: { message: { content: [{ type: 'text', text: mk(6) }] } } })
  await settle()

  const creates = createsSince(mark)
  ok(creates.length >= 2, '目标卡满额后换新卡（create 次数 ' + creates.length + '）')
  ok(JSON.stringify(cardsSince(mark)).includes('表格已满'), '换卡说明出现（0.7.9：写在**旧卡**上）')

  // 第 6 张表在**新卡**上的落地形态：轮结束的强制同步会把待写内容一次刷出去
  //（换卡后头 400ms 内的普通同步会被 CARD_MIN_INTERVAL 限流跳过，属既有行为，不是目标卡缺陷）。
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()
  const all = cardsSince(mark)
  ok(JSON.stringify(all).includes('本轮结束'), '封口落在换卡后的新卡上（游标已接续，不断链）')
  // 0.7.9（CM 2026-10-03 ③）：换卡说明现在写在**旧卡**上（走 PATCH，不再是新卡的 create）
  // ⇒ 先按"任意 op 里含换卡说明"定位，再把**其后第一张 create** 当作新卡。
  // 0.7.10（独立审查 MED#973 修正）：**必须同时断言 op 类型** —— 只查"短语存在"的话，
  // 把说明写回"新卡的 create"（= 0.7.8 的旧行为）也照样满足 ⇒ 这条断言钉不住它名字里的回归。
  const hintAt = all.findIndex((c) => JSON.stringify(c.payload).includes('表格已满'))
  ok(hintAt >= 0 && all[hintAt].op === 'update',
    '换卡说明写在**旧卡**上（P3：走 PATCH，不是新卡的 create）实际 op=' + (hintAt >= 0 ? all[hintAt].op : 'none'))
  const newStart = all.findIndex((c, i) => i > hintAt && c.op === 'create')
  const onNewCard = newStart >= 0 ? JSON.stringify(all.slice(newStart)) : ''
  ok(onNewCard.includes('| 列6 |') && !onNewCard.includes('**列6**：'),
    '第 6 张表落在新卡且保持 markdown 原样（未被降级）')
  ok(!JSON.stringify(all.slice(0, newStart < 0 ? 0 : newStart)).includes('| 列6 |'),
    '第 6 张表没有跑到旧卡（游标接续不重不漏）')
}

console.log('14) 飞书命令 /goal：目标模式入口（CM 2026-09-16 要求）')
{
  const mark = sentCards.length
  const sentBefore = agent.sent.length
  // 取本次命令的纯文本回复（sendPlainText 发的是 1.0 卡片，elements[0].content 即正文）
  const replyText = () => {
    const creates = sentCards.slice(mark)
      .filter((c) => c.op === 'create' && c.payload && !c.payload.schema && Array.isArray(c.payload.elements))
    const last = creates[creates.length - 1]
    return last ? String(last.payload.elements[0].content || '') : ''
  }

  // ① 命令注册表未接管（execute 返回 undefined）→ 走 goals 服务兜底
  fakeCommands.execute = async () => undefined
  const usesBefore = goalCalls.length
  feedInbound('om_goal_cmd_1', '/goal 把 A 项目的总结写完')
  await drain()
  ok(goalCalls.length === usesBefore + 1 && goalCalls[goalCalls.length - 1].objective === '把 A 项目的总结写完',
    '目标原样传给 goals.create（' + JSON.stringify(goalCalls[goalCalls.length - 1] || null) + '）')
  ok(replyText().includes('目标已创建'), '飞书回复创建结果')
  ok(replyText().includes('开卡更新'), '回复里说明接下来每轮会发进度卡')

  // ② /goal 属于命令，不该被当成普通消息丢给模型
  ok(agent.sent.length === sentBefore, '/goal 没有走普通消息路径（模型未收到）')

  // ③ 命令注册表可用时优先走它（子命令 pause/resume/clear/edit 都由它处理）
  const registry = []
  fakeCommands.execute = async (_agent, line) => { registry.push(line); return { result: { text: 'Goal paused\nStatus: paused' } } }
  feedInbound('om_goal_cmd_2', '/goal pause')
  await drain()
  ok(registry.includes('/goal pause'), '子命令透传到 harness 命令通道（' + JSON.stringify(registry) + '）')
  ok(replyText().includes('Goal paused'), '命令通道的返回原样发回飞书')
  ok(!replyText().includes('开卡更新'), '暂停时不补"会发进度卡"的提示')

  // ④ 无参数 = 查看状态，同样透传
  feedInbound('om_goal_cmd_3', '/goal')
  await drain()
  ok(registry.includes('/goal'), '无参数 /goal 透传为状态查询')

  // ⑤ 注册表也没接管 + 是子命令 → 不静默、给用法（不能把 pause 当成新目标）
  const usesBefore2 = goalCalls.length
  fakeCommands.execute = async () => undefined
  feedInbound('om_goal_cmd_4', '/goal pause')
  await drain()
  ok(goalCalls.length === usesBefore2, '子命令不会被误当成新目标创建')
  ok(replyText().includes('用法：/goal'), '给出用法提示（不静默失败）')
  fakeCommands.execute = async () => undefined
}

// ---- 卡片断言小工具（用例 15 / 15b 共用）----------------------------------------
// 卡片元素取法：切换卡现在是 **schema 2.0 + body.elements**（与流式卡/提问卡同形状，
// 那种形状在真机上被 PATCH 过成千上万次）；这里兼容两种形状，免得断言跟着形状走。
const cardElements = (card) => {
  const p = (card && card.payload) || {}
  if (p.body && Array.isArray(p.body.elements)) return p.body.elements
  return Array.isArray(p.elements) ? p.elements : []
}
// 只认真卡片（带 header）：纯文本回复（sendPlainText）的载荷同样有 elements，
// 不排除的话在"以纯文本结尾"的窗口里会抓到那条消息，断言失败信息会指向错的东西。
const lastCardFrom = (from) => sentCards.slice(from)
  .filter((c) => c.op === 'create' && c.payload && c.payload.header && cardElements(c).length).pop()
// 行文本可能落在两种地方：① 顶层 div（旧版式）② column_set → column → markdown（C 版式"一行一个"）。
// 统一收成 { text: { content } } 形状，老断言不用改。
const divRows = (card) => {
  const out = []
  const take = (e) => {
    if (!e) return
    const c = String((e.text && e.text.content) || e.content || '')
    if (/(^|\n)\s*(▶ )?\d+\. /.test(c)) out.push({ text: { content: c } })
  }
  for (const e of cardElements(card)) {
    if (e.tag === 'column_set') {
      for (const col of (e.columns || [])) for (const el of ((col && col.elements) || [])) take(el)
    } else take(e)
  }
  return out
}
// 按钮取法要兼容两种卡片形状：
//  · 1.0：`{ tag: 'action', actions: [...] }`，按钮自带 `value`
//  · 2.0：`column_set → column → button`，回调走 `behaviors: [{ type: 'callback', value }]`
//    （**2.0 不再支持 action 元素** —— 真机报 230099/200861，见用例 48 的校验）
const allButtons = (card) => {
  const out = []
  const take = (e) => {
    if (!e || e.tag !== 'button') return
    const value = e.value || (Array.isArray(e.behaviors) && e.behaviors[0] && e.behaviors[0].value)
    out.push({ ...e, value })
  }
  for (const e of cardElements(card)) {
    if (e.tag === 'action') for (const b of (e.actions || [])) take(b)
    else take(e)
    for (const col of (e.columns || [])) for (const el of (col && col.elements) || []) take(el)
  }
  return out
}
// `chatId` 只给用例 95 用：模拟「卡被转发到**别的会话**，在那边点一下」的回调形状。
// 第 4 个参数 `msgId`＝被点的那张卡的 message_id。**真机上这个字段恒有**（「✕ 取消」删卡、
// /model 结果原地更新都靠它）；夹具原来不发 ⇒ "写回同一张卡"这条路径在冒烟里根本跑不到。
const tapValue = async (value, operator, chatId, msgId) => {
  fakeProc.output += JSON.stringify({
    type: 'event', eventType: 'card.action.trigger',
    data: {
      action: { tag: 'button', value },
      context: {
        open_chat_id: chatId || CHAT_ID,
        ...(msgId ? { open_message_id: msgId } : {}),
      },
      ...(operator ? { operator } : {}),
    },
  }) + '\n'
  await drain()
}
// L1 版式（CM 2026-10-02 选定）：会话行本身就是一个**整行按钮**，名字在按钮文字里。
// 所以"按名字找行"要查按钮的 fs_j，而不是 divRows。
const sessBtnIndexOf = (card, needle) => {
  const b = allButtons(card).find((x) => x.value && x.value.fs_level === 'sess'
    && String((x.text && x.text.content) || '').includes(needle))
  return b ? Number(b.value.fs_j) : -1
}
const rowIndexOf = (card, needle) => {
  const rows = divRows(card)
  const i = rows.findIndex((e) => String(e.text.content).includes(needle))
  if (i < 0) return -1
  const m = /(\d+)\. /.exec(String(rows[i].text.content))
  return m ? Number(m[1]) - 1 : -1
}

// 一级 F 版式（CM 2026-10-02 选定）**不显示路径**，只显示工作区标题 ⇒ 卡片断言按标题定位。
// 标题就是路径末段（workspaceLeaf 的口径，与 DSH 的 defaultWorkspaceTitle 一致）。
const WS_TITLE_WORK = WORKSPACE.split('/').pop()
const WS_TITLE_OTHER = OTHER_WORKSPACE.split('/').pop()
const WS_TITLE_THIRD = THIRD_WORKSPACE.split('/').pop()

console.log('15) /switch：两级（① 工作区 → ② 该工作区的会话）（CM 2026-10-02 定稿 A 方案）')
{
  const mark = sentCards.length
  const summaryText = '帮我看看上周的复盘记录'
  const ownId = createdSessionIds[0]
  persistedSessions = [
    { version: 0, id: ownId, createdAt: Date.now() - 7200e3, cwd: WORKSPACE },                    // 已在本聊天
    { version: 0, id: 'gui-session-aaaa1111', createdAt: Date.now() - 3600e3, cwd: WORKSPACE },
    { version: 0, id: 'fu-session-bbbb2222', createdAt: Date.now() - 1800e3, cwd: OTHER_WORKSPACE },
    { version: 0, id: 'sub-child-cccc3333', createdAt: Date.now() - 600e3, cwd: WORKSPACE, origin: 'subagent' },
  ]
  persistedFirstText['gui-session-aaaa1111'] = summaryText
  persistedFirstText['fu-session-bbbb2222'] = 'FU 会话（示例标题）'

  // ① 第一级：工作区卡
  feedInbound('om_switch_ws', '/switch')
  await drain()
  const wsCard = lastCardFrom(mark)
  const wsBody = JSON.stringify(wsCard && wsCard.payload)
  ok(Boolean(wsCard) && wsBody.includes('第一步：选工作区'), '第一级是工作区卡（卡面写明"第一步"）')
  ok(wsBody.includes(WS_TITLE_WORK) && wsBody.includes(WS_TITLE_OTHER), '两个工作区（按标题）都列出来了')
  ok(!wsBody.includes('gui-sess') && !wsBody.includes('fu-sess'),
    '第一级**不列任何会话**（旧卡"标题写其它工作区、其实列的是会话"那个歧义消失）')
  const wsRowsShown = divRows(wsCard)
  ok(wsRowsShown.length === 2, '工作区卡共 2 行（' + wsRowsShown.length + '）')
  const curWsRow = wsRowsShown.find((e) => String(e.text.content).includes(WS_TITLE_WORK))
  ok(Boolean(curWsRow) && String(curWsRow.text.content).includes('▶'), '当前工作区带 ▶ 标记')
  // 正例（门槛第三轮 medium，按 CM 选定的一级 F 版式调整）：F 版式**不显示** 🟢（无用的信息不显示），
  // 只在目录**真的不存在**时显示 ⚠️ ⇒ 这里反过来断言"存在的目录**不许**出现 ⚠️"，
  // 与 15b 的"目录不存在 ⇒ ⚠️"形成对照。若 dirExists() 恒假，这条会立刻变红。
  ok(wsRowsShown.every((e) => !String(e.text.content).includes('⚠️')),
    '存在的目录**不出现** ⚠️（与 15b 的"目录不存在 ⇒ ⚠️"形成对照）')
  const wsIndexWork = rowIndexOf(wsCard, WS_TITLE_WORK)
  const wsIndexOther = rowIndexOf(wsCard, WS_TITLE_OTHER)
  ok(wsIndexWork >= 0 && wsIndexOther >= 0,
    '两行序号可读（work=' + (wsIndexWork + 1) + ', other=' + (wsIndexOther + 1) + '）')
  const wsButtons = allButtons(wsCard)
  ok(wsRowsShown.every((_, i) => wsButtons.some((b) => b.value.fs_level === 'ws' && b.value.fs_i === i)),
    '每行都有「进入看会话」按钮，且 fs_i 对得上行号')
  ok(wsRowsShown.every((_, i) => wsButtons.some((b) => b.value.fs_level === 'ws-new' && b.value.fs_i === i)),
    '每行都有「新建」按钮，且 fs_i 对得上行号')
  // CM 2026-10-02：「两个按钮要**同一排**，不要分成两行」。
  // 渲染在飞书侧，冒烟看不到像素 —— 但能验结构：那两行按钮必须落在**同一个 column_set**
  // （两列 + flex_mode='bisect' 等分），而不是两个独立元素（那就必然上下两行）。
  const oneRowOk = wsRowsShown.every((_, i) => {
    const rowEl = cardElements(wsCard).find((e) => e.tag === 'column_set'
      && (e.columns || []).some((c) => ((c && c.elements) || []).some((el) => {
        const v = el && el.behaviors && el.behaviors[0] && el.behaviors[0].value
        return v && v.fs_level && v.fs_i === i
      })))
    return Boolean(rowEl) && rowEl.columns.length === 2 && rowEl.flex_mode === 'bisect'
  })
  ok(oneRowOk, '每个工作区行的两个按钮在**同一排**（同一 column_set、两列、bisect 等分）')

  // ② 点「进入」→ 该工作区的会话卡（走真实卡片回调路径）
  const enterBtn = wsButtons.find((b) => b.value.fs_level === 'ws' && b.value.fs_i === wsIndexWork)
  const enterMark = sentCards.length
  // 按钮缺失时上面那条 ok() 已经记账失败；这里再解引用会崩成 TypeError、把失败信息盖掉。
  if (enterBtn) await tapValue(enterBtn.value)
  // ⭐ CM 2026-10-02 实测投诉：「点一下就弹一张新卡片」「切一次能弹三四张」⇒ 必须**原地更新**
  const enterUpdates = sentCards.slice(enterMark).filter((c) => c.op === 'update')
  ok(sentCards.slice(enterMark).filter((c) => c.op === 'create').length === 0,
    '点「进入」**没有新发卡片**（原地更新同一张）')
  ok(enterUpdates.length > 0, '而是 PATCH 了原来那张卡')
  // 原地更新后，"会话卡"的内容要从那条 update 里取（不是新建的卡）
  const sessCard = enterUpdates.length ? enterUpdates[enterUpdates.length - 1] : undefined
  const sBody = JSON.stringify(sessCard && sessCard.payload)
  ok(Boolean(sessCard) && sBody.includes('第二步：选会话'), '第二级是会话卡')
  // CM 2026-10-02 选定 **二级 C 版式**（一行一个会话：标题 + 状态徽标）⇒ 卡上**不再显示短 id**
  ok(!sBody.includes('gui-sess'), 'C 版式不显示短 id（只有标题 + 状态徽标）')
  ok(sBody.includes(summaryText), '其它会话带了首条消息摘要（认得出是哪个）')
  ok(!sBody.includes('sub-chil'), '子代理子会话不被列为可切换目标')
  ok(!sBody.includes('fu-sess'), '**只列这个工作区的会话**（别的工作区的会话不串进来）')
  const sessBottom = allButtons(sessCard).map((b) => b.value && b.value.fs_level)
  ok(!sessBottom.includes('ws-new'), '二级底部**没有**「新建」（CM：下面新建不要，只留返回、取消）')
  ok(sessBottom.includes('ws-back'), '底部有「← 返回」')
  ok(sessBottom.includes('cancel'), '底部有「✕ 取消」（一按就撤销整张卡）')
  ok(cardElements(sessCard).filter((e) => e.tag === 'hr').length >= 1, '会话之间有分隔线')
  ok(allButtons(sessCard).some((b) => b.value && b.value.fs_level === 'sess'
    && String((b.text && b.text.content) || '').includes(summaryText)),
    'L1 版式：会话名**写在整行按钮里**（点名字即切换）')
  ok(JSON.stringify(sessCard.payload).includes('第 1/'), '二级卡片标明页码（第 1/N 页）')
  const guiIndex = sessBtnIndexOf(sessCard, summaryText)
  ok(guiIndex >= 0, '候选行的序号可读（gui=' + (guiIndex + 1) + '）')
  const sessRowBtns = allButtons(sessCard).filter((b) => b.value && b.value.fs_level === 'sess')
  ok(sessRowBtns.length > 0 && sessRowBtns.every((b) => b.value.fs_mode === 'takeover'),
    '会话行的按钮全部是「切换」语义（CM：这里应该是切换，不是新建）')
  ok(!allButtons(sessCard).some((b) => b.value && b.value.fs_level === 'ws-new'),
    '二级卡片上没有「新建」（CM：下面新建不要，只留返回、取消）')
  ok(allButtons(sessCard).some((b) => b.value && b.value.fs_level === 'ws-back'),
    '底部同排还有「返回工作区」')
  const sessButtons = allButtons(sessCard)
  const takeover = sessButtons.find((b) => b.value.fs_level === 'sess' && b.value.fs_j === guiIndex
    && b.value.fs_mode === 'takeover')
  ok(Boolean(takeover), '空闲会话给了「接管」按钮')
  const tookBefore = resumedSessions
  const takeoverMark = sentCards.length
  if (takeover) await tapValue(takeover.value)
  ok(resumedSessions === tookBefore + 1, '点「接管」真的 resume 了那个会话（接管生效）')
  ok(cardsSince(takeoverMark).filter((c) => c.op === 'create').length === 0,
    '接管后**没有新发卡片**（结果写回同一张）')
  ok(JSON.stringify(cardsSince(takeoverMark)).includes('已接管'), '结果直接显示在原来那张卡上')
  // 2026-10-02 CM：「切换了…那个卡片就是已切换就行了，就不要有一个返回按钮啊」
  // ⇒ 结果卡＝**终态卡**：一个按钮都不留（旧写法挂了个「← 回到工作区列表」）。
  const resultCard = sentCards.slice(takeoverMark).filter((c) => c.op === 'update').pop()
  ok(Boolean(resultCard) && allButtons(resultCard).length === 0,
    '结果卡是终态卡：一个按钮都没有（实际 ' + (resultCard ? allButtons(resultCard).length : '?') + ' 个）')
  ok(!JSON.stringify(cardsSince(takeoverMark)).includes('回到工作区列表'),
    '结果卡/提示文案里不再出现「回到工作区列表」（那个按钮已经删了，留着就是让人去点空气）')
  ok(registryAttached.some((a) => a.id === 'gui-session-aaaa1111'),
    '接管时把会话**挂进了工作区注册表**（与 GUI 同源：侧边栏也看得到）')

  // ③ /list ＝ 当前工作区的会话（不再混工作区，也不列别的工作区的会话）
  const listMark = sentCards.length
  feedInbound('om_list_ws', '/list')
  await drain()
  const listBody = JSON.stringify(cardsSince(listMark))
  ok(listBody.includes('工作区') && listBody.includes(WORKSPACE), '/list 顶部标明当前工作区')
  ok(listBody.includes(summaryText) || listBody.includes('gui-sess'), '/list 列出当前工作区的会话')
  ok(!listBody.includes('fu-sess'), '/list 不列别的工作区的会话')

  // ④ 文字：/switch <工作区序号> new → 在该工作区新建（cwd 必须是那个工作区）＋ 也挂进注册表
  const beforeNew = createdSessions
  feedInbound('om_switch_new', '/switch ' + (wsIndexOther + 1) + ' new')
  await drain()
  ok(agent.session.header.cwd === OTHER_WORKSPACE,
    'new 模式把新会话的 cwd 设成了那个工作区（实际 ' + agent.session.header.cwd + '）')
  ok(createdSessions === beforeNew + 1, '确实新建了会话')
  // 别硬编码 'ws-2'：那只是 seed() 顺序的副产物。从注册表里按路径取真 id（门槛第三轮 low）。
  const otherEntity = fakeWorkspaceRegistry._entities.find((e) => e.path === OTHER_WORKSPACE)
  ok(Boolean(otherEntity) && registryAttached.some((a) => a.ws === otherEntity.id),
    '新建的会话也挂进了那个工作区（GUI 侧边栏能看到）')

  // ⑤ 运行中的会话（🟡）只给「新建」；文字接管也必须被挡住
  liveAgents.push({ id: 'fu-session-bbbb2222', session: agent.session })
  const liveMark = sentCards.length
  feedInbound('om_switch_live', '/switch ' + (wsIndexOther + 1))
  await drain()
  const liveCard = lastCardFrom(liveMark)
  const liveBody = JSON.stringify(liveCard && liveCard.payload)
  const liveFuRowEl = divRows(liveCard).find((e) => String(e.text.content).includes('FU 会话（示例标题）'))
  ok(Boolean(liveFuRowEl) && String(liveFuRowEl.text.content).includes('🟡'),
    '运行中会话**那一行**被标成 🟡（不是卡面图例里有就算）')
  ok(liveBody.includes('不能切换'), '卡面说明了 🟡 的规则（不让 CM 猜）')
  const liveFuIndex = rowIndexOf(liveCard, 'FU 会话（示例标题）')
  ok(liveFuIndex >= 0, '🟡 那一行在列表里（序号 ' + (liveFuIndex + 1) + '）')
  const liveBtns = allButtons(liveCard)
    .filter((b) => b.value.fs_level === 'sess' && b.value.fs_j === liveFuIndex)
  ok(liveBtns.length === 0,
    '运行中的会话**那一行不给按钮**（原来给的是「新建」，语义错位；现在只写"不能切换"）')
  ok(String(liveFuRowEl.text.content).includes('不能切换'),
    '并在那一行写明"正在别处运行 —— 不能切换"')
  const blockMark = sentCards.length
  feedInbound('om_switch_live_takeover', '/switch ' + (wsIndexOther + 1) + ' ' + (liveFuIndex + 1))
  await drain()
  ok(JSON.stringify(cardsSince(blockMark)).includes('正在别处运行'), '文字接管被挡下并说明原因')
  liveAgents.length = 0

  // ⑥ 「← 返回工作区列表」→ 回到第一级
  const backBtn = allButtons(sessCard).find((b) => b.value.fs_level === 'ws-back')
  ok(Boolean(backBtn), '会话卡有「← 返回」按钮')
  const backMark = sentCards.length
  if (backBtn) await tapValue(backBtn.value)
  ok(JSON.stringify(cardsSince(backMark)).includes('选择工作区'), '点返回回到工作区卡')
  ok(cardsSince(backMark).filter((c) => c.op === 'create').length === 0, '点「返回」也没有新发卡片')
}

console.log('15b) /switch 边界：注册表不可用 / 目录不存在 / 未注册工作区 / 服务名与方法缺失（门槛第二、三轮补）')
{
  // ⚠️ 用例内会 create 新工作区、追加会话、动 mock 的 cwd —— 用 try/finally 保证**无论中途是否抛**
  // 都还原（原来不是 guarded：中途一抛，_entities 会停在空数组上，把后面所有用例都毒掉）。
  // 注：chat.sessions/activeIndex 在插件内部、测试拿不到，只能保证持久化与注册表两侧自洽 ——
  // 所以这里**保留**追加的那条 third 会话（不还原 persistedSessions），避免"chat 还引用着、
  // 持久化里却没了"的悬空状态。
  const entitiesBefore = fakeWorkspaceRegistry._entities.slice()
  const cwdBefore = agent.session.header.cwd
  try {
    // (a) 未注册工作区：目录只从**会话 cwd** 兜底出现，且接管时必须能挂进注册表
    //     （走 resolveByPath → create → attachSession —— 这条链此前从未被跑过）
    persistedSessions.push({ version: 0, id: 'third-session-dddd4444', createdAt: Date.now() - 300e3, cwd: THIRD_WORKSPACE })
    const markA = sentCards.length
    feedInbound('om_switch_third', '/switch')
    await drain()
    const cardA = lastCardFrom(markA)
    const thirdIndex = rowIndexOf(cardA, WS_TITLE_THIRD)
    ok(thirdIndex >= 0, '注册表里没有、只在会话 cwd 里出现的目录，也作为兜底工作区出现（序号 ' + (thirdIndex + 1) + '）')
    // 序号从卡面读回来（别写死），并让下面按同一个序号接管
    feedInbound('om_switch_third_takeover', '/switch ' + (thirdIndex + 1) + ' 1')
    await drain()
    // 断言钉住**是哪条会话**挂上了：只判"有东西挂上"的话，就算挂错了工作区也会绿（门槛第三轮 low）。
    ok(registryAttached.some((a) => a.id === 'third-session-dddd4444'),
      '在**未注册**工作区接管时，**这条会话**挂进了注册表（走 resolveByPath/create → attachSession）')

    // (b) 目录不存在 ⇒ ⚠️（以本地目录检查为准，不只信注册表那个 token）
    fakeWorkspaceRegistry._entities.push(
      makeRegistryEntity(SMOKE_WS_ROOT + '/fs-smoke-ghost-does-not-exist', 'ghost', 'ws-ghost'))
    const markB = sentCards.length
    feedInbound('om_switch_ghost', '/switch')
    await drain()
    const ghostCard = lastCardFrom(markB)
    const ghostRow = divRows(ghostCard).find((e) => String(e.text.content).includes('ghost'))
    ok(Boolean(ghostRow) && String(ghostRow.text.content).includes('⚠️'),
      '目录不存在的行标 ⚠️（注册表说 ok 也不算健康）')
    fakeWorkspaceRegistry._entities.pop()

    // (c) 注册表整个不可用 ⇒ 用会话 cwd 兜底，而不是给一张空卡
    fakeWorkspaceRegistry._entities = []
    const markC = sentCards.length
    feedInbound('om_switch_noregistry', '/switch')
    await drain()
    const cardC = lastCardFrom(markC)
    const cBody = JSON.stringify(cardC && cardC.payload)
    ok(Boolean(cardC) && cBody.includes(WS_TITLE_WORK),
      '注册表不可用（空）时仍列出会话里出现过的工作区（不让用户对着空卡）')
    fakeWorkspaceRegistry._entities = entitiesBefore

    // (d) 注册表**只**以客户端服务名 workspaces 暴露、而且**没有 get()**：
    //     ① 工作区卡照样读得到（服务名两种都认）② 接管时的挂载走 resolveByPath/create（逐个方法判可用）
    const clientOnly = {
      list: () => fakeWorkspaceRegistry.list(),
      resolveByPath: async (p) => fakeWorkspaceRegistry._entities.find((e) => e.path === p),
      create: async (p, t) => fakeWorkspaceRegistry.create(p, t),
    }
    registryOverride = clientOnly
    const markD = sentCards.length
    feedInbound('om_switch_clientonly', '/switch')
    await drain()
    const cardD = lastCardFrom(markD)
    const dBody = JSON.stringify(cardD && cardD.payload)
    ok(Boolean(cardD) && dBody.includes(WS_TITLE_WORK) && dBody.includes('选择工作区'),
      '注册表只以 workspaces 暴露时，工作区卡照样出得来（服务名两种都认）')
    const dIndex = rowIndexOf(cardD, WS_TITLE_OTHER)
    const attachBeforeD = registryAttached.length
    feedInbound('om_switch_clientonly_takeover', '/switch ' + (dIndex + 1) + ' 1')
    await drain()
    ok(registryAttached.length > attachBeforeD,
      '该注册表没有 get() 时，挂载仍能走 resolveByPath/create（逐个方法判可用）')
    registryOverride = null
  } finally {
    registryOverride = null
    fakeWorkspaceRegistry._entities = entitiesBefore
    agent.session.header.cwd = cwdBefore
  }
}

console.log('15c) 文字命令的会话卡：按钮序号必须指向**那个**工作区（门槛第四轮抓到的回归）')
{
  // 回归原形：我在 0.5.2 里把 /list 路径上真死的那句 `ws.index = wsIndex` 连**文字命令路径上活着的那句**
  // 一起删了 ⇒ /switch <n> 出来的会话卡里，按钮的 fs_i 全是 0 ⇒
  // 在**空工作区**点「在这里新建会话」会在**第一个**工作区建会话（用户选的工作区被无视）。
  const emptyPath = SMOKE_WS_ROOT + '/fs-smoke-empty'
  try { mkdirSync(emptyPath, { recursive: true }) } catch { /* 已存在 */ }
  const entitiesBefore15c = fakeWorkspaceRegistry._entities.slice()
  try {
    fakeWorkspaceRegistry._entities.push(makeRegistryEntity(emptyPath, 'empty-ws', 'ws-empty'))
    const mark = sentCards.length
    feedInbound('om_switch_empty', '/switch')
    await drain()
    const wsCard15c = lastCardFrom(mark)
    const emptyIndex = rowIndexOf(wsCard15c, 'empty-ws')
    ok(emptyIndex >= 0, '空工作区出现在工作区卡上（序号 ' + (emptyIndex + 1) + '）')
    const sessMark = sentCards.length
    feedInbound('om_switch_empty_open', '/switch ' + (emptyIndex + 1))
    await drain()
    const sessCard15c = lastCardFrom(sessMark)
    ok(Boolean(sessCard15c) && JSON.stringify(sessCard15c.payload).includes('还没有会话'),
      '空工作区在会话卡上给出「在这里新建会话」入口')
    // 二级现在没有「新建」了（CM 要求）⇒ 新建走**一级菜单**那个按钮，它同样必须带上正确的工作区序号
    const newBtn = allButtons(wsCard15c).find((b) => b.value && b.value.fs_level === 'ws-new' && b.value.fs_i === emptyIndex)
    ok(Boolean(newBtn), '一级菜单上「新建」按钮指向这个工作区（fs_i=' + emptyIndex + '）')
    if (newBtn) await tapValue(newBtn.value)
    ok(agent.session.header.cwd === emptyPath,
      '点它新建出来的会话 cwd 就是该工作区（实际 ' + agent.session.header.cwd + '）')
    // 二级卡片的按钮（返回/取消）也必须带**那个**工作区的序号：
    // 缺了 ws.index 它们会全变 0 ⇒ 返回/翻页会跑到第一个工作区去（这正是门槛抓到的回归）。
    const backOnEmpty = allButtons(sessCard15c).find((b) => b.value && b.value.fs_level === 'ws-back')
    ok(Boolean(backOnEmpty) && backOnEmpty.value.fs_i === emptyIndex,
      '二级卡片的按钮序号也指向这个工作区（fs_i=' + (backOnEmpty && backOnEmpty.value.fs_i) + '，期望 ' + emptyIndex + '）')
  } finally {
    fakeWorkspaceRegistry._entities = entitiesBefore15c
  }
}

console.log('15d) 二级卡片：每页 5 个 + 翻页 + 会话间分隔线（CM 2026-10-02 三条）')
{
  const persistedBefore15d = persistedSessions.slice()
  try {
    for (let i = 0; i < 7; i++) {
      persistedSessions.push({
        version: 0, id: 'page-session-' + i,
        createdAt: Date.now() - (i + 1) * 60e3, cwd: WORKSPACE,
      })
    }
    const mark = sentCards.length
    feedInbound('om_page_ws', '/switch')
    await drain()
    const wsCard = lastCardFrom(mark)
    const wsIdx = rowIndexOf(wsCard, WS_TITLE_WORK)
    ok(wsIdx >= 0, '工作区卡上找到 work（序号 ' + (wsIdx + 1) + '）')
    const enterBtn = allButtons(wsCard).find((b) => b.value.fs_level === 'ws' && b.value.fs_i === wsIdx)
    const openMark = sentCards.length
    if (enterBtn) await tapValue(enterBtn.value)
    const upd = sentCards.slice(openMark).filter((c) => c.op === 'update')
    const page1 = upd.length ? upd[upd.length - 1] : lastCardFrom(openMark)
    const p1Body = JSON.stringify(page1 && page1.payload)
    ok(p1Body.includes('第 1/'), '第 1 页标明「第 1/N 页」')
    const page1Rows = allButtons(page1).filter((b) => b.value && b.value.fs_level === 'sess').length
    ok(page1Rows === 5, '每页只列 5 个会话（实际 ' + page1Rows + '）')
    ok(cardElements(page1).filter((e) => e.tag === 'hr').length >= 4,
      '会话之间加了分隔线（' + cardElements(page1).filter((e) => e.tag === 'hr').length + ' 条 hr）')
    const nextBtn = allButtons(page1).find((b) => b.value.fs_level === 'page' && b.value.fs_page === 1)
    ok(Boolean(nextBtn), '第 1 页有「下一页 →」')
    const p2Mark = sentCards.length
    if (nextBtn) await tapValue(nextBtn.value)
    const upd2 = sentCards.slice(p2Mark).filter((c) => c.op === 'update')
    const page2 = upd2.length ? upd2[upd2.length - 1] : undefined
    ok(JSON.stringify(page2 && page2.payload).includes('第 2/'), '翻到第 2 页')
    const page2Rows = allButtons(page2).filter((b) => b.value && b.value.fs_level === 'sess').length
    ok(page2Rows >= 1 && page2Rows <= 5, '第 2 页列出剩下的会话（' + page2Rows + ' 个）')
    ok(cardsSince(p2Mark).filter((c) => c.op === 'create').length === 0, '翻页是原地更新（不弹新卡）')
    ok(allButtons(page2).some((b) => b.value.fs_level === 'page' && b.value.fs_page === 0), '第 2 页有「← 上一页」')
  } finally {
    persistedSessions = persistedBefore15d
  }
}

console.log('16) 目标轮封口必须补扫：收尾汇报不能丢（CM 2026-09-16 实测反馈）')
{
  // 背景（真机取证）：FU 机器人目标模式 round 2~6 的卡片全是 notes=0、只有工具记录，
  // 而会话日志里确实有整段「**进度（第 N 轮）**…」。根因＝封口时**没有补扫**：
  // 工具调用是轮内陆续到达的（被 300ms watcher 拍到），收尾话语与轮结束几乎同时到，
  // 落在最后一拍之后 → 直接被丢掉。普通回合路径有 catch-up scan，目标卡漏了。
  const mark = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 600,
    data: {
      content: [{ type: 'text', text: '<goal_round>\nRound: 3/10\n</goal_round>' }],
      source: { kind: 'goal', goalId: 'g_seal', revision: 1, round: 3 },
    },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()
  ok(createsSince(mark).length === 1, '第 3 轮建卡')

  agentEvents.push({ type: 'tool/call', seq: 601, data: { callId: 'call_seal_1', name: 'read', arguments: '{"file_path":"a.md"}' } })
  await drain()

  // 收尾汇报：**紧接**轮结束到达，中间不给 watcher 任何一拍。
  // 同时塞进"倒数第二段话"和一个工具调用 —— 这两样**只有补扫**才会进卡
  // （提升逻辑只搬最后一段话；去掉补扫时它们必须消失，否则这测试就是假保险丝）。
  const midText = '窗口外的中途交代-MID'
  const closing = '**进度（第 3 轮）** ' + 'A'.repeat(700) + ' 收尾标记-END'
  agentEvents.push({ type: 'assistant/message', seq: 602, data: { message: { content: [{ type: 'text', text: midText }] } } })
  agentEvents.push({ type: 'tool/call', seq: 603, data: { callId: 'call_seal_2', name: 'fuse_probe_tool', arguments: '{"x":1}' } })
  agentEvents.push({ type: 'assistant/message', seq: 604, data: { message: { content: [{ type: 'text', text: closing }] } } })
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()

  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('收尾标记-END'), '封口补扫到了收尾汇报')
  ok(body.includes(midText), '末刻到达的中途话语也在卡上（只有补扫能做到 → 真保险丝）')
  ok(body.includes('fuse_probe_tool'), '末刻到达的工具调用也在卡上（只有补扫能做到）')
  ok((body.match(/收尾标记-END/g) || []).length === 1, '收尾汇报只出现一次（不重复）')
  ok(body.includes('A'.repeat(600)), '收尾汇报按正式消息块写入，未被 500 字过程话语截断（600 个连续 A 仍在）')
  ok(body.includes('本轮结束'), '仍然写了「本轮结束」')
}

console.log('17) 本轮没有回复时必须说明原因（2026-09-18 真机事故：账户余额不足 402 → 卡片空白）')
{
  // 背景（真机取证，会话 fs-main-mu532zzl seq=724-727）：
  //   用户消息 → assistant/attempt(finish.reason=error{message:'Insufficient Balance',code:'QUOTA',status:402})
  //   → step/end → turn/end(reason.kind='error')，**整轮没有任何 assistant/message**。
  // 旧行为：卡片只写「（Agent 未产生文字回复）」、状态行还显示「✅ 已完成」；
  //   自愈重建会话时旧卡停在「正在工作中…」成为孤儿卡，重建提示只走纯文本兜底 → 用户看不到。
  // 新行为（本用例固化）：① 卡面写明上游原因（**中文人话 ＋ 原文**）；
  //   ② 失败回合状态行是「失败」不是「已完成」；③ 旧卡补封、不再停在「正在工作中…」；
  //   ④ 上游已明确报错 ⇒ **不再自愈重建**（2026-09-21 用户反馈：重建修不了欠费，
  //      还把报错换成「已自动重建会话重试」）—— 自愈只留给「无产出且无失败标记」（用例 20）。
  const mark = sentCards.length
  let sendCount = 0
  // 真实回合不会瞬间结束：给建卡留出落地时间，否则这张卡来不及创建就被封口，
  // 测不到"旧卡停在正在工作中"这条（真机 14:35:28 建卡 / 14:35:29 重试，中间隔了一拍）。
  agent.whenIdle = async () => { await new Promise((r) => setTimeout(r, 80)) }
  agent.send = function (message) {
    this.sent.push(message)
    sendCount += 1
    const base = 1000 + sendCount * 10
    const failure = { message: 'Insufficient Balance', code: 'QUOTA', status: 402 }
    agentEvents.push(
      { type: 'user/message', seq: base, data: { content: [{ type: 'text', text: String(message.content[0].text) }], source: { kind: 'user' } } },
      { type: 'assistant/attempt', seq: base + 1, data: { turn: sendCount, step: 1, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure } } }] } },
      { type: 'turn/end', seq: base + 2, data: { turn: sendCount, reason: { kind: 'error', error: failure } } },
    )
  }
  feedInbound('om_balance_402', '余额不足测试')
  await settle(4)

  const ops = cardsSince(mark)
  const body = JSON.stringify(ops)
  // 2026-09-21 行为变更（用户：「它不会提示我欠费…就直接显示说本轮没有回复」）：
  //   ① 原因必须是**中文人话 ＋ 上游原文**（旧断言只查英文原文）；
  //   ② 上游已明确报错 ⇒ **不再自愈重建**（重建修不了欠费；旧行为每条消息白跑一轮、
  //      还把报错换成「已自动重建会话重试」）⇒ 本轮**只建 1 张卡**。
  ok(ops.filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0').length === 1,
    '上游报错时不再重建会话（只 1 张卡；实际 ' + ops.filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0').length + '）')
  ok(body.includes('账户欠费'), '卡面用中文写明"账户欠费／余额不足"（不再只甩英文）')
  ok(body.includes('Insufficient Balance') && body.includes('QUOTA'),
    '卡面同时保留上游原文（Insufficient Balance / QUOTA 402，便于核对）')
  ok(!body.includes('已自动重建会话'), '不再把报错换成「已自动重建会话重试」（它修不了欠费）')
  ok(body.includes('⚠️'), '卡片带警示标记（不是一句干巴巴的占位符）')
  ok(statusShows(body, '失败'), '失败回合的状态栏写「失败」')
  ok(!statusShows(body, '已完成'), '失败回合不再假称「已完成」')

  // 每张卡（create → 其后 update 为一组）的最后形态里都不该再留着「正在工作中…」
  const perCard = []
  for (const c of ops) {
    if (c.op === 'create' && c.payload && c.payload.schema === '2.0') perCard.push(c.payload)
    else if (perCard.length) perCard[perCard.length - 1] = c.payload
  }
  ok(!JSON.stringify(perCard).includes('正在工作中'),
    '没有卡片停在「正在工作中…」（旧卡被补封，不留孤儿卡）')
}

console.log('18) 有工具调用但最终失败的回合：工具面板 + 原因 + 失败状态（与自愈路径的组合验证）')
{
  // 组合点：hadOutput = lastSeq!==undefined || card.tools.size>0 —— 有工具调用就**不**触发自愈重建，
  // 所以这条必须自己把原因写在卡上，且**不能**把已有工具面板挤掉（工具面板 × 失败提示 × 状态行）。
  const mark = sentCards.length
  let sendCount = 0
  agent.whenIdle = async () => { await new Promise((r) => setTimeout(r, 80)) }
  agent.send = function (message) {
    this.sent.push(message)
    sendCount += 1
    const base = 2000 + sendCount * 10
    const failure = { message: 'Insufficient Balance', code: 'QUOTA', status: 402 }
    agentEvents.push(
      { type: 'user/message', seq: base, data: { content: [{ type: 'text', text: String(message.content[0].text) }], source: { kind: 'user' } } },
      { type: 'tool/call', seq: base + 1, data: { callId: 'call_balance_1', name: 'read', arguments: '{"file_path":"a.md"}' } },
      { type: 'tool/result', seq: base + 2, data: { message: { source: { callId: 'call_balance_1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } },
      { type: 'assistant/attempt', seq: base + 3, data: { turn: sendCount, step: 2, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure } } }] } },
      { type: 'turn/end', seq: base + 4, data: { turn: sendCount, reason: { kind: 'error', error: failure } } },
    )
  }
  feedInbound('om_balance_tools', '有工具调用但失败的回合')
  await settle(4)

  const ops = cardsSince(mark)
  const body = JSON.stringify(ops)
  ok(ops.filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0').length === 1,
    '有工具产出 → 不触发自愈重建（只 1 张卡）')
  ok(body.includes('工具调用'), '工具面板照常进卡（没被失败提示挤掉）')
  ok(body.includes('call_balance_1') || body.includes('a.md'), '工具参数摘要照常进卡')
  ok(body.includes('Insufficient Balance'), '卡面写明失败原因')
  ok(statusShows(body, '失败'), '状态栏写「失败」')
  ok(!statusShows(body, '已完成'), '不假称「已完成」')
}

console.log('19) 目标轮失败也要说原因（不再无条件写「✅ 本轮结束」）')
{
  // 与用例 17 同源的问题：目标轮封口**无条件**写「✅ 本轮结束」+ status='sealed'
  // → 余额不足/上游报错导致整轮没有任何产出时，卡片谎报成功且不写原因。
  const mark = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 700,
    data: {
      content: [{ type: 'text', text: '<goal_round>\nRound: 4/10\n</goal_round>' }],
      source: { kind: 'goal', goalId: 'g_seal', revision: 1, round: 4 },
    },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()
  // 2026-09-27：允许复用刚封口的回合卡 → 新建 0~1 张都算对；要求「没多开」＋「🎯 卡面出现」
  ok(createsSince(mark).length <= 1, '第 4 轮没有多开卡（create 次数 ' + createsSince(mark).length + '）')
  ok(JSON.stringify(cardsSince(mark)).includes('目标模式'), '第 4 轮的 🎯 卡面出现（新建或复用）')

  const failure = { message: 'Insufficient Balance', code: 'QUOTA', status: 402 }
  agentEvents.push(
    { type: 'assistant/attempt', seq: 701, data: { turn: 4, step: 1, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure } } }] } },
    { type: 'turn/end', seq: 702, data: { turn: 4, reason: { kind: 'error', error: failure } } },
  )
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()

  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('Insufficient Balance'), '目标轮卡写明失败原因')
  ok(body.includes('本轮失败'), '封口写「本轮失败」')
  ok(!body.includes('本轮结束'), '失败轮不再写「✅ 本轮结束」')
  ok(statusShows(body, '失败'), '状态栏写「失败」')
}

console.log('20) 无产出且**没有**失败标记：明说「原因未上报」，僵尸会话自愈仍然保留')
{
  // 2026-09-21 用户实锤：卡片只说「本轮没有回复」、不给任何原因。
  // 两种来源都要堵住：①上行有失败标记（用例 17）②上行**没有**标记（本用例）。
  // 后者正是 2026-09-08「僵尸会话」的形态（重启后当轮被腰斩、事件一个都没落），
  // 所以**自愈必须保留**；但封口的旧卡不能只留一句占位符。
  const mark = sentCards.length
  let sendCount = 0
  agent.whenIdle = async () => { await new Promise((r) => setTimeout(r, 80)) }
  agent.send = function (message) {
    this.sent.push(message)
    sendCount += 1
    if (sendCount === 1) return // 僵尸轮：一个事件都不产生
    agentEvents.push(
      { type: 'user/message', seq: 3000 + sendCount * 10, data: { content: [{ type: 'text', text: String(message.content[0].text) }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 3001 + sendCount * 10, data: { message: { content: [{ type: 'text', text: '自愈后的正常回复-OK' }] } } },
      { type: 'turn/end', seq: 3002 + sendCount * 10, data: { turn: sendCount, reason: { kind: 'completed' } } },
    )
  }
  feedInbound('om_silent_no_marker', '无产出无标记测试')
  await settle(4)

  const ops = cardsSince(mark)
  const body = JSON.stringify(ops)
  ok(body.includes('原因未上报'), '没有失败标记时，卡片明说「原因未上报」（不再只写占位符）')
  ok(statusShows(body, '失败'), '无产出的回合状态栏写「失败」，不假称完成')
  ok(body.includes('已自动重建会话'), '僵尸会话自愈仍然保留（只在**没有**失败标记时才自愈）')
  ok(body.includes('自愈后的正常回复-OK'), '自愈重试的回复正常交付给用户')
}

console.log('21) 其它上游错误也翻成人话（429 限流）')
{
  const mark = sentCards.length
  agent.whenIdle = async () => { await new Promise((r) => setTimeout(r, 80)) }
  agent.send = function (message) {
    this.sent.push(message)
    const failure = { message: 'Too Many Requests', code: 'RATE_LIMIT', status: 429 }
    agentEvents.push(
      { type: 'user/message', seq: 4000, data: { content: [{ type: 'text', text: String(message.content[0].text) }], source: { kind: 'user' } } },
      { type: 'assistant/attempt', seq: 4001, data: { turn: 9, step: 1, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure } } }] } },
      { type: 'turn/end', seq: 4002, data: { turn: 9, reason: { kind: 'error', error: failure } } },
    )
  }
  feedInbound('om_rate_limit', '限流测试')
  await settle(4)

  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('被上游限流'), '429 → 卡面写「被上游限流（请求过快）」')
  ok(body.includes('Too Many Requests'), '仍保留上游原文')
}

console.log('22) 子代理／后台回执轮也要上卡（2026-09-21 CM：子代理回来了，我在飞书看不到你在继续干活）')
{
  // 背景：子代理／后台 job 完成时，DSH 会往同会话注入一条 `source.kind==='plugin'` 的
  // user/message 把模型唤醒继续干活 —— 这一轮**没有飞书入站消息**，所以旧实现没有卡承接：
  // CM 看不见「我在继续干活」，也收不到这一轮的结论（只能再发一条消息把我戳醒）。
  const mark = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 5000,
    data: {
      content: [{ type: 'text', text: 'Background subagent f835b8c2 finished and will do no further work unless you send it more.\n\nIts closing message:\n对照台账已落盘。' }],
      source: { kind: 'plugin' },
    },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()
  ok(createsSince(mark).length === 1, '回执轮建了卡（实际 ' + createsSince(mark).length + ' 张）')

  agentEvents.push({ type: 'assistant/message', seq: 5001, data: { message: { content: [{ type: 'text', text: '子代理回来了，我接着说：台账已落盘-OK' }] } } })
  agentEvents.push({ type: 'turn/end', seq: 5002, data: { turn: 20, reason: { kind: 'completed' } } })
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()

  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('🔔'), '卡面标了「回执到了」')
  ok(body.includes('正在继续工作'), '卡面说明模型被唤醒继续干活')
  ok(body.includes('台账已落盘-OK'), '这一轮的结论进了卡（CM 不用再发消息戳一次）')
  ok(body.includes('本轮结束'), '正常封口')

  // 控制组：会话启动类 plugin 消息（runtime context／技能目录）**不许**建卡，否则刷屏
  const mark2 = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 5003,
    data: {
      content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }],
      source: { kind: 'plugin' },
    },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()
  ok(createsSince(mark2).length === 0, 'system-reminder 类 plugin 消息不建卡（不刷屏）')
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()

  // 📌 审计纠正（2026-10-01）：此前把「NOTICE_RE 旧正文正则兜底」记为"0 覆盖"——**那是按标识符 grep
  //    得出的假结论**。事实上本用例（seq 5000，`source.kind='plugin'`）与用例 23 的控制组
  //    （`Background job pwsh-91 finished.`）**都只能靠正文正则**才能被判成回执轮：
  //    `autoTurnInfo()` 只特判 `kind === 'goal'`，其余一律走 NOTICE_RE ⇒ 正则一旦失效，这两条必红。
  //    故不另加断言（重复覆盖没有价值），在此注明真实的覆盖来源。
}

console.log('23) 普通飞书回合**不许**被当成回执轮抢建第二张卡（2026-09-23 CM：每次回复都发两张卡）')
{
  // 真机取证链（四环，全部有据）：
  //   ① dsh-agent-loop `wakeDriver()` 在 `send()` 的**同一个调用栈**里 setPhase({kind:'running'})
  //      → `dispatch.emit('agent/status')`（lib/index.js L781/L787/L844，同步 emit）。
  //   ② 旧实现把 `activeTurns.set` 放在 send() **之后** ⇒ 这一刻处理器读到"没有普通回合持有卡"。
  //   ③ 新用户消息这时还在 inbox 里、**没进会话事件表** ⇒ `autoTurnInfo()` 从末尾读到的
  //      `user/message` 是**上一条后台回执正文** ⇒ 判成 kind='notice'。
  //   ④ `openGoalCard()` 另开一张卡；它的游标与普通回合卡的游标同源 ⇒ 两张卡镜像同一批事件
  //      （CM：「每次回复我都发两张卡片」，内容重复）。
  // 本用例把 mock 的 send() 改成与真机同序：**先**同步 running，**再**写本轮助手事件。
  const mark = sentCards.length

  // 本轮之前那一轮正好是"后台回执轮" —— 真机上就是这样，这是本缺陷的触发前提。
  agentEvents.push({
    type: 'user/message', seq: 6000,
    data: {
      content: [{ type: 'text', text: 'Background subagent 8eebc571 finished and will do no further work unless you send it more.' }],
      source: { kind: 'plugin' },
    },
  })

  agent.send = function (message) {
    this.sent.push(message)
    emitCtx('agent/status', { agent, status: 'running' })   // ← 与真机同序：同步、且先于事件落表
    agentEvents.push(
      { type: 'assistant/message', seq: 6001, data: { message: { content: [{ type: 'text', text: '两张卡回归测试-正文' }] } } },
      { type: 'turn/end', seq: 6002, data: { turn: 30, reason: { kind: 'completed' } } },
    )
  }
  agent.whenIdle = async () => { await new Promise((r) => setTimeout(r, 80)) }

  feedInbound('om_two_cards_regression', '两张卡回归测试')
  await settle(4)

  ok(createsSince(mark).length === 1,
    '普通回合只建一张卡（实际 ' + createsSince(mark).length + ' 张）')
  const body = JSON.stringify(cardsSince(mark))
  ok(!body.includes('🔔'), '没有多出来的「回执到了」卡')
  ok(body.includes('两张卡回归测试-正文'), '正文正常进了唯一那张卡')
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()

  // 控制组：真正的回执轮（没有飞书入站、直接由 agent/status 进 running）**仍然**建卡 —— 不许误伤。
  const mark2 = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 6100,
    data: {
      content: [{ type: 'text', text: 'Background job pwsh-91 finished.' }],
      source: { kind: 'plugin' },
    },
  })
  emitCtx('agent/status', { agent, status: 'running' })
  await drain()
  ok(createsSince(mark2).length === 1, '真正的回执轮照样建卡（没有误伤）')
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()
}

console.log('24) 子代理回执「落盘即播报」：不看回合状态（2026-10-01 改造①）')
{
  // 真机根因：回执要等 turn/start **之后**才写进会话，而旧实现在"回合启动那一拍"回扫
  // → 判成普通回合 → 不开卡（CM 实证"没弹"）。本用例**完全不发 agent/status**，
  // 只把回执事件写进会话 —— 新实现必须照样播报。
  const mark = sentCards.length
  const sentBefore = agent.sent.length
  agentEvents.push({
    type: 'user/message', seq: 7000,
    data: {
      content: [
        { type: 'text', text: 'Background subagent child-abc12345-0000-0000-0000-000000000000 finished and will do no further work unless you send it more.' },
        { type: 'text', text: 'Its closing message:' },
        { type: 'text', text: '交付完成：报告已生成。' },
      ],
      source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-abc12345-0000-0000-0000-000000000000' },
    },
  })
  await drain()
  const created = cardsSince(mark).filter((c) => c.op === 'create')
  const rawText = JSON.stringify(created.map((c) => c.payload))
  ok(created.length >= 2, '纯文本 + 详情卡 双层播报都发了（实际 ' + created.length + ' 条）')
  ok(rawText.includes('已完成'), '播报里写了「子代理已完成」')
  ok(rawText.includes('child-ab'), '播报带正确的子代理 id 前 8 位（不是张冠李戴）')
  ok(rawText.includes('不用回这条'), '通知卡定位清楚：不用回这张卡')
  ok(agent.sent.length === sentBefore, '播报不新开回合（没有往 agent 里塞消息）')
  // 2026-10-01 补（此前无守护）：v0.4.2 补上的"纯文本成功也留痕"必须真的打出来 ——
  // 否则"纯文本到底有没有送达"永远证不了（真机并发测试时唯一的观测缺口）。
  ok(consoleLines.some((l) => l.includes('notice plain text sent')),
    'sendPlainText 成功后留痕（notice plain text sent）')
  // 去重：同一批事件再扫一遍，不许重复播报
  const again = sentCards.length
  await drain()
  ok(sentCards.length === again, '同一回执不重复播报')
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()
}

console.log('25) 卡片底部「目标条」：目标全文 + 状态 + 上下文占比 + 缓存命中（改造③）')
{
  const mark = sentCards.length
  agentEvents.push(
    { type: 'request/context', seq: 7100, data: { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 1000000 } },
    {
      type: 'assistant/message', seq: 7101,
      data: {
        usage: { inputTokens: 162, outputTokens: 100, cacheReadTokens: 177152, cacheWriteTokens: 0, totalTokens: 177414 },
      },
    },
  )
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 7110, data: { message: { content: [{ type: 'text', text: '目标条回合正文' }] } } })
  }
  agent.whenIdle = async () => {}
  feedInbound('om_goal_footer', '目标条测试')
  await settle(3)
  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('目标模式'), '底部出现目标条')
  ok(body.includes('把飞书卡片这四项改造做完'), '折叠面板里带目标全文')
  ok(body.includes('已激活'), '状态文案＝已激活（armed）')
  ok(body.includes('第 3/20 轮'), '轮数 N/M 正确')
  ok(body.includes('缓存命中'), '带缓存命中率')
  ok(/（\d+\.\d%）/.test(body), '上下文带占比')
  ok(body.includes('collapsible_panel'), '目标条是可折叠面板')
  ok(body.includes('"tag":"hr"'), '目标条上面有灰色分隔线 hr（CM 2026-10-01：不然跟正文混到一起）')

  // 续行被解除武装（dsh 重启后的真实状态）必须一眼可见
  const mark2 = sentCards.length
  fakeGoalActivation = 'disarmed'
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 7120, data: { message: { content: [{ type: 'text', text: '续行已停的回合一' }] } } })
  }
  feedInbound('om_goal_disarmed', '续行已停目标条测试')
  await settle(3)
  const body2 = JSON.stringify(cardsSince(mark2))
  ok(body2.includes('续行已停'), 'disarmed → 卡面写「续行已停」（CM 要抓的"目标停了"）')
  ok(body2.includes('/goal resume'), '并且给出恢复方式')
  fakeGoalActivation = 'armed'

  // 未启用形态：CM 2026-10-01「未激活的时候也加一个灰色底」
  const mark3 = sentCards.length
  fakeGoalEnabled = false
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 7130, data: { message: { content: [{ type: 'text', text: '无目标回合一' }] } } })
  }
  feedInbound('om_goal_disabled', '未启用目标条测试')
  await settle(3)
  const body3 = JSON.stringify(cardsSince(mark3))
  // 0.7.9（CM 2026-10-03 ①）：删掉「🎯 目标模式 · 未启用」那句 —— 模式位已由 statusTextFor 独占，
  // 再写一句"未启用"就是"普通模式与目标模式共存"的第二种形态。
  ok(!body3.includes('未启用'), '★ 无目标时目标条**不再**写「未启用」（一行只有一个模式位）')
  ok(body3.includes('grey-50'), '未启用形态也有灰色底（grey-50）')
  ok(body3.includes('"tag":"hr"'), '未启用形态同样带灰色分隔线')
  fakeGoalEnabled = true
}

console.log('26) 选项卡：长选项换行分栏 + 6 个选项不丢（改造④，CM 定 A4）')
{
  const mark = sentCards.length
  const questions = [{
    id: 'q-smoke-1',
    question: '阶段 1-4 复盘口径，你要哪一种？',
    options: [
      { label: '按决策错误口径：只判用了不合规依据、用了无出处的方法、有据可查却没查这三种情形；流程没走全的一律归到阶段 2。' },
      { label: '按流程完整性口径：把没走的步骤也算失误，逐项打勾核对。' },
      { label: '两者都要：先按决策口径判对错，再附一份流程完整性清单。' },
      { label: '选项四：只看结论对不对。' },
      { label: '选项五：只看流程走没走全。' },
      { label: '选项六：以上都不选，我直接回复文字。' },
    ],
  }]
  emitCtx('tools/execute', { name: 'ask_user_question', agent, arguments: { questions }, signal: undefined }, () => {})
  await drain()
  const qCard = cardsSince(mark).filter((c) => c.op === 'create')
    .find((c) => JSON.stringify(c.payload).includes('需要你的回答'))
  ok(Boolean(qCard), '问句卡已发出')
  const body = JSON.stringify(qCard ? qCard.payload : {})
  ok(body.includes('"schema":"2.0"'), '问句卡改用 JSON 2.0 结构')
  ok(body.includes('column_set'), '选项改成"一行一个分栏"')
  ok(body.includes('stretch'), '窄屏自动堆叠（A4）')
  ok(body.includes('选它'), '按钮文案＝选它')
  ok(body.includes('有据可查却没查这三种情形'), '长选项正文**完整**出现在卡上（不再截断）')
  ok(body.includes('选项六'), '第 6 个选项没有被静默丢弃（旧实现 slice(0,5)）')
  // 清掉挂起的提问：否则 30 分钟超时定时器会拖住进程不退出
  feedInbound('om_answer_pending_question', '选 1')
  await drain()
}

console.log('27) 引用回复透传：parent_id → 会话里带被引摘要（改造⑤）')
{
  feedInbound('om_quote_source', '这是被引用的那条原消息')
  await drain()
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: 'om_quote_reply',
        message_type: 'text',
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        content: JSON.stringify({ text: '我引用的就是上面那条' }),
        parent_id: 'om_quote_source',
      },
      sender: { sender_id: { open_id: 'ou_test' } },
    },
  }) + '\n'
  await drain()
  const last = agent.sent[agent.sent.length - 1]
  const text = (last && last.content && last.content[0] && last.content[0].text) || ''
  ok(text.includes('你在引用这条消息'), '引用信息被带进了会话正文')
  ok(text.includes('这是被引用的那条原消息'), '引用里带的是被引消息的摘要')
  ok(text.includes('我引用的就是上面那条'), '用户正文本身照旧送达')
}

console.log('28) 中文目的行：长过程话语被 500 字截断时，🎯 行必须留下（改造②）')
{
  const mark = sentCards.length
  const note = '背景说明。'.repeat(120) + '\n🎯 去查基准库，确认这场比赛的赔率口径。\n结尾一句。'
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 7200, data: { message: { content: [{ type: 'text', text: note }] } } })
  }
  feedInbound('om_purpose_line', '目的行测试')
  await settle(2)
  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('🎯 去查基准库'), '目的行没有被 500 字截断切掉（改造②的保护生效）')
}

console.log('29) 点击选项后后续内容必须写到【新卡】(CM 回归红线：自动轮也要换卡)')
{
  // 造一个自动轮：回执落盘 → 播报建卡（这张卡会进 autoCards，成为"活跃卡"）
  const mark = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 7300,
    data: {
      content: [
        { type: 'text', text: 'Background subagent child-split0001-0000 finished and will do no further work unless you send it more.' },
        { type: 'text', text: 'Its closing message:' },
        { type: 'text', text: '这一步做完了。' },
      ],
      source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-split0001-0000' },
    },
  })
  await drain()
  ok(cardsSince(mark).filter((c) => c.op === 'create').length >= 2, '自动轮已建卡（split 的前提）')

  // 在自动轮里提问（真机上就是"我在回执轮里问了 CM 一个问题"）
  const qmark = sentCards.length
  const questions = [{ id: 'q-split', question: '选一个', options: [{ label: '选项甲' }, { label: '选项乙' }] }]
  emitCtx('tools/execute', { name: 'ask_user_question', agent, arguments: { questions }, signal: undefined }, () => {})
  await drain()
  const qCard = cardsSince(qmark).filter((c) => c.op === 'create')
    .find((c) => JSON.stringify(c.payload).includes('需要你的回答'))
  ok(Boolean(qCard), '问题卡已发出')
  const token = qCard
    && qCard.payload.body.elements.find((e) => e.tag === 'column_set')
    && qCard.payload.body.elements.find((e) => e.tag === 'column_set').columns[1].elements[0].behaviors[0].value.fs_question
  ok(Boolean(token), '从问题卡里取到了回传 token')

  // 点按钮：**必须走 helper 事件通道**（card.action.trigger 由 handleHelperMessage 分发，
  // 不是 ctx 事件 —— 用 emitCtx 发它不会有任何反应）。
  const tapMark = sentCards.length
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'card.action.trigger',
    data: {
      action: { tag: 'button', value: { fs_question: token, fs_option: 0 } },
      context: { open_chat_id: CHAT_ID },
    },
  }) + '\n'
  await drain()
  ok(createsSince(tapMark).length >= 1,
    '点击后开了【新卡】（旧卡被冻结，后续内容不再往用户已经划过的那张卡上堆）')
  const updates = sentCards.slice(tapMark).filter((c) => c.op === 'update')
  ok(updates.some((c) => JSON.stringify(c.payload).includes('已收到你的选择')),
    '旧卡被封口并写了「✅ 已收到你的选择，继续处理中…」')
  ok(updates.some((c) => JSON.stringify(c.payload).includes('继续处理中')),
    '新卡写了「继续处理中…」')
}

console.log('30) 有活跃卡时回执【并入卡片】、不发独立消息（CM 2026-10-01：别让它沉在活跃卡下面）')
{
  let release = null
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 7400, data: { message: { content: [{ type: 'text', text: '活跃回合正文' }] } } })
  }
  agent.whenIdle = () => new Promise((resolve) => { release = resolve })
  feedInbound('om_merge_notice', '并卡测试')
  await drain()
  ok(Boolean(release), '回合确实卡在 whenIdle（活跃卡场景成立）')

  const before = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 7410,
    data: {
      content: [
        { type: 'text', text: 'Background subagent child-merge001-0000 finished and will do no further work unless you send it more.' },
        { type: 'text', text: 'Its closing message:' },
        { type: 'text', text: '这一步做完了。' },
      ],
      source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-merge001-0000' },
    },
  })
  await drain()
  const during = sentCards.slice(before)
  ok(during.length > 0, '回执到达时有动作（至少 PATCH 了活跃卡）')
  ok(during.every((c) => c.op === 'update'),
    '有活跃卡时**不发独立消息**（全部是 PATCH，共 ' + during.length + ' 条）')
  ok(JSON.stringify(during).includes('子代理'), '回执内容并进了那张活跃卡')

  if (release) release()
  await settle(2)
  agent.whenIdle = async () => {}
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()
}

console.log('31) 结论独立成卡（CM 2026-10-01 B 方案，17:3x 修正：**只按耗时**判定）')
{
  // (a) 耗时达标（本用例把阈值压到 0ms —— 冒烟里回合是瞬时完成的，elapsed 可能是 0）
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'
  const mark = sentCards.length
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push(
      { type: 'tool/call', seq: 7500, data: { callId: 'call_split_1', name: 'read', arguments: '{"file_path":"a.md"}' } },
      { type: 'assistant/message', seq: 7501, data: { message: { content: [{ type: 'text', text: '结论：一切正常。' }] } } },
    )
  }
  feedInbound('om_split_with_tools', '分卡测试（达标）')
  await settle(3)
  const events = sentCards.slice(mark)
  const creates = events.filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0')
  ok(creates.length === 2, '耗时达标 → 过程卡 + 结论卡（实际 ' + creates.length + ' 张）')
  const conclusionIdx = events.findIndex((c, i) => i > 0 && c.op === 'create' && JSON.stringify(c.payload).includes('一切正常'))
  ok(conclusionIdx > 0, '结论出现在**新开的**那张卡里')
  const beforeConclusion = JSON.stringify(events.slice(0, conclusionIdx))
  // 🔴 0.7.14 反转（CM 指定 TASK v3）：旧断言把 bug 写成了期望（规矩 3 活案例）——
  //    【旧断言】2026-10-03 P0：过程卡保留正文（与结论卡重复是有意代价）。
    //【反转条件】replySeqs 收紧到只含最后一段答复后，搬走结论段已不会误删过程叙述 ⇒ 两卡不许再重复。
  ok(!beforeConclusion.includes('一切正常'), '★ 0.7.14 B3：过程卡**不含**结论段（结论只出现在结论卡）')
  ok(beforeConclusion.includes('结论见下方卡片'), '过程卡末尾追加一句指路')
  ok(JSON.stringify(creates[creates.length - 1].payload).includes('已完成'), '结论卡的状态栏写「已完成」')
  // CM 2026-10-01 A 方案：**过程卡不摆状态栏**（无目标/无上下文/无缓存），只留一行裸状态
  // 判据换成「缓存命中」（= 完整状态栏的指标段）。
  // ⚠️ 2026-10-03 H 之后**不能再拿「目标模式」当判据**：状态栏首段现在是三模式标签
  //   （🧭普通/📋计划/🎯目标），裸状态行里也会出现它 ⇒ 会假红。
  ok(!beforeConclusion.includes('缓存命中'),
    '过程卡**不显示状态栏**（没有目标/上下文/缓存那一条）')
  ok(beforeConclusion.includes('运行中') || beforeConclusion.includes('已完成'), '过程卡保留一行裸状态')
  ok(JSON.stringify(creates[creates.length - 1].payload).includes('缓存命中'),
    '结论卡带完整状态栏（灰底那一行在结论卡上）')

  // (b) 未达阈值（恢复默认 30s；本轮的 80ms 远不够）→ 维持单卡
  //     ★ 这就是 CM 17:3x 的反馈：「短任务都变了两张卡了」—— 短任务**即使调了工具**也必须单卡
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  const mark2 = sentCards.length
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push(
      { type: 'tool/call', seq: 7510, data: { callId: 'call_split_2', name: 'read', arguments: '{"file_path":"b.md"}' } },
      { type: 'assistant/message', seq: 7511, data: { message: { content: [{ type: 'text', text: '简短结论' }] } } },
    )
  }
  feedInbound('om_split_short', '分卡测试（未达标）')
  await settle(3)
  ok(createsSince(mark2).length === 1,
    '**短任务（即使调了工具）也维持单卡**（实际 ' + createsSince(mark2).length + ' 张）')
}

console.log('31b) 🔴 P0 复现 CM 2026-10-03 报障：过程卡正文**不许**被搬到结论卡')
{
  // 复现要点（我第一版探针没抓到的原因）：回复集合 replySeqs 是"从末尾往前扫、**跨过工具调用
  // 继续收**"得来的 ⇒ 叙述与工具交替时它会覆盖**整轮** ⇒ 旧实现把过程卡里这些 note 全删掉，
  // 文字就"全跑到结论卡"、过程卡只剩一句指路。所以夹具必须是**叙述↔工具交替**。
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'
  const markP0 = sentCards.length
  const logMarkP0 = consoleLines.length   // 审查 LOW#2020：consoleLines 是全程缓冲，必须取本轮窗口
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 9500, data: { message: { content: [{ type: 'text', text: '第一段过程叙述' }] } } })
    agentEvents.push({ type: 'tool/call', seq: 9501, data: { callId: 'p0_1', name: 'read', arguments: '{"file_path":"a.md"}' } })
    agentEvents.push({ type: 'tool/result', seq: 9502, data: { message: { source: { callId: 'p0_1' }, content: [{ type: 'text', text: 'ok' }] } } })
    agentEvents.push({ type: 'assistant/message', seq: 9503, data: { message: { content: [{ type: 'text', text: '第二段过程叙述' }] } } })
    agentEvents.push({ type: 'tool/call', seq: 9504, data: { callId: 'p0_2', name: 'read', arguments: '{"file_path":"b.md"}' } })
    agentEvents.push({ type: 'tool/result', seq: 9505, data: { message: { source: { callId: 'p0_2' }, content: [{ type: 'text', text: 'ok' }] } } })
    agentEvents.push({ type: 'assistant/message', seq: 9506, data: { message: { content: [{ type: 'text', text: '第三段过程叙述' }] } } })
    // 审查 MED#2016（我这条用例原本是**假绿**）：replySeqs 遇到"相邻叙述"会停 ⇒ 若结论**紧接**叙述，
    // 它只覆盖结论那一句，旧实现也能通过。让结论**紧跟一次工具结果**，replySeqs 才会覆盖三段叙述。
    agentEvents.push({ type: 'tool/call', seq: 9507, data: { callId: 'p0_3', name: 'read', arguments: '{"file_path":"c.md"}' } })
    agentEvents.push({ type: 'tool/result', seq: 9508, data: { message: { source: { callId: 'p0_3' }, content: [{ type: 'text', text: 'ok' }] } } })
    agentEvents.push({ type: 'assistant/message', seq: 9509, data: { message: { content: [{ type: 'text', text: '结论：三件事都做完了。' }] } } })
  }
  feedInbound('om_p0_keepblocks', 'P0 正文保全')
  await settle(4)
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  const p0Creates = sentCards.slice(markP0)
    .filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0')
  ok(p0Creates.length === 2, '前提：走了「结论独立成卡」那条路（实际 ' + p0Creates.length + ' 张）')
  const procPayload = p0Creates.length > 0 ? p0Creates[0].payload : {}
  const concPayload = p0Creates.length > 1 ? p0Creates[p0Creates.length - 1].payload : {}
  const procJson = JSON.stringify(procPayload)
  const concJson = JSON.stringify(concPayload)
  ok(procJson.includes('第一段过程叙述') && procJson.includes('第二段过程叙述') && procJson.includes('第三段过程叙述'),
    '★ B1：过程叙述三段**一段不少**（0.7.14 "搬走结论段"不许碰到它们）')
  // 🔴 0.7.14 反转（CM 指定 TASK v3）：结论段不许再留在过程卡上（与结论卡重复 = 本次事故）。
  ok(!procJson.includes('结论：三件事都做完了'),
    '★ 0.7.14 B3：结论段不在过程卡上（0.7.13 及以前会留一份 ⇒ 两卡重复）')
  ok(procJson.includes('结论见下方卡片'), '过程卡末尾追加了一行指路（只追加，不删块）')
  ok(concJson.includes('结论：三件事都做完了'), '结论卡里有结论（自包含口径不变）')
  ok(consoleLines.slice(logMarkP0).some((l) => l.includes('card fingerprint:') && l.includes('collapsed=')),
    '★ 观测指纹已留痕（封口帧 elements/panels/collapsed/payload_md5）')
}

console.log('31c) 折叠阈值修正：正常长回合（90 元素）不再把过程文字藏进收起面板')
{
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'
  const markFold = sentCards.length
  agent.send = function (message) {
    this.sent.push(message)
    for (let i = 0; i < 45; i++) {
      agentEvents.push({ type: 'tool/call', seq: 9600 + i * 2, data: { callId: 'fv_' + i, name: 'read', arguments: '{"file_path":"g' + i + '.md"}' } })
      agentEvents.push({ type: 'assistant/message', seq: 9601 + i * 2, data: { message: { content: [{ type: 'text', text: '叙述第 ' + i + ' 段 ' + 'y'.repeat(20) }] } } })
    }
    agentEvents.push({ type: 'assistant/message', seq: 9800, data: { message: { content: [{ type: 'text', text: '结论：完毕。' }] } } })
  }
  feedInbound('om_fold_threshold', '阈值修正')
  await settle(4)
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  const foldCreates = sentCards.slice(markFold)
    .filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0')
  const procEls = (foldCreates[0] && foldCreates[0].payload.body.elements) || []
  const visibleText = procEls.map((e) => {
    if (e.tag === 'markdown') return String(e.content || '')
    if (e.tag === 'collapsible_panel' && e.expanded === true) return String((e.elements && e.elements[0] && e.elements[0].content) || '')
    return ''
  }).join('\n')
  ok(visibleText.includes('叙述第 0 段'), '★ 第一段默认可见（阈值 180 之下不再折叠）')
  ok(visibleText.includes('叙述第 44 段'), '★ 最后一段默认可见')
  const hiddenNarration = procEls.filter((e) => e.tag === 'collapsible_panel' && e.expanded !== true
    && String((e.elements && e.elements[0] && e.elements[0].content) || '').includes('叙述第 0 段'))
  ok(hiddenNarration.length === 0, '★ 没有把叙述藏进收起面板（审查 LOW#2049：去掉恒真断言，改验真事实）')
}

console.log('32) /compact：压缩上下文必须透传到命令注册表（CM 2026-10-01 要求）')
{
  // 旧实现：compact 不在 COMMANDS 白名单 ⇒ `/compact` 被当成**普通消息**丢给模型，压缩根本不会发生。
  const prev = fakeCommands.execute
  const calls = []
  // ★ 记录**全部**参数：execute 的签名是 (agent, line, submittedAttachments, signal)——
  //   2026-10-01 真机事故：signal 传在第 3 位 ⇒ 注册表里 `signal.aborted` 抛
  //   `Cannot read properties of undefined (reading 'aborted')`（用户看到「压缩失败：…」）。
  fakeCommands.execute = async (...args) => {
    calls.push({ agentId: args[0] && args[0].id, line: args[1], attachments: args[2], signal: args[3] })
    return { result: { text: 'compacted 12 messages' } }
  }
  const mark = sentCards.length
  feedInbound('om_compact', '/compact')
  await drain()
  const body = JSON.stringify(cardsSince(mark))
  const call = calls.find((c) => c.line === '/compact')
  ok(Boolean(call), '/compact 被路由到 commands.execute')
  ok(call && call.signal && typeof call.signal.aborted === 'boolean',
    'signal 必须传在**第 4 位**（第 3 位是 attachments）—— 传错位会让注册表抛 TypeError')
  ok(call && call.attachments !== undefined && Array.isArray(call.attachments) && call.attachments.length === 0,
    '第 3 位必须是**数组**（空附件）—— 传 undefined 会让注册表读 .length 再抛一次')
  ok(body.includes('压缩上下文'), '把压缩结果回给用户')
  ok(body.includes('compacted 12 messages'), '上游结果原文可见')

  // /goal 与 /plan 走同一条通道 —— 同一个错位问题也要守住
  feedInbound('om_goal_signal', '/goal 信号位测试')
  await drain()
  const goalCall = calls.find((c) => c.line && c.line.startsWith('/goal'))
  ok(goalCall && goalCall.signal && typeof goalCall.signal.aborted === 'boolean',
    '/goal 同样把 signal 传在第 4 位（旧代码在这里静默抛错、退化成兜底分支）')

  // 注册表没有 /compact 时，必须明说"不可用"，而不是静默什么都不做
  fakeCommands.execute = async () => undefined
  const mark2 = sentCards.length
  feedInbound('om_compact_missing', '/compact')
  await drain()
  ok(JSON.stringify(cardsSince(mark2)).includes('压缩不可用'), '插件未装载时要明确告知（不静默）')

  // ★ CM 2026-10-01：「报错能不能直接知道、提醒到 agent？」——
  //   命令抛异常时，除了回给用户，还必须**回注会话并唤醒 agent**（否则它永远不知道出过错）
  const sentBefore = agent.sent.length
  const mark3 = sentCards.length
  fakeCommands.execute = async () => { throw new Error('boom-from-registry') }
  feedInbound('om_compact_throw', '/compact')
  await drain()
  ok(JSON.stringify(cardsSince(mark3)).includes('压缩失败'), '失败照旧回给用户')
  const injected = agent.sent.slice(sentBefore).map((m) => JSON.stringify(m)).join(' ')
  ok(injected.includes('[系统回执]') && injected.includes('boom-from-registry'),
    '失败必须**回注给 agent**（含原因），让它能主动排查')

  // 2026-10-01 审计发现：`/plan`、`/goal` 的 catch 也接了 reportCommandFailure，
  // 但**从没有人断言过**（上面只注入了 /compact 的异常）。三条通道一起钉住。
  fakeCommands.execute = async () => { throw new Error('boom-plan') }
  const sentBeforePlan = agent.sent.length
  feedInbound('om_plan_throw', '/plan')
  await drain()
  ok(agent.sent.slice(sentBeforePlan).map((m) => JSON.stringify(m)).join(' ').includes('boom-plan'),
    '/plan 失败同样回注 agent（含原因）')

  fakeCommands.execute = async () => { throw new Error('boom-goal') }
  const sentBeforeGoalFail = agent.sent.length
  feedInbound('om_goal_throw', '/goal pause')
  await drain()
  ok(agent.sent.slice(sentBeforeGoalFail).map((m) => JSON.stringify(m)).join(' ').includes('boom-goal'),
    '/goal 失败同样回注 agent（含原因）')
  fakeCommands.execute = prev
}

console.log('33) 目标状态三分支（paused/blocked/complete）＋ 状态变化刷新活跃卡（2026-10-01 审计补测）')
{
  // (a) `goalStateText()` 的三个分支此前**一次都没被执行过**（smoke 只覆盖 armed/disarmed/未启用）。
  let seqN = 8000
  const phaseCase = async (label, expect) => {
    const mark = sentCards.length
    seqN += 10
    agent.send = function (message) {
      this.sent.push(message)
      agentEvents.push({ type: 'assistant/message', seq: seqN, data: { message: { content: [{ type: 'text', text: label }] } } })
    }
    feedInbound('om_goal_phase_' + seqN, label)
    await settle(3)
    ok(JSON.stringify(cardsSince(mark)).includes(expect), label + '：卡面出现「' + expect + '」')
  }
  fakeGoalPhase = 'paused'
  await phaseCase('暂停态目标条', '已暂停（发 /goal resume 恢复）')
  fakeGoalPhase = 'blocked'
  fakeGoalBlockedReason = '已达轮次上限'
  await phaseCase('阻塞态目标条（状态栏只写已阻塞）', '🚫 已阻塞 · ')
  // CM 2026-10-01：**状态栏只写「已阻塞」**，长原因挪到展开面板 ⇒ 上面断"短状态栏"，
  // 下面断"原因仍完整在卡里（面板内容里）"。
  await phaseCase('阻塞态目标条（原因在面板里）', '已达轮次上限')
  // ⚠️ 2026-10-01 真机抓出：驱动服务给的 blockedReason 是**对象** `{code, message}`，
  //    而这里原来只测字符串形状 ⇒ `String(obj)` 渲染成 `[object Object]` 漏网（CM 在卡上看到了）。
  //    补对象形状 + "绝不出现 [object Object]" 两条断言。
  fakeGoalBlockedReason = { code: 'model-reported', message: '对象形状的阻塞原因' }
  await phaseCase('阻塞态目标条（对象原因在面板里）', '对象形状的阻塞原因')
  {
    const mark = sentCards.length
    seqN += 10
    agent.send = function (message) {
      this.sent.push(message)
      agentEvents.push({ type: 'assistant/message', seq: seqN, data: { message: { content: [{ type: 'text', text: '对象原因渲染测试' }] } } })
    }
    feedInbound('om_goal_phase_obj', '对象原因渲染测试')
    await settle(3)
    const body = JSON.stringify(cardsSince(mark))
    ok(!body.includes('[object Object]'), '目标阻塞原因绝不许渲染成 [object Object]')
  }
  fakeGoalPhase = 'complete'
  fakeGoalBlockedReason = ''
  await phaseCase('完成态目标条', '已完成 · 共 3 轮')
  fakeGoalPhase = 'active'

  // (b) `goal/changed` / `goal/activation-changed` → **已经在飞书上的活跃卡**必须跟着刷新。
  //     审计结论：`index.js` L3595-3618 那段（refreshLiveCards）在 smoke 里 0 触发、真机 0 次 ⇒ 纯代码承诺。
  //     注意：普通回合的过程卡是 bare（不摆状态栏）⇒ 必须用**自动卡**（回执轮）来验，
  //     它从出生就是 full（`makeCardState` 默认 footerMode='full'）。
  const markAuto = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 8100,
    data: {
      content: [
        { type: 'text', text: 'Background subagent child-refresh01-0000 finished and will do no further work unless you send it more.' },
        { type: 'text', text: 'Its closing message:' },
        { type: 'text', text: '刷新用例的回执。' },
      ],
      source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-refresh01-0000' },
    },
  })
  await drain()
  // 前提（可失败）：回执必须触发卡片动作 —— 新开自动卡 或 并入活跃卡，两种都算。
  ok(sentCards.length > markAuto, '前提：回执触发了卡片动作（新开自动卡/并入活跃卡）')

  const markRefresh = sentCards.length
  fakeGoalPhase = 'paused'
  emitCtx('goal/changed', {})
  await drain()
  // 判据：必须出现一次 **PATCH**，且该 PATCH 的载荷里同时有「目标模式」（＝状态栏，说明刷的是
  // full 卡）和「已暂停」（＝读到的是**刚刚改过的**状态）。只看 create 不算 —— 那是新建卡，不是刷新。
  const refreshPatched = sentCards.slice(markRefresh)
    .filter((c) => c.op === 'update').map((c) => JSON.stringify(c.payload)).join(' ')
  ok(refreshPatched.includes('目标模式') && refreshPatched.includes('已暂停'),
    'goal/changed → 已发出的卡被当场 PATCH 成新状态（refreshLiveCards 真的在跑）')

  const markActivation = sentCards.length
  fakeGoalPhase = 'active'
  fakeGoalActivation = 'disarmed'
  emitCtx('goal/activation-changed', { sessionId: agent.session.id || 'agent-smoke-1' })
  await drain()
  const activationPatched = sentCards.slice(markActivation)
    .filter((c) => c.op === 'update').map((c) => JSON.stringify(c.payload)).join(' ')
  ok(activationPatched.includes('续行已停'),
    'goal/activation-changed → 同样刷新（「续行已停」当场可见）')

  fakeGoalActivation = 'armed'
  emitCtx('agent/status', { agent, status: 'idle' })
  await settle()
}

console.log('34) 建结论卡失败 → 结论绝不能丢（审计发现：回退分支形同虚设）')
{
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'
  const mark = sentCards.length
  // 时间线：本轮第 1 次建卡＝过程卡（必须成功），第 2 次建卡＝结论卡（这次让它失败）。
  failCreatesFrom = 2
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push(
      { type: 'tool/call', seq: 8600, data: { callId: 'call_concl_1', name: 'read', arguments: '{"file_path":"c.md"}' } },
      { type: 'assistant/message', seq: 8601, data: { message: { content: [{ type: 'text', text: '结论：这一句绝不能丢。' }] } } },
    )
  }
  feedInbound('om_conclusion_fail', '结论卡失败测试')
  await settle(3)
  failCreatesFrom = 0
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  const since = sentCards.slice(mark)
  ok(JSON.stringify(since).includes('结论见下方卡片'), '前提：本轮确实走了"结论独立成卡"路径')
  // 判据落在 **PATCH** 上：建卡失败的载荷也会进 sentCards（没有 message_id），
  // 所以不能靠"载荷里有没有这句话"来判 —— 必须看**已经存在的那张过程卡**有没有被补上结论。
  const patched = JSON.stringify(since.filter((c) => c.op === 'update'))
  ok(patched.includes('这一句绝不能丢'),
    '建结论卡失败 ⇒ 必须把结论补回过程卡（PATCH），否则用户只看到「结论见下方卡片」却永远等不到那张卡')
}

console.log('35) 引用透传落盘：重启后仍能查出"你引的是哪张卡"（2026-10-01 真机实证补测）')
{
  // 真机事故：CM 长按引用一张卡片 → 卡面回「内容未登记，可能是更早的消息」。
  // 根因＝登记表只在内存，dsh 重启就清空（他引的那张卡恰恰建于本次重启之前）。
  const idxPath = join(process.env.FS_CONFIG_DIR, 'message-index.json')
  // 先跑一轮普通回合（封口后有明确结论），用来检查"登记的摘要到底是不是有信息量的那一句"。
  const labelMarker = '引用摘要测试用的结论'
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 8900, data: { message: { content: [{ type: 'text', text: labelMarker }] } } })
  }
  feedInbound('om_label_turn', '摘要登记测试')
  await settle(3)
  await drain()   // 等 rememberMessage 的落盘防抖（300ms）跑完

  let saved = null
  try { saved = JSON.parse(readFileSync(idxPath, 'utf8')) } catch { saved = null }
  const ids = saved ? Object.keys(saved) : []
  const labels = ids.map((id) => String((saved[id] && saved[id].label) || ''))
  // ⚠️ 2026-10-01 真机（CM 引用重启后的卡）：摘要居然是「bot 的回复卡片：正在工作中…」
  //    —— 建卡那一刻卡片里只有占位符，登记它**等于没登记**（引用时看不出引的是哪张、讲什么）。
  //    封口时卡片内容才成形 ⇒ 每次成功同步都必须刷新摘要。
  ok(!labels.some((l) => l.includes('正在工作中')),
    '登记摘要里不许留着建卡时的占位符「正在工作中…」（实际：' + JSON.stringify(labels.filter((l) => l.includes('正在工作中')).slice(0, 2)) + '）')
  ok(labels.some((l) => l.includes(labelMarker)),
    '卡片封口后的结论被登记成摘要（引用时能看出"引的是哪张、说了什么"）')
  ok(ids.length > 0, '发出去的消息/卡片被登记到落盘索引（' + ids.length + ' 条）')
  ok(ids.some((id) => String(id).startsWith('om_card_')), '卡片 message_id 在索引里（引用卡片的主场景）')
  const cardEntry = ids.map((id) => saved[id]).find((v) => v && String(v.label).includes('bot 的回复卡片'))
  ok(Boolean(cardEntry), '卡片登记的摘要是"bot 的回复卡片：…"（引用时能说出引的是哪张）')

  // 模拟"这张卡是上一次进程登记的"：直接写进磁盘索引（内存里没有它）。
  const oldId = 'om_from_previous_process'
  const merged = Object.assign({}, saved, { [oldId]: { label: 'bot 的回复卡片：上一进程发的那张卡', at: Date.now() - 60000 } })
  writeFileSync(idxPath, JSON.stringify(merged))
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: 'om_quote_old_card',
        message_type: 'text',
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        content: JSON.stringify({ text: '我引的是上一进程那张卡' }),
        parent_id: oldId,
      },
      sender: { sender_id: { open_id: 'ou_test' } },
    },
  }) + '\n'
  await drain()
  const last = agent.sent[agent.sent.length - 1]
  const text = (last && last.content && last.content[0] && last.content[0].text) || ''
  ok(text.includes('上一进程发的那张卡'),
    '未命中内存时**再读一次落盘索引** ⇒ 重启前发出的卡片也认得出来（不再一律「内容未登记」）')

  // 真·未登记的消息必须照实说，**不许编造**
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: 'om_quote_unknown',
        message_type: 'text',
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        content: JSON.stringify({ text: '我引的是一条谁也没登记过的消息' }),
        parent_id: 'om_never_seen_anywhere',
      },
      sender: { sender_id: { open_id: 'ou_test' } },
    },
  }) + '\n'
  await drain()
  const last2 = agent.sent[agent.sent.length - 1]
  const text2 = (last2 && last2.content && last2.content[0] && last2.content[0].text) || ''
  ok(text2.includes('内容未登记'), '真查不到时照实写「内容未登记」（A24：不许编造出处）')
}

console.log('36) /help 文案必须列出 /compact（2026-10-01 审计：此前无守护用例）')
{
  const mark = sentCards.length
  agent.send = function (message) { this.sent.push(message) }
  feedInbound('om_help_cmd', '/help')
  await drain()
  const body = JSON.stringify(sentCards.slice(mark))
  ok(body.includes('/compact'), '/help 里列出了 /compact')
  ok(body.includes('压缩上下文'), '/help 说明了 /compact 的作用与前置条件')
  ok(body.includes('/goal') && body.includes('/switch'), '/help 仍保留既有命令（没被改坏）')
}

console.log('37) 消息索引 300 条上限：不许无界增长，且淘汰最旧的（审计：此前无守护用例）')
{
  const idxPath = join(process.env.FS_CONFIG_DIR, 'message-index.json')
  const many = {}
  for (let i = 1; i <= 400; i++) {
    many['om_cap_' + String(i).padStart(3, '0')] = { label: 'cap-entry-' + i, at: Date.now() - (400 - i) * 1000 }
  }
  writeFileSync(idxPath, JSON.stringify(many))
  // 引用其中最后一条（内存里没有 ⇒ 走"未命中再读盘"），既验按需加载、又能触发一次裁剪
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: 'om_cap_quote',
        message_type: 'text',
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        content: JSON.stringify({ text: '上限测试：引用最后一条' }),
        parent_id: 'om_cap_400',
      },
      sender: { sender_id: { open_id: 'ou_test' } },
    },
  }) + '\n'
  await drain()
  const last = agent.sent[agent.sent.length - 1]
  const text = (last && last.content && last.content[0] && last.content[0].text) || ''
  ok(text.includes('cap-entry-400'), '按需读盘：引用能查到落盘索引里的条目')
  await drain()   // 等 rememberMessage 的 300ms 防抖落盘
  const after = JSON.parse(readFileSync(idxPath, 'utf8'))
  const keys = Object.keys(after)
  ok(keys.length <= 300, '落盘索引被裁到 300 条以内（实际 ' + keys.length + ' 条，防无界增长）')
  ok(keys.includes('om_cap_400'), '保留较新的条目（最旧的先淘汰）')
}

console.log('38) bot 配置热读通道：splitConclusionMinMs 优先级 + notifyAgentNotices 开关（审计：两条都没验过）')
{
  // 依据：`ensureHelpers()` 每 CONFIG_REFRESH_MS(10s) 重读配置并 `bot.cfg = cfg`（index.js L2288/L2320）
  // ⇒ 改配置免重启生效。此前 smoke 只测过 env 那条通道（DSH_FEISHU_SPLIT_MIN_MS），
  //    **bot 配置这条（也是文档里第一优先级）从未验证**；notifyAgentNotices 也是零覆盖。
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'      // env 说：立刻分卡
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{
      name: 'smoke',
      workspace: WORKSPACE,
      appId: APP_ID,
      appSecret: APP_SECRET,
      splitConclusionMinMs: 600000,   // bot 配置说：几乎不分卡 ⇒ 应当**压过** env
      notifyAgentNotices: false,      // 关掉回执播报
      reactionEmoji: 'GLANCE',        // 别把用例 40 要验的字段洗掉
      approvalForm: true, planEnabled: true, goalEnabled: true,   // 可选通道：别在这里顺手关掉（用例 51 还要用）
    }],
  }, null, 2))
  await new Promise((r) => setTimeout(r, 11000))   // 等过热读节拍
  await drain()                                     // 触发一次 ensureHelpers → 应用新配置

  // A) notifyAgentNotices=false ⇒ 回执**不许**有任何播报动作
  const markA = sentCards.length
  agentEvents.push({
    type: 'user/message', seq: 9200,
    data: {
      content: [
        { type: 'text', text: 'Background subagent cfgswitch-0001 finished and will do no further work unless you send it more.' },
        { type: 'text', text: 'Its closing message:' },
        { type: 'text', text: '配置开关测试。' },
      ],
      source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'cfgswitch-0001' },
    },
  })
  await drain()
  const touchedA = sentCards.slice(markA)
  ok(!JSON.stringify(touchedA).includes('cfgswitch'),
    'notifyAgentNotices=false：回执被静默跳过（实际 ' + touchedA.length + ' 条卡片动作）')

  // B) bot 配置的阈值优先于 env（env=0 也不许分卡）
  const markB = sentCards.length
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 9210, data: { message: { content: [{ type: 'text', text: '阈值优先级测试正文' }] } } })
  }
  feedInbound('om_priority_cfg', '阈值优先级测试')
  await settle(3)
  const createsB = createsSince(markB).length
  ok(createsB === 1,
    'bot 配置 splitConclusionMinMs=600000 压过 env=0 ⇒ 不分卡（实际 ' + createsB + ' 张）')
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
}

console.log('39) admin 路由：绝不泄露密钥 + 配置写入走归一化 + 非法方法拒绝（审计：这两条路由零覆盖）')
{
  const routeOf = (p) => registeredRoutes.find((r) => r.path === p)
  const callRoute = async (route, method, body) => {
    const res = {
      headersSent: false,
      status: 0,
      payload: '',
      writeHead(status) { this.status = status; this.headersSent = true },
      end(text) { this.payload = String(text || '') },
    }
    const req = new EventEmitter()
    req.method = method
    const pending = route.handler(req, res)
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
    await pending
    let json = null
    try { json = JSON.parse(res.payload) } catch { json = null }
    return { status: res.status, raw: res.payload, json }
  }

  const statusRoute = routeOf('/feishu/admin/status')
  ok(Boolean(statusRoute && statusRoute.handler), '/feishu/admin/status 路由已注册且带 handler')
  const st = await callRoute(statusRoute, 'GET')
  ok(st.status === 200 && st.json && st.json.ok === true, '状态路由返回 200 + ok')
  ok(st.json && st.json.bots && st.json.bots[0] && st.json.bots[0].hasSecret === true,
    '状态里只给 hasSecret 布尔（证明有密钥），不给密钥本身')
  ok(!st.raw.includes(APP_SECRET), '状态响应**不含 appSecret 明文**（密钥不泄露）')

  const cfgRoute = routeOf('/feishu/admin/config')
  ok(Boolean(cfgRoute && cfgRoute.handler), '/feishu/admin/config 路由已注册且带 handler')
  const g = await callRoute(cfgRoute, 'GET')
  ok(g.status === 200 && g.json && g.json.ok === true, '配置读取返回 200 + ok')
  ok(g.json && g.json.bots[0] && g.json.bots[0].appSecret === '***', '配置读取把 appSecret 掩码成 ***')
  ok(!g.raw.includes(APP_SECRET), '配置读取响应**不含 appSecret 明文**（密钥不泄露）')

  // POST 写入必须走归一化（不认识的字段会被丢弃 —— 这正是本轮抓到 splitConclusionMinMs 那个 bug 的机制）
  const p = await callRoute(cfgRoute, 'POST', {
    bots: [{ name: 'smoke-posted', workspace: WORKSPACE, appId: 'cli_posted_1', appSecret: 'posted-secret', unknownField: 'x' }],
  })
  ok(p.status === 200 && p.json && p.json.ok === true, '配置写入返回 200 + ok')
  const onDisk = JSON.parse(readFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), 'utf8'))
  ok(onDisk.bots.length === 1 && onDisk.bots[0].name === 'smoke-posted', '写入落到 feishu.config.json（归一化后）')
  ok(!JSON.stringify(onDisk).includes('unknownField'), '归一化丢弃白名单外的字段（这次抓 bug 的机制）')

  const bad = await callRoute(cfgRoute, 'PUT')
  ok(bad.status === 405, '不支持的方法返回 405（实际 ' + bad.status + '）')

  // 收尾：把配置恢复成 smoke 的标准 bot，避免影响后续（reactionEmoji 要保留，用例 40 还要用）
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET, reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true }],
  }, null, 2))
}

console.log('40) 打字提示（reaction）生命周期 + cfg.reactionEmoji 通道（审计：零覆盖）')
{
  // 期望：入站时给用户消息挂一个 emoji（"我在打字"），封口时**撤掉**（不留假象）。
  // cfg.reactionEmoji 在 smoke 配置里显式设成 'GLANCE'（默认是 'OnIt'）⇒ 断言必须看到 GLANCE，
  // 才能证明是**配置通道**生效、而不是写死的默认值。
  const mark = reactionCalls.length
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: 9300, data: { message: { content: [{ type: 'text', text: '打字提示测试正文' }] } } })
  }
  feedInbound('om_reaction_case', '打字提示测试')
  await settle(4)
  const calls = reactionCalls.slice(mark)
  const posts = calls.filter((c) => c.method === 'POST')
  const deletes = calls.filter((c) => c.method === 'DELETE')
  ok(posts.length >= 1, '入站后加了 reaction（打字提示，实际 ' + posts.length + ' 次 POST）')
  ok(posts.some((c) => c.body.includes('GLANCE') || c.url.includes('GLANCE')),
    'emoji 用的是**配置里的** GLANCE（证明 cfg.reactionEmoji 通道生效；实际 body=' + (posts[0] ? posts[0].body.slice(0, 80) : '无') + '）')
  ok(deletes.length >= 1, '封口后撤掉 reaction（不留"正在输入"假象，实际 ' + deletes.length + ' 次 DELETE）')
}

console.log('41) /list 与 /stop（2026-10-01 审计：两条既有命令零覆盖）')
{
  // /list：列出本聊天的会话（▶ 标出当前；无会话时给明确文案）
  const mark = sentCards.length
  feedInbound('om_list_cmd', '/list')
  await drain()
  const body = JSON.stringify(sentCards.slice(mark))
  ok(body.includes('▶') || body.includes('无会话'), '/list 列出会话并标出当前（▶）或明确"无会话"')
  ok(/\d+\.\s/.test(body) || body.includes('无会话'), '/list 的清单带序号')

  // /stop：必须打到"正在跑的**活的** agent"的 cancel()，并给回执（旧实现的坑：缓存句柄可能指向过期实例）
  const cancels = []
  agent.cancel = (reason) => { cancels.push(reason) }
  const mark2 = sentCards.length
  feedInbound('om_stop_cmd', '/stop')
  await drain()
  ok(cancels.length === 1, '/stop 调用了 agent.cancel()（实际 ' + cancels.length + ' 次）')
  ok(cancels[0] && cancels[0].kind === 'user', 'cancel 的 reason 形如 { kind: "user" }')
  ok(JSON.stringify(sentCards.slice(mark2)).includes('已发送停止指令'), '回执明确告诉用户已发送停止指令')
}

console.log('42) 计划模式退出申请（exit_plan_mode）：`user-questions/request` 水位线必须被接管（CM 2026-10-01 报障）')
{
  // 报障原话：「计划模式退出的时候，我收不到你的退出申请」。
  // 根因：`exit_plan_mode` 调的是 `ctx.userQuestions.ask(...)` **服务**
  // （`dsh-plan-mode/lib/index.js:261`），**不经过** `ask_user_question` 工具 ⇒
  // 旧实现只拦 `tools/execute`（用例 26/29 覆盖的那条）⇒ 拦不到它，
  // 申请只发给了连着长连接的 GUI 客户端。修法＝与 `approval/request` 同构的水位线。
  const planText = '# 计划：把计划审查搬到飞书\n\n1. 只读排查调用链\n2. 出水印卡 + 中文选项'
  const questions = [{
    id: 'plan-review',
    header: 'Plan review',
    question: 'Approve this plan and leave plan mode?',
    detail: planText,
    options: [
      { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
      { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
    ],
    intent: { kind: 'plan-review', approve: 'Approve' },
  }]
  let delegated = 0
  const nextSpy = () => { delegated += 1; return Promise.resolve('next') }

  // (a) 没有 agent / 不是飞书会话的 agent ⇒ 必须 `next()` 交回 harness。
  //     这条是**红线**：GUI 会话的提问绝不能被本插件吞掉（否则 GUI 里也会变哑巴）。
  ok(emitCtx('user-questions/request', { questions, signal: undefined }, nextSpy).length === 1,
    '水位线上只有本插件一个监听器（接管范围可控）')
  const foreignRuns = emitCtx('user-questions/request', { questions, agent: { id: 'agent-not-feishu' }, signal: undefined }, nextSpy)
  const foreignResolved = await Promise.all(foreignRuns.map((r) => Promise.resolve(r).catch(() => {})))
  ok(delegated === 2 && foreignResolved[0] === 'next',
    '无 agent / 非飞书 agent 一律交回下一个（delegated=' + delegated + '）')

  const cardOf = (since) => cardsSince(since).filter((c) => c.op === 'create')
    .find((c) => JSON.stringify(c.payload).includes('计划已写好'))
  const rowsOf = (card) => (card ? card.payload.body.elements.filter((e) => e.tag === 'column_set') : [])
  const tokenOf = (rows) => rows[0] && rows[0].columns[1].elements[0].behaviors[0].value.fs_question
  const tap = async (token, index) => {
    fakeProc.output += JSON.stringify({
      type: 'event',
      eventType: 'card.action.trigger',
      data: { action: { tag: 'button', value: { fs_question: token, fs_option: index } }, context: { open_chat_id: CHAT_ID } },
    }) + '\n'
    await drain()
  }

  // (b) 飞书会话的提问 ⇒ 接管 + 出水印卡（计划正文必须在卡上，不能是空卡）
  const mark = sentCards.length
  const r1 = emitCtx('user-questions/request', { questions, agent, signal: undefined }, nextSpy)
  const pending = r1[0]
  ok(Boolean(pending) && typeof pending.then === 'function', '飞书会话的提问被接管（返回 Promise，而不是 next()）')
  await drain()
  const card = cardOf(mark)
  ok(Boolean(card), '计划审查卡已发到飞书')
  const body = JSON.stringify(card ? card.payload : {})
  ok(body.includes('计划已写好'), '卡头是"计划已写好，等你批准"（不是通用的"需要你的回答"）')
  ok(body.includes('把计划审查搬到飞书') && body.includes('只读排查调用链'),
    '计划正文**完整**在卡上（含标题与正文，不是只有标题的空卡）')
  const rows = rowsOf(card)
  // 2026-10-02 CM：「审批文字+按钮+拒绝文字+按钮 ⇒ 文字放在按钮上，审批绿、拒绝红」。
  // 2026-10-03 CM（I）：「批准和拒绝在同一行，**另开一行**去做目标模式这个选择」
  //   ⇒ 两排：行1＝批准/拒绝（bisect）· 行2＝整行「🎯 以目标模式跑」。
  ok(rows.length === 2, '审批卡**两排**：行1＝批准/拒绝 · 行2＝「以目标模式跑」（实际 ' + rows.length + ' 排）')
  const goalRow = rows[1]
  const goalBtn = (((goalRow && goalRow.columns) || [])[0] || {}).elements
  const goalButton = (goalBtn || [])[0]
  ok(Boolean(goalButton) && goalButton.tag === 'button'
    && goalButton.text && goalButton.text.content === '🎯 以目标模式跑',
    '★ 行2 是整行按钮「🎯 以目标模式跑」（实际：'
      + JSON.stringify(goalButton && goalButton.text && goalButton.text.content) + '）')
  ok(Boolean(goalButton) && goalButton.behaviors && goalButton.behaviors[0]
    && goalButton.behaviors[0].value && goalButton.behaviors[0].value.fs_plan_goal !== undefined,
    '★ 该按钮带新命名空间 { fs_plan_goal }（既有三类分派未动）')
  ok(Boolean(goalRow) && ((goalRow.columns || []).length === 1),
    '行2 只有**一列**（整行宽度 ⇒ 长文案不会被截断）')
  const row = rows[0]
  ok(Boolean(row) && row.flex_mode === 'bisect', '两个按钮**同一排**等分（flex_mode=bisect）')
  const btns = ((row && row.columns) || []).map((c) => (c.elements || [])[0])
  const approveBlock = btns[0]
  const rejectBtn = btns[1]
  ok(btns.length === 2, '正好两个控件（实际 ' + btns.length + ' 个）')
  // 2026-10-02 真机两版：第一版把绿放在 `column.background_style` 上 ⇒ CM 手机上**没渲染**
  //（官方注明该字段需客户端 v7.9+），且被 width:fill 按钮整列盖住。定稿＝可点击的整块容器。
  ok(Boolean(approveBlock) && approveBlock.tag === 'interactive_container',
    '「批准」＝整块可点击的容器（不是按钮 + 绿底列）')
  ok(Boolean(approveBlock) && approveBlock.background_style === 'green-600',
    '「批准」＝深绿底 green-600（实际 ' + (approveBlock && approveBlock.background_style) + '）')
  const approveMd = (approveBlock && approveBlock.elements || [])[0]
  ok(Boolean(approveMd) && approveMd.tag === 'markdown' && approveMd.text_align === 'center',
    '批准文字居中（text_align=center —— 第一版左对齐，CM 指出）')
  ok(Boolean(approveMd) && approveMd.content === "**<font color='white'>批准</font>**",
    '白字标签**不跨加粗嵌套**（写成 <font…>**批准</font>** 会把标签原文当文字漏出来）')
  ok(Boolean(approveMd) && !/<\s*font/i.test(String(approveMd.content).replace("<font color='white'>", '').replace('</font>', '')),
    '除那一处白字标签外没有别的裸标签（防再次漏出英文）')
  ok(Boolean(rejectBtn) && rejectBtn.text.content === '拒绝', '「拒绝」文字在按钮上')
  ok(Boolean(rejectBtn) && rejectBtn.type === 'danger_filled', '「拒绝」＝红底白字（danger_filled）')
  ok(Boolean(approveBlock) && Boolean(rejectBtn)
    && approveBlock.behaviors[0].value.fs_option === 0 && rejectBtn.behaviors[0].value.fs_option === 1,
    '序号仍指向原选项（0=Approve / 1=Keep planning）—— 协议没动')
  ok(body.includes('点「批准」') && !body.includes('选它'), '提示文案跟着改（不再是"点右侧选它"）')

  // (c) 点「批准」⇒ 回传 harness 的**必须是原 label `Approve`**（plan-mode 按它判批准）
  await tapValue(approveBlock.behaviors[0].value)
  const a1 = await pending
  ok(a1 && a1.answers && a1.answers.length === 1 && a1.answers[0].id === 'plan-review',
    '答案按 question.id 原样回传（id=plan-review）')
  ok(a1.answers[0].selected.length === 1 && a1.answers[0].selected[0] === 'Approve',
    '选中项是原 label `Approve`（中文只是卡面文案，没污染回传协议）')
  ok(a1.answers[0].custom === undefined, '没把"按钮选择"冒充成自定义反馈')

  // (d) 点「继续修改」⇒ 回传原 label `Keep planning`（plan-mode 据此留在计划模式）
  const mark2 = sentCards.length
  const r2 = emitCtx('user-questions/request', { questions, agent, signal: undefined }, nextSpy)
  await drain()
  const rows2 = rowsOf(cardOf(mark2))
  const rejectBtn2 = rows2[0] && ((rows2[0].columns || [])[1] || {}).elements[0]
  await tapValue(rejectBtn2.behaviors[0].value)
  const a2 = await r2[0]
  ok(a2.answers[0].selected[0] === 'Keep planning', '第二个选项回传 `Keep planning`')

  // (e) 文字「批准」＝ 批准（CM 习惯回中文；批准标签是英文硬约定）
  const r3 = emitCtx('user-questions/request', { questions, agent, signal: undefined }, nextSpy)
  await drain()
  feedInbound('om_plan_approve_text', '批准')
  await drain()
  const a3 = await r3[0]
  ok(a3.answers[0].selected[0] === 'Approve', '回文字「批准」被认成批准（不再被误当成修改意见）')

  // (f) 带补充说明的文字 ⇒ 仍按"继续修改"的反馈回给模型。
  //     方向是刻意的：误判成"留在计划模式"可恢复，误判成"已批准"不可恢复（直接开工）。
  const r4 = emitCtx('user-questions/request', { questions, agent, signal: undefined }, nextSpy)
  await drain()
  feedInbound('om_plan_feedback_text', '同意，但第 2 步先改成只读排查')
  await drain()
  const a4 = await r4[0]
  ok(a4.answers[0].selected.length === 0 && String(a4.answers[0].custom).includes('第 2 步'),
    '带补充说明 ⇒ 当成反馈（custom），绝不误批准')

  // (g) 普通提问（走服务时）不受影响：卡头仍是通用文案、回传照旧
  const mark5 = sentCards.length
  const r5 = emitCtx('user-questions/request', {
    questions: [{ id: 'q-plain', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }],
    agent, signal: undefined,
  }, nextSpy)
  await drain()
  ok(JSON.stringify(cardsSince(mark5)).includes('需要你的回答'),
    '非计划审查的提问仍走通用问句卡（没有把两类混在一起）')
  await tap(tokenOf(rowsOf(cardsSince(mark5).filter((c) => c.op === 'create')
    .find((c) => JSON.stringify(c.payload).includes('需要你的回答')))), 0)
  const a5 = await r5[0]
  ok(a5.answers[0].selected[0] === '甲', '普通提问的按钮回传照旧（甲）')
}

console.log('43) /plan <正文>：命令起了回合也必须建卡（2026-10-01 修复①）')
{
  // 背景（CM 报障「我发了这个计划模式的启动给你……飞书上没有看到卡片」）：
  // harness 把 `/plan <正文>` 解释成「开计划模式 + 把正文当用户消息**起一个真回合**」
  // （会话 fs-main-mupoeiy4 seq 721→725 实证）；而插件的事件入口把命令交给 handleCommand
  // 后**直接 return** ⇒ 那一整轮（16 步）没有任何卡片持有它，CM 完全看不到过程。
  // 修法：命令回报 turnStarted 时落回 handleInbound 走「建卡 → 等回合 → 封口」。
  const prevExec = fakeCommands.execute
  const prevIdle43 = agent.whenIdle
  const mark = sentCards.length
  agent.whenIdle = async () => {}
  agent.send = function (message) { this.sent.push(message) }   // 命令轮**不该**再走这条
  const sentBefore = agent.sent.length
  const seqBase = 9500
  fakeCommands.execute = async () => {
    // 模拟 harness：/plan <正文> 在 execute 内部就把正文投进会话并起了回合、开始产出
    agentEvents.push({
      type: 'assistant/message', seq: seqBase + 1,
      data: { message: { content: [{ type: 'text', text: '命令起回合后的过程' }] } },
    })
    return { result: { text: 'Plan mode on. Use /plan off to leave.' } }
  }
  feedInbound('om_plan_turn', '/plan 检查计划模式，目标模式，所有卡片是否正常')
  await settle(3)
  ok(createsSince(mark).length >= 1,
    '/plan <正文> 也建了卡（create 次数 ' + createsSince(mark).length + '）')
  ok(JSON.stringify(cardsSince(mark)).includes('命令起回合后的过程'),
    '命令起的这一轮过程被镜像进卡（不再「看不见」）')
  ok(agent.sent.length === sentBefore, '正文没有被重复投递一次（skipSend 生效）')
  fakeCommands.execute = prevExec
  agent.whenIdle = prevIdle43
}

console.log('44) 入站消息不被静默吞掉（2026-10-01 事故守护）')
{
  // 事故复盘：steerActiveTurn 第一句就调 isDuplicateInbound() —— 它**有副作用**（把 id 记进
  // seenInboundIds）。一旦 steer 没走成（没有活跃回合 / agent 无 steer）函数 return false
  // 落到 handleInbound，那里再查一次 ⇒ 已「见过」⇒ 判重投直接丢掉
  // ⇒ **所有飞书消息被静默吞掉**（真机日志特征：duplicate inbound skipped 连发）。
  // 修法：只「窥探」不认领；仅当 steer 真的投出去之后才认领。这条用例把它钉死。
  const prevIdle44 = agent.whenIdle
  agent.whenIdle = async () => {}
  const mark = sentCards.length
  agent.send = function (message) { this.sent.push(message) }
  const sentBefore = agent.sent.length
  delete agent.steer                                   // 没有 steer 能力 ⇒ 必然走 fallback
  feedInbound('om_never_swallowed', '这条不许被吞')
  await settle(3)
  ok(agent.sent.slice(sentBefore).some((m) => JSON.stringify(m).includes('这条不许被吞')),
    '无 steer 能力时消息照常投递（没被误判成重投）')
  ok(createsSince(mark).length >= 1, '并且照常建卡')
  // 真·重投仍必须被去重（去重能力不能被上面的修复削弱）
  const sentAfter = agent.sent.length
  feedInbound('om_never_swallowed', '这条不许被吞')
  await settle(2)
  ok(agent.sent.length === sentAfter, '同 message_id 重投仍被去重（不会跑两轮）')
  agent.whenIdle = prevIdle44
}

console.log('45) exit_plan_mode 经【工具层】接管（2026-10-02 换的通道）')
{
  // 背景：`user-questions/request` 水位线即使把监听下沉到 agent.ctx **仍然拿不到**
  //（真机 2026-10-02 00:4x：只有注册行 bound to agent scope，没有任何接管行；
  //  harness 侧收到 "The user dismissed the plan review to speak instead"）。
  // 改用与 ask_user_question 同一条已验证通道：tools/execute。
  const plan = '# 把计划审查搬到飞书\n\n- 只读排查调用链'
  const nextSpy = () => Promise.resolve('next')
  // 2026-10-02：改成**分别收结果与异常** —— 「继续修改」分支现在必须**抛错**
  //（返回 isError:true 会被 harness 判"不可序列化"而换成报错，见真机实测）。
  // ⚠️ 必须在 emitCtx **同一拍**就把异常接住并转成值：本用例「继续修改」分支是**抛错**的，
  // 若等到 await 时才挂 handler，Node 会先看到 unhandled rejection，直接崩掉测试进程
  //（2026-10-02 实测：`Error: The user chose to keep planning…` 把 smoke 打挂）。
  const capture = (runs) => runs.map((r) => Promise.resolve(r).then(
    (value) => ({ value }), (error) => ({ error })))
  const toolOf = (os) => {
    const hit = os.find((o) => o.value && typeof o.value === 'object' && 'content' in o.value)
    return hit && hit.value
  }
  const planCardOf = (since) => cardsSince(since).filter((c) => c.op === 'create')
    .find((c) => JSON.stringify(c.payload).includes('计划已写好'))

  // (a) 红线：非飞书 agent / 空计划 ⇒ **所有**监听器都必须 next()
  // ⚠️ 2026-10-04：原先写死 `length === 2`（当时 tools/execute 上只有 exit_plan_mode +
  //    ask_user_question 两条【专用】拦截）。0.7.18 新增了【通用】身份覆写拦截
  //    （`ctx.on('tools/execute')`：不拦任何工具、只覆写身份、一律 next）⇒ 变成 3 个
  //    ⇒ 写死的 2 让这条**红线误报**（CI run 37150060118 唯一失败项，本地同样复现）。
  //    红线的本意是「**不许吞掉**非飞书的工具调用」，**不是「必须恰好 2 个」**
  //    ⇒ 改成 `>= 2`（下限守住"两条专用拦截都在"），并把实际数量打进消息便于以后自查。
  const foreign = await Promise.all(capture(emitCtx('tools/execute',
    { name: 'exit_plan_mode', agent: { id: 'agent-not-feishu' }, arguments: { plan }, signal: undefined }, nextSpy)))
  ok(foreign.length >= 2 && foreign.every((o) => o.value === 'next'),
    '非飞书 agent ⇒ 一律交回下一个（红线；listeners=' + foreign.length + '）')
  const emptyPlan = await Promise.all(capture(emitCtx('tools/execute',
    { name: 'exit_plan_mode', agent, arguments: { plan: '   ' }, signal: undefined }, nextSpy)))
  ok(emptyPlan.every((o) => o.value === 'next'), '计划正文为空 ⇒ 交回下一个（不吞）')

  // (b) 飞书会话 ⇒ 接管 + 出计划审查卡（计划正文必须完整在卡上）
  const mark = sentCards.length
  const runs = capture(emitCtx('tools/execute',
    { name: 'exit_plan_mode', agent, arguments: { plan }, signal: undefined }, nextSpy))
  await drain()
  const card = planCardOf(mark)
  ok(Boolean(card), '工具层接管成功：飞书弹出计划审查卡')
  ok(JSON.stringify(card ? card.payload : {}).includes('把计划审查搬到飞书'), '计划正文完整在卡上')

  // (c) 回文字「批准」⇒ 通过**命令注册表 /plan off** 真的退出计划模式
  //     （真机实证：ctx.inject(['planMode']) 在本环境从不触发 ⇒ planModeRef 恒为 null，
  //      只调 planMode.set 那条分支等于"口头说退出"，会话里并未退出）
  const prevExec = fakeCommands.execute
  const execLines = []
  fakeCommands.execute = async (a, line) => {
    execLines.push(line)
    return { result: { text: 'Plan mode off.' } }
  }
  planModeCalls.length = 0
  feedInbound('om_plan_approve_tool', '批准')
  await drain()
  const tool = toolOf(await Promise.all(runs))
  ok(Boolean(tool), '返回的是**工具结果**（不是 next()）')
  ok(tool && tool.isError === false && tool.value && tool.value.approved === true,
    '批准 ⇒ isError:false + approved:true')
  ok(execLines.includes('/plan off'),
    '批准 ⇒ 走命令注册表 /plan off 真正退出计划模式（不只是回一句话）')
  ok(JSON.stringify(tool ? tool.content : '').includes('Plan approved'), '回给模型的文案与 plan-mode 原文一致')
  fakeCommands.execute = prevExec

  // (d) 带说明的文字 ⇒ **抛错**把反馈原文回给模型；且不退出计划模式
  planModeCalls.length = 0
  const runs2 = capture(emitCtx('tools/execute',
    { name: 'exit_plan_mode', agent, arguments: { plan: '# 第二版计划' }, signal: undefined }, nextSpy))
  await drain()
  feedInbound('om_plan_keep_tool', '同意，但第 2 步先改成只读排查')
  await drain()
  const os2 = await Promise.all(runs2)
  const thrown = os2.find((o) => o.error)
  ok(Boolean(thrown) && String(thrown.error && thrown.error.message).includes('第 2 步'),
    '带说明 ⇒ **抛错**把反馈原文回给模型（不是 isError:true —— 那会被 harness 判"不可序列化"）')
  ok(os2.filter((o) => o.error).length === 1, '恰好一个监听器抛错（另一个交回 next）')
  ok(planModeCalls.length === 0, '留在计划模式（没有退出）')
}

console.log('46) 插话必须【新开卡片】+ 醒目彩色块（2026-10-02 CM 追加）')
{
  // CM 原话：「我"插话"了以后，你应该新开卡片。不然我说的话全部堆到下面，
  //           但是你一直在旧卡片上更新」。
  let release
  const gate = new Promise((r) => { release = r })
  const prevIdle = agent.whenIdle
  agent.whenIdle = () => gate
  agent.send = function (message) { this.sent.push(message) }
  agent.steered = []
  agent.steer = function (message) { this.steered.push(message) }

  const mark = sentCards.length
  feedInbound('om_steer_start', '起一个会被插话的回合')
  await drain()
  const createsBefore = cardsSince(mark).filter((c) => c.op === 'create').length
  ok(createsBefore >= 1, '活跃回合已建卡（create 次数 ' + createsBefore + '）')

  feedInbound('om_steer_interrupt', '这是我插进去的话')
  await drain()
  ok(agent.steered.some((m) => JSON.stringify(m).includes('这是我插进去的话')),
    '插话以 steer 投递（不排队等整轮跑完）')

  const creates = cardsSince(mark).filter((c) => c.op === 'create')
  ok(creates.length >= createsBefore + 1,
    '插话后**新开了一张卡**（create 次数 ' + createsBefore + ' → ' + creates.length + '）')
  const body = JSON.stringify(cardsSince(mark))
  ok(body.includes('后续内容见下方新卡'), '旧卡就地封口并指路（不再往下堆）')
  ok(body.includes('你的消息已插话送达'), '新卡第一块是插话提示')
  ok(body.includes('**📨 你的消息已插话送达**'), '提示标题加粗（markdown 粗体）')
  ok(body.includes('orange-50') && body.includes('background_style'),
    '提示是彩色底块（column_set + background_style，飞书 -50 = 区块背景）')
  ok(body.includes('这是我插进去的话'), '他这句话本身也在提示块里（看得到自己说了什么）')

  // 🔴 第四十六轮 MEDIUM#2（核对为真）：handleHelperMessage 是同步函数，steer 支原来在
  //   handleInbound **之前**就 return ⇒ 回合进行中收到「文字+文件」的 post，附件静默丢
  //   （#65 的孪生形状，只是这次窗口在插话）。修复=入口先串行下载 post 附件、落盘说明拼进
  //   textRendered 再照常分流——插话文本必须带得出"已保存到"。
  const fileDir46 = join(WORKSPACE, 'downloaded_files')
  const names46 = () => (existsSync(fileDir46) ? readdirSync(fileDir46) : [])
  const before46 = new Set(names46())
  feedInboundRaw('om_steer_post65', 'post', {
    title: '',
    content: [[{ tag: 'text', text: '插话顺带发个表' },
      { tag: 'file', file_key: 'file_v3_steer65', file_name: '插话表.xlsx' }]],
  })
  await drain()
  ok(names46().filter((n) => !before46.has(n)).some((n) => n.endsWith('_插话表.xlsx')),
    '★★★ 插话回合里发"文字+文件"post ⇒ 附件也落盘（旧字节这支直接丢文件＝必红）')
  const steeredJson46 = JSON.stringify(agent.steered)
  ok(steeredJson46.includes('插话表.xlsx') && steeredJson46.includes('已保存到'),
    '★★ 插话正文里带落盘说明（agent 拿得到路径＝插话真的把文件带进来了）')

  release()
  agent.whenIdle = prevIdle
  await drain()
}

console.log('47) 热重载卸载：agent.ctx 上的监听必须被注销（high#1 的核心修法，此前零覆盖）')
{
  // ⭐ 敏感性检查（第三轮门槛 medium#1 的修复）：**从未收到过飞书消息**的 agent，
  // 只靠 agent/status 一次补挂，就必须同时拿到 approval/request **和** user-questions/request。
  // 上一版代码只挂前者 ⇒ 重载后它起自动轮（goal/notice）时问句会只弹电脑、飞书收不到卡；
  // 那条缺陷在**这里会变红**（不是"写了就算验过"）。
  emitCtx('agent/status', { agent: freshAgent, status: 'stopped' })
  await drain()
  ok(freshCount('approval/request') === 1, '新 agent 靠 agent/status 挂上审批水位线')
  ok(freshCount('user-questions/request') === 1, '新 agent 靠 agent/status 也挂上问句水位线（上一版会漏）')

  // 再确保本代已经绑过（agent/status 的任何状态都会补挂审批水位线）
  emitCtx('agent/status', { agent, status: 'stopped' })
  await drain()
  const bound = agentScopeCount('approval/request')
  ok(bound >= 1, '插件确实把 approval/request 挂到了 agent.ctx 上（本次 ' + bound + ' 条）')

  // 再取一次：同一个 agent 重复绑定**不许**叠加（WeakSet 幂等）
  emitCtx('agent/status', { agent, status: 'stopped' })
  await drain()
  ok(agentScopeCount('approval/request') === bound, '同一代重复绑定不叠加（仍是 ' + bound + ' 条）')

  // 模拟 HMR 卸载：**按行为**找出卸载钩子（第四轮门槛 medium）—— 不再假设
  // "第一个 ctx.effect 就是卸载钩子"（那样 index.js 一旦在前面多注册一个 effect，
  // 这个用例要么误报失败、要么去卸载别的东西）。判据就是它该有的效果：
  // 执行后本代挂上去的 agent 作用域监听必须**全部**消失（两个 mock agent 都算）。
  const beforeDisposed = agentScopeDisposed
  ok(effectCleanups.length >= 1, '捕获到 ctx.effect 的 cleanup（' + effectCleanups.length + ' 个）')
  let unloaded = false
  for (const cleanup of effectCleanups) {
    cleanup()
    if (agentScopeCount('approval/request') === 0 && agentScopeCount('user-questions/request') === 0
      && freshCount('approval/request') === 0 && freshCount('user-questions/request') === 0) {
      unloaded = true
      break
    }
  }
  ok(unloaded, '卸载钩子执行后两条水位线均已注销（不再跨代叠加）')
  ok(agentScopeDisposed > beforeDisposed, 'disposer 确实移除过监听（移除次数 ' + agentScopeDisposed + '）')
}
  // 0.7.16: this case just disposed the live generation (the generation flag correctly silences it afterwards --
  // correct production semantics: after HMR the old generation must stay quiet; per-card registration in 0.7.15
  // could not feel this). The suite needs a live generation to continue => restore like a real hot reload:
  // re-apply the module (fresh generation, flag=false). Precedent: case 53 re-applies mid-suite, 54+ stay green.
  const mod47 = await import('../index.js')
  mod47.apply(ctx)
  await drain()

console.log('48) 卡片 schema 校验：schema 2.0 不许出现 tag=action（真机 230099/200861 报错）')
{
  // 2026-10-02 真机事故（CM：「我发了指令，它没弹出这个卡片」）：
  // 我把切换卡从 1.0 形状换成 schema 2.0，却留着 1.0 的 `tag: 'action'` 包按钮 ⇒ 飞书**直接拒建卡**：
  //   code 230099 / ErrCode 200861  ErrPath: ROOT -> body -> elements -> [3](tag: action)
  //   ErrMsg: cards of schema V2 no longer support this capability; unsupported tag action
  // mock 的 fetch 不校验卡片结构 ⇒ 冒烟全绿、真机全废。这条用例把飞书那条规则**前移**到本地。
  const walk = (els, visit) => {
    for (const e of els || []) {
      if (!e || typeof e !== 'object') continue
      visit(e)
      if (Array.isArray(e.elements)) walk(e.elements, visit)
      for (const col of (e.columns || [])) walk(col && col.elements, visit)
    }
  }
  let v2 = 0
  const bad = []
  for (const c of sentCards) {
    const p = c.payload
    if (!p || p.schema !== '2.0') continue
    v2 += 1
    if (!p.body || !Array.isArray(p.body.elements)) bad.push('schema 2.0 卡缺 body.elements')
    walk(p.body && p.body.elements, (e) => {
      if (e.tag === 'action') bad.push('出现 1.0 的 tag=action（2.0 不支持）')
      if (e.tag === 'button' && !Array.isArray(e.behaviors)) bad.push('2.0 按钮缺 behaviors')
    })
  }
  // 带**按钮**的 column_set 不能是 flex_mode='none'（CM 2026-10-02 实测：按钮全被压成省略号）。
  // 'none' 是按内容自适应宽度：纯文本列没问题（工具面板就是），按钮列会塌成一点点。
  // 生产里渲染正常的是 stretch / bisect + width:'weighted'（提问卡、一级 F 都是这套）。
  const noneWithButton = []
  for (const c of sentCards) {
    const p = c.payload
    if (!p || p.schema !== '2.0') continue
    walk(p.body && p.body.elements, (e) => {
      if (e.tag !== 'column_set') return
      const hasButton = (e.columns || []).some((col) => ((col && col.elements) || [])
        .some((el) => el && el.tag === 'button'))
      if (hasButton && (!e.flex_mode || e.flex_mode === 'none')) noneWithButton.push(String(e.flex_mode))
    })
  }
  // 按钮文字长度（CM 2026-10-02 实测）：
  //  · **窄列里的按钮**（放在 column 里）文字 ≤2 字 —— 「但凡超过两个字就会变省略号」
  //  · **整行按钮**（顶层、width:fill）可以长（L1 版式就是把会话名写进按钮），但也要有上限，
  //    免得名字过长把按钮文字挤掉。上限与 index.js 的 SESSION_NAME_MAX(16) + '▶ 12. ' 前缀 对应。
  const longNarrow = []
  const longWide = []
  const walkBtn = (els, inColumn) => {
    for (const e of els || []) {
      if (!e || typeof e !== 'object') continue
      if (e.tag === 'button') {
        const t = String((e.text && e.text.content) || '')
        const n = [...t].length
        if (inColumn ? n > 2 : n > 24) (inColumn ? longNarrow : longWide).push(t)
      }
      if (Array.isArray(e.elements)) walkBtn(e.elements, inColumn)
      // ⚠️ 2026-10-03：**单列** column_set ＝ 整行按钮（例：计划卡的「🎯 以目标模式跑」），
      //    不是"窄列"；只有**多列**共享一行时才算窄列（≤2 字那条约束才适用）。
      const multiCol = Array.isArray(e.columns) && e.columns.length > 1
      for (const col of (e.columns || [])) walkBtn(col && col.elements, multiCol)
    }
  }
  for (const c of sentCards) {
    const p = c.payload
    if (!p || p.schema !== '2.0') continue
    walkBtn(p.body && p.body.elements, false)
  }
  ok(longNarrow.length === 0, '窄列里的按钮文字都 ≤2 字（超过会被截成省略号）'
    + (longNarrow.length ? ' —— 超长：' + longNarrow.slice(0, 3).join(' / ') : ''))
  ok(longWide.length === 0, '整行按钮文字都在上限内（≤24 字，含序号与 ▶ 前缀）'
    + (longWide.length ? ' —— 超长：' + longWide.slice(0, 2).join(' / ') : ''))
  ok(noneWithButton.length === 0,
    '带按钮的 column_set 都用等分/拉伸（不用 none，否则按钮会被压成省略号）'
    + (noneWithButton.length ? ' —— 违规 ' + noneWithButton.length + ' 处' : ''))
  ok(v2 > 0, '本轮确实建过 schema 2.0 的卡（' + v2 + ' 张，否则这条校验没意义）')
  ok(bad.length === 0, 'schema 2.0 卡片全部合法（无 action 元素、按钮走 behaviors）'
    + (bad.length ? ' —— 首个问题：' + bad[0] : ''))
}

console.log('49) 入站文件自动收：飞书发文件 ⇒ 插件自己下载并告知（CM 2026-10-02）')
{
  const dir = join(WORKSPACE, 'downloaded_files')
  // ⚠️ 收件目录**跨轮累积**（它是 tmpdir 下的固定路径，上一次跑的文件还在）——
  //    所以断言一律只看"**这一轮新增**的文件名"，绝不用绝对计数。
  //    （0.5.7 落地后冒烟红 1 条就是踩了这个：`pngFiles.length === 1` 在第二次跑时变成 2。）
  const namesOf = () => (existsSync(dir) ? readdirSync(dir) : [])
  const beforeNames = new Set(namesOf())
  const newNames = () => namesOf().filter((n) => !beforeNames.has(n))
  feedInboundFile('om_file_001', { key: 'file_v3_abc', name: '季度报表.xlsx' })
  await drain()
  const added = newNames()
  ok(added.length === 1, '文件真的落盘（新增 ' + added.length + ' 个）')
  ok(added.some((n) => n.includes('季度报表')), '文件名保留下来（' + String(added[0] || '-') + '）')
  // 🔴 第四十六轮自纠（r39 全量实测红暴露的顺序依赖）：原来断 resourceDownloads[0]——
  //   用例 46 的"插话带附件"格排在本用例之前，[0] 已不是本条消息的下载 ⇒ 恒假。改 some()：
  //   判"本条 file_key 请求过资源接口"，与执行顺序无关。
  ok(resourceDownloads.some((r) => /\/resources\/file_v3_abc\?type=file/.test(String(r.url))),
    '走的是消息资源接口（/messages/<id>/resources/<file_key>?type=file）')
  const seen = JSON.stringify(agent.sent)
  ok(seen.includes('收到文件') && seen.includes('季度报表'), '插件自己把文件喂给模型（不用 CM 再口头告诉我一遍）')
  ok(seen.includes('downloaded_files'), '并把落盘路径一起给模型')
  ok(consoleLines.some((l) => l.includes('inbound file saved:')), '留痕 `inbound file saved:`（可日志复验）')
  // ①b 有扩展名的（文件消息带 file_name）**原样保留**，不许被文件头嗅探改写
  ok(added.some((n) => n.endsWith('_季度报表.xlsx')), '带扩展名的文件名原样保留（实际 ' + String(added[0] || '-') + '）')

  // ② 图片：飞书**不给文件名**（只有 image_key）⇒ 必须按**文件头**补扩展名。
  //    真机实例：CM 发的截图存成 `2026-10-02-15-52-19_image`（内容是 JPEG），光看名字看不出格式。
  const beforeImg = new Set(namesOf())
  resourceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
  feedInboundFile('om_file_img', { type: 'image', key: 'img_v3_png' })
  await drain()
  const newImgs = namesOf().filter((n) => !beforeImg.has(n))
  ok(newImgs.length === 1 && newImgs[0].endsWith('_image.png'),
    '图片消息按文件头补上扩展名（本轮新增 ' + String(newImgs[0] || '-') + '）')
  ok(/^\d{4}-\d{2}-\d{2}-\d{6}_/.test(String(newImgs[0] || '')),
    '时间戳换成本地时间格式 YYYY-MM-DD-HHMMSS（旧版是 UTC 的 YYYY-MM-DD-HH-MM-SS）')
  ok(consoleLines.some((l) => l.includes('inbound file saved:') && l.includes('_image.png')),
    '留痕里也能看到补好的扩展名')

  // ③ 认不出的字节 ⇒ `.bin`（**不猜**格式）
  const beforeBin = new Set(namesOf())
  resourceBytes = Buffer.from('hello-from-feishu')
  feedInboundFile('om_file_noext', { key: 'file_v3_noext', name: '没有扩展名' })
  await drain()
  ok(namesOf().filter((n) => !beforeBin.has(n)).some((n) => n.endsWith('_没有扩展名.bin')),
    '认不出的格式补 .bin（不瞎猜）')

  // 失败也要**可见**：不再静默吞掉（CM 原话正是"你不知道，要我告诉你"）
  resourceShouldFail = true
  feedInboundFile('om_file_002', { key: 'file_v3_bad', name: '坏文件.pdf' })
  await drain()
  resourceShouldFail = false
  ok(JSON.stringify(agent.sent).includes('下载失败'), '下载失败时明说失败（HTTP 码 + 文件名），不再无声')
  ok(consoleLines.some((l) => l.includes('inbound file download failed: HTTP 403')), '并留痕 HTTP 状态码')

  // 🔴 中台 #65（CM 2026-10-08「赶紧修，这功能不能坏」）：PC 端"文字+文件同一条消息"是
  //   msg_type=post 富文本。旧实现只在**正文为空**时才下载附件 ⇒ 有文字时内嵌 file 静默丢
  //   （考勤表没了、agent 只收到一句"麻烦核对"）。修复=post 一律抠附件走同一条下载链。
  resourceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
  const beforePost = new Set(namesOf())
  const sentBefore65 = agent.sent.length
  feedInboundRaw('om_post65_txt', 'post', {
    title: '',
    content: [
      [{ tag: 'text', text: '麻烦核对下考勤表' },
        { tag: 'file', file_key: 'file_v3_post65', file_name: '考勤表.xlsx' }],
    ],
  })
  await drain()
  const newPost = namesOf().filter((n) => !beforePost.has(n))
  ok(newPost.length === 1 && newPost[0].endsWith('_考勤表.xlsx'),
    '★★★ #65 post 带文字+文件 ⇒ 文件落盘（旧字节只收文字丢文件＝本条必红）｜新增 '
    + String(newPost[0] || '-'))
  ok(resourceDownloads.some((r) => /\/resources\/file_v3_post65\?type=file/.test(r.url)),
    '★★ 内嵌附件走同一条消息资源接口（复用整条附件链，不另起第二通道）')
  const seen65 = JSON.stringify(agent.sent.slice(sentBefore65))
  ok(seen65.includes('麻烦核对下考勤表') && seen65.includes('已保存到') && seen65.includes('考勤表.xlsx'),
    '★★★ 送进 agent 的正文＝原文字＋落盘说明（只有字没有表＝等于没收到）｜实得 '
    + seen65.slice(0, 160))
  // ④b post **只有图片没文字**：旧写法落到"非文本消息丢弃"支，修复后照样抠下来
  const beforePost2 = new Set(namesOf())
  feedInboundRaw('om_post65_img', 'post', {
    title: '',
    content: [[{ tag: 'img', image_key: 'img_v3_post65b' }]],
  })
  await drain()
  ok(namesOf().filter((n) => !beforePost2.has(n)).some((n) => n.endsWith('_image.png')),
    '★★ post 无文字带图 ⇒ 图也收（img 元素按文件头补扩展名，与整条图片消息同口径）')

  // ④c 🔴 第四十六轮 MEDIUM#1（核对为真）：时间戳只有**秒级** ⇒ 同一条 post 里两个同名附件
  //   （旧链算出同一路径）后者**静默覆盖**前者，而两条回执各自声称有文件＝agent 内容与回执对不上。
  //   修复＝撞名加 -2 序号。判据取"两份落盘互不相同且都在"（跨秒也不假红）。
  const beforeDup = new Set(namesOf())
  const sentBeforeDup = agent.sent.length
  feedInboundRaw('om_post65_dup', 'post', {
    title: '',
    content: [[{ tag: 'text', text: '两联并存' },
      { tag: 'file', file_key: 'file_v3_dup_a', file_name: '考勤重复.xlsx' },
      { tag: 'file', file_key: 'file_v3_dup_b', file_name: '考勤重复.xlsx' }]],
  })
  await drain()
  const dupMsg = agent.sent.slice(sentBeforeDup).find((m) => JSON.stringify(m).includes('两联并存'))
  const dupText = ((dupMsg && dupMsg.content) || []).map((c) => (c && c.text) || '').join('\n')
  const savedPaths = dupText.split('\n').filter((l) => l.startsWith('已保存到：'))
    .map((l) => l.slice('已保存到：'.length))
  ok(savedPaths.length === 2 && new Set(savedPaths).size === 2 && savedPaths.every((p) => existsSync(p)),
    '★★★ 同名双附件 ⇒ 两份各自落盘、路径互异且真实存在（旧链同秒覆盖＝只 1 份/两条回执同路径＝必红）'
    + '｜本轮新增 ' + JSON.stringify(namesOf().filter((n) => !beforeDup.has(n))))
  ok(resourceDownloads.some((r) => /file_v3_dup_b\?type=file/.test(String(r.url))),
    '★★ 第二个附件真的发了下载请求（不是被跳过）')

  // 🔴 第四十八轮 LOW#3（核对为真）：命令分支**不消费 textRendered**（只吃锚点剥出的 cmd），
  //   /plan、/goal 起回合时还走 skipSend 连正文都不重投 ⇒ post 的落盘说明在命令通道两头都不露
  //   ＝#65 的"静默丢附件"从命令口复发。修复＝命令受理时补一条**可见文字回执**。
  // 🔴 第四十九轮 MEDIUM#1（核对为真，两处收紧）：
  //   ① 回执有**两个**调用点（真机事件入口 dispatchParsedInbound ＋ 内部入口 handleInbound），
  //      本格要钉的契约是"不许双发"⇒ 断言必须是**精确计数 1**，`.some()` 在双发时照样绿。
  //   ② `/help` 不起回合 ⇒ 内部入口那条腿（`handleInbound(…, outcome.turnStarted)`）从没被驱动
  //      ＝双发面整条没演。改用 `/plan <正文>`（夹具 planEnabled 开着、本代用例 43 同款桩），
  //      让命令真的起回合 ⇒ commandHold 置位 ⇒ 那条腿真的走到（走到但**不许**再发一次回执）。
  {
    const mkCmd48 = sentCards.length
    const beforeCmd48 = new Set(namesOf())
    const prevExec49 = fakeCommands.execute
    const prevIdle49 = agent.whenIdle
    agent.whenIdle = async () => {}
    // 与用例 43 同款：模拟 harness 在 execute 内部把正文投进会话并**起了真回合**（开始产出）。
    agentEvents.push({
      type: 'assistant/message', seq: 9601,
      data: { message: { content: [{ type: 'text', text: '命令回合-49' }] } },
    })
    fakeCommands.execute = async () => ({ result: { text: 'Plan mode on. Use /plan off to leave.' } })
    feedInboundRaw('om_post_cmd65', 'post', {
      title: '',
      content: [[{ tag: 'text', text: '/plan 带附件起回合' },
        { tag: 'file', file_key: 'file_v3_cmd65', file_name: '命令附表.xlsx' }]],
    })
    await settle(2)
    fakeCommands.execute = prevExec49
    agent.whenIdle = prevIdle49
    ok(namesOf().filter((n) => !beforeCmd48.has(n)).some((n) => n.endsWith('_命令附表.xlsx')),
      '★★★ 命令+附件的 post ⇒ 附件照样落盘（这条旧字节也成立，是本格的后半截前提）')
    // （前提）这一格确实走到了"命令起回合 ⇒ 落回内部入口"那条腿：起了回合才会有过程卡。
    ok(cardsSince(mkCmd48).some((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0'),
      '★★（前提）/plan 起了真回合（有过程卡）⇒ 内部入口那条腿真的被驱动，下面那条计数才有靶心')
    const receipts49 = cardsSince(mkCmd48).filter((c) => c.op === 'create'
      && c.payload && !c.payload.schema
      && JSON.stringify(c.payload).includes('命令附表.xlsx')
      && JSON.stringify(c.payload).includes('已保存到'))
    ok(receipts49.length === 1,
      '★★★ 命令通道**只发一次**可见落盘回执（两个入口共用一函数 + commandHold 防双发；'
      + '把守卫拆掉＝2 张＝必红）｜实到 ' + receipts49.length)
  }

  // 🔴 第四十九轮 MEDIUM#2（核对为真）：刹车豁免原来只被"空队列发 /stop"（用例 41）演过 ⇒
  //   豁免支与普通支**可观察结果相同**，把 isBrake 恒写成 false 全套照样绿。补真积压一格：
  //   附件下载挂在半路（夹具 resourceSlow 开关）时同拍发刹车，刹车必须**先**被派发；
  //   同时被排队的那条不能被丢（豁免＝插队，不是丢弃）。
  // 🔴 第四十九轮 LOW（index.js:6543）：豁免面同时收窄到与 handleCommand 的闸门豁免**同一清单**
  //   （/stop、/plan off、/goal 无参、/goal pause）——本格的刹车用 /goal pause 演，
  //   正好钉住"两套判据并存"这个洞（只认 /stop 时这条必红）。
  {
    const cmdLines49 = []
    const prevExec49b = fakeCommands.execute
    // 记录"命令注册表真的收到了哪一行"＝刹车有没有被派发的可观察出口（/goal 的子命令
    //   全部由注册表实现，index.js:3961 一带；不靠 agent.cancel——pause 不调它）。
    fakeCommands.execute = async (_agent, line) => {
      cmdLines49.push(String(line))
      return { result: { text: '目标已暂停' } }
    }
    const beforeBrake = new Set(namesOf())
    resourceSlowKey = 'file_v3_brake84'
    resourceSlowMs = 800
    try {
      // 同一拍塞两条：①带附件的 post（下载挂在半路，占住尾队列）②刹车命令
      feedInboundRaw('om_post_brake_084', 'post', {
        title: '',
        content: [[{ tag: 'text', text: '带慢附件的消息' },
          { tag: 'file', file_key: 'file_v3_brake84', file_name: '慢表.xlsx' }]],
      })
      feedInbound('om_goalpause_brake_084', '/goal pause')
      // 🔴 r45 首跑红在**我自己的判别格**（不是被测代码）：夹具的定时器只有 `intervals`
      //   被调用时才推进（见 `drain()` 的实现），单 `setTimeout` 干等 250ms 一个拍都没跑
      //   ⇒ 两条事件根本没被读走，"刹车已派发"当然量不到。改成**先走一拍**（两条同拍读走：
      //   post 起挂死的下载、刹车当拍派发），再等一小段真实时间（200ms < 800ms 下载延迟，
      //   此刻下载确实还在飞）做判定。
      for (const fn of intervals) fn()
      await new Promise((r) => setTimeout(r, 200))
      ok(cmdLines49.some((l) => l === '/goal pause'),
        '★★★ 附件下载挂在半路时 `/goal pause` **照常立即派发**（刹车走尾队列豁免；'
        + '旧判据只认 /stop ⇒ 这条排在下载后＝此刻还没下发＝必红）｜实到 '
        + JSON.stringify(cmdLines49))
      ok(!namesOf().some((n) => !beforeBrake.has(n) && n.endsWith('_慢表.xlsx')),
        '★★（前提）此刻那次下载**还没完成**（尾队列确实被占住，上一条绿得才有靶心）')
      await settle(4)
      ok(namesOf().filter((n) => !beforeBrake.has(n)).some((n) => n.endsWith('_慢表.xlsx')),
        '★★ 慢下载完成后附件照常落盘、排队那条照常派发（豁免只让刹车插队，不丢队列消息）')
    } finally {
      resourceSlowKey = ''
      resourceSlowMs = 0
      fakeCommands.execute = prevExec49b
    }
  }

  // 🔴 第四十八轮 LOW#1（核对为真）：post 附件把派发推到异步 ⇒ **同一拍里后到的普通消息先派发**
  //   （提问挂着时，带附件的真回答被后到的普通文字抢先消费＝答案错挂到人头上）。
  //   修复＝真机入站按 bot 排一条到达顺序尾队列（/stop 这类刹车豁免，保持"随叫随到"）。
  //   判据取"谁回答了提问卡"——这是这条乱序唯一会在真机上咬人的形状；
  //   🔴 r42 自查：第一版按 agent.sent 相邻两个下标比顺序是**错的**（本会话是空转桩，
  //   回合无输出会重建会话重试同一条 ⇒ 相邻两条其实是同一条消息，量不到顺序）。
  {
    const qMark48 = sentCards.length
    emitCtx('tools/execute', {
      name: 'ask_user_question', agent,
      arguments: { questions: [{
        id: 'q-order-084', question: '这一轮要哪一种口径？',
        options: [{ label: '口径甲' }, { label: '以上都不选，我直接回复文字' }],
      }] },
      signal: undefined,
    }, () => {})
    await settle(2)
    const before48 = new Set(namesOf())
    // 两条塞进**同一拍** output（drain 一次全读）＝复现"同批乱序"的靶心
    feedInboundRaw('om_post_order_084', 'post', {
      title: '',
      content: [[{ tag: 'text', text: '带表回答甲' },
        { tag: 'file', file_key: 'file_v3_order84', file_name: '顺序表.xlsx' }]],
    })
    feedInbound('om_text_order_084', '插队的普通消息')
    await settle(3)
    const win48 = JSON.stringify(cardsSince(qMark48))
    ok(win48.includes('带表回答甲') && win48.indexOf('插队的普通消息') === -1,
      '★★★ 同批两条 ⇒ 带附件的那条按**到达顺序**先派发并由它回答提问'
      + '（旧字节后到的先派发＝提问被插队那条吃掉＝必红）')
    ok(namesOf().filter((n) => !before48.has(n)).some((n) => n.endsWith('_顺序表.xlsx')),
      '★★ 排队这条的附件也真的落了盘（不是靠跳过下载蒙过去的顺序）')
    ok(consoleLines.some((l) => String(l).indexOf('question answered via chat') >= 0),
      '★★ 提问确实是在这条会话里被文字回答的（不是超时/别的路径，判据才有靶心）')
  }

  // 🔴 第四十九轮 MEDIUM#3（核对为真）：排队里的下载**没有超时** ⇒ 一次挂死把该 bot 整条
  //   入站管线堵在队列头（普通消息/提问回答/插话/除刹车外的命令全等）。修法＝有界窗口
  //   （默认 15 秒，`DSH_FEISHU_ATT_DOWNLOAD_MS` 可调，同款先例见 DSH_FEISHU_SPLIT_MIN_MS）。
  //   本格把窗口压到 400ms、让下载挂 1500ms ⇒ 必须看到"诚实的⚠️超时说明 + 队列照常放行"；
  //   回退掉 withDownloadBail 这条必红（那时超时说明压根不出现，第二条也排在挂死下载后面）。
  {
    const sentBeforeBail = agent.sent.length
    const logBeforeBail = consoleLines.length
    process.env.DSH_FEISHU_ATT_DOWNLOAD_MS = '400'
    resourceSlowKey = 'file_v3_hang84'
    resourceSlowMs = 1500
    try {
      // 同一拍两条：①带"挂死"附件的 post ②紧跟一条普通消息（判队列有没有被堵住）
      feedInboundRaw('om_post_hang_084', 'post', {
        title: '',
        content: [[{ tag: 'text', text: '挂死下载甲' },
          { tag: 'file', file_key: 'file_v3_hang84', file_name: '挂死表.xlsx' }]],
      })
      feedInbound('om_after_hang_084', '挂死之后的第二条')
      await settle(2)
      const winBail = agent.sent.slice(sentBeforeBail)
        .map((m) => ((m && m.content) || []).map((c) => (c && c.text) || '').join('\n')).join('\n')
      ok(winBail.includes('挂死下载甲') && winBail.includes('没有返回'),
        '★★★ 下载挂死 ⇒ 有界窗口给出**诚实的⚠️超时说明**并照常放行本条（静默等下去＝必红）'
        + '｜实得片段 ' + JSON.stringify(winBail.slice(0, 90)))
      ok(winBail.includes('挂死之后的第二条'),
        '★★ 挂死没堵住尾队列：后到的普通消息照样派发（头阻塞已解）')
      ok(consoleLines.slice(logBeforeBail).some((l) => String(l).includes('inbound file download timed out')),
        '★★ 超时在日志留痕（标记与证据锁同一行，判"确实在超时那条支路"）')
    } finally {
      delete process.env.DSH_FEISHU_ATT_DOWNLOAD_MS
      resourceSlowKey = ''
      resourceSlowMs = 0
    }
  }

  // 🔴 第五十轮 LOW#5（核对为真）：去重的"认领"在下游 handleInbound/steer，而 0.8.4 把派发推到
  //   下载**之后** ⇒ 只窥"已认领"盖不住"第一份还在下载"这个窗口，重投的第二份照样再下一遍
  //   （多一份 -2 重复文件＋误导的 `inbound file saved` 日志）。修法＝入队即登记在飞标记。
  //   本格把**同一个 message_id** 的 post 在同一拍喂两份（第一份下载挂在半路）⇒
  //   第二份必须在入口被判重丢弃、那个 file_key 只能被请求一次、盘上只能有一份文件。
  //   （把判据退回成只窥 `inboundAlreadySeen` ⇒ 本格的三条全红。）
  {
    const beforeRedel = new Set(namesOf())
    const dlKey = 'file_v3_redel84'
    const dlBefore = dlCountOf(dlKey)
    const logBeforeRedel = consoleLines.length
    resourceSlowKey = dlKey
    resourceSlowMs = 700
    try {
      // 同一拍两条**同 message_id** 的事件＝长连接 at-least-once 的重投形状
      feedInboundRaw('om_post_redel_084', 'post', {
        title: '',
        content: [[{ tag: 'text', text: '重投的带表消息' },
          { tag: 'file', file_key: dlKey, file_name: '重投表.xlsx' }]],
      })
      feedInboundRaw('om_post_redel_084', 'post', {
        title: '',
        content: [[{ tag: 'text', text: '重投的带表消息' },
          { tag: 'file', file_key: dlKey, file_name: '重投表.xlsx' }]],
      })
      for (const fn of intervals) fn()
      await new Promise((r) => setTimeout(r, 200))   // 200ms < 700ms：第一份确实还在下载里
      ok(consoleLines.slice(logBeforeRedel).some((l) => String(l).includes('duplicate inbound skipped (pre-download)')),
        '★★ 重投在**入口**就被丢（留痕与下游判重同一口径）')
      await settle(3)
      // 🔴 r46 自查（M4 变异自己抓出来的恒过形状）：「只请求一次」原来在 200ms 那个取样点上
      //   判——可**没有在飞标记时第二份也才被排进尾队列、还没轮到下载**，那一刻同样只有 1 次
      //   请求 ⇒ 拆掉标记它照样绿。判"有没有重复下载"必须等**队列排空**之后再数，
      //   和下面"盘上只有一份"同一个取样点（同格共用窗口＝陷阱 20 的同族）。
      ok(dlCountOf(dlKey) === dlBefore + 1,
        '★★★ 挂死的下载窗口里，重投**没有**再下一遍（该 file_key 排空后仍只多一次请求）'
        + '｜实增 ' + (dlCountOf(dlKey) - dlBefore))
      const redelFiles = namesOf().filter((n) => !beforeRedel.has(n) && n.includes('重投表'))
      ok(redelFiles.length === 1,
        '★★★ 盘上只有一份（旧形状会落出 -2 重复文件）｜实得 ' + JSON.stringify(redelFiles))
      // 🔴 第五十一轮 MEDIUM#2（核对为真）：标记原来在任务 `finally` 里"派发完就撤"——可
      //   `dispatchParsedInbound` 只把 handleInbound **排进链**（命令支/提问支根本不排），
      //   认领在更晚才落地（甚至永不落地）⇒ 撤早了的那段窗口里的重投照样漏网。改判据＝
      //   标记**跟着认领走**（`isDuplicateInbound` 认领时才撤；派发支自己抛错才撤；外加 TTL 兜底）。
      //   驱动形状专挑**命令**：`/help` 起不了回合、永远走不到认领 ⇒ "派发完≠认领完"这段窗口被演实。
      const cmdKey = 'file_v3_redel84b'
      const cmdDlCount = () => resourceDownloads.filter((r) => String(r.url).includes(cmdKey)).length
      const cmdDlBefore = cmdDlCount()
      const beforeCmdRedel = new Set(namesOf())
      const logBeforeCmdRedel = consoleLines.length
      resourceSlowKey = cmdKey
      resourceSlowMs = 300
      const cmdPost = () => feedInboundRaw('om_post_cmdredel_084', 'post', {
        title: '',
        content: [[{ tag: 'text', text: '/help 命令重投' },
          { tag: 'file', file_key: cmdKey, file_name: '命令重投表.xlsx' }]],
      })
      cmdPost()
      await settle(3)                       // 第一份：下载完＋派发完（命令支**不会**认领）
      ok(cmdDlCount() === cmdDlBefore + 1,
        '★★（前提）第一份只下了一次并已派发完——下面量的正是"此后"来的重投')
      cmdPost()
      await settle(3)
      const cmdFiles = namesOf().filter((n) => !beforeCmdRedel.has(n) && n.includes('命令重投表'))
      ok(cmdFiles.length === 1 && cmdDlCount() === cmdDlBefore + 1,
        '★★★ 认领从未发生的窗口里，后来的重投**仍然被入口丢掉**（标记跟着认领撤，不是"派发完就撤"）'
        + '｜文件 ' + cmdFiles.length + ' 份、请求 +' + (cmdDlCount() - cmdDlBefore) + ' 次')
      ok(consoleLines.slice(logBeforeCmdRedel).some((l) => String(l).includes('duplicate inbound skipped (pre-download)')),
        '★★ 这一发判重同样留痕（两处以同一口径判"确实在入口丢的"）')
    } finally {
      resourceSlowKey = ''
      resourceSlowMs = 0
    }
  }

  // 🔴 第四十八轮 LOW#2（核对为真）：外层 catch 原来与共享核的 catch **逐字重复**，而那个核
  //   自己已带 catch ⇒ 外层唯一可达的异常只有正文不是合法 JSON。收窄后这条支路要有判别：
  //   喂一条 `content` 坏了的 file 消息 ⇒ 必须回"我没能处理的附件消息"，且不崩整轮。
  {
    const sentBefore48c = agent.sent.length
    fakeProc.output += JSON.stringify({
      type: 'event',
      eventType: 'im.message.receive_v1',
      data: {
        message: {
          message_id: 'om_file_badcontent_084',
          message_type: 'file',
          chat_id: CHAT_ID,
          chat_type: 'p2p',
          content: '{这不是合法JSON',
        },
        sender: { sender_id: { open_id: 'ou_test' } },
      },
    }) + '\n'
    await settle(2)
    const bodyBad48 = ((agent.sent[sentBefore48c] && agent.sent[sentBefore48c].content) || [])
      .map((c) => (c && c.text) || '').join('\n')
    ok(bodyBad48.includes('我没能处理的附件消息'),
      '★★ 正文解析失败也走**同一条**可见回执（外层 catch 收窄到解析步，文案单源）'
      + '｜实得 ' + JSON.stringify(bodyBad48.slice(0, 60)))
  }
}

console.log('50) 静默看门狗：提示必须**有诊断含义**（CM 2026-10-03：「我以为你一直在做事」）')
{
  // ⚠️ 本条**必须排在热重载用例之前**：那个用例会把已注册的 ctx.effect cleanup 全跑一遍
  //    （模拟卸载）⇒ 之后**没有任何 watcher 还活着**（第一版排后面，日志里 0 条 buildCardPayload，
  //    断言全绿不了也说明不了问题）。
  // 让这一轮"挂住"（whenIdle 不返回）⇒ 卡保持 running，才走得到静默分支
  let release
  const gate = new Promise((r) => { release = r })
  const prevIdle = agent.whenIdle.bind(agent)
  agent.whenIdle = () => gate
  const logMark = consoleLines.length
  feedInbound('om_stall_watchdog', '看门狗用例')
  await drain()
  ok(consoleLines.slice(logMark).some((l) => l.includes('card created')), '（前提）这一轮建了卡')

  const realNow = Date.now
  const before = sentCards.length
  Date.now = () => realNow() + 6 * 60 * 1000      // 假装已静默 6 分钟（这期间没有任何新事件）
  await drain()
  const slice = JSON.stringify(sentCards.slice(before))
  ok(slice.includes('没有回包'), '★ 零动作静默 6 分钟 ⇒ 卡面写「上游已 N 分钟没有回包」（不是含糊的"无新动作"）')
  ok(slice.includes('不是卡片坏了'), '★ 并写明"不是卡片坏了"（CM：我不知道你在干什么）')
  ok(!slice.includes('还在跑'), '（反例）没有误报成"工具还在跑（正常）"')
  const plain = cardsSince(before).filter((c) => c.op === 'create' && c.payload && !c.payload.schema).length
  ok(plain >= 1, '★ 另发了一条**纯文本**提示（新消息才会提醒，不只是悄悄改卡上一行）')
  ok(consoleLines.slice(logMark).some((l) => l.includes('stall notice sent')), '并留痕 `stall notice sent`')

  // 再跑一轮：每轮只发一次（不刷屏）
  const before2 = sentCards.length
  await drain()
  const plain2 = cardsSince(before2).filter((c) => c.op === 'create' && c.payload && !c.payload.schema).length
  ok(plain2 === 0, '同一轮不重复发（每轮只提示一次）')

  Date.now = realNow
  release()
  agent.whenIdle = prevIdle
  await drain()
}

console.log('55) ★ 同 agent 只允许一个 watcher：新卡注册时必须停掉同 agent 的旧 watcher 并把旧卡收口')
{
  // 真机症状（本机 web.log L78520-78548，CM 2026-10-03 报障「换了新卡，旧卡也一直在更新」）：
  //   热重载"续卡"之后旧卡的 watcher 还在跑，再来一条入站又会开一张新卡 ⇒ 两个 watcher 扫**同一条**
  //   事件流 ⇒ 两张卡内容同步长（0c26bbb3 与 09c6d978 游标 5405→5406→…→5445）。
  // ⚠️ 为什么**不**用"回合进行中插一条文件消息"来复现：入站挂在 `bot.chain` 上**串行**执行
  //   （index.js L3985 `bot.chain = bot.chain.then(() => handleInbound(...))`），首轮被 gate 住时
  //   第二条入站**根本轮不到** ⇒ 永远建不出第二张卡（cycle2/3/4 三次实测都是 `create 次数 1`）⇒ 那种夹具必假红。
  //   所以改用**确定性构造**：直接把"同 agent 的旧卡 + 旧 watcher"放进**跨代接管登记表**
  //   （真机里它就是热重载接管的那张卡），再让一条普通入站建新卡 ⇒ 新 watcher 注册时必须处理掉它。
  const reg = globalThis.__fsLiveCards
  ok(reg && typeof reg.set === 'function' && Boolean(agent && agent.id),
    '（前提）跨代接管登记表挂在 globalThis、且 harness agent 有 id')
  const zombie = {
    token: 'om_zombie55',
    blocks: [{ type: 'message', text: '旧卡正文' }, { type: 'message', text: '正在工作中…' }],
    tools: new Map(),
    seenSeqs: new Set(),
    status: 'running',
    bornSeq: 1,          // 故意比新卡小 ⇒ "更晚创建的是新卡"成立
    cursor: 0,
  }
  let stopped55 = false
  reg.set(String(agent.id), {
    agent,
    card: zombie,
    bot: { cfg: { appId: APP_ID }, chats: new Map() },
    chatId: CHAT_ID,
    stop: () => { stopped55 = true },
  })
  const logMark55 = consoleLines.length
  const mark55 = sentCards.length
  agent.send = function (message) { this.sent.push(message) }
  feedInbound('om_two_watcher_b', '新入站（应把同 agent 的旧卡顶掉）')
  await settle(3)
  ok(createsSince(mark55).length >= 1, '（前提）新入站建出了新卡（create 次数 ' + createsSince(mark55).length + '）')
  const window55 = consoleLines.slice(logMark55)
  ok(window55.some((l) => l.includes('stale watcher stopped: agent=')),
    '★ 留痕 `stale watcher stopped`（不静默 —— 本文件口径）')
  // 0.7.13（TODO-0710 #1）：留痕必须带 **born=<旧bornSeq>/<新bornSeq>** —— token 要首次 sync 成功才有，
  //   真机 web.log L80023 打出 `old=- new=-` ＝ 查不到是哪两张卡。bornSeq 建卡即有、跨代单调。
  const bornLine55 = window55.find((l) => l.includes('stale watcher stopped: agent=') && /born=[0-9]+\/[0-9]+/.test(l))
  ok(Boolean(bornLine55),
    '★ 留痕带 born=<旧bornSeq>/<新bornSeq>（建卡即有，不依赖 token 同步）实际：'
    + (bornLine55 ? bornLine55.slice(-110) : '❌ 无 born 字段'))
  ok(stopped55 === true, '★ 同 agent 的旧 watcher 真的被停掉（它的 stop() 被调用 ⇒ clearInterval）')
  ok(zombie.status === 'sealed', '★ 旧卡被就地收口（status=sealed ⇒ 不再继续长）')
  ok(zombie.blocks.some((b) => b.text && b.text.includes('本卡已收口')),
    '★ 旧卡留了一行「本卡已收口，后续内容见下方新卡」')
  ok(!zombie.blocks.some((b) => b.text === '正在工作中…'),
    '★ 旧卡上的「正在工作中…」占位符被摘掉（与 MED#7095 同源要求）')
  reg.delete(String(agent.id))
}

console.log('56) ★ 0.7.9 P1：状态栏一行只有一个模式位（CM ①）')
{
  let release56
  const gate56 = new Promise((r) => { release56 = r })
  const prevIdle56 = agent.whenIdle
  agent.whenIdle = () => gate56
  agent.send = function (message) { this.sent.push(message) }
  const mark56 = sentCards.length
  feedInbound('om_mode_slot', '状态栏模式位测试')
  await settle(3)
  // 0.7.10（独立审查 MED#3201 修正）：**必须先放行闸门让回合收口** —— 运行中的过程卡是
  // `footerMode='bare'`，页脚只渲染 statusTextFor(card)（本来就只有**一个**模式位），
  // 而"两个模式位"只出现在**完整页脚**（收口后才渲染）⇒ 旧写法在**未修复版上也会通过**（空断言）。
  release56()
  agent.whenIdle = prevIdle56
  await settle(4)
  const body56 = JSON.stringify(cardsSince(mark56))
  ok(!body56.includes('目标模式 · 未启用'),
    '★ 无目标时不再出现「🎯 目标模式 · 未启用」（CM ①：普通模式与目标模式共存）')
  // ⚠️ 口径必须精确（0.7.10 自查修正）：**不能**在整张卡上数「目标模式」的次数 —— 目标轮的过程卡
  //   **标题**本来就是 `🎯 目标模式 · 第 N 轮…`，与状态栏的模式位是**设计内的两处**（两张卡就 4 次）
  //   ⇒ 旧写法会把"正常"判成"回归"（**假红**：上一轮 GREEN 就是这么被我自己的断言判红的）。
  //   CM ① 的真正形状是：**同一个文本元素里**出现两个模式词
  //   （例：`🧭 普通模式 · 运行中  ｜  🎯 目标模式 · 未启用` 或 `🎯 目标模式 · 运行中  ｜  🎯 目标模式 · 已激活…`）。
  const badElems56 = []
  const walk56 = (n) => {
    if (!n || typeof n !== 'object') return
    if (typeof n.content === 'string' && (n.content.match(/目标模式/g) || []).length > 1) badElems56.push(n.content.slice(0, 90))
    for (const k of Object.keys(n)) { const v = n[k]; if (v && typeof v === 'object') walk56(v) }
  }
  for (const c of cardsSince(mark56)) walk56(c.payload)
  ok(badElems56.length === 0,
    '★ 没有任何**单个文本元素**里出现两个「目标模式」（CM ① 的真正形状）实际 ' + badElems56.length + ' 处'
    + (badElems56.length ? '：' + badElems56[0] : ''))
  ok(!body56.includes('目标模式 · 已暂停') && !body56.includes('目标模式 · 已阻塞'),
    '★ 目标短语不再自带「目标模式」前缀（否则与模式位重复）')
  await settle(2)
}

console.log('57) ★ 0.7.9 P2：过程卡不许丢字；结论卡不许夹带过程叙述（CM ②）')
{
  let release57
  const gate57 = new Promise((r) => { release57 = r })
  const prevIdle57 = agent.whenIdle
  agent.whenIdle = () => gate57
  let seq57 = 13000
  const mark57 = sentCards.length
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: ++seq57, data: { message: { content: [{ type: 'text', text: '过程叙述-ALPHA-过程' }] } } })
    agentEvents.push({ type: 'tool/call', seq: ++seq57, data: { callId: 'c57', name: 'probe57', arguments: '{}' } })
    agentEvents.push({ type: 'tool/result', seq: ++seq57, data: { message: { source: { callId: 'c57' }, content: [{ type: 'text', text: 'ok' }] } } })
    agentEvents.push({ type: 'assistant/message', seq: ++seq57, data: { message: { content: [{ type: 'text', text: '最终答复-BETA-结论' }] } } })
  }
  feedInbound('om_p2_keep', 'P2 过程卡不丢字')
  await settle(4)
  release57()
  agent.whenIdle = prevIdle57
  await settle(3)

  const ops57 = cardsSince(mark57)
  const body57 = JSON.stringify(ops57)
  ok(body57.includes('过程叙述-ALPHA-过程'),
    '★ 过程卡仍能看到**工具调用之前**的叙述（CM ②「过程卡全部文字突然消失」）')
  ok(body57.includes('最终答复-BETA-结论'), '最终答复也在卡上（内容没丢）')
  const groups57 = []
  for (const c of ops57) {
    if (c.op === 'create' && c.payload && c.payload.schema === '2.0') groups57.push([])
    if (groups57.length) groups57[groups57.length - 1].push(JSON.stringify(c.payload || {}))
  }
  const last57 = groups57.length ? groups57[groups57.length - 1].join('') : ''
  ok(groups57.length <= 1 || !last57.includes('过程叙述-ALPHA-过程'),
    '★ 结论卡（本轮最后一张）**不夹带**过程叙述（实际 ' + groups57.length + ' 张卡）')
  // 0.7.10（独立审查 LOW#3244 修正）：原句只是上面两条的**合取**（永不独立失败）⇒ 换成新增覆盖：
  ok(groups57.length <= 2,
    '★ 本轮**真卡片 ≤2**（过程卡 + 结论卡；不再多出第 3 张）实际 ' + groups57.length)

  // 0.7.10（审查 MED#3799 的回归钉）：长回复（>500 字）**不许在过程卡上重复出现** ——
  // 镜像 note 会被 clipNoteText 处理（截断 + 补 … + 可能补回目的行），旧实现按"整段相等"判重必然失配。
  {
    let release57b
    const gate57b = new Promise((r) => { release57b = r })
    const prevIdle57b = agent.whenIdle
    agent.whenIdle = () => gate57b
    const mark57b = sentCards.length
    const longText = 'LONGMARK-开头-' + 'X'.repeat(700) + '-LONGMARK-结尾'
    agent.send = function (message) {
      this.sent.push(message)
      agentEvents.push({ type: 'assistant/message', seq: ++seq57, data: { message: { content: [{ type: 'text', text: longText }] } } })
    }
    feedInbound('om_p2_long', 'P2 长回复不重复')
    await settle(4)
    release57b()
    agent.whenIdle = prevIdle57b
    await settle(3)
    // ⚠️ 口径必须精确（0.7.10 自查修正）：**不能跨窗口计数** —— 旧实现是"**同一张卡上**出现两次"，
    //   而"两张卡各一次"在窗口计数里同样是 2 ⇒ 断言会**永不失败**（我第一版就是这么写的，自查时改掉）。
    //   正确判据：取**这张卡的最后一次 payload**（每次 PATCH 都发全量元素列表），在其中数出现次数。
    const ops57b = cardsSince(mark57b).filter((c) => c.payload && c.payload.schema === '2.0')
    const last57b = ops57b.length ? JSON.stringify(ops57b[ops57b.length - 1].payload) : ''
    const hits57b = (last57b.match(/LONGMARK-开头/g) || []).length
    ok(hits57b <= 1,
      '★ 长回复（>500 字）不许在**同一张卡的最后形态**里出现两次（实际 ' + hits57b + ' 次；旧实现过程卡会重复）')
  }
}

console.log('57c) ★ 0.7.11 HIGH：短回复（<120 字）整段已在卡上 ⇒ 收口不得整段重追加')
{
  let release57c
  const gate57c = new Promise((r) => { release57c = r })
  const prevIdle57c = agent.whenIdle
  agent.whenIdle = () => gate57c
  let seq57c = 14100
  const mark57c = sentCards.length
  const shortReply = 'SHORTMARK-短旁白整段已展示-收尾'
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: ++seq57c, data: { message: { content: [{ type: 'text', text: shortReply }] } } })
  }
  feedInbound('om_p2_short', 'P2 短回复不重复')
  await settle(4)
  release57c()
  agent.whenIdle = prevIdle57c
  await settle(3)
  // 口径（§10.8）：**同一张卡的最后一次 payload** 里数出现次数 —— 跨窗口计数永不失败
  const ops57c = cardsSince(mark57c).filter((c) => c.payload && c.payload.schema === '2.0')
  const last57c = ops57c.length ? JSON.stringify(ops57c[ops57c.length - 1].payload) : ''
  const hits57c = (last57c.match(/SHORTMARK-短旁白整段已展示-收尾/g) || []).length
  ok(hits57c === 1,
    '★ 短回复（<120 字）整段已在卡上恰好出现一次（实际 ' + hits57c + ' 次；0.7.10 的 120 阈值把「整段已在」判死）')
}

console.log('57d) ★ 0.7.11 MED：空白折叠后归一化长度≠原文长度 ⇒ 不得按归一化长度切原文')
{
  let release57d
  const gate57d = new Promise((r) => { release57d = r })
  const prevIdle57d = agent.whenIdle
  agent.whenIdle = () => gate57d
  let seq57d = 14200
  const mark57d = sentCards.length
  // 甲段 99 字符 + 45 个换行 + 乙段 39 字符 = 原文 183；归一化 139（45 换行折叠成 1 空格，省 44）
  // 0.7.10 的 bug：shownChars=139（归一化长度）直接切原文 ⇒ slice(139) 把乙段整段重吐一遍。
  const paraA = 'BLANKTAIL-MARKER-甲-' + 'P'.repeat(80)
  const paraB = 'BLANKTAIL-MARKER-乙-' + 'Q'.repeat(20)
  const blankReply = paraA + '\n'.repeat(45) + paraB
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: ++seq57d, data: { message: { content: [{ type: 'text', text: blankReply }] } } })
  }
  feedInbound('om_p2_blank', 'P2 空行回复不重复')
  await settle(4)
  release57d()
  agent.whenIdle = prevIdle57d
  await settle(3)
  const ops57d = cardsSince(mark57d).filter((c) => c.payload && c.payload.schema === '2.0')
  const last57d = ops57d.length ? JSON.stringify(ops57d[ops57d.length - 1].payload) : ''
  const hits57d = (last57d.match(/BLANKTAIL-MARKER-乙/g) || []).length
  ok(hits57d === 1,
    '★ 含空行的已展示回复恰好出现一次、不重吐尾部（实际 ' + hits57d + ' 次）')
}

console.log('57e) ★ 0.7.11 MED：clipNoteText 把被截掉的目的行【前置】到 note 开头 ⇒ 必须剥掉再算公共前缀')
{
  let release57e
  const gate57e = new Promise((r) => { release57e = r })
  const prevIdle57e = agent.whenIdle
  agent.whenIdle = () => gate57e
  let seq57e = 14300
  const mark57e = sentCards.length
  // smoke 28 同款形状作为**回复**：正文 600+ 字（必被 500 截断）、🎯 目的行在末尾（被切掉 ⇒ 前置到 note 开头）
  // 0.7.10 的 bug：note 以 🎯 开头 ⇒ 公共前缀=0 ⇒ 整段重追加；修后还须保证目的行不随尾部二次出现。
  const longReply = 'PURPMARK-正文开头-' + 'X'.repeat(600) + '\n🎯 目的行在末尾-壹'
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: ++seq57e, data: { message: { content: [{ type: 'text', text: longReply }] } } })
  }
  feedInbound('om_p2_purpose', 'P2 目的行前置不重复')
  await settle(4)
  release57e()
  agent.whenIdle = prevIdle57e
  await settle(3)
  const ops57e = cardsSince(mark57e).filter((c) => c.payload && c.payload.schema === '2.0')
  const last57e = ops57e.length ? JSON.stringify(ops57e[ops57e.length - 1].payload) : ''
  const hits57e = (last57e.match(/PURPMARK-正文开头-/g) || []).length
  ok(hits57e === 1,
    '★ 目的行前置形状恰好出现一次、不整段重追加（实际 ' + hits57e + ' 次）')
  const hits57eP = (last57e.match(/🎯 目的行在末尾-壹/g) || []).length
  ok(hits57eP === 1,
    '★ 已在卡上的目的行恰好出现一次（实际 ' + hits57eP + ' 次）')
}

console.log('60) ★ 0.7.13 TODO#2：回合末尾恰好是工具调用 ⇒ 仍开结论卡（答复不退回过程卡）')
{
  // 形状：叙述 → 工具 → 答复 → 工具（**末尾是工具**）。0.7.12 的反向扫描在第一个工具处 break
  //   ⇒ spokenBlocks 空 ⇒ narrationOnlyTurn ⇒ 不拆结论卡（0.7.13 修：先跳过末尾连续工具）。
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'
  let release60
  const gate60 = new Promise((r) => { release60 = r })
  const prevIdle60 = agent.whenIdle
  agent.whenIdle = () => gate60
  let seq60 = 15000
  const mark60 = sentCards.length
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push(
      { type: 'assistant/message', seq: ++seq60, data: { message: { content: [{ type: 'text', text: '过程叙述-TAILTOOL-甲' }] } } },
      { type: 'tool/call', seq: ++seq60, data: { callId: 'c60a', name: 'probe60a', arguments: '{}' } },
      { type: 'tool/result', seq: ++seq60, data: { message: { source: { callId: 'c60a' }, content: [{ type: 'text', text: 'ok' }] } } },
      { type: 'assistant/message', seq: ++seq60, data: { message: { content: [{ type: 'text', text: '最终答复-TAILTOOL-乙' }] } } },
      { type: 'tool/call', seq: ++seq60, data: { callId: 'c60b', name: 'probe60b', arguments: '{}' } },
      { type: 'tool/result', seq: ++seq60, data: { message: { source: { callId: 'c60b' }, content: [{ type: 'text', text: 'done' }] } } },
    )
  }
  feedInbound('om_p2_tailtool', 'P2 末尾工具回合')
  await settle(4)
  release60()
  agent.whenIdle = prevIdle60
  await settle(3)
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  const groups60 = []
  for (const c of cardsSince(mark60)) {
    if (c.op === 'create' && c.payload && c.payload.schema === '2.0') groups60.push([])
    if (groups60.length) groups60[groups60.length - 1].push(JSON.stringify(c.payload || {}))
  }
  const last60 = groups60.length ? groups60[groups60.length - 1].join('') : ''
  ok(groups60.length >= 2,
    '★ 末尾带工具的回合仍拆出结论卡（实际 ' + groups60.length + ' 张卡；0.7.12 会退回单卡）')
  ok(last60.includes('最终答复-TAILTOOL-乙'), '★ 结论卡带最终答复')
  ok(!last60.includes('过程叙述-TAILTOOL-甲'), '★ 结论卡不夹带过程叙述（只取最后一段连续叙述）')
}

console.log('58) ★ 0.7.9 P6：非文本入站（转发卡片）不许静默丢弃（CM：转发卡片没反应）')
{
  const markRich = sentCards.length
  feedInboundRaw('om_card_rich', 'interactive', {
    header: { title: { content: '卡片标题-Z' } },
    elements: [{ tag: 'markdown', content: '卡片正文-GAMMA' }],
  })
  await settle(3)
  const fedRich = JSON.stringify(agent.sent)
  ok(fedRich.includes('卡片正文-GAMMA') || fedRich.includes('卡片标题-Z'),
    '★ 卡片里的文字被抠出来喂给了模型（不再零反应）')
  // 0.7.10（独立审查 LOW#3250 修正）：markRich 原本声明后**从未使用**（死变量）⇒ 接一条真断言：
  ok(cardsSince(markRich).length > 0, '★ 卡片消息也走卡片通道（有可见产出），不是零反应')
  ok(consoleLines.some((l) => l.includes('inbound rich message salvaged') && l.includes('chat=')),
    '★ 留痕 inbound rich message salvaged 且带 chat/message_id')

  const markEmpty = sentCards.length
  feedInboundRaw('om_card_empty', 'interactive', {})
  await settle(3)
  const bodyEmpty = JSON.stringify(cardsSince(markEmpty))
  ok(bodyEmpty.includes('非文本') || bodyEmpty.includes('读不到') || bodyEmpty.includes('没有我能读'),
    '★ 抠不到文字时**回一条可见提示**（绝不静默）')
  ok(consoleLines.some((l) => l.includes('inbound dropped visible') && l.includes('message_id=')),
    '★ 留痕 inbound dropped visible 且带 chat/message_id（可事后对上是谁发的）')
}

console.log('59) ★ 0.7.9 P5：11310（表格/元素超限）不再"通知+抢救+换卡"三连（CM：卡片乱发）')
{
  rejectPatches = 1
  rejectPatchesBody = { code: 230099, msg: 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit' }
  const mark59 = sentCards.length
  let seq59 = 14000
  agent.send = function (message) {
    this.sent.push(message)
    // 必须让本轮**有输出**：否则会走"会话自愈重试"（heal）路径，重试各自建卡 ⇒ create 计数不可判定
    // （0.7.9 实测：不加这一句时本轮 create=6，其中多张来自 heal 重试，与卡片路径无关）。
    agentEvents.push({ type: 'assistant/message', seq: ++seq59, data: { message: { content: [{ type: 'text', text: 'P5 超限回合的答复' }] } } })
  }
  feedInbound('om_11310', 'P5 表格超限')
  await settle(4)
  const body59 = JSON.stringify(cardsSince(mark59))
  ok(!body59.includes('卡片发送失败'),
    '★ 11310 不再发用户可见的「卡片发送失败」提示（正文已由抢救纯文本送达）')
  // ⚠️ 判据修正（0.7.9 实测）：smoke 的 mock 把**纯文本消息**也记成 op='create'（payload 不是卡片 schema）
  //   ⇒ 必须只数**真卡片**（payload.schema === '2.0'），否则会把"抢救纯文本 / 兜底纯文本"当成卡片，断言失真。
  const creates59 = cardsSince(mark59).filter((c) => c.op === 'create')
  const cards59 = creates59.filter((c) => c.payload && c.payload.schema === '2.0')
  const texts59 = creates59.filter((c) => !(c.payload && c.payload.schema === '2.0'))
  ok(cards59.length <= 2, '★ 本轮**真卡片** ≤2（实际 ' + cards59.length + ' 张 —— 旧实现是"通知+抢救+换卡"三连）')
  ok(texts59.length <= 2, '★ 纯文本 ≤2 条（抢救正文 + 兜底；不再多一条"卡片发送失败"）实际 ' + texts59.length)
  ok(consoleLines.some((l) => l.includes('card failure notice skipped')),
    '★ 留痕 card failure notice skipped（11310 被正确归成 toolarge）')
  rejectPatches = 0
  rejectPatchesBody = null
}

console.log('51) 热重载打断会话 ⇒ 必须在会话里说清（CM 2026-10-02：0.4.22 之后这条提示没了）')
{
  const activeTurns = globalThis.__fsActiveTurns
  ok(Boolean(activeTurns) && typeof activeTurns.set === 'function',
    '（前提）活跃回合表挂在 globalThis 上（跨代际，新实例看得见）')
  // (a) 旧实例 dispose 侧：重载那一刻有回合在跑 ⇒ 必须留下"待播报"线索
  activeTurns.set('fs-main-reloadtest', {
    bot: { cfg: { appId: APP_ID }, chats: new Map() },
    chatId: CHAT_ID,
    card: { token: 'om_reload_card' },
    split: null,
  })
  globalThis.__fsReloadHint = null
  for (const cleanup of effectCleanups) {
    try { cleanup() } catch { /* 卸载钩子里有别的副作用，这里只关心线索 */ }
  }
  const hint = globalThis.__fsReloadHint
  ok(Boolean(hint) && Array.isArray(hint.items) && hint.items.length === 1,
    '重载前把"可能被中断的回合"登记下来（' + ((hint && hint.items) ? hint.items.length : 0) + ' 条）')
  ok(Boolean(hint) && hint.items[0] && hint.items[0].sessionId === 'fs-main-reloadtest'
    && hint.items[0].chatId === CHAT_ID, '登记的是**那个会话**（sessionId + chatId 都对）')
  ok(consoleLines.some((l) => l.includes('登记 1 个可能被中断的回合')), '旧实例留痕（可日志复验）')
  activeTurns.delete('fs-main-reloadtest')

  // (b) 新实例侧：apply 时读线索 ⇒ 往那个会话发一条说明，且每会话只提示一次
  globalThis.__fsReloadHint = {
    at: Date.now(),
    items: [{ sessionId: 'fs-main-reloadtest', chatId: CHAT_ID, appId: APP_ID }],
  }
  const before = sentCards.length
  const mod2 = await import('../index.js')
  mod2.apply(ctx)
  await drain()
  await drain()
  const texts = sentCards.slice(before).map((c) => JSON.stringify(c.payload))
  // 0.7.20（CM 下令删掉假消息注入）：提示必须**按真实状态**说话。
  //   这一条用的 sessionId `fs-main-reloadtest` **不在** liveAgents 里（真 agent 已不在本实例）
  //   ⇒ 应当走 `no-agent` 分支：如实说"没有接管"，**不许**再谎称"上一轮被打断、我已让它接着做"。
  ok(texts.some((t) => t.includes('热重载')),
    '★ 重载后在该会话发了提示（不再静默）')
  ok(texts.some((t) => t.includes('没有接管')),
    '★ agent 不在本实例 ⇒ 如实说"没有接管"（旧文案无条件说"我已自动让它接着做"=假话）')
  ok(!texts.some((t) => t.includes('我已自动让它接着做')),
    '★ 不再承诺"自动让它接着做"（那条假消息已被删除）')
  ok(!JSON.stringify(agent.sent).includes('插件刚热重载'),
    '★★ **没有**向 agent 注入假的用户消息（CM 报障②：幻影回合的根源）')
  ok(consoleLines.some((l) => l.includes('hot reload interrupt notice') && l.includes('state=no-agent')),
    '留痕带**状态**（`state=` 可判定走的是哪条分支）')
  const notified = globalThis.__fsReloadNotified
  ok(Boolean(notified) && typeof notified.has === 'function' && notified.has('fs-main-reloadtest'),
    '记下"这个会话已提示过"（第二次重载不会重复刷屏）')

  // (c) 幂等：同样的线索再来一次 ⇒ 不再发第二条
  const before2 = sentCards.length
  globalThis.__fsReloadHint = {
    at: Date.now(),
    items: [{ sessionId: 'fs-main-reloadtest', chatId: CHAT_ID, appId: APP_ID }],
  }
  const mod3 = await import('../index.js')
  mod3.apply(ctx)
  await drain()
  await drain()
  const texts2 = sentCards.slice(before2).map((c) => JSON.stringify(c.payload))
  ok(!texts2.some((t) => t.includes('热重载')), '同一个会话不会提示第二遍（幂等）')
}

console.log('52) 审批单卡通道（feishu_approval_form）：工具 / 版式 / 点击 / stale / 超时 / 适配（2026-10-03 任务）')
{
  // ⚠️ 取**第一次**注册的那个工具（第一代）。原因：冒烟的 `drain()` 会把**所有代际**的轮询回调
  //    都跑一遍，而注入的 helper 事件总是由**排在最前的第一代**消费 ⇒ 处理卡片点击的是第一代的
  //    `handleCardAction`，token 也只可能在第一代的 `pendingForms` 里。用别的代际的工具就会出现
  //    "卡发出去了、点击却 record not found"（本用例第一版就踩了这个，白等 4 秒）。
  const formTool = toolNow('feishu_approval_form')
  ok(Boolean(formTool), 'feishu_approval_form 工具已注册')
  ok(Boolean(formTool) && typeof formTool.execute === 'function', '工具有 execute')
  // 任何一步没走通都不许把整套用例挂死：给工具结果加一个"很短"的观察窗口
  const settle = (p, ms) => Promise.race([
    p,
    new Promise((r) => setTimeout(() => r({ ok: false, choice: '', timedOut: false, cardId: '', detail: '（还没结算：' + ms + 'ms 内没等到点击/超时）' }), ms)),
  ])

  // 30 分钟的定时器拦下来手动触发（不然用例要等半小时）——只拦这一个时长，其余 setTimeout 照跑
  const origSetTimeout = globalThis.setTimeout
  const formTimers = []
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === 30 * 60 * 1000) { formTimers.push(fn); return 0 }
    return origSetTimeout(fn, ms, ...rest)
  }

  const formArgs = {
    title: '身份标签变更单 · 曹伟轩',
    meta: [
      { label: '单号', value: 'BG-2026-1003-01' },
      { label: '变更类型', value: '身份标签（数据域收窄）' },
      { label: '置信度', value: '0.86' },
      { label: '证据来源', value: '企微通讯录 + 三季度汇报' },
    ],
    categories: [
      { text: '财经：L2 → L2（不变）', change: 'same' },
      { text: '数据域：全量 → 财务（收窄）', change: 'narrow' },
    ],
    skills: [{ text: '台账回填', change: 'add' }, { text: '舆情抓取', change: 'remove' }],
    evidence: ['他三季度只报财务口径', '通讯录显示岗位为财务分析'],
    impact: ['能看到财务域全量台账'],
    risk: ['继续用旧标签 ⇒ 他看到不完整数据'],
    chatId: CHAT_ID,
  }
  // ⚠️ 夹具时序（第一版踩了）：前面用例 38/39 改写过配置（还写过别的 appId），
  //    而 `bot.cfg`/`bots` 是**每 10 秒热读一次**才回填 ⇒ 这里必须先等过热读节拍，
  //    否则 `findBotForChat(CHAT_ID)` 解析不到 bot（日志特征：`approval form target: ... bot=no`）。
  await new Promise((r) => setTimeout(r, 11000))
  await drain()
  const mark = sentCards.length
  const pendingForm = Promise.resolve()
    .then(() => formTool.execute(formArgs, { agent, signal: undefined }))
    .catch((e) => ({ ok: false, choice: '', timedOut: false, cardId: '', detail: 'THREW: ' + String(e && e.message || e) }))
  await drain()
  const formCard = lastCardFrom(mark)
  if (!formCard) {
    // 失败也要把**原因**打出来（否则只能猜）——等一个很短的时间看工具返回了什么
    const probe = await Promise.race([
      pendingForm,
      new Promise((r) => setTimeout(() => r({ detail: '（工具还在等点击，说明卡其实发了但没被 lastCardFrom 认出来）' }), 300)),
    ])
    ok(false, '审批单卡已发出 —— 实际：' + JSON.stringify(probe))
  } else {
    ok(true, '审批单卡已发出')
  }
  const fp = (formCard && formCard.payload) || {}
  ok(fp.schema === '2.0' && Boolean(fp.header) && fp.header.template === 'blue', '卡头＝蓝色')
  ok(JSON.stringify((fp.header && fp.header.title) || '').includes('身份标签变更单 · 曹伟轩'), '卡头带人名的标题')
  const fEls = ((fp.body && fp.body.elements) || [])
  const fieldDiv = fEls.find((e) => e.tag === 'div' && Array.isArray(e.fields))
  // 2026-10-03 CM 真机反馈：短值并排（单号 + 置信度）；长值各占一行（变更类型 / 证据来源）
  ok(Boolean(fieldDiv) && fieldDiv.fields.length === 2
    && fieldDiv.fields.every((f) => f.is_short === true),
    '短值两列并排：只有 单号 + 置信度 进 fields 区且 is_short=true（实际 '
      + (fieldDiv ? fieldDiv.fields.length : 0) + ' 个）')
  const divText = JSON.stringify((fieldDiv && fieldDiv.fields) || [])
  ok(!divText.includes('身份标签（数据域收窄）') && !divText.includes('企微通讯录'),
    '长文本**没有**被塞进双列框里')
  const longRows = fEls.filter((e) => e.tag === 'markdown' && /^\*\*.+\*\*\n/.test(String(e.content || '')))
  ok(longRows.some((e) => String(e.content).includes('变更类型') && String(e.content).includes('身份标签（数据域收窄）')),
    '「变更类型」这类长文本**单独一行**')
  ok(longRows.some((e) => String(e.content).includes('证据来源') && String(e.content).includes('企微通讯录')),
    '「证据来源」这类长文本**单独一行**')
  const flat = JSON.stringify(fEls)
  ok(['①', '②', '③', '④', '⑤'].every((n) => flat.includes(n)),
    '五个分区标题都在（①~⑤）')
  ok(!flat.includes('⑥ 操作'), '不再有「⑥ 操作」这行标题（CM 2026-10-03：「这几个文本不需要」）')
  ok(flat.includes('🔹') && flat.includes('🔸'), '① 用 🔹/🔸 区分「不变 / 收窄」')
  ok(flat.includes('➕') && flat.includes('➖'), '② 用 ➕/➖ 表示新增/取消')
  ok(flat.includes('> 他三季度只报财务口径'), '③ 证据渲染成引用块')
  ok(fEls.filter((e) => e.tag === 'hr').length >= 5, '分区之间有 hr 分隔（' + fEls.filter((e) => e.tag === 'hr').length + ' 条）')
  const actionRow = fEls.find((e) => e.tag === 'column_set')
  const actionBtns = ((actionRow && actionRow.columns) || []).map((c) => (c.elements || [])[0])
  ok(Boolean(actionRow) && actionRow.flex_mode === 'bisect', '操作行＝两列等分（bisect）')
  ok(actionBtns.length === 2, '★ **只有两个按钮**：采纳 / 驳回（实际 ' + actionBtns.length + ' 个）')
  ok(Boolean(actionBtns[0]) && actionBtns[0].type === 'primary'
    && Boolean(actionBtns[1]) && actionBtns[1].type === 'danger',
    '★ 按钮**带色**：采纳=primary(蓝) / 驳回=danger(红)')
  ok(actionBtns.every((b) => b && b.text && (b.text.content === '✅ 采纳' || b.text.content === '❌ 驳回')),
    '按钮文案就是 采纳 / 驳回（没有第三个「我要改」）')
  ok(actionBtns.every((b) => b && b.behaviors && b.behaviors[0].value.fs_form !== undefined
    && b.behaviors[0].value.fs_choice !== undefined), '两个按钮都带 { fs_form, fs_choice }')
  const formToken = actionBtns[0].behaviors[0].value.fs_form
  ok(consoleLines.some((l) => l.includes('approval form sent:') && l.includes('token=' + formToken)),
    '留痕 `approval form sent`（可日志复验）')

  // 点击「采纳」⇒ 工具拿到选择 + 卡就地变回执卡
  const decideMark = sentCards.length
  await tapValue(actionBtns[0].behaviors[0].value)
  const decided = await settle(pendingForm, 4000)
  ok(decided && decided.ok === true && decided.choice === '采纳', '★ 点「采纳」⇒ 工具结果拿到 choice=采纳（' + JSON.stringify(decided && decided.choice) + '）')
  ok(decided && decided.timedOut === false && String(decided.cardId || '').length > 0, '工具结果带 cardId 且非超时')
  const receipt = sentCards.slice(decideMark).filter((c) => c.op === 'update').pop()
  const rp = (receipt && receipt.payload) || {}
  const rpText = JSON.stringify(rp)
  // J（2026-10-03 CM）：「审批卡是特殊的存在，点了以后**不应该把旧的内容清掉**，
  //   就应该把**两个按钮那个位置**变成'你已经审批过了'」⇒ 三条断言锁死这个语义。
  ok(rpText.includes('你已经审批过了：采纳'), '★ 按钮那一行换成了「你已经审批过了：采纳」')
  ok(rpText.includes('身份标签变更单') && rpText.includes('变更类型') && rpText.includes('① 类别'),
    '★ **正文全部保留**（标题 + 长文本字段 + 分区①都还在 —— 不再整卡变两行回执）')
  const receiptBtns = []
  for (const el of ((rp.body && rp.body.elements) || [])) {
    if (el && el.tag === 'action') {
      for (const a of (el.actions || [])) if (a && a.tag === 'button') receiptBtns.push(a)
    }
    if (el && el.tag === 'button') receiptBtns.push(el)
    for (const col of ((el && el.columns) || [])) {
      for (const ce of (col && col.elements) || []) if (ce && ce.tag === 'button') receiptBtns.push(ce)
    }
  }
  ok(receiptBtns.length === 0, '★ 点完后**不再有任何按钮**（实际 ' + receiptBtns.length + ' 个）')
  ok(rp.header && rp.header.template === 'green', '采纳 ⇒ 回执卡头绿色')
  ok(consoleLines.some((l) => l.includes('approval form decided:') && l.includes('-> 采纳')), '留痕 `approval form decided`')

  // stale 点击（同一张卡再点一次）：**不许静默**，必须一条可见提示
  const staleMark = sentCards.length
  await tapValue(actionBtns[0].behaviors[0].value)
  const staleText = JSON.stringify(sentCards.slice(staleMark))
  ok(staleText.includes('已经处理过了') || staleText.includes('已过期'), '★ 旧卡再点 ⇒ 可见提示（不是静默 no-op）')
  ok(consoleLines.some((l) => l.includes('form button: record not found')), '并留痕 `form button: record not found`')

  // 超时（30 分钟）：可见告知 + 卡变超时态 + 工具结果 timedOut
  const mark2 = sentCards.length
  formTimers.length = 0          // 只认本用例自己那个定时器（前面那条早被点击结算掉了）
  const pendingTimeout = formTool.execute(Object.assign({}, formArgs, { title: '超时用例单' }), { agent, signal: undefined })
  await drain()
  ok(formTimers.length >= 1, '捕获到 30 分钟定时器（' + formTimers.length + ' 个）')
  const fireTimeout = formTimers.pop()
  if (typeof fireTimeout === 'function') fireTimeout()
  const timedOut = await settle(pendingTimeout, 4000)
  ok(timedOut && timedOut.timedOut === true && timedOut.choice === '', '★ 超时 ⇒ 工具结果 timedOut=true（choice 为空）')
  const timeoutText = JSON.stringify(sentCards.slice(mark2))
  ok(timeoutText.includes('自动作废'), '★ 超时**可见地**说明（纯文本 + 卡面都写了"自动作废"）')
  ok(timeoutText.includes('（超时未操作）'), '超时后卡面也换成超时态')

  globalThis.setTimeout = origSetTimeout

  // askUserQuestion 适配通道：questions[0].card ⇒ 直接渲染审批单卡，回答按 question-answer 形状回传
  //
  // ⚠️ 夹具坑（第一版就踩了）：`findChatForAgent` 跨代际**只认「会话 id == agent id」**这条
  //    （生产实测两者同为 `fs-main-*`，且会话 id 已落盘 ⇒ 重载后照样认得出）。而冒烟的假 agent
  //    id 是 `agent-smoke-1`、会话 id 是 `fs-main-*`，只有"活 handle"那条路能匹配 —— 用例 50
  //    重载过两代之后 handle 早没了 ⇒ 日志「no chat owner for agent agent-smoke-1, delegating」
  //    ⇒ 根本没有卡。这里按生产的形态传 id（用**已落盘的会话 id**），验的才是插件逻辑。
  const adaptAgentId = createdSessionIds[createdSessionIds.length - 1] || agent.id
  const adaptAgent = { id: adaptAgentId, ctx: agentCtx }
  const questions = [{
    id: 'approval-1',
    question: '身份标签变更：是否采纳？',
    options: [{ label: '采纳' }, { label: '驳回' }, { label: '改' }],
    card: { title: '身份标签变更单 · 曹伟轩（适配通道）', meta: [{ label: '单号', value: 'BG-2' }], categories: [{ text: '财经 L2 → L2', change: 'same' }] },
  }]
  const mark3 = sentCards.length
  const r = emitCtx('user-questions/request', { questions, agent: adaptAgent, signal: undefined }, () => Promise.resolve('next'))
  await drain()
  const adaptCard = lastCardFrom(mark3)
  ok(JSON.stringify((adaptCard && adaptCard.payload) || {}).includes('身份标签变更单 · 曹伟轩（适配通道）'),
    '★ askUserQuestion 带 card 字段 ⇒ 走审批单卡（不是"文字 + 选它"简卡）')
  const adaptBtns = allButtons(adaptCard)
  ok(adaptBtns.length === 2 && adaptBtns[0].type === 'primary' && adaptBtns[1].type === 'danger',
    '适配通道的卡也是两个带色按钮（采纳/驳回，实际 ' + adaptBtns.length + ' 个）')
  await tapValue(adaptBtns[1].value)
  // 多个代际都挂在同一条水位线上（用例 50 重载过），`r[0]` 可能是"交回下一个"那条 ⇒
  // 从**所有**返回值里挑出真正带 answers 的那个（这才是接管成功的那条）。
  const allReturns = await Promise.all((r || []).map((x) => settle(x, 4000)))
  const answered = allReturns.find((x) => x && x.answers) || allReturns[0]
  ok(answered && answered.answers && answered.answers[0] && answered.answers[0].selected
    && answered.answers[0].selected[0] === '驳回',
    '★ 适配通道点「驳回」⇒ 按 question-answer 形状回传 selected=[驳回]（实际：' + JSON.stringify(answered) + '）')

  // 护栏：非飞书会话 + 没给 chatId ⇒ 明确报错，绝不瞎发
  const foreign = await formTool.execute({ title: '不该发出去的单' }, { agent: { id: 'agent-not-feishu' }, signal: undefined })
  ok(foreign && foreign.ok === false && String(foreign.detail).includes('不是飞书会话'),
    '★ 非飞书会话 ⇒ 明确报错（不瞎发到别人的会话）')

  // ---- 泛化通道（0.6.2）：`sections` 用**任意**审批单，标题自动补 ①~⑩
  const mark4 = sentCards.length
  const genericPromise = formTool.execute({
    title: '权限申请单 · 通用形态',
    meta: [{ label: '申请单号', value: 'REQ-2026-1' }, { label: '紧急度', value: 'P1' }],
    sections: [
      { title: '申请内容', lines: ['开通「财务域」只读'] },
      { title: '理由', lines: ['季度对账需要'] },
      { title: '不会越权的地方', lines: ['不改数据、不外发'] },
    ],
    chatId: CHAT_ID,
  }, { agent, signal: undefined })
  await drain()
  const genericCard = lastCardFrom(mark4)
  const gp = JSON.stringify((genericCard && genericCard.payload) || {})
  ok(gp.includes('① 申请内容') && gp.includes('② 理由') && gp.includes('③ 不会越权的地方'),
    '★ 泛化 `sections` ⇒ 任意审批单，标题自动补 ①~③（不必套"类别×L档"那套）')
  ok(gp.includes('开通「财务域」只读') && gp.includes('REQ-2026-1'), '泛化段内容与短字段原样上卡')
  const genericBtns = allButtons(genericCard)
  ok(genericBtns.length === 2 && genericBtns[0].type === 'primary' && genericBtns[1].type === 'danger',
    '泛化卡同样是两个带色按钮（采纳/驳回）')
  await tapValue(genericBtns[0].value)          // 别让这张卡挂着没人点
  await settle(genericPromise, 4000)

  // ---- 开关（0.6.2）：approvalForm 关掉 ⇒ 工具**明确拒绝** + 适配通道**回退**普通提问卡
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{
      name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
      reactionEmoji: 'GLANCE', approvalForm: false, planEnabled: true, goalEnabled: true,
    }],
  }, null, 2))
  await new Promise((r) => setTimeout(r, 11000))   // 等过热读节拍（bot.cfg 每 10 秒重读一次）
  await drain()
  // 注意：这里必须显式给 chatId —— 否则先撞"不是飞书会话"那条护栏（本用例要把闸门压到开关这一层）
  const refused = await formTool.execute({ title: '关掉开关后不该发', chatId: CHAT_ID }, { agent, signal: undefined })
  ok(refused && refused.ok === false && String(refused.detail).includes('没打开审批单通道'),
    '★ approvalForm=false ⇒ 工具**明确拒绝**（不发卡，并给出"怎么打开"的一句话）—— 实际：' + JSON.stringify(refused))
  ok(consoleLines.some((l) => l.includes('approval form refused')), '并留痕 `approval form refused`')

  const mark5 = sentCards.length
  const q2 = [{
    id: 'plain-1', question: '普通提问（开关关掉后）',
    options: [{ label: '甲' }, { label: '乙' }],
    card: { title: '关掉后不该走审批单卡' },
  }]
  emitCtx('user-questions/request', { questions: q2, agent: adaptAgent, signal: undefined }, () => Promise.resolve('next'))
  await drain()
  const fallbackCard = lastCardFrom(mark5)
  const fbText = JSON.stringify((fallbackCard && fallbackCard.payload) || {})
  ok(fbText.includes('选它') && !fbText.includes('关掉后不该走审批单卡'),
    '★ 开关关掉 ⇒ 带 `card` 的提问**回退**成普通提问卡（绝不误发审批单）')
}

console.log('53) F 失败可见 + G 上传：被拒必须「用户看得见 + Agent 收得到」；本地图片必须先换 image_key')
{
  const imgTool = toolNow('feishu_send')
  ok(Boolean(imgTool), '（前提）拿到 feishu_send 工具')
  // ⚠️ 夹具要点（踩过）：`feishu_send` 在**目标会话有活跃卡**时会**主动跳过**
  //    （设计如此：回复会自动进卡片，别另发一条）⇒ 返回 ok:true 但**没有真发**，
  //    于是上传根本不会被触发。这里用一个"没有活跃卡"的会话，才走得到真发送。
  const FREE_CHAT = 'oc_smoke_nocard_001'

  // ---- G：正文里的本地图片 ⇒ 先上传换 key（飞书**只认 img_key**；本地路径会**整张卡被拒**）
  const gMark = sentCards.length
  // 独立审查 HIGH#1：TEMP 是 Windows 专有 ⇒ CI(ubuntu) 上会拼出**相对路径**，
  // LOCAL_IMAGE_RE 认不出、G 用例必红。用 tmpdir() 才是跨平台绝对路径。
  // 审查 LOW#3375：夹具放进**本次运行独有**的目录（原先共享 tmpdir + 固定文件名 ⇒ 两次运行会撞车、
  // 异常退出还会把 id_rsa.png 留在共享 temp 里）。
  const fixtureDir = mkdtempSync(join(tmpdir(), 'fs-smoke-fix-'))
  const picPath = join(fixtureDir, 'fs-smoke-pic.png')
  writeFileSync(picPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  // 审查 MED#3293：同上，工具没注册时要"干净地判红"，不能抛 TypeError
  const gOut = imgTool
    ? await imgTool.execute({
      text: '把这张图发我 ![示意图](' + picPath + ')',
      chatId: FREE_CHAT,
    }, { agent, signal: undefined })
    : { ok: false, missing: true, detail: '（feishu_send 未注册）' }
  await drain()
  ok(imageUploads.length >= 1, '★ 本地图片**触发了上传**（POST /open-apis/im/v1/images）')
  const gText = JSON.stringify(sentCards.slice(gMark).map((c) => c.payload))
  ok(gText.includes('img_v3_smoke_key'), '★ 卡里换成了**真 `image_key`**（图片才会显示）')
  ok(!gText.includes('fs-smoke-pic.png'), '★ 卡里**不再有本地文件名**（否则整张卡会被飞书拒）')
  ok(gOut && gOut.ok === true, '（工具侧）发卡成功 ⇒ Agent 拿到 ok')
  ok(consoleLines.some((l) => l.includes('image uploaded')), '上传留痕 `image uploaded`')

  // ---- G-文件（审查 MED#1410：uploadFile/sendFileMessage 曾是**死代码**、文件那半边根本没接线）
  //      本地**文件**链接 ⇒ 上传换 file_key ⇒ 作为**文件消息**发出 ⇒ 卡里只留一句"已发送"
  const docPath = join(fixtureDir, 'fs-smoke-doc.pdf')
  writeFileSync(docPath, Buffer.from('%PDF-1.4\n% smoke fixture\n'))
  const fileMark = sentCards.length
  const fileUpBefore = fileUploads.length
  const gFileOut = imgTool
    ? await imgTool.execute({ text: '报告在 [季度报告.pdf](' + docPath + ')', chatId: FREE_CHAT },
      { agent, signal: undefined })
    : { ok: false, missing: true, detail: '（feishu_send 未注册）' }
  await drain()
  ok(Boolean(imgTool) && fileUploads.length > fileUpBefore,
    '★ 本地文件**触发了上传**（POST /open-apis/im/v1/files）')
  ok(Boolean(imgTool)
    && sentCards.slice(fileMark).some((c) => JSON.stringify(c.payload || {}).includes('file_v3_smoke_key')),
    '★ 作为**文件消息**真的发出去了（file_key 到位）')
  ok(gFileOut && gFileOut.ok === true, '（工具侧）文件发送成功 ⇒ Agent 拿到 ok')
  // 审查 LOW#3330：文件那半边也要验"本地路径已从卡里抹掉"（否则整张卡会被飞书拒）
  ok(!JSON.stringify(sentCards.slice(fileMark).map((c) => c.payload)).includes('fs-smoke-doc.pdf'),
    '★ 卡里**不再有本地文件路径**（否则整张卡会被飞书拒）')

  // ---- 安全闸回归（审查 HIGH#2）：凭证/密钥类路径**绝不外传**
  const upBefore = fileUploads.length + imageUploads.length
  const sensitiveMark = sentCards.length   // 审查 LOW#3344：断言要用**自己那段**窗口，别复用 fileMark
  // 审查 MED#3331：原来指向一个**不存在**的 Windows 路径 ⇒ ENOENT 也会让它"绿"，挡不住 HIGH#2 回归。
  // 现在造一个**真实存在**、唯一拦截理由就是"名字触发安全闸"的夹具（PNG 文件头 + 敏感文件名）。
  const sensitivePic = join(fixtureDir, 'id_rsa.png')
  writeFileSync(sensitivePic, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (imgTool) {
    await imgTool.execute({
      text: '看看这个 ![k](' + sensitivePic + ')',
      chatId: FREE_CHAT,
    }, { agent, signal: undefined })
    await drain()
  }
  // 审查 LOW#3329：断言不能"没注册工具就静默跳过"（那样这个安全回归就白测了）
  ok(Boolean(imgTool) && (fileUploads.length + imageUploads.length) === upBefore,
    '★ 疑似凭证/密钥类路径**拒绝上传**（HIGH#2：堵死"任意本地文件外传"通道）')
  ok(JSON.stringify(sentCards.slice(sensitiveMark).map((c) => c.payload)).includes('疑似凭证'),
    '★ 而且**说清原因**（拒绝要可见，不静默）')

  // ---- F：连"兜底纯文本"都被拒 ⇒ ①留痕 ②**降级重试**（剥掉 markdown）③**把失败交回 Agent**
  const fMark = sentCards.length
  rejectPatches = 2                     // 第一次 + 降级重试都拒：模拟"这段就是发不出去"
  // 审查 MED#3297：这条(以及下面那条)调用原先没设防 ⇒ 工具没注册就抛 TypeError、
  // 整个用例块直接断掉、连最后的 SMOKE FAIL 汇总都看不到。
  const fOut = imgTool
    ? await imgTool.execute({
      text: '**这段会先被拒** ![图](http://example.com/x.png)',
      chatId: FREE_CHAT,
    }, { agent, signal: undefined })
    : { ok: false, missing: true, detail: '（feishu_send 未注册）' }
  await drain()
  ok(consoleLines.some((l) => l.includes('plain text send failed')), '★ 兜底失败**留痕**（不再静默）')
  ok(consoleLines.some((l) => l.includes('plain text degraded retry')), '★ 自动**降级重试**（剥掉 markdown 再发一次）')
  // 审查 LOW#3315：mock 在"判定被拒"**之前**就 push 了 ⇒ 上面那条恒真。
  // 用"新增条数 == 2"才能证明**两次尝试都发生了**（首次 + 降级重试）。
  ok(sentCards.slice(fMark).length === 2, '★ 降级重试确实又发了一次（两次尝试都计数，不是空转）')
  // 审查 LOW#3357：兜底对象带 missing 标记 ⇒ 这条负向断言不会因为"工具没注册"而假绿。
  ok(fOut && fOut.ok === false && fOut.missing !== true,
    '★ 两次都失败 ⇒ **工具把失败交回 Agent**（它不会以为发成功了就收工）：'
      + JSON.stringify(fOut && fOut.detail).slice(0, 90))

  // 审查 LOW#3314/#3375：夹具在本次运行独有的目录里，跑完整目录删掉（异常退出也不会污染共享 temp）。
  try { rmSync(fixtureDir, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
}
console.log('')
console.log('53) ★ 热重载"续卡"不得接管已经过期的卡（僵尸卡源头：协作信箱 CM-OFFICE 任务）')
{
  // 真机症状（协作信箱）：热重载接管了一张**早已不是该会话当前卡**的旧卡 ⇒ 它扫不到新事件、
  //   静默分钟数只涨不落 ⇒ 每 10 分钟往会话发一条"上游已经 N 分钟没有回包"（实际对话很活跃）。
  // 判据：同会话里**更早**的那张卡必须"封口而不接管"；**更新**的那张照常接管（不搞一刀切）。
  const reg = globalThis.__fsLiveCards
  ok(reg && typeof reg.set === 'function', '（前提）跨代接管登记表挂在 globalThis')
  const mkEntry = (agentId, token, bornSeq) => ({
    agent: { id: agentId },
    card: {
      token,
      blocks: [{ type: 'message', text: '旧卡正文 ' + token }],
      tools: new Map(),
      seenSeqs: new Set(),
      status: 'running',
      bornSeq,
      cursor: 0,
    },
    bot: { cfg: { appId: APP_ID }, chats: new Map() },
    chatId: CHAT_ID,
    stop: () => {},
  })
  reg.set('fs-main-zold', mkEntry('fs-main-zold', 'zzz-old1', 10))
  reg.set('fs-main-znew', mkEntry('fs-main-znew', 'zzz-new2', 20))
  const markZ = consoleLines.length
  const modZ = await import('../index.js')
  modZ.apply(ctx)
  await drain()
  const zLines = consoleLines.slice(markZ)
  ok(zLines.some((l) => l.includes('热重载续卡：跳过') && l.includes('zzz-old1')),
    '★ 更早的那张卡**不被接管**（封口而不是继续养着 ⇒ 从源头不产生会误报"没有回包"的僵尸卡）')
  ok(zLines.some((l) => l.includes('热重载续卡：接管') && l.includes('zzz-new2')),
    '（对照）同会话里**更新**的那张卡照常被接管（没有一刀切停掉接管）')
  ok(!zLines.some((l) => l.includes('热重载续卡：接管') && l.includes('zzz-old1')),
    '（反例）更早的那张绝不出现在"接管"日志里')
  reg.delete('fs-main-zold')
  reg.delete('fs-main-znew')
}

console.log('61) ★ 0.7.14 B3 总纲：过程卡与结论卡之间不许重复同一段文字（CM 指定 TASK v3）')
{
  // ① 先清场：case 52 的适配子段会留下**未回答的挂起问题**（user-questions/request）——
  //   纯文本入站会被 pendingQuestions 当成回答吃掉（第一次跑实测：61 的入站根本没到回合路径）。
  //   修法 = 先发一条一次性文本，把挂起问题按插件的**文本回答主路径**答掉（与卡上点击同效），
  //   settle 等那一轮收口，再开始本用例。无挂起时这条就是一条普通 Junk 回合，无害。
  feedInbound('om_b3_drain', '（清场：回答遗留问题）')
  await settle(4)
  // 形状：🎯 叙述 → 工具 → **长答复（>500 字，含截断点前后的标记）**。
  // 镜像 note 会被 clipNoteText 截成前 500 字 + … ⇒ 断言分两层：
  //   头标记（截断点之前）在未修复版会随 note 留在过程卡 ⇒ 红；
  //   尾标记（截断点之后）从未上过过程卡 ⇒ 只钉"结论卡完整性"。
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'
  const mark61 = sentCards.length
  let seq61 = 16000
  // 0.7.15（审查 MED#3942）：必须**真 >500 字** —— 头/尾各 400 ⇒ 镜像 note 被 clipNoteText
  // 截成前 500 + …（被截断的 note 不是原文前缀 ⇒ "搬走"仍须按 seq 命中 —— 原 191 字从未踩到该分支）。
  const head61 = 'REPLY61-头-' + 'H'.repeat(400)
  const tail61 = 'REPLY61-尾-' + 'T'.repeat(400)
  const longReply61 = head61 + '\n\n中段说明一句。\n\n' + tail61
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push(
      { type: 'assistant/message', seq: ++seq61, data: { message: { content: [{ type: 'text', text: '🎯 先去核对基线库，确认口径。' }] } } },
      { type: 'tool/call', seq: ++seq61, data: { callId: 'c61', name: 'probe61', arguments: '{}' } },
      { type: 'tool/result', seq: ++seq61, data: { message: { source: { callId: 'c61' }, content: [{ type: 'text', text: 'ok' }] } } },
      { type: 'assistant/message', seq: ++seq61, data: { message: { content: [{ type: 'text', text: longReply61 }] } } },
    )
  }
  feedInbound('om_b3_dup', 'B3 两卡不重复')
  await settle(4)
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  const groups61 = []
  for (const c of cardsSince(mark61)) {
    if (c.op === 'create' && c.payload && c.payload.schema === '2.0') groups61.push([])
    if (groups61.length) groups61[groups61.length - 1].push(JSON.stringify(c.payload || {}))
  }
  const proc61 = groups61.length ? groups61[0].join('') : ''
  const conc61 = groups61.length > 1 ? groups61[groups61.length - 1].join('') : ''
  ok(groups61.length >= 2, '（前提）拆出过程卡 + 结论卡（实际 ' + groups61.length + ' 张）')
  ok(conc61.includes('REPLY61-头-') && conc61.includes('REPLY61-尾-'),
    '★ 结论卡有**完整**结论（含 500 字截断点之后的尾段）')
  ok(!proc61.includes('REPLY61-头-'),
    '★ B3：过程卡**不含**结论段（连被截断的前缀都不许留 —— 0.7.13 会留 ⇒ 红）')
  ok(proc61.includes('🎯 先去核对基线库'),
    '★ B1：过程叙述（🎯 行）一条不少（"搬走结论段"不许碰到它）')
  await settle(2)
}

console.log('62) ★ 0.7.14 H3：热重载打断时旧实例不许封口推卡（"半截卡"根因）')
{
  // 复现（对应真机 web.log 18:39:32）：回合在跑 → HMR dispose（停 watcher、登记 interrupted）→
  // 回合收尾 ⇒ 0.7.13 的旧实例仍会 seal+push（用户多看到一张半截卡）。
  // 0.7.14：dispose 把活跃回合的卡登记进 __fsInterruptedCards，syncCard 头部命中即拦。
  let release62
  const gate62 = new Promise((r) => { release62 = r })
  const prevIdle62 = agent.whenIdle
  agent.whenIdle = () => gate62
  // 0.7.16（审查 MED#2）：**开启拆卡** —— 封口时旧代会 makeCardState **新建**结论卡并推送；
  // 那张新卡在 dispose 时还不存在 ⇒ 0.7.15 的按对象 WeakSet 拦不住它（审查指出的野卡漏洞）。
  // 开关使下面「新建的卡不许发出去」断言从恒真变可证伪：0.7.15 上必红、0.7.16 代际旗上转绿。
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'
  const mark62 = sentCards.length
  const logMark62 = consoleLines.length
  let seq62 = 17000
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({ type: 'assistant/message', seq: ++seq62, data: { message: { content: [{ type: 'text', text: '被重载打断的答复-62' }] } } })
  }
  feedInbound('om_h3_half', 'H3 半截卡')
  await settle(3)
  // 模拟 HMR dispose：逐个调 ctx.effect cleanup，直到看到"登记 … 个可能被中断的回合"
  // 0.7.15：**逐个跑完全部 cleanup**（不 break）—— 登记代可能 ≠ 封口代，只登记第一个代会漏拦；
  // dispose 可重复执行（已 splice 的列表再跑是空操作），对每一代都跑一遍才覆盖"谁在封口"。
  const markAdopt = sentCards.length
  const logAdopt = consoleLines.length
  for (const cleanup of effectCleanups) {
    try { cleanup() } catch { }
  }
  let disposed62 = consoleLines.slice(logMark62).some((l) => l.includes('dispose(热重载): 登记'))
  ok(disposed62, '（前提）dispose 已执行且登记了被中断的回合')
  // 0.7.15（审查 HIGH#1979）：新代（重新 apply）接管**同一张卡对象**后，它的 syncCard **不许**被拦
  // —— 0.7.14 的 globalThis Set 按对象记 ⇒ 新代也被拦、卡片冻结在「正在工作中…」（本断言在 0.7.14 必红）。
  // 0.7.15 fix (S10.8 observation surface): slice consoleLines with a consoleLines index (logMark62);
  // takeover log prints the internal id card=card_294 (create log has feishu token msg=om_card_294, strip om_ prefix).
  const tokM = consoleLines.slice(logMark62, logAdopt).join('\n').match(/card created[^\n]*msg=(\S+)/)
  const tok62 = tokM ? tokM[1] : ''
  // 0.7.16（审查 LOW#2）：接管日志打印 token.slice(-8) ⇒ 期望值同样取 slice(-8)
  //（去 om_ 前缀只在卡号 3 位时碰巧相等，4 位即假红）。
  const cid62 = tok62.slice(-8)
  const modA = await import('../index.js')
  modA.apply(ctx)
  await drain()
  await settle(2)
  const adoptLines = consoleLines.slice(logAdopt)
  ok(Boolean(tok62) && adoptLines.some((l) => l.includes('热重载续卡：接管') && l.includes('card=' + cid62)),
    '（前提）新代接管了同一张卡（热重载续卡：接管 + ' + (cid62 || 'id未取到') + '）')
  const skipAfterAdopt = adoptLines.filter((l) => l.includes('card sync skipped: generation disposed')).length
  ok(skipAfterAdopt === 0,
    '★ HIGH：新代接管的推送**不许**被拦（0.7.14 的 global Set 会拦 ⇒ skip=' + skipAfterAdopt + ' ⇒ 红）')
  ok(sentCards.slice(markAdopt).some((c) => c.op === 'update'),
    '★ HIGH：新代接管后对该卡产生了推送（update；0.7.14 被拦 ⇒ 无 ⇒ 红）')
  const markAfterDispose = sentCards.length
  release62()
  agent.whenIdle = prevIdle62
  await settle(3)
  ok(consoleLines.slice(logMark62).some((l) => l.includes('card sync skipped: generation disposed')),
    '★ H3：旧实例的封口推送被拦下（card sync skipped: generation disposed；0.7.13 无此拦截 ⇒ 红）')
  // 0.7.16（审查 MED#1 更正措辞）：旧断言的「都会出」是错的 —— 旧实例封口已建卡走 PATCH（update），
  // 这条只数 create ⇒ 本用例原夹具**不拆卡时恒真**（MED#2 的野卡要拆卡才出现）。
  // 现在本用例开拆卡（见上方 E1）⇒ dispose 后旧代要新建结论卡 ⇒ 0.7.15 必红、0.7.16 转绿。
  const createdAfterDispose = sentCards.slice(markAfterDispose).filter((c) => c.op === 'create')
  const rogueCreate = createdAfterDispose.filter((c) => !JSON.stringify(c).includes('被重载打断的答复-62'))
  // 0.7.22（交接清单#2）改判：旧口径是「dispose 之后新建的卡一律不许发出去」（无 token ⇒ 野卡）。
  //   新口径：**只有被显式登记为「待建」的结论卡**允许由活着的实例真建出来（结论卡形态不再永久丢），
  //   其余任何 dispose 后新建的卡仍然一张都不许有 ⇒ 野卡防线不降。
  ok(rogueCreate.length === 0,
    '★ MED#2：dispose 之后**非托孤**的新建卡一张都不许发出去（实际 ' + rogueCreate.length + ' 张）')
  ok(createdAfterDispose.filter((c) => c.msgId).length === 1,
    '★ 清单#2：托孤的结论卡由新代**真建出来**（不再是单卡降级丢形态；实际建成 '
    + createdAfterDispose.filter((c) => c.msgId).length + ' 张 / 尝试 ' + createdAfterDispose.length + ' 次）')
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  await settle(2)
}

console.log('63) ★ 0.7.17 stable 显示层：员工只看 状态+工具面板+结论（过程叙述/指路不渲染）')
{
  // CM 2026-10-03 拍板（10 问）：stable＝员工只看到「工作中」状态＋工具调用折叠面板（结果在内）＋结论卡；
  // 过程叙述/🎯 行/指路行一律不渲染。cfg.mode 走白名单归一化（漏加就被丢——splitConclusionMinMs 同坑）。
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{
      name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
      reactionEmoji: 'GLANCE', approvalForm: true, mode: 'stable',
    }],
  }, null, 2))
  // 0.7.19（审查 LOW#5）：原地等 10.5s 是**无效等待**——mock 的 interval 不自跑，cfg 真正
  // 生效靠下面 settle→drain 驱动的 ensureHelpers（每 tick 无条件 bot.cfg=cfg，≤500ms）。
  await settle(2)
  let release63
  const gate63 = new Promise((r) => { release63 = r })
  const prevIdle63 = agent.whenIdle
  agent.whenIdle = () => gate63
  let seq63 = 18000
  const mark63 = sentCards.length
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push(
      { type: 'assistant/message', seq: ++seq63, data: { message: { content: [{ type: 'text', text: '过程叙述-STABLE-甲' }] } } },
      { type: 'tool/call', seq: ++seq63, data: { callId: 'c63', name: 'probe63', arguments: '{}' } },
      { type: 'tool/result', seq: ++seq63, data: { message: { source: { callId: 'c63' }, content: [{ type: 'text', text: 'ok' }] } } },
      { type: 'assistant/message', seq: ++seq63, data: { message: { content: [{ type: 'text', text: '最终答复-STABLE-乙' }] } } },
    )
  }
  feedInbound('om_stable_display', 'stable 显示层测试')
  await settle(4)
  release63()
  agent.whenIdle = prevIdle63
  await settle(3)
  const ops63 = cardsSince(mark63).filter((c) => c.payload && c.payload.schema === '2.0')
  const last63 = ops63.length ? JSON.stringify(ops63[ops63.length - 1].payload) : ''
  ok(ops63.length >= 1, '（前提）建了卡（实际 ' + ops63.length + ' 张）')
  ok(last63.includes('最终答复-STABLE-乙'), '★ stable：结论照常显示（V2 结论卡一定出现）')
  ok(last63.includes('工具调用'), '★ stable：工具调用折叠面板保留（结果在内）')
  ok(!last63.includes('过程叙述-STABLE-甲'), '★ stable：过程叙述**不渲染**（0.7.16 无过滤 ⇒ 红）')
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
             reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true }],
  }, null, 2))
  await settle(2)
}

console.log('64) ★ 0.7.17 stable 门禁：/switch 被拒（CM：员工一个会话就够）')
{
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{
      name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
      reactionEmoji: 'GLANCE', approvalForm: true, mode: 'stable',
    }],
  }, null, 2))
  await settle(2)
  const mark64 = sentCards.length
  feedInbound('om_stable_switch', '/switch')
  await settle(4)
  const touched64 = sentCards.slice(mark64)
  ok(touched64.some((c) => JSON.stringify(c.payload || {}).includes('稳定版不支持')),
    '★ stable：/switch 被明确拒绝并提示（0.7.16 会照常出切换卡 ⇒ 红）')
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
             reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true }],
  }, null, 2))
  await settle(2)
}

console.log('65) ★ 0.7.17 群一律 stable＋三开关全关（C）：mode 配置即使缺省，群也降级')
{
  // 群判据 = 入站事件自带的 chat_type（不信 oc_ 前缀，2030）。cfg.mode 不写（=full），
  // 但 chat_type=group ⇒ 建卡必须判 stable ⇒ 过程叙述同样不渲染（RED 于 0.7.16）。
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{
      name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
      reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true,
    }],
  }, null, 2))
  await settle(2)
  const mark65 = sentCards.length
  let seq65 = 19000
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push(
      { type: 'assistant/message', seq: ++seq65, data: { message: { content: [{ type: 'text', text: '群叙述-GROUP65-甲' }] } } },
      { type: 'assistant/message', seq: ++seq65, data: { message: { content: [{ type: 'text', text: '群答复-GROUP65-乙' }] } } },
    )
  }
  fakeProc.output += JSON.stringify({
    type: 'event',
    eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: 'om_group65', message_type: 'text', chat_type: 'group',
        chat_id: 'oc_group65_test01', content: JSON.stringify({ text: '群里的验收消息' }),
        mentions: GROUP_MENTION,
      },
      sender: { sender_id: { open_id: 'ou_test' } },
    },
  }) + '\n'
  await settle(5)
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  const ops65 = cardsSince(mark65).filter((c) => c.payload && c.payload.schema === '2.0')
  const last65 = ops65.length ? JSON.stringify(ops65[ops65.length - 1].payload) : ''
  ok(ops65.length >= 1, '（前提）群消息建了卡（实际 ' + ops65.length + ' 张）')
  ok(last65.includes('群答复-GROUP65-乙'), '★ 群：答复照常显示')
  ok(!last65.includes('群叙述-GROUP65-甲'), '★ 群：过程叙述**不渲染**（群里一律 stable；0.7.16 无过滤 ⇒ 红）')
  await settle(2)
}

console.log('66) ★ 0.7.19 RED-A 群判定不许被内部合成事件覆盖（cardfail 注入缺 chat_type ⇒ 群降级 full）')
{
  // 审查 MED（两份审查交叉印证）发现 1-A：notifyCardFailure 往 handleInbound 注入的事件**不带 chat_type**，
  // 旧实现 `bot.chatKinds.set(chatId, String(evt.chat_type || 'p2p'))` 无条件覆盖 ⇒ 群记录被改写成 p2p
  // ⇒ resolveCardMode 落到 cfg（缺省 full）⇒ 过程叙述暴露给群。锚定：覆盖发生的**紧接着那一轮**
  //（注入轮自己）必须仍按 stable 渲染。cfg.mode 缺省（=full），群降级只能靠 chatKinds。
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
             reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true }],
  }, null, 2))
  await settle(2)
  const GROUP66 = 'oc_group66_test'
  const feed66 = (msgId, text) => {
    fakeProc.output += JSON.stringify({
      type: 'event', eventType: 'im.message.receive_v1',
      data: {
        message: { message_id: msgId, message_type: 'text', chat_type: 'group',
                    chat_id: GROUP66, content: JSON.stringify({ text }), mentions: GROUP_MENTION },
        sender: { sender_id: { open_id: 'ou_test' } },
      },
    }) + '\n'
  }
  let seq66 = 20000
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push(
      { type: 'assistant/message', seq: ++seq66, data: { message: { content: [{ type: 'text', text: '过程叙述-A66-甲' }] } } },
      { type: 'assistant/message', seq: ++seq66, data: { message: { content: [{ type: 'text', text: '答复-A66-乙' }] } } },
    )
  }
  const mark66a = sentCards.length
  feed66('om_group66_m1', '群判定-建立 group 记录')
  await settle(5)
  const ops66a = cardsSince(mark66a).filter((c) => c.payload && c.payload.schema === '2.0')
  const last66a = ops66a.length ? JSON.stringify(ops66a[ops66a.length - 1].payload) : ''
  ok(ops66a.length >= 1, '（前提）群 M1 建了卡（实际 ' + ops66a.length + ' 张）')
  ok(last66a.includes('答复-A66-乙') && !last66a.includes('过程叙述-A66-甲'),
    '（前提）M1 按 stable 渲染（group 记录已建立：答复在、过程滤）')

  // 注入触发：create 被拒（230099 且不含 11310 ⇒ classify=rejected ⇒ 非 toolarge ⇒
  // notifyCardFailure 走 else 分支 ⇒ 往 handleInbound 注入**无 chat_type** 的合成事件）。
  const mark66b = sentCards.length
  const logMark66 = consoleLines.length
  rejectPatches = 1
  rejectPatchesBody = { code: 230099, msg: 'Failed to create card content (injected: chatKinds overwrite RED)' }
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push(
      { type: 'assistant/message', seq: ++seq66, data: { message: { content: [{ type: 'text', text: '过程叙述-INJECT-丙' }] } } },
      { type: 'assistant/message', seq: ++seq66, data: { message: { content: [{ type: 'text', text: '注入答复-INJECT-丁' }] } } },
    )
  }
  feed66('om_group66_m2', '触发卡片失败注入')
  await settle(6)
  rejectPatches = 0
  rejectPatchesBody = null
  const log66 = consoleLines.slice(logMark66)
  ok(log66.some((l) => l.includes('card failure notice sent')),
    '（前提）触发了非 toolarge 失败注入（card failure notice sent；没触发则本用例恒真=假保险丝）')
  const ops66b = cardsSince(mark66b).filter((c) => c.payload && c.payload.schema === '2.0')
  const last66b = ops66b.length ? JSON.stringify(ops66b[ops66b.length - 1].payload) : ''
  ok(ops66b.length >= 1, '（前提）注入轮建了卡（实际 ' + ops66b.length + ' 张；没有卡则断言无从锚定）')
  ok(last66b.includes('注入答复-INJECT-丁'),
    '（前提）注入轮渲染出了答复（证明卡是活的，不是死卡假绿）')
  ok(!last66b.includes('过程叙述-INJECT-丙'),
    '★ 注入轮仍按 stable 渲染：内部事件不许把群改写成 p2p（旧实现 || \'p2p\' 覆盖 ⇒ full ⇒ 红）')
  await settle(2)
}

console.log('67) ★ 0.7.19 RED-C 热重载后群第一条命令 /switch 仍要被拒（门禁跑在记录之前 ⇒ fail-open）')
{
  // 审查 MED 发现 1-C：/switch 门禁（handleCommand）跑在 handleInbound 的 chatKinds 记录之前，
  // 而热重载后 chatKinds 清零（发现 1-B）⇒ 群第一条命令必然绕过 F6 门禁（fail-open）。
  // 修复：handleHelperMessage 的 normalizeEvent 之后**早记** chat_type（命令分支也覆盖）。
  // 本用例锚定：re-apply 之后，同群发 /switch 必须仍被「稳定版不支持」拒绝。
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
             reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true }],
  }, null, 2))
  await settle(2)
  const GROUP67 = 'oc_group67_test'
  const feed67 = (msgId, text) => {
    fakeProc.output += JSON.stringify({
      type: 'event', eventType: 'im.message.receive_v1',
      data: {
        message: { message_id: msgId, message_type: 'text', chat_type: 'group',
                    chat_id: GROUP67, content: JSON.stringify({ text }), mentions: GROUP_MENTION },
        sender: { sender_id: { open_id: 'ou_test' } },
      },
    }) + '\n'
  }
  const mark67a = sentCards.length
  feed67('om_group67_m1', '群判定-热重载前建立 group 记录')
  await settle(5)
  ok(cardsSince(mark67a).filter((c) => c.payload && c.payload.schema === '2.0').length >= 1,
    '（前提）热重载前群 M1 建了卡（group 记录已建立）')

  // 模拟热重载 = **先卸载旧代**（case 51 同款流程），否则新旧两代并存 ⇒ 两代 helper 竞争消费
  // 同一入站流 ⇒ 断言结果不纯（RED 首跑实测：68 被留有 group 记录的旧代代劳 ⇒ 假绿）。
  for (const cleanup67 of effectCleanups) { try { cleanup67() } catch { /* 卸载副作用不关心 */ } }
  globalThis.__fsReloadHint = null
  const mod67 = await import('../index.js')
  mod67.apply(ctx)
  await drain()
  await drain()

  const mark67b = sentCards.length
  feed67('om_group67_switch', '/switch')
  await settle(5)
  const touched67 = cardsSince(mark67b)
  ok(touched67.some((c) => JSON.stringify(c.payload || {}).includes('稳定版不支持')),
    '★ 热重载后群第一条命令 /switch 仍被拒（旧实现：门禁时 chatKinds 空 ⇒ cfg 缺省 full ⇒ 放行 ⇒ 红）')
  await settle(2)
}

console.log('68) ★ 0.7.19 RED-B 群判定必须随 chats 落盘（persistChats 写 kind —— 旧实现不写 ⇒ 红）')
{
  // 审查 MED 发现 1-B：chatKinds 只在内存、不随 bot.chats 落盘 ⇒ 每次热重载群判定清零。
  // 修复 = persistChats 写 kind + loadChats 恢复。本用例锚修复**本体**（落盘字段）。
  // ⚠️ RED 首跑教训：「重启后再发一条群消息」那条路判别不了 B —— 真群消息自带 chat_type，
  // 入站当场把 kind 写对（自愈）⇒ 旧 68 恒绿（假保险丝）。行为面改由用例 69 锚（无入站主动推卡）。
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
             reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true }],
  }, null, 2))
  await settle(2)
  const GROUP68 = 'oc_group68_test'
  const feed68 = (msgId, text) => {
    fakeProc.output += JSON.stringify({
      type: 'event', eventType: 'im.message.receive_v1',
      data: {
        message: { message_id: msgId, message_type: 'text', chat_type: 'group',
                    chat_id: GROUP68, content: JSON.stringify({ text }), mentions: GROUP_MENTION },
        sender: { sender_id: { open_id: 'ou_test' } },
      },
    }) + '\n'
  }
  let seq68 = 21000
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push(
      { type: 'assistant/message', seq: ++seq68, data: { message: { content: [{ type: 'text', text: '过程叙述-B68-甲' }] } } },
      { type: 'assistant/message', seq: ++seq68, data: { message: { content: [{ type: 'text', text: '答复-B68-乙' }] } } },
    )
  }
  const mark68 = sentCards.length
  feed68('om_group68_m1', '落盘-建立 group 记录')
  await settle(5)
  const ops68 = cardsSince(mark68).filter((c) => c.payload && c.payload.schema === '2.0')
  const last68 = ops68.length ? JSON.stringify(ops68[ops68.length - 1].payload) : ''
  ok(ops68.length >= 1 && last68.includes('答复-B68-乙') && !last68.includes('过程叙述-B68-甲'),
    '（前提）M1 按 stable 渲染（chat 记录已建立）')

  const statePath68 = join(process.env.FS_CONFIG_DIR,
    'state-' + String(APP_ID).replace(/[^a-zA-Z0-9]/g, '') + '.json')
  let state68 = null
  try { state68 = JSON.parse(readFileSync(statePath68, 'utf8')) } catch { state68 = null }
  const rec68 = state68 && state68.chats && state68.chats[GROUP68]
  ok(Boolean(rec68), '（前提）M1 的 chat 记录已落盘（state 文件里有该群）')
  ok(rec68 && rec68.kind === 'group',
    '★ chat_kind 随 chats 落盘（persistChats 写 kind=group；旧实现不写 ⇒ 红）')
  await settle(2)
}

console.log('69) ★ 0.7.19 RED-B2 重启后【无入站的主动推卡】仍 stable：goal 轮卡不许泄露过程叙述')
{
  // B 的真实行为击穿（OCR 报告同款路径）：重启后、该群还没有新入站时，goal/自动轮卡经
  // findChatForAgent（按**已落盘的 session id** 认领，见 index.js:4424 与用例 50 先例）解析
  // where —— 全程不经飞书入站 ⇒ chatKinds 不会"自愈"。未修复：loadChats 不恢复 kind ⇒
  // chatKinds 空 ⇒ cfg 缺省 full ⇒ 过程叙述上卡（泄露给群里的员工）。
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
             reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true }],
  }, null, 2))
  await settle(2)
  const GROUP69 = 'oc_group69_test'
  const feed69 = (msgId, text) => {
    fakeProc.output += JSON.stringify({
      type: 'event', eventType: 'im.message.receive_v1',
      data: {
        message: { message_id: msgId, message_type: 'text', chat_type: 'group',
                    chat_id: GROUP69, content: JSON.stringify({ text }), mentions: GROUP_MENTION },
        sender: { sender_id: { open_id: 'ou_test' } },
      },
    }) + '\n'
  }
  agent.send = function (message) { this.sent.push(message) }
  feed69('om_group69_m1', '建会话+落盘（供跨代认领）')
  await settle(5)
  const sess69 = createdSessionIds[createdSessionIds.length - 1] || agent.id
  ok(Boolean(sess69), '（前提）拿到已落盘的会话 id（跨代认领的钥匙：' + sess69 + '）')

  // 卸旧代 + re-apply（热重载语义，同 67）
  for (const cleanup69 of effectCleanups) { try { cleanup69() } catch { /* 卸载副作用不关心 */ } }
  globalThis.__fsReloadHint = null
  const mod69 = await import('../index.js')
  mod69.apply(ctx)
  await drain()
  await drain()

  // goal 轮（全程无飞书入站）：id 用落盘会话 id（findChatForAgent 按它认领），
  // session 用顶层 agent 的活事件流（process 事件从这里读）。
  const adapt69 = { id: sess69, ctx: agentCtx, session: agent.session }
  const mark69 = sentCards.length
  let seq69 = 25000
  agentEvents.push({
    type: 'user/message', seq: ++seq69,
    data: {
      content: [{ type: 'text', text: '<goal_round>\nRound: 1/10\n</goal_round>' }],
      source: { kind: 'goal', goalId: 'g69', revision: 1, round: 1 },
    },
  })
  emitCtx('agent/status', { agent: adapt69, status: 'running' })
  await drain()
  agentEvents.push(
    { type: 'assistant/message', seq: ++seq69, data: { message: { content: [{ type: 'text', text: '目标轮过程叙述-B69-甲' }] } } },
    { type: 'assistant/message', seq: ++seq69, data: { message: { content: [{ type: 'text', text: '目标轮结论-B69-乙' }] } } },
  )
  await drain()
  emitCtx('agent/status', { agent: adapt69, status: 'idle' })
  await settle(4)
  const body69 = JSON.stringify(cardsSince(mark69))
  ok(body69.includes('第 1 轮'),
    '（前提）goal 轮卡建立且卡面轮次可见（跨代 owner 认领成功 —— 事件流真的进卡了）')
  ok(body69.includes('目标轮结论-B69-乙'), '（前提）goal 轮结论渲染出来了（卡是活的）')
  ok(!body69.includes('目标轮过程叙述-B69-甲'),
    '★ 重启后无入站的 goal 轮按 stable 渲染（过程叙述不渲染；旧实现 kind 不恢复 ⇒ full ⇒ 红）')
  await settle(2)
}

console.log('70) ★ 身份认证 fail-closed：identityGuard 开 + 飞书回合身份未解析 ⇒ 拒绝执行（CM 2026-10-04 裁决）')
{
  // 被守护的行为（**已有实现，本用例不碰实现**）：
  //   `identity-inject.mjs` 的 decideAction —— hasOwner=false ⇒ pass-through；有 actor ⇒ overwrite；
  //   **无 actor ⇒ deny**。CM 原话：「无表就拒应该是最好的，最稳的。因为你执行不了，总比资料泄露好吧」
  //   拦截器实体 = index.js:6830（`ctx.on('tools/execute')` 里**第一个**监听器，通用身份拦截；
  //   6872 / 6949 是专用拦截，本用例不碰）。开关 = 每个 bot 的配置项 `identityGuard`（**默认关**）。
  //
  // ⚠️ 口径澄清（2026-10-04 施工时逐行读 index.js:6835-6840 得出，别写错）：
  //   if (!(owner && owner.bot && owner.bot.cfg && owner.bot.cfg.identityGuard)) return next()
  //   const rec = identityCtx(workspaceRoot()).store.get(exec.agent.id)
  //   const action = !rec ? 'pass-through' : decideAction({ hasOwner: true, actor: rec.actor })
  //   ⇒ **deny 的触发条件是「store 里有这一轮的记录、但 rec.actor 为空」**（＝这个飞书回合确实
  //     去解析了身份、却没解析出来）；而「store 里**根本没有**这条记录」走 `!rec` ⇒ pass-through（放行）。
  //   ⇒ 所以本用例的 deny 场景走**端到端真实路径**：开着开关喂一条飞书入站 ⇒ 入站侧 resolve 失败
  //     （本机表里没有 ou_test 这个人）⇒ store 记 { actor: null } ⇒ 工具调用被拦。
  //     用例刻意**不**断言"store 里没记录也拒" —— 与当前实现不符，属另一条口径（会另案上报）。
  const CFG_PATH = join(process.env.FS_CONFIG_DIR, 'feishu.config.json')
  const cfgTextBefore = readFileSync(CFG_PATH, 'utf8')
  const patchCfg = (patch) => {
    const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'))
    Object.assign(cfg.bots[0], patch)
    writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2))
  }
  const nextSpy = () => Promise.resolve('next')
  const capture = (runs) => runs.map((r) => Promise.resolve(r).then(
    (value) => ({ value }), (error) => ({ error })))
  // 断言消息里要能看出"到底返回了什么"，否则红了只能靠猜
  const summarize = (os) => os.map((o) => (o.error
    ? ('throw:' + String((o.error && o.error.message) || o.error))
    : (o.value === 'next' ? 'next' : JSON.stringify(o.value).slice(0, 100))))
  const isDeny = (o) => Boolean(o && o.value && typeof o.value === 'object' && o.value.isError === true)

  // (0) 前提：开关默认关（配置里本来没有这个键）—— 守住"默认关"这条口径
  ok(JSON.parse(cfgTextBefore).bots[0].identityGuard === undefined,
    '（前提）identityGuard 默认**关**：配置里本来就没有这个键')

  // (1) 开闸 ＋ 喂一条**真实飞书入站**（唯一能写进 store 的生产路径：handleInbound 的身份解析）
  patchCfg({ identityGuard: true })
  await settle(2)
  ok(JSON.parse(readFileSync(CFG_PATH, 'utf8')).bots[0].identityGuard === true,
    '（前提）开关已写进配置（实现是**热读**：ensureHelpers 每 tick 无条件 bot.cfg=cfg，靠 drain 驱动）')
  // 🔴 第四十三轮门槛 MEDIUM（核对为真）：无记录硬拒已**收窄**为"调用带身份键"才拒
  //   （CM 裁决原文的边界是「带**参**执行」；不带身份字段的调用没有冒充面，拒它是纯误伤
  //   ——store.set 只在入站/steer 写、TTL 30 分钟，goal 自动续轮/长轮过期后连 read 都会被杀）。
  //   用一条**在册但本轮没喂过入站**（⇒ store 里无记录）的会话 id 一次演完两支。
  {
    const staleIds = persistedSessions.map((s) => String((s && s.id) || '')).filter(Boolean)
    const probeId = staleIds.find((id) => id !== agent.id)
    ok(Boolean(probeId),
      '（前提）拿到一条本轮无入站记录的在册会话 id（拿不到＝本格如实红）｜候选 ' + JSON.stringify(staleIds))
    if (probeId) {
      const keyedRun = await Promise.all(capture(emitCtx('tools/execute',
        { name: 'read', agent: { id: probeId }, arguments: { file_path: 'a.md', open_id: 'ou_spoof_43' }, signal: undefined }, nextSpy)))
      ok(keyedRun.some(isDeny)
        && keyedRun.filter(isDeny).every((o) => String(JSON.stringify(o.value)).includes('identity_record_missing')),
        '★★★ 无记录＋**带身份键** ⇒ 拒（K3-GAP 不放松；旧写法在这也拒＝形状相同，判别在隔壁支）'
        + '｜实得 ' + JSON.stringify(summarize(keyedRun)))
      const logKeyless = consoleLines.length
      const keylessRun = await Promise.all(capture(emitCtx('tools/execute',
        { name: 'read', agent: { id: probeId }, arguments: { file_path: 'a.md' }, signal: undefined }, nextSpy)))
      ok(keylessRun.length >= 3 && keylessRun.every((o) => o.value === 'next'),
        '★★★ 无记录＋**不带身份键** ⇒ 放行（第四十三轮收窄：旧字节硬拒 ⇒ 本条必红）'
        + '｜实得 ' + JSON.stringify(summarize(keylessRun)))
      // 🔴 第四十四轮 MEDIUM#1（核对为真）：keyless 支原来**漏 return**——落到 rec.actor
      //   （rec=null）抛 TypeError 被外层 catch 吞掉再 next()：放行靠异常兜路，每笔调用还刷
      //   一条误导性 ALERT[internal_error]。上面的 every(next) 走 catch 也能绿（假绿灯），
      //   所以必须另钉"放行以**显式控制流**发生"——同窗内不许出现 internal_error。
      ok(!consoleLines.slice(logKeyless).some((l) => String(l).includes('identity ALERT[internal_error]')),
        '★★ keyless 放行**不走异常兜路**（无 ALERT[internal_error] 噪音；漏 return 版必红）')
    }
  }
  agent.send = function (message) { this.sent.push(message) }
  liveAgents.length = 0   // 让入站的 resolveAgent 走 resume 分支 ⇒ handle.agent 就是下面这个 mock agent
  const idLogFrom = consoleLines.length
  feedInbound('om_identity_guard_70', '身份闸门用例：这条走真实入站路径')
  await settle(4)
  const idLines = consoleLines.slice(idLogFrom).filter((l) => l.includes('[fs] identity:'))
  ok(idLines.length >= 1,
    '（前提）入站侧真的做了身份解析（留痕 `[fs] identity: agent=…`；实际 ' + idLines.length + ' 行）')
  ok(idLines.length >= 1 && !idLines.some((l) => l.includes('-> OK ')),
    '（前提）这个 open_id **没解析出 actor**（留痕：' + JSON.stringify(idLines) + '）')
  // 谁被记进了 store 就用谁：findChatForAgent 认两种归属 —— 会话表里的 id（String(s.id) === key）
  // 或活 handle 的 agent 对象（index.js:4452-4453）⇒ 按插件自己日志里的 agent id 取对应对象。
  const recId = (idLines.map((l) => (l.match(/\[fs\] identity: agent=(\S+)/) || [])[1]).find(Boolean)) || agent.id
  const fsAgent = recId === agent.id ? agent : { id: recId, ctx: agentCtx, session: agent.session }
  const execPayload = (a) => ({ name: 'read', agent: a, arguments: { file_path: 'a.md' }, signal: undefined })

  // (2) 🔴 断言二：开关开 ＋ 飞书回合身份未解析 ⇒ 工具结果 isError:true（**不是** next()）
  const onRun = await Promise.all(capture(emitCtx('tools/execute', execPayload(fsAgent), nextSpy)))
  ok(onRun.length >= 3,
    '（前提）tools/execute 上至少 3 个监听器（通用身份 + exit_plan_mode + ask_user_question；实际 '
      + onRun.length + '）')
  const denyHits = onRun.filter(isDeny)
  ok(denyHits.length >= 1,
    '★ 开关开 + 飞书回合身份未解析 ⇒ 拦下（工具结果 isError:true，不是 next()）：'
      + JSON.stringify(summarize(onRun)))
  ok(denyHits.length >= 1
      && denyHits.every((o) => String(JSON.stringify(o.value)).includes('identity_unresolved')),
    '★ 拒绝理由看得出是「身份未解析」（identity_unresolved）')

  // (3) 🔴 断言三：开关开 ＋ **非飞书** agent（无 owner 的回合）⇒ 仍然 next()（放行）
  //     （2026-10-04 实测踩过一次：锁死本机 GUI／子代理就是事故级）
  const foreignRun = await Promise.all(capture(emitCtx('tools/execute',
    execPayload({ id: 'agent-not-feishu-70' }), nextSpy)))
  ok(foreignRun.length >= 3 && foreignRun.every((o) => o.value === 'next'),
    '★ 开关开着也不许锁死非飞书 agent（本机 GUI／子代理／定时轮）⇒ 全部 next()（listeners='
      + foreignRun.length + '）')

  // (4) 🔴 断言一：开关**关** ⇒ 工具调用不被拦（监听器 next()）
  //     放在最后做，且此时 store 里那条 { actor: null } 记录**还在** ⇒ 证明"放行"是**开关**造成的，
  //     而不是"没记录/记录过期"造成的假绿。
  patchCfg({ identityGuard: false })
  await settle(2)
  const offRun = await Promise.all(capture(emitCtx('tools/execute', execPayload(fsAgent), nextSpy)))
  ok(offRun.length >= 3 && offRun.every((o) => o.value === 'next'),
    '★ 开关关 ⇒ 同一条调用**一个监听器都不拦**（全 next()；listeners=' + offRun.length + '）')
  // 反证：再打开 ⇒ 同一条调用又被拦（说明身份记录仍在、没被 TTL 清掉）
  patchCfg({ identityGuard: true })
  await settle(2)
  const onAgain = await Promise.all(capture(emitCtx('tools/execute', execPayload(fsAgent), nextSpy)))
  ok(onAgain.some(isDeny),
    '★ 再把开关打开 ⇒ 同一条调用又被拦（证明上一步的放行是**开关**造成的，不是记录消失）')

  // 收尾：配置还原成本用例之前的样子（本用例在最后，但别给以后加用例的人埋雷）
  writeFileSync(CFG_PATH, cfgTextBefore)
  await settle(2)
  ok(JSON.parse(readFileSync(CFG_PATH, 'utf8')).bots[0].identityGuard === undefined,
    '（收尾）配置已还原：identityGuard 键移除（回到默认关）')
}

// ==== 0.7.20 用例组（热重载不再打扰 agent · 僵尸卡到此为止）====================
// 共用小工具：卡片 watcher 走**真实** setInterval(300ms)，所以推进假时钟之后必须真的等它轮询。
// ⚠️ 关键陷阱（2026-10-04 施工时踩到）：孤儿卡补封口要求「连续确认」——
//   idleSince 在某一拍记下、下一拍才比长短 ⇒ **恒定偏移永远测不到补封口**，必须分两次推进。
function useFakeClock() {
  const realNow = Date.now
  let off = 0
  Date.now = () => realNow() + off
  return {
    advance(minutes) { off += minutes * 60 * 1000 },
    restore() { Date.now = realNow },
  }
}
async function pollCards(times) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 420))
}
// 把一张「agent 已 idle 且无人认领」的卡推到补封口（两次推进，见上面陷阱说明）
async function forceOrphanSeal(clock) {
  clock.advance(60); await pollCards(2)
  clock.advance(2); await pollCards(2)
}

console.log('71) ★ 0.7.20 A：热重载**不给 agent 发假消息** · 接管即补扫强推 · 无卡则从当前游标复活')
{
  const cards71 = globalThis.__fsLiveCards
  let release71
  const gate71 = new Promise((r) => { release71 = r })
  const prevIdle71 = agent.whenIdle
  agent.whenIdle = () => gate71
  agent.send = function (message) { this.sent.push(message) }
  liveAgents.push(agent)

  // (a) 一轮挂住的回合 ⇒ 一张 running 的卡
  const markA = sentCards.length
  feedInbound('om_reload_71a', '热重载接管用例-71A')
  await settle(3)
  ok(Boolean(cards71.get(agent.id) && cards71.get(agent.id).card), '（前提a）这张卡登记在跨代接管表里')
  const sentA = agent.sent.length
  // 重载那一刻会话里又落了新事件（旧实例还没来得及扫/推就被 dispose = CM 报的「重载后卡片不更新」）
  agentEvents.push({ type: 'assistant/message', seq: 91001, data: { message: { content: [{ type: 'text', text: '欠推内容-71A' }] } } })

  // (b) 热重载 ⇒ 新实例接管同一张卡，并**立刻把欠着的内容推出去**
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 卸载副作用不关心 */ } }
  effectCleanups.length = 0   // 十三轮 MED#4：disposer 清单必须随代清零（否则旧代每次重载都被再 dispose 一遍）
  // 隔离：提示按 sessionId 去重（120 秒窗口内同一会话只播一次，这是**设计**不是 bug），
  //   而前面别的用例已经为 agent-smoke-1 播过一次 ⇒ 这里清掉，才能看到本用例自己的分支。
  if (globalThis.__fsReloadNotified) globalThis.__fsReloadNotified.clear()
  globalThis.__fsReloadHint = { at: Date.now(), items: [{ sessionId: String(agent.id), chatId: CHAT_ID, appId: APP_ID }] }
  const markB = sentCards.length
  const logMarkB = consoleLines.length
  const modB = await import('../index.js')
  modB.apply(ctx)
  await settle(3)
  const winB = consoleLines.slice(logMarkB)
  ok(winB.some((l) => l.includes('热重载续卡：接管') && l.includes('catchup=true')),
    '★ 接管立刻补扫（catchup=true —— 欠的内容扫出来了）')
  ok(winB.some((l) => l.includes('热重载续卡：接管') && l.includes('unpushed=true')),
    '★ 判定「欠一次推送」（unpushed=true：内容进卡晚于推送成功）')
  ok(JSON.stringify(sentCards.slice(markB)).includes('欠推内容-71A'),
    '★ 强推真的推到了飞书（不用等下一条新事件 —— CM 报障②的正面解）')
  ok(winB.some((l) => l.includes('hot reload interrupt notice') && l.includes('state=mirrored')),
    '★ 提示按**真实状态**发：state=mirrored（卡还在，不必新建）')
  ok(!JSON.stringify(sentCards.slice(markB)).includes('我已自动让它接着做'),
    '★ 不再谎称「我已自动让它接着做」（那是假消息注入的承诺）')
  ok(agent.sent.length === sentA,
    '★★ 全程**没有**给 agent 发任何消息（假消息注入已删 —— CM 报障「跑完一轮又自己接一轮」的根源）')

  // (c) 再重载一次（中间**没有**新事件）⇒ 一张卡都不许推（独立审查 HIGH#1：无脑重推=内容重复）
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 同上 */ } }
  effectCleanups.length = 0   // 十三轮 MED#4：disposer 清单必须随代清零（否则旧代每次重载都被再 dispose 一遍）
  globalThis.__fsReloadHint = null
  const markC = sentCards.length
  const logMarkC = consoleLines.length
  const modC = await import('../index.js')
  modC.apply(ctx)
  await settle(3)
  const pushedC = sentCards.slice(markC).filter((c) => c.payload && c.payload.schema === '2.0')
  ok(pushedC.length === 0,
    '★ 第二次重载无新内容 ⇒ 一次卡都不推（实际 ' + pushedC.length + ' 次；无脑重推会让卡面内容重复）')
  ok(consoleLines.slice(logMarkC).some((l) => l.includes('热重载续卡：接管') && l.includes('unpushed=false')),
    '留痕 unpushed=false（判定依据可见：没欠推就不推）')

  // (d) 接管失败（卡彻底没跟过来）⇒ 从**当前游标**新建一张续镜像，不重放已推过的内容
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 同上 */ } }
  effectCleanups.length = 0   // 十三轮 MED#4：disposer 清单必须随代清零（否则旧代每次重载都被再 dispose 一遍）
  cards71.delete(String(agent.id))
  if (globalThis.__fsReloadNotified) globalThis.__fsReloadNotified.clear()
  globalThis.__fsReloadHint = { at: Date.now(), items: [{ sessionId: String(agent.id), chatId: CHAT_ID, appId: APP_ID }] }
  const markD = sentCards.length
  const logMarkD = consoleLines.length
  const modD = await import('../index.js')
  modD.apply(ctx)
  await settle(3)
  const winD = consoleLines.slice(logMarkD)
  ok(winD.some((l) => l.includes('reload revive')),
    '★ 彻底没卡但 agent 还在跑 ⇒ 新建一张卡续镜像（留痕 `reload revive`）')
  ok(winD.some((l) => l.includes('hot reload interrupt notice') && l.includes('state=revived')),
    '★ 状态判定=revived（提示与真实动作一致）')
  const createdD = sentCards.slice(markD).filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0')
  ok(createdD.length === 1, '★ 新建的正是**一张**流式卡（实际 ' + createdD.length + ' 张）')
  const bodyD = JSON.stringify(createdD)
  ok(bodyD.includes('从当前进度继续'), '卡上第一行就写清「从当前进度继续」（CM：提示要让用户知道是什么情况）')
  ok(!bodyD.includes('欠推内容-71A'), '★ 不重放已经推过的内容（游标从当前事件位置起 ⇒ 只镜像往后）')
  ok(agent.sent.length === sentA, '★★ 复活同样**没有**碰 agent（不发消息、不打断、不重跑）')

  // (e) 收尾：模拟「旧代 runTurn 的收尾推送被代际旗吞掉」（拥有者从跨代表里消失）
  //     ⇒ 这张复活卡成了无主孤儿，而 agent 已 idle ⇒ 应当补封口。
  globalThis.__fsActiveTurns.delete(String(agent.id))
  agent.status = 'idle'
  await pollCards(4)
  ok(!consoleLines.slice(logMarkD).some((l) => l.includes('orphan card sealed after reload')),
    '（闸门）宽限未到 ⇒ 不许抢着封口（防止把还在跑的一轮误封成结束）')
  const clockE = useFakeClock()
  await forceOrphanSeal(clockE)
  clockE.restore()
  const winE = consoleLines.slice(logMarkD)
  ok(winE.some((l) => l.includes('orphan card sealed after reload')),
    '★ 无人认领 + agent 已 idle ⇒ 就地补封口（僵尸卡到此为止，不再每 10 分钟播一次）')
  ok(sentCards.slice(markD).some((c) => JSON.stringify(c.payload).includes('本实例补的封口')),
    '补封口在卡上留了一行看得懂的话（不静默）')
  release71()
  agent.whenIdle = prevIdle71
  delete agent.status
  await settle(2)   // 让 gen1 那次正式收尾跑完，别把它的推送漏进下一条用例的窗口
  liveAgents.length = 0
}

console.log('72) ★ 0.7.20 B：agent 已 idle ⇒「上游没回包」**一条都不播**；回合还在则不抢封口')
{
  const cards72 = globalThis.__fsLiveCards
  const turns72 = globalThis.__fsActiveTurns
  let release72
  const gate72 = new Promise((r) => { release72 = r })
  const prevIdle72 = agent.whenIdle
  agent.whenIdle = () => gate72
  agent.send = function (message) { this.sent.push(message) }
  const mark72 = sentCards.length
  const logMark72 = consoleLines.length
  feedInbound('om_orphan_72', '孤儿卡闸门-72')
  await settle(3)
  ok(createsSince(mark72).length >= 1, '（前提）这一轮建了卡')
  const entry72 = cards72.get(agent.id)
  ok(Boolean(entry72 && entry72.card && entry72.card.status === 'running'), '（前提）卡处于 running')
  ok(turns72.has(String(agent.id)), '（前提）这一轮仍被飞书回合持有（activeTurns 认它）')

  // ① agent 报 idle，但回合仍被持有 ⇒ 不许播「没有回包」（假话），也不许抢封口（正式收尾会处理）
  agent.status = 'idle'
  const clock72 = useFakeClock()
  clock72.advance(60); await pollCards(3)
  clock72.advance(2); await pollCards(3)
  const win72a = consoleLines.slice(logMark72)
  ok(win72a.some((l) => l.includes('stall notice suppressed: agent idle')),
    '★ 留痕 `suppressed: agent idle`（回合还在，只是不再产生事件）')
  ok(!win72a.some((l) => l.includes('stall notice sent')),
    '★★ 一条「上游没有回包」都不播（旧实现每 10 分钟一条无限刷 —— CM 报障 365/375/385/395/405）')
  ok(!win72a.some((l) => l.includes('orphan card sealed after reload')),
    '★ 但**不抢封口**：activeTurns 还认这一轮 ⇒ 交给正式收尾（不许把还在跑的误封）')

  // ② 旧代的收尾被代际旗吞掉（= 真孤儿卡）：拥有者消失 ⇒ 补封口 + 仍然一条提示都不播
  const logMark72b = consoleLines.length
  turns72.delete(String(agent.id))
  await forceOrphanSeal(clock72)
  clock72.restore()
  const win72b = consoleLines.slice(logMark72b)
  ok(win72b.some((l) => l.includes('orphan card sealed after reload')),
    '★ 拥有者消失 + agent idle ⇒ 补封口（留痕可复验）')
  ok(!win72b.some((l) => l.includes('stall notice sent')), '★ 全程仍然一条提示都不发')
  ok(entry72.card.status === 'sealed', '卡的状态收到 sealed（定时器停掉 ⇒ 这张卡从此不再播任何东西）')
  ok(!JSON.stringify(sentCards.slice(mark72)).includes('没有回包'),
    '★ 卡面上也没写「没有回包」（不是上游的问题，是收尾被吞）')
  release72()
  agent.whenIdle = prevIdle72
  delete agent.status
}

console.log('73) ★ 0.7.20 C：真卡住也**最多播 2 次**（跨换卡累计），第 3 次起只留痕不发消息')
{
  // agent 明确 running ⇒ 通过存活闸门，这一段专门测「封顶」（CM 报障的另一半：刷屏）
  agent.status = 'running'
  let release73
  const gate73 = new Promise((r) => { release73 = r })
  const prevIdle73 = agent.whenIdle
  agent.whenIdle = () => gate73
  agent.send = function (message) { this.sent.push(message) }
  const mark73 = sentCards.length
  const logMark73 = consoleLines.length
  feedInbound('om_cap_73', '静默封顶-73')
  await settle(3)
  ok(createsSince(mark73).length >= 1, '（前提）这一轮建了卡')
  const clock73 = useFakeClock()
  // 逐段把静默推长（每段都 > 10 分钟去重窗口 ⇒ 旧实现会一直刷下去）
  for (let i = 0; i < 6; i++) { clock73.advance(11); await pollCards(3) }
  const plainNotice = sentCards.slice(mark73)
    .filter((c) => c.op === 'create' && c.payload && !c.payload.schema
      && JSON.stringify(c.payload).includes('没有回包'))
  ok(plainNotice.length === 2,
    '★ 只播了 2 条纯文本提示（实际 ' + plainNotice.length + ' 条 —— 旧实现每 10 分钟一条，无限）')
  const win73 = consoleLines.slice(logMark73)
  ok(win73.filter((l) => l.includes('stall notice sent')).length === 2,
    '留痕 `stall notice sent` = 2 条（与发消息一一对应，无假日志）')
  ok(win73.some((l) => l.includes('stall notice suppressed: reached cap')),
    '★ 第 3 次起留痕 `suppressed: reached cap`（不静默、也不再发）')
  ok(JSON.stringify(plainNotice).includes('最多提醒 2 次'),
    '提示正文把「最多提醒 2 次」告诉用户（CM：要让他知道是什么情况）')
  clock73.restore()
  release73()
  agent.whenIdle = prevIdle73
  delete agent.status
  await settle(2)
}

console.log('74) ★ 0.7.20 D：热重载**接管来的卡**发完提示也要能换卡（旧实现打 nothing to rotate）')
{
  const cards74 = globalThis.__fsLiveCards
  const turns74 = globalThis.__fsActiveTurns
  let release74
  const gate74 = new Promise((r) => { release74 = r })
  const prevIdle74 = agent.whenIdle
  agent.whenIdle = () => gate74
  agent.send = function (message) { this.sent.push(message) }
  liveAgents.push(agent)
  agent.status = 'running'
  feedInbound('om_rot_74', '接管卡换-74')
  await settle(3)
  // 热重载 ⇒ 新实例接管这张卡（接管之后它**只**存在于跨代 registry：activeTurns/autoCards 都不认它）
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 卸载副作用不关心 */ } }
  effectCleanups.length = 0   // 十三轮 MED#4：disposer 清单必须随代清零（否则旧代每次重载都被再 dispose 一遍）
  globalThis.__fsReloadHint = null
  const mod74 = await import('../index.js')
  mod74.apply(ctx)
  await settle(2)
  const entry74 = cards74.get(agent.id)
  ok(Boolean(entry74 && entry74.card && entry74.card.status === 'running'), '（前提）接管成功，卡仍在跑')
  // ⚠️ 这里**人为**把跨代回合记录删掉，只代表一种情形：「旧代收尾已经走完、条目自己消失了」
  //   ⇒ 换卡只能落到 registry 兜底通道。真机更常见的是这条记录**还挂着**（旧代 runTurn
  //   仍 await 在 whenIdle 上），那才是用例 75 要打的洞（0.7.21 补）。
  turns74.delete(String(agent.id))
  const logMark74 = consoleLines.length
  const clock74 = useFakeClock()
  clock74.advance(6); await pollCards(3)
  const win74 = consoleLines.slice(logMark74)
  ok(win74.some((l) => l.includes('side notice -> live card rotated') && l.includes('kind=adopted')),
    '★ 走 registry 通道换卡（留痕 kind=adopted）')
  ok(!win74.some((l) => l.includes('nothing to rotate')),
    '★ 不再打「nothing to rotate」（旧实现在这里直接放弃 ⇒ 提示压在长卡下面，CM 看到的那条症状）')
  // 收尾：这一轮结束后无主卡被补封口，不留到以后刷屏
  agent.status = 'idle'
  await forceOrphanSeal(clock74)
  clock74.restore()
  ok(consoleLines.slice(logMark74).some((l) => l.includes('orphan card sealed after reload')),
    '（收尾）无主卡补封口 ⇒ 本用例不留活 watcher 给后续用例')
  release74()
  agent.whenIdle = prevIdle74
  delete agent.status
  liveAgents.length = 0
}

// ==== 0.7.21 用例组（接管这条路上剩下的两个高危）==========================================
// 这两条都是 0.7.20 同一条路径的**后续**，各自打中一个"看起来绿、实际是假绿灯"的地方：
//   用例 74 为了看到 registry 通道，人为 `turns74.delete()` 把跨代回合记录删了 ——
//   真机常态是旧代的 runTurn 还 await 在 `whenIdle()` 上，那条记录**一直挂着**。

console.log('75) ★ 0.7.21 A：接管时**旧代回合记录还挂着** ⇒ 换卡必须走本代（旧闭包会打死镜像链路）')
{
  const cards75 = globalThis.__fsLiveCards
  const turns75 = globalThis.__fsActiveTurns
  let release75
  const gate75 = new Promise((r) => { release75 = r })
  const prevIdle75 = agent.whenIdle
  // 旧代 runTurn 卡在 await whenIdle ⇒ 它登记在**跨代表**上的条目不会被它自己删掉
  agent.whenIdle = () => gate75
  agent.send = function (message) { this.sent.push(message) }
  agent.status = 'running'
  liveAgents.push(agent)

  feedInbound('om_foreign_75', '外代闭包-75')
  await settle(3)
  ok(turns75.has(String(agent.id)), '（前提）这一轮的记录仍挂在跨代 activeTurns 上（旧代还没收尾）')

  // 热重载 ⇒ 本代接管同一张卡；⚠️ 这里**不**删 activeTurns（与用例 74 的关键差别）
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 卸载副作用不关心 */ } }
  effectCleanups.length = 0   // 十三轮 MED#4：disposer 清单必须随代清零（否则旧代每次重载都被再 dispose 一遍）
  if (globalThis.__fsReloadNotified) globalThis.__fsReloadNotified.clear()
  globalThis.__fsReloadHint = null
  const mod75 = await import('../index.js')
  mod75.apply(ctx)
  await settle(2)
  const adopted75 = cards75.get(String(agent.id))
  ok(Boolean(adopted75 && adopted75.card), '（前提）本代接管了这张卡')
  const cardBeforeRotate75 = adopted75 && adopted75.card
  ok(turns75.has(String(agent.id)), '（前提）跨代表上仍留着**旧代**那条记录（真机常态）')

  // 触发一次 stall 提示 ⇒ 提示发完要换卡（把"还在跑的卡"挪到提示下方）
  const mark75 = sentCards.length
  const logMark75 = consoleLines.length
  const clock75 = useFakeClock()
  clock75.advance(6); await pollCards(3)
  const win75 = consoleLines.slice(logMark75)
  ok(win75.some((l) => l.includes('stall notice sent')), '（前提）静默提示确实发出去了')
  ok(win75.some((l) => l.includes('live card rotated') && l.includes('kind=adopted')),
    '★ 换卡走**本代**的续卡通道（kind=adopted）')
  ok(!win75.some((l) => l.includes('live card rotated') && l.includes('kind=turn')),
    '★★ 没有去调旧代登记的 rotate —— 那条闭包的推送已被代际旗全吞（调一次=这张卡从此不再更新）')

  // 换卡之后这条链路必须**还活着**：喂一条新事件 ⇒ 卡面更新要真的推到飞书
  const markLive = sentCards.length
  agentEvents.push({
    type: 'assistant/message', seq: 92001,
    data: { message: { content: [{ type: 'text', text: '换卡后仍要能镜像-75' }] } },
  })
  await settle(3)
  ok(JSON.stringify(sentCards.slice(markLive)).includes('换卡后仍要能镜像-75'),
    '★★★ 换卡后镜像链路**没死**（新内容真推出去了；旧实现这里一条都发不出去）')
  const nowEntry75 = cards75.get(String(agent.id))
  ok(nowEntry75 && nowEntry75.card && nowEntry75.card !== cardBeforeRotate75,
    'registry 已指向换出来的新卡（不是仍挂着旧卡）')

  // 收尾：让旧代那一轮正常返回（它的推送已被本代接管，不影响后续用例）
  clock75.restore()
  release75()
  agent.whenIdle = prevIdle75
  delete agent.status
  await settle(3)
  liveAgents.length = 0
}

console.log('76) ★ 0.7.21 B：热重载**之后**旧代那一轮才跑完 ⇒ 迟到的收尾必须送达')
{
  // 场景（CM 报障「热重载后卡片不更新」的另一半）：重载那刻这一轮还在跑 ⇒ 本代接管续镜像；
  //   随后旧代那个 await whenIdle 的 runTurn **才**返回，它的收尾推送全被代际旗吞掉。
  //   0.7.20 在这里是**终态**：卡对象已被旧代改成 sealed ⇒ 本代 watcher 的
  //   `else if (card.status === 'running')` 分支不再进（补封口也进不去）⇒ 这张卡在飞书
  //   上永远停在收尾前的样子，且没有任何自愈通道。
  const cards76 = globalThis.__fsLiveCards
  let release76
  const gate76 = new Promise((r) => { release76 = r })
  const prevIdle76 = agent.whenIdle
  agent.whenIdle = () => gate76
  agent.send = function (message) { this.sent.push(message) }
  agent.status = 'running'
  liveAgents.push(agent)
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'   // 强制走"结论独立成卡"那条分叉（旧代收尾会推两张卡）

  const mark76 = sentCards.length
  feedInbound('om_late_76', '迟到收尾-76')
  await settle(3)
  ok(createsSince(mark76).length >= 1, '（前提）这一轮建了卡')
  // 重载之后才有"最终回复"—— 它由旧代在 whenIdle 返回后摘走并封口
  agentEvents.push({
    type: 'assistant/message', seq: 93001,
    data: { message: { content: [{ type: 'text', text: '收尾时才算说完的结论-76' }] } },
  })
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 同上 */ } }
  effectCleanups.length = 0   // 十三轮 MED#4：disposer 清单必须随代清零（否则旧代每次重载都被再 dispose 一遍）
  globalThis.__fsReloadHint = null
  const mod76 = await import('../index.js')
  mod76.apply(ctx)
  await settle(2)
  ok(Boolean(cards76.get(String(agent.id))), '（前提）本代接管了这张卡（这一轮还在跑）')

  // 旧代那一轮**此刻**才真的结束
  const logMark76 = consoleLines.length
  const markAfter76 = sentCards.length
  agent.status = 'idle'
  release76()
  await settle(3)
  const win76 = consoleLines.slice(logMark76)
  ok(win76.some((l) => l.includes('turn sealed')), '（前提）旧代确实走到了收尾')
  ok(win76.some((l) => l.includes('conclusion split')), '（前提）旧代走了"结论独立成卡"那条分叉')

  const late = sentCards.slice(markAfter76)
  const lateBody = JSON.stringify(late)
  ok(lateBody.includes('收尾时才算说完的结论-76'),
    '★★ 迟到的收尾内容**真的推到了飞书**（旧代被拦下的那次推送由本代补发，不是静静丢掉）')
  ok(statusShows(lateBody, '已完成'),
    '★ 补发的是**封口后**的状态（卡面不再停在「正在工作中…」，CM 报障的正身）')
  // 0.7.22（交接清单#2）改判：旧口径「指路语一出现就算错」成立的前提是下方那张卡**永远不会存在**
  //   （无 token 的托孤卡被直接丢弃）。现在「建结论卡」这个动作也交班、由新代真 POST ⇒
  //   指路语与事实一致。红线不降，改为：**有指路语就必须有那张新建的结论卡**
  //   （建不出来时也必须把结论写回本卡，见 relayCreateFallback），两头都不落实就是红。
  const guideShown = lateBody.includes('结论见下方卡片')
  // 判据要的是"**那张卡真的存在**"⇒ 必须带 msgId（mock 在决定成功/失败**之前**就把 rec 记进
  //   sentCards，只数 op 会把一次失败的建卡算成建成 —— 用例 79 已经踩过这个坑）。
  const conclusionCreated = late.filter((c) => c.op === 'create' && c.msgId)
    .some((c) => JSON.stringify(c).includes('收尾时才算说完的结论-76'))
  ok(!guideShown || conclusionCreated,
    '★★★ 指路语与事实一致 —— 指着「下方那张卡」时那张卡必须真的被建出来（指路=' + guideShown
    + ' / 托孤建成=' + conclusionCreated + '）')

  // 收尾：不留活 watcher / 不留 running 的卡给后面的会话
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  release76()
  agent.whenIdle = prevIdle76
  delete agent.status
  liveAgents.length = 0
  const tail76 = cards76.get(String(agent.id))
  if (tail76 && tail76.card && tail76.card.status === 'running') {
    const clock76 = useFakeClock()
    await forceOrphanSeal(clock76)
    clock76.restore()
  }
}

console.log('77) ★ 0.7.21 群聊「@ 才回复」判据：身份未回前到达的群消息不许丢 / 没@ 与 @别的bot 必须忽略')
{
  // 这道门（2026-10-04 由另一会话直接改进线上文件）此前**零覆盖**。把它的代码移植进本副本后
  // 全量冒烟 13 条群用例全红，红在同一条缝上：`bot.botOpenId` 是**异步取、同拍同步读** ⇒
  // **身份还没回来时到达的群消息即使 @ 了也被判成"没 @"而无声丢弃**。
  // （真机形态＝热重载/重连后飞书补推的那一批：`ready` 与积压事件落在同一次 readOutput、
  //   且积压排在 `ready` 前面时，身份还没取回来。首启/稳态不受影响——helper 一上线就预热身份。）
  // 本用例锁四条：① 身份未回前到达的带 @ 消息不丢（扣住→身份到位→按序重投→真建卡）
  //              ② 没 @ 忽略 ③ @ 别的 bot 忽略 ④ 身份取不到 ⇒ 明说丢弃、不静默、不崩。
  const GROUP77 = 'oc_group77_test'
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{
      name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
      reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true,
    }],
  }, null, 2))
  let seq77 = 24000
  let turns77 = 0
  // 用例 76 收尾时把活体列表清空了 ⇒ 这里重新登记，否则群消息找不到 agent（连回合都起不来）
  liveAgents.push(agent)
  agent.send = function (message) {
    this.sent.push(message)
    turns77 += 1
    agentEvents.push({
      type: 'assistant/message', seq: ++seq77,
      data: { message: { content: [{ type: 'text', text: '群答复-G77-' + turns77 }] } },
    })
  }
  const feedGroup77 = (msgId, text, mentions) => {
    fakeProc.output += JSON.stringify({
      type: 'event', eventType: 'im.message.receive_v1',
      data: {
        message: {
          message_id: msgId, message_type: 'text', chat_type: 'group',
          chat_id: GROUP77, content: JSON.stringify({ text }),
          ...(mentions ? { mentions } : {}),
        },
        sender: { sender_id: { open_id: 'ou_human_77' } },
      },
    }) + '\n'
  }
  const newCards = (mark) => cardsSince(mark).filter((c) => c.payload && c.payload.schema === '2.0')

  // 换新实例（=真机的一次热重载）⇒ bot 对象全新、身份尚未解析。
  // ⚠️ 时序（第一版踩了 ⇒ 我曾据此说成"冷启动第一条必丢"，那是**说重了**）：helper 一连上就
  //   吐一行 `ready`，而 `ready` 同样走 handleHelperMessage ⇒ 顶部的身份预热通常**先**把
  //   open_id 取回来，真群消息到达时身份已经在了。
  //   真正会丢的是「**身份还没回来就已经到达**」那批 —— 典型形态是同一次 readOutput 里排在
  //   `ready` **之前**的积压（重连/热重载后飞书补推的事件）。所以这里必须把群消息**压在
  //   apply 之前**入队，让它与 ready 落在同一批、且排在 ready 前面，才测得到这条缝。
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const infoMark77 = botInfoCalls
  const markA77 = sentCards.length
  const logA77 = consoleLines.length
  feedGroup77('om_group77_at', '冷启动第一条要处理-77', GROUP_MENTION)
  const mod77 = await import('../index.js')
  mod77.apply(ctx)
  await settle(5)
  const winA77 = consoleLines.slice(logA77)
  ok(winA77.some((l) => l.includes('bot open_id resolved')),
    '（前提）本代确实去取了 bot 身份（判据要有出处，不是猜它解析过）')
  ok(botInfoCalls - infoMark77 === 1,
    '★ 同一批只打**一个**身份请求 —— 群判据的"扣住等重投"与 ready 的预热共用在途请求（各打一次＝白问两遍）')
  ok(winA77.some((l) => l.includes('held pending bot open_id'))
    && winA77.some((l) => l.includes('replaying held group msgs')),
    '★★ 身份未回前到达的群消息被**扣住后按序重投**（旧实现当场判「没 @」丢进黑洞）')
  ok(newCards(markA77).length >= 1 && JSON.stringify(newCards(markA77)).includes('群答复-G77-1'),
    '★★★ 重投真的跑成了回合并在飞书建了卡（只留日志不算修好）')

  // ② 身份已到位：没 @ ⇒ 忽略
  const markB77 = sentCards.length
  const logB77 = consoleLines.length
  feedGroup77('om_group77_noat', '群里没艾特的闲聊-77')
  await settle(3)
  ok(consoleLines.slice(logB77).some((l) => l.includes('group msg without @bot ignored')),
    '★ 群里没 @ 的消息被忽略并留痕（CM 定的规则本体）')
  ok(newCards(markB77).length === 0,
    '★ 没 @ ⇒ 一张卡都不建（群里多 bot 互刷的根就断在这里）')

  // ③ @ 的是别的 bot ⇒ 不算 @ 我
  const markC77 = sentCards.length
  feedGroup77('om_group77_other', '叫另一个机器人的-77',
    [{ key: '@_user_2', id: SMOKE_OTHER_BOT_ID, name: '别的机器人' }])
  await settle(3)
  ok(newCards(markC77).length === 0,
    '★ 判据认的是**本 bot 的 open_id/名字**，不是"群里出现过任何 @"（@ 别的 bot 必须不理）')

  // ④ 部分客户端只把 mentions 塞在 content 里 ⇒ 判据也要认
  const markD77 = sentCards.length
  fakeProc.output += JSON.stringify({
    type: 'event', eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: 'om_group77_incontent', message_type: 'text', chat_type: 'group',
        chat_id: GROUP77,
        content: JSON.stringify({ text: '内容里带@-77', mentions: GROUP_MENTION }),
      },
      sender: { sender_id: { open_id: 'ou_human_77' } },
    },
  }) + '\n'
  await settle(4)
  ok(newCards(markD77).length >= 1 && JSON.stringify(newCards(markD77)).includes('群答复-G77-2'),
    '★ content 内嵌 mentions 也算 @ 到我（只看消息级字段会漏掉这类客户端 ⇒ CM @ 了却没反应）')

  // ⑤ 身份取不到 ⇒ 按 fail-closed 丢弃，但必须**说清楚**（不许静默吞消息）
  botInfoShouldFail = true
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 同上 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod77b = await import('../index.js')
  mod77b.apply(ctx)
  await settle(2)
  const markE77 = sentCards.length
  const logE77 = consoleLines.length
  feedGroup77('om_group77_noid', '身份取不到时不该有卡-77', GROUP_MENTION)
  await settle(4)
  const winE77 = consoleLines.slice(logE77)
  ok(winE77.some((l) => l.includes('group msgs dropped (bot open_id unresolved)')),
    '★ 取不到身份时扣住的消息**明确丢弃并留痕**（静默吞=下次照样查不到）')
  ok(newCards(markE77).length === 0,
    '★ 取不到身份按 fail-closed 走：不建卡（宁可不理，不可互刷）')
  botInfoShouldFail = false
}


console.log('78) ★ 同群**双 bot** 提问卡互不串扰（清单#3「单独验证」：文字按 chat+bot 分键、按钮按 token）')
{
  // 被守护的 bug（交接清单#3）：`pendingQuestions` 原先按 **chatId** 单键 ⇒ 同一个群里
  //   后弹的那张提问卡 `set(chatId)` **覆盖**前一张的 record，先那张卡点按钮/回文字都"没反应"，
  //   而且回答会被**另一个 bot** 的 record 吃掉（连"已收到"回执都发在错的 bot 身份上）。
  //   0.7.22 修法两条通道：文字回答按 `appId|chatId` 分键；卡片按钮改按 token 索引。
  //   ⇒ 只有把两个 bot 装进同一个群、各挂一张提问卡，才测得出这条缝。
  const CFG78 = join(process.env.FS_CONFIG_DIR, 'feishu.config.json')
  const APP2 = 'cli_second_bot78'
  const GROUP78 = 'oc_group78_shared'
  writeFileSync(CFG78, JSON.stringify({
    bots: [
      { name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET, reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true },
      { name: 'smoke2', workspace: WORKSPACE, appId: APP2, appSecret: 'secret-78b', reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true },
    ],
  }, null, 2))
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 卸载副作用不关心 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod78 = await import('../index.js')
  mod78.apply(ctx)
  await settle(3)

  agent.send = function (message) { this.sent.push(message) }
  agent.whenIdle = async () => undefined
  const proc78b = extraProcs.get(APP2)
  ok(Boolean(proc78b), '（前提）第二个 bot 起了**自己的** helper 通道（同群双 bot 场景成立；否则串扰无法测）')

  // 两个 bot 各自在**同一个群**里被 @ 一次 ⇒ 各建一个会话（会话 id 是归属钥匙）
  const feed78 = (proc, msgId, text) => {
    proc.output += JSON.stringify({
      type: 'event', eventType: 'im.message.receive_v1',
      data: {
        message: {
          message_id: msgId, message_type: 'text', chat_type: 'group', chat_id: GROUP78,
          content: JSON.stringify({ text }), mentions: GROUP_MENTION,
        },
        sender: { sender_id: { open_id: 'ou_human_78' } },
      },
    }) + '\n'
  }
  feed78(fakeProc, 'om_group78_a', 'bot甲开会话-78')
  await settle(4)
  const sessA = createdSessionIds[createdSessionIds.length - 1]
  feed78(proc78b || fakeProc, 'om_group78_b', 'bot乙开会话-78')
  await settle(4)
  const sessB = createdSessionIds[createdSessionIds.length - 1]
  ok(Boolean(sessA) && Boolean(sessB) && sessA !== sessB,
    '（前提）同群里两个 bot 各自建了会话（' + sessA + ' / ' + sessB + '）')

  // 各挂一张提问卡：agent 对象按**会话 id** 构造（findChatForAgent 靠它认归属）
  const agentA = { id: sessA, ctx: agentCtx, session: agent.session }
  const agentB = { id: sessB, ctx: agentCtx, session: agent.session }
  const QA = [{ id: 'q78-a', question: 'bot甲的问题-78', options: [{ label: '甲选项一' }, { label: '甲选项二' }] }]
  const QB = [{ id: 'q78-b', question: 'bot乙的问题-78', options: [{ label: '乙选项一' }, { label: '乙选项二' }] }]
  const capture78 = (runs) => Promise.all(runs.map((r) => Promise.resolve(r)
    .then((value) => ({ value }), (error) => ({ error: String((error && error.message) || error) }))))
  const markQ78 = sentCards.length
  let doneA = null, doneB = null
  void capture78(emitCtx('tools/execute',
    { name: 'ask_user_question', agent: agentA, arguments: { questions: QA }, signal: undefined },
    () => Promise.resolve('next'))).then((os) => { doneA = os })
  await settle(3)
  void capture78(emitCtx('tools/execute',
    { name: 'ask_user_question', agent: agentB, arguments: { questions: QB }, signal: undefined },
    () => Promise.resolve('next'))).then((os) => { doneB = os })
  await settle(3)

  const qCards = cardsSince(markQ78).filter((c) => c.op === 'create'
    && JSON.stringify(c.payload).includes('需要你的回答'))
  const cardA = qCards.find((c) => c.app === APP_ID)
  const cardB = qCards.find((c) => c.app === APP2)
  ok(Boolean(cardA) && Boolean(cardB),
    '（前提）两张提问卡各归各的 bot（建卡归属 app 分明：' + qCards.map((c) => c.app).join(',') + '）')
  // token 从卡面 JSON 里直接抓（而不是按 `columns[i].elements[0].behaviors[0]` 的固定形状取）：
  //   提问卡按选项数排版，分栏结构会变；第一版按固定下标取，取到 undefined 直接把整个冒烟进程崩掉。
  const tokenOf = (row) => {
    const m = /"fs_question":"([^"]+)"/.exec(JSON.stringify((row && row.payload) || {}))
    return m ? m[1] : ''
  }
  const tokenB = tokenOf(cardB)
  ok(Boolean(tokenB), '（前提）从 bot 乙的提问卡里取到回传 token（按钮路径的钥匙）')

  // ① 文字回答**只送到甲的连接**：旧实现（按 chatId 单键）会结掉"最后 set 的那条"＝乙的 record
  const markAns78 = sentCards.length
  feed78(fakeProc, 'om_group78_answer', '甲选项一')
  await settle(4)
  ok(doneA !== null, '★ 甲的连接收到文字回答 ⇒ **甲**的提问真的被结掉（旧实现：甲那条回答没有交给甲，反而被乙抢走）')
  ok(doneB === null,
    '★★ 乙的提问**没有**被同群那条回答顺手结掉（按 appId|chatId 分键的本体；实际 doneB=' + (doneB === null ? 'null' : 'resolved') + '）')
  const ansWin = sentCards.slice(markAns78)
  ok(ansWin.some((c) => c.op === 'create' && c.app === APP_ID
      && JSON.stringify(c.payload).includes('已收到你的回答')),
    '★ 「✅ 已收到你的回答」发在**甲**的身份上（回执没串到乙的 app）')
  const touchedB = ansWin.filter((c) => c.op === 'update' && cardB && c.msgId === cardB.msgId)
  ok(touchedB.length === 0,
    '★ 甲的回答没有去改乙那张卡（乙卡 msgId=' + (cardB && cardB.msgId) + ' 被 PATCH ' + touchedB.length + ' 次）')

  // ② 按钮路径按 token：点乙的卡 ⇒ 结乙、封口乙的卡，不碰甲
  const markTap78 = sentCards.length
  ;(proc78b || fakeProc).output += JSON.stringify({
    type: 'event', eventType: 'card.action.trigger',
    data: {
      action: { tag: 'button', value: { fs_question: tokenB, fs_option: 1 } },
      context: { open_chat_id: GROUP78 },
    },
  }) + '\n'
  await settle(4)
  ok(doneB !== null, '★ 点乙卡上的按钮 ⇒ **乙**的提问按 token 被结掉（不再依赖"猜哪个 bot"）')
  const tapWin = sentCards.slice(markTap78)
  ok(tapWin.some((c) => c.op === 'update' && c.app === APP2 && cardB
      && c.msgId === cardB.msgId && JSON.stringify(c.payload).includes('乙选项二')),
    '★ 乙的卡封口成「已收到你的选择：乙选项二」（写在自己那张卡、自己的 app 身份上）')
  ok(!tapWin.some((c) => c.op === 'update' && cardA && c.msgId === cardA.msgId),
    '★ 点乙的按钮没有动甲那张卡')

  // 收尾：回到单 bot 配置，后面的用例不受本次换代影响
  writeFileSync(CFG78, JSON.stringify({
    bots: [{
      name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
      reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true,
    }],
  }, null, 2))
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 同上 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod78b = await import('../index.js')
  mod78b.apply(ctx)
  await settle(2)
  liveAgents.length = 0
  // 第四轮门槛 LOW：双 bot 夹具留下的**次 bot 进程**必须在这里清掉 —— 否则它带着
  //   未读完的 output 常驻模块级状态，后面的用例若再碰到同一个/别的 appId，
  //   那批残留会被当成"入站事件"吐给插件 ⇒ 结果依赖用例顺序（假绿灯/假红灯都可能）。
  extraProcs.clear()
}

console.log('79) ★ 托孤的结论卡**建不出来**时结论必须仍送达（独立审查 HIGH 的正身：兜底路径原来不可达）')
{
  // HIGH 原判定：`relayCreateFallback` 只在 `!bot` 分支被调用，而它内部又用 `findBotForChat`
  //   **重新解析**同一个 chatId ⇒ 同拍必然还是 undefined ⇒ 两条兜底分支**全不可达**，
  //   结论被静默丢弃（注释却承诺"会退化到纯文本"）。
  //   0.7.22 修法：把**已解析的 bot** 传进去，并在唯一可达的路径（新代 POST 建卡失败）上
  //   检查 `token`/`rescued` 后调用兜底。本用例把那条路径钉住：建卡失败 ⇒ 结论写回过程卡、
  //   且指路语必须一起摘掉（否则卡上既说"见下方卡片"又自己挂着正文）。
  const cards79 = globalThis.__fsLiveCards
  let release79
  const gate79 = new Promise((r) => { release79 = r })
  const prevIdle79 = agent.whenIdle
  agent.whenIdle = () => gate79
  agent.send = function (message) { this.sent.push(message) }
  agent.status = 'running'
  liveAgents.push(agent)
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'   // 强制走"结论独立成卡"那条分叉

  const mark79 = sentCards.length
  feedInbound('om_relayfail_79', '托孤建卡失败-79')
  await settle(3)
  const procCards79 = createsSince(mark79)
  ok(procCards79.length >= 1, '（前提）过程卡已建出来（兜底要写回的就是它）')
  agentEvents.push({
    type: 'assistant/message', seq: 94001,
    data: { message: { content: [{ type: 'text', text: '建卡失败也要送达的结论-79' }] } },
  })
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 同上 */ } }
  effectCleanups.length = 0   // 十三轮 MED#4：disposer 清单必须随代清零（否则旧代每次重载都被再 dispose 一遍）
  globalThis.__fsReloadHint = null
  const mod79 = await import('../index.js')
  mod79.apply(ctx)
  await settle(2)
  ok(Boolean(cards79.get(String(agent.id))), '（前提）本代接管了这张卡（这一轮还在跑）')

  // 新代 POST 建结论卡时**失败**：返回体没有 message_id ⇒ token 空、也没走 rescueText
  createReturnsEmptyId = true
  const logMark79 = consoleLines.length
  const sentMark79 = sentCards.length
  agent.status = 'idle'
  release79()
  await settle(5)
  createReturnsEmptyId = false

  const win79 = consoleLines.slice(logMark79)
  const late79 = sentCards.slice(sentMark79)
  ok(win79.some((l) => l.includes('conclusion split')),
    '（前提）旧代走到了"结论独立成卡"的分叉（托孤登记的就是这次建卡）')
  // 判据必须是 **PATCH**（真的写到了飞书那张卡上），不能只看"窗口里出现过这段文字"——
  //   建卡失败那一次 POST 的**请求体**本身就带着结论，反证跑（旧实现）里它也出现，却什么都没送达。
  const degraded79 = late79.filter((c) => c.op === 'update'
    && JSON.stringify(c.payload).includes('建卡失败也要送达的结论-79'))
  ok(degraded79.length >= 1,
    '★★ HIGH 正身：结论卡建不出来，结论**仍然被推到了飞书**（写回过程卡），不是静静丢掉（更新数=' + degraded79.length + '）')
  ok(degraded79.every((c) => !JSON.stringify(c.payload).includes('结论见下方卡片')),
    '★ 写回正文时把「结论见下方卡片」那句指路语摘掉了（否则卡上自相矛盾）')
  ok(win79.some((l) => l.includes('relayed card create degraded onto the process card')),
    '★ 降级动作留了痕（真机能一眼看出这张卡是兜底形态，不是正常分卡）')

  // 收尾（同 76）：不留活 watcher / running 卡给后面的用例
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  agent.whenIdle = prevIdle79
  delete agent.status
  liveAgents.length = 0
  const tail79 = cards79.get(String(agent.id))
  if (tail79 && tail79.card && tail79.card.status === 'running') {
    const clock79 = useFakeClock()
    await forceOrphanSeal(clock79)
    clock79.restore()
  }
}

console.log('80) ★ 托孤建卡的 POST **在飞途中本代又被 dispose** ⇒ 不许降级（否则同一个结论发两次）')
{
  // 复跑审查 MEDIUM 的正身：G2 接过队列、把结论卡 POST 出去（请求在飞）→ 这一期间 G2 也被
  //   热重载掐掉 → syncCard 的 catch 走 `handing to next generation`，把同一张卡**再排一次队**
  //   并**正常返回** ⇒ 外层 `.then` 照样看到 `!token`，旧写法就在这里降级写回过程卡；
  //   而 G3 随后又会把这张卡真建出来 ⇒ 同一段结论同时挂在过程卡和新结论卡上。
  //   这正是本包反复消灭的「一个内容发两次」，所以必须钉住：在队里 = 会送达 = 不降级。
  const cards80 = globalThis.__fsLiveCards
  let release80
  const gate80 = new Promise((r) => { release80 = r })
  const prevIdle80 = agent.whenIdle
  agent.whenIdle = () => gate80
  agent.status = 'running'
  liveAgents.push(agent)
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'

  const mark80 = sentCards.length
  feedInbound('om_inflight_80', '在飞途中换代的结论-80')
  await settle(3)
  ok(createsSince(mark80).length >= 1, '（前提）过程卡已建出来（降级会写回它）')
  agentEvents.push({
    type: 'assistant/message', seq: 94101,
    data: { message: { content: [{ type: 'text', text: '在飞途中换代的结论-80' }] } },
  })
  // G1 被掐掉、G2 接手（托孤队列跨代共享：globalThis.__fsCardRelay）
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 同 78 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod80a = await import('../index.js')
  mod80a.apply(ctx)
  await settle(2)
  ok(Boolean(cards80.get(String(agent.id))), '（前提）G2 接管了这张卡（这一轮还在跑）')

  // G2 一发起建卡就卡住 ⇒ 测试在"请求在飞"的窗口里把 G2 也换掉
  let releaseHang
  createHangGate = { promise: new Promise((r) => { releaseHang = r }) }
  createThrowAfterHang = true
  const logMark80 = consoleLines.length
  const sentMark80 = sentCards.length
  agent.status = 'idle'
  release80()
  await settle(3)
  const inflight = sentCards.slice(sentMark80)
    .filter((c) => c.op === 'create' && JSON.stringify(c.payload).includes('在飞途中换代的结论-80'))
  ok(inflight.length >= 1, '（前提）G2 确实把建卡请求发出去了（在飞、被闸门卡住）')

  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 同上 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod80b = await import('../index.js')
  mod80b.apply(ctx)
  await settle(2)
  // 放行：这一次建卡**失败**（瞬时故障那一类，不触发 rescueText）；之后的建卡恢复正常
  createThrowAfterHang = false
  createHangGate = null
  releaseHang()
  await settle(6)

  const win80 = consoleLines.slice(logMark80)
  const late80 = sentCards.slice(sentMark80)
  const dupPatch80 = late80.filter((c) => c.op === 'update'
    && JSON.stringify(c.payload).includes('在飞途中换代的结论-80'))
  ok(dupPatch80.length === 0,
    '★★ 卡片已被重新托孤（还会被送出去）⇒ 这次**不许**降级写回过程卡（实际写回数='
    + dupPatch80.length + '，>0 就是"同一个结论发两次"）')
  ok(win80.some((l) => l.includes('re-queued mid-flight, not degrading')),
    '★ 留痕：识别出"在飞途中被 dispose ⇒ 已重新排队"并放弃降级')
  const built80 = late80.filter((c) => c.op === 'create' && c.msgId
    && JSON.stringify(c.payload).includes('在飞途中换代的结论-80'))
  ok(built80.length === 1,
    '★ 结论卡由 G3 **建成一张**（内容没因为绕这一圈就丢；实际建成=' + built80.length + '）')
  ok(win80.some((l) => l.includes('handing to next generation')),
    '★ 走的就是 dispose 分支那条重排队路径（前提条件成立，不是绕过去了）')

  // 收尾（同 79）
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  agent.whenIdle = prevIdle80
  delete agent.status
  liveAgents.length = 0
  const tail80 = cards80.get(String(agent.id))
  if (tail80 && tail80.card && tail80.card.status === 'running') {
    const clock80 = useFakeClock()
    await forceOrphanSeal(clock80)
    clock80.restore()
  }
}

console.log('81) ★ 托孤补发要按**入队时记的 appId** 还原卡片主人（独立审查 MED：同群双 bot 时"按会话猜"会建错身份）')
{
  // 被守护的缺陷：`drainCardRelay` 解析 bot 用的是 `(it.appId && bots.get(it.appId)) || findBotForChat(it.chatId)`。
  //   单 bot 用例里这两个表达式返回**同一个对象** ⇒ 写成 `bots.get(it.chatId)`、或条目丢了 appId，
  //   全套冒烟照样绿；而在真机的"同一个群里挂了两个 bot"形态下，`findBotForChat` 返回配置里
  //   **第一个**命中的 bot ⇒ 乙那一轮的结论卡会被建到**甲**的身份上（串扰，CM 报过的那类）。
  //   ⇒ 必须造一个"两位解析者结果不同"的夹具：甲也认识这个群（排在前面），回合却归乙。
  const CFG81 = join(process.env.FS_CONFIG_DIR, 'feishu.config.json')
  const APP2 = 'cli_second_bot81'
  const GROUP81 = 'oc_group81_relay'
  writeFileSync(CFG81, JSON.stringify({
    bots: [
      { name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET, reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true },
      { name: 'smoke2', workspace: WORKSPACE, appId: APP2, appSecret: 'secret-81b', reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true },
    ],
  }, null, 2))
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 卸载副作用不关心 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod81a = await import('../index.js')
  mod81a.apply(ctx)
  await settle(3)
  const proc81b = extraProcs.get(APP2)
  ok(Boolean(proc81b), '（前提）第二个 bot 起了**自己的** helper 通道（否则"按会话猜"根本没机会出错）')

  const feed81 = (proc, msgId, text) => {
    proc.output += JSON.stringify({
      type: 'event', eventType: 'im.message.receive_v1',
      data: {
        message: {
          message_id: msgId, message_type: 'text', chat_type: 'group', chat_id: GROUP81,
          content: JSON.stringify({ text }), mentions: GROUP_MENTION,
        },
        sender: { sender_id: { open_id: 'ou_human_81' } },
      },
    }) + '\n'
  }

  // ① 甲：带 @ 的**命令**消息 ⇒ 登记这个群但**不起回合**（`/help` 在 handleInbound 之前就分流走了）。
  //    这一步是让 `findBotForChat(GROUP81)` 归到**甲**（配置里排第一），从而与 `bots.get(APP2)` 不同。
  feed81(fakeProc, 'om_group81_help', '/help')
  await settle(4)

  // ② 乙：真正的一轮（托孤的就是它的结论卡）
  agent.send = function (message) { this.sent.push(message) }
  const prevIdle81 = agent.whenIdle
  let release81
  const gate81 = new Promise((r) => { release81 = r })
  agent.whenIdle = () => gate81
  agent.status = 'running'
  liveAgents.push(agent)
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'

  const mark81 = sentCards.length
  feed81(proc81b, 'om_group81_turn', '托孤归属-81')
  await settle(4)
  const proc81Cards = sentCards.slice(mark81).filter((c) => c.op === 'create' && c.payload && c.payload.schema === '2.0')
  ok(proc81Cards.some((c) => c.app === APP2),
    '（前提）乙这一轮的过程卡建在**乙**的身份上（app=' + proc81Cards.map((c) => c.app).join(',') + '）')
  agentEvents.push({
    type: 'assistant/message', seq: 94201,
    data: { message: { content: [{ type: 'text', text: '托孤归属结论-81' }] } },
  })

  // G1 被掐掉、G2 接手（这一代来收尾）
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 同上 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod81b = await import('../index.js')
  mod81b.apply(ctx)
  await settle(2)
  ok(Boolean(globalThis.__fsLiveCards.get(String(agent.id))), '（前提）G2 接管了乙这一轮的卡（回合还在跑）')

  // G2 一发建卡请求就卡住 ⇒ 在"请求在飞"的窗口里把 G2 也换掉 ⇒ 条目带着 appId=APP2 进队列
  let releaseHang81
  createHangGate = { promise: new Promise((r) => { releaseHang81 = r }) }
  createThrowAfterHang = true
  const logMark81 = consoleLines.length
  const sentMark81 = sentCards.length
  agent.status = 'idle'
  release81()
  await settle(3)

  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 同上 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod81c = await import('../index.js')
  mod81c.apply(ctx)
  await settle(2)
  createThrowAfterHang = false
  createHangGate = null
  releaseHang81()
  await settle(6)

  const win81 = consoleLines.slice(logMark81)
  const late81 = sentCards.slice(sentMark81)
  // 🔴 门槛（第十二轮 MEDIUM）：必须要求 `c.msgId`。夹具在 create 分支是**先落 sentCards、
  //   后过闸门/抛错**（见上面 mock 的注释："只有真拿到 message_id 才写 msgId，失败分支留空"），
  //   而 G2 那一次故意 mid-flight 失败的建卡**同样带 app=APP2** ⇒ 不加 msgId 时下面三条
  //   断言在"G3 补发根本没建出卡"的情况下照样全绿＝本用例要钉的那条 MED 回归变成假绿灯。
  const relay81 = late81.filter((c) => c.op === 'create' && c.msgId
    && JSON.stringify(c.payload).includes('托孤归属结论-81'))
  ok(win81.some((l) => l.includes('handing to next generation')),
    '（前提）走的就是 dispose 重排队那条路（条目是带着 appId 入队的）')
  ok(relay81.length >= 1,
    '★★ 托孤补发把结论卡建了出来（内容没因为绕这一圈就丢；实际建卡=' + relay81.length + '）')
  ok(relay81.every((c) => c.app === APP2),
    '★★★ MED 正身：补发用的是**入队时记的 appId**（乙）—— 全部 ' + relay81.length
    + ' 次建卡的 app=' + relay81.map((c) => c.app).join(',') + '）')
  ok(!relay81.some((c) => c.app === APP_ID),
    '★★★ 没有按会话猜身份、把乙的结论卡建到甲的 app 上（findBotForChat 在这个群里返回的是甲）')

  // 收尾：回到单 bot 配置 + 清掉次 bot 通道，后面的用例不受影响
  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  agent.whenIdle = prevIdle81
  delete agent.status
  liveAgents.length = 0
  extraProcs.clear()
  writeFileSync(CFG81, JSON.stringify({
    bots: [{
      name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
      reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true,
    }],
  }, null, 2))
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 同上 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod81d = await import('../index.js')
  mod81d.apply(ctx)
  await settle(2)
  const tail81 = globalThis.__fsLiveCards.get(String(agent.id))
  if (tail81 && tail81.card && tail81.card.status === 'running') {
    const clock81 = useFakeClock()
    await forceOrphanSeal(clock81)
    clock81.restore()
  }
}

console.log('82) ★ 结论写回过程卡的那次 PATCH **失败** ⇒ 退避到点必须有人再推（第五轮门槛 HIGH 正身）')
{
  // HIGH 原判定（复跑后**范围比报告更大**）：`syncCard` 失败时只把 `retryUntil` 记在卡上，
  //   **没有任何人会再推它**。于是这条链路整个断死：
  //   封口 → 结论卡建不出来 → `conclusion card failed, falling back to single card`
  //   → 结论 append 到过程卡 → 这次 PATCH 栽在网络/5xx（不属 rejected/toolarge，不触发内部 rescueText）
  //   → 卡进入退避 → 之后所有推送（含 force）被 retryUntil 入口闸静默吞掉
  //   → 而 runTurn 那边 `cardDelivered` 只看"有 token 且未熔断"= true ⇒ 连纯文本兜底都不发
  //   ⇒ 用户看到"卡片不动了"，正文一个字都没到（真·静默丢失）。
  //   0.7.22 修法：**退避定时器**（scheduleCardRetry）—— 到点自动 force 重推同一张卡
  //   （PATCH 幂等，不会再开一张卡）；同时 `relayCreateFallback` 认这条"稍后会到"，不再重复发纯文本。
  const CONCL82 = '降级没送达也要落正文-82'
  const cards82 = globalThis.__fsLiveCards
  // 用**活着的单 bot 代**跑完整回合：封口 → 结论卡建不出来 → 写回过程卡 → 那次 PATCH 失败。
  //   不像 79/80 那样在封口前换代 —— 这里要的就是"过程卡没被托孤、此后只剩退避定时器"那个形态。
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{
      name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
      reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true,
    }],
  }, null, 2))
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 同上 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod82 = await import('../index.js')
  mod82.apply(ctx)
  await settle(3)

  let release82
  const gate82 = new Promise((r) => { release82 = r })
  const prevIdle82 = agent.whenIdle
  agent.whenIdle = () => gate82
  agent.send = function (message) { this.sent.push(message) }
  agent.status = 'running'
  liveAgents.push(agent)
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'

  const mark82 = sentCards.length
  feedInbound('om_degradefail_82', '降级未送达要转纯文本-82')
  await settle(3)
  ok(createsSince(mark82).length >= 1, '（前提）过程卡已建出来（写回要用的就是它）')
  agentEvents.push({
    type: 'assistant/message', seq: 94301,
    data: { message: { content: [{ type: 'text', text: CONCL82 }] } },
  })

  // 两条失败同时注入：① 结论卡**建不出来**（返回体没有 message_id）⇒ 走单卡回退；
  //   ② 回退写回过程卡的那次 PATCH **抛错**（按正文片段锁定，不误伤封口那次）。
  createReturnsEmptyId = true
  failPatchContaining = CONCL82
  const logMark82 = consoleLines.length
  const sentMark82 = sentCards.length
  agent.status = 'idle'
  release82()
  // 退避是 CARD_RETRY_BASE×2^0 = 1s，定时器再 +50ms ⇒ settle(8)（≈4.8s 真实时间）足够跨过去。
  await settle(8)
  createReturnsEmptyId = false
  failPatchContaining = ''

  const win82 = consoleLines.slice(logMark82)
  const late82 = sentCards.slice(sentMark82)
  ok(win82.some((l) => l.includes('conclusion card failed, falling back to single card')),
    '（前提）确实走了"结论卡建不出来 ⇒ 写回过程卡"这条回退')
  ok(win82.some((l) => l.includes('card sync failed') && l.includes('retry=')),
    '（前提）写回那次 PATCH 确实失败并进入退避（失败不落 sentCards，只能从日志确认）')
  ok(win82.some((l) => l.includes('retrying deferred card sync')),
    '★ HIGH 正身：退避到点**有人再推**（旧实现只把 retryUntil 记在卡上，此后再无人推 ⇒ 静默丢失）')
  // 送达判据用**形状**：真正送达 = 一次成功的 PATCH（失败的注入不落 sentCards）。
  const fixed82 = late82.filter((c) => c.op === 'update' && JSON.stringify(c.payload).includes(CONCL82))
  ok(fixed82.length === 1,
    '★★ 结论**真的到了飞书**：含正文的成功 PATCH 恰好一次（实际=' + fixed82.length
    + '，0=退避后无人再推，>1=重复推送）')
  // 纯文本兜底发的是**旧式卡**（无 schema:2.0）⇒ 用它判"一个内容发两次"。
  const plain82 = late82.filter((c) => c.op === 'create' && !c.payload.schema
    && JSON.stringify(c.payload).includes(CONCL82))
  ok(plain82.length === 0,
    '★★★ 定时器接管后**不再重复发纯文本**（实际=' + plain82.length + '，>0=同一内容送达两次）')
  ok(!win82.some((l) => l.includes('relayed card degrade not delivered')),
    '已安排退避重推的卡不会被判成"没送达"（willBeRetried 那条判据在位）')

  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  agent.whenIdle = prevIdle82
  delete agent.status
  liveAgents.length = 0
  const tail82 = cards82.get(String(agent.id))
  if (tail82 && tail82.card && tail82.card.status === 'running') {
    const clock82 = useFakeClock()
    await forceOrphanSeal(clock82)
    clock82.restore()
  }
}

// 🔴 中台 #61/#62（第三十五轮）：托孤卡的 token 后 8 位记下来，供**收尾**的可判定断言用
//   （本用例的送达窗口远早于接力真正到期的时刻，只能在末尾核）。
let relayTok84 = ''
console.log('84) ★ 托孤降级的最后防线：过程卡**推不动**（退避未到）⇒ 必须改走纯文本（第四轮门槛 LOW 的分支）')
{
  // 第四轮门槛 LOW#5 原话：用例 79 只钉住了 `relayed card create degraded onto the process card`
  //   这一条降级分支，而**同批新增**的另一条 —— `holderPushable === false ⇒ degraded to plain text`
  //   —— 没有任何断言。若 `holderPushable` 的判据写反（比如把 `retryUntil` 的比较方向弄错），
  //   结论就会又回到"append 进内存、一个字没到"的静默丢失，而整套冒烟照样绿。
  //   本用例把"过程卡在退避窗口内"这个形态造出来（直接把 retryUntil 拨到将来），
  //   断言结论**改由纯文本送达**、且没有那次成功的 PATCH。
  // 标识符后缀与用例号对齐（第五轮门槛 LOW：整块沿用 83 而日志号是 84，且全文件
  //   不存在 `83)` 用例 ⇒ 从断言消息反查源码时对不上号）。
  const CONCL84 = '推不动过程卡也要落正文-84'
  const cards84 = globalThis.__fsLiveCards
  let release84
  const gate84 = new Promise((r) => { release84 = r })
  const prevIdle84 = agent.whenIdle
  agent.whenIdle = () => gate84
  agent.send = function (message) { this.sent.push(message) }
  agent.status = 'running'
  liveAgents.push(agent)
  process.env.DSH_FEISHU_SPLIT_MIN_MS = '0'

  const mark84 = sentCards.length
  feedInbound('om_nomickpush_84', '过程卡推不动-84')
  await settle(3)
  ok(createsSince(mark84).length >= 1, '（前提）过程卡已建出来（它就是那颗"推不动"的卡）')
  agentEvents.push({
    type: 'assistant/message', seq: 94401,
    data: { message: { content: [{ type: 'text', text: CONCL84 }] } },
  })
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具残留不影响下一用例 */ } }
  effectCleanups.length = 0   // 十三轮 MED#4：disposer 清单必须随代清零（否则旧代每次重载都被再 dispose 一遍）
  globalThis.__fsReloadHint = null
  const mod84 = await import('../index.js')
  mod84.apply(ctx)
  await settle(2)
  const holder84 = cards84.get(String(agent.id)) && cards84.get(String(agent.id)).card
  ok(Boolean(holder84 && holder84.token), '（前提）接管到的过程卡有 token（降级候选的就是它）')
  // 前提不成立时**记失败并跳过**，不许在这里抛 TypeError 打挂整个 smoke 进程
  // （第六轮门槛 LOW：一旦 84 的接管没成，后面所有用例会跟着被跳过，看起来"只剩一条红"）。
  if (holder84) {
    // 直接把过程卡拨进退避窗口 —— 这正是 `holderPushable` 要拦的形态（syncCard 对 force 也照样吞）。
    holder84.retryUntil = Date.now() + 60000
    relayTok84 = String(holder84.token || '').slice(-8)
  } else {
    ok(false, '（前提）接管到的过程卡对象存在（拿不到就无法制造 holderPushable=false 的形态）')
  }

  createReturnsEmptyId = true
  const logMark84 = consoleLines.length
  const sentMark84 = sentCards.length
  agent.status = 'idle'
  release84()
  await settle(5)
  createReturnsEmptyId = false

  const win84 = consoleLines.slice(logMark84)
  const late84 = sentCards.slice(sentMark84)
  ok(win84.some((l) => l.includes('relayed card create degraded to plain text')),
    '★ LOW#5 正身：过程卡推不动时走的是**纯文本**那条最后防线（不是 append 进内存就完事）')
  ok(late84.filter((c) => c.op === 'update' && JSON.stringify(c.payload).includes(CONCL84)).length === 0,
    '（前提）期间没有任何成功的 PATCH（退避闸门确实在拦）')
  const plain84 = late84.filter((c) => c.op === 'create' && !c.payload.schema
    && JSON.stringify(c.payload).includes(CONCL84))
  ok(plain84.length === 1,
    '★★ 结论**真的到了飞书**：纯文本恰好一次（实际=' + plain84.length + '，0=静默丢失，>1=发两次）')

  delete process.env.DSH_FEISHU_SPLIT_MIN_MS
  agent.whenIdle = prevIdle84
  delete agent.status
  liveAgents.length = 0
  const tail84 = cards84.get(String(agent.id))
  if (tail84 && tail84.card && tail84.card.status === 'running') {
    const clock84 = useFakeClock()
    await forceOrphanSeal(clock84)
    clock84.restore()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 0.8.0「agent 互认」用例（85-92）。夹具形状一律按 2026-10-05 真机取证：
//   V1 mentions[].id = **对象** {open_id,union_id,user_id}；V2 bot 消息 sender_type='bot'；
//   V3 card.action.trigger 的 operator = {user_id,open_id,union_id}；
//   V4 出站 @ 有「卡片 markdown」与「post tag:at」两条通道（post 必须包 zh_cn）。
// roster 文件按 scripts/collect_bot_roster.mjs 的真实形状写（views = {appId: ou}，主键 union_id）。
// ─────────────────────────────────────────────────────────────────────────────
const ROSTER85 = join(process.env.FS_CONFIG_DIR, 'bot_roster.json')
const GROUP85 = 'oc_smoke_group_85'
function writeRoster(rows) {
  writeFileSync(ROSTER85, JSON.stringify(Object.assign({
    generated_at: new Date().toISOString(), bots: [], people: [], chats: {},
  }, rows), null, 2))
}
// 群消息夹具（可指定 mentions / sender 形态）—— 与用例 77 同构，但带 union_id。
function feedGroup85(chatId, msgId, text, mentions, sender) {
  fakeProc.output += JSON.stringify({
    type: 'event', eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: msgId, message_type: 'text', chat_type: 'group',
        chat_id: chatId, content: JSON.stringify({ text }),
        ...(mentions ? { mentions } : {}),
      },
      sender: sender || { sender_id: { open_id: 'ou_human_85', union_id: 'on_cm' }, sender_type: 'human' },
    },
  }) + '\n'
}
const MENTION_SELF85 = {
  key: '@_user_1', id: { open_id: SMOKE_BOT_OPEN_ID, union_id: 'on_bot_self', user_id: '' },
  name: SMOKE_BOT_NAME, mentioned_type: 'bot',
}
const MENTION_B85 = {
  key: '@_user_2', id: { open_id: 'ou_empb_85', union_id: 'on_bot_b', user_id: '' },
  name: '员工B', mentioned_type: 'bot',
}
// 每个互认用例自己的回合：正文唯一标记，便于「明细有没有混进卡片」按形状判定。
function armTurn85(tag) {
  let n = 0
  agent.send = function (message) {
    this.sent.push(message)
    agentEvents.push({
      type: 'assistant/message', seq: 96000 + (++n),
      data: { message: { content: [{ type: 'text', text: '回合正文-' + tag }] } },
    })
  }
}
const schemaCards = (mark) => cardsSince(mark).filter((c) => c.payload && c.payload.schema === '2.0')
const lastSentText = () => {
  const m = agent.sent[agent.sent.length - 1]
  return m && m.content && m.content[0] ? String(m.content[0].text) : ''
}

console.log('85) ★ 互认·入站：@ 占位符还原 + 明细只进会话不进卡片 + 发送方标注（roster 认名，V1 对象形态 id）')
{
  writeRoster({
    bots: [{ name: '员工B', app_id: 'cli_briend', union_id: 'on_bot_b', views: { cli_briend: 'ou_empb_85' } }],
    people: [{ name: '陈明', union_id: 'on_cm', views: { [APP_ID]: 'ou_human_85' } }],
    chats: { [GROUP85]: { name: '测试群', bot_app_ids: [APP_ID, 'cli_briend'], member_unions: ['on_cm'] } },
  })
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod85 = await import('../index.js')
  mod85.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  armTurn85('85')
  const mark = sentCards.length
  feedGroup85(GROUP85, 'om_group85_at', '@_user_1 帮我问 @_user_2 一句-85', [MENTION_SELF85, MENTION_B85])
  await settle(4)
  const sent85 = lastSentText()
  ok(sent85.includes('@员工B'), '★ 占位符 @_user_2 还原成 @员工B（旧实现原样把占位符送进会话）')
  ok(!sent85.includes('@_user_1') && !sent85.includes('@_user_2'),
    '★ 会话里一个字节的 @_user_N 都不残留（否则 agent 永远不知道对方是谁）')
  ok(sent85.includes('@员工B(bot id=ou_empb_85)'),
    '★ 明细行带 kind=bot + id（对象形态 id 也能解析出 open_id）')
  ok(sent85.includes('【发送方】kind=user name=陈明 open_id=ou_human_85'),
    '★ 发送方标注：roster 按 union_id 认出人名（identityGuard 关时也不再贴裸 ou）')
  const cards85 = JSON.stringify(schemaCards(mark))
  ok(schemaCards(mark).length >= 1 && cards85.includes('回合正文-85'), '（前提）群里 @ 本 bot 照常成卡')
  ok(!cards85.includes('【本条 @ 的对象】') && !cards85.includes('【发送方】'),
    '★★ 明细**只进会话、绝不进卡片**（守 B3/B4 用例 61/57 的口径）')
  ok(!cards85.includes('ou_empb_85') && !cards85.includes('ou_human_85'), '★★ id 不外泄到卡片（R10 隐私）')

  // 🔴 防回归（2026-10-05 中台 #25，HOME#DSH 真机实证）：真实 open_id 是 `ou_` + 32 位 hex，
  //   老写法截成 12 位 ⇒ agent 拿去调 contact API 必报 99992351 invalid id，身份反查整条断掉。
  //   会话明细这两个字段必须是**完整** id；同时卡片那侧一个字都不能多。
  // ⚠️ 这三个值**必须是假的**：形状要真（前缀 + 32 位 hex），内容一律用 md5("dsh-smoke-*")
  //   生成，别把真机取证里的 id 抄进来 —— 本文件会随包推到公开仓库，真实 id 等于把当事人的
  //   飞书身份标识公开发出去（2026-10-05 推送前自查发现，已替换）。
  const LONG_OPEN85 = 'ou_c3ddbda6f4c9c806702c07200c2e9c45'
  const LONG_UNION85 = 'on_9f7827ce32b2f8a72faedb2a2a325de9'
  const LONG_MENT85 = 'ou_60c72dbdf6d401ae48f87595176d5714'
  const mark85L = sentCards.length
  feedGroup85(GROUP85, 'om_group85_longid', '@_user_1 长 id 复验-85L',
    [MENTION_SELF85, {
      key: '@_user_2', id: { open_id: LONG_MENT85, union_id: 'on_bot_long85', user_id: '' },
      name: '长号同事', mentioned_type: 'user',
    }],
    { sender_id: { open_id: LONG_OPEN85, union_id: LONG_UNION85 }, sender_type: 'human' })
  await settle(4)
  const sent85L = lastSentText()
  ok(sent85L.includes('open_id=' + LONG_OPEN85) && sent85L.includes('union_id=' + LONG_UNION85),
    '★★ 发送方明细带**完整** open_id/union_id（截断＝agent 侧身份反查全废，中台 #25）')
  ok(sent85L.includes('id=' + LONG_MENT85),
    '★★ @ 对象明细同样带完整 id（两套明细口径一致，不留一半截一半）')
  const cards85L = JSON.stringify(schemaCards(mark85L))
  ok(schemaCards(mark85L).length >= 1, '（前提）长 id 这条也照常成卡（不是靠没发卡蒙过下面两条）')
  ok(!cards85L.includes(LONG_OPEN85) && !cards85L.includes(LONG_MENT85) && !cards85L.includes(LONG_UNION85),
    '★★ 完整 id 绝不进卡片 —— 截断只允许出现在卡片与日志那一侧（R10/B3/B4 未松动）')
}

console.log('86) ★ 互认·入站兼容：mentions[].id 字符串老形态（部分客户端只给 key+id 字符串）')
{
  // ⚠️ 本用例原来把「字符串 id 还原」和「@bot /命令 判成命令」捆在**同一条消息**里
  //   （`@_user_1 /new 调研86`），第十三轮门槛 MEDIUM#2 修好命令锚点后**当场红两条**——
  //   红才是对的：命令一旦被正确识别就**不起回合**，那两条读的是上一轮（用例 85 长 id 那次）
  //   残留的会话文本。也就是说修复前 `createdSessions + 1` 那条绿是**假绿灯**：
  //   它是靠"命令没被识别、整串当普通文本送进 agent 并建了会话"才通过的。
  //   ⇒ 两件事拆成两条用例各判各的：本用例只管渲染，命令识别交给用例 97。
  const GROUP86 = 'oc_smoke_group_86'
  armTurn85('86')
  const mark86 = agent.sent.length
  feedGroup85(GROUP86, 'om_group86_plain', '@_user_1 老格式复验-86',
    [GROUP_MENTION[0], { key: '@_user_2', id: 'ou_old_style_86', name: '老格式同事' }])
  await settle(4)
  ok(agent.sent.length === mark86 + 1,
    '（前提）这条普通群消息真的进了会话（下面两条读的不是上一轮的残留文本）')
  const sent86 = lastSentText()
  ok(sent86.includes('@老格式同事') && !sent86.includes('@_user_2'),
    '★ 字符串形态 id 的 mention 同样还原成 @姓名（兼容部分客户端只给 key+id 字符串）')
  ok(sent86.includes('老格式同事(bot id=ou_old_style_86') || sent86.includes('老格式同事(user id=ou_old_style_86'),
    '★ 字符串形态 id 的明细行也带**完整** id（与对象形态同一套渲染，不分叉）')
}

console.log('87) ★ 互认·出站 @：roster 命中 ⇒ 真 <at>；查无此名 ⇒ 保留原文+声明；重名歧义 ⇒ 绝不硬 @')
{
  const tool87 = toolNow('feishu_send')
  const mark = sentCards.length
  const hit = tool87 && await tool87.execute({ text: '接力问你一句-87', at: '员工B', chatId: GROUP85 })
  await settle(2)
  const win87 = JSON.stringify(sentCards.slice(mark))
  ok(hit && hit.ok === true, '（前提）feishu_send 带 at 参数能发出去')
  ok(win87.includes('<at id=ou_empb_85>员工B</at>'),
    '★ 命中 roster ⇒ 换成本应用视角的 <at id=ou>（stripUnsendable 不剥 at，真机已证）')
  const markB = sentCards.length
  await tool87.execute({ text: '这句话里的名字查不到-87', at: '查无此人', chatId: GROUP85 })
  await settle(2)
  const winB = JSON.stringify(sentCards.slice(markB))
  ok(winB.includes('（未能 @ 出：查无此人）') && !winB.includes('<at id='),
    '★★ 未命中 ⇒ 不发幽灵 @：原文保留 + 明说「未能 @ 出」（宁可看见失败，不可静默半截）')

  // 🔴 第八轮门槛 LOW（L1）：`@` 的**边界**。旧实现只有右侧负向前瞻 ⇒ 两件真实的事会出事：
  //   ① 邮件地址 `sales@all.com` 里的 `@all` 后面跟 `.` ⇒ 命中 ⇒ 一次**真·@ 全体**；
  //   ② markdown 链接 `@[文字](url)` 被当成 `@[人名]` ⇒ 链接文字被 @ 解析吃掉。
  //   现在左右都有边界 + `]` 后紧跟 `(`/`[` 时整条不匹配 ⇒ 两种都原样送出。
  const markD = sentCards.length
  await tool87.execute({
    text: '邮箱 sales@all.com 与链接 @[看板](https://ex.com/a) 都保持原样-87L',
    chatId: GROUP85,
  })
  await settle(2)
  const winD = JSON.stringify(sentCards.slice(markD))
  ok(winD.includes('sales@all.com') && winD.includes('@[看板]'),
    '★★ 邮件地址 / markdown 链接原样保留（第九轮门槛 LOW）')
  ok(!winD.includes('<at id='),
    '★★★ 上一条**一个 @ 都没展开**：`sales@all.com` 不许把全组人都 @ 出来')
  const markE = sentCards.length
  await tool87.execute({ text: '这句要 @all 并且 @[员工B]-87L', chatId: GROUP85 })
  await settle(2)
  const winE = JSON.stringify(sentCards.slice(markE))
  ok(winE.includes('<at id=all>所有人</at>') && winE.includes('<at id=ou_empb_85>员工B</at>'),
    '★★★ 边界收紧没误伤正常写法：裸 `@all` 与 `@[姓名]` 照常展开')

  // 🔴 第十五轮门槛 LOW#12（核对为真）：`@all` 的**右边界**原来只排 `[A-Za-z0-9_]` ⇒
  //   `@all-hands`（会议名）、`@all.png`（截图文件名）里的 `@all` 后面跟的是 `-`/`.`
  //   ⇒ 照样命中并展开成一次**真·@ 全体**。上面那条 `sales@all.com` 之所以绿，是
  //   **左边界**（前面有 `s`）挡的，不是右边界 —— 所以那条一直没能鉴别这个缺陷。
  //   出站 @ 是唤醒对方 bot 入站事件的扳机 ⇒ 误触发＝全组广播，这里必须钉住。
  const markF15 = sentCards.length
  await tool87.execute({ text: '会议 @all-hands 与截图 @all.png 都不许 @ 出全组-15L', chatId: GROUP85 })
  await settle(2)
  const winF15 = JSON.stringify(sentCards.slice(markF15))
  ok(winF15.includes('@all-hands') && winF15.includes('@all.png'),
    '★ `@all-hands` / `@all.png` 原样保留（右边界收紧为 `(?![\\w.\\-])`）')
  ok(!winF15.includes('<at id=all>'),
    '★★★ 这一条**一个 @ 都没展开**（旧实现在这里发出一次真·@ 全体）')

  // 🔴 第十一轮门槛 LOW#3：`@「」` 这一支**漏了左边界**（另两支都有）⇒
  //   `mail@「员工B」` 里的 `@「员工B」` 照样命中、展开成真 @，和第八轮刚立的
  //   「左右都要边界」自相矛盾。三支一律有左边界才是同一条规则。
  const markF = sentCards.length
  await tool87.execute({ text: '这句里的 mail@「员工B」 不是 @ 人名-87L', chatId: GROUP85 })
  await settle(2)
  const winF = JSON.stringify(sentCards.slice(markF))
  ok(winF.includes('mail@「员工B」') && !winF.includes('<at id='),
    '★★ 中文字形 `@「」` 同样要左边界：`mail@「员工B」` 原样送出、一个 @ 都不展开')
  const markG = sentCards.length
  await tool87.execute({ text: '这句正常 @「员工B」-87L', chatId: GROUP85 })
  await settle(2)
  ok(JSON.stringify(sentCards.slice(markG)).includes('<at id=ou_empb_85>员工B</at>'),
    '★★ 边界收紧没误伤：空格后面的 `@「姓名」` 照常展开')

  // 🔴 第十一轮门槛 LOW#6：`at` 参数里混进换行/制表时，组装 token 必须**剥掉控制字符**。
  //   旧写法只剥方括号 ⇒ 拼出 `@[查无\n此人]`，违反 expandAtTokens 的 `[^\]\n]{1,60}` 语法
  //   ⇒ **整条不匹配**：@ 没展开、原文照发，连「（未能 @ 出：…）」那句声明都不出现
  //   —— 比"声明失败"更坏的是"无声失败"（模型以为 @ 出去了）。
  const markH = sentCards.length
  await tool87.execute({ text: '名字里带换行也要走正常解析-87L', at: '查无\n此人', chatId: GROUP85 })
  await settle(2)
  const winH = JSON.stringify(sentCards.slice(markH))
  ok(winH.includes('（未能 @ 出：查无此人）') && !winH.includes('<at id='),
    '★★ `at` 里的控制字符剥净 ⇒ 走正常「查无此人」路径（可见失败，不静默）')

  // 🔴 第十四轮门槛 MEDIUM（核对为真）：`@all`/`@[名字]` 出现在**代码区**（围栏 ```、行内 `）
  //   时是「引用这段文字」，不是要 @ 人 —— 旧实现是**盲扫整篇**（本仓库的文档、工具说明、
  //   以及 agent 随手贴进卡片的 diff/README 里，这些字面量都是原样出现的）。后果两条：
  //   ① 改写了作者写的内容（卡上的代码样例和源码不再一致）；
  //   ② 真的发了一次 @ ⇒ 通知到人，而**出站 @ 正是唤醒对方 bot 入站事件的扳机**（误唤起另一个 agent）。
  const markCode = sentCards.length
  await tool87.execute({
    text: '代码区里的 @ 记号不许生效-87CODE\n'
      + '```diff\n@all 唤醒群里所有 agent\n@[员工B] 这行是文档示例\n```\n'
      + '正文这行的 @[员工B] 才要真 @。',
    chatId: GROUP85,
  })
  await settle(2)
  const winCode = JSON.stringify(sentCards.slice(markCode))
  ok(winCode.includes('@all 唤醒群里所有 agent') && winCode.includes('@[员工B] 这行是文档示例'),
    '★★★ 围栏代码块里的 `@all` / `@[名字]` **原样保留**（卡上的代码样例与源码一致）')
  ok(!winCode.includes('<at id=all>'),
    '★★★ 上一条一个 `@ 全体` 都没发出去（旧实现这里会把全组人 @ 一遍、顺带唤醒群里的 bot）')
  ok(winCode.split('<at id=ou_empb_85>员工B</at>').length - 1 === 1,
    '★★★ 只展开**正文**那一条（恰好 1 次；代码区那条不算）｜实得 '
    + (winCode.split('<at id=ou_empb_85>员工B</at>').length - 1))
  const markInline = sentCards.length
  await tool87.execute({
    text: '行内 `@[员工B]` 只是举例-87INLINE，正文 @「员工B」 才要真 @。',
    chatId: GROUP85,
  })
  await settle(2)
  const winInline = JSON.stringify(sentCards.slice(markInline))
  ok(winInline.includes('`@[员工B]`') && winInline.includes('<at id=ou_empb_85>员工B</at>'),
    '★★ 行内 `…` 同样原样保留，而正文的 `@「姓名」` 照常展开（同一条消息里两种待遇分得清）')

  // 重名歧义：两个同名 bot 都在群里 ⇒ 宁可谁都不 @（views 不同值）
  writeRoster({
    bots: [
      { name: '撞名bot', app_id: 'cli_dup1', union_id: 'on_dup1', views: { cli_dup1: 'ou_dup1' } },
      { name: '撞名bot', app_id: 'cli_dup2', union_id: 'on_dup2', views: { cli_dup2: 'ou_dup2' } },
    ],
    people: [{ name: '陈明', union_id: 'on_cm', views: { [APP_ID]: 'ou_human_85' } }],
    chats: { [GROUP85]: { name: '测试群', bot_app_ids: [APP_ID, 'cli_dup1', 'cli_dup2'], member_unions: ['on_cm'] } },
  })
  await new Promise((r) => setTimeout(r, 1100))   // 越过 mtime 判定（热读按 mtime，写太快会撞同一毫秒）
  const markC = sentCards.length
  await tool87.execute({ text: '重名的时候不许瞎 @-87', at: '撞名bot', chatId: GROUP85 })
  await settle(2)
  const winC = JSON.stringify(sentCards.slice(markC))
  ok(winC.includes('撞名bot（重名歧义）') && !winC.includes('ou_dup1') && !winC.includes('ou_dup2'),
    '★★★ 重名歧义 ⇒ 一个都不 @，只在文末声明歧义（误 @ 等于把话发给错的人）')
  writeRoster({
    bots: [{ name: '员工B', app_id: 'cli_briend', union_id: 'on_bot_b', views: { cli_briend: 'ou_empb_85' } }],
    people: [{ name: '陈明', union_id: 'on_cm', views: { [APP_ID]: 'ou_human_85' } }],
    chats: { [GROUP85]: { name: '测试群', bot_app_ids: [APP_ID, 'cli_briend'], member_unions: ['on_cm'] } },
  })
}

console.log('88) ★ 互认·防互刷回归：默认 groupRelay=self_only ⇒ bot 消息没 @ 本 bot 一律 0 卡')
{
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 同上 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod88 = await import('../index.js')
  mod88.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  armTurn85('88')
  const mark = sentCards.length
  const logMark = consoleLines.length
  // 真机形态（V2）：对方 bot 发的消息 sender_type='bot'，@ 的是**群里另一个 agent**。
  feedGroup85(GROUP85, 'om_group88_bot', '@员工B 我们聊两句-88', [MENTION_B85],
    { sender_id: { open_id: 'ou_other_bot_id', union_id: 'on_bot_other' }, sender_type: 'bot' })
  await settle(4)
  ok(consoleLines.slice(logMark).some((l) => l.includes('group msg without @bot ignored')),
    '★ 默认门（self_only）照旧：bot 来源、没 @ 本 bot ⇒ 忽略并留痕')
  ok(schemaCards(mark).length === 0, '★★ 一张卡都不建（10-04 的防互刷裁决没被 relay 通道推翻）')
}

console.log('89) ★ 互认·relay 可选通道：mentions_any 放行 → 配对预算 90s>3 冻结 10 分钟 → 人说一句即复臂')
{
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{
      name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
      reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true,
      groupRelay: 'mentions_any', groupRelayChats: { oc_relay_off: 'off' },
    }],
  }, null, 2))
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 同上 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod89 = await import('../index.js')
  mod89.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  armTurn85('89')
  const botSender89 = { sender_id: { open_id: 'ou_other_bot_id', union_id: 'on_bot_other' }, sender_type: 'bot' }
  const logMark = consoleLines.length
  const mark = sentCards.length
  feedGroup85(GROUP85, 'om_group89_r1', '@员工B 接力一句-89', [MENTION_B85], botSender89)
  await settle(4)
  ok(consoleLines.slice(logMark).some((l) => l.includes('group msg relayed (groupRelay)')),
    '★ opt-in（mentions_any）后，@ 别的已知 agent 的 bot 消息被接力（P1 出站 @ 能闭环的前提）')
  ok(schemaCards(mark).length >= 1, '★ 接力真的跑成了回合（不是只放行不干活）')
  // 配对预算：同一发送方 90 秒内第 4 条 ⇒ 冻结该配对 10 分钟，第 5 条直接扣下
  const logMarkB = consoleLines.length
  for (let i = 2; i <= 5; i++) {
    feedGroup85(GROUP85, 'om_group89_r' + i, '@员工B 刷第' + i + '条-89', [MENTION_B85], botSender89)
    await settle(2)
  }
  const winB = consoleLines.slice(logMarkB)
  ok(winB.some((l) => l.includes('bot-pair loop frozen 10min')),
    '★★ 配对预算越阈 ⇒ 冻结 10 分钟并留痕（防线①：不靠「祈祷它们别刷」）')
  ok(winB.some((l) => l.includes('bot-pair loop frozen (drop relayed msg)')),
    '★★ 冻结期内的后续 relay 被扣下（同一对 bot 再刷也不建卡）')
  // 复臂：群里出现**任意人**消息（哪怕没 @ 本 bot）⇒ 计数清零
  const logMarkC = consoleLines.length
  const markC = sentCards.length
  feedGroup85(GROUP85, 'om_group89_human', '人插一句（没 @ 也要复臂）-89')
  await settle(2)
  feedGroup85(GROUP85, 'om_group89_after', '@员工B 复臂后再来一条-89', [MENTION_B85], botSender89)
  await settle(4)
  ok(consoleLines.slice(logMarkC).some((l) => l.includes('group msg relayed (groupRelay)')),
    '★★★ 人一句话就把配对解冻（防线③：真协作不能被预算永久锁死）')
  ok(schemaCards(markC).length >= 1, '复臂后的 relay 照样跑成回合')
  // 🔴 第六轮门槛：`mentions_any` 的判据是「@ 了**别的 bot**」，不是「@ 了不是我的人」。
  //   旧实现写 `m.mentioned_type === 'bot' || (cand && !mine)` ⇒ 真机 mentions 没有类型字段时，
  //   **人 @ 人**也会放行（本 bot 闯进没点它的对话、白烧一个回合）。这条断言对旧码必红。
  const logMarkE = consoleLines.length
  const markE = sentCards.length
  feedGroup85(GROUP85, 'om_group89_h2h', '张三 @李四 你们看这条-89',
    [{ key: '@_user_9', id: { open_id: 'ou_human_other_89', union_id: 'on_h_89', user_id: '' }, name: '李四' }],
    { sender_id: { open_id: 'ou_human_85', union_id: 'on_cm' }, sender_type: 'human' })
  await settle(3)
  ok(!consoleLines.slice(logMarkE).some((l) => l.includes('group msg relayed')),
    '★ 人 @ 人（无 mentioned_type、ou 不在 bot 目录）⇒ 不放行')
  ok(schemaCards(markE).length === 0, '★ 同上：一张卡都不建（不误唤醒）')
  // 群级覆盖：groupRelayChats[oc_relay_off]='off' ⇒ 该群连 mentions_any 也不放行
  const logMarkD = consoleLines.length
  feedGroup85('oc_relay_off', 'om_group89_off', '@员工B 这个群关了-89', [MENTION_B85], botSender89)
  await settle(3)
  ok(!consoleLines.slice(logMarkD).some((l) => l.includes('group msg relayed')),
    '★ 按群覆盖（groupRelayChats=off）生效：整群关掉接力')
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{
      name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
      reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true,
    }],
  }, null, 2))
  // 🔴 第八轮门槛 LOW：光把配置文件写回去**不生效** —— 内存里这一代仍带着
  //   `groupRelay: 'mentions_any'`（和 groupRelayChats），后面任何一条**群消息**用例
  //   都会在这个没人设置的接力配置下跑（顺序依赖＝假绿灯）。和 78/81/92/93/94 一样
  //   显式换代重新 apply，让"配置回到单 bot"这件事真的落到当前这一代上。
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod89z = await import('../index.js')
  mod89z.apply(ctx)
  await settle(2)
  // 换代之后必须把单聊**重新挂回** agent（与 92/93/94 开头同一套），
  // 否则用例 90 的 `lastSentText()` 读的是没被绑定的那代 ⇒ 假红。
  liveAgents.push(agent)
  armTurn85('89-z')
  feedInbound('om_bind89z', '接力用例收尾后重新绑定-89')
  await settle(4)
}

console.log('90) ★ 互认·卡片文字通道：转发卡里的 @ / 按钮 / 图片 抠成可读文字，post 里的 at 同样还原')
{
  armTurn85('90')
  const mark = sentCards.length
  // 形状与用例 58 一致（真机 interactive 事件的 content 就是卡片对象本身：header + elements）
  feedInboundRaw('om_rich90_at', 'interactive', {
    header: { title: { content: '转发进来的卡-90' } },
    elements: [
      { tag: 'markdown', content: '这件事请找人处理-90' },
      { tag: 'at', user_id: 'ou_empb_85', user_name: '员工B' },
      { tag: 'button', text: { content: '批准-90' } },
      { tag: 'img', alt: '截图说明-90' },
    ],
  })
  await settle(4)
  const text90 = lastSentText()
  ok(text90.includes('这件事请找人处理-90'), '★ 转发卡片的正文被抠出来（旧实现整条静默丢弃）')
  ok(text90.includes('@员工B'), '★★ 卡片里的 @ 元素还原成 @姓名（CM 报的「卡片内容的 @ 其他 agent 看不到」正身）')
  ok(text90.includes('【按钮/控件】批准-90'), '★★ 按钮/控件不再被吞：写成【按钮/控件】+ 文字')
  ok(text90.includes('【图片】截图说明-90'), '★★ 图片元素写成【图片】+ alt（至少知道那儿有个图）')
  // post 分支（同一条 extractText）里的 at 元素；入站 post 的 content 是 {title,content}，
  // **没有** zh_cn 包裹（zh_cn 只是出站写法，V4 取证）。
  const markB = agent.sent.length
  feedInboundRaw('om_rich90_post', 'post', {
    title: '转发进来的图文-90',
    content: [[{ tag: 'at', user_id: 'ou_c_90', user_name: '员工C' }, { tag: 'text', text: '看下这个-90' }]],
  })
  await settle(4)
  const textB = lastSentText()
  ok(agent.sent.length === markB + 1 && textB.includes('@员工C') && textB.includes('看下这个-90'),
    '★★★ post 消息的 at 段还原成 @姓名（整段丢失是旧行为）')
  ok(schemaCards(mark).length >= 1, '（前提）富文本回合照常建卡')

  // 🔴 第十三轮门槛 LOW#3：富节点的 `user_name`/`name` 偶见**对象**形态（转发链路里的卡片元素
  //   带的是 {content} 这类结构而不一定是字符串）。旧写法把它直接拼进文本 ⇒ 送进会话的是
  //   `@[object Object]`，agent 拿它去认人必然认不出，而且卡面上还难看。
  //   现在的口径：名字**只认字符串**，其余一律兜底 `@某人`（宁缺勿错）。
  const markC = agent.sent.length
  feedInboundRaw('om_rich90_objname', 'post', {
    title: '对象形态名字-90L3',
    content: [[
      { tag: 'at', user_id: 'ou_obj_90', user_name: { content: '不该被拼接的对象' } },
      { tag: 'at', user_id: 'ou_str_90', name: '只有name的同事' },
      { tag: 'text', text: '对象名字复验-90L3' },
    ]],
  })
  await settle(4)
  const textC = lastSentText()
  ok(agent.sent.length === markC + 1 && textC.includes('对象名字复验-90L3'),
    '（前提）带对象形态 user_name 的 post 照常成回合（不是整条被丢）')
  ok(textC.includes('@某人') && textC.includes('@只有name的同事'),
    '★★ 对象形态名字 ⇒ 兜底「@某人」；字符串 name 仍照常还原（名字只认字符串）')
  ok(!textC.includes('[object Object]'),
    '★★★ 会话文本里绝不出现 [object Object]（旧实现直接拼 String(obj) 的产物）')
}

console.log('91) ★ 互认·出站 @ 的 post 降级通道：DSH_FEISHU_AT_MODE=post ⇒ msg_type=post + zh_cn 包裹 + tag:at')
{
  process.env.DSH_FEISHU_AT_MODE = 'post'
  const tool91 = toolNow('feishu_send')
  const mark = sentCards.length
  await tool91.execute({ text: '走 post 通道的那条-91', at: '员工B', chatId: GROUP85 })
  await settle(3)
  const posts = sentCards.slice(mark).filter((c) => c.payload && c.payload.zh_cn)
  ok(posts.length >= 1,
    '★ post 通道发出去了（payload 是 {zh_cn:{content}} —— V4 实测裸 content 会被 code 230001 拒）')
  const segs = JSON.stringify((posts[0] && posts[0].payload.zh_cn.content) || [])
  ok(segs.includes('"tag":"at"') && segs.includes('"user_id":"ou_empb_85"'),
    '★★ @ 被换成 tag:"at" 段（卡片 at 失效时的备胎通道，@ 的是对方应用视角的 ou）')
  ok(segs.includes('走 post 通道的那条-91'), '（前提）正文与 @ 在同一条消息里')
  delete process.env.DSH_FEISHU_AT_MODE
}

console.log('92) ★ 互认·卡片点击者：operator（V3 形状）写回审批结果 + 每次点击都留痕')
{
  // ⚠️ 与用例 52 同一条时序纪律：**发卡的那一代**必须和**处理点击的那一代**是同一代
  //    （点击事件只会在"当前活着的 helper"的 pendingForms 里查 token）。
  //    前面 88/89 各起过新一代 ⇒ 这里先清干净再起一代，工具取**最后注册**的那个。
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod92 = await import('../index.js')
  mod92.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  armTurn85('92-pre')
  // 先让这一代 bot 认识这个单聊（findBotForChat 只认本代见过的会话）
  feedInbound('om_bind92', '先把会话挂上-92')
  await settle(4)
  const tool92 = toolNow('feishu_approval_form')
  armTurn85('92')
  const mark92 = sentCards.length
  // 🔴 第十五轮门槛 LOW#6：留痕断言要取**本轮窗口**（与兄弟分支 `logMark92b` 同口径）。
  //   `consoleLines` 是全程缓冲 ⇒ 全量 `some` 今天恰好也只有一条会命中，但它是"靠运气成立"
  //   的断言：以后任何一条别的用例发出同形状留痕，这里就会在别人没做对时也变绿。
  const logMark92 = consoleLines.length
  const pending92 = tool92.execute(
    { title: '点击者身份单-92', meta: [{ label: '事项', value: '认人' }], chatId: CHAT_ID },
    { agent, signal: undefined },
  )
  await drain()
  // 按**形状**认领审批单卡，不按「最后一张」：这一代后面还会建过程卡/结论卡，
  // `lastCardFrom(mark92)`（取 slice 内最后一条 create）必然抓到结论卡 ⇒ 按钮恒为空，
  // 用例就变成"替 bug 背书"。判据用只有审批单才有的 { fs_form, fs_choice } 按钮值。
  // ⚠️ `cardElements/allButtons/divRows` 收的是**整条 sentCards 记录**（内部自己取 .payload），
  //    传 payload 进去会静默得到空数组 ⇒ 上一版就是这么"认不出按钮"的（第五轮门槛 HIGH 的同源坑）。
  const formCards92 = sentCards.slice(mark92).filter((c) => c.op === 'create' && c.payload
    && allButtons(c).some((b) => b.value && b.value.fs_form))
  const formCard = formCards92.length ? formCards92[formCards92.length - 1] : null
  const btn = formCard ? allButtons(formCard).find((b) => b.value && b.value.fs_form) : null
  if (!btn) {
    const probe = await Promise.race([
      pending92,
      new Promise((r) => setTimeout(() => r({ detail: '（卡发了但按钮没被认出来）' }), 500)),
    ])
    const shape92 = sentCards.slice(mark92).map((c) => c.op + '/' + (c.payload && c.payload.schema)
      + '/header=' + Boolean(c.payload && c.payload.header)
      + '/tree=' + JSON.stringify(cardElements(c).map((e) => e.tag === 'column_set'
        ? { column_set: (e.columns || []).map((col) => (col && col.elements || []).map((x) => x.tag)) }
        : e.tag))
      + '/btn=' + allButtons(c).length)
    console.log('    [debug92] ' + JSON.stringify(shape92) + ' probe='
      + String((probe && (probe.detail || JSON.stringify(probe))) || ''))
    ok(false, '（前提）审批单卡发出且按钮带 { fs_form, fs_choice }')
  } else {
    ok(true, '（前提）审批单卡发出且按钮带 { fs_form, fs_choice }')
    // 真机取证 V3：回调里的 operator = { user_id, open_id, union_id }（本应用视角）
    await tapValue(btn.value, { user_id: '', open_id: 'ou_human_85', union_id: 'on_cm' })
  }
  const out92 = await Promise.race([
    pending92,
    new Promise((r) => setTimeout(() => r({ ok: false, timeout: true }), 5000)),
  ])
  ok(out92 && out92.ok === true, '（前提）点击把审批单答回去了：' + JSON.stringify(out92 && out92.choice))
  // 🔴 第八轮门槛 M1（口径分两侧，别记成"一律截断"）：
  //   · **回给 agent** 的 `clicker` ⇒ 完整 open_id。半截 id 拿去通讯录反查必然 99992351，
  //     和第八轮把 `senderLabelFooter`/`mentionFooter` 改成给完整 id 是同一个理由。
  //   · **卡面/日志**（`dismissApprovalCard` 追加文本、`card action operator:` 留痕）⇒ 仍截断。
  //   夹具 id 'ou_human_85' 的前 8 位是 'ou_human' ⇒ 断言写全量即同时钉住"没退回截断"。
  ok(out92 && out92.clicker === '[点击者 陈明|ou_human_85]',
    '★ 点击者随结果回到 agent，且带**完整** id（roster 认名 + 可反查；旧实现这里给的是半截 ou_human）')
  ok(out92 && String(out92.detail).includes('[点击者 陈明|ou_human_85]'),
    '★★ detail 里也带上完整点击者（agent 读文本就能看到，不必猜是谁点的）')
  {
    // 完整 id 只进工具结果，**不许爬上卡片**（B3 隐私：会话可见文本保持截断口径）。
    // 回执卡的文案按**线上那份**取（`formResultCardPayload` 有 `originalElements` 时写
    // 「你已经审批过了」，只在没带原元素时才写「已记录你的选择」）：判据必须认前者，
    // 否则这条"前提"会在空数组上恒真 ⇒ 下面那条隐私断言变成假绿灯。
    const receipts92 = cardsSince(mark92).filter((c) => c.op === 'update'
      && /你已经审批过了|已记录你的选择/.test(JSON.stringify(c.payload || {})))
    ok(receipts92.length >= 1, '（前提）审批单就地变成回执卡')
    ok(receipts92.every((c) => !JSON.stringify(c.payload).includes('ou_human_85')),
      '★★ 回执卡面上没有完整 open_id（给 agent 的全量 ≠ 给用户看的全量）')
  }
  ok(consoleLines.slice(logMark92).some((l) => l.includes('card action operator: ou=ou_human_85')),
    '★★★ 每次点击都留痕（认不出名字时至少留 id 前缀，不静默）')

  // 🔴 第十一轮门槛 LOW#3：截断分支原来写死 `ou.slice(0, 8)` ⇒ 回调**只带 union_id** 时
  //   idTag 是空串，留痕/卡面渲染成 `[点击者 陈明|]`。这一支的目的本来就是"卡片侧留一个
  //   截断 id"，全丢掉等于没留（`open_id` 是**应用视角**值，真机确实存在只回 union_id 的形状）。
  {
    const mark92b = sentCards.length
    const pending92b = tool92.execute(
      { title: '只有 union 的点击-92U', meta: [{ label: '事项', value: '认人' }], chatId: CHAT_ID },
      { agent, signal: undefined },
    )
    await drain()
    const btn92b = (() => {
      for (const c of sentCards.slice(mark92b).filter((x) => x.op === 'create')) {
        const b = allButtons(c).find((y) => y.value && y.value.fs_form)
        if (b) return b
      }
      return null
    })()
    if (btn92b) {
      const logMark92b = consoleLines.length
      await tapValue(btn92b.value, { user_id: '', open_id: '', union_id: 'on_cm' })
      ok(consoleLines.slice(logMark92b)
        .some((l) => l.includes('card action operator') && l.includes('[点击者 陈明|on_cm]')),
        '★★ 回调只带 union_id ⇒ 截断口径**回退到 union**（旧实现的留痕是 `[点击者 陈明|]`，等于没留 id）')
      const out92b = await Promise.race([
        pending92b,
        new Promise((r) => setTimeout(() => r({ ok: false, timeout: true }), 5000)),
      ])
      ok(out92b && out92b.clicker === '[点击者 陈明|on_cm]',
        '★★★ 只带 union 时回到 agent 的那份同样是 union（反查仍有稳定键，绝不出现空 id）')
    } else ok(false, '（前提）第二张审批单卡发出且按钮带 fs_form')
  }
}

console.log('93) ★ 会话摘要要剥掉互认明细：【发送方】/【本条 @ 的对象】/open_id= 都不许露出（第五轮门槛 MEDIUM ⇒ 功能基线 缺口#9）')
{
  // 明细行是**拼在正文尾部**持久化进 user/message 的（用例 85 已钉住那个形状），
  // 而摘要读取处 firstUserText（/list 与 /switch 共用）原来只剥开头的 `[飞书…]` 投递前缀
  // ⇒ 短消息会把 `kind=… open_id=…` 整条尾巴显示到用户看得见的灰字上。
  //
  // 🔴 **为什么断言挂在 /list 而不是 /switch 会话卡**（本用例第一版就栽在这）：
  //   会话卡那侧的摘要要过 `clipSessionName`（上限 16 字 ⇒ 尾部必被裁成 `…`），
  //   在那一层断言"摘要里没有 open_id="是**恒真**的 —— 夹住它的是裁剪，不是剥离。
  //   /list 把**同一份 `r.summary` 原样**渲进卡面（不裁剪）⇒ 缺席才真的来自剥离。
  const BODY93 = '弱口令这条要改成强制双因素'
  const QUOTE93 = '（你在引用这条消息：审批单-登录）'
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod93 = await import('../index.js')
  mod93.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  armTurn85('93-pre')
  feedInbound('om_bind93', '先绑定单聊-93')
  await settle(4)

  persistedSessions = [
    { version: 0, id: 'sess93-footers', createdAt: Date.now() - 300e3, cwd: WORKSPACE },
    { version: 0, id: 'sess93-plain0', createdAt: Date.now() - 200e3, cwd: WORKSPACE },
  ]
  persistedFirstText['sess93-footers'] = '[飞书 陈明] ' + BODY93
    + '\n【发送方】kind=user name=陈明 open_id=ou_human_93'
    + '\n【本条 @ 的对象】@员工B(bot id=ou_empb_93)'
    + '\n' + QUOTE93
  const PLAIN93 = '这条没有任何明细行'
  persistedFirstText['sess93-plain0'] = '[飞书 机器人] ' + PLAIN93

  const mark93 = sentCards.length
  feedInbound('om_list93', '/list')
  await drain()
  const body93 = JSON.stringify(cardsSince(mark93))
  ok(cardsSince(mark93).length >= 1 && body93.includes(BODY93),
    '（前提）/list 出了卡，且带明细的会话仍以**正文**被认出（摘要没被削空）')
  ok(body93.includes(BODY93 + ' ' + QUOTE93),
    '★★ 摘要正身＝「正文 ＋ 引用提示」：引用是有效上下文 ⇒ 保留，剥离没把正文尾巴一起削掉')
  ok(!body93.includes('【发送方】') && !body93.includes('【本条 @ 的对象】'),
    '★★ 两条互认明细都不露出（/list 不裁剪 ⇒ 这里的缺席只可能来自剥离）')
  ok(!body93.includes('open_id=') && !body93.includes('ou_human_93') && !body93.includes('ou_empb_93'),
    '★★★ id 不外泄（R10 隐私口径：卡面不出现 kind=…/完整 ou；这一层没有裁剪替它兜底）')
  ok(!body93.includes('[飞书'), '开头的 [飞书…] 投递前缀照旧剥掉（既有口径不回归）')
  ok(body93.includes(PLAIN93),
    '（对照）本来就没有明细的会话，正文一字不少（剥明细不能误伤普通消息）')

  liveAgents.length = 0
}

console.log('94) ★ /model 卡按 provider 分组：同一条 model 挂在两条路由上，不许看起来"重复两次"（CM 2026-10-05 报障）')
{
  // 🔴 症状：发 /model，卡片上同一个模型名出现两遍、点哪个都不知道切的是哪条路由。
  //   根因不是宿主重复返回：`dsh-llm` 只在**单个 provider 内**去重（跨 provider 不去重，
  //   见 listModels 的 INVALID_CATALOG 只比 seen.has(model.id)），宿主 GUI 因此按 provider
  //   分组渲染（`dsh-api-session-controller` 的 buildModelCatalog ⇒ kind='group' + group.name）。
  //   插件把这些拉平成一层按钮、标题只写模型名 ⇒ 两条路由共有的模型必然显示两次。
  //   夹具就照这个真形状造：官方 + 镜像两条路由，共用 `test-model`。
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod94 = await import('../index.js')
  mod94.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  armTurn85('94-pre')
  feedInbound('om_bind94', '先绑定单聊-94')
  await settle(4)

  llmOverride = {
    listProviders: () => [
      { id: 'test', name: 'DeepSeek 官方' },
      { id: 'mirror', name: 'DeepSeek 镜像' },
    ],
    listModels: async (pid) => (pid === 'test'
      ? [{ id: 'test-model', name: 'Test Model' }, { id: 'only-test', name: '仅官方有' }]
      : [{ id: 'test-model', name: 'Test Model' }, { id: 'only-mirror', name: '仅镜像有' }]),
  }

  const mark94 = sentCards.length
  feedInbound('om_model94', '/model')
  await drain()
  llmOverride = null

  const card94 = cardsSince(mark94).find((c) => c.payload && Array.isArray(c.payload.elements))
  ok(!!card94, '（前提）/model 真的出了一张带 elements 的卡（否则下面全是恒真）')
  // 顺元素走一遍：div 里出现组名 ⇒ 之后的按钮归这一组。分组若只是装饰，这个映射当场穿帮。
  const groupOf = {}
  let cur94 = null
  for (const el of (card94 ? card94.payload.elements : [])) {
    const txt = el && el.text && el.text.content ? String(el.text.content) : ''
    if (el.tag === 'div' && /\*\*(DeepSeek [^*]+)\*\*/.test(txt)) cur94 = txt.match(/\*\*(DeepSeek [^*]+)\*\*/)[1]
    if (el.tag === 'action' && cur94) {
      for (const a of el.actions || []) {
        groupOf[cur94] = groupOf[cur94] || []
        groupOf[cur94].push({ label: String(a.text && a.text.content), value: String(a.value && a.value.fs_model) })
      }
    }
  }
  const g94 = groupOf['DeepSeek 官方'] || []
  const m94 = groupOf['DeepSeek 镜像'] || []
  ok(g94.length === 2 && m94.length === 2,
    '★★ 两个 provider 各成一段、段标题就是宿主给的 provider 显示名（GUI 同源口径）')
  ok(g94.some((b) => b.value === 'test|test-model') && m94.some((b) => b.value === 'mirror|test-model'),
    '★★ 共有的 test-model 在两段各有一个按钮，且 value 分别指回自己那条路由（不吞选项、也不只是标着好看）')
  ok(g94.every((b) => b.value.indexOf('test|') === 0) && m94.every((b) => b.value.indexOf('mirror|') === 0),
    '★★ 按钮不串组：官方段里不许混进 mirror|、镜像段里不许混进 test|')
  for (const [name, list] of [['官方', g94], ['镜像', m94]]) {
    const labels = list.map((b) => b.label)
    ok(new Set(labels).size === labels.length, '（' + name + '段）组内没有重复按钮 ⇒ 「同一个名字出现两次」必来自跨路由拉平')
  }
  ok(g94.some((b) => b.label.startsWith('▶ ') && b.value === 'test|test-model')
    && !m94.some((b) => b.label.startsWith('▶ ')),
    '▶ 当前模型高亮要 provider 也对得上才标（镜像段的同名模型不许被误标成当前）')
  ok(JSON.stringify(cardsSince(mark94)).indexOf('Test Model') === -1,
    '（对照）按钮文字用宿主给的 model **id**，不用 display name（卡面口径与改前一致，本轮只动排布）')

  // 🔴 第九轮门槛 LOW（L2）：段标题来自**宿主的** `p.name`，不受我们控制 —— 可能是对象
  //   （`String(obj)` ⇒ 卡上直接印出 `[object Object]`）、可能带 lark_md 元字符（`*`/`_`/反引号
  //   把标题排版顶穿）、可能压根没给。三种形状都在这里钉住：剥元字符 + 回退 provider id。
  llmOverride = {
    listProviders: () => [
      { id: 'odd', name: '带*号_和`标记' },
      { id: 'objname', name: { zh: 'X' } },
      { id: 'blankname' },
    ],
    listModels: async (pid) => [{ id: 'm-' + pid, name: 'M' }],
  }
  const mark94b = sentCards.length
  feedInbound('om_model94b', '/model')
  await drain()
  llmOverride = null
  const card94b = cardsSince(mark94b).find((c) => c.payload && Array.isArray(c.payload.elements))
  ok(!!card94b, '（前提）provider 名再怪也照常出卡（不许因为显示名就整张卡没了）')
  const titles94 = []
  for (const el of card94b ? card94b.payload.elements : []) {
    const txt = el && el.text && el.text.content ? String(el.text.content) : ''
    const mm = /^\*\*([\s\S]*)\*\*$/.exec(txt)
    if (mm) titles94.push(mm[1])
  }
  ok(titles94.includes('带号和标记'),
    '★ 段标题剥掉 lark_md 元字符（* / _ / 反引号），名字内容还在、排版不被顶穿')
  ok(titles94.includes('objname') && titles94.includes('blankname'),
    '★★ 名字是对象/干脆没给 ⇒ 回退 provider id（和 `/model <provider>/<model>` 的写法对得上）')
  const json94b = JSON.stringify((card94b && card94b.payload) || {})
  ok(json94b.indexOf('[object Object]') === -1, '★★★ 卡面上绝不出现 [object Object]')
  const vals94b = allButtons(card94b).map((b) => String(b.value && b.value.fs_model))
  ok(vals94b.length === 3 && vals94b.includes('objname|m-objname') && vals94b.includes('odd|m-odd'),
    '（前提）回退只动显示名，按钮 value 仍是 provider|model（切换逻辑不受影响）')

  liveAgents.length = 0
}

console.log('95) ★ 卡片点击必须来自「发起会话」：转发到别的会话点 ⇒ 可见地拒绝，回原会话照常生效（第九轮门槛 MEDIUM·M3）')
{
  // 🔴 token 只回答「这是哪一张卡」，不回答「点的人该不该算」：卡被转发到别的会话后
  //   那条新消息带着**同一个 value**，在那边点一下照样能答掉原会话这张单
  //   （0.7.22 按 bot 隔离修的是「同群两个 bot 抢答案」，没修「同一个 bot 跨会话」）。
  //   ⇒ 判据要两条：token 认卡 + `record.chatId` 认会话。拒绝必须**看得见**（与 stale 卡同口径）。
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod95 = await import('../index.js')
  mod95.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  armTurn85('95-pre')
  feedInbound('om_bind95', '先绑定单聊-95')
  await settle(4)
  // 让这一代也认得群会话（findBotForChat 只认本代见过的会话 ⇒ 不绑就测不出「可见拒绝」）
  feedGroup85(GROUP85, 'om_group95_bind', '@_user_1 绑定群会话-95', [MENTION_SELF85])
  await settle(4)

  const tool95 = toolNow('feishu_approval_form')
  armTurn85('95')
  const mark95 = sentCards.length
  const pending95 = tool95.execute(
    { title: '跨会话点击单-95', meta: [{ label: '事项', value: '转发' }], chatId: CHAT_ID },
    { agent, signal: undefined },
  )
  await drain()
  const btn95 = (() => {
    for (const c of sentCards.slice(mark95).filter((x) => x.op === 'create')) {
      const b = allButtons(c).find((y) => y.value && y.value.fs_form)
      if (b) return b
    }
    return null
  })()
  ok(!!btn95, '（前提）审批单发在**单聊**里且按钮带 fs_form token')
  if (btn95) {
    const logMark95 = consoleLines.length
    const sentMark95 = sentCards.length
    await tapValue(btn95.value, { user_id: '', open_id: 'ou_human_85', union_id: 'on_cm' }, GROUP85)
    const raced95 = await Promise.race([
      pending95,
      new Promise((r) => setTimeout(() => r({ pending: true }), 500)),
    ])
    ok(raced95 && raced95.pending === true,
      '★ 转发到群里点 ⇒ **不作答**（单仍挂在发起会话，等真人回去点；旧实现这边一点就把原单答掉了）')
    ok(consoleLines.slice(logMark95).some((l) => l.includes('card click ignored (not the originating chat)')),
      '★★ 拒绝要留痕（card=… click=…），不许静默吞一次点击')
    const win95 = JSON.stringify(sentCards.slice(sentMark95))
    ok(win95.includes('这张卡不是在') && win95.includes('本会话'),
      '★★★ 误点的会话里回一句说明（看得见地拒绝，与 stale 卡同口径）')
    await tapValue(btn95.value, { user_id: '', open_id: 'ou_human_85', union_id: 'on_cm' }, CHAT_ID)
    const out95 = await Promise.race([
      pending95,
      new Promise((r) => setTimeout(() => r({ ok: false, timeout: true }), 5000)),
    ])
    ok(out95 && out95.ok === true,
      '★★ 回到**发起会话**再点 ⇒ 照常生效（收紧只挡跨会话，不挡正常使用）：' + JSON.stringify(out95 && out95.choice))
  }

  // 第二站点：提问卡（ask_user_question）。判据用「旧卡有没有被封口成回执」，
  // 不依赖工具返回值句柄 —— 与用例 29 同一条可观测口径。
  const qmark95 = sentCards.length
  emitCtx('tools/execute', {
    name: 'ask_user_question', agent, signal: undefined,
    arguments: { questions: [{ id: 'q-x95', question: '跨会话点-95', options: [{ label: '选项甲' }, { label: '选项乙' }] }] },
  }, () => {})
  await drain()
  const qCard95 = cardsSince(qmark95).filter((c) => c.op === 'create')
    .find((c) => JSON.stringify(c.payload).includes('需要你的回答'))
  // 🔴 token 用**正则从整份 payload 里抓**（第十一轮门槛 MEDIUM#11），不要用固定下标：
  //   本文件用例 78 的注释早就写过「第一版按固定下标取，取到 undefined 直接把整个冒烟进程崩掉」。
  //   下标链 `elements.find(column_set).columns[1].elements[0].behaviors[0]` 只在
  //   「非计划卡、正好两个选项」这一种布局下成立；选项数一变、或这里换成计划审查卡
  //   （第一排是 planReviewButtonsRow）⇒ 链上某环是 undefined，抛**未捕获 TypeError**
  //   把整个冒烟进程带走的是一处取数，而不是一条断言。
  const qToken95 = (() => {
    const m = /"fs_question":"([^"]+)"/.exec(JSON.stringify((qCard95 && qCard95.payload) || {}))
    return m ? m[1] : ''
  })()
  ok(Boolean(qToken95), '（前提）提问卡在单聊里发出且带 fs_question token')
  if (qToken95) {
    const logMarkQ = consoleLines.length
    await tapValue({ fs_question: qToken95, fs_option: 0 }, undefined, GROUP85)
    ok(consoleLines.slice(logMarkQ).some((l) => l.includes('card click ignored (not the originating chat)')),
      '★★ 提问卡走的是**同一道闸**（不是只把审批单卡堵了）')
    // 提问卡的回执文案是 `questionResultCardPayload` 的「✅ 已收到：<选项>」
    //（用例 29 里那句「已收到你的选择，继续处理中…」是**流式卡封口**的文案，
    //   本代没有活流式卡 ⇒ 那条不会出现，判据必须按前者的形状写）
    ok(!JSON.stringify(cardsSince(qmark95).filter((c) => c.op === 'update')).includes('已收到：选项甲'),
      '★★★ 群里那一下没把提问卡封口 ⇒ 原会话的单还活着')
    await tapValue({ fs_question: qToken95, fs_option: 0 }, undefined, CHAT_ID)
    ok(JSON.stringify(cardsSince(qmark95).filter((c) => c.op === 'update')).includes('已收到：选项甲'),
      '★★ 发起会话里点 ⇒ 照常封口生效（防「一刀切把正常点击也挡了」）')
  }
  liveAgents.length = 0
}

console.log('96) ★🔴 审批卡（fs_approval）点击通道：跨会话点 ⇒ 拒；发起会话点 ⇒ 真放行（第十一轮门槛 CRITICAL 的漏检根因）')
{
  // 为什么单独一条用例（这是本文件最重要的结构性补洞，不是重复用例 95）：
  //   第十轮把跨会话守卫补到**第四个站点**（审批卡）时，写的是
  //   `cardClickOutsideOriginChat(record, chatId)` —— 而审批卡那个分支**没有 chatId 绑定**
  //   （前三处各自的 `const chatId` 都声明在自己那个 if 块里）。
  //   · `node --check` 查不出未声明标识符（那是运行期 ReferenceError，不是语法错误）；
  //   · 全量冒烟当时对审批卡点击通道**零覆盖**（`grep fs_approval scripts/smoke.mjs` = 0 命中）；
  //   ⇒ 这条 CRITICAL 是代码审查门槛抓出来的，闸门一片绿。补了本用例它就跑不掉：
  //     守卫若再引用未声明变量，异常被调用方 try/catch 吞成一条 `card action error` 日志，
  //     `record.settle()` 永不执行 ⇒ 下面「发起会话点 ⇒ allowed-once」当场红。
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod96 = await import('../index.js')
  mod96.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  armTurn85('96-pre')
  feedInbound('om_bind96', '先绑定单聊-96')
  await settle(4)
  feedGroup85(GROUP85, 'om_group96_bind', '@_user_1 绑定群会话-96', [MENTION_SELF85])
  await settle(4)

  let delegated96 = 0
  // 🔴 夹具坑（本用例第一次跑就是红的，红在断言不在产品）：`emitCtx` 把**同一个** `next`
  //   发给**每一个**监听器，不是链式往下传 ⇒ 前面那些老代次的监听器各自「查无此 agent 的会话」
  //   原样转交一次，`delegated96` 天生就是正的，而且 `runs96[0]` 拿到的是**转交**的返回值。
  //   所以：① 取被接管的那条 Promise 要按**对象身份**过滤（老代次返回的就是同一个 sentinel 对象）；
  //   ② 「拒掉不算转交」要比**接管之后的增量**，不是比总数。
  const nextSentinel96 = Promise.resolve('next-96-delegated')
  const nextSpy96 = () => { delegated96 += 1; return nextSentinel96 }
  const mark96 = sentCards.length
  const logMark96 = consoleLines.length
  const runs96 = emitCtx('approval/request',
    { agent, toolName: 'bash', reason: '跨会话点击复验-96', callId: 'call-96', signal: undefined }, nextSpy96)
  const taken96 = runs96.filter((r) => r && typeof r.then === 'function' && r !== nextSentinel96)
  const pending96 = taken96[0]
  ok(taken96.length === 1 && Boolean(pending96),
    '★ 飞书会话的审批申请被接管（恰好一个监听器把它扣下换成 Promise，其余原样转交 next）')
  await drain()
  const card96 = cardsSince(mark96).filter((c) => c.op === 'create')
    .find((c) => JSON.stringify(c.payload).includes('需要你的确认'))
  const tok96 = (() => {
    const m = /"fs_approval":"([^"]+)"/.exec(JSON.stringify((card96 && card96.payload) || {}))
    return m ? m[1] : ''
  })()
  ok(Boolean(tok96), '（前提）审批卡发在**单聊**里且按钮带 fs_approval token')
  const delegatedAtTakeover96 = delegated96
  if (tok96) {
    const crossLogMark = consoleLines.length
    const crossCardMark = sentCards.length
    await tapValue({ fs_approval: tok96, fs_action: 'allow' },
      { user_id: '', open_id: 'ou_human_85', union_id: 'on_cm' }, GROUP85)
    const raced96 = await Promise.race([
      pending96,
      new Promise((r) => setTimeout(() => r({ pending: true }), 500)),
    ])
    ok(raced96 && raced96.pending === true,
      '★★ 转发到群里点「允许一次」⇒ **不作答**（工具权限不能被别的会话放行，比答错题更严重）')
    ok(consoleLines.slice(crossLogMark).some((l) => l.includes('card click ignored (not the originating chat)')),
      '★★★ 审批卡走的是**同一道闸**（第四个站点没漏：三处堵、一处不堵等于没堵）')
    ok(JSON.stringify(sentCards.slice(crossCardMark)).includes('这张卡不是在'),
      '★★ 误点的会话里回一句说明（可见地拒绝）')
    ok(delegated96 === delegatedAtTakeover96,
      '★ 被跨会话拒掉**不算**交回 next（不许把审批转给下游监听器；转交计数接管时 '
        + delegatedAtTakeover96 + ' 点击后 ' + delegated96 + '，增量必须为 0）')
    // 🔴 门槛（第十二轮 HIGH）：**正向路径必须真点一次**，否则这条绊线是虚的。
    //   只点群里那一下 ⇒ `win96` 永远是 `'__no-settle__'`，而"守卫引用未声明变量 ⇒ 异常被吞
    //   ⇒ 拿不到值"这个 CRITICAL 场景**本来就只在正向点击时才暴露**（跨会话那次在守卫里就
    //   return 了，压根走不到 settle）。所以补回发起会话（单聊 `CHAT_ID`）这一下。
    await tapValue({ fs_approval: tok96, fs_action: 'allow' },
      { user_id: '', open_id: 'ou_human_85', union_id: 'on_cm' }, CHAT_ID)
    const win96 = await Promise.race([
      pending96,
      new Promise((r) => setTimeout(() => r('__no-settle__'), 5000)),
    ])
    ok(win96 === 'allowed-once',
      '★★★★ 回到**发起会话**点 ⇒ 真放行（settle=allowed-once）；本条就是 CRITICAL 的判据：'
        + '守卫引用未声明变量时异常被吞、这里永远拿不到值')
    ok(!consoleLines.slice(logMark96).some((l) => l.includes('card action error')),
      '★★★ 全程没有 card action error（第十轮那条 CRITICAL 正是被这条日志吞掉的）')
  }
  liveAgents.length = 0
}

console.log('97) ★🔴 群里「@bot /命令」必须判成命令：命令锚点从**原始文本**剥前导占位符（第十三轮 MEDIUM#2）')
{
  // 为什么必须单独一条（不是用例 86 的重复）：第十三轮之前，命令解析拿的是**还原后**的正文
  // （`@姓名 /help`），首字符不是 `/` ⇒ `splitCommand` 永远判不出命令 ⇒ 群里 @bot 发命令
  // **一直**当普通消息处理。旧代码的注释声称"已修复"，实际没修，而捆在用例 86 里的那条
  // 断言恰好因为"没被识别成命令"才变绿（假绿灯，见用例 86 头部注释）。
  // 本用例的判据是**可鉴别**的：命令生效 ⇒ 不起回合、不建会话、只发一条帮助纯文本；
  // 命令没生效 ⇒ agent.sent 必然 +1（整串进会话）。
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod97 = await import('../index.js')
  mod97.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  armTurn85('97')
  const GROUP97 = 'oc_smoke_group_97'
  const sessionsBefore97 = createdSessions
  const sentBefore97 = agent.sent.length
  const mark97 = sentCards.length
  const logMark97 = consoleLines.length
  feedGroup85(GROUP97, 'om_group97_help', '@_user_1 /help', [GROUP_MENTION[0]])
  await settle(4)
  ok(agent.sent.length === sentBefore97,
    '★★ 命令**没有**起回合（旧实现判不出命令 ⇒ 整串当普通文本送进 agent，这里必然 +1）')
  ok(createdSessions === sessionsBefore97,
    '★★ 群里发 /help 不新建会话（没判成命令时它会当成第一句话把会话建起来）')
  const plain97 = cardsSince(mark97)
    .filter((c) => c.op === 'create' && c.payload && !c.payload.schema)
    .filter((c) => JSON.stringify(c.payload).includes('/compact 压缩上下文'))
  ok(plain97.length === 1,
    '★★★ /help 的帮助文本真的发出去了（恰好一条纯文本：0=命令没生效，>1=执行了两遍）')
  ok(!consoleLines.slice(logMark97).some((l) => l.includes('group msg without @bot ignored')),
    '★ 带 @ 的命令不会被「群里没 @ 我」那道闸门丢掉（锚点与闸门读的是同一份 mentions）')

  // 🔴 第十三轮门槛 LOW#4：`mentioned_type` 的口径原来**两处不一致** ——
  //   判「是不是同行（别的 agent）」认 bot 与 app，明细行写 kind 时只认 bot。
  //   同一个 mention 在两个判断里答案相反 ⇒ 现在统一由 mentionedTypeIsAgent 裁决。
  const mark97B = agent.sent.length
  feedGroup85(GROUP97, 'om_group97_app', '@_user_1 类型口径复验-97L4',
    [MENTION_SELF85, {
      key: '@_user_2', id: { open_id: 'ou_app_97', union_id: 'on_bot_app97', user_id: '' },
      name: '应用形态bot', mentioned_type: 'app',
    }])
  await settle(4)
  ok(agent.sent.length === mark97B + 1 && lastSentText().includes('应用形态bot(bot id=ou_app_97'),
    '★★ mentioned_type=app 的明细写 kind=bot（与「bot」同一套判据，不再一处认一处不认）')
  liveAgents.length = 0
}

console.log('98) ★🔴 出站 @ 的 name→id 兜底必须合并**本地增量表**（第十三轮 MEDIUM#3：内核读两份，这里只读主表）')
{
  // 背景：「**本机 bot 视角**的 ou」按设计就写在 `identity_map.local.json`（每台一份、不参与
  //   同步）。内核 `resolveActorJs` 是主表＋增量**合并后**才解析；而出站 @ 的兜底只读主表
  //   ⇒ 只在增量里的那个 ou 永远查不到，明明认得出的人被发成「（未能 @ 出：X）」。
  // 口径与内核严格一致：增量**只按同名补 open_ids，不新增人名**。
  const MAP98 = join(tmpdir(), 'fs-smoke-identity_map_98.json')
  const LOCAL98 = join(tmpdir(), 'fs-smoke-identity_map_local_98.json')
  writeFileSync(MAP98, JSON.stringify({
    v: 1, people: [
      { union_id: 'on_inc_98', name: '增量同事', open_ids: { cli_other_app: 'ou_other_view_98' } },
    ],
  }))
  writeFileSync(LOCAL98, JSON.stringify({
    v: 1, people: [
      { union_id: 'on_inc_98', name: '增量同事', open_ids: { [APP_ID]: 'ou_local_view_98' } },
      { union_id: 'on_only_98', name: '仅本地的人', open_ids: { [APP_ID]: 'ou_local_only_98' } },
    ],
  }))
  // 夹具先在新代次里把群会话绑上（feishu_send 要落到活着的会话；上一代次的映射不跨代）。
  armTurn85('98')
  feedGroup85(GROUP85, 'om_group98_bind', '@_user_1 绑定群会话-98', [MENTION_SELF85])
  await settle(4)
  const prevMap98 = process.env.MAILBOX_IDENTITY_MAP
  const prevLocal98 = process.env.MAILBOX_IDENTITY_LOCAL
  process.env.MAILBOX_IDENTITY_MAP = MAP98
  process.env.MAILBOX_IDENTITY_LOCAL = LOCAL98
  try {
    const tool98 = toolNow('feishu_send')
    ok(Boolean(tool98 && typeof tool98.execute === 'function'), '（前提）当前代次注册了 feishu_send')
    const mark98 = sentCards.length
    const hit98 = tool98 && await tool98.execute({ text: '增量视角复验-98', at: '增量同事', chatId: GROUP85 })
    await settle(2)
    const win98 = JSON.stringify(sentCards.slice(mark98))
    ok(hit98 && hit98.ok === true, '（前提）feishu_send 带 at 参数能发出去')
    ok(win98.includes('<at id=ou_local_view_98>增量同事</at>'),
      '★★ 本机视角的 ou 只在增量表里 ⇒ 同样 @ 得出来（旧实现只读主表 ⇒ 发成「未能 @ 出」）')
    ok(!win98.includes('ou_other_view_98'),
      '★★★ 绝不拿**别的应用视角**的 ou 去 @（open_id 是应用视角值，错视角＝@ 了个寂寞）')
    const mark98B = sentCards.length
    await tool98.execute({ text: '主表没有这个名字-98', at: '仅本地的人', chatId: GROUP85 })
    await settle(2)
    const win98B = JSON.stringify(sentCards.slice(mark98B))
    ok(win98B.includes('（未能 @ 出：仅本地的人）') && !win98B.includes('ou_local_only_98'),
      '★★ 增量里「主表没有的名字」一律不算数（与内核同口径：只补 id、不新增人名）')
  } finally {
    // 环境变量必须还原：这张临时主表会让**入站授权**（identityGuard）也换表，挂着不放
    //   就等于后面的用例跑在假身份目录上（A25：验证环境不能悄悄偏离生产）。
    if (prevMap98) process.env.MAILBOX_IDENTITY_MAP = prevMap98
    else delete process.env.MAILBOX_IDENTITY_MAP
    if (prevLocal98) process.env.MAILBOX_IDENTITY_LOCAL = prevLocal98
    else delete process.env.MAILBOX_IDENTITY_LOCAL
  }
  liveAgents.length = 0
}

console.log('99) ★🔴 /model：视觉影子路由不上卡 ＋ 点击真走宿主 selectModel ＋ 结果写回同一张卡（CM 2026-10-05「切换从来没成功过」）')
{
  // 🔴 三个缺陷一起钉，出处都是本机 dsh web 日志 output/dsh-install/web.log（A24 禁无出处断言）：
  //   ①「自动视图先把它删掉」：profile 插件 dsh-vision-router 给每条真路由再挂一条影子
  //     `<provider>-vision`、显示名拼成 `<源名> + 自动识图`，包装路由默认 id `deepseek-vision`
  //     ⇒ 同一批模型在卡上出现两遍。上一轮"按 provider 分组"只把重复**摆整齐**，没**去掉**。
  //   ②「卡片里切换从来没成功过」：旧实现调 `sessionController.selectForNextRequest`
  //     —— 那方法长在**内部** ApiSessionAgentController 上，远程服务对象没有 ⇒ 恒降级成
  //     `agent.session.append('model/selection', …)`，活 agent 的 picked 不变 ⇒ 下一次请求
  //     照用旧模型，**却回了「✅ 已切换」**＝假成功。改走宿主 GUI 同一条 `selectModel`。
  //   ③「卡片应该更新成已切换到 XX，不是另外发卡片」：结果必须 PATCH 回被点的那张卡。
  // ⚠️ 夹具坑（本用例第一版差点又假绿灯）：mock agent.session 原来**没有 append**
  //   ⇒ 旧兜底那句在冒烟里必然抛错 ⇒ "没走兜底"是恒真断言。现在挂了记录器 sessionAppendCalls。
  // ⚠️ 另一个坑：`sendPlainText` 实际发的是 `elements:[{tag:'markdown'}]` 的卡（不是 msg_type=text）
  //   ⇒ "另发一条提示"在夹具里的形状是**一条 markdown create**，按这个形状抓才对得上。
  const mdText = (c) => {
    const els = c && c.payload && Array.isArray(c.payload.elements) ? c.payload.elements : []
    return els.length && els[0] && els[0].tag === 'markdown' ? String(els[0].content) : null
  }
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod99 = await import('../index.js')
  mod99.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  armTurn85('99-pre')
  feedInbound('om_bind99', '先绑定单聊-99')
  await settle(4)

  // ---- ① 影子路由整段不上卡 ----------------------------------------------------
  llmOverride = {
    listProviders: () => [
      { id: 'test', name: 'DeepSeek 官方' },
      { id: 'test-vision', name: 'DeepSeek 官方 + 自动识图' },
      { id: 'mirror', name: 'DeepSeek 镜像' },
      { id: 'mirror-vision', name: 'DeepSeek 镜像 + 自动识图' },
      // 包装路由：id 里没有 `-vision`（默认为 deepseek-vision，但用户可改）⇒ 只有"字样"这条判据兜得住
      { id: 'wrapper', name: 'DeepSeek + 自动识图' },
    ],
    listModels: async (pid) => [{ id: 'm-' + String(pid).replace(/-vision$/, ''), name: 'M' }],
  }
  const mark99 = sentCards.length
  feedInbound('om_model99', '/model')
  await drain()
  llmOverride = null

  const picker99 = cardsSince(mark99).find((c) => c.op === 'create' && c.msgId
    && c.payload && Array.isArray(c.payload.elements) && mdText(c) === null)
  ok(!!picker99, '（前提）/model 出了一张可点击的选择卡（否则下面全是恒真）')
  const json99 = JSON.stringify((picker99 && picker99.payload) || {})
  const titles99 = []
  for (const el of picker99 ? picker99.payload.elements : []) {
    const txt = el && el.text && el.text.content ? String(el.text.content) : ''
    const mm = /^\*\*([\s\S]*)\*\*$/.exec(txt)
    if (mm) titles99.push(mm[1])
  }
  ok(titles99.length === 2 && titles99.includes('DeepSeek 官方') && titles99.includes('DeepSeek 镜像'),
    '★★★ 只剩两条真路由成段：`-vision` / 「+ 自动识图」影子路由整段不上卡（CM：自动视图先删掉）'
    + '｜实得 ' + JSON.stringify(titles99))
  ok(json99.indexOf('自动识图') === -1,
    '★★ 卡面上一个字都不提「自动识图」（段标题是宿主给的显示名 ⇒ 缺席只可能来自过滤）')
  const vals99 = allButtons(picker99).map((b) => String(b.value && b.value.fs_model))
  ok(vals99.length === 2 && vals99.includes('test|m-test') && vals99.includes('mirror|m-mirror'),
    '★★★ 按钮也只剩真路由那两个：没有 `-vision|` / `wrapper|` 这种"点了会切到影子路由"的按钮'
    + '｜实得 ' + JSON.stringify(vals99))

  // ---- ② 点击：真调宿主 selectModel，且结果写回同一张卡 -------------------------
  const pickerMsg99 = picker99 && picker99.msgId
  selectModelCalls = []
  sessionAppendCalls.length = 0
  const markClick99 = sentCards.length
  await tapValue({ fs_model: 'mirror|m-mirror' }, undefined, CHAT_ID, pickerMsg99)
  await settle(2)
  ok(selectModelCalls.length === 1,
    '★★★ 点击后**真的**调了宿主 sessionController.selectModel 一次（旧实现这方法不存在 ⇒ 0 次）'
    + '｜实得 ' + selectModelCalls.length)
  ok(selectModelCalls.length === 1 && selectModelCalls[0].sessionId === agent.id
    && selectModelCalls[0].provider === 'mirror' && selectModelCalls[0].model === 'm-mirror',
    '★★★ 入参就是宿主的 schema {sessionId=agent.id, provider, model}（sessionId 错＝切到别的会话/直接 unavailable）'
    + '｜实得 ' + JSON.stringify(selectModelCalls[0] || null))
  ok(sessionAppendCalls.length === 0,
    '★★★ 不再退回 `session.append(model/selection)` 兜底（只写持久事件、改不到活 agent ⇒ 假成功）')
  const winClick99 = cardsSince(markClick99)
  const patch99 = winClick99.find((c) => c.op === 'update' && c.msgId === pickerMsg99)
  ok(!!patch99, '★★★ 结果**写回被点的那张卡**（PATCH 同一个 message_id），不是另外发一条')
  // 🔴 第十四轮门槛 LOW（核对为真）：原来这条只按 msgId 匹配 ⇒ 拿**错的应用身份**发 PATCH
  //   照样算绿。真机上被点的这张卡属于**收到这次点击的那个 bot**，用别的应用身份 PATCH 会被
  //   API 拒（update card failed ⇒ 卡片不动），而夹具仍记成成功 ⇒ 正是本次改动最吃紧的假绿灯。
  ok(!!patch99 && patch99.app === APP_ID,
    '★★★ 写回用的是**收到这次点击的那个 bot** 的身份（ownerBot＝连接自带的 evtBot，不按会话猜）'
    + '｜实得 app=' + JSON.stringify((patch99 && patch99.app) || ''))
  const hdr99 = patch99 && patch99.payload && patch99.payload.header
  ok(Boolean(hdr99 && hdr99.title && String(hdr99.title.content).indexOf('已切换模型') >= 0),
    '★★ 终态卡标题＝「✅ 已切换模型」（CM：卡片应该更新成已切换到 XX 的提示）')
  ok(JSON.stringify((patch99 && patch99.payload) || {}).indexOf('mirror/m-mirror') >= 0,
    '★★ 卡上写清切到了哪条路由（provider/model 一起给，同名 model 跨路由才分得清）')
  ok(allButtons(patch99).length === 0,
    '★★ 终态卡不带按钮（与 /switch 的 buildSwitchResultCard 同口径；要再切就重发 /model）')
  ok(winClick99.filter((c) => c.op === 'create').length === 0,
    '★★★ 点击后**一条新消息都不发**（"卡片不动 ＋ 另发一条提示"正是 CM 明确否掉的形状）'
    + '｜实得 ' + JSON.stringify(winClick99.filter((c) => c.op === 'create').map(mdText)))

  // ---- ②' 宿主拒绝：如实报错，不再报喜 -----------------------------------------
  selectModelImpl = () => { throw new Error('session/model-unavailable: 没有这条路由') }
  selectModelCalls = []
  const markFail99 = sentCards.length
  await tapValue({ fs_model: 'mirror|m-mirror' }, undefined, CHAT_ID, pickerMsg99)
  await settle(2)
  selectModelImpl = null
  const failPatch99 = cardsSince(markFail99).find((c) => c.op === 'update' && c.msgId === pickerMsg99)
  ok(!!failPatch99 && JSON.stringify(failPatch99.payload).indexOf('没能切换模型') >= 0,
    '★★★ 宿主抛错 ⇒ 同一张卡改成「⚠️ 没能切换模型」（旧实现这里照样回 ✅ ＝ 假成功）')
  ok(!!failPatch99 && JSON.stringify(failPatch99.payload).indexOf('session/model-unavailable') >= 0,
    '★★ 失败原因原样写进卡面（用户看得出是"路由不可用"，不是"点了没反应"）')

  // ---- ②'' 宿主压根没这个服务：明说切不了，绝不静默兜底 -------------------------
  sessionControllerAvailable = false
  const markNa99 = sentCards.length
  await tapValue({ fs_model: 'mirror|m-mirror' }, undefined, CHAT_ID, pickerMsg99)
  await settle(2)
  sessionControllerAvailable = true
  const naPatch99 = cardsSince(markNa99).find((c) => c.op === 'update' && c.msgId === pickerMsg99)
  ok(!!naPatch99 && JSON.stringify(naPatch99.payload)
    .indexOf('宿主没有暴露 sessionController.selectModel') >= 0,
    '★★ 服务不在 ⇒ 明说「这台 dsh 版本切不了模型」，不降级成写事件假装成功')
  ok(sessionAppendCalls.length === 0, '★★ 这一支同样没有 append 兜底（兜底路径已整条删除）')

  // ---- ②'''' 第十四轮门槛 LOW（核对为真）：「点了没反应」另两条兜底分支 -------------
  //   生产有 3 条出口：①有 message_id 且 PATCH 成功（上面已钉）②事件**没给** open_message_id
  //   ③PATCH 被拒。②③原先没有任何用例覆盖 ⇒ 而这两支恰恰是"用户点了半天什么都不动"的形状。
  const markNoId = sentCards.length
  await tapValue({ fs_model: 'test|m-test' }, undefined, CHAT_ID, '')   // 不带 open_message_id
  await settle(2)
  const winNoId = cardsSince(markNoId)
  const textNoId = winNoId.filter((c) => c.op === 'create' && mdText(c) !== null).map(mdText)
  ok(winNoId.filter((c) => c.op === 'update').length === 0
    && textNoId.length === 1 && textNoId[0].indexOf('已切换为 `test/m-test`') >= 0,
    '★★ 事件没给 open_message_id ⇒ 不 PATCH，落**恰好一条**文本回执（写清切到了哪条路由）'
    + '｜实得 ' + JSON.stringify(textNoId))
  failPatchContaining = '已切换为'          // 逼 PATCH 走 transport 失败（真机"卡片不动"那条路）
  const markRej = sentCards.length
  await tapValue({ fs_model: 'test|m-test' }, undefined, CHAT_ID, pickerMsg99)
  await settle(2)
  const winRej = cardsSince(markRej)
  const textRej = winRej.filter((c) => c.op === 'create' && mdText(c) !== null).map(mdText)
  failPatchContaining = ''                 // 闸门用完即卸，别让它影响后面的用例
  ok(textRej.length === 1 && textRej[0].indexOf('已切换为 `test/m-test`') >= 0
    && winRej.filter((c) => c.op === 'update').length === 0,
    '★★ PATCH 被拒 ⇒ 同一份结果**降级为恰好一条**文本回执（失败的 PATCH 夹具不落记录，'
    + '这里再断"窗口内没有成功 PATCH"挡重试）｜实得 ' + JSON.stringify(textRej))

  // ---- ②''''' 第十四轮门槛 MEDIUM（核对为真）：宿主 resolve 但**没回带 selected** ------
  //   旧实现在这一支把**请求值**当成**宿主确认的结果**回显（日志 selectModel ok ＋ 卡片
  //   「✅ 已切换为 …」）—— 正是本轮要消灭的"假成功"形状；宿主若做了归一化还会把没生效的
  //   名字报成已生效。现在：有 selected 才算确认；没确认**既不谎报成功也不谎报失败**。
  selectModelImpl = () => ({})             // 请求被接受、响应里没有 selected（老版本/归一化宿主）
  selectModelCalls = []
  const markUnc = sentCards.length
  await tapValue({ fs_model: 'test|m-test' }, undefined, CHAT_ID, pickerMsg99)
  await settle(2)
  selectModelImpl = null
  const uncPatch = cardsSince(markUnc).find((c) => c.op === 'update' && c.msgId === pickerMsg99)
  const uncJson = JSON.stringify((uncPatch && uncPatch.payload) || {})
  ok(selectModelCalls.length === 1, '（前提）未确认这一支仍然真调了宿主一次')
  ok(uncJson.indexOf('宿主没有回带确认') >= 0 && uncJson.indexOf('已切换为') === -1,
    '★★★ 没回带 selected ⇒ 卡片如实说「宿主没有回带确认」，**不写「已切换为」**（请求值不冒充确认值）'
    + '｜实得 ' + uncJson.slice(0, 160))

  // ---- 文字通道 /model <provider>/<model> 走同一条路 ---------------------------
  selectModelCalls = []
  const markTxt99 = sentCards.length
  const log99 = consoleLines.length
  const saveBefore99 = dmSaveCalls.length
  feedInbound('om_model99t', '/model mirror/m-mirror')
  await drain()
  ok(selectModelCalls.length === 1,
    '★★ 文字直切也走 selectModel（两条通道同源，不留第二条"看起来成功"的路）')
  // 🔴 第四十七轮 MEDIUM#1 的堵漏格：健康宿主必须走「宿主即时落地」支（第一拍命中、桥不代劳）。
  //   夹具曾把健康支写坏成"恒不写本次选择"而**全链无一红**（回执两条路径同字面）——判据不能只看回执。
  ok(consoleLines.slice(log99).some((l) => String(l).includes('宿主即时落地')),
    '★★ 健康宿主 ⇒ 落地校验第一拍命中，留痕「宿主即时落地」（夹具/实现漂移致恒走兜底＝本条必红）')
  ok(dmSaveCalls.length === saveBefore99,
    '★★ 宿主自己存了 ⇒ 桥不直存代劳（txt99 走即时支；dmSaveCalls 零增长）｜实增 '
    + (dmSaveCalls.length - saveBefore99))
  const txt99 = cardsSince(markTxt99).filter((c) => c.op === 'create' && mdText(c) !== null).map(mdText)
  ok(txt99.length === 1 && txt99[0] === '✅ 模型已切换为 `mirror/m-mirror` 并记为默认（后续每条消息、重连/恢复都按它走）',
    '★★ 文字回执写宿主**归一化后**的 provider/model＋落地已验证才许说「已切换」（#124），且不含旧的 append 兜底字样｜实得 ' + JSON.stringify(txt99))
  selectModelImpl = () => ({})
  const markTxtUnc = sentCards.length
  feedInbound('om_model99x', '/model mirror/m-mirror')
  await drain()
  selectModelImpl = null
  const txtUnc = cardsSince(markTxtUnc).filter((c) => c.op === 'create' && mdText(c) !== null).map(mdText)
  ok(txtUnc.length === 1 && txtUnc[0].indexOf('宿主没有回带确认') >= 0
    && txtUnc[0].indexOf('模型已切换为') === -1,
    '★★ 文字通道同一口径：未确认 ⇒ 明说「宿主没有回带确认」，不写「✅ 模型已切换为」'
    + '｜实得 ' + JSON.stringify(txtUnc))

  // 🔴 中台 #124 三形态（CM 裁决：桥必须保证**落地**，不许推给宿主线）：
  //   ④A 宿主②半静默没跑 ⇒ 桥**直存** saveSelection 后落地 ⇒ 回执"并记为默认"；
  //   ④B 直存也失败 ⇒ 回执如实"默认值未写入"，**禁**「已切换」；
  //   ④C 服务没 saveSelection 口 ⇒ 如实"桥直存无门"。旧字节（无校验）三支全红。
  try {
    resetDmFixtures()
    dmSilentDrop = true
    // 前提（陷阱 30②）：上一支 txtUnc 的健康桩已把 dmSelection 写成 mirror/m-mirror，
    //   不清回去 ④A 的回读会**假性即时匹配**（目标==残留值），直存分支根本没被演。
    //   复位由 resetDmFixtures() 单源完成（它把 dmSelection 摆回 test/test-model、dmSaveCalls 清空）
    //   ——🔴 第五十轮 LOW#1：原来这里又手抄了一遍这两个赋值，复位值一改就漂移，删掉。
    // ↑（第五十一轮 LOW#7）原来这里每支都抄一遍 `selectModelCalls = []`，可本块没有任何判据读它
    //   （"宿主被调了几次"那两枚钉在 #124 块之前的两个「前提」格里，104 各自读之前自己清）＝死赋值。
    const mark124a = sentCards.length
    feedInbound('om_model124a', '/model mirror/m-mirror')
    await settle(2)
    const txt124a = cardsSince(mark124a).filter((c) => c.op === 'create' && mdText(c) !== null).map(mdText)
    ok(txt124a.length === 1 && txt124a[0].includes('并记为默认') && txt124a[0].includes('mirror/m-mirror'),
      '★★★ #124A 宿主没存默认 ⇒ 桥**直存后落地**，回执"已切换…并记为默认"｜实得 ' + JSON.stringify(txt124a))
    ok(dmSaveCalls.length === 1 && dmSaveCalls[0].provider === 'mirror' && dmSaveCalls[0].model === 'm-mirror',
      '★★★ 桥真的替宿主把默认值写了一遍（参数＝目标路由）｜实得 ' + JSON.stringify(dmSaveCalls))
    dmSaveFails = true
    const mark124b = sentCards.length
    await tapValue({ fs_model: 'test|m-test' }, undefined, CHAT_ID, pickerMsg99)
    await settle(2)
    const patch124b = cardsSince(mark124b).find((c) => c.op === 'update' && c.msgId === pickerMsg99)
    const json124b = JSON.stringify((patch124b && patch124b.payload) || {})
    ok(json124b.includes('默认值未写入') && json124b.includes('桥直存报错')
      && json124b.indexOf('已切换为') === -1,
      '★★★ #124B 直存也失败 ⇒ 卡片如实说「默认值未写入（桥直存报错…）」，**不写「已切换为」**（验收标准 D）'
      + '｜实得 ' + json124b.slice(0, 200))
    dmSaveFails = false
    // ④D 直存**挂死不返回**（#124 疑似根因：宿主保存队列被热重载风暴拖住）⇒ 桥 4 秒有界
    //     放弃，回执如实"桥直存 4 秒未返回"。这支同时钉 A19：回执不许被宿主队列无限悬着。
    dmSaveHangs = true
    const log124d = consoleLines.length
    const mark124d = sentCards.length
    await tapValue({ fs_model: 'test|m-test' }, undefined, CHAT_ID, pickerMsg99)
    await settle(10)
    const patch124d = cardsSince(mark124d).find((c) => c.op === 'update' && c.msgId === pickerMsg99)
    const json124d = JSON.stringify((patch124d && patch124d.payload) || {})
    ok(json124d.includes('秒未返回') && json124d.indexOf('已切换为') === -1,
      '★★★ #124D 直存挂死 ⇒ 桥**有界** 4 秒放弃并如实回执（不许悬到宿主队列自己醒）'
      + '｜实得 ' + json124d.slice(0, 160))
    ok(consoleLines.slice(log124d).some((l) => String(l).indexOf('默认值落地 FAIL') >= 0),
      '★★ 落地失败留痕（日志含「默认值落地 FAIL」）')
    dmSaveHangs = false
    dmNoSaveApi = true
    // ④C 目标与残留默认**不同**才走得到"没口"分支（同值会被即时读回判成已落地）。
    const mark124c = sentCards.length
    await tapValue({ fs_model: 'test|m-test' }, undefined, CHAT_ID, pickerMsg99)
    await settle(2)
    const patch124c = cardsSince(mark124c).find((c) => c.op === 'update' && c.msgId === pickerMsg99)
    const json124c = JSON.stringify((patch124c && patch124c.payload) || {})
    ok(json124c.includes('桥直存无门') && json124c.indexOf('已切换为') === -1,
      '★★ #124C 服务没暴露 saveSelection ⇒ 如实「桥直存无门」，同样禁报喜｜实得 ' + json124c.slice(0, 160))
    // ---- 🔴 第四十四轮 MEDIUM#3（核对为真）：#124 四象限里文字通道的两个失败支原来没演 ----
    //   ④E confirmed && !persisted（文字档）：宿主②半没跑＋桥直存也报错 ⇒ 文字回执必须
    //      如实「下一条请求会用…但默认值未写入（桥直存报错…）」，禁「模型已切换为」。
    //   卡片档④B 演的是同一象限的另一通道；两通道回执由**两个格式化器**分别拼装，
    //   只钉一边＝另一边可以随便回归。
    dmNoSaveApi = false      // ④C 的"没口"旗用完即卸——④E 要的正是"有口但报错"
    dmSaveFails = true
    const mark124e = sentCards.length
    feedInbound('om_model124e', '/model test/m-test')   // 残留默认=mirror/m-mirror，目标必须不同
    await settle(3)
    dmSaveFails = false
    const txt124e = cardsSince(mark124e).filter((c) => c.op === 'create' && mdText(c) !== null).map(mdText)
    ok(txt124e.length === 1 && txt124e[0].includes('下一条请求会用 `test/m-test`')
      && txt124e[0].includes('默认值未写入（桥直存报错') && txt124e[0].indexOf('模型已切换为') === -1,
      '★★★ #124E 文字档 confirmed+未落地 ⇒ 「下一条请求会用…但默认值未写入（桥直存报错…）」，'
      + '禁「✅ 模型已切换为」（与卡片档④B 同象限同口径）｜实得 ' + JSON.stringify(txt124e))
    //   ④F !confirmed && !persisted（文字档）：宿主没回带 selected ＋②半没跑＋没直存口。
    selectModelImpl = () => ({})
    dmNoSaveApi = true
    const mark124f = sentCards.length
    feedInbound('om_model124f', '/model test/m-test')
    await settle(3)
    selectModelImpl = null
    dmNoSaveApi = false
    dmSilentDrop = false
    const txt124f = cardsSince(mark124f).filter((c) => c.op === 'create' && mdText(c) !== null).map(mdText)
    ok(txt124f.length === 1 && txt124f[0].includes('切换请求已发给宿主')
      && txt124f[0].includes('宿主没有回带确认') && txt124f[0].includes('默认值未写入')
      && txt124f[0].indexOf('模型已切换为') === -1,
      '★★★ #124F 文字档 未确认+未落地 ⇒ 「切换请求已发给宿主…宿主没有回带确认，且默认值未写入」'
      + '（四象限文字档补齐；未确认不许写「✅」，未落地不许写「已切换」）｜实得 ' + JSON.stringify(txt124f))
    // ---- 🔴 第四十四轮 MEDIUM#5（核对为真）：宿主**半拍后**才落地 —— 钉轮询循环后续拍 ----
    //   ④G dmDelayedLand=2 ⇒ 头两次 currentSelection 读旧值，第三拍才读到目标 ⇒
    //   回执仍是「✅ …并记为默认」（落地已验证才许报喜），留痕必须走「宿主半拍后落地（第 N 拍读到）」
    //   支；桥**不许**因头两拍没读到就多直存一次（宿主自己跟上了就不该代劳）。
    dmSelection = { provider: 'test', model: 'test-model' }
    dmDelayedLand = 2
    const saveCallsBefore124g = dmSaveCalls.length
    const log124g = consoleLines.length
    const mark124g = sentCards.length
    feedInbound('om_model124g', '/model mirror/m-mirror')
    await settle(4)
    dmDelayedLand = 0
    dmPendingLand = null
    const txt124g = cardsSince(mark124g).filter((c) => c.op === 'create' && mdText(c) !== null).map(mdText)
    ok(txt124g.length === 1 && txt124g[0].includes('并记为默认') && txt124g[0].includes('mirror/m-mirror'),
      '★★★ #124G 半拍落地 ⇒ 轮询等到后回执仍是「已切换…并记为默认」（报喜以**落地已验证**为准，'
      + '不以即时为准）｜实得 ' + JSON.stringify(txt124g))
    ok(consoleLines.slice(log124g).some((l) => /宿主半拍后落地（第 \d+ 拍读到）/.test(String(l))),
      '★★ 留痕走「宿主半拍后落地（第 N 拍读到）」支（旧夹具恒第一拍命中＝该支死代码）')
    ok(dmSaveCalls.length === saveCallsBefore124g,
      '★★ 宿主自己半拍跟上了 ⇒ 桥**不代劳直存**（dmSaveCalls 零增长）｜实增 '
      + (dmSaveCalls.length - saveCallsBefore124g))
  } finally { resetDmFixtures() }

  // 🔴 中台 #171（per-bot 预设，0.8.5）：default 预设＝全员可见的暴露面（HR 工具被任何 bot
  //   摸到，中台 #171 真机实锤）。桥必须把 bot 配置 `agentPreset` 递到 registry `mount(ctx, id)`：
  //   ①主夹具 bot 不写该字段 ⇒ mount 第二参＝undefined（registry `id ?? defaultId` 回落默认，
  //     现行为一字不动——基线格；create/resume 两腿都要演，resume 漏挂＝#156 同族死灰）；
  //   ②配置写 `agentPreset: 'preset-hr'` + 10 秒热读 ⇒ 新 chat 的 create/resume 都把该 id 递到 registry；
  //   ③id 查无 ⇒ registry 抛 not-found ⇒ 失败日志**可见**（含请求 id 与 bot 名），**禁静默回落**
  //     （回落＝把配置错误捂成正常，与本仓「拒得清楚」口径一致）；
  //   ④带空白的 id ⇒ normalizeConfig trim 后生效（若白名单丢字段 ⇒ mount 收 undefined ⇒ 本格红）。
  // 🔴 会话生命周期（第一/二版用例踩过）：mount 只发生在**建/复会**——live 会话或 entry.handle
  //   命中即复用、不再 mount ⇒ 每格用**新 chat** 演 create 腿；resume 腿＝模拟重启：重新
  //   import+apply 重建桥内存（entry.handle 随之清零，先例：热重载提示用例）＋清 liveAgents，
  //   下一条消息即走 resume 分支，演完恢复。
  const writeBotCfg = (extra) => writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'),
    JSON.stringify({ bots: [Object.assign({
      name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
      reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true,
    }, extra)] }, null, 2))
  const simulateRestart = async () => {
    const mod = await import('../index.js')
    mod.apply(ctx)
    await drain()
    liveAgents.length = 0
  }
  try {
    resetPresetMountFixtures()
    // ① 基线：新 chat 首条建会话（create 腿）⇒ 模拟重启 ⇒ 次条走 resume 腿
    const markP1 = presetMountCalls.length
    feedInbound('om_preset_a171', '预设基线第一条', { chatId: 'oc_preset_base171' })
    await settle(3)
    await simulateRestart()
    feedInbound('om_preset_b171', '预设基线第二条', { chatId: 'oc_preset_base171' })
    await settle(3)
    liveAgents.push(agent)
    const legP1 = presetMountCalls.slice(markP1)
    ok(legP1.length === 2 && legP1[0] === undefined && legP1[1] === undefined,
      '★★★ #171① 未写 agentPreset ⇒ create/resume 两腿 mount 第二参都是 undefined'
      + '（registry 回落默认＝现行为不变；resume 腿同样挂载，不许再出「会话没工具」死灰）'
      + '｜实得 ' + JSON.stringify(legP1))
    // ② 写 agentPreset + 热读 ⇒ 新 chat 两腿按 id 挂载
    writeBotCfg({ agentPreset: 'preset-hr' })
    await new Promise((r) => setTimeout(r, 11000))   // 等过热读节拍（bot.cfg 每 10 秒重读）
    await drain()
    const markP2 = presetMountCalls.length
    feedInbound('om_preset_c171', '预设专用 chat 第一条', { chatId: 'oc_preset_hr171' })
    await settle(3)
    await simulateRestart()
    feedInbound('om_preset_d171', '预设专用 chat 第二条', { chatId: 'oc_preset_hr171' })
    await settle(3)
    liveAgents.push(agent)
    const legP2 = presetMountCalls.slice(markP2)
    ok(legP2.length === 2 && legP2[0] === 'preset-hr' && legP2[1] === 'preset-hr',
      '★★★ #171② 配置写 agentPreset ⇒ 新 chat 的 create/resume 两腿都把 id 递到 registry'
      + '（per-bot 挂载通道通——#171 的收口机制本体）｜实得 ' + JSON.stringify(legP2))
    // ③ id 查无 ⇒ 失败日志可见，禁静默回落（新 chat 逼 create 腿；挂载失败**不拒服务**）
    presetMountImpl = () => {
      const e = new Error('Unknown agent preset: preset-hr')
      e.code = 'agent-preset/not-found'
      throw e
    }
    const logP3 = consoleLines.length
    const markP3 = sentCards.length
    feedInbound('om_preset_e171', '预设查无此名', { chatId: 'oc_preset_bad171' })
    await settle(3)
    presetMountImpl = null
    const p3Logs = consoleLines.slice(logP3).map(String).filter((l) => l.includes('preset'))
    ok(p3Logs.some((l) => l.includes('[fs] preset mount failed') && l.includes('preset-hr') && l.includes('smoke')),
      '★★★ #171③ id 查无 ⇒ mount 失败日志可见（含请求 id 与 bot 名），**不静默回落**'
      + '｜实得 ' + JSON.stringify(p3Logs.slice(0, 2)))
    ok(cardsSince(markP3).length > 0,
      '★★ 挂载失败**不拒服务**：卡片链路照常走（fail-soft 在工具层、不在消息层）'
      + '｜卡片动作 ' + cardsSince(markP3).length)
    // ④ 带空白的 id ⇒ trim 通道（写法容错；白名单丢字段的话这里收 undefined ⇒ 红）
    writeBotCfg({ agentPreset: '  preset-hr  ' })
    await new Promise((r) => setTimeout(r, 11000))
    await drain()
    const markP4 = presetMountCalls.length
    feedInbound('om_preset_f171', '空白预设等同未写', { chatId: 'oc_preset_trim171' })
    await settle(3)
    const legP4 = presetMountCalls.slice(markP4)
    ok(legP4.length === 1 && legP4[0] === 'preset-hr',
      '★★ #171④ 带空白的 agentPreset ⇒ trim 后仍生效（normalizeConfig 白名单 trim 通道通）'
      + '｜实得 ' + JSON.stringify(legP4))
  } finally {
    // 还原主夹具（无 agentPreset）——后续用例不受本块污染
    writeBotCfg(undefined)
    await new Promise((r) => setTimeout(r, 11000))
    await drain()
    liveAgents.push(agent)
    resetPresetMountFixtures()
  }

  // 🔴 第四十四轮 MEDIUM#4（核对为真）：peer **变更即落盘**。persistChats 不在常规入站路径上
  //   （只有 /new/switch/建会话/标题变化会调），旧行为 = noteChatPeer 只写内存 ⇒ 已存在的会话
  //   重启后 state 里没有 peer ⇒ approverChatFor 找不到审批人私聊、审批卡发不出去。
  //   判据用**换发言人**（首条消息的落盘由建会话路径顺带完成，未修版本也过——那不算判别）。
  {
    const PEER_CHAT = 'oc_peerflush_084'
    const PEER_CHAT2 = 'oc_peerhelp_084'
    const statePathPeer = join(process.env.FS_CONFIG_DIR,
      'state-' + String(APP_ID).replace(/[^a-zA-Z0-9]/g, '') + '.json')
    const readRec = (chatKey) => {
      try {
        const st = JSON.parse(readFileSync(statePathPeer, 'utf8'))
        return st && st.chats && st.chats[chatKey] ? st.chats[chatKey] : undefined
      } catch { return undefined }
    }
    const readPeer = (chatKey) => { const r = readRec(chatKey); return r ? r.peer : undefined }
    // 🔴 第四十六轮 LOW#5：不再手抄第 4 份事件信封——feedInbound 已有 opts（chatId/openId/unionId）
    const feedPeer = (msgId, ou, chat, text, opts) => feedInbound(msgId, text || ('普通消息-' + msgId),
      Object.assign({ chatId: chat, openId: ou, unionId: 'on_' + ou }, opts || {}))
    feedPeer('om_peer_a084', 'ou_peer_a', PEER_CHAT)
    await settle(3)
    ok(readPeer(PEER_CHAT) === 'ou_peer_a', '（前提）A 的首条消息把会话建好并带上 peer=ou_peer_a')
    feedPeer('om_peer_b084', 'ou_peer_b', PEER_CHAT)
    await settle(3)
    ok(readPeer(PEER_CHAT) === 'ou_peer_b',
      '★★★ 换发言人 ⇒ peer 变更**即时落盘**（未修时 state 停留在 ou_peer_a：persistChats 不在'
      + '常规入站路径 ⇒ 重启后审批人私聊找不回）｜实得 ' + String(readPeer(PEER_CHAT)))
    // 🔴 第四十五轮 LOW#1（核对为真）：审批人**第一条就是 /help**（不起回合、不建会话）⇒
    //   命令支的占位 chat 只进内存不落盘，noteChatPeer 的 flush 又发生在占位建出来之前
    //   ⇒ peer 到不了 state，重启后照样找不到审批人私聊。修复=占位建好当场落盘。
    feedPeer('om_peer_c084', 'ou_peer_c', PEER_CHAT2, '/help')
    await settle(3)
    ok(readRec(PEER_CHAT2) && readPeer(PEER_CHAT2) === 'ou_peer_c',
      '★★★ 新会话首条是 /help ⇒ 占位 chat+peer 一并落盘（旧字节 state 里根本没这条会话＝必红）'
      + '｜实得 ' + JSON.stringify(readRec(PEER_CHAT2) || null).slice(0, 120))
    // 🔴 第五十一轮 MEDIUM#1（核对为真）：真机入口 `handleHelperMessage` 把 peer 登记**嵌在
    //   `if (evt.chat_type)` 里**，而内部入口 `handleInbound:5416` 是无条件登记 ⇒ 事件不带
    //   chat_type 时这条腿整个漏记（chatPeers 是 approverChatFor 与命令路径认人的数据源）。
    //   判别形状：**新会话 + 首条 /help + 不带 chat_type**——命令在 handleInbound 之前就分流
    //   走了（永远走不到那条无条件腿），所以只有入口这条腿能记下 peer；把 noteChatPeer 塞回
    //   if 里（变异 M5）⇒ 本条必红（state 有占位会话但 peer 字段为空）。
    const PEER_CHAT4 = 'oc_peer_noctype_084'
    feedPeer('om_peer_d084', 'ou_peer_d', PEER_CHAT4, '/help', { chatType: null })
    await settle(3)
    ok(readRec(PEER_CHAT4) && readPeer(PEER_CHAT4) === 'ou_peer_d',
      '★★★ 事件**不带 chat_type** ⇒ peer 仍登记并落盘（两个入口口径归一，不是"字段缺就整条漏"）'
      + '｜实得 ' + JSON.stringify(readRec(PEER_CHAT4) || null).slice(0, 120))
    // 🔴 第四十七轮 LOW#4（核对为真）：群侧换发言人原来也**每条一次同步全量写盘**⇒ 改成
    //   置旗标 + 既有节拍一拍一刷。判别＝这条合并通道真的把 peer 送进了 state
    //   （把节拍里那段 flush 循环删掉 ⇒ 本条必红；p2p 的即时写归上面两格管）。
    const PEER_CHAT3 = 'oc_peergroup_084'
    // 🔴 r42 自查（第一版本格自己就是红的）：**群消息没有 @bot 会被入口直接忽略**
    //   （`group msg without @bot ignored`），不带 mention 的两条喂进去什么都没发生 ⇒
    //   "前提"格先红。按 66/106 同款补 GROUP_MENTION，并把发言人从 sender 里带进来。
    const feedGroupPeer = (msgId, ou) => feedGroup85(PEER_CHAT3, msgId, '@_user_1 普通消息-' + msgId,
      GROUP_MENTION, { sender_id: { open_id: ou, union_id: 'on_' + ou }, sender_type: 'human' })
    feedGroupPeer('om_peerg1_084', 'ou_pg1')
    await settle(2)
    ok(readPeer(PEER_CHAT3) === 'ou_pg1', '（前提）群会话首条把 peer 落到盘（建会话路径顺带写）')
    feedGroupPeer('om_peerg2_084', 'ou_pg2')
    await settle(2)
    ok(readPeer(PEER_CHAT3) === 'ou_pg2',
      '★★★ 群侧换发言人 ⇒ peer 经**合并节拍**落盘（旗标+一拍一刷，不丢＝必红）｜实得 '
      + String(readPeer(PEER_CHAT3)))
    // 🔴 第四十九轮 LOW（smoke:7490，核对为真）——**重载边界如实写明，不假装钉住**：
    //   门槛问的是"重启后审批人找不回"这条契约，本格只钉到**同代内**旗标→落盘。代码侧
    //   已补第二处消费方（生命周期清理里 `flushPendingPeerChanges()`，index.js teardown），
    //   契约成立；但**夹具演不出那个窗口**——真机里事件读取（drainOutput）与合并冲刷在
    //   **同一个节拍回调**里（index.js:10431 → 冲刷在尾部），所以"置了旗标却没赶上冲刷"
    //   只能由 handleInbound 那条异步腿（5387）产生，而它拿的是同一条事件、同一个发言人
    //   ⇒ 值不变、不触发写。故此处**不补**一格"dispose 后再断言"（那种格子删掉冲刷循环
    //   也不会红＝假绿灯，见本文件口径第 32 条），把边界如实记录在这里。
  }

  // ---- ③「当前」读会话自己的选择（sessionProjections.modelSelection） ----------
  modelSelectionState = {
    pending: { provider: 'mirror', model: 'm-mirror' },
    lastUsed: { provider: 'test', model: 'm-test' },
  }
  llmOverride = {
    listProviders: () => [
      { id: 'test', name: 'DeepSeek 官方' },
      { id: 'mirror', name: 'DeepSeek 镜像' },
    ],
    listModels: async (pid) => [{ id: 'm-' + String(pid), name: 'M' }],
  }
  const markCur99 = sentCards.length
  feedInbound('om_model99c', '/model')
  await drain()
  const curCard99 = cardsSince(markCur99).find((c) => c.op === 'create' && c.payload
    && Array.isArray(c.payload.elements) && mdText(c) === null)
  const curJson99 = JSON.stringify((curCard99 && curCard99.payload) || {})
  ok(curJson99.indexOf('当前：`mirror/m-mirror`') >= 0,
    '★★★「当前」读**本会话**待生效的 pending，不是全局默认 test/test-model（旧实现恒显示默认值）')
  const curBtns99 = allButtons(curCard99).map((b) => ({
    label: String(b.text && b.text.content), value: String(b.value && b.value.fs_model),
  }))
  ok(curBtns99.some((b) => b.label.indexOf('▶ ') === 0 && b.value === 'mirror|m-mirror')
    && !curBtns99.some((b) => b.label.indexOf('▶ ') === 0 && b.value === 'test|m-test'),
    '★★ ▶ 高亮跟着会话选择走（旧实现读不到 ⇒ 高亮永远停在全局默认那条）')

  // pending 清空后退回 lastUsed（宿主 request/header 落定的那一条）
  modelSelectionState = { pending: null, lastUsed: { provider: 'test', model: 'm-test' } }
  const markUsed99 = sentCards.length
  feedInbound('om_model99u', '/model')
  await drain()
  llmOverride = null
  const usedCard99 = cardsSince(markUsed99).find((c) => c.op === 'create' && c.payload
    && Array.isArray(c.payload.elements) && mdText(c) === null)
  ok(JSON.stringify((usedCard99 && usedCard99.payload) || {}).indexOf('当前：`test/m-test`') >= 0,
    '★★ 没有 pending 时显示 lastUsed（＝上一次请求真正用的模型），不是全局默认 test/test-model')

  // 还原：用例 94 的 ▶ 断言靠 agentDefaultModel 生效，modelSelection 挂着会盖掉它
  modelSelectionState = undefined
  liveAgents.length = 0
}

console.log('100) ★🔴 「✕ 取消」的真删卡分支必须可达：DELETE 通道打通 + 被拒时降级 PATCH 成「已取消」（第十五轮门槛 MEDIUM#4）')
{
  // 为什么这条以前**测不到**：夹具的 `/im/v1/messages` 分支不分方法，DELETE（没有请求体）
  //   落进建卡分支的 `JSON.parse(init.body)` ⇒ 抛的是**夹具自己的** SyntaxError ⇒
  //   `httpJson` 把它当成网络失败（status 0）⇒ `deleteMessage` 恒 false ⇒ CM 按「✕ 取消」
  //   之后的**成功出口**（把消息删掉）在冒烟里从来没被执行过，能绿的只有降级 PATCH。
  //   按 A25 的口径：被测代码的出口必须用生产的方式跑到，不能由夹具替它决定走哪条。
  // 🔴 第十八轮门槛（LOW，核对为真）：**单 bot** 配置下 `dels[0].app === APP_ID` 是恒真的——
  //   「这张卡的主人」和「唯一那个已连接 bot」在夹具里是同一个对象 ⇒ 真把身份来源写错
  //   （比如永远取配置里第一个 bot）照样绿。改按用例 78/81 的双 bot 形态：卡挂在**第二个**
  //   bot 上、点击也从**第二个** bot 的通道进来（这就是真机形状：卡片回调只投给建卡的那个应用），
  //   `app` 才真的能分辨身份来源。第一个 bot 仍在配置里且排在前面，所以"取第一个"这种
  //   错误实现会被断言抓红。
  const CFG100 = join(process.env.FS_CONFIG_DIR, 'feishu.config.json')
  const APP2_100 = 'cli_second_bot100'
  writeFileSync(CFG100, JSON.stringify({
    bots: [
      { name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
        reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true },
      { name: 'smoke2', workspace: WORKSPACE, appId: APP2_100, appSecret: 'secret-100b',
        reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true },
    ],
  }, null, 2))
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod100 = await import('../index.js')
  mod100.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  armTurn85('100')
  persistedSessions = [
    { version: 0, id: 'sess-100aaaa1111', createdAt: Date.now() - 3600e3, cwd: WORKSPACE },
    { version: 0, id: 'sess-100bbbb2222', createdAt: Date.now() - 1800e3, cwd: OTHER_WORKSPACE },
  ]
  const proc100b = extraProcs.get(APP2_100)
  ok(Boolean(proc100b), '（前提）第二个 bot 起了**自己的** helper 通道（否则"卡主人"与"唯一已连接 bot"仍是同一个，身份断言会退回恒真）')
  // 指到**指定 bot 的连接**上收发（`feedInbound`/`tapValue` 只认 fakeProc＝配置里的第一个 bot）
  const feedOn100 = (proc, msgId, text) => {
    proc.output += JSON.stringify({
      type: 'event', eventType: 'im.message.receive_v1',
      data: {
        message: { message_id: msgId, message_type: 'text', chat_id: CHAT_ID, chat_type: 'p2p',
          content: JSON.stringify({ text }) },
        sender: { sender_id: { open_id: 'ou_test' } },
      },
    }) + '\n'
  }
  const tapOn100 = async (proc, value, msgId) => {
    proc.output += JSON.stringify({
      type: 'event', eventType: 'card.action.trigger',
      data: {
        action: { tag: 'button', value },
        context: { open_chat_id: CHAT_ID, ...(msgId ? { open_message_id: msgId } : {}) },
      },
    }) + '\n'
    await drain()
  }
  // 🔴 故意**不**做 `|| fakeProc` 的降级：次 bot 通道没起来时这条用例应当报红，
  //   而不是静默退回单 bot 形态把身份断言重新变成恒真。
  // 🔴 第二十轮门槛 MEDIUM（核对为真）：但上面那条前置是**软断言**（`ok()` 不中断执行），
  //   原来这里直接解引用 `proc100b` ⇒ 通道缺失时 `proc.output += …` 抛未捕获 TypeError、
  //   **整个冒烟当场崩**，用例 101–103 不再执行，失败被报成一次无关崩溃而不是受控的红。
  //   ⇒ 空壳只补「取不到就崩」这一个洞：它是 `{ output: '' }`，**没有**任何 bot 语义，
  //   事件写进去不会有人应答 ⇒ 下面那条「（前提）/switch 出在**第二个** bot 的身份上」
  //   自然报红、后续断言被 `if (cancelBtn100 && wsCard100)` 跳过 = 受控红，不是恒真。
  const owner100 = proc100b || { output: '' }
  // ---- ① 成功出口：DELETE 打到这张卡的 message_id，且**不再** PATCH/另发 -------
  const markWs100 = sentCards.length
  feedOn100(owner100, 'om_switch100_ws', '/switch')
  await settle(4)
  const wsCard100 = lastCardFrom(markWs100)
  const cancelBtn100 = wsCard100 ? allButtons(wsCard100).find((b) => b.value && b.value.fs_level === 'cancel') : undefined
  ok(!!wsCard100 && !!wsCard100.msgId && !!cancelBtn100 && wsCard100.app === APP2_100,
    '（前提）/switch 出在**第二个** bot 的身份上且卡上有「✕ 取消」（'
      + JSON.stringify({ card: !!wsCard100, app: wsCard100 && wsCard100.app,
        msgId: wsCard100 && wsCard100.msgId, btn: !!cancelBtn100 }) + '）')
  if (cancelBtn100 && wsCard100) {
    const delMark100 = messageDeletes.length
    const cardMark100 = sentCards.length
    const logMark100 = consoleLines.length
    // 🔴 第十六轮门槛 LOW（核对为真）：「不起回合」的基线原来在 `/switch` **之前**取，
    //   测的时间窗是 [/switch, 取消] 两段 ⇒ 断言被 `/switch` 的行为绑住。`/switch` 今天
    //   恰好不起回合所以看不出来，但命令路径**是能**起回合的（本文件别处就写着 `/plan <正文>`
    //   会起真回合）⇒ 将来任何让 `/switch` 起回合的改动都会把这条红成"取消有问题"。
    //   基线和其余三个 mark 同点位取，断言才只归因于这一次点击。
    const sentMark100 = agent.sent.length
    await tapOn100(owner100, cancelBtn100.value)
    await settle(3)
    const dels100 = messageDeletes.slice(delMark100)
    ok(dels100.length === 1 && dels100[0].msgId === wsCard100.msgId,
      '★★★ 取消真的发出一次 DELETE，删的就是这张卡（msgId=' + dels100.map((d) => d.msgId).join(',')
        + '，期望 ' + wsCard100.msgId + '）')
    ok(dels100.length === 1 && dels100[0].app === APP2_100,
      '★★★ 删卡用的是**这张卡的主人**（挂在配置里第二个 bot 上）那个应用的身份，'
        + '不是"取配置里第一个 bot"（跨应用删别人的消息必被拒）｜实得 '
        + dels100.map((d) => d.app).join(',') + '，期望 ' + APP2_100 + ' 且不得为 ' + APP_ID)
    const after100 = sentCards.slice(cardMark100)
    ok(after100.length === 0,
      '★★ 删成功后不再 PATCH、也不再另发一条提示（CM 的口径是「卡片撤销掉」，不是多一条消息）｜实得 '
        + after100.map((c) => c.op).join(','))
    ok(consoleLines.slice(logMark100).some((l) => l.includes('/switch card cancelled (message deleted)')),
      '★★★ 走的是「消息已删除」那条出口（旧夹具恒 false ⇒ 只能观测到 patched to cancelled state）')
    ok(agent.sent.length === sentMark100, '★ 取消不起回合（不往会话里写任何东西）')

    // ---- ② 被拒出口：飞书不删（权限/已撤回）⇒ 降级把这张卡改成「已取消」 ---------
    failDeletes = 1
    const markWs100b = sentCards.length
    feedOn100(owner100, 'om_switch100_ws2', '/switch')
    await settle(4)
    const wsCard100b = lastCardFrom(markWs100b)
    const cancelBtn100b = wsCard100b ? allButtons(wsCard100b).find((b) => b.value && b.value.fs_level === 'cancel') : undefined
    ok(!!wsCard100b && !!cancelBtn100b && wsCard100b.app === APP2_100,
      '（前提）第二次 /switch 照常出在第二个 bot 上（降级分支的靶心）｜app='
        + (wsCard100b && wsCard100b.app))
    if (cancelBtn100b && wsCard100b) {
      const logMark100b = consoleLines.length
      const delMark100b = messageDeletes.length
      await tapOn100(owner100, cancelBtn100b.value)
      await settle(3)
      ok(messageDeletes.slice(delMark100b).length === 1, '（前提）这一支确实也试过 DELETE（只是被拒）')
      const patch100b = cardsSince(markWs100b).find((c) => c.op === 'update' && c.msgId === wsCard100b.msgId)
      ok(!!patch100b && JSON.stringify(patch100b.payload).includes('已取消')
        && patch100b.app === APP2_100,
        '★★★ 删不掉 ⇒ 就地 PATCH 成「已取消」，不留一张还能点的旧卡（PATCH 也走在**主人**'
          + '那个 app 上｜实得 ' + (patch100b && patch100b.app) + '）')
      ok(consoleLines.slice(logMark100b).some((l) => l.includes('cancelled (patched to cancelled state)')),
        '★★ 降级出口有留痕（可日志复验，不靠读代码）')
    }
    failDeletes = 0
  }

  // ---- ③ 演示/候选卡那条独立通道（fs_demo_cancel）------------------------------
  // 🔴 同样从**第二个 bot** 的通道点进来：这条分支删的是事件里 `open_message_id` 直传的那条
  //   消息（不查 pendingSwitchCards ⇒ 没有 `record.bot` 可用），身份判据只能来自连接自带的 bot
  //   —— 第十八轮同类排查发现这里也写着 `findBotForChat(chatId)`（同 `fs_switch` 那条同源缺陷），
  //   改成 `evtBot` 后必须有这条断言，否则又是"改了就算好"。
  const delMark100c = messageDeletes.length
  await tapOn100(owner100, { fs_demo_cancel: true }, 'om_demo_card_100')
  await settle(3)
  const dels100c = messageDeletes.slice(delMark100c)
  ok(dels100c.length === 1 && dels100c[0].msgId === 'om_demo_card_100',
    '★★ 演示卡的「✕ 取消」删的是**事件里那张**（open_message_id 直传，不查 pendingSwitchCards）'
      + '｜实得 ' + dels100c.map((d) => d.msgId).join(','))
  ok(dels100c.length === 1 && dels100c[0].app === APP2_100,
    '★★★ 演示卡那条出口也用**收到事件的连接 bot**（不是按会话猜 ⇒ 恒取配置第一个）'
      + '｜实得 ' + dels100c.map((d) => d.app).join(','))
  persistedSessions = []
  liveAgents.length = 0
  // 收尾：回到单 bot 配置 + 清掉次 bot 通道（用例 78/81 同口径），后面的用例不受本次换代影响
  writeFileSync(CFG100, JSON.stringify({
    bots: [{
      name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
      reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true,
    }],
  }, null, 2))
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod100b = await import('../index.js')
  mod100b.apply(ctx)
  await settle(2)
  extraProcs.clear()
}

console.log('101) ★🔴 命令锚点要认**三种**文本形态：占位符 / `@名字` / 裸名字紧跟命令（第十五轮门槛 MEDIUM#3）')
{
  // 上一轮只钉住了「占位符形态」（用例 97）。但锚点喂的是 `extractText()` 的**输出**，
  // 而它在两种已在生产的形态下根本不是占位符：
  //   ① 手机端纯文本：content 自带 `mentions:[{key,denote_text}]` ⇒ 占位符**先被换成 denote_text**
  //      （飞书给的名字可以不带 @）⇒ `t.startsWith(m.key)` 永不命中；
  //   ② PC 端 post 富文本：`at` 元素**没有 key 字段** ⇒ 还原成 `@名字`。
  // ⇒ 旧实现下这两种形态的群里 `@bot /命令` 仍然当普通消息处理（整串进会话）。
  // 反面还要钉住「第三档不许误剥」：裸名字后面**不紧跟命令**时不能当成命令
  // （否则 `张三 说的 /help 那条` 会被读成命令）。
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod101 = await import('../index.js')
  mod101.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  armTurn85('101')
  const GROUP101 = 'oc_smoke_group_101'
  // 直接给**原始事件形状**（feedGroup85 只会造 `{text}` + 根级 mentions，覆盖不到下面两种形态）。
  const feedGroupRaw101 = (msgId, msgType, contentObj, mentions) => {
    fakeProc.output += JSON.stringify({
      type: 'event', eventType: 'im.message.receive_v1',
      data: {
        message: {
          message_id: msgId, message_type: msgType, chat_type: 'group', chat_id: GROUP101,
          content: JSON.stringify(contentObj), ...(mentions ? { mentions } : {}),
        },
        sender: { sender_id: { open_id: 'ou_human_85', union_id: 'on_cm' }, sender_type: 'human' },
      },
    }) + '\n'
  }
  const HELP_MARK = '/compact 压缩上下文'
  const plainCreates = (mark) => cardsSince(mark)
    .filter((c) => c.op === 'create' && c.payload && !c.payload.schema)
    .filter((c) => JSON.stringify(c.payload).includes(HELP_MARK))

  // ① denote_text 形态（手机端）：占位符已被换成**不带 @** 的名字
  {
    const mark = sentCards.length
    const sent = agent.sent.length
    feedGroupRaw101('om_group101_mobile', 'text',
      { text: '@_user_1 /help', mentions: [{ key: '@_user_1', denote_text: SMOKE_BOT_NAME }] },
      [MENTION_SELF85])
    await settle(4)
    ok(agent.sent.length === sent,
      '★★★ denote_text 形态的 `名字 /help` 判成了命令（没生效时整串当普通消息进会话 ⇒ sent +1）')
    ok(plainCreates(mark).length === 1, '★★★ 帮助文本真的发出去了（恰好一条）｜实得 ' + plainCreates(mark).length)
  }
  // ② post 富文本形态（PC 端）：at 元素没有 key ⇒ extractText 还原成 `@名字`
  {
    const mark = sentCards.length
    const sent = agent.sent.length
    feedGroupRaw101('om_group101_post', 'post',
      { title: '', content: [[{ tag: 'at', user_id: SMOKE_BOT_OPEN_ID, name: SMOKE_BOT_NAME },
        { tag: 'text', text: ' /help' }]] },
      [MENTION_SELF85])
    await settle(4)
    ok(agent.sent.length === sent,
      '★★★ post 形态的 `@名字 /help` 判成了命令（旧实现两档都不命中：既没占位符也没裸名字）')
    ok(plainCreates(mark).length === 1, '★★★ post 形态同样只发一条帮助｜实得 ' + plainCreates(mark).length)
  }
  // ③ 反面：裸名字后面不紧跟命令 ⇒ 不许剥、不许当成命令
  {
    const mark = sentCards.length
    const sent = agent.sent.length
    feedGroupRaw101('om_group101_falsecmd', 'text',
      { text: '@_user_1 说的 /help 那条别跑-101L3', mentions: [{ key: '@_user_1', denote_text: SMOKE_BOT_NAME }] },
      [MENTION_SELF85])
    await settle(4)
    ok(agent.sent.length === sent + 1 && lastSentText().includes('说的 /help 那条别跑-101L3'),
      '★★★ 名字后面不紧跟命令 ⇒ 仍是普通消息（第三档的 `^\\s*\\/` 守卫在起作用，不把正文读成命令）')
    ok(plainCreates(mark).length === 0, '★★ 这一条没有发出帮助卡（命令没被误判）')
    ok(!lastSentText().includes('@_user_1'), '★ 占位符仍然不漏进会话（还原通道没被锚点改动带坏）')
  }
  liveAgents.length = 0
}

console.log('102) ★🔴 认不出的斜杠文本**不许静默吞**：命令分支只对 `resolveCommandName` 认得出的名字开放（第十六轮门槛 MEDIUM）')
{
  // 真机事件入口旧写法：`splitCommand` 只要首字符是 `/` 就进命令分支，而分支尾部**无条件
  //   `return`**；`handleCommand` 第一行又是 `if (!resolved) return false`（什么都不做）
  //   ⇒ 群里 `@bot /help2`（命令打错一个字）这类文本**既没有卡、也没有回合、连回执都没有**，
  //   用户视角＝"它装没看见"。内部入口 `handleInbound` 早就有正确口径（`handled` 为假就落回
  //   普通消息），两个入口口径不一致正是这类静默丢失的温床。
  //   本用例钉住修好后的三条：①认不出的照常进会话；②第三档剥出来的认错名（`名字/李四 …`）
  //   同样不吞；③认得出的**仍然**走命令分支（判据写反时这条变红）。
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
             reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true }],
  }, null, 2))
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod102 = await import('../index.js')
  mod102.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  armTurn85('102')
  const GROUP102 = 'oc_smoke_group_102'
  const feedGroupRaw102 = (msgId, contentObj, mentions) => {
    fakeProc.output += JSON.stringify({
      type: 'event', eventType: 'im.message.receive_v1',
      data: {
        message: {
          message_id: msgId, message_type: 'text', chat_type: 'group', chat_id: GROUP102,
          content: JSON.stringify(contentObj), ...(mentions ? { mentions } : {}),
        },
        sender: { sender_id: { open_id: 'ou_human_85', union_id: 'on_cm' }, sender_type: 'human' },
      },
    }) + '\n'
  }
  const HELP_MARK102 = '/compact 压缩上下文'
  const helpCards = (mark) => cardsSince(mark)
    .filter((c) => c.op === 'create' && c.payload && !c.payload.schema)
    .filter((c) => JSON.stringify(c.payload).includes(HELP_MARK102))

  // ① 打错一个字的命令 ⇒ 普通消息通道（旧写法在这里 `return`，什么都没发生）
  {
    const mark = sentCards.length
    const sent = agent.sent.length
    feedGroupRaw102('om_group102_typo',
      { text: '@_user_1 /help2-102A' }, [MENTION_SELF85])
    await settle(4)
    ok(agent.sent.length === sent + 1 && lastSentText().includes('/help2-102A'),
      '★★★ 认不出的 `/help2` 落回普通消息（sent ' + agent.sent.length + '，基线 ' + sent + '）——旧写法静默吞掉')
    ok(helpCards(mark).length === 0, '★★ 认不出的命令没有错发帮助卡')
  }
  // ② 第三档剥出的认错名（手机端 `名字/李四 今天值班`）⇒ 同样不许吞
  {
    const mark = sentCards.length
    const sent = agent.sent.length
    feedGroupRaw102('om_group102_name_slash',
      { text: '@_user_1/李四 今天值班-102B', mentions: [{ key: '@_user_1', denote_text: SMOKE_BOT_NAME }] },
      [MENTION_SELF85])
    await settle(4)
    ok(agent.sent.length === sent + 1 && lastSentText().includes('今天值班-102B'),
      '★★★ 名字紧跟斜杠剥出 `/李四 …` 也不当命令（旧写法：锚点第三档命中 ⇒ 整条被吞）')
    ok(helpCards(mark).length === 0, '★★ 这一条没有发出帮助卡')
  }
  // ③ 反面：认得出的命令**仍然**走命令分支，不许因为加了守卫而落进会话
  {
    const mark = sentCards.length
    const sent = agent.sent.length
    feedGroupRaw102('om_group102_known', { text: '@_user_1 /help' }, [MENTION_SELF85])
    await settle(4)
    ok(agent.sent.length === sent,
      '★★★ 已知命令 `/help` 没有落进会话（判据写反成 `!resolveCommandName` 时这条变红）')
    ok(helpCards(mark).length === 1, '★★★ 已知命令照常执行（恰好一条帮助）｜实得 ' + helpCards(mark).length)
  }
  liveAgents.length = 0
}

console.log('103) ★🔴 命令锚点遇到「名字互为前缀」时要取**最长**匹配（第十七轮门槛 LOW#4）')
{
  // 旧实现按 mentionList 顺序**先命中先切**。当排在前面的名字是排在后面的名字的前缀
  // （`smoke-bot` / `smoke-bot2`、`张三` / `张三丰`）时，正文 `@smoke-bot2 @smoke-bot /help`
  // 会在第一个 token 上只切掉 10 个字符 ⇒ 剩下 `2 @smoke-bot /help` ⇒ 后面谁也匹配不上
  // ⇒ 命令判成普通消息（用户视角：说了 `/help` 没执行，只是 agent 多回一句）。
  // ⚠️ 这个形状能不能在真机出现，取决于飞书给 `mentions` 数组排序是否严格跟随正文顺序 ——
  //   这一点**无法从接口文档证实**，所以不拿它当依据；锚点按"同一位置取最长"实现，
  //   不依赖任何排序假设（对不冲突的输入结果与旧写法逐字相同）。
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
             reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true }],
  }, null, 2))
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod103 = await import('../index.js')
  mod103.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  armTurn85('103')
  const MENTION_SB103 = {
    key: '@_user_2', id: { open_id: 'ou_smoke_bot_2', union_id: 'on_bot_sb2', user_id: '' },
    name: SMOKE_BOT_NAME + '2', mentioned_type: 'bot',
  }
  fakeProc.output += JSON.stringify({
    type: 'event', eventType: 'im.message.receive_v1',
    data: {
      message: {
        message_id: 'om_group103_prefix', message_type: 'post', chat_type: 'group',
        chat_id: 'oc_smoke_group_103',
        content: JSON.stringify({ title: '', content: [[
          { tag: 'at', user_id: 'ou_smoke_bot_2', name: SMOKE_BOT_NAME + '2' },
          { tag: 'at', user_id: SMOKE_BOT_OPEN_ID, name: SMOKE_BOT_NAME },
          { tag: 'text', text: ' /help' },
        ]] }),
        // 刻意把**较短**的那个名字排在前面（= 与正文顺序不一致），这才是能踩到旧写法的输入
        mentions: [MENTION_SELF85, MENTION_SB103],
      },
      sender: { sender_id: { open_id: 'ou_human_85', union_id: 'on_cm' }, sender_type: 'human' },
    },
  }) + '\n'
  {
    const mark = sentCards.length
    const sent = agent.sent.length
    await settle(4)
    ok(agent.sent.length === sent,
      '★★★ 前缀名字没有把命令切碎（旧写法切 10 个字符 ⇒ 剩 `2 @… /help` ⇒ 判不成命令、整条落进会话）')
    ok(cardsSince(mark)
      .filter((c) => c.op === 'create' && c.payload && !c.payload.schema)
      .filter((c) => JSON.stringify(c.payload).includes('/compact 压缩上下文')).length === 1,
      '★★★ 最长匹配生效：`/help` 照常执行（恰好一条帮助）')
  }
  liveAgents.length = 0
}

console.log('104) ★🔴 /model 文字档：bare 模型名不许静默重发卡、卡面语法不许被飞书吞掉、失败必须留日志并说中文（中台 #47，2026-10-06 生产取证）')
{
  // 取证出处（生产 dsh-feishu-aiad.service／0.8.2／analyst 会话 fs-main-muvrahja，2026-10-06 13:50-13:54）：
  //   B 卡面提示写 `/model <provider>/<model>` ⇒ 飞书把尖括号当 HTML 标签**整段吞掉**，
  //     实得消息 om_x100b637c8462c0a4c12356ad128bbe4 渲染成「/model /」＝语法看不见。
  //   C 于是用户按猜的写法发不带 provider 的 `/model deepseek-v4-pro`（实得消息
  //     om_x100b637ce2a0b0acc4ccb7f2e2324b5）⇒ 旧正则不匹配 ⇒ **静默重发一张选择卡、一句解释都没有**；
  //     同一条 catch 分支还**不打日志**（那两条失败在 journal 里 0 行，只能翻聊天才拿到报错原文）。
  //   A 切到宿主清单外的名字时抛英文原文 `Select an available model before sending a message.`
  //     （实得消息 om_x100b637c8762b0a0c4c4df07432b66b），桥原样拼进「切换失败：」转给用户。
  // 三条拼起来就是 CM 说的「切换从来没成功过／点了没反应」；0.8.2 的 selectModel 本身是好的
  //   （实测切 deepseek-official/deepseek-v4-pro ⇒ 日志 selectModel ok、随后 current 跟着变）。
  const md104 = (c) => {
    const els = c && c.payload && Array.isArray(c.payload.elements) ? c.payload.elements : []
    return els.length && els[0] && els[0].tag === 'markdown' ? String(els[0].content) : null
  }
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod104 = await import('../index.js')
  mod104.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  armTurn85('104-pre')
  feedInbound('om_bind104', '先绑定单聊-104')
  await settle(4)

  const twoRoutes = {
    listProviders: () => [{ id: 'test', name: 'T 官方' }, { id: 'mirror', name: 'M 镜像' }],
    listModels: async (pid) => [{ id: 'm-' + pid, name: 'Model ' + pid }],
  }
  llmOverride = twoRoutes
  const mk104 = sentCards.length
  feedInbound('om_104p', '/model')
  await drain()
  const picker104 = cardsSince(mk104).filter((c) => c.op === 'create' && allButtons(c).length > 0).pop()
  ok(!!picker104, '（前提）/model 出了一张带按钮的选择卡（否则下面全是恒真）')
  const pj104 = JSON.stringify((picker104 && picker104.payload) || {})
  ok(pj104.indexOf('<provider>') === -1 && pj104.indexOf('<model>') === -1,
    '★★★ 卡面上不再出现尖括号占位符（飞书把 `<...>` 当标签吞掉 ⇒ 实得只剩「/model /」）'
    + '｜实得 ' + JSON.stringify(pj104.includes('<provider>') || pj104.includes('<model>')))
  ok(pj104.indexOf('/model test/m-test') >= 0,
    '★★★ 语法提示给的是清单里真实存在的一条路径（看得见语法才知道怎么发）')

  // ---- C：bare 模型名按清单补全，唯一命中直接切 -------------------------------
  selectModelCalls = []
  sessionAppendCalls.length = 0
  const mk104a = sentCards.length
  feedInbound('om_104a', '/model m-mirror')
  await settle(2)
  ok(selectModelCalls.length === 1 && selectModelCalls[0].provider === 'mirror'
    && selectModelCalls[0].model === 'm-mirror',
    '★★★ 不带 provider 的模型名：唯一命中 ⇒ 补全 provider 后真的调了宿主 selectModel'
    + '（旧写法正则不匹配＝0 次调用、只重发一张卡）｜实得 ' + JSON.stringify(selectModelCalls))
  ok(sessionAppendCalls.length === 0, '★★ 没有退回只写事件的 append 兜底')
  const win104a = cardsSince(mk104a)
  const txt104a = win104a.map(md104).filter(Boolean).join(' | ')
  ok(txt104a.indexOf('模型已切换为 `mirror/m-mirror`') >= 0,
    '★★★ 回执写清切到了哪条路由｜实得 ' + JSON.stringify(txt104a))
  ok(win104a.filter((c) => c.op === 'create' && allButtons(c).length > 0).length === 0,
    '★★★ 认得出的名字不再「静默重发一张选择卡」（用户视角的「发了没反应」正是这条）')

  // ---- C：同名挂多条路由 ⇒ 不许猜，把候选念回去 -------------------------------
  llmOverride = {
    listProviders: () => [{ id: 'test', name: 'T 官方' }, { id: 'mirror', name: 'M 镜像' }],
    listModels: async () => [{ id: 'dup', name: 'Dup' }],
  }
  selectModelCalls = []
  const mk104b = sentCards.length
  feedInbound('om_104b', '/model dup')
  await settle(2)
  const txt104b = cardsSince(mk104b).map(md104).filter(Boolean).join(' | ')
  ok(selectModelCalls.length === 0,
    '★★★ 同名挂两条路由时**不猜**（猜错＝切到用户没点的那条）｜实得 ' + selectModelCalls.length)
  ok(txt104b.indexOf('test/dup') >= 0 && txt104b.indexOf('mirror/dup') >= 0,
    '★★★ 把两条候选路径原样念回去，让用户自己带 provider｜实得 ' + JSON.stringify(txt104b))

  // ---- C：清单里没这个名字 ⇒ 明说没有（旧：静默重发卡） ----------------------
  const mk104c = sentCards.length
  feedInbound('om_104c', '/model not-a-model')
  await settle(2)
  const txt104c = cardsSince(mk104c).map(md104).filter(Boolean).join(' | ')
  ok(txt104c.indexOf('没找到模型') >= 0,
    '★★★ 认不出的名字给出中文说明（旧写法这句话都不说）｜实得 ' + JSON.stringify(txt104c))
  ok(cardsSince(mk104c).filter((c) => c.op === 'create' && allButtons(c).length > 0).length === 0,
    '★★ 认不出的名字不再重发一张同样的选择卡')

  // ---- A：宿主英文报错 → 中文一句＋下一步动作，且必须留日志 ------------------
  llmOverride = twoRoutes
  selectModelImpl = () => { throw new Error('Select an available model before sending a message.') }
  const log104 = consoleLines.length
  const mk104d = sentCards.length
  feedInbound('om_104d', '/model test/m-test')
  await settle(2)
  selectModelImpl = null
  const txt104d = cardsSince(mk104d).map(md104).filter(Boolean).join(' | ')
  ok(txt104d.indexOf('宿主不认') >= 0,
    '★★★ 宿主的「模型不可用」翻译成中文并给下一步（原文是英文，用户看不懂也不知道怎么办）'
    + '｜实得 ' + JSON.stringify(txt104d))
  ok(txt104d.indexOf('available model') === -1, '★★ 不把宿主英文原文转给用户')
  ok(consoleLines.slice(log104).some((l) => l.indexOf('/model 切换失败(文字档)') >= 0),
    '★★★ 文字档失败**必须留日志**（旧写法只发文本、journal 里 0 行 ⇒ 服务器侧无法取证）')
  // 🔴 这条**原来是个弱断言**：只要求"任意一行日志里含宿主原文"。反证跑在 0.8.2 冻结字节上时
  //   它照样是绿的 ⇒ 因为出站消息正文本身也会被打进日志，旧字节的失败路径一行失败日志都没有
  //   也能满足。收紧成「原文必须落在那条失败日志的**同一行**」——0.8.2 字节上这条必红（实测已验）。
  ok(consoleLines.slice(log104).some((l) => l.indexOf('/model 切换失败(文字档)') >= 0
    && l.indexOf('Select an available model') >= 0),
    '★★ 宿主原文落在那条失败日志的同一行（翻译只面向用户，取证不能被翻译污染）')

  // ---- A：认不出的错误不许编造原因 -------------------------------------------
  selectModelImpl = () => { throw new Error('session/model-unavailable: 没有这条路由') }
  const mk104e = sentCards.length
  feedInbound('om_104e', '/model mirror/m-mirror')
  await settle(2)
  selectModelImpl = null
  const txt104e = cardsSince(mk104e).map(md104).filter(Boolean).join(' | ')
  ok(txt104e.indexOf('session/model-unavailable') >= 0,
    '★★ 映射只认确知含义的那一条，其余原文照抄（A24 禁编造解释）｜实得 ' + JSON.stringify(txt104e))

  // ---- 回声消毒：出站正文里的 `@all` 必须展不开（第二十一轮门槛 MEDIUM#1） --------
  // 为什么单独钉：这两条 error 文案走 sendPlainText ⇒ 出站前过 expandAtTokens，而 `@all`
  //   的展开**不需要通讯录命中**（直接返回 <at id=all>所有人</at>）⇒ 群成员发一句
  //   `/model `@all` 就能借桥广播全群、且收不回。
  // 🔴 触发形状必须是**单个**前导反引号：我们的模板是「…模型名 `+arg+`…」，arg 自带一个 `` ` ``
  //   时，`INLINE_CODE_RE = /(`+)[^\n]*?\1/` 会把开头那串两个反引号**回退成一个**、代码串在 arg
  //   的第一个字符就闭合 ⇒ 剩下的 `@all` 落在代码区**外面**被展开。
  //   ⚠️ 若 arg 写成 `` `@all`zz ``（两端都带反引号）则两个反引号能自己配成对、`@all` 反而被保护
  //   ⇒ 那种夹具在旧字节上也是绿的（＝假钉，见本仓「断言要在旧字节上必红」的口径）。
  {
    const log104f = consoleLines.length
    const mk104f = sentCards.length
    feedInbound('om_104f', '/model `@all')
    await settle(2)
    const win104f = cardsSince(mk104f)
    const txt104f = win104f.map(md104).filter(Boolean).join(' | ')
    ok(txt104f.length > 0, '（前提）零命中这条给了回执文本（否则下面全是恒真）｜实得长度 ' + txt104f.length)
    ok(txt104f.indexOf('<at') === -1 && txt104f.indexOf('所有人') === -1,
      '★★★ 用户输入的 `@all` 没有被展开成真·@ 全体（唤醒全群、收不回）'
      + '｜实得 ' + JSON.stringify(txt104f))
    ok(txt104f.indexOf('@') === -1,
      '★★ 出站正文不回显 `@` 字符（消毒后不可能再被任何 @ 语法命中）｜实得 ' + JSON.stringify(txt104f))
    ok(txt104f.indexOf('all') >= 0,
      '★★ 消毒只剥元字符、不吞掉整个名字（用户仍认得出自己发的是什么）｜实得 ' + JSON.stringify(txt104f))
    // L1：两种失败共用一条日志支路 ⇒ 标签必须能同时成立，且 arg 在日志里留**原文**（取证不被消毒污染）
    ok(consoleLines.slice(log104f).some((l) => l.indexOf('/model 文字档无法解析') >= 0
      && l.indexOf('`@all') >= 0),
      '★★ 解析失败留日志，且日志里是**消毒前**的原文（面向取证，不是面向用户）')
  }

  // ---- 清单为空：不许断言"清单里没有"，也不许给占位符当示例（门槛 LOW#3＋MEDIUM#2） --
  {
    llmOverride = {
      listProviders: () => [{ id: 'test', name: 'T 官方' }],
      listModels: async () => { throw new Error('catalog down') },
    }
    const mk104g = sentCards.length
    feedInbound('om_104g0', '/model')
    await settle(2)
    const txt104g0 = cardsSince(mk104g).map(md104).filter(Boolean).join(' | ')
    ok(txt104g0.indexOf('<provider>') === -1 && txt104g0.indexOf('<model>') === -1,
      '★★★ 空清单的补充说明里也没有尖括号（同一个"被飞书吞掉"的判据不能只落一处）'
      + '｜实得 ' + JSON.stringify(txt104g0))
    const mk104g1 = sentCards.length
    feedInbound('om_104g1', '/model some-name')
    await settle(2)
    const txt104g1 = cardsSince(mk104g1).map(md104).filter(Boolean).join(' | ')
    ok(txt104g1.indexOf('拿不到模型清单') >= 0,
      '★★★ 清单读不出时明说"拿不到清单"，不假装查过｜实得 ' + JSON.stringify(txt104g1))
    ok(txt104g1.indexOf('没有这个名字') === -1,
      '★★ 不据空清单断言"宿主清单里没有这个名字"（那是无出处断言，A24）｜实得 ' + JSON.stringify(txt104g1))
  }
}
// ---- 105：卡片必须声明 update_multi（CM 三台机器都遇到「点完显示已切换、过一会儿卡面自己变回选择界面」）----
// 🔴 第三十轮门槛 LOW#8 ⇒ 第三十一轮门槛 LOW#3（核对为真）：105/106 原先**嵌在 104 的块作用域里**，
//    anyone 给 104 加提前 return 就会让它们静默不跑（整批断言消失而不是变红）。已核实 105/106
//   对 104 顶层局部量（md104/twoRoutes/picker104/…）**零引用** ⇒ 104 块在此收口，两格提为顶层块，
//   执行顺序一字未动。
console.log('105) ★🔴 互动卡必须声明 update_multi（源码字面量闸 + 运行期选择卡/写回闸）')
// 🔴 第四十七轮 LOW#1（核对为真）：花括号原来缩进两格、和列 0 的头行错位，仍暗示一个不存在的
//   嵌套层。这里只把**配对的两枚花括号**提回列 0（与 104/107+ 同款），块体保持四格缩进——
//   逐行重排整个百行块在冻结窗口只制造 diff 噪音，且改不动任何行为。
{
    // 105a 源码级守护：全库任何一张卡的 config 都必须带 update_multi —— 漏掉＝飞书按「非共享卡片」渲染，
    //   更新只对触发端可见，其他端（或同端稍后重绘）拿到的仍是旧卡面。这条判据不靠运行时，防以后新增卡片再漏。
    const idx105 = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    // 🔴 第二十二轮门槛 MEDIUM#2（核对为真）：旧写法逐行扫 ⇒ 只认单行 `config:` 字面量，
    //   多行写法被静默跳过＝假绿灯。改为把全文换行归一后整体扫（命中报内容而非行号）。
    // 🔴 同轮 LOW#10：判据要钉**值** `update_multi: true`，不是键名 —— `update_multi: false`
    //   同样正是本守卫要防的"非共享卡片"回归。
    // 🔴 第二十三轮门槛 MEDIUM#2 ⇒ 第三十二轮门槛 LOW#4（核对为真，口径统一升级）：旧正则只认
    //   **一层**嵌套 ⇒ 两层（如 `config: { i18n: { … }, update_multi: true }`）进不了字面量闸，
    //   却被下面的零容忍交叉核对点名为"隐形站点"＝报错指向错误（假称变量传值，实为深嵌套）。
    //   改为**花括号配对**扫任意深度：每个 `config:{` 站点找到配对闭括号、在配对区间内判
    //   update_multi=true；交叉核对只处理 `config:` 后**不接** `{` 的站点（变量传值）。两闸同一口径。
    const flat105 = idx105.replace(/\s+/g, ' ')
    const miss105 = []
    const litHits105 = new Set()
    {
      // 🔴 第三十三轮门槛 LOW#4（核对为真）：两处扫描都加**词界** `\b`——旧写法是不锚定子串，
      //   `subconfig:` 这类标识符尾串会撞进交叉核对，红得与卡片 config 无关（无关重构联动假红，
      //   与 LOW#5 解耦启动日志是同一族问题）。
      // 🔴 第三十三轮门槛 LOW#3（核对为真，边界如实声明）：配对按**裸字符**数括号，不识别
      //   字符串/注释词法上下文 ⇒ 字面值里出现裸 `{`/`}` 会让区间边界错位：偏保守的走 miss105
      //   假红（可接受，指到具体 seg 一眼能判），偏危险的（区间吞进 update_multi）由
      //   **用例 112 出口层总闸**兜底——完整词法解析留给 112，源码层只做粗筛。
      const re105 = /\bconfig:\s*\{/g
      let m105
      while ((m105 = re105.exec(flat105)) !== null) {
        litHits105.add(m105.index)
        let depth = 0
        let i = flat105.indexOf('{', m105.index)
        for (; i < flat105.length; i += 1) {
          const ch = flat105[i]
          if (ch === '{') depth += 1
          else if (ch === '}') { depth -= 1; if (depth === 0) break }
        }
        const seg = flat105.slice(m105.index, i + 1)
        if (!/update_multi\s*:\s*true\b/.test(seg)) miss105.push(seg.slice(0, 140))
      }
    }
    ok(miss105.length === 0,
      '★★★ 每一处**字面量**卡片 config 都声明了 update_multi=true（不设＝更新内容仅触发端可见＝CM 报的"回退"）'
      // 🔴 第二十九轮门槛 MEDIUM#3（核对为真）：本闸只管**字面量站点**——整份缺 config 的卡
      //   对它隐形（没有 config 冒号这个词可扫）、注释/字符串里的字面量会干扰它。
      // 🔴 第三十八轮门槛 LOW#2（核对为真，**口径更正**）：花括号配对按裸字符计数、不识别
      //   字符串/注释词法——方向**不是单侧保守**：字符串里落单的 `{` 既可能让它**假红**，
      //   也可能把配对区间**撑进隔壁 config 块**借到对面的 update_multi=true 而**假绿**；
      //   再加"从没被任何用例发出的卡"112 出口闸也看不见＝残余盲区。
      //   改造成迷你词法扫描器判**不修**：正则剥字符串/注释自己就会踩 URL 里的 `//`
      //   （本文件里就有），造一个假灯敌比留一个可描述、可人工复核的边界更糟。
      //   纪律＝新增卡片时人必须过这条闸的判据（本批 35+ 轮均如此），残余风险如实挂账。
      + '｜分工：本闸=源码字面量层（花括号配对，任意嵌套深度，词法盲区见上注），运行期每张已发卡由用例 112 兜'
      + '｜漏掉的 config ' + JSON.stringify(miss105))
    // 🔴 第二十四轮门槛 MEDIUM#1（核对为真）：本闸只认「config: 紧跟字面量对象」，
    //   `config: cardCfg` 这类变量传值对它是隐形的 ⇒ 断言文案不能只靠字面量扫描兜住。
    //   补一条**覆盖交叉核对**：遍历全文**所有** `config:` 站点，凡是被字面量闸**没吃掉的**
    //   （即后面不接 `{` 的）一律点名变红。
    // 🔴 第三十轮门槛 LOW#5（核对为真）：原白名单唯一一条锚定 index.js 启动日志的**字面文本**
    //   （改名/拆行就联动假红）⇒ 那行日志字段已改为 cfg_path，白名单清空，
    //   交叉核对升级为"非字面量站点零容忍"。新站点若确属非卡用途：改写得不含该词，
    //   或做成卡片字面量形态进字面量闸。
    // 🔴 第三十一轮门槛 LOW#4（核对为真）：白名单数组清空后 `.some` 恒假，是死条件——直接
    //   删掉，非字面量站点**无条件**进 loose105（零容忍形状写进代码，不靠读者脑内推断）。
    const loose105 = []
    for (const mm of flat105.matchAll(/\bconfig:/g)) {
      if (litHits105.has(mm.index)) continue
      loose105.push(flat105.slice(mm.index, mm.index + 60))
    }
    ok(loose105.length === 0,
      '★★ 105a 覆盖交叉核对：没有"守卫看不见"的新 `config:` 站点（变量传 config 会被字面量闸漏掉）'
      + '｜发现 ' + JSON.stringify(loose105))

    // 105b 运行时：选择卡**发出时**就得带（不是只在结果卡上补），点击写回的那份也要带
    llmOverride = {
      listProviders: () => [{ id: 'test', name: 'T 官方' }],
      listModels: async () => [{ id: 'm-test', name: 'M Test' }],
    }
    const log105 = consoleLines.length
    const mk105 = sentCards.length
    feedInbound('om_105', '/model')
    await settle(2)
    // 🔴 第二十二轮门槛 LOW#11（核对为真）：旧判据"有 elements 数组"会把 sendPlainText 类
    //   卡也认成 picker（那种卡恒带 update_multi=true ⇒ 断言变恒真）。改按 fs_model 按钮锁定，
    //   与对照组的定位方式一致。
    const picker105 = cardsSince(mk105).find((c) => c.op === 'create'
      && allButtons(c).some((b) => b.value && b.value.fs_model))
    ok(!!picker105, '（前提）/model 出了选择卡（否则下面全是恒真）｜本窗口卡数 ' + cardsSince(mk105).length)
    ok(picker105 && picker105.payload.config && picker105.payload.config.update_multi === true,
      '★★★ 选择卡发出时的 config 里就有 update_multi=true（回退的根因在这张卡，不在结果卡）'
      + '｜实得 ' + JSON.stringify((picker105 && picker105.payload.config) || null))

    const mk105p = sentCards.length
    // 🔴 第三十三轮门槛 LOW#7（核对为真）：picker 缺位（上一条前提已红）时**不再注入点击**——
    //   无 msgId 的 /model 点击不是空操作：按用例 99 的考证它会真的切会话模型并广播「已切换为」，
    //   污染全局状态又在红格上添误导痕迹（同 32 轮 LOW#3 对 107/109 的规矩）。
    if (picker105 && picker105.msgId) {
      await tapValue({ fs_model: 'test|m-test' }, undefined, CHAT_ID, picker105.msgId)
    }
    await settle(2)
    const win105p = cardsSince(mk105p)
    // 🔴 第三十八轮门槛 LOW#6（核对为真）：picker 存在但没带 msgId 时，原来的 find 会
    //   退化成 `c.msgId === undefined`——任何**别家的**残留 update 记录都能冒充"PATCH 真发了"
    //   ＝前提假绿。与 106/111 兄弟格同规矩：先钉 msgId 存在再找。
    const patch105 = (picker105 && picker105.msgId)
      ? win105p.find((c) => c.op === 'update' && c.msgId === picker105.msgId)
      : undefined
    ok(!!patch105, '（前提）点击后真的对**被点的那张卡**发了 PATCH（否则判"留痕"是恒真）｜本窗口 '
      + win105p.length)
    ok(patch105 && patch105.payload.config && patch105.payload.config.update_multi === true,
      '★★★ 写回的载荷同样带 update_multi=true｜实得 '
      + JSON.stringify((patch105 && patch105.payload.config) || null))
    // B3（本轮自曝的缺陷）：旧实现只在**失败**时打日志 ⇒「到底改没改成」只能靠反证＋调飞书 GET 才钉得死
    ok(consoleLines.slice(log105).some((l) => l.indexOf('/model card patched') >= 0),
      '★★ 改卡**成功**也留一行日志（失败不留痕是 0.8.3 缺陷 A 的同一形状，成功不留痕则连"是谁写回去的"都查不到）')
}
  // ---- 106：私聊边界 —— 需要真人点的动作（切模型/目标模式/审批单）不在群聊受理 ----------------
  // CM 2026-10-06：「卡片只在私聊去做审核、切换模型这些动作」＋「审批单只能私聊，不能发群。
  //   这就直接解决了身份的问题了，就不用那么复杂了」⇒ 群里的卡谁翻到都能点＝把审批权发给全群。
  // 🔴 第三十轮门槛 LOW#8：补 106 头（编号归位）；第三十一轮 LOW#3：已提为顶层块（见 105 头注）。
// 🔴 第四十轮门槛 LOW#4（核对为真，做最小改动）：106 头行原来缩进两格、暗示一个已不存在
//   的嵌套层。大括号配对整体重排要动 105/106 两个百行块的每一行，冻结前 diff 噪音远大于
//   收益——只把**用例头行**提回列 0（与 104/105/107+ 同款），层级误导的主源头消除。
console.log('106) ★🔴 私聊边界：/model、/goal、/plan 与审批单只在已确认私聊受理（群里拒发+留痕）')
// 🔴 第四十七轮 LOW#1（同上 105 注）：花括号配对提回列 0，块体缩进不动。
{
    // 先让这条会话在桥的记忆里是**群**（群判据只认入站事件带的 chat_type，不信 oc_ 前缀）
    feedGroup85(CHAT_ID, 'om_106_mark_group', '@_user_1 /help', [GROUP_MENTION[0]])
    await settle(2)
    // 🔴 第二十八轮门槛 LOW#4（核对为真）：下面"不发选择卡"的判别力原本白吃 105 遗留的
    //   llm 桩——哪天 105 补一句 `llmOverride = null` 收尾，桩没了，闸被删也建不出 picker，
    //   断言静默退化成恒真。本格自带桩，自含自足。
    llmOverride = {
      listProviders: () => [{ id: 'test', name: 'T 官方' }],
      listModels: async () => [{ id: 'm-test', name: 'M Test' }],
    }

    const log106 = consoleLines.length
    const mk106 = sentCards.length
    feedGroup85(CHAT_ID, 'om_106_model', '@_user_1 /model', [GROUP_MENTION[0]])
    await settle(3)
    const win106 = cardsSince(mk106)
    ok(win106.filter((c) => c.op === 'create' && allButtons(c).some((b) => b.value && b.value.fs_model)).length === 0,
      '★★★ 群里发 /model **不发选择卡**（发了＝群里任何人都能替会话主人切模型）'
      + '｜本窗口 create 数 ' + win106.filter((c) => c.op === 'create').length)
    const txt106 = win106.map((c) => JSON.stringify(c.payload)).join(' | ')
    ok(txt106.indexOf('私聊') >= 0, '★★ 群里这条给的是"请在私聊里进行"的可见回执｜实得 ' + txt106.slice(0, 120))
    ok(consoleLines.slice(log106).some((l) => l.indexOf('私聊边界拒绝: /model') >= 0),
      '★★ 边界拒绝留痕（不许静默吞掉，否则又是一条"点了没反应"）')

    const mk106g = sentCards.length
    feedGroup85(CHAT_ID, 'om_106_goal', '@_user_1 /goal 把群里能开目标这件事测一遍', [GROUP_MENTION[0]])
    await settle(3)
    const txt106g = cardsSince(mk106g).map((c) => JSON.stringify(c.payload)).join(' | ')
    ok(txt106g.indexOf('私聊') >= 0 && txt106g.indexOf('目标已') === -1,
      '★★★ 群里发 /goal 不建目标、只回"请在私聊里进行"（目标模式会连开多轮，落在群里＝替全群花钱）'
      + '｜实得 ' + txt106g.slice(0, 120))

    // 🔴 第三十六轮门槛 MEDIUM（核对为真）：/goal clear 原来混在刹车豁免清单里＝群里任何人
    //   @ 一下就能清空会话主人的目标。豁免只保留 pause/无参查状态（resume 于第四十轮 MEDIUM
    //   也已归闸——恢复续跑＝重新开车花钱，不是刹车）⇒ clear 必须
    //   和建目标一样被私聊边界拦下。旧字节没有这道边界、clear 还吃豁免 ⇒ 两条都必红。
    {
      const log106c = consoleLines.length
      const mk106c = sentCards.length
      feedGroup85(CHAT_ID, 'om_106_goal_clear', '@_user_1 /goal clear', [GROUP_MENTION[0]])
      await settle(3)
      ok(consoleLines.slice(log106c).some((l) => l.indexOf('私聊边界拒绝: /goal') >= 0),
        '★★★ 群里 /goal clear 被私聊边界拦下并留痕（旧字节 clear＝刹车豁免 ⇒ 本条必红）')
      const txt106c = cardsSince(mk106c).map((c) => JSON.stringify(c.payload)).join(' | ')
      ok(txt106c.indexOf('私聊') >= 0,
        '★★ 群里 /goal clear 同样只回"请在私聊里进行"的可见回执｜实得 ' + txt106c.slice(0, 120))
    }

    // 审批单：同一条会话（此刻已被记成群）里的审批请求必须**不发卡**并直接判拒
    // 🔴 夹具口径（用例 96 踩过的同一个坑）：emitCtx 把**同一个** next 发给每个监听器，
    //   查无此 agent 会话的老代次会原样转交 ⇒ 转交物是一个 **Promise**，拿字符串比身份比不掉，
    //   会把「转交」误判成「接管」。所以哨兵必须是那个 Promise 对象本身。
    const mk106a = sentCards.length
    const log106a = consoleLines.length
    const nextSentinel106 = Promise.resolve('next-106-delegated')
    const raw106a = emitCtx('approval/request',
      { agent, toolName: 'bash', reason: '群聊审批边界-106', callId: 'call-106a', signal: undefined },
      () => nextSentinel106)
    // 🔴 第三十三轮门槛 LOW#6（核对为真）：与 107/111 同规矩——**同一拍**给每个返回值挂
    //   reject handler（旧写法只 race 第一个，其余接管支路 reject 就是 unhandled rejection
    //   打挂进程）。接管身份判定仍按**原对象**做（capture 后拿不到原 Promise 身份）。
    const wrapped106a = raw106a.map((r) => Promise.resolve(r).then(
      (value) => ({ value }), (error) => ({ error })))
    const taken106a = wrapped106a.filter((_r, i) => raw106a[i] && typeof raw106a[i].then === 'function'
      && raw106a[i] !== nextSentinel106)
    ok(taken106a.length === 1,
      '（前提）群里的审批请求确实被本代飞书桥**接管**（恰好 1 个监听器扣下换成 Promise，'
      + '其余转交 next）｜接管数 ' + taken106a.length + '，没接管则下面两条断言是恒真')
    // 🔴 第三十一轮门槛 MEDIUM#3（核对为真）：与用例 107 同形的无界 await——若群审批边界闸
    //   回归成"当代接管并发卡"，这张卡的 Promise 要等 30 分钟审批超时才结算 ⇒ 整套 smoke
    //   挂住而不是当场判红。给 3 秒有界窗口：超时值不是 'unavailable' ⇒ 本条必红。
    const settled106a = taken106a.length
      ? await Promise.race([
          taken106a[0],
          new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 3000)),
        ])
      : null
    // 🔴 第三十四轮门槛 LOW#3（核对为真）：三层链式三元违反仓规（「嵌套三元改 if/else」），
    //   且日后编辑容易重结合**错分支**（把「无人接管」误标成「超时」＝掩盖真回归）。摊平。
    let outcome106a
    if (settled106a === null) {
      outcome106a = '（没有监听器接管）'
    } else if (settled106a.timedOut) {
      outcome106a = '（3 秒未结算＝疑似接管后挂着等审批）'
    } else if ('error' in settled106a) {
      outcome106a = '（监听器 reject：' + String((settled106a.error && settled106a.error.message) || settled106a.error) + '）'
    } else {
      outcome106a = settled106a.value
    }
    await settle(2)
    // 🔴 第三十轮门槛 LOW#3：拒发值从 'rejected' 改为框架词表内的 'unavailable'（fail-closed，
    //   文档口径见 index.js 该分支注释）——预执行钩子据此区分"未发卡"与"真人拒绝"。
    ok(outcome106a === 'unavailable',
      '★★★ 群里的审批请求判**渠道不可用**（不是挂一张群里人人可点的卡，也不是放行）｜实得 ' + JSON.stringify(outcome106a))
    // 白名单口径（第二十三轮 MEDIUM#5）：只拒"确认过的群"改成"只认确认过的 p2p"⇒ 留痕串同步更新
    ok(consoleLines.slice(log106a).some((l) => l.indexOf('approval refused') >= 0 && l.indexOf('kind=group') >= 0),
      '★★ 群审批拒发也留痕（白名单口径：kind 明确记为 group）')
    ok(cardsSince(mk106a).filter((c) => c.op === 'create'
      && JSON.stringify(c.payload).indexOf('需要你的确认') >= 0).length === 0,
      '★★★ 群里没有发出审批卡')

    // 🔴 第二十四轮 MEDIUM#3：/plan 也纳入私聊边界（它产出**群里人人可点**的计划审批卡：
    //   批准/拒绝 + 「🎯 以目标模式跑」）。旧字节（23 轮前）群里 /plan 直接受理 ⇒ 这两条必红。
    {
      const log106p = consoleLines.length
      const mk106p2 = sentCards.length
      feedGroup85(CHAT_ID, 'om_106_plan_group', '@_user_1 /plan 群里不许出计划卡', [GROUP_MENTION[0]])
      await settle(3)
      const win106p = cardsSince(mk106p2)
      ok(consoleLines.slice(log106p).some((l) => l.indexOf('私聊边界拒绝: /plan') >= 0),
        '★★★ 群里发 /plan ⇒ 边界拒绝并留痕（旧字节无此闸 ⇒ 这条必红）')
      ok(win106p.map((c) => JSON.stringify(c.payload)).join(' | ').indexOf('私聊') >= 0,
        '★★ 群里这条给"请在私聊里进行"的可见回执')
      // 🔴 第二十七轮门槛 MEDIUM#2（核对为真）：大小写错配把整批闸门绕光——旧分类拿
      //   lowercase 判刹车（`/plan OFF` 也算 off），执行侧却是**大小写敏感**的 `=== 'off'`
      //   ⇒ 大写形式在群里绕过私聊边界+开关+能力闸，落进"带正文 ⇒ 进计划模式并起回合"。
      //   修法＝分类钉原样大小写。这两条在修前字节上必红（大写被当刹车放行、无拒绝留痕）。
      // 🔴 第三十七轮门槛 MEDIUM#3（核对为真）：第二条原来断的是 **consoleLines**——而
      //   「已进入计划模式」只作为**出站正文**出现（index.js:3922 sendPlainText），从不进
      //   console ⇒ 恒真零判别力。改按同窗**出站卡**断（与 /goal clear 格同一口径）：
      //   旧字节大写被放行进开车路径 ⇒ 会话里必出现这条正文，本条必红。
      const log106U = consoleLines.length
      const mk106U = sentCards.length
      feedGroup85(CHAT_ID, 'om_106_plan_OFF', '@_user_1 /plan OFF', [GROUP_MENTION[0]])
      await settle(2)
      ok(consoleLines.slice(log106U).some((l) => l.indexOf('私聊边界拒绝: /plan') >= 0),
        '★★★ 群里发 /plan **OFF（大写）** 同样被边界拒住（大小写漂移不许当刹车绕闸）')
      ok(!cardsSince(mk106U).some((c) => JSON.stringify(c.payload).indexOf('已进入计划模式') >= 0),
        '★★ 大写这条**没有**落进"进计划模式起回合"的路径（判别力对照：旧字节正是从这里溜过闸门）')
    }

    // 对照组（防恒真）：把这条会话改回 p2p，同一个 /model 必须正常出卡
    feedInbound('om_106_back_p2p', '@_user_1 /help')
    await settle(2)
    const mk106p = sentCards.length
    llmOverride = {
      listProviders: () => [{ id: 'test', name: 'T 官方' }],
      listModels: async () => [{ id: 'm-test', name: 'M Test' }],
    }
    feedInbound('om_106_p2p_model', '/model')
    await settle(3)
    const picker106 = cardsSince(mk106p).find((c) => c.op === 'create'
      && allButtons(c).some((b) => b.value && b.value.fs_model))
    ok(!!picker106, '★★（对照）私聊里同一条 /model 照常出选择卡 ⇒ 上面那三条红不是因为卡出不来')
    // 🔴 第二十八轮门槛 MEDIUM#1（核对为真）：fs_model 的**点击通道**曾是唯一没来源守卫的
    //   动作口——卡被转发进群后，群里任何成员点一下就切了这个会话的模型（capabilityGuard
    //   默认关＝此路无闸）。把会话改标回群再点同一张 picker 的按钮：新字节拒答+留痕；
    //   旧字节无守卫会**真的应答并 PATCH「已切换为」**⇒ 下面三条在上一代字节上必红。
    feedGroup85(CHAT_ID, 'om_106_back_group', '@_user_1 /help', [GROUP_MENTION[0]])
    await settle(2)
    const log106t = consoleLines.length
    const mk106t = sentCards.length
    if (picker106 && picker106.msgId) {
      await tapValue({ fs_model: 'test|m-test' }, undefined, CHAT_ID, picker106.msgId)
      await settle(2)
    }
    ok(Boolean(picker106 && picker106.msgId),
      '★★★（前提）群内点击反例真的演到了（picker 建成且带 message_id）——缺位＝这条守卫没被驱动，宁红勿绿')
    ok(consoleLines.slice(log106t).some((l) => l.indexOf('/model 点击不作答') >= 0),
      '★★★ 群里点 /model 卡（转发的卡）＝不作答并留痕（旧字节此路无守卫 ⇒ 必红）')
    ok(!cardsSince(mk106t).some((c) => JSON.stringify(c.payload).indexOf('已切换为') >= 0),
      '★★ 群点击没有 PATCH/发出「已切换为」应答（行为级反证：不只是日志措辞变了）')
    // 🔴 第三十轮门槛 LOW#6（核对为真）：本用例把 CHAT_ID 标成了群，kind 会随 chats 落盘
    //   （persistChats/loadChats 恢复）⇒ 后续用例的结果开始依赖运行顺序与磁盘残留。
    //   收尾用一条带 chat_type=p2p 的入站把 kind 复位，每格自洽。
    //   🔴 第四十六轮 LOW#4（核对为真）：这四行收尾原来漂在**用例块外**（块在上面就 `}` 关了），
    //   缩进看着在块内、作用域其实是模块级——属"缩进暗示了不存在的嵌套"同类缺陷的尾巴。归位。
    feedInbound('om_106_reset_kind', '/help')
    await settle(2)
    llmOverride = null
    liveAgents.length = 0
}

// ---- C3：fs_plan_goal 点击 → goals.create 的行为断言（0.8.4 批次）-------------------
// 🔴 第三十五轮门槛 LOW#2：107-113 各自重复「写 cfg → 清 effectCleanups → 复位
//   __fsReloadHint → import/apply」四拍 Setup，抽 setupGen(cfg) helper 判**不修**：
//   全套断言刚以 35 轮回归验证跑绿，定版前的冻结窗口里做跨用例结构重构，
//   新形状的验证只能靠 diff，回归覆盖成本大于防漂移收益；防漂移记入下批次观察。
console.log('107) ★🔴 点「🎯 以目标模式跑」必须把计划全文交给 goals.create（C3 行为断言）')
{
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
             reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true }],
  }, null, 2))
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod107 = await import('../index.js')
  mod107.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  const nextSpy107 = () => Promise.resolve('next')
  // 🔴 前置绑定（用例 85/92 同规矩）：重新 apply 起的是**新一代**，agent↔chat 的归属表是
  //   代内闭包 ⇒ 必须先发一条普通入站把 agent 绑进本代，exit_plan_mode 才认得出"飞书回合"。
  armTurn85('107')
  feedInbound('om_107_bind', '先把你绑上')
  await settle(3)

  // ① 走**已验证的出卡路径**（用例 45 同形）：exit_plan_mode 工具层接管 ⇒ 计划审查卡
  //    （`/plan <正文>` 命令起的是普通回合，不产 fs_plan_goal 卡——首版就栽在这里）
  const plan107 = '# 把计划审查搬到飞书-107\n\n- 只读排查调用链'
  const mk107 = sentCards.length
  // 🔴 第三十二轮门槛 LOW#2（核对为真，用例 44 capture 同规矩）：**同一拍**就给每个监听器
  //   返回值挂 reject 处理——回归路径（接管后 askUserQuestion 超时 reject 等）若等 await 才挂，
  //   Node 先按 unhandled rejection 崩掉整个 smoke 进程（2026-10-02 实测过），红变成"挂死"。
  const runs107 = emitCtx('tools/execute',
    { name: 'exit_plan_mode', agent, arguments: { plan: plan107 }, signal: undefined }, nextSpy107)
    .map((r) => Promise.resolve(r).then((value) => ({ value }), (error) => ({ error })))
  await drain()
  const planCard107 = cardsSince(mk107).filter((c) => c.op === 'create')
    .find((c) => JSON.stringify(c.payload).includes('计划已写好'))
  ok(Boolean(planCard107), '★★★ 工具层接管出计划审查卡（前提，没卡下面全是恒真）')

  if (planCard107) {
    // ② 找到行2「🎯 以目标模式跑」的 fs_plan_goal 按钮，注入带 operator 的点击
    const goalVal = allButtons(planCard107).map((b) => b.value).find((v) => v && v.fs_plan_goal !== undefined)
    ok(Boolean(goalVal), '★★★ 卡上有 fs_plan_goal 按钮（行2 整行「以目标模式跑」）')
    const goalBefore = goalCalls.length
    const log107 = consoleLines.length
    // 🔴 第三十二轮门槛 LOW#3（核对为真）：按钮缺位（goalVal=undefined，上一条前提已打红）
    //   就**不要注入点击**——tapValue(undefined) 发的是无 token 事件，被 handleCardAction
    //   "no token ⇒ ignoring" 支路吞掉，正好在已红格上多一条误导痕迹。全文守同款规矩。
    if (goalVal) {
      await tapValue(goalVal, {
        open_id: 'ou_test', union_id: 'on_test107', user_id: '',
      })
      await drain()
    }
    // ③ 行为断言：goals.create **真的被调**且收到的 objective 就是计划全文
    //    （0.8.2 只统一了身份取法，`goalCalls` 这条行为面一直没人钉 —— 本条补上）
    ok(goalCalls.length === goalBefore + 1
      && String(goalCalls[goalCalls.length - 1].objective || '').includes('把计划审查搬到飞书-107'),
      '★★★ 点「以目标模式跑」⇒ goals.create 收到计划全文（C3）｜实得 '
      + JSON.stringify(goalCalls[goalCalls.length - 1] || null))
    ok(consoleLines.slice(log107).some((l) => l.indexOf('plan goal created') >= 0),
      '★★ 建目标成功要留痕（`plan goal created`，失败支路则是 `plan goal failed`）')
    // ④ 批准也要答出去（runs 拿到 approved:true 的工具结果，会话不停在半截）
    //    结果对象三层形状（与用例 45 同源）：`{ isError:false, value:{approved:true}, content:[…] }`
    //    —— approved 在**第三层**（`o.value` 才是监听器原返回值，find 再包一层 `{value}`）。
    // 🔴 第三十轮门槛 MEDIUM#2（核对为真）：这段 await 原来**无条件**执行——若卡上没有
    //   fs_plan_goal 按钮（正是紧邻用例 109 守护的回归），点击没有 token ⇒ 提问无人结算 ⇒
    //   Promise.all 挂满 askUserQuestion 的 30 分钟超时才 reject，整套 smoke 卡半小时。
    //   改成：goalVal 缺失就跳过等待（上面那条 ok 已经打红），存在时也只给 3 秒有界窗口。
    const wrapped107 = goalVal ? (await Promise.race([
      Promise.all(runs107),
      new Promise((resolve) => setTimeout(() => resolve([]), 3000)),
    ])).find((o) => o.value && typeof o.value === 'object' && 'content' in o.value)
      : null
    const tool107 = wrapped107 && wrapped107.value
    ok(Boolean(tool107) && tool107.isError === false
      && tool107.value && tool107.value.approved === true,
      '★ 点击同时把「批准」答回工具调用（approved:true，不留半截状态）｜实得 '
      + JSON.stringify(tool107))
  }

  llmOverride = null
  liveAgents.length = 0
}

// ---- C5 / K10 机器守护：新通道「不写＝关」必须有用例钉住（CM 最小化总则的机械化）----
console.log('108) ★🔴 新开关默认关：配置不写 planEnabled/goalEnabled ⇒ /plan、/goal 不受理（K10）')
{
  // 夹具**刻意不写**这两个开关（也不写 capabilityGuard/identityGuard）——这一格钉的就是
  //   「缺省形态＝关」，所以不许在这里"顺手补上"。
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
             reactionEmoji: 'GLANCE' }],
  }, null, 2))
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod108 = await import('../index.js')
  mod108.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  llmOverride = {
    listProviders: () => [{ id: 'test', name: 'T 官方' }],
    listModels: async () => [{ id: 'm-test', name: 'M Test' }],
  }
  // 命令注册表 recorder（别处同款装法）：记到 `execute` 被调到的每一行
  // 🔴 第二十九轮门槛 LOW#6（核对为真）：还原原来只挂在**顺序路径**末尾——中途任何
  //   await 抛了，recorder 就漏给后续代（109-112 的 execute 全被它吃掉）。同批登记的
  //   effectCleanups 在**每一代 apply 前无条件跑**（105/108 自己就是这么用的），把还原
  //   也挂进去＝抛不抛都兜得住；顺序路径上那句显式还原保留（幂等，双保险）。
  const prevExec108 = fakeCommands.execute
  effectCleanups.push(() => { fakeCommands.execute = prevExec108 })
  const cmdLines108 = []
  fakeCommands.execute = async (a, line) => { cmdLines108.push(line); return undefined }
  // 回执判据（用例 14 同形）：sendPlainText 发的是 1.0 文本卡，取**本格窗口内**新增最后一张的正文
  // 🔴 第三十一轮门槛 MEDIUM#1（核对为真）：旧写法三个子格共用一个 `mark108` 且从不推进 ⇒
  //   若 /plan 回归成静默 return（②不产生新卡），reply 读到的是①那格 /goal 的回执（本就含
  //   「未启用」）⇒ ②假过。每格各取自己的起点，窗口内没卡就判空串（宁红勿假绿）。
  const reply108 = (from) => {
    const creates = sentCards.slice(from)
      .filter((c) => c.op === 'create' && c.payload && !c.payload.schema && Array.isArray(c.payload.elements))
    const last = creates[creates.length - 1]
    // 🔴 第三十二轮门槛 LOW#1（核对为真）：buildCardPayload 可以产出**空 elements** 的 1.0 卡
    //   （全部块被过滤）——旧写法 `elements[0].content` 在这种卡上直接 TypeError，把"该红的
    //   断言"升级成"夹具崩溃"。越界一并防护，返回空串走正常判红。
    const first = last && last.payload.elements[0]
    return first ? String(first.content || '') : ''
  }

  // ① /goal 未开 ⇒ 不受理：不进命令通道（harness 收不到 `/goal …`）、留痕、有可见回执
  {
    const log108 = consoleLines.length
    const mark108a = sentCards.length
    feedInbound('om_108_goal_off', '/goal 关掉时不许开目标')
    await drain()
    ok(cmdLines108.length === 0,
      '★★★ 开关关着 ⇒ /goal 没有下发到命令通道（旧字节无此闸 ⇒ 这条必红）｜实到 '
      + JSON.stringify(cmdLines108))
    ok(consoleLines.slice(log108).some((l) => l.indexOf('开关拒绝') >= 0 && l.indexOf('/goal') >= 0),
      '★★ 拒绝必须留痕（同一行含「开关拒绝」与 /goal）')
    ok(reply108(mark108a).includes('未启用'), '★★ 拒绝给可见回执（不是静默吞掉）｜实得 ' + JSON.stringify(reply108(mark108a)))
  }
  // ② /plan 未开 ⇒ 同样不受理（🔴 第二十四轮 LOW#6：与 ① 对称补齐「留痕+可见回执」，
  //    否则把 /plan 改成静默 return 的回归照样过这一格）
  {
    const log108p = consoleLines.length
    const mark108b = sentCards.length
    feedInbound('om_108_plan_off', '/plan 关掉时不许开计划')
    await drain()
    ok(cmdLines108.length === 0,
      '★★★ 开关关着 ⇒ /plan 没有下发到命令通道｜实到 ' + JSON.stringify(cmdLines108))
    ok(consoleLines.slice(log108p).some((l) => l.indexOf('开关拒绝') >= 0 && l.indexOf('/plan') >= 0),
      '★★ 拒绝必须留痕（同一行含「开关拒绝」与 /plan）')
    ok(reply108(mark108b).includes('未启用'), '★★ /plan 拒绝给可见回执｜实得 ' + JSON.stringify(reply108(mark108b)))
  }
  // ③ 对照组（防恒真）：没挂开关的 /help 照常受理 ⇒ 红不是因为命令链路整体坏了
  {
    const mark108c = sentCards.length
    feedInbound('om_108_help', '/help')
    await drain()
    ok(reply108(mark108c).includes('/new'),
      '★★（对照）/help 仍被正常受理（命令链路活着，只有带开关的两条被拒）｜实得 '
      + JSON.stringify(reply108(mark108c).slice(0, 40)))
  }
  // ④ 记录器**在位性**对照（第二十四轮 MEDIUM#6）：①② 判的是
  //   `cmdLines108.length === 0`——若记录器本身没挂进下发路径，这个 0 就是**恒真**。
  //   喂一条**不带开关**、会真正走到 `commands.execute` 的命令（/compact），断言记录器收得到。
  //   /compact 要活体 agent ⇒ 与用例 107 同款先 arm+bind 进本代。
  armTurn85('108')
  feedInbound('om_108_bind', '先把你绑上')
  await settle(3)
  {
    feedInbound('om_108_compact', '/compact')
    await drain()
    ok(cmdLines108.some((l) => String(l).indexOf('/compact') >= 0),
      '★★★（在位性对照）没挂开关的 /compact 真的到达了命令通道 ⇒ ①② 的「长度=0」不是恒真'
      + '｜实到 ' + JSON.stringify(cmdLines108))
  }
  // ⑤（第二十四轮 MEDIUM#7）真"刹车/只读"子命令**不吃开关**：开关关 ≠ 没被关在模式里——
  //   GUI 起的计划模式要靠 /plan off 退出；跑着的目标要靠 /goal pause 刹车
  //   （clear 不是刹车——第三十六轮 MEDIUM 已归闸；resume 也不是——第四十轮 MEDIUM 已归闸，
  //   正由上方用例 106 与下方 resume 格分别钉住）。
  //   被开关拦下＝人下不了正在跑的火车。这一组在"只有开关没有旁路"的字节上必红。
  {
    const log108m = consoleLines.length
    feedInbound('om_108_planoff', '/plan off')
    await drain()
    ok(cmdLines108.some((l) => String(l).indexOf('/plan off') >= 0),
      '★★★ 开关关着 ⇒ /plan off 仍下发（管理命令走旁路）｜实到 ' + JSON.stringify(cmdLines108))
    ok(!consoleLines.slice(log108m).some((l) => l.indexOf('开关拒绝') >= 0 && l.indexOf('/plan') >= 0),
      '★★ /plan off 不许被记成「开关拒绝」')
  }
  {
    const log108g = consoleLines.length
    feedInbound('om_108_goalpause', '/goal pause')
    await drain()
    ok(cmdLines108.some((l) => String(l).indexOf('/goal pause') >= 0),
      '★★★ 开关关着 ⇒ /goal pause 仍下发（刹目标不受开关限制）｜实到 ' + JSON.stringify(cmdLines108))
    ok(!consoleLines.slice(log108g).some((l) => l.indexOf('开关拒绝') >= 0 && l.indexOf('/goal') >= 0),
      '★★ /goal pause 不许被记成「开关拒绝」')
  }
  // 🔴 第四十轮门槛 MEDIUM（核对为真）：resume 是"开车"不是"刹车"——豁免已收回，它与建目标
  //   一样吃开关闸。第三十九轮那版钉的是「豁免照下发」的反面（当时判据把 resume 当刹车），
  //   前提已被本轮裁决推翻，本格整体翻转：旧字节 resume 豁免直通下发 ⇒ 三条全红（真判别器）。
  {
    const log108r = consoleLines.length
    const mark108r = sentCards.length
    feedInbound('om_108_goalresume', '/goal resume')
    await drain()
    ok(!cmdLines108.some((l) => String(l).indexOf('/goal resume') >= 0),
      '★★★ 开关关着 ⇒ /goal resume **不**下发（resume＝重新开跑烧钱的目标，归闸；旧字节豁免直通＝本条必红）｜实到 '
      + JSON.stringify(cmdLines108))
    ok(consoleLines.slice(log108r).some((l) => l.indexOf('开关拒绝') >= 0 && l.indexOf('/goal') >= 0),
      '★★ /goal resume 必须被记成「开关拒绝」（不许静默吞）')
    ok(reply108(mark108r).includes('未启用'),
      '★★ /goal resume 拒绝给可见回执｜实得 ' + JSON.stringify(reply108(mark108r)))
  }
  fakeCommands.execute = prevExec108
  llmOverride = null
  liveAgents.length = 0
}

// ---- 109：fs_plan_goal 卡上按钮也必须过 goalEnabled 闸（第二十三轮 MEDIUM#6 补网）------
// 107 只演了"开关开着能建目标"，108 只钉了**命令通道**的开关拒绝 ⇒ 卡片通道无人看守：
//   闸被删也能进目标模式（连开多轮真花钱）。这一格补上"开关关 ⇒ 卡上点不动"。
console.log('109) ★🔴 goalEnabled 关 ⇒ 点计划卡的「🎯 以目标模式跑」不建目标（卡通道开关闸）')
{
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
             reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true }],
  }, null, 2))
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod109 = await import('../index.js')
  mod109.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  const nextSpy109 = () => Promise.resolve('next')
  armTurn85('109')
  feedInbound('om_109_bind', '先把你绑上')
  await settle(3)

  const plan109 = '# 卡片开关闸反例-109\n\n- 目标模式不许从卡上开进来'
  const mk109 = sentCards.length
  // 🔴 第三十三轮门槛 MEDIUM#2（核对为真）：本格同样吃"无界 await/裸返回值"这个坑——
  //   emitCtx 返回值被整数组丢弃 ⇒ 接管支路的 Promise（只在 30 分钟超时或发卡失败时
  //   reject）没有同拍 handler，一旦 reject 就是 unhandled rejection **打挂整个 smoke**
  //   （用例 44/107/111 同规矩：同一拍逐个挂 handler，把 reject 变成值）。
  emitCtx('tools/execute',
    { name: 'exit_plan_mode', agent, arguments: { plan: plan109 }, signal: undefined }, nextSpy109)
    .forEach((r) => { Promise.resolve(r).then(() => {}, () => {}) })
  await drain()
  const planCard109 = cardsSince(mk109).filter((c) => c.op === 'create')
    .find((c) => JSON.stringify(c.payload).includes('计划已写好'))
  ok(Boolean(planCard109), '（前提）计划审查卡照常发出（计划通道没被本格开关关住）')

  if (planCard109) {
    const goalVal109 = allButtons(planCard109).map((b) => b.value)
      .find((v) => v && v.fs_plan_goal !== undefined)
    ok(Boolean(goalVal109), '（前提）卡上有 fs_plan_goal 按钮')
    const goalBefore109 = goalCalls.length
    const log109 = consoleLines.length
    // 🔴 第三十二轮门槛 LOW#3（同 107）：fs_plan_goal 缺位时不注入点击，免得留误导痕迹。
    if (goalVal109) {
      await tapValue(goalVal109, {
        open_id: 'ou_test', union_id: 'on_test109', user_id: '',
      })
      await drain()
    }
    ok(goalCalls.length === goalBefore109,
      '★★★ 开关关着 ⇒ 点「以目标模式跑」**没有**调用 goals.create（闸被删此条必红）｜实增 '
      + (goalCalls.length - goalBefore109))
    ok(consoleLines.slice(log109).some((l) => l.indexOf('开关拒绝') >= 0 && l.indexOf('card:fs_plan_goal') >= 0),
      '★★ 卡片通道拒绝也留痕（同一行含「开关拒绝」与 card:fs_plan_goal）')
    const txt109 = cardsSince(mk109).map((c) => JSON.stringify(c.payload)).join(' | ')
    ok(txt109.includes('未启用'), '★★ 给点击者可见回执（goalEnabled 未启用），不许静默吞掉')
  }

  llmOverride = null
  liveAgents.length = 0
}

// ---- 110：过期提醒"同一行只提醒一次"，且去重标记**随表持久化**（第二十四轮 MEDIUM#4）----
console.log('110) ★🔴 过期授权首次拦下时提醒一次；再拦不再重发；notified 落盘')
{
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
             reactionEmoji: 'GLANCE', goalEnabled: true, capabilityGuard: true,
             capabilityApproverOpenId: 'ou_approver_110' }],
  }, null, 2))
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'capability_grants.json'), JSON.stringify({
    version: 1,
    grants: [{ id: 'grant-110', capability: 'goal', open_id: 'ou_test', union_id: '',
               name: '', app_id: APP_ID, requester_chat_id: CHAT_ID, term: 'today',
               granted_at: '2020-01-01T00:00:00.000Z', expires_at: '2020-01-01T00:00:00.000Z',
               granted_by: 'ou_approver_110' }],
  }, null, 2))
  // 🔴 窗口从**播种之后**就开：harness 的 ctx.interval 每拍都触发所有代际的定时器，
  //   提醒可能落在 apply 后第一拍（早于任何入站）⇒ 只断言"本代开始后发过且只发过"。
  const logGen110 = consoleLines.length
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod110 = await import('../index.js')
  mod110.apply(ctx)
  await settle(2)
  liveAgents.push(agent)

  // ① 过期提醒**至少发出一次** + 去重标记落盘
  {
    feedInbound('om_110_first', '/goal 过期后不许静默续跑')
    await settle(3)
    ok(consoleLines.slice(logGen110).some((l) => l.indexOf('capability expired notice: ') >= 0),
      '★★★ 过期授权被本代发出「审批已过期」提醒（同一行留痕；发在清扫拍或拦下拍都算）')
    let g110 = null
    try { g110 = JSON.parse(readFileSync(join(process.env.FS_CONFIG_DIR, 'capability_grants.json'), 'utf8')) } catch { /* 判红 */ }
    const row110 = g110 && (g110.grants || []).find((r) => r.id === 'grant-110')
    ok(row110 && row110.notified === true,
      '★★★ 去重标记**写在表里**（第二十四轮 M4：内存集合会因逐出/重启失信；重启后不重发才是契约）｜实得 '
      + JSON.stringify(row110 && row110.notified))
  }
  // ② 再拦一次 ⇒ 不得重复提醒（notified 持久生效；旧内存全清/逐出版本在这里会红）
  {
    const log110b = consoleLines.length
    feedInbound('om_110_second', '/goal 第二次拦下')
    await settle(3)
    ok(!consoleLines.slice(log110b).some((l) => l.indexOf('capability expired notice: ') >= 0),
      '★★★ 同一过期行第二次拦下**不再**提醒（同一行只提醒一次）')
  }

  // 🔴 第四十三轮门槛 LOW#3（核对为真）：表**读不出来**（这里用坏 JSON 模拟）≠没批过——
  //   拒因必须单立（table_unreadable），且**不许发起申请卡**（recordCapabilityGrant 在
  //   readFailed 时中止入库，那张批了也存不进去＝第二次"批了没生效"）。旧字节走 no_grant：
  //   发「还没获批＋已受理申请」回执＋真发审批卡 ⇒ 三条全红。
  {
    writeFileSync(join(process.env.FS_CONFIG_DIR, 'capability_grants.json'), '{broken')
    const log110u = consoleLines.length
    const mk110u = sentCards.length
    feedInbound('om_110_unreadable', '/goal 表读不出时不许发起申请')
    await settle(3)
    ok(consoleLines.slice(log110u).some((l) => String(l).indexOf('table_unreadable') >= 0),
      '★★★ 读失败走独立拒因留痕（table_unreadable，不许混进 no_grant）')
    const txt110u = cardsSince(mk110u).map((c) => JSON.stringify(c.payload)).join(' | ')
    ok(txt110u.includes('读不出来') && txt110u.indexOf('已受理你的申请') === -1,
      '★★ 回执如实"读不出来、不发起申请"，禁 no_grant 措辞＋受理承诺（旧字节必红）｜实得 ' + txt110u.slice(0, 160))
    ok(!cardsSince(mk110u).some((c) => c.op === 'create'
      && JSON.stringify(c.payload).indexOf('fs_cap_grant') >= 0),
      '★★★ 没有向审批人发新的申请卡（存不进去的卡＝制造第二次"批了没生效"）')
  }

  // 🔴 第三十轮门槛 LOW#6（核对为真）：本用例播种的过期 grants 必须收尾删除——留着的话
  //   111/112 是靠磁盘残留（notified=true 抑制重发）跑绿的，用例顺序一调整就难归因。
  // 🔴 第三十三轮门槛 LOW#5（核对为真）：只宽恕"本就不存在"（ENOENT）——EPERM/EACCES 这类
  //   **真删失败**不许被当成已清理静默吞掉（残留照样污染后续格），点名判红。
  try { rmSync(join(process.env.FS_CONFIG_DIR, 'capability_grants.json')) } catch (error) {
    ok(Boolean(error && error.code === 'ENOENT'),
      '★★ 110 收尾：grants 播种文件要么删掉要么本就不存在｜实得 ' + String(error && error.code))
  }
  liveAgents.length = 0
}

// ---- 111：计划审查卡也不许投进群——exit_plan_mode 对接管会话做 p2p 白名单（第二十五轮 MEDIUM#4）----
console.log('111) ★🔴 群会话的 exit_plan_mode **不接管**（不往群里投人人可点的计划审批卡）')
{
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
             reactionEmoji: 'GLANCE', approvalForm: true, planEnabled: true, goalEnabled: true }],
  }, null, 2))
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod111 = await import('../index.js')
  mod111.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  const nextSpy111 = () => Promise.resolve('next-111')
  armTurn85('111')
  feedInbound('om_111_bind', '先把你绑上')
  await settle(3)
  // 把这条会话在桥的账上改成**群**（群判据只认入站 chat_type，用例 65 同规矩）
  feedGroup85(CHAT_ID, 'om_111_mark_group', '@_user_1 /help', [GROUP_MENTION[0]])
  await settle(2)

  const plan111 = '# 群会话计划卡反例-111\n\n- 不许投进群'
  const mk111 = sentCards.length
  const log111 = consoleLines.length
  // 🔴 第三十二轮门槛 LOW#2（核对为真，同 107/用例44）：reject 处理必须**同拍**挂上——
  //   本用例要防的回归（当代接管群调用）恰好走"提问超时 reject"这条路，晚挂 handler＝
  //   unhandled rejection 先把 smoke 进程打挂，断言红永远看不到。
  const runs111 = emitCtx('tools/execute',
    { name: 'exit_plan_mode', agent, arguments: { plan: plan111 }, signal: undefined }, nextSpy111)
    .map((r) => Promise.resolve(r).then((value) => ({ value }), (error) => ({ error })))
  await drain()
  ok(consoleLines.slice(log111).some((l) => l.indexOf('exit_plan_mode 不接管') >= 0),
    '★★★ 群会话的 exit_plan_mode 走原生通道并留痕（旧字节无此闸 ⇒ 这条必红）')
  ok(cardsSince(mk111).filter((c) => c.op === 'create'
    && JSON.stringify(c.payload).includes('计划已写好')).length === 0,
    '★★★ 没有把「计划已写好」审批卡投进群（群里人人可点＝把审批权发给全群）')
  // 🔴 第三十一轮门槛 MEDIUM#2（核对为真）：无界 await 同用例 107 形状——若当代回归成
  //   "接管群调用"，它返回的 Promise 要等 30 分钟提问超时才结算 ⇒ 整套 smoke 挂住而不是
  //   当场红。3 秒有界窗口：超时就塞一个非 'next-111' 的标记值，下面的 every 判据必红。
  const wrapped111 = await Promise.race([
    Promise.all(runs111),
    new Promise((resolve) => setTimeout(
      () => resolve([{ value: '（3 秒未结算＝疑似当代接管挂住）' }]), 3000)),
  ])
  const outs111 = wrapped111.map((o) => (o && o.error)
    ? '（监听器 reject：' + String((o.error && o.error.message) || o.error) + '）'
    : (o && o.value))
  // 🔴 第二十八轮门槛 MEDIUM#2（核对为真）：`some` 在这里**永真**——emitCtx 会把这次调用
  //   发给**所有代**的监听器（夹具的 disposer 是空操作 ⇒ 旧代监听器从不摘除），旧代不拥有
  //   这条会话、全部转发回 'next-111'。当代若回归成"接管群调用"，它的返回值不是 next-111，
  //   但 some 仍被旧代那一大堆喂真 ⇒ 判别力为零。改 every：当代接管当场红。
  ok(outs111.every((o) => o === 'next-111'),
    '★★ 不接管＝**每一个**监听器都原样 next()（some 会被旧代恒真兜住；实得 '
    + outs111.length + ' 份，非 next-111 的有 '
    + outs111.filter((o) => o !== 'next-111').length + ' 份）')

  // ③ 🔴 第三十二轮门槛 MEDIUM#2（核对为真）服务层兜底：工具层 next() 放给原生通道后，
  //   原生照样会沿 user-questions/request 发一条 **plan-review 提问**——收口点在
  //   handleUserQuestionRequest，那里缺 p2p 闸的话「计划已写好」卡仍会进群（旧字节必红）。
  {
    const mk111q = sentCards.length
    const log111q = consoleLines.length
    const q111 = {
      id: 'plan-review', header: 'Plan review', question: 'Approve this plan and leave plan mode?',
      detail: plan111, intent: { kind: 'plan-review' },
      options: [{ label: 'Approve', description: 'Leave plan mode.' },
        { label: 'Keep planning', description: 'Stay in plan mode.' }],
    }
    // capture 同拍挂 handler：接管支路的 Promise 可能长挂/超时 reject，不留单拍钩子会打挂进程
    emitCtx('user-questions/request', { agent, questions: [q111], signal: undefined },
      () => Promise.resolve('next-111q'))
      .forEach((r) => { Promise.resolve(r).then(() => {}, () => {}) })
    await drain()
    ok(consoleLines.slice(log111q).some((l) => l.indexOf('plan-review 卡不作答') >= 0),
      '★★★ 群会话的原生通道 plan-review 提问也被**服务层收口点**闸住并留痕（旧字节无闸 ⇒ 必红）')
    ok(cardsSince(mk111q).filter((c) => c.op === 'create'
      && JSON.stringify(c.payload).includes('计划已写好')).length === 0,
      '★★★ 走服务层通道同样没把计划审批卡投进群（闸落唯一收口点，不是只闸工具层）')
  }
  // 🔴 第三十轮门槛 LOW#6：同 106 —— 本用例把 CHAT_ID 标成群，收尾用 p2p 入站复位，
  //   不把群残留带给 112 与以后的新用例。
  feedInbound('om_111_reset_kind', '/help')
  await settle(2)
  // ④ 🔴 第三十二轮 M2 对照组（防闸过紧误伤）：**私聊**里同一条 plan-review 提问必须照常
  //   接管发卡，并用点击 Approve 结算（不留 30 分钟悬问）。闸判据写反/全量设闸 ⇒ 本条红。
  {
    const mk111p = sentCards.length
    const q111p = {
      id: 'plan-review', header: 'Plan review', question: 'Approve this plan and leave plan mode?',
      detail: plan111, intent: { kind: 'plan-review' },
      options: [{ label: 'Approve', description: 'Leave plan mode.' },
        { label: 'Keep planning', description: 'Stay in plan mode.' }],
    }
    const runs111p = emitCtx('user-questions/request', { agent, questions: [q111p], signal: undefined },
      () => Promise.resolve('next-111p'))
      .map((r) => Promise.resolve(r).then((value) => ({ value }), (error) => ({ error })))
    await drain()
    const qCard111 = cardsSince(mk111p).filter((c) => c.op === 'create')
      .find((c) => JSON.stringify(c.payload).includes('计划已写好'))
    ok(Boolean(qCard111), '★★（对照）私聊的 plan-review 提问照常出审批卡（闸只挡非确认私聊，不是一刀切）')
    const tok111 = (() => {
      const m = /"fs_question":"([^"]+)"/.exec(JSON.stringify((qCard111 && qCard111.payload) || {}))
      return m ? m[1] : ''
    })()
    ok(Boolean(tok111), '（前提）对照卡上取到了 fs_question token（没取到＝结算没被演）')
    // 🔴 第四十一轮门槛 MEDIUM（核对为真）：①if 守卫里 msgId 缺位＝整段**静默跳过**，
    //   对照格承诺的"点击结算"根本没被演还全绿；②race 结果被丢弃——出卡了但提问**没结算**
    //   （30 分钟悬问）也无人判红。前提补钉 msgId，结算结果补 ok() 消费。
    ok(Boolean(qCard111 && qCard111.msgId),
      '（前提）对照卡带 message_id（缺位＝点击没被驱动，下面判定会恒真，就地变红）')
    // 🔴 第三十四轮门槛 MEDIUM#1（核对为真）：原写法对 `runs111p` 是**无界** `Promise.all`
    //   且没钉 msgId——对照路径一回归（没出卡/卡上没 token/msgId 缺失 ⇒ 点击结算不了），
    //   提问就挂到 30 分钟 ask 超时、整场冒烟被吊死＝本批次要消灭的失效模式本身。
    //   补 msgId 守卫 + 3 秒 race：结算不到就地放行（对照断言自会红），不悬半刻。
    if (tok111 && qCard111 && qCard111.msgId) {
      await tapValue({ fs_question: tok111, fs_option: 0 }, undefined, CHAT_ID, qCard111.msgId)
      await drain()
      const settled111p = await Promise.race([
        Promise.all(runs111p),
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ])
      ok(Boolean(settled111p) && settled111p.every((o) => o && !o.error),
        '★★（对照）私聊 plan-review 点击**真的结算**了提问（不留 30 分钟悬问；超时/报错都判红）｜实得 '
        + JSON.stringify(settled111p && settled111p.map((o) => (o && o.error) ? 'error' : 'ok') || '（3 秒未结算）'))
    }
  }
  liveAgents.length = 0
}

// ---- 112：运行时"所有互动卡都带 update_multi"总闸（第二十六轮门槛 LOW#9） --------
console.log('112) ★★★ 本轮发出的**每一张**互动卡（含各用例全生命周期）config.update_multi=true')
{
  // 105a 是**源码级**字面量守卫：变量传值（`config: cardCfg`）、整份缺 config 对它隐形，
  //   且它验的是"文件里写了"，不是"发出去的那份带没带"。这一条直接过**出口层**：
  //   遍历夹具记录的全部出站卡，create 的互动卡（有 elements/header）必须带
  //   `config.update_multi === true`；PATCH 若携带 config 同样钉值。源码守卫继续留着
  //   兜"从没被任何用例发出的卡"，两闸互补、不互替。
  const bad112 = []
  // 🔴 第三十八轮门槛 LOW#3（核对为真）：原来只存 config 团——112 走的是**全量累计**
  //   sentCards，红格时报不出是哪一张/哪个用例的卡，归因会被无关老用例带偏。
  //   每条违例带上记录序号与 msg/标题指纹，红格可分诊。
  for (const [i, c] of sentCards.entries()) {
    const p = c.payload || {}
    const triage112 = '#' + i + ' msg=' + String(c.msgId || '-')
      + ' head=' + String(p.header || (p.config && p.config.summary) || '').slice(0, 24)
    // 🔴 第二十八轮门槛 LOW#3（核对为真）：互动卡有**两种形状**——1.0 的顶层 elements，
    //   和 2.0 的 `body.elements`（主流式卡 index.js:1927 就是后者、且**不带顶层 header**，
    //   旧判据把它跳过了＝本闸宣称覆盖的最常发卡型其实没演）。两种形状都要吃进来。
    const isCard = Array.isArray(p.elements) || Boolean(p.header)
      || (p.body && Array.isArray(p.body.elements))
    if (c.op === 'create' && isCard) {
      if (!p.config || p.config.update_multi !== true) {
        bad112.push(triage112 + ' create:' + JSON.stringify((p.config !== undefined ? p.config : null)))
      }
    } else if (c.op === 'update' && p.config && p.config.update_multi !== true) {
      bad112.push(triage112 + ' update:' + JSON.stringify(p.config))
    }
  }
  ok(bad112.length === 0,
    '★★★ 出口层总闸：没有一张互动卡缺 update_multi 或带 false（v0.8.3 的"回退"形状在此必红）'
    + '｜违规 ' + JSON.stringify(bad112.slice(0, 3)) + '（共 ' + bad112.length + ' 处）')
}

// ---- 113：审批单（feishu_approval_form / fs_form 通道）的私聊边界 + 能力闸（第三十三轮 MEDIUM#3）----
console.log('113) ★🔴 审批单只发已确认私聊；capabilityGuard 开着时 fs_form 点击必须过 approval 能力闸')
{
  writeFileSync(join(process.env.FS_CONFIG_DIR, 'feishu.config.json'), JSON.stringify({
    bots: [{ name: 'smoke', workspace: WORKSPACE, appId: APP_ID, appSecret: APP_SECRET,
             reactionEmoji: 'GLANCE', approvalForm: true, capabilityGuard: true,
             capabilityApproverOpenId: 'ou_approver_113' }],
  }, null, 2))
  for (const cleanup of effectCleanups) { try { cleanup() } catch { /* 夹具清理尽力而为 */ } }
  effectCleanups.length = 0
  globalThis.__fsReloadHint = null
  const mod113 = await import('../index.js')
  mod113.apply(ctx)
  await settle(2)
  liveAgents.push(agent)
  const formTool113 = toolNow('feishu_approval_form')
  ok(Boolean(formTool113 && typeof formTool113.execute === 'function'),
    '（前提）feishu_approval_form 工具已注册（否则下面全是恒真）')
  armTurn85('113')
  feedInbound('om_113_bind', '先把会话绑进本代-113')
  await settle(3)

  // ① 群拒发（反证格）：把 CHAT_ID 标成群 ⇒ 工具调用必须**明确拒绝**、不发卡、留痕。
  //    旧字节 askApprovalForm 无 isP2pChat 判据 ⇒ 整张审批单卡（采纳/驳回）发进群，三条全红。
  {
    const mk113a = sentCards.length
    const log113a = consoleLines.length
    feedGroup85(CHAT_ID, 'om_113_mark_group', '@_user_1 /help', [GROUP_MENTION[0]])
    await settle(2)
    // 🔴 第三十三轮复跑发现：旧字节无拒发闸 ⇒ execute 把卡发进群后**无界挂起**，
    //   negctrl 死于 30 分钟提问超时、113 三条判据根本没打印 ⇒ 红名单被截断（假过）。
    //   改为 3 秒 Promise.race 有界：旧字节超时落入「3 秒未返回＝旧形状」→ 本条快速变红。
    // 🔴 第四十轮门槛 LOW#6（核对为真）：前提格红（工具没注册）时这里原来**无条件解引用**
    //   ⇒ TypeError 打断整场冒烟、红单丢失——与本文件 COLD 分支立下的规矩相悖（断言失败后
    //   不许继续解引用）。未注册时给一个「拒发理由=未注册」的哨兵值，让下方断言照常判红。
    const exec113a = formTool113
      ? formTool113.execute(
        { title: '群拒发反例-113', chatId: CHAT_ID }, { agent, signal: undefined })
      : Promise.resolve({ ok: false, detail: '（feishu_approval_form 未注册＝前提已红）' })
    exec113a.then(() => { }, () => { })
    const refused113 = await Promise.race([
      // 🔴 第三十八轮门槛 LOW#5（核对为真）：race 里放的原来是**裸** promise——
      //   `.then(()=>{},()=>{})` 只消 unhandled rejection，**不改变 race 的结算**：
      //   execute 一旦 reject，top-level await 当场抛＝整场冒烟截断（红单丢失，
      //   正是 107/111 用 {value}/{error} 同拍包装防过的失效模式）。改成错误→值。
      Promise.resolve(exec113a).then(
        (value) => value,
        (error) => ({ ok: false, detail: '（execute 抛错＝失败：' + String((error && error.message) || error) + '）' })),
      new Promise((resolve) => setTimeout(() => resolve(
        { ok: false, detail: '（3 秒未返回＝单子挂在群里等人点＝旧形状）' }), 3000)),
    ])
    await settle(2)
    ok(Boolean(refused113) && refused113.ok === false && String(refused113.detail || '').includes('私聊'),
      '★★★ 群里的审批单请求被**拒发并明确返回拒绝理由**（旧字节直接发卡进群 ⇒ 本条必红）｜实得 '
      + JSON.stringify(refused113 && refused113.detail || refused113))
    ok(consoleLines.slice(log113a).some((l) => l.indexOf('approval form refused (chat not known p2p)') >= 0),
      '★★ 审批单拒发留痕（与 fs_approval 同一白名单口径）')
    ok(cardsSince(mk113a).filter((c) => c.op === 'create'
      && JSON.stringify(c.payload).indexOf('fs_form') >= 0).length === 0,
      '★★★ 群里一张审批单卡（fs_form 按钮卡）都没发出去')
  }

  // ② p2p 对照（防闸过紧误伤 + 自证出口闸）：复位私聊后同一调用**照常出卡**，
  //    卡必须带 config.update_multi=true（113 在 112 之后运行，本格出口自证）。
  feedInbound('om_113_reset_kind', '/help')
  await settle(2)
  const mk113b = sentCards.length
  const ac113 = new AbortController()
  // 🔴 第四十轮门槛 LOW#6：②同样不许裸解引用——工具没注册时给一条"如实红"的替身，
  //   而不是 TypeError 截断整场（formCard113 判据自然变红）。
  const formPromise113 = formTool113
    ? formTool113.execute(
      { title: '能力闸反例-113', chatId: CHAT_ID }, { agent, signal: ac113.signal })
    : Promise.resolve(null)
  formPromise113.then(() => { }, () => { })   // 同拍挂 handler：abort/超时 reject 不许打挂进程
  await drain()
  const formCard113 = cardsSince(mk113b).filter((c) => c.op === 'create')
    .find((c) => JSON.stringify(c.payload).indexOf('fs_form') >= 0)
  ok(Boolean(formCard113),
    '★★（对照）私聊里审批单**照常出卡**（闸只挡非确认私聊，不是一刀切）')
  ok(Boolean(formCard113) && Boolean(formCard113.payload.config)
    && formCard113.payload.config.update_multi === true,
    '★★ 审批单卡出口自证：config.update_multi=true（本格在 112 总闸之后运行）')

  // ③ 能力闸：capabilityGuard 开着，ou_test 表里**没有** approval 授权 ⇒ 点「采纳」必须被拦、
  //    留 DENY 痕（src=card:fs_form）、单子**不结算**（旧字节 fs_form 口没接闸 ⇒ 直通 ⇒ 必红）。
  if (formCard113) {
    const btn113 = allButtons(formCard113).map((b) => b.value)
      .find((v) => v && v.fs_form !== undefined)
    ok(Boolean(btn113), '（前提）审批单卡按钮带 fs_form token')
    const log113c = consoleLines.length
    if (btn113) {
      await tapValue(btn113, { open_id: 'ou_test', union_id: 'on_test113', user_id: '' },
        CHAT_ID, formCard113.msgId)
      await drain()
    }
    ok(consoleLines.slice(log113c).some((l) => l.indexOf('capability DENY(no_grant)') >= 0
      && l.indexOf('cap=approval') >= 0 && l.indexOf('src=card:fs_form') >= 0),
      '★★★ 无 approval 授权的人点审批单「采纳」被能力闸拦下并留痕（与 fs_approval 同口径）')
    ok(!consoleLines.slice(log113c).some((l) => l.indexOf('approval form decided') >= 0),
      '★★★ 被拦的点击**没有**把单子结算掉（拦截=不作答，不能一边拦一边生效）')
  }
  // 收尾：能力闸下这张单注定没人能点 ⇒ abort 掉，不留 30 分钟悬单（reject 已同拍接住）。
  // 🔴 第三十四轮门槛 LOW#4（核对为真）：两个分支尾部完全相同 ⇒ 上提一处，不留复制。
  ac113.abort()
  await settle(2)
  liveAgents.length = 0
}

// 🔴 中台 #61/#62（第三十五轮）：托孤双 60 秒对撞原来让「这张卡补送到不到」听天由命
//   （sentCards 汇总因此 ±1 抖动，闸门 T/U 的 507/506 差的就是这张卡）。
//   index.js 改成「退避结束后再给一个完整 TTL」后，这张卡**必然落终态**——
//   收尾判定据：①不在队列里悬着；②送达痕与丢弃痕互斥（同时出现＝接力逻辑打架）。
//   注：本条是**可判定性钉**（旧字节大概率也绿，因为两支痕本就互斥），
//   真反证靠红单数的 ±1 消失——闸门定版比对 sentCards 复现性。
{
  // 🔴 第四十轮门槛 LOW#3（核对为真）：下面两钉全从 globalThis.__fsCardRelay 取值——全局一旦
  //   改名/消失，`(globalThis.__fsCardRelay || [])` 得空数组 ⇒ relay84=false、首钉**照样绿**，
  //   判定无声退化成恒真。先钉"队列全局在位且是数组"，改名漂移当场变红而不是装过。
  ok(relayTok84 === '' || Array.isArray(globalThis.__fsCardRelay),
    '★★ 中台#62 判据前提：接力队列全局 __fsCardRelay 在位（改名/摘除＝本退路钉当场红，不许无声退化）')
  const relay84 = (globalThis.__fsCardRelay || []).some((it) =>
    String((it && it.card && it.card.token) || '').slice(-8) === relayTok84 && relayTok84 !== '')
  ok(relayTok84 !== '' && !relay84, '★★ 中台#62：用例 84 的托孤卡收尾已落终态（不悬在接力队列里）'
    + (relayTok84 === '' ? '｜前提没拿到 token ⇒ 本条如实变红不装过' : ''))
  const dl84 = consoleLines.filter((l) => l.indexOf('relayed card push delivered') >= 0
    && relayTok84 !== '' && l.indexOf('card=' + relayTok84) >= 0).length
  const dr84 = consoleLines.filter((l) => l.indexOf('relayed card push dropped') >= 0
    && relayTok84 !== '' && l.indexOf('card=' + relayTok84) >= 0).length
  ok(relayTok84 === '' || dl84 + dr84 <= 1,
    '★★ 中台#62：这张卡的补送痕/丢弃痕至多一条（互斥，实得 delivered=' + dl84 + ' dropped=' + dr84 + '）'
    + (relayTok84 === '' ? '｜84 前提已红（没拿到 token），本条不级联误伤' : ''))
}

if (failures === 0) {
  console.log('SMOKE PASS (sentCards=' + sentCards.length + ', sessions=' + createdSessions + ')')
  process.exit(0)
} else {
  console.log('SMOKE FAIL: ' + failures + ' assertion(s) failed')
  process.exit(1)
}