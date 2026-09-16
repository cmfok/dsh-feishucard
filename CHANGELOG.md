# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added（2026-09-16，CM 需求：飞书里"切换会话/工作区"）

CM 原话：「能不能在飞书里面做一个"切换会话"的命令？① 我打一个命令 ② 它能展示目前可切换的
一些会话或者工作区 ③ 然后我切换过去」。方案经 CM 拍板（"先按你的来"）。

- **无参数 `/switch`** → 一张卡片，分三组列出候选，**每行两个按钮**：
  ① 本聊天的会话（现有 `chat.sessions`，当前项标 ▶）② 本工作区的其它会话（含 GUI 里开的）
  ③ 其它工作区（`P:\fu`、`Ai100` …）。卡面顶部常驻「当前会话 + 工作目录」，并写明图例
  「🟢 空闲（可接管）｜🟡 运行中（只给"新建"）」。
- **序号连续编号，从本聊天会话开始** → 老语义 `/switch 1`（主会话）不变；
  文本兜底 `/switch <序号>`（接管）、`/switch <序号> new`（在该工作区新建）。
- **数据来源**：`ctx.get('sessionPersistence').list()`（`SessionHeader`：id/cwd/createdAt/origin）
  —— 过滤子代理子会话（`origin === 'subagent'` 或 `delegationDepth > 0`），按 `locate()` + `stat`
  的 mtime 倒序（比 createdAt 更接近"最近动过"）；**已在本聊天的会话会被去重**。
- **会话名**：DSH 的 `SessionHeader` 没有标题字段，所以显示优先级为
  ① 活着的会话 → 内存里最后一条 `session/title` 事件；② 否则首条用户消息摘要
  （`readFrom(id, 0)`，且**只对 < 4MB 的日志读**、1.5s 超时、并行执行 —— 绝不为列个表去解析几百 MB 历史）；
  ③ 都没有才退回短 id。
- **两条安全约束（都写进卡面，不让 CM 猜）**：
  - **正在别处运行的会话（🟡）不给"接管"** —— DSH 里同一会话被两处同时驱动会写坏历史；
    卡片只给"新建"，文字路径也会明确挡下并说明原因。
  - **"新建"不碰任何旧会话**：只是在该工作区开一个全新会话（`createDedicated(bot, id, cwd)` 新增
    cwd 参数，cwd = 那个工作区）。
- 卡片回调：`handleCardAction` 新增 `fs_switch` 分支（复用既有 `card.action.trigger` 长连接通道），
  卡片 15 分钟过期后点击会明确告知"卡片已过期，请重新 /switch"（不静默）。
- `/help` 文案同步更新。
- **测试**（`scripts/smoke.mjs` 用例 15）：mock 增加假 `sessionPersistence`（`list`/`locate`/`readFrom`）
  与 `agents.list()`。覆盖：三组标题齐全、短 id、**首条消息摘要**、子代理子会话被排除、
  行数正好（不去重就会多一行）、序号可读、"接管"按钮 → 走**真实卡片回调路径**真的 resume 了会话、
  `/switch <n> new` 把新会话 cwd 设成目标工作区、🟡 标记 + 只给"新建" + 文字接管被挡下。

### Added（2026-09-16，CM 要求：飞书里直接开目标模式 —— `/goal` 命令）

原来飞书里打 `/goal` 不生效：桥的命令白名单 `COMMANDS = ['help','new','switch','list','plan','stop']`
不含 `goal`，`resolveCommandName()` 返回 undefined → 整条消息被当普通话转给模型。

- `COMMANDS` 增加 `goal`；新增 `goal` 分支，**走与 `/plan` 同一条命令通道**
  （`ctx.get('commands').execute(agent, '/goal …', signal)`）→ `command-goal` 插件正确处理
  ` <目标> ` / 无参数（查看状态）/ `pause` / `resume` / `clear` / `edit <新目标>`。
