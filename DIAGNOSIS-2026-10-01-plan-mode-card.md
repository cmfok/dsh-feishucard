# 诊断：计划模式启动「不建卡」+ 计划审批「不到飞书」+「跳新会话」+「结论卡被截断」（2026-10-01）

> 报障人：CM（飞书）。现象四条，全部已定位到代码级根因，证据附行号。
> 状态：**已修复并验证**（v0.4.15）—— 见文末「七、落地记录」。

## 〇、CM 四条报障原话

1. 「我发了这个计划模式的启动给你，其实我看到你在思考，在做事情，但是我飞书上没有看到卡片」
2. 「我发上一段话给你的时候，它就自动建了卡片了……要我真的再发一条信息给你，才能创建卡片。
   但是在我发第二条信息给你之前的所有，你的所有动作和思考，我都已经看不到了。」
3. 「你现在发这计划，我在电脑端上看到你的计划是发了，但是我在飞书上也是没有收到的」
   「然后还直接跳到了一个新会话」
4. 「你的正式回复又被截断了，然后结论卡片只有这一句话，其他都进了你的过程卡片」

## 一、事故时间线（会话 `fs-main-mupoeiy4`）

| 会话 seq | 事件 | 说明 |
|---|---|---|
| 721 | `command/run` name=plan, args=` 检查计划模式，目标模式，所有卡片是否正常` | CM 发的是 **`/plan <正文>`** |
| 722 | `plan/mode {active:true}` | harness 开了计划模式 |
| 723/724 | `agent/inbox/spliced` | plan-mode 插件塞入 2 条：切换通知 + **CM 的正文** |
| 725 | `turn/start turn=9` | **harness 起了一个真回合**（正文被当用户消息） |
| 727 | `command/done` → `Plan mode on. Use /plan off to leave.` | 命令返回 |
| 730–838 | turn 9 共 **16 步**（体检 + 写审计脚本 + 读插件源码） | 这 16 步**没有任何卡片持有** |
| 831 | `tool/call exit_plan_mode`（带完整计划 markdown） | 提计划 |
| 832 | tool/result → `The user chose to keep planning; revise the plan and present it again.` | 审批被判「继续修改」，整轮作废 |
| 838/847 | `turn/end turn=9 / turn=10`，原因均为 `aborted(user)` | 两次被用户中断 |
| — | 插件判定「无输出」→ 自愈重建会话 `fs-main-muppqw21` | 即 CM 看到的「跳到新会话」 |

## 二、根因（三条）

### 根因 ① `/plan <正文>` 走命令通道，**在建卡之前就 return**

- 源码：`index.js:1886-1895`
  ```js
  const cmd = splitCommand(text)
  if (cmd) {
    const handled = await handleCommand(bot, chat, chatId, cmd)...
    if (handled) return            // ← 建卡在 return 之后，永远到不了
  }
  ```
- `/plan` 分支：`index.js:1541-1583`。`commands.execute(agent, '/plan <arg>', [], signal)` 返回
  `{result:{text:'Plan mode on. …'}}` → `sendPlainText(...)` → `return true`。
- 关键：`commands.execute` **不只是切开关**，它把 `args` 当用户消息**起了一个完整回合**
  （会话 seq 723-725 实证）。命令通道只发一句纯文本回执就收工 ⇒ **回合没人持卡**。
- 为何第二条消息才建卡：新卡 `card.cursor = seqBefore`（`index.js:1997`）＝建卡那一刻的事件位置
  ⇒ 建卡之前的 16 步**永久不可见**（与 CM 描述完全一致）。

### 根因 ② 计划审批水位线被 **GUI 桥接抢先**，插件监听排在其后

- `exit_plan_mode` 调 `ctx.userQuestions.ask()`（`dsh-plan-mode/lib/index.js:261`）
  → 派发 `user-questions/request` 水位线（`dsh-user-questions/lib/index.js:69`）。
- 该事件**同时**被 GUI 转发：`dsh-api-remotes/lib/index.js:17-25` 把它列入
  `API_REMOTE_FORWARDED_EVENTS`（mode=`waterfall`）；L117-127 注册转发监听，
  L187-204 `forwardWaterfall()` —— **只有远端不接时才 `next()`**：
  ```js
  resolve: (outcome) => {
    if (outcome.kind === "result") { settled.resolve(outcome.value); return }
    Promise.resolve().then(next).then(settled.resolve, settled.reject)
  }
  ```
- 插件监听挂在**根 ctx**（`index.js:3368`）⇒ 排在转发桥接**之后** ⇒ 浏览器一答就没它的事。
- **日志实证**：本实例窗口（`web.log` L65931 起）`[fs] user-questions/request` 出现 **0 次**
  ⇒ 监听自 apply #12（23:39:35）挂上后**从未被触发过**。
- 交叉印证：第二次现场 `exit_plan_mode` 只到电脑端、飞书零字节；且返回 "keep planning"。
- ⚠️ 待一次现场验证的环节：当次浏览器客户端是否处于已连接状态（连接态下才会被抢答）。