- **兜底**：命令注册表不可用（`execute` 返回 undefined 或抛错）时直连 `ctx.get('goals').create(agent, { objective })`
  创建目标；子命令在这种状态下**不猜测**，只回用法（避免把 `pause` 误建成目标）。
- 目标刚创建/恢复时补一句中文提示（`normalizeGoalReply` + `GOAL_START_HINT`）：
  「接下来每轮都会在这张聊天里开卡更新」；命令输出正文仍用 harness 原文（不翻译引擎输出）。
- `/help` 文案同步补 `/goal`。
- **测试**（`scripts/smoke.mjs` 用例 14）：mock 增加假 `goals` / `commands` 服务，覆盖
  ① 注册表未接管 → 走 `goals` 兜底且 objective 原样传递；② `/goal` 不被丢给模型（模型零接收）；
  ③ 注册表可用时 `/goal pause` 与无参数 `/goal` 都透传、返回原样回飞书、暂停时不补启动提示；
  ④ 子命令在兜底态**不会**被误建成新目标，且给出用法（不静默失败）。

### Added（2026-09-16，CM 拍板方案 A：目标模式的**工作过程**也发到飞书）

CM 原话诉求：「你处在目标模式的时候，我在飞书上也能看到你工作的过程。」
盘点发现：目标模式续轮由 `@deepseek-ai/dsh-goal-round-driver` 以**同会话**方式注入一条
`user/message`（`source.kind === 'goal'`、带 `round` 号、正文是 `<goal_round>` 提示词）驱动，
**不经过飞书入站**；而本插件的建卡入口 `runTurn` 只从飞书入站消息调用
→ 目标轮根本**没有卡承接**（不是没发，是没通道）。

- 新增 `agent/status` 订阅（DSH 侧 emit 处：`packages/core/agent-loop/src/agent.ts`）：
  - `running` + 该 agent 属于某个飞书聊天 + 当前无活跃卡（`activeTurns` 不占用）+ 本轮触发消息是
    **goal 轮** → 建卡「🎯 目标模式 · 第 N 轮开始，正在工作…」，复用**与普通回合完全同一套**
    `startCardWatcher` / `syncCard` → 过程话语内联、工具折叠面板、诚实状态行、表格换卡全部照旧生效。
  - `idle` → 停 watcher、封卡、写「✅ 本轮结束」。
  - 卡游标 = 建卡时的会话事件长度 → **goal 提示词本身不搬上卡**（只镜像本轮后续事件）。
- `currentRoundIsGoal(agent)`：倒序找会话里**最后一条** `user/message`，看 `source.kind === 'goal'`。
- `openGoalCard()` 自带换卡闭包 `rotate()`：满 5 张表 → 旧卡封住、新卡游标接续（与 `rotateTables()` 同机制）。
- 噪声控制（CM 拍板口径）：**只报目标轮**，其它自动回合（插件上下文、子代理等）一律不自动建卡。
- 开关：环境变量 `DSH_FEISHU_GOAL_CARDS=0` 全局关；per-bot 配置 `notifyGoalRounds: false` 单独关
  （`normalizeConfig` 已接受该字段）。

**测试**（`scripts/smoke.mjs`，新增用例 13 / 13b；smoke mock 的 `ctx.on` 从"记录但不触发"
升级为**可 emit**，否则新钩子无法回归）：
- 13：goal 轮建卡 ×1、卡面写出轮次、`<goal_round>` 提示词不上卡、过程话语 + 工具面板进卡、
  idle 封口写「本轮结束」、**非 goal 自动回合不建卡**。
- 13b（新功能 × 既有换卡机制的组合验证）：goal 卡满 5 张表 → 换新卡、第 6 张表保持 markdown
  **不被降级**、封口落在新卡上（游标接续不断链）。
- 已知非缺陷：换卡后 ≤400ms 内普通同步会被 `CARD_MIN_INTERVAL` 限流跳过，待写内容在下一次
  强制同步（下一事件 / 封口）刷出 —— 用例 13b 据此断言"封口时的最终形态"，不依赖真实计时。

### Changed（2026-09-16，CM 拍板：审批**默认关闭**）

CM 原话：「正常来说 dsh 就不用我审批，现在为什么还需要点审批呢？连推送个仓库都要我审批。」
盘点结论：**唯一还会弹审批的就是本插件加的飞书审批拦截器**（审计哨兵已关、DSH 权限已是
`danger-full-access`），它当时默认开启（`?? '1'`）→ `git push` 等联网命令都会触发。

- **`APPROVAL_ON_FEISHU` 默认由「开」改为「关」**：`String(process.env.DSH_FEISHU_APPROVAL ?? '0') === '1'`
  —— 默认**不拦截、不审批**；要恢复审批：设 `DSH_FEISHU_APPROVAL=1`。
- **这是默认行为，不许被改回去**（除非 CM 明确要求）。审批相关的"不变量"与协作规矩见 README/项目档案。
- 审计哨兵 `sentinelEnabled: false` 保持不变（它另走主程序审批界面 → 只在电脑上，飞书看不到）。

**验证**（重启后实测）：`bridge active` ×1、`长连接 ready` ×2、收到真实消息并跑了工具，
而 `approval needed (pre-execute)` = **0**、`approval card sent` = **0** → 确认不再弹审批。

### Fixed（2026-09-16，CM 反馈「卡片隔很久才回 + 中间步骤看不到 + 表格只显示 | 符号」）

**根因①（主凶）：`toolArgSummary()` 每次调用必抛 `ReferenceError: cmd is not defined`**
- 现象：日志 `card watcher error: cmd is not defined` ×240+、`handler error: ReferenceError`。
  卡片更新链每轮崩 → 插件退化成**最后一条纯文本回复**（纯文本不渲染 markdown）
  → CM 看到的就是「隔好久才回、中间步骤全无、表格变回原始 `|`」三合一。
- 成因：有人把 `approvalReasonFor` 里的「联网/外发命令」判断**误抄**进本函数（那里的 `cmd`
  有定义，这里没有），且**同时删掉了 `const joined = picks.join(...)...` 一行** → `picks` 收集完没人用。
- 修法：**按 git 历史（`5c800e5` 等提交）还原为已知正确实现**，不靠猜。职责不重复
  （"联网/外发命令"提示本来就在 `approvalReasonFor`）。

**根因②：表格超限的处理方式不对（CM 拍板：换卡，不是降级）**
- 飞书单卡硬上限 5 张表（实测 `ErrCode 11310 / card table number over limit`）。
- 一度改成"降级为可读清单"，**CM 否决**：「我就喜欢看表格。那你是不是应该去想，能不能超限了以后就换发一张新卡呀？
  然后新的内容就在新卡更新，旧的内容就保留在旧卡呀」—— 采纳。
- 实现：
  - 新增 `cardTableCount(card)` —— 数本卡 `message` + `note` 两种块的 markdown 表格数。
    ⚠️ **只数 `message` 会永远不触发**：agent 过程话语走 `appendNote` 存成 `type: 'note'`，
    只有最终回复才被提升成 `message`（实测：用例 12 一度 create 次数停在 1）。
  - `startCardWatcher(..., onTableBudget)` 增加额度检查：**本卡满 5 张且仍有待镜像事件**时先换卡。
    检查必须在扫描**之前** —— 否则内容已写进旧卡，换卡就晚了。
  - 新增 turn 级 `rotateTables()`：封旧卡 → 建新卡 → **新卡游标 = 旧卡当前游标**
    （与答题专用 `split()` 的唯一差别：`split()` 把游标设到事件末尾，会跳过待处理事件）。
    新卡带一行说明「📊 上一张卡的表格已满（飞书单卡最多 5 张），后续内容在这张新卡继续。」
  - `split()` 重建 watcher 时同样传入 `rotateTables`，保证答题拆卡后换卡能力不丢。