### 根因 ③ 消息排队 + 跳新会话

- 排队：`index.js:2417` `bot.chain = bot.chain.then(() => handleInbound(...))`
  —— 上一条还在跑，这一条**必须等**；投递目标又写死 `next-turn`（`index.js:2056`）
  ⇒ 只能等本轮结束才进会话（会话 seq 769 `target:"next-turn"` 实证）。
- 跳新会话：`index.js:2208-2240` 自愈逻辑 —— `!hadOutput && sessionReused` ⇒ 丢弃旧会话、
  新建 `fs-main-<ts>` 重试。本次因 turn 9/10 均 `aborted(user)` 无 assistant 输出而命中
  （日志 L67559 / L67590）。

## 三、修复方案（待批准）

1. **`/plan <正文>` 与普通消息同构**：建卡 → 等回合 → 封口。
   要点：`activeTurns` 必须在 `commands.execute()` **之前**登记（避免 `agent/status` 另开自动卡）；
   `card.cursor` 取 execute 之前的事件位置；正文已由 harness 投递，**不得再 `send()` 一次**（否则重复）。
2. **水位线监听下沉到 agent scope**：`agent.ctx.on('user-questions/request', …)`
   —— 同 scope 内先于根级桥接执行；非飞书 agent 一律 `next()`（保持现有策略）。
   需幂等注册 + 随会话处置注销。
3. **回合中插话（steer）**：`activeTurns.has(agent.id)` 时按 `next-step` 投递并镜像进当前卡，
   而不是排在 `bot.chain` 后面等 `next-turn`。（风险最高，涉打断语义。）

**风险提示（必须遵守）**：profile 的 `node_modules/dsh-feishucard` 是**指向源码的链接/junction**
（`sync` 体检已正确拒绝覆盖），保存 `index.js` 即触发 **HMR 热重载**；
日志实证 11 次：**重载会把当时在跑的回合就地封口**，且插件 apply 会把活跃 goal 置为「停用续行」。
⇒ **改动必须在不跑任何回合时进行**。

## 四、根因 ④ 结论卡只剩最后一句（2026-10-01 追加报障）

**证据**：`web.log` 封口行
`turn sealed: … reply_len=40 card=om_x100b64dc6c96c0a0b278ad9cef8c3d7 blocks=34
reply="等待你拍板前我不动代码（插件现在是"保存即热重载"，改前必须确保没有回合在跑）。"`
→ `conclusion split … reply_len=40` → `conclusion card opened: card=om_x100b64dc7ed938acb3faf09e5c3f96f`
（正文 34 个块全部留在过程卡上）。

**根因**：封口时把「**最后一条** `assistant/message` 文本」当结论（`index.js` seal 段）。
而 agent 的真实回复形态常常是「正文 → 工具调用（如 `present`）→ 一句收尾」
⇒ **收尾句顶替了整段答复**；真正的正文只剩过程卡上的 note，而 note 还被
`MAX_NOTE_CHARS = 500` 截断 ⇒ 内容实质丢失。

**修法（结构性判据，不用长度阈值）**：从末尾往前收集 assistant 文本 ——
① 遇到**纯目的行旁白**（全部非空行以 🎯 开头）即停；
② **连续两段文本之间没有工具调用 ⇒ 只取最后那段**（同一段叙述的多次快照，绝不拼起来）；
③ **中间隔着工具调用 ⇒ 允许再取上一段**（正是「正文 → present → 收尾」的形态）；
④ 同一 seq 只收一次；⑤ 整轮只有旁白 ⇒ **不拆结论卡**（消灭无信息卡）。

## 五、事故：一次改动让**所有飞书消息被静默吞掉**（2026-10-01 深夜，当场修复）

- **现象**：CM 报「所有飞书信息你收不到」；真机日志 `duplicate inbound skipped` 连发（4 条被吞）。
- **根因**：为修 ③ 新加的 `steerActiveTurn` **第一句**就调 `isDuplicateInbound()` ——
  它**有副作用**（把 id 记进 `seenInboundIds`）。一旦 steer 没走成（没有活跃回合／agent 无
  `steer`）函数 `return false`，落到 `handleInbound` 时再查一次 ⇒ 已「见过」⇒ 判重投丢掉。
- **修法**：新增只读的 `inboundAlreadySeen()`；`steerActiveTurn` 只**窥探**，
  **仅当 steer 真的投出去之后**才认领 `message_id`。
- **教训**：**「查重」必须与「认领」分离** —— 带副作用的判断函数不能用在"可能还要回退"的分支上。

## 六、待验证 / 未决

- [x] 现场确认根因 ②：**第二轮已证伪**「下沉到 agent scope 就能抢先」的假设 ——
  2026-10-02 00:4x 真机复现，日志只有注册行、没有任何接管行，
  harness 侧收到 `The user dismissed the plan review to speak instead`
  ⇒ 该水位线被 GUI **整条吃掉**。**最终改走 `tools/execute` 拦 `exit_plan_mode`**（已上线）。