- **降级降级为兜底**：单条消息内一次就来 >5 张表时换卡救不了，仍走 `demoteTableToLines()` 清单
  （新增 `splitTableRow()`；比原来的代码块可读，也不再出现原始竖线，内容一字符不丢）。

**根因④（排查中发现，一并修）：过程话语截断把表格切断**
- `appendNote` 原实现 `slice(0, MAX_NOTE_CHARS) + '…'`（500 字符）—— 截断点落在表格中间时，
  可能只剩表头没有分隔行 → 飞书判定不是表格 → **原样显示竖线**（CM 现象之一）。
- 修法：新增 `clipNoteText()` —— 先退到整行边界；若末尾仍停留在表格行，把**不完整的表格整块丢弃**，
  绝不留半张表。短文本行为不变。

**根因③：审批正则过宽，误伤自家只读命令**
- `EGRESS_CMD_RE` 尾部 `nc ` 只有**两个字母加一个空格**，多行命令拼接后极易误命中；
  实测把一条纯读日志的命令判成「联网/外发命令」并弹审批，CM 未及时点 → **命令直接被拒**。
- 修法：全部加 `\b` 词边界；`nc` 要求 `\bnc\s+-`（真实 netcat 形式）；补 `socat`/`telnet`/
  `Test-NetConnection` 等真实外发命令。

**测试**
- `scripts/test-fold-tables.mjs`：`[tables]` 组重写（不再用代码块／清单可读／降级有说明／畸形表格不丢内容／空数组安全）；
  新增 `[clip]` 组 4 条断言（短文本原样／有省略号／**不留半张表**／未超长不受影响） → **ALL PASS**。
  ⚠️ 该测试用 `grab()` 从 `index.js` 抽函数，**新增函数必须同步加进 `grab()` 列表**，
  否则 `new Function` 里 `ReferenceError`（本次已踩两次：`demoteTableToLines`、`clipNoteText`）。
- `scripts/smoke.mjs`：新增用例 11（降级兜底 4 条）+ 用例 12（**换卡 5 条**：新建第二张卡／带换卡说明／
  第 6 张表保持表格／未被降级／旧卡已承载 1~5 张表） → **SMOKE PASS**。

**⚠️ 生效条件**：插件代码是**启动时加载**的；本次实测 `cordis-plugin-hmr` **未自动重载**
（用"只在新正则下才放行"的探针命令验证：仍被旧正则拦下）→ 需重启 dsh web 才生效。

### Fixed（2026-09-16，状态行真实性 —— 与 Hermes 侧同步）

起因：CM 反馈 Hermes 卡片末行「回复中/已完成」不真实，追问「Dsh呢？」→ 按兄弟项目规则对照审计 DSH。
**审计结果**：
- ⚠️ **`completed` 是死状态**：全文件**从未**给 `status` 赋 `completed` → 渲染里的「已完成」分支永不执行；
- ⚠️ **封口时状态行被直接删掉**（`if (card.status !== 'sealed')`）→ 回合结束后用户看不出"这轮结束了没有"；
- ⚠️ **没有"无新动作"提示** → agent 卡住时永远显示 `_运行中…_`（= CM 说的症状①）；
- ✅ **封口时机本来就是对的**：DSH 是**回合真结束时**才 seal（走 `whenIdle`），不是计时器猜 —— 这点优于
  Hermes 原来的实现（Hermes 用 8 秒静默猜，已改）。

**修法**：
- 新增纯函数 `statusTextFor(card)`（便于离线断言）：`sealed → _✅ 已完成_`、
  `error → _失败_`、**长时间无新事件 → `_运行中…（已 N 分钟无新动作）_`**（诚实，不宣称完成）。
- 状态行渲染改用它 → **封口后也显示「✅ 已完成」**（不再删掉）。
- `makeCardState()` 增加 `lastEventAt` / `idleMinutes`；watcher 里：有新事件 → 记录并清零空闲；
  无新事件且仍在 running → 每满 1 分钟更新一次空闲提示（变化才同步，避免刷 PATCH）。
  阈值 `DSH_IDLE_NOTICE_MIN = 3` 分钟。

**测试**：`scripts/test-fold-tables.mjs` 新增 `[status]` 组 6 项断言
（进行中 / 久无动静 / 封口必须显示已完成 / completed 分支 / 失败 / 空闲不宣称完成）→ `ALL PASS`；
既有 `smoke.mjs` 仍 `SMOKE PASS`。
> 注：写测试时又踩了一次"假保险丝"—— 断言最初被追加在 `process.exit()` **之后** → 永不执行。
> 已移到汇总之前，确认真的在跑（Hermes 侧同一天也犯过同类错，见 [[开发标准]] §10.2）。

**部署**：分发到运行时副本（源=副本逐字节一致）→ 空闲 140 分钟确认无腰斩风险 →
走正规重启脚本（读 key 启动器）→ `restart done, web is up`、`plugin apply`、
`helper spawned ×2`、`long connection ready ×2` 全部确认。

### Fixed（2026-09-16，与 Hermes 侧同步的两个同类缺陷）

从 Hermes 的飞书卡片项目（`output/hermes-feishu-card`）交叉审计后同步修复 —— 同一类机制，
Hermes 侧踩过的坑 DSH 这边也有一份：

- **折叠会静默丢弃内容（旧消息被吞）**：`buildCardPayload()` 把"更早过程"折进一个面板后，
  用 `extraLines.join('

').slice(0, 3000)` **把正文硬砍到 3000 字、其余直接丢弃**。
  而 DSH 的卡片**没有容量上限**（没有 Hermes 那种换卡），会长到远超 3000 字
  → 中间那一大段历史被删掉，用户看到"旧消息被吞"。
  （Hermes 侧同款 bug 实测：50 个元素折叠后丢 **57%** 内容、28/50 段消失。）
  **修法**：改为按 `FOLD_CHUNK_CHARS` 切成**多块面板**（新增 `chunkText()`，按段落切、
  单段超长硬切，**一个字符都不丢**）；多块时标题显示 `📎 更早过程 (i/N)`。

- **完全没有表格数量防护**：飞书单卡最多 5 张表（《表格组件》官方文档），
  超出报 `ErrCode 11310 / card table number over limit`，**整张卡被拒**。
  Hermes 侧 2026-09-15 实测单日 22 次 11310 全部来自这一条；DSH 此前 0 处表格处理。
  **修法**：新增 `countMarkdownTables()` / `demoteOverflowTables()` —— 单卡第 6 张起的表格
  **改成 ``` 代码块**（内容一个字符不丢，只是那几张不再按表格样式渲染）。
  为什么不是折叠：**折叠降低不了表格数**（折叠只是把同样的文本挪进面板），只能改渲染方式。
  为什么不是换卡：DSH 无容量换卡机制，这条改动保持最小。

- **`countMarkdownTables` 必须跳过 ``` 代码块**：代码块里的 `| a | b |` 是普通文本，
  飞书不算表格组件。否则"把超限表格降级成代码块"会被自己重新数进去、降级永不生效
  （**这个 bug 是写测试时当场抓到的**：8 张表降级后仍数出 8 张）。

### Tests

- 新增 `scripts/test-fold-tables.mjs`（离线纯函数级，11 项断言，无需飞书凭据）：
  折叠切成多块 / 每块 ≤ 单元素上限 / **50 段一段都没丢** / 无「已省略」丢弃标记 /
  8 张表降级后恰好 5 张 / 超出部分变代码块 / **内容一个字符都没丢** /
  代码块里的表格不再被计入 / 未超限时原样返回。
  跑法：`node scripts/test-fold-tables.mjs`（`ALL PASS` = 通过）。
- 既有 `scripts/smoke.mjs` 全绿（`SMOKE PASS`，sentCards=13，无回归）。

### Deploy / Notes