- [x] **真机复验已通过（2026-10-02 01:0x）**：飞书弹出「📋 计划已写好，等你批准」，
  日志 `[fs] exit_plan_mode intercepted for fs-main-muppqw21 plan_len=1988`
  → `question card sent: plan-review`；CM 回「看到卡片了」。**根因②彻底解决。**
- [x] 插话换新卡真机复验：两次 `card created … elements=5`（hr＋彩色块＋hr＋…），
  旧卡留「📨 你的消息已插话送达 —— 后续内容见下方新卡。」。
- [x] smoke 覆盖缺口：`/plan` happy path 已补**用例 43**；入站不被吞**用例 44**；
  工具层接管**用例 45**；插话换新卡**用例 46**。

## 六·补、第三轮真机抓出的两个新缺陷（均已修）

**D1a｜「批准」并没有真的退出计划模式**
- 真机日志：`plan approved on Feishu … exit=unavailable(planMode 服务未注入)`
  ⇒ `ctx.inject(['planMode'])` 在本环境**从不触发**（profile bundle 跨 scope），
  `planModeRef` 恒为 `null`；所谓退出只是**我口头告诉模型**，会话里没有 `plan/mode` 事件
  ⇒ 下一轮系统提示仍写「You are in plan mode」，等于把模型骗了。
- 修法：改走**命令注册表** `/plan off`（与 `/plan` 命令同一条已验证通道）。
  日志特征：`exit via /plan off: Plan mode off.`。

**D1b｜「继续修改」让 harness 抛异常**
- 真机拿到的是 `Error: tool result must be losslessly JSON-serializable`。
- 根因：`dsh-tools` 的 `materializeFinalResult()` 在 `isError===true` 时**无条件**写
  `error: result.error`；我们没给 ⇒ `undefined` ⇒ `dsh-util-values` 的 `walkJsonValue()`
  对 `typeof !== 'object'` 判「不可序列化」⇒ 抛错。
- 修法：改成 `throw`（与 `dsh-plan-mode` 自己的 `execute` 同路）。
- **测试坑**：抛错后必须在 `emitCtx` **同一拍**接住，否则 unhandled rejection 会把 smoke 打挂。

**D2｜文字回答后问题卡不更新**
- 真机：`question answered via chat` 之后按钮仍可点，点了报
  `question button: record not found for chat …`（CM：卡片弹出时他正好在发消息）。
- 修法：新增 `finalizeQuestionCard()`，两条文字回答路径都调用，
  就地改成「✅ 已收到」态并登记 `recentQuestions`。

## 七、落地记录（全部为**单次落盘**，避免反复热重载）

| 次序 | 文件 | 改动 | 证据 |
|---|---|---|---|
| 1 | `index.js` | ① `/plan <正文>` 建卡（事件入口交接 turnStarted + `skipSend`）② 水位线挂 agent scope ③ `steerActiveTurn` ④ 结论收集规则 | 补丁脚本 17 处锚点**精确匹配**（`--dry-run` 先验） |
| 2 | `index.js` | 事故修复：查重与认领分离 | `duplicate inbound skipped` 清零 |
| 3 | `index.js` | ④ 收紧：跨工具调用才延伸（修 smoke 7/12 回归） | `SMOKE PASS` |
| 4 | `index.js` | ① 补真实入口（事件入口的命令分支） | `SMOKE PASS` |
| 5 | `scripts/smoke.mjs` | 新增用例 43 / 44 | `SMOKE PASS (sentCards=167, sessions=6)` |
| 6 | `index.js` | 第二轮：`notice` 块渲染（彩色底块）＋ `split(notice)` 换新卡 ＋ **工具层拦 `exit_plan_mode`** | 8 处锚点精确匹配 → `SMOKE PASS` |
| 7 | `index.js` | `activeTurns` 改按「该会话绑定的 agent」查（session id 兜底） | `SMOKE PASS` |
| 8 | `scripts/smoke.mjs` | 补 `planMode` 注入 ＋ 新增用例 45 / 46 | `SMOKE PASS (sentCards=177, sessions=7)` |
| 9 | `index.js` | 第三轮：退出改走 `/plan off`（D1a）＋「继续修改」改抛错（D1b）＋ `finalizeQuestionCard`（D2） | 5 处锚点精确匹配 → `SMOKE PASS` |
| 10 | `scripts/smoke.mjs` | 用例 45 重写（批准走 `/plan off`；继续修改**必须抛错**；同一拍接异常） | `SMOKE PASS (sentCards=182, sessions=7)` |

**线上版本**：`plugin apply #19 v0.4.14 md5=36130971 bytes=227731`（= 源码哈希一致）；
profile 的 `node_modules/dsh-feishucard` **是指向源码的链接** ⇒ 保存即 HMR 热重载
（`~/.dsh/AGENTS.md` ①「HMR 不生效、必须 sync」一条**已过时**，与实机不符）。
**备份链**：`index.js.bak-*-pre-plancard-fix` / `-pre-steer-dedupe-fix` /
`-pre-conclusion-rule` / `-pre-event-command-hold` / `-pre-plan-tool-and-steer-card` /
`-pre-plan-exit-and-question-card`。