- **DSH 的加载方式是 HMR 直接监听项目目录**（启动日志 `hmr watching [ '<项目目录>' ]`），
  不是 `~/.dsh/profiles/web/node_modules/dsh-feishucard` 副本；副本已同步保持一致以防万一。
- 重启必须走**读环境变量注入 key 的启动器**（`output/dsh-install/restart-dsh-web.cmd`
  → `start-dsh-web.cmd`）。**裸 `node` 启动会没有 `DEEPSEEK_API_KEY` → 所有回复空白**
  （2026-09-08 踩过，详见教训 006/007）。本次重启走正规脚本，日志
  `%TEMP%\dsh-restart.log` 显示 `restart done, web is up`，启动日志
  `[fs] plugin apply` + `long connection ready` 齐全。

### Fixed

- **「两张卡片、内容重复」的真正根因：agent 自己调用了 `feishu_send`（2026-09-15 查实际对话定位）**。
  证据（解压会话事件）：`seq=66336 tool/call name=feishu_send args={"text": "像，但不是一回事…"}`
  紧接着 `seq=66986 assistant/message "**像，但不是一回事…**"` —— **同一段回复**先被 agent 主动发了一条
  普通消息（`sendPlainText`，1.0 结构卡），随后又作为最终回复进了流式卡（JSON 2.0）。
  用户侧就是"两张卡片、内容大部分重复"；API 里也能看到成对出现
  （`interactive` 2.0 降级占位 + `interactive` 1.0 带正文）。
  **这不是重复处理，而是两条独立路径各发一次** —— 与前面修的"同一轮内重复"（游标/去重/幂等）不同源。
  修法：`feishu_send` 执行前检查**目标会话是否有未封口的活跃卡片**（`findActiveCardForChat`）——
  有则**跳过**并明确告知 agent「当前对话的回复会自动显示为飞书卡片，无需调用本工具」；
  同时更新工具 description，从源头减少误用。显式传 `chatId` 发到别的会话不受影响。

### Fixed（早前）

- **同一段内容分两张卡、内容大量重复（2026-09-15 CM 反馈，与 Hermes 侧同源但机理不同）**：
  1. **seal 前补扫从本轮起点重放**：`scanEvents(turnAgent, { from: seqBefore }, card)` + `appendNote` 无去重
     → `split()`（答题后开新卡）之后，新卡会把 split 前的内容重写一遍、split 后的写两遍。
     改为 **一卡一游标**：游标挂在卡对象（`card.cursor`），`scanCard(agent, card)` 从本卡游标续扫；
     `appendNote` 按 **seq 去重**（`card.seenSeqs`）；`split()` 的新卡游标 = 当前事件位置。
  2. **建卡不幂等**：`sendInteractive` 返回体不校验就写进 `card.token`，且 15s 超时被 abort 时
     飞书侧可能已建卡 → token 仍空 → 每次 sync 再建一张（孤儿卡）。现在：校验 `message_id` 必须为
     非空字符串；建卡失败置 `createFailed`，**队列内外双重拦截**不再重复建卡；
     `failCount` 只在**成功 PATCH** 时清零（create 成功不算"卡健康"）。
  3. **入站无去重**：长连接 at-least-once 重投 / 双 helper 会让同一条消息跑两整轮 → 两张相同的卡。
     新增按 `message_id` 的 LRU(200) 去重。
- **正文里的长代码框不折叠（问题②的 DSH 侧）**：DSH 对 note/回复是平铺 markdown，代码框零折叠。
  新增 `renderMessageElements()`（移植 Hermes 侧：>8 行或 >600 字符 → 折叠面板，未闭合围栏自动补全）。

### Added

- `scripts/smoke.mjs` 新增 4 组回归测试（共 8 项断言）：**入站去重**、**seq 去重**、
  **长代码框折叠**、**建卡幂等**（用 `createReturnsEmptyId` 开关模拟返回体缺 message_id）。
  这些断言在修复过程中直接抓出两处我自己的实现漏洞（入口检查漏掉并发排队的 create；断言把
  兜底纯文本误计为重复建卡）。

## [Unreleased]（早前）

### Added

- **飞书文件消息静默丢弃 → 自动收件（2026-09-09 CM 实测）**：`handleInbound` 对无文本的文件/图片消息直接 return，用户发文件 agent 无感知。修复：新增 `downloadInboundFile`——识别 file/image/audio/media 消息的 file_key，经消息资源 API 下载到 fileInbox（config 可选，缺省 <workspace>/downloaded_files）并注入「收到文件+本地路径」文本；语法 + smoke 全绿（2026-09-09）。

## [0.2.0] - 2026-09-08

### Added

- Approval cards: dsh `approval/request` for plugin-owned Feishu sessions is
  answered via an interactive Feishu card with `✅ 允许一次` / `❌ 拒绝` buttons
  (`card.action.trigger` long-connection events); 3-minute timeout auto-rejects
  (rule shown on the card),
  agent abort settles as cancelled; card shows the final outcome after the user
  clicks. Fixes sessions hanging forever when audit sentinels ask without a
  GUI answerer (2026-08-15).
- User questions: `ask_user_question` tool calls from Feishu-owned agents are
  intercepted on the `tools/execute` waterfall (stock DSH, no source patches)
  and answered in the chat — options render as an interactive button card
  (ZCode-style, up to 5 buttons; plain-text fallback for more), free-text
  replies work too; the answer is returned as a normal tool success. The
  reply also bypasses the serial chain (the chain is held by the turn waiting
  on the answer) so a question can never hang (2026-08-17).
- `/stop` command: cancels the CURRENT live agent (resolved via `agents.list()`
  instead of a possibly stale cached handle), processed immediately (bypasses
  the serial message chain so it can interrupt a running turn) (2026-08-16).
- `/plan` routes through the harness commands registry (plan-mode registers it
  there) with an injected-planMode fallback; `ctx.get('planMode')` misses the
  service across bundle scopes (2026-08-16).
- Card clicks (`card.action.trigger`) bypass the serial chain so approvals
  settle instantly; the approval card is recalled after the decision instead
  of lingering at the bottom of the chat (2026-08-16).
- Card fold redesign: history folds into a top `📎 更早过程` panel, the newest
  10 elements stay visible — content scrolls forward as it grows (2026-08-15).
- helper: registers `card.action.trigger`, `LoggerLevel.info`, and a raw-event
  debug hook; the host logs raw events for observability (2026-08-16).

### Fixed

- **问答后流式卡续更不可见 → 答题后自动开新卡（2026-09-08 CM 实测）**：`ask_user_question`
  答题（点按钮/文字回复）后，agent 的后续输出仍写入本轮**旧**的流式回复卡（位置在
  选项卡上方，用户看不到更新）。修复：新增 `activeTurns`（agentId → 当前 turn 卡上下文）
  与 `entry.split()`——答题 resolve 前冻结旧卡（stop watcher + seal + 提示"已收到继续处理"），
  从当前事件位置起另开**新卡**接管后续 narration；按钮路径（handleCardAction）与
  文字回复路径（handleInbound）均接入。新 watcher 从 `snapshotEvents().length` 续扫，
  避免旧事件重放。语法 + smoke 全绿（2026-09-08）。
- **问题选项卡的失效点击静默丢弃 → 改为可见提示（2026-09-08 CM 实测）**：用户在
  `ask_user_question` 按钮卡片上二次点击（卡片已回答/已过期）时，宿主只打印日志
  「record not found」就静默 return，飞书端表现为"点了没反应/按钮灰掉"。修复：
  ① 新增 `recentQuestions`（每 chat 最近一次已答卡 token）与 `findBotForChat`
  （按 open_chat_id 反查 bot）；② record 缺失时按 token 是否命中最近卡，向用户
  发可见提示（"该选项已处理过 / 这张卡片已过期，请看最新消息或直接回复"），不再
  静默；③ 结果卡 `updateInteractive` 失败或缺失时降级发文本「✅ 已收到：xx」，
  保证任何一次点击都有反馈。语法 + smoke 全绿（2026-09-08）。
- **飞书新会话无标准工具（2026-09-08 公司电脑实锤修复）**：dedicated 会话由
  `agents.create` 创建时未挂载 agent preset，模型只见 `feishu_send`，没有
  fs/bash/web 等工具。修复：create/resume 的 `setup` 均调用
  `agentPresets.mount(agentCtx)`（与 GUI 会话工厂同路径）；会话状态引入
  `gen: 2` 标记，加载时自动丢弃旧世代（无工具）会话条目——聊天下一条消息
  自动重建全工具会话，日志 `dropping N legacy session(s) ...` 留痕。冒烟全绿
  （含 `standard agent preset mounted` 日志）+ 真机重启验证迁移生效。
- **DSH 0.1.2 API 适配（2026-09-08）**：`agent.session.events`（旧数组属性）在
  DSH 0.1.2-rc.1 已废弃，改为 `agent.session.snapshotEvents()`——原代码在
  0.1.2 上入站消息一到 `handleInbound` 就抛
  `TypeError: Cannot read properties of undefined (reading 'length')`，机器人
  收消息不回复（公司电脑实测）。适配后 smoke 全绿、真机入站→流式卡片闭环
  恢复。涉及：`scanEvents` / `seqBefore` / seal 扫描三处读取点，均改用
  `snapshotEvents()`（返回冻结数组，下标=seq，语义与原 `events` 一致）。
- `extractText` now parses Feishu **post (rich-text)** message content
  (`{"title","content":[[{tag,text},...],...]}`) in addition to plain text —
  desktop-client messages (post) were silently dropped with zero logs, making
  the bot appear dead (PC "在吗？" got no reply while mobile text messages
  worked fine). Root cause confirmed 2026-09-01 by comparing chat history
  (post vs text msg_type) against bridge logs; fix verified with unit cases
  for text/post/mentions/empty/bad-json.

## [0.1.0] - 2026-08-15

### Added

- Official Feishu (Lark) SDK long connection (no public URL required): helper
  subprocess per bot, JSON-line protocol on stdout, crash auto-restart.
- Per-chat dedicated agent sessions (never shared with GUI sessions), session
  persistence across restarts, `/new /switch /list /help` commands.
- Streaming reply card: one card per turn, PATCH-updated live — inline
  agent notes + collapsible tool-call panels with status symbols, sealed with
  the final reply; rate-limit coalescing, exponential backoff, circuit
  breaker, and a plain-text fallback.
- Typing reaction (OnIt) added on arrival and removed after reply delivery.
- `feishu_send` model tool for proactive messages.
- Hot-reloadable config at `~/.dsh-feishucard/feishu.config.json`, with a
  one-time automatic migration from a legacy `~/.cc-connect` config if
  present.
- Smoke test suite (mocked DSH context + mocked Feishu API) covering the full
  turn pipeline.

### Fixed

- Fast turns (< 300ms) could lose narration/tool panels because the event
  watcher never polled before seal; a catch-up scan now runs at seal time.
- Helper subprocess could be spawned repeatedly while booting (status not yet
  `running`); a per-bot spawn cooldown prevents duplicate processes.
- Resuming a session DSH still marks live (e.g. after a hard kill) is rejected
  by the platform (`cannot prepare session ... while it is live`); the plugin
  now automatically creates a fallback session so messages always get a reply.
- Live sessions (restored by DSH on boot, or held by the GUI) are now reused
  directly from `agents.list()` instead of failing to resume, so conversation
  context survives restarts.

### Changed

- Config/state moved from the legacy `~/.cc-connect/` location to the
  project's own `~/.dsh-feishucard/` directory; a one-time automatic
  migration preserves an existing legacy config.
- README rewritten in naturally mixed Chinese/English; added CI workflow
  (syntax check + secret scan + smoke test).
