# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.25] - 2026-10-02

### Fixed（独立审查门槛判 **BLOCK** ⇒ 逐条修复：1 high / 3 medium / 8 low 真缺陷）

**门槛**：`code-review-gate`（阿里 OpenCodeReview / `deepseek-flash`，13m18s，`fail-on: high`）。
报告：`output/code-review/dsh-feishucard-20261002-132807/REPORT.md` ——
**0 critical / 1 high / 3 medium / 12 low**。1 high + 3 medium **逐条打开源码复核，4/4 全真、零误报**；
12 条 low 里 **11 条已修**，剩 1 条是结构性重构建议（本轮不动，理由见文末"未采纳"）。

| # | 级别 | 位置 | 问题（复核结论） | 修法 |
|:--|:--|:--|:--|:--|
| 1 | **high** | agent 作用域监听 | `agent.ctx` 是**长生命周期**的（HMR 只换插件代际、不换 agent），而监听注册后**从不注销** ⇒ 每次热重载往同一个 agent 上再叠一条；老闭包钉住整代插件状态，且瀑布流里**最早的监听先被调用** ⇒ 可能是上一代在应答 | 留住 `scope.on` 的 disposer，统一放进 `agentScopeDisposers`，在 `ctx.effect` 卸载钩子里注销（`approval/request` + `user-questions/request` 两处） |
| 2 | medium | `feishuChatAgents()` | 枚举靠 `s.handle.agent`，而**句柄不持久化** ⇒ 热重载/重启后 `pollSubagentNotices`（回执播报）与 `refreshLiveCards`（目标条刷新）对空集合空转、静默失效 | 先按 **session id** 找活 agent（`liveAgentsById()`，与 `resolveAgent` 同一条判据），找不到才退回句柄 |
| 3 | medium | 文字回答路径（入站） | 飞书**纯文本回答**的主路径漏了 `splitLiveCardAfterAnswer()`（另两条回答路径都有）⇒ 回「批准」后旧卡不冻结，后续内容继续堆在用户已划走的那张卡上 | 补上该调用，顺序与 `handleInbound` 一致：先换卡 → 再改「已收到」态 → 最后 `resolve` |
| 4 | medium | `scripts/sync-to-profile.mjs` | 「改动已进入待生效队列」那行**无条件**打印 ⇒ **复验失败的同步**也会被读成"重启就生效"，把失败伪装成成功 | 只在 `bad === 0` 时打印；失败时显式报「**未**部署，重启也不会生效」并以 exit 1 收尾 |

**同一轮顺手修掉的 8 条 low（皆为真缺陷）**

| 级别 | 位置 | 问题 | 修法 |
|:--|:--|:--|:--|
| low | `recentTurnCards` | 唯一没跨代际共享的簿记表：一热重载，3 分钟"复用刚封口的卡"窗口就没了 ⇒ goal 轮又另开一张卡镜像同一批事件（正是它要防的"同内容两张卡"） | 搬上 `globalThis.__fsRecentTurnCards`（与 `activeTurns` / `liveCardRegistry` 一致） |
| low | `makeAutoCardEntry.split()` | 新 watcher 传的 `onTableBudget` 是 `null` ⇒ 答题后换的新卡**没有换卡通道**，满 5 张表即降级成代码块，破坏"永远不降级表格"的不变量 | `openGoalCard` 暴露 `state.rotate`，split 时接上 |
| low | `noticeSeen` | 每个子代理回执加一条、**从不清理**（桥要连跑几天）⇒ 慢速无界内存增长 | FIFO 上限 500 条（`rememberNoticeSeen`） |
| low | `loadMessageIndex()` | 每次未命中都重读盘并**回写覆盖内存**：① 入站路径同步 `readFileSync + JSON.parse`；② 把 300ms 去抖窗口内刚刷新的标签退回旧值 | 跳过内存里已有的 key，只补磁盘新增 |
| low | `installApprovalBridge()` | 只判"装过"不看实例：一旦 `ctx.get('approval')` 给出另一个实例，新实例的 `decide` 从未被包 ⇒ 飞书审批静默退回 GUI 老路 | 判据从**对象身份**改到**方法自身标记**（`__fsApprovalBridgeWrapped`）：是原始方法才包、已包过只刷新指向 |
| low | 日志字段名 | djb2（32 位）却叫 `payload_md5` / `reply_md5` / `closing_md5` —— 名字承诺 MD5，会误导下一个 grep 日志的人 | 改名 `payload_hash` / `reply_hash` / `closing_hash`（历史取证引用保持原样） |
| low | 结论去重 key | 32 位指纹兼作去重 key，撞了就把一条正常结论**静默**换成"✅ 本轮已完成…" | key 拌入正文长度（`shortHash(reply + '#' + len)`） |
| low | `--dry-run` 诊断 | 链接形态下守卫在 dry-run **之前**，只读诊断也直接 exit 3 | `--dry-run` 不再被守卫拦；另修：大小写只在 Windows 折叠、链接指向**别处**时打印真实目标并区分文案 |

**未采纳（1 条，已在此记录理由）**

- `index.js` 三处"封口 → 开新卡 → 重挂 watcher"的重复逻辑（`rotateAdoptedCard` / `rotateTables` / `makeAutoCardEntry.split`）抽成一个公共函数 ——
  属**结构性重构**，而这块正是本轮修掉最多回归的地方：**本轮不动核心换卡路径**（风险大于收益），
  留作后续专项（届时先补一条覆盖三种换卡入口的冒烟用例再动）。

**另：三条同属 low 的建议已按建议修掉并留痕** ——
`sync-to-profile.mjs` 链接守卫的三处（措辞/大小写/dry-run 顺序）、`smoke.mjs` 两处死变量 `mark3` / `mark4`、
以及 dispose 里那段"移交活跃回合"死代码（`activeTurns` 本身就是那个全局 Map，`has` 恒为 true，日志不可达）。

**取证（2026-10-02 真机日志，顺手把 low#4 的修法本身也修对）**：实测 `ctx.get('approval')`
**每代给出新的代理对象**，而那个对象的 `decide` 是**未包装的原始函数**
（每个新代际都会打 `approval[service]: 发现未被包装的实例，重包 decide()`）⇒
① **不存在叠层**（上一代的包装随它那个对象一起被丢弃）；② 但**每代都必须重包** ——
早期"只包一次"的写法在实例换代之后会让飞书审批静默失效。
⇒ 判据**不能落在对象身份上**（每次都不等，日志里那行 `实例已更换，重新包装 decide()` 每代都打），
落在**方法自身标记**上才能同时覆盖"实例被换"与"实例被复用"两种 DSH 行为。

**复跑（同一门槛，8m57s）⇒ 上一轮那条 high 已消失，判 WARN：0 critical / 0 high / 1 medium / 3 low。**
四条逐条处理：

| 级别 | 位置 | 问题 | 处置 |
|:--|:--|:--|:--|
| medium | 两个 agent 作用域绑定 | 整条 high#1 修复都押在 `scope.on(...)` 返回 disposer 上 —— 若上游改成"返回 this 以便链式调用"，修复就变成**沉默的空操作**（监听照样叠加、日志一个字都没有） | ① **先取证 API**：`@deepseek-ai/cordis/lib/index.js:371` 的 JSDoc 明写 `@returns a disposer removing the listener`；② 取不到时**喊出来**（`⚠️ agent 作用域 disposer 不可用（监听可能跨代叠加）`） |
| low | 卸载钩子 | `unbound` 只记成功数 ⇒ 某个 disposer 抛错被吞掉时，"没拆干净"会被少计成正常 | 改记**尝试次数**，并在 catch 里单独留痕 |
| low | `recentTurnCards` | 搬上 `globalThis` 后**不再随代际清空**，每条又钉着封口卡（含 blocks）与**上一代 bot** ⇒ 随会话数无限增长 | 新增 `pruneRecentTurnCards()`，在读的地方先剔过期项 |
| low（测试） | smoke 零覆盖 | mock agent **没有 `ctx`** ⇒ `scope.on` 从不被调用、`agentScopeDisposers` 恒为空 —— "忘了注销 / 注销不生效"在冒烟里永远不会变红 | 给 mock agent 配上会记账的 `ctx.on`，**新增用例 47**：绑定 → 断言不叠加 → 执行 effect cleanup → 断言监听全部注销 |

**用例 47 实测**：`挂到了 agent.ctx 上（本次 1 条）` · `同一代重复绑定不叠加（仍是 1 条）` ·
`卸载后 approval/request 监听已注销` · `卸载后 user-questions/request 监听已注销` ·
`disposer 确实被调用（调用次数 2）`。

**第三轮复跑（6m34s）⇒ 仍 WARN，但**上一轮 4 条已全部消失**：0 critical / 0 high / **2 medium** / 1 low。**
这两条 medium 里有**一条是我上一轮修复带出来的新缺口**，逐条处置：

| 级别 | 位置 | 问题 | 处置 |
|:--|:--|:--|:--|
| **medium** | `agent/status` 补挂点（**上一轮修复带出的新缺口**） | 我上一轮给两条 agent 作用域监听加了"卸载时注销" ⇒ 于是"**只有 `handleInbound` 与 `/plan` 会补挂 `user-questions/request`**"这个长期被掩盖的**不对称**暴露了：老 agent 重载后起**自动轮**（goal/notice，不走 `handleInbound`）时手上没有问句水位线，而根级监听又被 GUI 桥接抢在前面 ⇒ **提问/计划审查只弹电脑、飞书收不到卡** | 在 `agent/status` 里与 `bindFeishuAgentApproval` **同一个补挂点**补上 `bindFeishuAgentQuestions` |
| **medium** | 结论去重 key | 我上一轮"把正文长度拌进 key"来防撞 —— 但这张表挂在 `globalThis`，存在的意义正是**跨代际**去重；一改 key 推导，**上一代旧代码写进去的条目就永远对不上** ⇒ 升级后那一次热重载的去重失效，又会看到一次"同内容两张卡" | key 推导**保持跨版本稳定**（`shortHash(reply)`），防撞改用**长度作第二判据**（分开存 `len`、分开比；旧条目无 `len` 时按兼容放过） |
| low | `pruneRecentTurnCards()` 只在读路径调用 | 那个调用点位于一串提前 return **之后**（关掉自动卡 / per-bot 通知开关时走不到）⇒ 跨代际的表照样按"每个 agentId 一条"无限涨 | 新增 `rememberRecentTurnCard()`，**写入即剔**（两个写点都改用它） |

**新增敏感用例（可失败性已实测）**：冒烟里加一个**从未收到过飞书消息**的 mock agent
（＝重载后自己起自动轮的老 agent），只靠 `agent/status` 一次补挂，断言它**同时**拿到
`approval/request` 与 `user-questions/request`。

```
  ✅ 新 agent 靠 agent/status 挂上审批水位线
  ✅ 新 agent 靠 agent/status 也挂上问句水位线（上一版会漏）
```

**变异测试（证明这条用例真的会红，不是"写了就算验过"）**：把那行补挂临时摘掉重跑 ⇒
`❌ 新 agent 靠 agent/status 也挂上问句水位线（上一版会漏）` + `SMOKE FAIL: 1 assertion(s) failed`；
还原后 `SMOKE PASS`。

**第四轮复跑（4m40s）⇒ 0 critical / 0 high / 1 medium / 3 low —— 四条全是测试与文案，无生产代码缺陷。**
按 `fail-on: high` 判据这轮**不阻塞推送**；四条仍按建议当场改掉，且**生产代码 `index.js` 与第四轮被审版本
逐字节相同**（md5 `2fd59090…` 可核）—— 改的只有测试与提示文案：

| 级别 | 位置 | 问题 | 处置 |
|:--|:--|:--|:--|
| medium | `scripts/smoke.mjs` 用例 47 | 用 `effects[0]` 硬编码"卸载钩子＝第一个 `ctx.effect`" ⇒ 与 `index.js` 的注册顺序耦合：前面一旦多注册一个 effect，就会误报失败、或去卸载别的东西 | 改成**按行为定位**：mock 收集所有"setup 返回函数"的 cleanup，逐个执行直到两条水位线在**两个** mock agent 上全部消失 |
| low | `scripts/smoke.mjs` | `entry.listener` 存了却从不读（死字段）；且 disposer 在"没找到该条目"时也 +1 ⇒ 计数不再是"移除了几条"的忠实信号 | 改为直接存 listener；**只有真的 splice 掉才计数** |
| low | `scripts/smoke.mjs` | `agentCtx.on` 与 `freshCtx.on` 是近乎复制品，只差一个计数器 ⇒ 以后修记账容易只改一处 | 抽 `makeScopedCtx(onDispose)` 工厂，两个 mock 共用 |
| low | `scripts/sync-to-profile.mjs` | `sameReal` 分支里的补救建议假定"是链接"；当 target 是**实体目录**、只是 realpath 恰等于源码根时，"删掉该链接"会把人带沟里 | 建议按 `isLink` 分流 |

**为什么不跑第五轮**：门槛判据是 `fail-on: high`，已连续四轮 **0 critical / 0 high**，剩余全是越挖越细的 nit；
且这轮只碰测试与文案（`index.js` 逐字节未动）。继续"改一轮跑一轮"只会无限推迟推送 ——
残余项一律如实记在本文件里，不阻塞。

**门槛四轮小结**：BLOCK(1 high/3 med/12 low) → WARN(1 med/3 low) → WARN(2 med/1 low) → WARN(1 med/3 low)；
**生产代码的 critical/high 从第二轮起就再没出现过**，三轮里揪出的最有价值的一条是
**"上一轮修复带出的新缺口"**（问句水位线只在 `handleInbound`/`/plan` 补挂）。

**回归**：`node --check`=0（index.js / smoke.mjs / sync-to-profile.mjs）；
smoke **SMOKE PASS (sentCards=182, sessions=7)**，`❌` 0 条；`--dry-run` 链接形态下可用（返回 0）。

## [0.4.24] - 2026-10-02

### Fixed（🔴 空闲一会儿再下命令，不再要求"先发一条普通消息" —— CM 报障）

**CM 原话**：「经常我隔开一段时间没跟机器人说话以后，我突然跟它说话，我发目标、发计划，
或者想去改模型，我发指令过去，它会弹一句说『**目前没有会话，先发一条普通消息**』。这是为什么呢？」

**根因**：**命令通道和普通消息走的不是同一条取 agent 的路**。

| 通道 | 取 agent 的方式 | 空闲/重启/热重载后 |
|:--|:--|:--|
| **普通消息** | `resolveAgent(bot, chat)`：① 复用**活着的**会话 ② 否则 `resumeDedicated()` 恢复持久化会话 | ✅ 照样能用 |
| **命令**（`/goal` `/plan` `/model` `/stop` `/compact`） | 只读 `chat.sessions[activeIndex].handle`——**内存里的活句柄** | ❌ 句柄没了 ⇒ 弹"先发一条普通消息" |

⇒ 句柄是内存态，**空闲久了 / dsh 重启 / 插件热重载之后就不在了**；而会话其实一直都在磁盘上。

**修法**：新增 `commandAgent(bot, chat)` —— 先找活句柄，找不到就**走 `resolveAgent()` 同一条路**
（复用活会话，否则恢复持久化会话）。五条命令分支 + `/model` 卡片点击全部改用它。

- 留痕：冷启动那次会打 `[fs] command channel: resumed session for command (agent=…)`。
- 顺带把 `/stop` 里那段重复的"活句柄 + 兜底"查法一并删掉（同一件事只留一处）。

**回归**：`node --check`=0；smoke **SMOKE PASS (sentCards=182, sessions=7)**，`❌` 0 条。

## [0.4.23] - 2026-10-02

### Added（`/model` —— 飞书侧切换模型，CM 2026-10-02 提）

**CM 原话**：「有一个问题：**飞书上切换不了模型**，你现在能发个卡片给我选择，先把模型切换了吗？」

**语义与 GUI 同源（不自己发明）**

| 动作 | 依据（读自 0.2 源码） |
|:--|:--|
| 取当前模型 | `sessionController.selectionFor(agent)`（退回 `agentDefaultModel.currentSelection()`） |
| 列可选模型 | `ctx.llm.listProviders()` → `ctx.llm.listModels(provider.id)` |
| **执行切换** | `sessionController.selectForNextRequest(agent, { provider, model })` —— 内部就是 `agent.session.append('model/selection', …)`（`dsh-api-session-controller/lib/index.js:319-322`），**按会话**生效、从下一次请求开始用；服务拿不到时退回直接 append 同一条事件 |

**用法**：`/model` 发选择卡（当前项带 `▶` 且是主按钮，**点一下即切**）；
`/model <provider>/<model>` 文字直切。

**为什么以前切不了**：模型选择是**会话级**的（session 日志里的 `model/selection` 事件），
飞书侧从来没有那条写入通道 —— 只有 GUI 那个面板有。

**回归**：`node --check`=0；smoke **SMOKE PASS (sentCards=182, sessions=7)**，`❌` 0 条。

## [0.4.22] - 2026-10-02

### Fixed（🔴 热重载后新实例「接管」旧卡，而不是各开一张）

**背景**：接 0.4.20。0.4.20 只做了「停 watcher + 把旧卡封口」，实机发现**副作用**：
封口把观众丢在「后续内容见新的卡片」，而**下面根本没有新卡** ——
因为新实例不认领上一代那张卡，于是这一轮的剩余内容**整段不可见**（只能等回合收尾的结论卡）。

**修法（续卡机制）**

1. 新增**跨代登记表** `globalThis.__fsLiveCards`（agentId → `{ agent, card, bot, chatId, stop }`）——
   `startCardWatcher` 登记、`stop` 注销（只注销"还是我这条"）。
2. dispose 时**只停 watcher、不再封口**（封口留给真正的回合收尾），
   并把登记表快照保留下来给新实例。
3. **apply 时接管**：新实例遍历登记表，把还没封口的卡**接着更新**（同一张卡、同一游标），
   日志 `[fs] 热重载续卡：接管 agent=… card=… blocks=…`。
4. 卡片表格额度换卡在续卡通道里也保留（`rotateAdoptedCard`：旧卡留表格、新卡接续游标）。

**另加**：`buildCardPayload` 日志带上**卡片身份**（`card=<token 后 8 位> status=… cursor=…`）——
此前只有块数，出现"两条流并行"时**分不清是哪两张卡**，只能靠猜（多绕了几轮）。

**回归**：`node --check`=0；smoke **SMOKE PASS (sentCards=182, sessions=7)**，`❌` 0 条。

## [0.4.21] - 2026-10-02

### Fixed（🔴 插话会把"正在打的结果"截断 —— CM 报障「导致我看不到」）

**CM 原话**：「我发信息给你，若你刚好在应答的时候，你会**直接截断掉**需要打印结果的那些回复的内容，
**导致我看不到**」。

**机理（三步，缺一不可）**

1. 插话（steer）会 `split()` **换卡** —— 旧卡就地封口，后续内容写到下面新卡；
2. 旧卡上镜像的过程话语是 **note**，建卡时限长 `MAX_NOTE_CHARS`（**500 字**）⇒ 长正文被截断；
3. 新卡游标从**当前位置**起 ⇒ **不重放**旧内容；而 seal 时的结论提取只取"末尾那一段文本"
   （段与段之间**没有工具调用就停**）⇒ 前半段既不在新卡、也没进结论
   ⇒ **只剩旧卡上那 500 字，其余彻底看不到**。

**修法**：`split()` 封口旧卡**之前**，把卡上的 note **按 `seq` 从会话事件里还原成完整正文**
（`extractProcessText`，一个字不丢），再补那行"后续内容见下方新卡"。
留痕：`[fs] 插话封口：还原 N 段被截断的过程正文`。
还原失败只记日志、不影响换卡（绝不因为还原把插话弄坏）。

**回归**：`node --check`=0；smoke **SMOKE PASS (sentCards=182, sessions=7)**，`❌` 0 条。

## [0.4.20] - 2026-10-02

### Fixed（🔴 同一对话里两张卡并行长 —— CM 报障「又有重复了」）

**实证（`web.log`）**

| 证据 | 内容 |
|:--|:--|
| 两张卡并行长 | `buildCardPayload` **成对交错、两边块数不同**（例 69950 `blocks=38 tools=62` / 69951 `blocks=29 tools=51`），并排一路涨到 69967 / 69969 |
| 触发链 | `69810 plugin apply #14`（热重载）→ `69828 im.message.receive_v1`（CM 发消息）→ `69829 reused live session` → **`69833 card created`** |

⇒ **重载之后 CM 的新消息没有插话，而是另起一轮、另开一张卡**；同时上一代那条仍在跑的回合
继续更新它自己的卡 ⇒ 同一个对话里两张卡同时长。

**根因（两条，都属"热重载没做卫生"）**

1. **上一代的卡片 watcher 不会被停**：旧实现只在回合正常收尾时 `clearInterval`，
   **完全没有 dispose 清理** ⇒ 旧代的 `setInterval` 继续 PATCH 它自己那张卡。
2. **`activeTurns` 随重载清空**：新实例查不到"这个 agent 有活跃回合" ⇒
   `steerActiveTurn()` 落空、下一条消息走 `handleInbound` 另起一轮 ⇒ 又多一张卡。

**修法**

1. 所有 watcher 登记进本代 `liveCardWatchers`；`ctx.effect` 的 dispose 里停掉它们，
   并把旧卡**就地封口**（留一行 `♻️ 插件已热重载：本卡停止更新，后续内容见新的卡片。`），
   免得它在飞书里永远停在「正在工作中…」。
2. `activeTurns` 挂到 **`globalThis.__fsActiveTurns`** ⇒ **跨插件代际共享**，
   新实例能看见上一代仍在跑的回合，照旧走插话那条路（不再新开卡）；
   两处 `delete` 同时改成「**只有表里还是我这条才删**」，避免新实例摘掉别人的 entry。
3. dispose 时把还没结束的活跃回合**移交**给全局表（过渡期也不丢）。
   注意：本防护**只对"带着这段代码的那一代"生效** —— 销毁更早的实例时它仍会漏一次，
   从下一代起干净。

**真机验证**

```
[fs] dispose(热重载): 停掉 1 个卡片 watcher，旧卡已封口
```

**回归**：`node --check`=0；smoke **SMOKE PASS (sentCards=182, sessions=7)**，`❌` 0 条。

## [0.4.19] - 2026-10-02

### Changed（🔴 清掉仓库里的**硬编码绝对路径** —— CM 提问后按 A17 执行）

**CM 原话**：「而且不能用绝对路径吧？**绝对路径是不是得全部改掉？**」

**审计（全仓扫 `[A-Za-z]:[\\/]`）** —— 代码侧基本干净，问题集中在测试夹具与文档：

| 位置 | 原状 | 处理 |
|:--|:--|:--|
| `scripts/smoke.mjs` | `WORKSPACE` 与「其它工作区」两处**写死了盘符绝对路径**（4 处，含断言与注释） | **改由系统临时目录派生**：`SMOKE_WS_ROOT = tmpdir()` 归一成正斜杠 → `WORKSPACE` / `OTHER_WORKSPACE`（形状仍是 Windows 绝对路径，与插件 `normPath` 写法一致） |
| `README.md` / `feishu.config.example.json` | 示例配置里写死盘符绝对路径 | 换成 `<你的工作区绝对路径>` 占位符，并在 `_notes` 里写明"填自己机器、别提交真路径" |
| `UPGRADE-0.2.0-rc.2-compat.md` | 13 处实机路径 | 全量替换为占位符，并在文首加**路径约定**（`%WORK%` / `%DSH%` / `%REPO%`） |
| `CHANGELOG.md` | 1 处旧工作区绝对路径 | 改为 `<其它工作区>` |

**顺手更正一处作废推断（A22：不留负向锚定）**：`UPGRADE-*.md` 开头的「旧模型 id ⇒ 请求挂起」
**已实测证伪**（旧 id 直连 API = HTTP 200；未命中目录不抛错、原样照传），
与同文第七节**互相矛盾** ⇒ 已把该处结论与判断改成"**已作废、根因仍未定位**"，不再两条并存。

**审计结论**：`index.js` / `helper.cjs` / `scripts/sync-to-profile.mjs` **本来就没有**硬编码绝对路径
（`sync` 脚本走 `homedir()` + `DSH_HOME` + `--profile` 参数 + `import.meta.url`）—— 这点符合 A17。

## [0.4.18] - 2026-10-02

### Fixed（🔴 用户已授全权时，插件不该再加一道审批 —— CM 质问后修）

**CM 原话**：「为什么推送到仓库要我审批呢？**我已经给了全部权限给你了呀**」。

**实证（`web.log`，`git push` 那一步）**

```
[fs] approval needed (pre-execute): pwsh — 联网/外发命令：Set-Location '…dsh-feishucard'
[fs] approval card sent: pwsh token=4438db21-aec2-415e-901e-b7f335ff1d9f
[fs] approval allowed (once): pwsh
[fs] approval needed (pre-execute): pwsh — 联网/外发命令：…
[fs] approval card sent: pwsh token=92b5e4b3-ed3b-41f3-a0fa-c96eb441a0f7
```

**根因**：插件自己那道闸（`approvalReasonFor`：外发命令 / 工作区外写入）**不看会话档位** ——
推送命令里有 `$env:GIT_SSH_COMMAND = 'ssh …'`，命中 `EGRESS_CMD_RE` 的 `\bssh\b` 就弹卡。
**与 harness 权限无关**：CM 给的是 `danger-full-access`，harness 从未拦过。
这道闸之所以开着，是 **0.4.17 把它默认打开的副产物**（而它原本的口径就是
2026-09-16「**他给的是完全访问，审批不该由插件再加一道**」）。

**修法**：`tools/pre-execute` 里先读**本会话当前**的沙箱档位 ——
`ctx.get('sandboxPolicy').resolve({ session })` → `{ mode, workspaceRoot }`
（与 `dsh-tool-pwsh/lib/index.js:319` 同源），**`mode === 'danger-full-access'` 直接放行**。

- 恢复 2026-09-16 的本意：**用户已授全权 ⇒ 插件不再加一道**。
- ⚠️ **真正的"越权升级"审批不受影响**：那种请求只在会话**受限**时才产生
  （`sandbox_permissions` ⇒ 请求升级 ⇒ 走审批服务 `decide()` 直连 ⇒ 飞书卡）。
- ⇒ 行为收敛为：**全权模式 = 零审批卡；受限模式 = 只有越权才弹卡**（正是 CM 要的）。

## [0.4.17] - 2026-10-02

### Fixed（🔴 0.2 上飞书审批被 GUI 桥接抢答 —— CM 报障后修）

**CM 原话**：「手机上得要能审批才行，**不可以关了**」。

**现象**：把权限改成 `workspace-write` + 审批策略 `ask` 之后，越权请求**只弹在电脑上，
飞书一张卡都收不到**。

**取证（全部可复现）**

| 证据 | 内容 |
|:--|:--|
| 会话日志 | 本会话策略确实是 **`ask`**（`approval/policy` seq=3017，06:00 改的），**不是 `never` 短路** |
| 实例日志 | 升级 0.2 之后 `[fs] approval/request received` 出现 **0 次**（0.1.x 时代有 **70 次**） |
| 两次尝试 | 根级挂过、agent scope 也挂过（`bound to agent scope for …` 有日志行）—— **都没轮到** |
| CM 确认 | 那两次越权请求他都是**在电脑上**看到并拒绝的 |

**根因**：`@deepseek-ai/dsh-api-remotes` 的 forwarded waterfall
（`lib/index.js:215-232`；事件白名单 `:17-25`）在**根级更早注册**，只要浏览器端连着，
它就把 `approval/request` 收进队列交给 GUI 客户端，**只有远端不接才 `next()`**
⇒ 插件监听永远排在它后面。**0.2 新增的这条转发就是本次倒退的来源。**

**修法（不改 harness 一行）**：工具取审批服务是**按对象**取的 ——
`dsh-tool-pwsh/lib/index.js:341`（`dsh-tool-bash` / `dsh-tool-fs` 同构）都写
`approver: ctx.get("approval")` ⇒ 把该服务实例的 **`decide`** 包一层即可。

- **只包 `decide`**（政策判定 + 征求答案那一步）；`request()` **原样保留** ——
  它负责写 `approval/asked` / `approval/decided` **审计对**，绝不能绕过。
- **重载安全**：包装只装一次（挂在 `globalThis.__fsApprovalBridge`），relay 每次 `apply`
  重新赋值 ⇒ HMR 重载后不会指向上一代插件的旧状态。
- **补装点**：`apply` 时 + 每次 `tools/pre-execute`（审批服务可能晚于本插件就绪；幂等）。

**开关默认值改了（按 A20-⑤，旧口径作废）**

- `DSH_FEISHU_APPROVAL`：**默认开启**（原来默认 `'0'`＝关）。
  显式关闭设 `=0`（或 `false` / `off` / `no`）。
- 旧口径（2026-09-16「他给的是 danger-full-access 完全访问，审批不该由插件再加一道」）
  **已作废**，不再出现在代码注释里。

**红线不变**：非飞书会话（GUI / 子代理）一律 `return null` 交回原逻辑，绝不吞别人的审批。

**真机实测（CM 2026-10-02 06:16 在手机端亲测）**

```
[fs] approval[service] asking on Feishu: tool=pwsh agent=fs-main-muppqw21 reason=escalate sandbox to danger-full-access: …
[fs] approval card sent: pwsh token=a5d477a1-9086-4333-aac6-f60d6d0d7e51
[fs] approval allowed (once): pwsh
[fs] approval card recalled: pwsh
```

⇒ 卡**到达飞书** → CM **在手机上**点「允许一次」→ 命令**真的执行**
（探针文件 `%TEMP%\dsh-feishu-approval-probe.txt` 已写出并回读）。

### Fixed（🔴 同一条结论被发送两次 —— CM 2026-10-02 报障「为什么发了给我两次？」）

**实证（`web.log` 69634→69649，全部发生在同一秒内）**

```
69634 [fs] turn sealed: … card=om_x100b64d9d54ec0a0b1fff6a877c91b3   ← 卡 A 封口
69635 [fs] conclusion split: elapsed=617236ms tools=83
69636 [fs] turn sealed: … card=om_x100b64d9fc1a8ca0b4b72a9621c1113   ← 卡 B 封口
69637 [fs] conclusion split: elapsed=325527ms tools=26
69642 [fs] card created … payload_md5=4326a255
69645 [fs] card created … payload_md5=4326a255   ← **同一个 payload**
69648 [fs] card reply delivered to oc_***（会话 id 已脱敏）
69649 [fs] card reply delivered to oc_***（会话 id 已脱敏）   ← **发了两次**
```

**成因**：两条回合链条**各封一次口、各拆一张结论卡**。根因是**插件热重载**
（那一轮里连续 `apply #8`–`#11`）：重载会重建模块状态，但**上一代实例里仍在
`await whenIdle()` 的链条不会被注销**，它和新链条在同一秒各自收尾。
（`steer`／插话只是让两条链各自持有不同的卡，所以看起来像"两张卡"。）

**修法**：结论按「agent + 回复正文哈希」**跨插件代际**去重
（记在 `globalThis.__fsConclusionSeen`），**先到先得** ⇒ 不丢结论、也不重发新卡；
窗口 **120 秒**。

- ⚠️ **只在「本来就会开结论卡」的长回合上生效**（未达阈值／纯旁白的短回合完全不受影响），
  否则同一进程内两轮相同文本的短回复会被误并 —— 冒烟用例大量是短回合。
- 命中去重的那条链：**不再重复发送结论**，只在它自己的卡上留一行
  `✅ 本轮已完成，结论见上方卡片。`（正文不重复、也不新开卡）。
- 留痕：命中时打 `[fs] duplicate conclusion suppressed: agent=… hash=… age_ms=…`。

### Added

- `approval/request` 监听**同时下沉到 agent scope**（新函数 `bindFeishuAgentApproval`，
  挂载点：`tools/pre-execute` / `agent/status` / `handleInbound` / `/plan` 四处），
  作为第二道保障（`WeakSet` 幂等，随 agent 回收）。

### Verified

- `node --check index.js` = **0**。
- `node scripts/smoke.mjs` = **SMOKE PASS (sentCards=182, sessions=7)**（沙箱下需越权重试，走飞书审批放行）。
- **结论去重改动后重跑**：`node --check` = **0**；`node scripts/smoke.mjs` =
  **SMOKE PASS (sentCards=182, sessions=7)**，**`❌` 断言 0 条**；
  `duplicate conclusion suppressed` 命中 **0 次** —— 证实去重**没有误伤任何用例**
  （冒烟全是短回合，正好验证「只对"本来会开结论卡"的长回合生效」这条收窄是对的）。
- 线上加载：`[fs] plugin apply #11 v0.4.16 md5=3082fa72 bytes=246590 @ 2026-10-01T22:15:12Z`
  （该次 apply 的版本行仍是 `v0.4.16` —— 版本号是**之后**才补写的，下次重载会显示 `v0.4.17`）。

## [0.4.16] - 2026-10-02

### Changed（适配 dsh 0.2.0-rc.2：宿主升级后的两处破坏性变更）

**背景**：CM 授权把宿主从 `0.1.6-alpha.1` 升到 `0.2.0-rc.2`。升级前的兼容盘点见
`UPGRADE-0.2.0-rc.2-compat.md`（含真实判定函数、备份路径、回滚三步）。

**① peer 范围必须放开，否则会被宿主**静默跳过**（不是降级）**

- 0.2 起宿主在**组合阶段**校验 profile bundle 的 peer：只看 `name === '@deepseek-ai/dsh'`
  或以 `@deepseek-ai/dsh-` 开头的键，判定用
  **`semver.satisfies(runtimeVersion, range, { includePrerelease: true })`**
  （已从 `@deepseek-ai/dsh-app-boot@0.2.0-rc.2` 的 `evaluatePluginCompatibility()` 抽出核对）。
- 旧声明 `^0.1.0-rc.5` → `0.2.0-rc.2` = **false**（`^0.1.x` 的上界是 `<0.2.0-0`）⇒ 会被跳过。
- **改法**：`"@deepseek-ai/dsh-tools": ">=0.1.0-rc.5 <0.3.0-0"`
  —— 实测同时满足 `0.1.6-alpha.1` / `0.2.0-rc.1` / `0.2.0-rc.2` / `0.2.1`。
- ⚠️ **踩过的坑**：用**默认** semver 语义判断会得出"连 0.2.0-rc.2 都不满足"的错误结论
  （prerelease 默认不被范围接受），**差点把范围改错** —— 必须按宿主的
  `includePrerelease: true` 语义判。

**② `ctx.shell.start(spec)` 已改名 `execute(spec)`，且新 API 默认会杀掉长驻进程** 🔴

- 真机症状：升级后日志刷屏
  `[fs] helper start failed: ctx.shell.start is not a function`，
  **`long connection ready` 0 次、飞书整个收不到消息**（helper 是长连接的实际持有者）。
- 根因：0.2 新增 `@deepseek-ai/dsh-shell`，`ShellExecutor` 的抽象方法是
  `resolve(request)` / **`execute(spec)`**（旧 `start` 没了）。
- **第二处更要命**：0.2 的 `resolve()` 会填 `timeoutMs` 并按 `onExpiry` 处理，
  **默认 `'kill'` 会把我们这种长驻 helper 直接杀掉** ⇒ 必须显式 **`onExpiry: 'none'`**
  （官方语义：none 不设截止时间，只能由调用方 signal 或 `kill()` 停止）。
- 修法：`useExecute = typeof ctx.shell.execute === 'function'`，新版本走 `execute` 并带
  `onExpiry:'none'`，老版本自动退回 `start` —— **两个版本都能跑**。
  返回的 `ShellExecution` 与旧句柄形状兼容（`status` / `kill()` / `readOutput().delta` 都在）。
- **验证**：修完日志立刻 `helper spawned` ×3 → **`long connection ready` ×3**（三个 bot 全恢复）。

**升级后真机验收（四项全绿）**

| 项 | 结果 | 证据 |
|---|---|---|
| 插件未被跳过 | ✅ | `[fs] plugin apply #1 v0.4.14`（启动时）；`--dump-config` 零告警零跳过 |
| 飞书桥 | ✅ | `helper spawned` ×3 → `long connection ready` ×3 |
| 模型 | ✅ | 会话 v3/v4 文件均为 `"model":"deepseek-v4-flash"` `"provider":"deepseek-official"`，且实际在用 |
| 热重载（HMR） | ✅ | `hmr watching [...]` + 保存 index.js 后 `hmr reload plugin` → `plugin apply #2` |
| 历史会话 | ✅ | 本会话上下文完整续上；日志迁移为 `session.v4.jsonl.zstd`，**旧 v3 文件原样保留** |

**顺带确认**：`settings.yaml` 被 0.2 一次性导入为 `settings.yaml.imported`（符合 release notes）；
profile 的 `cordis.patch.yml` 被 0.2 规范化重写（保留了本插件所需的那条 HMR `root` 配置）。

- **守护用例**：`node --check` = 0；`npm run smoke` = **SMOKE PASS（182 卡 / 7 会话）**
  （smoke 的 mock 只提供 `shell.start`，正好覆盖"老版本退回 start"这条分支）。

### Fixed（第三轮：`/new` 名字校验 · 目标卡认不出归属 · `feishu_send` 跳过失效，2026-10-02）

**① `/new` 名字校验（3 个洞，CM 实测一次性暴露）**

| 漏洞 | 修法 |
|---|---|
| 名字零校验：`splitCommand` 把**所有空白（含换行）压成单空格**，CM 把整段 `/help` 输出当消息发出去 ⇒ 后面几十行全成了会话名 | `splitCommand` 增 `rawArg`（**保留换行**；`arg` 形态不变 ⇒ `/goal` `/plan` `/switch` 零影响）；`/new` **只取首行** ＋ 折叠空白 |
| 无长度上限 | **超 60 字直接拒绝**（不静默截断 —— 名字被改了必须让人知道），并提示用短名 |
| 校验排在「停掉旧会话」**之后** ⇒ 一个被拒的 `/new` 会**先杀掉当前会话** | 校验**前移**到 `cancel()` 之前，**当前会话未受影响** |
| 回复文案仍用 `cmd.arg`（label 改了、回复没改 ⇒ 割裂） | 回复改用 `nameArg` |

**② 目标卡认不出归属 → 静默跳过（T8 失败）**

- 真机诊断（加日志后一击命中）：`[fs] agent/status skip: no chat owner fs-main-muppqw21`
- 根因：`findChatForAgent()` **只按活着的 `handle` 匹配**，而 `handle` **不落盘**
  ⇒ HMR 重载后丢失；目标轮又不走消息路径去 `resolveAgent` 补 ⇒ 认不出归属 ⇒ 目标卡被静默跳过。
- 修法：改按**会话 id** 匹配（`agent.id === s.id`，落盘、跨重载稳定），`handle` 作兜底。
- 验证：`auto card opened … kind=goal` ✅；同时给该分支 **5 处静默 `return` 全部加了跳过原因日志**
  （只加日志不改行为）—— 以后"静默不建卡"类问题一眼定位。

**③ `feishu_send` 跳过失效（T11，间歇）**

- 现象：3 次触发 = **1 次失败（真发出去了）** ＋ 2 次正确跳过；受控复现 2 次**未命中**
  ⇒ **原故障根因未被日志钉死，不猜**（诊断装晚了）。
- **但机制从代码确证了一个结构性洞**：`bot.lastChatId` **只在入站消息时写入**，
  而每次 HMR 重载都会重建 `bots`（日志：每次 `plugin apply` 后紧跟 `bridge active` +
  `helper spawned`×3）⇒ `lastChatId` 归零 ⇒「重载后～下一条入站消息前」`targetChat` 为空
  ⇒ **整个 `if (targetChat)` 被绕过、跳过逻辑完全失效**。与"第 1 次失败发生在 `apply #5` 之后"吻合。
- 修法：`targetChat` 为空时**回退到「当前有活跃卡的会话」**（此时也无处指定收件人，
  而"对话正在被回答"本身就是不该另发一条的充分理由）；显式传 `chatId` 不受影响。
- 诊断保留：失败时打印 `target=<chatId> activeTurns=<n> [<chatId>/<status> | …]`，一击定位。

**状态**：`plugin apply #7 md5=e993b8d3` ／ `node --check`=0 ／ **smoke PASS（182 卡 / 7 会话）**

**卡片测试矩阵（本轮）**：T1–T10 ✅（T9 的 `/help`·`/switch`·`/stop` 由 CM 实测）、T12–T13 ✅；
**T11 = 结构性洞已修 ✅，但原故障未复现 ⇒ 回归待自然触发**（诊断已武装）。

## [0.4.15] - 2026-10-02

### Fixed（CM 四条报障：计划模式启动没卡 / 计划审批只到电脑端 / 消息排队 / 结论卡被截断）

一次成批修复。完整证据链（会话 seq、日志行号、源码行号）见
`DIAGNOSIS-2026-10-01-plan-mode-card.md`。

1. **`/plan <正文>` 起了回合却没有卡**（CM：「我发了这个计划模式的启动给你……飞书上没有看到卡片」）
   - 根因：harness 把 `/plan <正文>` 解释成「开计划模式 + 把正文当用户消息**起一个真回合**」
     （会话 `fs-main-mupoeiy4` seq 721→725 实证：`command/run` → `plan/mode` →
     `agent/inbox/spliced` → `turn/start`）；而插件的事件入口把命令交给 `handleCommand`
     后**直接 `return`** ⇒ 那一整轮（16 步）**没有任何卡片持有它**。等 CM 再发一条消息才建卡，
     而新卡游标从"当下"开始 ⇒ 之前的步骤**永久不可见**。
   - 修法：`/plan` 分支在 `commands.execute()` **之前**取事件游标，回报 `{ turnStarted }`；
     事件入口据此落回 `handleInbound`，走与普通消息同构的「建卡 → 等回合 → 封口」，
     并以 `skipSend` 避免把正文**重复投递**一次（否则模型看到两条一样的用户消息）。
2. **计划审批只到电脑端**（CM：「电脑端上看到你的计划是发了，但是飞书上没有收到」）
   - 根因：`user-questions/request` **同时被 GUI 桥接**（`dsh-api-remotes` 的 forwarded
     waterfall：白名单 `lib/index.js:17-25`，`forwardWaterfall` L187-204）——桥接把请求转给
     浏览器客户端，**只有远端不接时才 `next()`** ⇒ 只要 GUI 连着，**根级**监听永远轮不到
     （实测：本实例日志里 `[fs] user-questions/request` 出现 **0 次**）。
   - 修法：监听**同时**挂到 agent 自己的 scope（`agent.ctx.on`；Agent 接口里
     `readonly ctx: Context` 就是 Cordis Context，`dsh-api-remotes` 也用 `agent.ctx` 做
     scope 载体）—— 同一条水位线上里层 scope 先于根级执行；非飞书 agent 依旧 `next()`。
     日志留痕带 `[agent-scope]` / `[root]` 前缀，便于现场判定是谁接到的。
3. **回合进行中的消息排队**（CM：「发给你这段话，他在排队……你在做事情的时候没有收到我这条信息」）
   - 根因：入站消息统一排在 `bot.chain` 后面（事件入口），而上一条 `handleInbound` 正卡在
     `await whenIdle()` 上；投递目标又写死 `next-turn` ⇒ 必须等整轮跑完才进会话。
   - 修法：回合进行中、且这条是**普通消息**（不是命令、不是某个提问的答案）时改走
     `agent.steer()` 插到下一步，并在活跃卡上留一行「💬 你的消息已插话送达」。
4. **结论卡只有最后一句**（CM：「你的正式回复又被截断了，结论卡片只有这一句话，其他都进了你的过程卡片」）
   - 根因：旧实现把「最后一条 assistant 文本」当结论；而 agent 常把正文写在**最后一次工具调用
     之前**（本次实录：正文 → `present` → 一句收尾）⇒ 收尾顶替整段答复，真正的正文只剩过程卡上
     被 `MAX_NOTE_CHARS(500)` 截断的 note。
   - 修法（结构性判据，**不用长度阈值**）：从末尾往前收集 assistant 文本 ——
     遇到**纯目的行旁白即停**（旁白是段落边界）；**连续两段文本之间没有工具调用 ⇒ 只取最后那段**
     （那是同一段叙述的多次快照，绝不拼起来）；**中间隔着工具调用 ⇒ 允许再取上一段**
     （正是「正文 → present → 收尾」的真实形态）；同一 seq 只收一次。
     整轮只有旁白时**不拆结论卡**（消灭「只含一行 🎯 的无信息结论卡」）。

### Fixed（第三轮：真机验收通过的收尾 —— 退出通道 ＋ 问题卡收尾态，2026-10-02）

**先记真机验收结果（本轮实测全部通过）**

- ✅ **计划审查卡到飞书**：`exit_plan_mode intercepted for fs-main-muppqw21 plan_len=1988`
  → `question card sent: plan-review`（CM 回「看到卡片了」）。
- ✅ **插话换新卡**：两次 `card created … elements=5`（5 元素 ＝ hr ＋ 彩色块 ＋ hr ＋ …），
  旧卡留「📨 你的消息已插话送达 —— 后续内容见下方新卡。」。
- ✅ **消息未被吞**：全窗口零 `duplicate inbound skipped`。

**D1a｜「批准」其实**没有**真的退出计划模式**

- 真机日志：`plan approved on Feishu … exit=unavailable(planMode 服务未注入)`。
- 根因：`ctx.inject(['planMode'])` 在本环境**从不触发**（profile bundle 跨 scope，
  与插件里既有的 2026-08-15 那条注释同源）⇒ `planModeRef` 恒为 `null`；
  所谓"退出"只是**我口头告诉模型**，会话里并没有 append `plan/mode` 事件
  ⇒ 下一轮系统提示仍会写「You are in plan mode」，等于把模型骗了。
- 修法：改走**命令注册表**的 `/plan off`（`ctx.get('commands').execute(...)`）——
  与 `/plan` 命令同一条**已验证可用**的通道，由 `dsh-plan-mode` 自己执行 `set(agent,false)`。
  日志特征：`exit via /plan off: Plan mode off.`。

**D1b｜「继续修改」分支让 harness 抛异常（我收到的是报错，不是用户的反馈）**

- 真机实测：我拿到的是 `Error: tool result must be losslessly JSON-serializable`。
- 根因（源码级）：`dsh-tools` 的 `materializeFinalResult()` 在 `isError === true` 时
  **无条件**写入 `error: result.error`；我们没给 `error` ⇒ 值为 `undefined`；
  而 `dsh-util-values` 的 `walkJsonValue()` 对 `typeof current !== 'object'` 直接判
  「不可序列化」⇒ 抛错。
- 修法：改成 **`throw new Error(文案)`** —— 与 `dsh-plan-mode` 自己的 `execute`
  **完全同路**，由 harness 统一转成合法的错误工具结果。
- **测试基建坑**：改成抛错后，`emitCtx` 返回的 promise 若等到 `await` 才挂 handler，
  Node 会先触发 unhandled rejection **把 smoke 打挂**（实测）⇒ 必须**同一拍**接住
  （smoke 45 里新增 `capture()` 辅助函数）。

**D2｜文字回答后问题卡不更新 ⇒ 按钮仍可点、点了报 `record not found`**

- 真机场景（CM 亲述）：「弹卡片的时候我刚好发信息了」⇒ 那条被当成回答
  （`question answered via chat`）；随后再点卡上按钮 ⇒
  `question button: record not found for chat oc_ebe4…`。
- 根因：只有**按钮**路径会更新卡片，**文字**回答路径没有。
- 修法：新增 `finalizeQuestionCard(record, text)`，**两条文字回答路径都调用** ——
  就地改成「✅ 已收到：<你的选择 / 原文>」态（复用已有的 `questionResultCardPayload`），
  并登记 `recentQuestions`（再点旧卡给**友好提示**而不是静默失败）。

**D3｜（取证后决定**不改**）`/plan <正文>` 在活跃回合中是否多出空卡**

- 取证结论：本实例窗口内 3 张「（Agent 未产生文字回复）」空卡
  **全部紧跟 HMR 热重载、且属于另一个 chat**，与 `/plan` 无关
  ⇒ 按「没有证据就不动代码」**不加守卫**，继续观察。

- **守护用例**：smoke **45** 重写（批准走 `/plan off`；「继续修改」**必须抛错**；
  非飞书 agent / 空计划仍必须 `next()`）、smoke **46** 不变（插话换新卡 + 彩色块）。

### Fixed（第二轮：计划审查换通道 ＋ 插话换新卡 ＋ 醒目提示，2026-10-02）

**① 计划审查卡**仍然**到不了飞书 ⇒ 换通道到【工具层】**

- 真机复现：把 `user-questions/request` 监听**下沉到 `agent.ctx`** 之后，日志里只有注册行
  `user-questions/request: bound to agent scope for fs-main-muppqw21`，
  **没有任何** `[agent-scope]` / `[root]` 的**接管**行；harness 侧收到的是
  `The user dismissed the plan review to speak instead`
  ⇒ 该水位线被 GUI 侧**整条吃掉**（`dsh-api-remotes` 的 forwarded waterfall 先答，
  只有远端不接才 `next()`），**与监听挂在哪一层无关**。
- 修法：改在 **`tools/execute`** 上拦 `exit_plan_mode` —— 它是**工具**
  （`dsh-plan-mode/lib/index.js:231` 的 `ctx.tools.register`），与 `ask_user_question`
  **同一个 dispatch**，而拦 `ask_user_question` 是本插件**线上验证过可用**的通道。
  - **批准** ⇒ 调 `planMode.set(agent, false)`（与 `/plan off` 同一条官方通道，
    **真的退出计划模式**，不是只回一句话）＋ 回给模型的文案与 plan-mode 原文**逐字一致**；
  - **继续修改** ⇒ `isError: true` ＋ 反馈原文，绝不误批准；
  - **非飞书 agent / 空计划正文** ⇒ `next()`（红线：绝不吞别人的提问）。
  - 原 `user-questions/request` 监听**保留作兜底**（不冲突：工具层先返回就不再派发水位线）。

**② CM 追加：「我插话了以后，你应该新开卡片。不然我说的话全部堆到下面，你一直在旧卡片上更新」**

- 修法：插话复用答题后那套 `split()` —— 旧卡就地封口并留一行
  「📨 你的消息已插话送达 —— 后续内容见下方新卡。」，**新卡第一块**就是醒目提示
  （`split(notice)` 新增 `{ old, fresh }` 参数；不传时行为与原来完全一致）。

**③ CM 追加：「这一句不够明显，加个框、加粗、或者换个颜色」**

- 新增块类型 `notice`，渲染为 `hr` ＋ `column_set(background_style: 'orange-50')` ＋ `hr`，
  正文 `**📨 你的消息已插话送达**` 加粗。
- 颜色取自飞书官方枚举（14 色系 + 深浅后缀，**`-50` 的语义就是「区块背景」**）；
  `column_set` **不支持** `border`（会被 API 拒 `ErrCode 200621`），底块只能靠 `background_style`。
  **换色只改一个常量** `STEER_NOTICE_BG`（候选：`blue-50` / `wathet-50` / `yellow-50`）。
- **隔离**：`notice` **不参与** `cardTableCount`（只数 message/note）、
  **不参与**「本轮结论」摘要提取 —— 不会污染表格额度与结论判定。

**④ 顺带修的稳健性问题**：`activeTurns` 以 **agent id** 为键，而插话查找原先用 **session id**
（生产上二者恰好相同，但不是同一件事）⇒ 改为按「该会话绑定的 agent」查、session id 兜底。

- **守护用例**：smoke **45**（工具层接管／批准调 `set(agent,false)`／带说明当反馈／
  非飞书 agent 与空计划必须 `next()`）、smoke **46**（插话换新卡／旧卡封口指路／
  彩色底块 + 加粗标题）。
- **测试基建**：smoke mock 补上 `planMode` 服务注入 —— 此前 `ctx.inject` 对 planMode
  不触发，`planModeRef` 永远是 null，「批准后真的退出计划模式」这条分支**从未被测过**。

### Fixed（事故：本次改动一度让**所有飞书消息被静默吞掉**）

- **现象**：真机日志 `duplicate inbound skipped` 连发，CM 报「所有飞书信息你收不到」（4 条被吞）。
- **根因**：新加的 `steerActiveTurn` 第一句就调 `isDuplicateInbound()` —— 它**有副作用**
  （把 id 记进 `seenInboundIds`）。一旦 steer 没走成（没有活跃回合／agent 没有 `steer`）
  函数 `return false` 落到 `handleInbound`，那里再查一次 ⇒ 已「见过」⇒ 判重投丢掉。
- **修法**：新增只读的 `inboundAlreadySeen()`；`steerActiveTurn` 只**窥探**，
  **仅当 steer 真的投出去之后**才 `isDuplicateInbound()` 认领。
- **守护用例**：smoke **43**（`/plan <正文>` 建卡／过程进卡／正文不重复投递）、
  smoke **44**（无 steer 能力时消息照常投递、照常建卡；同 `message_id` 重投仍去重）。

## [0.4.14] - 2026-10-01

### Fixed（计划模式退出申请在飞书上**完全收不到** —— CM 报障「计划模式退出的时候，我收不到你的退出申请」）

**根因（同一种提问，插件只拦了一条链路）**：`exit_plan_mode` 调的是 **`ctx.userQuestions.ask(...)` 服务**
（`@deepseek-ai/dsh-plan-mode/lib/index.js:261`），**不经过** `ask_user_question` 工具；
而本插件此前只拦 `tools/execute` 上的 `ask_user_question`（`index.js` 里那条 `tools/execute` 拦截）
⇒ 计划审查请求只发给了**连着长连接的 GUI 客户端**，飞书侧一个字节都收不到，
模型那一轮就停在"等审批"上（用户侧表现＝没有任何动静）。

- **修法**：补一条与 `approval/request` **同构**的水位线 `user-questions/request`。
  依据：`userQuestions.ask` 的派发＝`ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', …)`
  （`@deepseek-ai/dsh-user-questions/lib/index.js:69`），而 `approval/request` 是同款派发
  （`@deepseek-ai/dsh-user-approval/lib/index.js:179`）＋本插件根级 `ctx.on('approval/request')` 线上已验证可用。
  - **只接管飞书自己的会话**：`findChatForAgent(agent)` 取不到 owner（GUI 会话／子代理）一律 `next()` 交回 harness ——
    **绝不吞掉别人的提问**。
  - **卡面**：header「📋 计划已写好，等你批准」，正文＝**完整计划 markdown**，
    选项行给中文说明「批准并执行（退出计划模式）」「继续修改（留在计划模式，回我文字即可）」。
  - **回传协议保持原 label**（`Approve` / `Keep planning`）：中文只是卡面文案 ——
    plan-mode 判批批准判的是 `selected[0] === 'Approve'`，污染了就会静默失效。
  - **文字回复**：整条消息**精确命中** `approve / 批准 / 同意 / 确认` 才算批准；
    带补充说明（例「同意，但第 2 步先改成只读排查」）按"继续修改"的反馈回给模型。
    方向是刻意选的：误判成"留在计划模式"可恢复，误判成"已批准"不可恢复（会立刻开工）。
- **守护用例**：smoke **42**（水位线接管／非飞书 agent 必须 `next()`／计划正文必须在卡上／
  按钮回传原 label／文字别名＝批准／带补充说明＝反馈／普通问句卡不受影响）。
- **部署**：junction＋HMR，保存即热重载 ⇒ 日志 `[fs] plugin apply #12 v0.4.13 md5=9a7fc238 bytes=204168`。
  ⚠️ 版本标记在 **apply 时**读 `package.json`，所以落地那一刻日志仍写 v0.4.13；
  **代码身份以 `md5=9a7fc238` 为准**，下次重载即显示 v0.4.14。

## [0.4.13] - 2026-10-01

### Fixed（per-bot `splitConclusionMinMs` 配置通道从未生效 —— 由"表面 × 覆盖"扫描抓出）

**发现方式**：目标轮 3 改用**系统性扫描**（把 `index.js` 里真实注册的命令／环境变量／`bot.cfg` 字段／路由／
工具名逐个丢进 `smoke.mjs` 里查），25 个表面中 16 个零覆盖 → 给其中两条补断言时，**用例 38 当场把这条逼了出来**。

- **根因**：`normalizeConfig()` 用**显式字段白名单**清洗配置，
  `reactionEmoji / ownerOpenId / notifyGoalRounds / notifyAgentNotices` 都在名单里，
  **唯独漏了 `splitConclusionMinMs`** ⇒ 写进 `feishu.config.json` 会被丢掉
  ⇒ `conclusionSplitMinMs(bot)` 永远读到 `undefined` ⇒ **0.4.4 起承诺的"bot 配置优先、10s 热读免重启"只有 env／默认值成立**。
- **证据（两条独立）**：① 同一份配置里 `notifyAgentNotices=false` 生效（回执 0 动作，证明配置确实被重读），
  而 `splitConclusionMinMs=600000`（env 同时设 0）仍分卡；② 代码白名单里就是没有这个字段。
- **修法**：白名单补上该字段（含 `Number.isFinite && >= 0` 校验）。
- **守护用例**：smoke **38** —— **由红转绿**（`bot 配置 600000 压过 env=0 ⇒ 不分卡`）；
  同时把 `notifyAgentNotices=false` 从零覆盖变为有断言。
- **部署**：junction＋HMR ⇒ 保存即热重载，**无需重启、无需 sync**（日志 `plugin apply #3 … md5=f36e3ae1 bytes=198141`）。

### Added（admin 路由首次有守护 —— 用例 39）

- `/feishu/admin/status`：响应**不含 appSecret 明文**（只给 `hasSecret` 布尔）。
- `/feishu/admin/config`：GET 把 appSecret 掩码成 `***` 且响应不含明文；POST 写入**必须走归一化**
  （白名单外字段被丢弃 —— 正是本轮 bug 的机制）；不支持的方法返回 405。

## [0.4.12] - 2026-10-01

### Fixed（引用的卡片"认得出来，但摘要没信息量"）

**真机现象（CM 引用重启后发出的卡）**：`（你在引用这条消息：bot 的回复卡片：正在工作中…）`
—— 落盘生效了（不再"未登记"），但摘要是**建卡那一刻的占位符**。

- **根因**：`rememberMessage` 只在 `syncCard` 的 **create 分支**登记一次，而那一刻卡片里只有
  `正在工作中…`（真正的内容要等封口才成形）⇒ 登记的等于没登记。
- **修法**：
  1. 新增 `cardLabel(card)`：跳过占位符/指路语（`正在工作中…`／`继续处理中…`／`✅ 本轮完成，结论见下方卡片。`…），
     **取最后一段正文**（封口后的结论最有信息量）；还在跑的卡退到**最后一条过程话语**（如 `🎯 目的行`）；
     都没有则给中性文案 —— **绝不留占位符**。
  2. `syncCard` **每次成功同步（create 或 PATCH）都刷新一次摘要**。
- **守护用例**：smoke **35** 扩充两条断言 —— ① 索引里**不许**出现含「正在工作中」的摘要（**先跑出红色基线**：
  `❌ …实际：["bot 的回复卡片：正在工作中…"]`）② 封口后的结论必须被登记。
- **部署**：**本次只 `npm run sync`，不重启**（CM 2026-10-01 明令「不要动不动就重启」）
  ⇒ 改动会在**下一次**重启时生效，当前进程仍跑 v0.4.11。

### 教训（自己的，记进本地档案）

- **禁止用 PowerShell 重写文本文件**：`(Get-Content -Raw) -replace … | Set-Content -Encoding UTF8`
  在 Windows PowerShell 5.1 下会写入 **UTF-8 BOM**（`EF BB BF`）⇒ Node 的 `JSON.parse` 当场抛错，
  `npm run sync` 直接失败。**改文本一律用文件工具**（本次已用 `write` 工具重写为无 BOM）。
  这与 `~/.dsh/AGENTS.md` A22-⑦（PS `>` 写 UTF-16）是同一类量具/工具陷阱。

## [0.4.11] - 2026-10-01

### Fixed（引用透传真机验收暴露：重启后"引的是哪张卡"查不出来）

**真机现象（CM 第一次真机验引用透传）**：长按引用一张卡片 → 注入会话的正文里出现
`（你在引用这条消息（内容未登记，可能是更早的消息））` —— **透传通了，但摘要查不到**。

- **取证**：CM 引的卡 `om_x100b64d11132f0a0b0484fbba40a0ca` 建卡于 `web.log` **65263 行**，
  而本次重启是 **65275 行** ⇒ 那张卡是**上一次进程**发出去的。
- **根因**：`recentMessages`（message_id → 摘要）**只在内存**，dsh 重启（改插件代码/框架升级）即清空
  ⇒ 重启前发出的一切卡片/消息都成了"未登记" —— 而参考/引用的卡片恰恰多半是上一轮的，命中率极低。
- **修法**（零新增飞书权限，沿用已有 state 目录）：
  1. 索引落盘到 `~/.dsh-feishucard/message-index.json`（`rememberMessage` 后 300ms 防抖写、`unref` 不拖进程）；
  2. 启动时加载（日志 `[fs] message index loaded: N entries`）；
  3. `quoteHintFor()` **未命中时再读一次盘** ⇒ 覆盖"本进程启动前登记的消息"。
- **不做**：仍然**不猜内容** —— 真查不到就照实写「内容未登记」（`~/.dsh/AGENTS.md` A24）；
  调用 `GET /im/v1/messages/{id}` 需要新增读消息 scope，**待 CM 决定**。
- **守护用例**：smoke **35** —— ① 索引文件里必须有卡片 message_id 与「bot 的回复卡片：…」摘要；
  ② **直接往磁盘索引写一条内存里没有的记录**（＝模拟"上一次进程登记的卡"），再喂一条引用它的入站消息，
  断言摘要能读出来（此断言只有"未命中时重读盘"才可能通过）；③ 真未登记的消息仍写「内容未登记」。

## [0.4.10] - 2026-10-01

### Fixed（结论卡的"单卡回退"形同虚设 ⇒ 结论会丢）

**发现方式**：CM 问「卡片还有哪些是改动过、但没有测试的？」→ 逐条审计改动 × smoke 断言 × 真机记录，
**补写守护用例时当场把这条逼了出来**（用例先红、修完才绿）。

- **根因**：`syncCard()` **内部吞异常** —— 建卡/改卡失败只在 catch 里置 `createFailed`／`circuitOpen`，
  **不往调用方抛**。而结论分卡那条路径写的是 `try { await syncCard(…conclusion…); … } catch { 退回单卡 }`
  ⇒ `catch` 只可能被第二行之后的代码触发，**建卡失败根本进不去回退分支**；
  结果是：过程卡封口写着「✅ 本轮完成，结论见下方卡片」，而**下面那张卡不存在**
  （真机日志特征：`conclusion card opened … card=-`），结论只能靠纯文本兜底、卡片链条断掉。
- **修法**：`await syncCard(…conclusion…)` 之后**自己检查 `conclusion.token`**，拿不到就抛进 catch；
  catch 里补回结论后**必须把过程卡 PATCH 上去**（`footerMode` 同时升级为 `full` —— 它此刻就是结论卡）。
- **守护用例**：smoke **34**（mock 新增 `failCreatesFrom`：只让"结论卡那一次"建卡失败，
  断言判据落在 **PATCH 载荷**上 —— 因为失败的 create 载荷也会进 `sentCards`，靠"载荷里有没有这句话"会假绿）。

### Added（补测审计发现的空白 —— 全是"改过但没人验"的分支）

- **smoke 33**：① `goalStateText()` 的 **paused / blocked / complete** 三个分支（此前一次都没被执行过）；
  ② **`goal/changed` / `goal/activation-changed` → 刷新已在飞书上的活跃卡**（`refreshLiveCards`，
  此前 smoke 0 触发、真机 0 次）。判据要求出现 **PATCH** 且载荷同时含「目标模式」与**刚改过的状态**。
- **smoke 32 扩充**：`/plan`、`/goal` 的命令失败**回注 agent** 也断言（此前只有 `/compact` 那条被验过）。
- **反向验证（防假保险丝）**：把 `ctx.on('goal/changed')` 临时改名 → smoke 33 当场变红，"去掉修复就失败"成立。

## [0.4.9] - 2026-10-01

### Fixed（`/compact` 第二次报错：`Cannot read properties of undefined (reading 'length')`）

**发现方式**：**由 0.4.8 新加的"命令失败回注 agent"自动叫醒 agent** —— CM 没贴报错，agent 自己知道并开查
（这条通道上线后第一次实战就抓到了自己的下一个 bug）。

- **根因（我 0.4.7 只修了一半）**：0.4.7 把 `signal` 挪到第 4 位后，第 3 位我填了 `undefined`；
  但注册表里是 `let attachments = NO_ATTACHMENTS; if (submittedAttachments.length > 0) {...}`
  —— **第 3 位必须是数组**（`NO_ATTACHMENTS = Object.freeze([])`），传 `undefined` 就在 `.length` 再抛一次。
- **修法**：三处统一 `commands.execute(agent, line, [], new AbortController().signal)`。
- **守护用例**：smoke 32 的断言从「第 3 位保持 undefined」**改成**「第 3 位必须是长度 0 的数组」
  —— 原来那条断言本身就在**保护错误行为**（断言写错＝把 bug 钉住），一并纠正。

## [0.4.8] - 2026-10-01

### Added（命令失败自动回注 agent —— 报错不再只有用户知道）

**CM 原话**：「能不能报错能直接知道，提醒到 agent 啊？」

- **痛点**：斜杠命令（`/compact` `/goal` `/plan`）在**会话链之外**执行 —— 命令炸了，
  用户看到一句报错，而 **agent 完全不知道**（它那一轮早就结束了）。
  真机事故就是：`/compact` 抛 TypeError，agent 直到 CM 把报错贴过来才知道 = **能自愈却等用户救**。
- **改法**：新增 `reportCommandFailure(agent, bot, chatId, what, error)`：
  1. 先建一张卡承接 agent 被唤醒后的这一轮（复用自动卡机制，标题写「⚠️ <命令> 执行失败 · 正在排查…」）；
  2. 再把失败**注入会话并唤醒 agent**（`agent.send(..., 'next-turn', true)`，正文含 `[系统回执]` 前缀＋原始错误），
     提示它"排查原因、用人话告诉用户现在什么情况"。
  - 接入点：`/plan`、`/goal`、`/compact` 三处 `catch`（原来只 `console.log` ＋（compact）回用户一句）。
- **守护用例**：smoke 32 增加断言 —— 命令抛异常时**既回用户、也必须回注 agent**（注入正文含原因）。

## [0.4.7] - 2026-10-01

### Fixed（`/compact` 报 `Cannot read properties of undefined (reading 'aborted')`）

**CM 真机反馈**：发 `/compact` 收到「压缩失败：Cannot read properties of undefined (reading 'aborted')」。

- **根因（传参错位，我的锅）**：harness 的签名是
  `commands.execute(agent, line, submittedAttachments, signal)` —— **signal 在第 4 位**，第 3 位是附件。
  旧代码三处调用都写成 `execute(agent, line, signal)` ⇒ 真正传进注册表的 `signal === undefined`
  ⇒ 注册表第一行 `if (signal.aborted)` 当场抛 TypeError。
- **连带发现（同型，长期潜伏）**：`/plan` 与 `/goal` 也是错位传参 ——
  异常被各自的 `catch` 吞掉后**静默走了兜底分支**（所以 `/goal` "看起来能用"，
  实际从未走通 command-goal 的注册表实现，pause/resume/clear/edit 的完整语义一直没生效）。
- **修法**：三处统一改成 `execute(agent, line, undefined, new AbortController().signal)`。
- **守护用例**：smoke 32 记录**全部实参**并断言
  「signal 必须在第 4 位（`typeof signal.aborted === 'boolean'`）／第 3 位保持 undefined」，
  `/compact` 与 `/goal` 两条通道都断言 —— 这类"位置传错被 catch 吞掉"的坑，靠断言钉死。

## [0.4.6] - 2026-10-01

### Changed（A 方案：过程卡不摆状态栏，状态栏只归结论卡 / 自动卡）

**CM 原话**：「过程卡片不显示状态栏，只有结论卡片才显示，可以吗？」（追问后选定 **A**）

- 新增卡片字段 `footerMode`：
  - `'full'` = 灰底状态栏（状态 ｜ 目标 ｜ 上下文占比 ｜ 缓存命中）——**结论卡**与**自动卡**（目标轮/回执轮）用；
  - `'bare'` = 一条 `hr` ＋ 一行裸状态（`运行中…` / `✅ 已完成` / `失败`）——**普通回合的过程卡**用。
- 判定时机：分卡只有到**封口**才知道 ⇒ 过程卡先设 `bare`；若**不满足分卡条件**（短任务），
  封口时**升级为 `full`**（那张卡本身就是结论卡，状态栏该在它身上）。
- 自动卡（目标轮/回执轮）**保留完整状态栏** —— CM 之前专门要的「目标有没有停/丢」就在那里看，不能误伤。
- **守护用例**：smoke 31 增加三条断言（过程卡无状态栏 / 过程卡留裸状态 / 结论卡带完整状态栏）。
  判据用「目标模式」这条状态栏专属文案 —— **`grey-50` 不能当判据**（工具折叠面板也是 grey-50，踩过一次）。

## [0.4.5] - 2026-10-01

### Added（飞书端 `/compact`：压缩上下文）

**CM 原话**：「压缩上下文在飞书卡片里面应该发什么指令啊？现在是支持的吗？不支持的话得加上」。

- **查证**：harness 侧**有** `@deepseek-ai/dsh-command-compact`（模块名 `command-compact`，
  注册 `/compact`，无参数，内部调 `compaction.compactNow(agent, signal, commandId)`）；
  但插件命令白名单是 `['help','new','switch','list','plan','goal','stop']` —— **没有 compact**
  ⇒ `/compact` 落到"非命令"分支，被当成**普通消息**发给模型，**压缩根本不会发生**（用户以为按了、其实什么都没做）。
- **改法**：`COMMANDS` 加 `compact`；新增 `/compact` 分支 —— 走与 `/goal` 同一条注册表通道
  `commands.execute(agent, '/compact', signal)`，把上游返回文本回给用户；
  注册表里没有该命令（插件未装载）时**明确回「压缩不可用」**，不静默。
- **已知前置条件（上游语义）**：**agent 必须空闲**，否则返回 busy
  （"this process has an active compaction, or the agent is not idle"）；无历史时返回 "No compactable history yet."
- **守护用例**：smoke **32**（路由到 `commands.execute` ＋ 结果可见 ＋ 未装载时明确告知）。
- `/help` 文本与 README 命令列表同步补齐。

## [0.4.4] - 2026-10-01

### Fixed（结论分卡阈值太低：短任务也被拆成两张卡）

**CM 反馈（v0.4.3 上线后当场）**：「短任务都变了两张卡了」。

- **真机取证**：两次分卡的 `elapsed=12136ms / 13753ms`、`tools=1` ——
  即 12~14 秒的短任务也被分卡；而"有工具调用"这条触发条件**对几乎每一轮都成立**（实测每轮至少 1 个工具），
  **形同虚设**，等于把 10 秒阈值也架空了。
- **改法**：**删掉"有工具调用"这条触发条件**，**只按耗时**判定；
  阈值 `CONCLUSION_SPLIT_MIN_MS` 默认 **10s → 30s**，并且改成**可热更新**：
  1. bot 配置 `splitConclusionMinMs`（`feishu.config.json`，**10 秒热生效、不用重启**）优先级最高；
  2. 其次环境变量 `DSH_FEISHU_SPLIT_MIN_MS`（进程级）；
  3. 都没有 → 默认 30000ms。
  取值在**每次封口时判读**（不是启动读一次）⇒ 可热调、测试也能逐用例设定阈值。
- **守护用例**：smoke 31 改成"达标（阈值压到 0ms）→ 2 张卡"／"未达标（默认 30s，即使调了工具）→ **1 张卡**"；
  `conclusion split` 日志新增 `threshold=` 字段，便于事后核对判据。

## [0.4.3] - 2026-10-01

### Added（结论独立成卡 + 状态并入状态栏 —— CM 定 B 方案）

**CM 原话**：「每一个卡片最后都有一个『进行中』和『已完成』的状态……它在运行，但运行完了以后却没有提示……
把『进行中』和『已完成』的状态并到那个状态栏里面；当它变成『已完成』的情况下，单发一条很简单的信息过来提醒……
为什么不做成结论那一块单独发一张卡片呢？大模型要输出结论了，肯定有信号的。」

- **信号（协议级，不靠猜文案）**：DSH 的回合靠"这一步还有没有工具调用"决定是否继续 ⇒
  **assistant/message 里只有文字、没有工具调用 = 这就是结论**。
- **分卡规则（CM 选 B）**：本轮 **有工具调用** 或 **耗时 ≥ `CONCLUSION_SPLIT_MIN_MS`（10s）**
  ⇒ 封住**过程卡**（它退化成"工作日志"，结论从它身上摘掉，只留一行「✅ 本轮完成，结论见下方卡片。」）
  ＋ **新开一张结论卡**（新消息 ⇒ 飞书会**提醒**）。短问答（无工具、<10s）维持单卡，不制造噪声。
  - 结论卡建卡失败 ⇒ 自动退回单卡（结论补回过程卡），**回复绝不因此丢失**。
  - `recentTurnCards` 改登记**结论卡**（它是本轮最后一张，自动轮接续时不会跑到它上面）。
- **状态并入状态栏**：`goalFooterElements()` 把 `statusTextFor()`（运行中／已完成／失败）写在**状态栏栏首**
  （`运行中… ｜ 🎯 目标模式 … ｜ 🧠 上下文占比 ｜ 💾 缓存命中`）；`buildCardPayload` 不再单独输出状态行，
  仅在卡片没有 agent（读不到会话）时兜底保留独立一行。
- **守护用例**：smoke **31**（有工具→2 张卡且结论不重复；短回合→1 张卡）；
  smoke 2/18-21 的状态断言从 `_失败_` 改为「状态栏里确实是这个词」（`statusShows()`）。

### Tests（v0.4.3）

- `npm run check` ✅ ＋ `SMOKE PASS（95 cards / 31 cases）`，既有用例全绿。

## [0.4.2] - 2026-10-01

### Changed（子代理回执：有活跃卡时**并入卡片**，不再发独立消息）

**CM 原话**：「它弹出来的时候，如果主会话还在更新的话，它会一直留到最后……不要去把它当做一个标签一样，
它现在就弹出来了以后就一直沉在活跃卡片的下面，那这样其实不好看的呀。」

- **机制原因**：飞书消息按**创建时刻**排位；独立通知发出后位置就固定了，而上面那张流式卡还在原地 PATCH
  ⇒ 通知被"钉"在活跃卡下面，像一块贴纸。
- **改法**：`announceSubagentNotice()` 顺序改为 ——
  1. 有 **活跃飞书回合卡** ⇒ 只把「🔔 子代理 … 已完成」**并进那张卡**（`appendNote` + PATCH），**不发任何独立消息**；
  2. 有 **活跃自动轮卡** ⇒ 同上；
  3. **会话不活跃**（没有卡在跑） ⇒ 才走双层播报（纯文本 + 详情卡）——这种情况通知就是最新的那条消息，位置正确。
- 卡处于熔断/建卡失败状态时自动退回纯文本（不会把通知吞掉）。
- **顺带补上观测缺口**：`sendPlainText` 成功后会打 `[fs] notice plain text sent: …`（此前只有失败才留痕，
  导致"纯文本是否送达"无法从日志核对）。
- **守护用例**：smoke **30**（whenIdle 挂起制造活跃卡 → 断言"回执到达时只 PATCH、不发新消息，且内容进了那张卡"）。

## [0.4.1] - 2026-10-01

### Fixed（回归红线 R1：点击卡片后，后续内容必须写到【新卡】上）

**CM 原话**：「弹卡片以后，我点击卡片了之后，**所有的内容都要在新卡片上去新增**。不然我看到的就是
——你弹了卡片给我，我点击了，但是你不动了，因为你在旧卡片上面持续的去新增……
我看到的最后一条消息就是你给我选择的东西。」

- **失效场景（真机实测，0.4.0 期间发生）**：问答发生在**自动轮**（回执轮/目标轮）里时，
  答题后的 `split` 只查 `activeTurns`（飞书**入站**轮）——自动轮不在那张表里 ⇒ **静默跳过** ⇒
  内容继续写进用户已经划过去的那张旧卡 ⇒ 用户观感「我点了，它却没动」。
- **修法**：
  1. 新增 `splitLiveCardAfterAnswer(agentId)` 统一入口：**入站轮 → 自动轮兜底**；
     两条路都没有时**必须打日志留痕**（静默跳过正是这次回归的根因）；
  2. 新增 `makeAutoCardEntry(...)`：自动轮卡片也带 `split()` —— 冻结旧卡
     （去掉「正在工作中…」、写「✅ 已收到你的选择，继续处理中…」）＋ 开新卡（游标＝当前事件位置，不重放）；
  3. **新卡必须立刻 `syncCard(...)` 建出来** —— 只登记不建卡的话，用户点完按钮什么都看不到。
- **守护用例**：smoke **29**（自动轮里提问 → 点按钮 → 断言"旧卡封口 + 新卡已建"）。

### Changed

- 版本 0.4.0 → 0.4.1；新增本地档案 `DEV-PURPOSE.local.md`（记录开发目的与回归红线，命中 `*.local` 不进 Git）。
- **目的行格式改口径**（CM 2026-10-01 当场要求）：`🎯 目的：<正文>` → **`🎯 <正文>`**（去掉"目的："三个字）。
  插件侧判据本来就是"以 🎯 开头"（`PURPOSE_LINE_RE`），**无需改代码**；只同步约定（`~/.dsh/AGENTS.md`）与注释/用例文案。

## [0.4.0] - 2026-10-01

飞书端四项体验改造 + 引用透传（CM 计划模式逐条拍板；全部改动集中在 `index.js`）。

### Fixed（子代理回执不自动弹卡 — 判定时点竞态）

- **根因（真机实证）**：旧实现只在 `agent/status === 'running'` 那一拍回扫"最后一条 `user/message`"，
  而回执消息要等 `turn/start` **之后**才写进会话 ⇒ 判成普通回合 ⇒ 直接 return，**一张卡都不开**。
  实证（会话 `fs-main-mup1y7yi`）：`turn/start(seq1023) → agent-message relay(seq1026) → subagent-settled(seq1035)`。
- **反向样本**：DSH-BA 会话（`fs-main-mumyza49`）里 136 轮中有 26 轮"回合启动时最近一条 user/message 是回执"
  ⇒ 该 agent 打出 19 张 `kind=notice` 卡 —— **是同一 bug 的另一面（误判撞对）**，卡片不带 id、归因不可靠。
- **修法**：新增**独立于回合状态**的回执轮询（1s）＋ 判据换成正式字段 `source.kind === 'subagent-settled'`
  （正文正则降级为兜底）；命中即**双层播报**：①`sendPlainText` 纯文本（载荷最简、必达）
  ②详情卡（含正确子代理 id，卡面写明"这是通知，不用回这张卡"）。
  普通飞书回合正在跑时**只发文本不建卡**（避免两张卡同内容）；`childId#seq` 去重；首次见到 agent 只登记游标不回放历史。

### Added（卡片底部「目标条」）

- `buildCardPayload` 末尾（状态行之前）新增折叠面板：**折叠＝一行**「目标模式状态 ｜ 🧠 上下文/窗口（占比） ｜ 💾 缓存命中率」，
  **点开＝状态/续行/创建时间 ＋ 目标全文**。
- 状态文案覆盖 `active+armed / active+disarmed（⚠️续行已停）/ paused / blocked / complete`；
  `disarmed` 那一格专门解决"dsh 重启后目标还在但续行停了"看不见的问题。
- 数据源：`goals.state()/runtimeState()/view()`、`assistant/message` 的 `data.usage`
  （口径实测：`total = input + cacheRead + output`；上下文＝`input+cacheRead`）、`request/context.contextWindow`。
  **读不到就整块不显示**（try/catch 静默降级，绝不让卡片因此炸掉）。
- `goal/changed`、`goal/activation-changed` → 刷新活跃卡。

### Changed（选项卡：分栏换行 + 去掉 5 个上限）

- 旧实现用 1.0 `action` + 按钮（`plain_text`、单行、≤100 字符）⇒ 长选项必被截断成 `…`（CM 实测"按钮上面全是三个点"）。
- 改为 **JSON 2.0**：每个选项一行 `column_set`（`flex_mode:'stretch'` ⇒ 宽屏并排、窄屏自动上下堆叠），
  正文列 markdown（自动换行、显示全文）＋ 按钮列「选它」。
- **去掉 `QUESTION_MAX_BUTTONS = 5`**：选项 >5 不再被静默丢弃；回传值 `{fs_question, fs_option}` 不变，点击逻辑零改动。

### Added（引用回复透传）

- 入站读 `message.parent_id/root_id/thread_id`；本地登记 `message_id → 摘要`（机器人发出去的卡片/消息 +
  CM 发来的消息，最近 300 条），命中引用时把「（你在引用这条消息：…）」随正文注入会话。
- 只用本地登记表 —— **不新增任何飞书权限**。

### Fixed（中文目的行不被截断切掉）

- `clipNoteText`：500 字截断后若 `🎯` 目的行丢失，把它补回（目的行是过程里信息密度最高的一行）。

### Tests

- smoke 新增 5 组用例（24-28）：回执落盘即播报＋不重复、目标条五态与上下文/缓存、选项卡 2.0 分栏＋6 选项不丢、
  `parent_id` 透传、目的行抗截断。`npm run check` + `npm run smoke` 全绿（72 cards / 28 cases）。

## [Unreleased]

### Fixed（同一个群同时挂着两个会话 / 目标轮另开一张卡 → 用户"一个内容发两次"）

**用户原话**：「为什么你一个内容还是发两次呢？这个问题不是已经修复了吗？你查一下这个什么问题？什么原因？」

- **先排除（真机取证，不是推测）**：
  1. 拉该群最近 **200 条**消息 → 机器人**只发卡片**（app 发的非卡片消息 **0 条**）、
     **没有任何两张卡在 5 秒内成对出现**（129 张卡 / 71 条用户消息）⇒ **不是"飞书消息发了两条"**。
  2. 源码与 profile 运行副本 **MD5 一致**（`F1BC8472`，151615 字节）；运行进程 09-23 **04:15** 启动，
     晚于 09-23 那次修复（03:49）⇒ **那次修复仍生效**；它的日志指纹（用户消息进来后紧跟
     `auto card opened … kind=notice`）在最近 1500 行日志里 **0 次命中**。
- **根因两条（均有 web.log 实证）**：
  1. **目标轮另开一张卡**：`turn sealed` → `card reply delivered` 之后**紧接着**
     `auto card opened: agent=… kind=goal round=1`。目标卡与普通回合卡**同源镜像同一批会话事件**
     → 用户看到同一段内容出现在两张卡上（与 2026-09-23 那条 CHANGELOG 描述的机制同型）。
     09-23 的 `activeTurns` 守卫只覆盖了 `notice`（回执轮），**`goal` 这条路没覆盖**。
  2. **`/new` 没停旧会话**：`/new` 只把 `active` 切到新会话，旧会话继续被后台 job 唤醒、
     继续往**同一个群**发卡（web.log 里两个 agent 的 `auto card opened` 交替出现；该段
     **卡片/用户消息 = 1.82:1**；旧会话的会话文件最后写入停在 19:40:15）。
- **修法（三处）**：
  1. `openGoalCard()` 增加第 5 参 `existing`：**目标轮开卡前先查 `recentTurnCards`**
     （普通回合卡封口时登记；条件＝同一个群 ＋ `AUTO_CARD_REUSE_MS = 3 分钟` 以内 ＋ 该卡有 token 且未熔断）
     → **复用那张卡**（沿用它的游标继续镜像、只补一行 🎯 目标模式头），不再另开。
     日志打 `[fs] auto card reused chat=… msg=… kind=goal`。
     **回执轮（notice）保持原行为** —— 它是子代理／后台 job 唤起的独立一轮，单独一张卡更好认
     （smoke 22/23 覆盖该行为）。
  2. `/new`：切新会话**之前**先 `cancel({ kind: 'user' })` 停掉旧会话的 live agent（同一套 live lookup，
     缓存句柄可能指向 hmr 后的陈旧实例）；回执文案追加「（旧会话 X 已停 —— 避免两个会话同时往这个群发卡）」，
     并打 `[fs] /new: cancelled previous live session <id>`。
  3. **留痕（可取证）**：飞书对 2.0 卡片只回占位符 `{"title":null,"elements":[[img,"请升级至最新版本客户端，以查看内容",""]]}`，
     **正文读不回来** → 建卡时打 `[fs] card created chat=… msg=<message_id> elements=N payload_md5=<8位>`；
     封口时把 `turn sealed` / `auto card sealed` 补上 `reply_md5` / `reply_len` / `card=` / `blocks=`
     （目标轮为 `closing_md5` / `closing_len`）。以后「同一段内容两张卡」可直接按指纹在日志里对上。
- **回归用例**：23 条全绿（`SMOKE PASS (sentCards=57, sessions=4)`）。用例 13／19 的断言按新契约改成
  「目标轮**没有多开卡**（create ≤ 1）」＋「🎯 卡面确实出现（新建或复用）」——
  旧断言写死 `create === 1`，会把"复用"判成失败。

### Fixed（一次回复发两张卡：普通飞书回合被当成"回执轮"抢建了第二张卡）

**用户原话**：「你现在每次回复我都发两张卡片，你查一下什么原因，修复掉」。

- **现象（真机取证，不是推测）**：拉该会话最近的飞书消息，**最近 29 条可判定的回复里有 10 条**
  在同一秒出现两张 interactive（`im/v1/messages` 返回两条、`create_time` 相同）。
- **根因（四环，逐环有据）**：
  1. dsh-agent-loop 的 `wakeDriver()` 在 `send()` 的**同一个调用栈**里
     `setPhase({ kind: 'running' })` → 同步 `dispatch.emit('agent/status')`
     （`@deepseek-ai/dsh-agent-loop/lib/index.js` L781／L787／L844）。
  2. `runTurn()` 旧实现把 `activeTurns.set(...)` 放在 `turnAgent.send(...)` **之后**，
     于是 `agent/status` 处理器在同一拍读 `activeTurns` 时读到"没有普通回合持有卡"。
  3. 这一刻新用户消息还在 agent 的 inbox 里、**尚未进会话事件表**，`autoTurnInfo()`
     从末尾扫到的 `user/message` 是**上一条后台回执正文** ⇒ 判成 `kind = 'notice'`。
  4. `openGoalCard()` 于是另开一张卡；它的游标与普通回合卡同源 ⇒ 两张卡镜像同一批事件，
     用户看到内容重复的两张卡（真机日志特征：用户消息进来后紧跟着
     `[fs] auto card opened: … kind=notice`，然后才是普通回合卡）。
- **修法**：`runTurn()` 改成**先登记 `activeTurns`、再 `send()`**（`send` 抛错时回滚登记）；
  `stopCardWatcher` 提前声明为 `null`；`split()` 加空值保护。`agent/status` 里那道
  `if (activeTurns.has(agent.id)) return  // 普通飞书回合持有卡，绝不抢` 从此真正生效。
- **回归用例 23**（`scripts/smoke.mjs`）：mock 的 `send()` 改成与真机同序（先同步 running、
  再写助手事件），并让会话末尾先是一条回执正文。**对照实验**：把修复前的 `index.js`
  换回去跑同一套 → 用例 23 报 `❌ 普通回合只建一张卡（实际 2 张）`（exit 1）；
  换回修复版 → `SMOKE PASS`。
- **没有误伤**：真正的回执轮（`kind='notice'`）照旧建卡 —— 用例 23 控制组 + 用例 22 全绿。

## [0.3.4] - 2026-09-21

### Added（子代理／后台任务回来时**自动上卡**）

**用户原话**：「经常拍了子代理以后，就算子代理返回的信息，你也不会自动唤醒……**我要子代理回来，
就会发信息激活你，你就继续工作并发信息我**」。

- **根因（两层）**：
  1. 子代理／后台 job 结束时，DSH 会往同会话注入一条 `source.kind === 'plugin'` 的 `user/message`
     **把模型唤醒继续干活** —— 这一轮**没有飞书入站消息**，而本插件的建卡入口 `runTurn` 只从
     飞书入站调用 ⇒ **没有任何卡承接这一轮**：CM 在飞书里既看不到"我在继续干活"，
     也收不到这一轮的结论（只能再发一条消息把我戳醒）。这与 2026-09-16 目标轮"看不到过程"
     是**同一个结构性缺口**（那次只补了 `source.kind === 'goal'`）。
  2. 探测函数把通知正文读成空串：`user/message` 的正文在 `data.content`，而代码只读
     `data.message.content`（写用例 22 时当场抓到 —— 所以就算加了白名单也永远不匹配）。
- **修法（复用目标卡那一整套机制）**：`currentRoundIsGoal()` → `autoTurnInfo()`，返回
  `kind: 'goal' | 'notice' | null`：
  - `source.kind === 'goal'` → 目标轮（行为不变）；
  - 正文命中白名单 `^\s*(background job|background subagent|后台任务|子代理)` → **回执轮**，
    卡面写「🔔 子代理回执到了 · 正在继续工作…」，走同一套 watcher／补扫／封口／换卡；
  - 其它 plugin 消息（runtime context／技能目录／系统提醒）→ **不建卡**（不许刷屏）。
- **开关**：env `DSH_FEISHU_NOTICE_CARDS=0` 全局关；per-bot 配置 `notifyAgentNotices: false` 单独关
  （`normalizeConfig` 已接受该字段）。
- 日志：`[fs] auto card opened: … kind=notice|goal`、`[fs] auto card sealed: … kind=…`。

### Tests

- 新增用例 **22**：回执轮建卡（🔔／正在继续工作／本轮结论进卡／正常封口）＋**控制组**
  （system-reminder 类 plugin 消息**不建卡**）。
- `npm run check` 通过；`npm run smoke` **SMOKE PASS（sentCards=53）**。

## [0.3.3] - 2026-09-21

### Fixed（用户反馈：「卡片里面欠费了，它不会提示我欠费，不会把报错信息报出来，就直接显示说『本轮没有回复』」）

**三处一起改，都是从真机取证反推出来的：**

1. **上游错误翻成人话**：`failureSummary()` 新增 `failureZh()` ——
   `QUOTA/402/Insufficient Balance → 「账户欠费／余额不足」`、`401 → 「API 密钥无效或未授权」`、
   `429 → 「被上游限流（请求过快）」`、`503 → 「上游暂时不可用」`、上下文超长 → `「上下文超长」`。
   **中文人话在前、上游原文在后**（`账户欠费／余额不足｜Insufficient Balance · QUOTA 402`），
   认不出就不编（原样透传）。真机现场：卡面只有英文报文时，用户读不出"这是欠费"。
2. **不再把报错换成「已自动重建会话重试」**：上游**已明确报错**时**跳过自愈**
   （重建会话修不好欠费／密钥／限流，旧行为每条消息白跑一轮重试＋二次失败）。
   自愈**只保留给**「无产出**且没有**失败标记」的僵尸会话场景（2026-09-08 那个 bug 的保护未动）。
3. **"一个原因都不给"这条路彻底堵死**：无产出**且没有**上游失败标记时，卡面写
   `⚠️ 本轮没有产生回复：上游没有给出失败标记（原因未上报 —— 见 dsh 日志／GUI 里这一轮）`，
   状态行 `_失败_`（不再退回干巴巴的 `（Agent 未产生文字回复）`，也不再假称「✅ 已完成」）。
   目标模式封口同源修正（无产出无标记时写 `❌ 本轮失败`，不再写 `✅ 本轮结束`）。

### Added（可观测：卡面文字进日志）

- 封口时打一行 `[fs] turn sealed: status=… silent=… failure=… reply="…"`（含失败原因与卡面正文前 160 字），
  目标卡同理（`[fs] goal card sealed: … failure=… silent=…`）。
  **为什么需要**：飞书对 card 2.0 只回降级占位符，**事后读不回卡片正文** ——
  本次排查就卡在"用户看到的到底是哪一句"无法证实；以后 `grep 'turn sealed'` 即可复盘。

### Tests

- 用例 17 按新行为改写（**只 1 张卡＝不再自愈**；断言中文原因 `账户欠费`＋上游原文＋不再出现「已自动重建会话」）。
- 新增用例 **20**（无产出且**无**失败标记）：断言卡面写「原因未上报」、状态 `_失败_`、
  **僵尸自愈仍然生效**（`已自动重建会话` + 重试回复交付）——把"自愈只留给无标记场景"钉住。
- 新增用例 **21**（429）：断言 `被上游限流` ＋ 上游原文。
- `npm run check` 通过；`npm run smoke` **SMOKE PASS（sentCards=51）**。

## [0.3.2] - 2026-09-18

### Fixed（目标模式轮次失败也谎报成功）

- 与 0.3.1 同源、但漏在**目标模式**那条路径上：`agent/status === 'idle'` 封口时**无条件**写
  `✅ 本轮结束` 且 `card.status='sealed'` → 上游报错（如 402 余额不足）导致整轮零产出时，
  目标卡同样"看不出为什么不动了"，还显示成功。现在：读上游显式失败标记
  （`turnFailureReason(sessionEvents(agent), live.openedAt)`）→ 无产出时写
  `⚠️ 本轮没有产生回复：<原因>`、状态行 `_失败_`、封口写 `❌ 本轮失败`；正常轮保持 `✅ 本轮结束`。

### Added（复验与部署的"可观测"补强）

- **构建标记**：`apply` 现在打印 `[fs] plugin apply #N v<版本> md5=<前8位> bytes=<大小> @ <ISO>`
  （版本读**部署目录**的 `package.json`，md5 为自身文件）→ 复验"线上跑的是哪一版"只需一条
  `grep 'plugin apply'`，不必再靠外部哈希比对。元数据陈旧（副本曾长期停在 0.2.0）会因此**暴露**。
- **`scripts/sync-to-profile.mjs` + `npm run sync`**：按 `package.json#files` 体检 → 备份
  `index.js.bak-<ts>-pre-sync` → 同步整包 payload 到 profile 副本 → **按哈希复验**（不一致退出码非 0）。
  `--dry-run` 只体检。背景：本包在 profile 里是**实体副本**，手工 `cp index.js` 是元数据漂移
  （副本 `package.json` 停在 0.2.0、`SECURITY.md`/`CHANGELOG.md` 落后）的根源。

### Docs

- `README.md` 的「Windows 开发陷阱」段更正：明确 **HMR 对本包不生效**（实测保存源码 75 秒零 reload，
  运行时 import 的是 profile 副本、HMR 只听源码目录），部署姿势改为 `npm run sync` + 重启 + 用
  `plugin apply` 标记复验；「开发」段补 `npm run sync`。
- `~/.dsh/AGENTS.md` ① 同步更正（原文"HMR 热重载已启用、改源码即生效"作废），并补：日志文件随启动器
  变化需按修改时间取最新、想让当前卡片先发出去可先等 10 秒再调重启脚本。

### 影响面清单（§10.1-3）

| 被改对象 | 还有谁在用 | 会不会变样 |
| --- | --- | --- |
| `apply` 日志行 | 只有人/脚本看日志 | 格式新增版本与哈希；`plugin apply #N` 前缀不变，旧 grep 仍命中 |
| `buildStamp()`（模块级新增） | 只有 `apply` | 只读自身文件与同目录 `package.json`；读失败降级为 `stamp failed: …`，不影响启动 |
| 目标卡封口 `card.status` | `statusTextFor`（→`_失败_`）、`rotate()` 的 `state.card.status !== 'running'` 守卫 | 仅"失败轮"置 `error`；此时 watcher 已 `stop()`，守卫不再触发 |
| `scripts/sync-to-profile.mjs` | 只有开发者手动跑 | 新增文件，不参与运行时 |

### 验证

- `npm run check` 通过；`npm run smoke` **全绿**（sentCards=47）。
- 新增用例 **19**（目标轮 402 失败）：断言卡面有原因、封口写「本轮失败」、**不再**出现「本轮结束」、
  状态行 `_失败_`；用例 16（目标轮成功）仍要求写「✅ 本轮结束」——两条一起构成"该成功成功、该失败失败"。
- **保险丝验证（§10.2-6）**：改 `index.js` 前先跑用例 19 → **恰好 4 条断言失败**，修复后全绿。
- `npm run sync -- --dry-run` 在改前正确报出 5 个 stale 文件（index.js / package.json / CHANGELOG.md /
  SECURITY.md / feishu.config.example.json），改后同步并哈希复验一致。

## [0.3.1] - 2026-09-18

### Fixed（2026-09-18，CM 反馈：bot 突然不回话，卡片只说「没有回复内容」，不知道发生了什么）

**根因（两类，都被同一处"哑巴卡"掩盖）：**

1. **上游报错时卡片不写原因**：模型 API 返回 `402 / code=QUOTA / "Insufficient Balance"` 时，
   整轮**没有任何 `assistant/message`** → 旧实现只把占位符「（Agent 未产生文字回复）」写进卡，
   状态行还显示 **`_✅ 已完成_`** —— 用户既看不到原因，还被告知"完成了"。
   真机取证（会话 `fs-main-mu532zzl`，`output/dsh-install/dump-session-tail.mjs` 解码 zstd 帧）：
   ```
   seq=724 user/message  "你看一下新创建这个agent，为什么回复我显示没有回复内容呢？"
   seq=725 assistant/attempt {"stream":[{"chunk":{"type":"finish","reason":{"kind":"error",
           "failure":{"message":"Insufficient Balance","code":"QUOTA","status":402}}}}]}
   seq=727 turn/end  {"reason":{"kind":"error","error":{...402...}}}
   ```
2. **自愈提示走不到卡片上**：`!hadOutput && sessionReused` 时插件会重建会话重试，但提示只拼进
   `turn.reply`，而卡片送达用的是 `turn.card.blocks` → **只有卡片失败退化成纯文本才带这句**；
   同时被丢弃的旧卡已经在飞书建出来了（14:35:28 那张），**永远停在「正在工作中…」**。

**修法（最小改动，全部围绕"卡面必须说实话"）：**

- 新增 `turnFailureReason(events, fromSeq)` / `failureSummary(failure)`：**只读上游显式标记**
  （`turn/end.data.reason.kind==='error'` 优先；无 `turn/end` 时才退回 `assistant/attempt` 的
  `finish.reason`）——`turn/end` 是终审，避免"中途失败后重试成功"的回合被误判（开发标准 §10.2-2）。
- `runTurn` 封口：本轮一个字都没说出来 **且** 有失败标记 → 卡面写
  `⚠️ 本轮没有产生回复：<上游原因>`，状态行改 `_失败_`；没有失败标记时维持原占位符（不编造原因）。
- `runTurn` 的 `waitError` 分支：同样去掉「正在工作中…」并写 `⚠️ 本轮中断：<错误原文>`。
- 自愈分支：重试前先把**旧卡的封口状态推上去**（不再留孤儿卡）；重建提示 `⚠️ 上一会话本轮没有产生回复
  （<原因>），已自动重建会话重试。` 同时**写进卡面 blocks** 与 `turn.reply`（纯文本兜底也带）。

**影响面清单（§10.1-3）：**

| 被改对象 | 还有谁在用 | 会不会变样 |
| --- | --- | --- |
| `runTurn` 返回值新增 `failure` | 只有 `runTurn` 的两个调用点（普通回合、自愈重试） | 只增字段，既有消费者（`turn.card/reply/hadOutput/waitError`）不变 |
| `card.status = 'error'`（封口路径） | `statusTextFor`（→`_失败_`）、`rotateTables`/`split` 的守卫 | 仅"本轮失败且无输出"时置位；此时 watcher 已停止，守卫不再触发 |
| 自愈分支新增一次 `await syncCard(旧卡)` | 无 | 只 PATCH 已存在的旧卡；建卡失败（createFailed）时 `syncCard` 自行跳过 |
| `turn.card.blocks.unshift(提示)` | 只影响该卡渲染顺序 | 提示置顶；工具面板/正文其余块不动 |

**验证：**

- `node --check index.js` 通过；`npm run smoke` **全绿**（sentCards=45）。
- 新增用例 **17**（复刻真机 402 事件流：无任何 assistant/message → 自愈重试同样失败）：
  断言卡面有 `Insufficient Balance · QUOTA 402`、有 `⚠️`、状态行 `_失败_`、不出现 `_✅ 已完成_`、
  带"已自动重建会话"、且**没有任何卡停在「正在工作中…」**。
- 新增用例 **18**（功能交互，§10.3）：有工具调用 → `hadOutput=true` 不自愈；断言**工具面板仍在**、
  参数摘要仍在、原因在、状态 `_失败_`、不假称完成（工具面板 × 失败提示 × 状态行同一条数据流）。
- **保险丝验证（§10.2-6）**：改动前先跑新用例 → **恰好 6 条断言失败**（基线见本文档与
  `output/` 留痕），修复后全绿 → 说明每条断言都真的在保护这个行为。

**落地复验（2026-09-18 15:00，重启后实测）：**

- **部署路径**：本包在 profile 里是**实体副本**（`node_modules/dsh-feishucard` 不是软链），
  而 HMR 只监听源码目录 → 实测**保存源码 75 秒无任何 reload**（`hmr watching` 之后始终没有第二次
  `plugin apply`）。故本次按「**同步副本 → 重启**」部署：
  `Copy-Item index.js <profile>/node_modules/dsh-feishucard/`（旧版备份
  `index.js.bak-20260918-pre-no-reply-notice`）。
- **落地副本复验**：把**部署副本的** `index.js`（md5 `D6E3BC2A`，与源码逐字节一致）配
  `scripts/smoke.mjs` 单独跑一遍 → `SMOKE PASS (sentCards=45)`（含用例 17/18）。
- **重启后状态**：新实例 14:59:12 启动、`plugin apply #1` 14:59:31、三个机器人
  `long connection ready`、**无任何错误行**；HTTP 3080 = 200。
- **会话连续性**：`state-cliaaf77f129a78dcc8.json` 仍指向 `fs-main-mu6l3up7`，重启后入站消息
  **没有触发自愈**（日志无 `produced no output` / `heal`）→ 上下文未丢。
- **"先发卡再重启"有效**：重启前那条卡片 14:58:42 正常送达
  （`om_x100b65fa5cd4d8acb28fe532c6bbb0d`）。
- 遗留（未改，供决策）：① 目标模式轮次封口仍无条件写「✅ 本轮结束」，那一轮失败同样看不出原因；
  ② 副本里的 `package.json`（0.2.0）/`CHANGELOG.md` 是旧元数据（部署只同步 `index.js`）；
  ③ 插件没有"版本→日志"的标记行，复验只能靠 md5 比对与行为断言（可加一行 `plugin apply #N (md5)`）。

## [0.3.0] - 2026-09-18

### Not a defect（2026-09-16 已核实，避免重复排查）

**「卡片只有工具、看不到它中途说的话」= 模型本来就不在中途说话，不是卡片吞了内容。**

CM 追问后按**轮**切开会话日志统计（脚本 `output/dsh-install/analyze-narration.mjs`），结论：

- 每个回合都**只有 1 段文字，且发生在最后一个工具之后**（即收尾总结），**"开场说话"次数恒为 0** ——
  它从不说"我先去查一下 X"再动手，而是闷头调工具、最后交一段报告。
- 大量"思考"在 `reasoning` 块里（最近 150 条 assistant 消息中 **105 条有 reasoning、仅 25 条有 text**；
  reasoning 合计 ~15.6 万字 vs text ~3.2 万字）—— **`extractProcessText()` 只取 `text` 块，reasoning 不推送**，
  这是 2026-08 起的既有设计（源码注释：*"reasoning blocks are NOT pushed"*），**不是缺陷**；
  CM 2026-09-16 明确表示**不需要**后台思考过程，只要"它说出来的话"，故不做 reasoning 面板。
- 因此卡片显示"工具 → 结果"是**忠实反映**；真正被丢掉的只有目标轮的**收尾报告**（见上一节 Fixed，已修）。
- 若将来想让卡片出现"它正在做什么"的自然语言，只能让**模型多说**（给它加执行风格约定）或由卡片
  从工具调用机械生成旁白；CM 本轮判断"它就是这么工作的，不用改"，故**不做**。

### Fixed（2026-09-16，CM 实测反馈：目标轮卡片"只有工具记录、一句话都没有"）

**根因：目标卡封口时缺少"补扫"（catch-up scan），每轮的收尾汇报被丢掉。**

- **取证**：FU 机器人 `fs-main-mu2yt7oi` 目标模式 round 2~6 的卡片日志全程 `notes=0`（只有 `tools` 在涨）；
  直接解码会话日志（多个独立 zstd 帧拼接，需逐帧解码）却能看到整段文本：
  `seq=1901597 blocks=[reasoning,text] "**进度（第 4 轮）…"`、`seq=1906069`、`seq=1911432` … → **不是模型没说，是管道丢的**。
- **机理**：工具调用在轮内陆续到达，被 300ms 的 card watcher 拍到；**每轮的"进度（第 N 轮）"汇报在轮结束前最后一刻才生成**
  → 落在最后一拍之后。普通回合 `runTurn` 封口有补扫（注释原文：*"if the turn finished faster than the watcher's
  poll interval, fold every event into the card now so narration and tool panels are not lost"*），
  而目标卡的 `agent/status === 'idle'` 分支**直接封卡**——我写这段时只对齐了"建卡"，没对齐"封口"。
  （round 1 之所以正常，是因为那张卡走的是普通回合路径。）
- **修法（对齐既有路径，最小改动）**：目标卡封口前 ① `scanCard(agent, card)` 补扫；
  ② 新增 `lastAssistantTextSince(agent, fromIndex)` 把本轮**最后一段话提升为正式消息块** ——
  过程话语有 500 字截断，而进度汇报通常远超 500 字，截断后看不到实质内容；
  搜索用 `live.openedAt`（本卡开始镜像的位置）界定"本轮说过的话"，**本轮没说话时绝不搬上一轮的文字**。
- **验证**：`scripts/smoke.mjs` 用例 **16**（末刻到达的中途话语 + 工具调用 + 收尾汇报，中间不给 watcher 任何一拍）。
  **保险丝验证（§10.2#6）**：把补扫那一行临时改成 `void 0` 重跑 → 恰好两条"只有补扫能做到"的断言失败，恢复后 SMOKE PASS。
  证据链存档：`output/goal-card-missing-text-2026-09-16.md`。

### Added（2026-09-16，CM 需求：飞书里"切换会话/工作区"）

CM 原话：「能不能在飞书里面做一个"切换会话"的命令？① 我打一个命令 ② 它能展示目前可切换的
一些会话或者工作区 ③ 然后我切换过去」。方案经 CM 拍板（"先按你的来"）。

- **无参数 `/switch`** → 一张卡片，分三组列出候选，**每行两个按钮**：
  ① 本聊天的会话（现有 `chat.sessions`，当前项标 ▶）② 本工作区的其它会话（含 GUI 里开的）
  ③ 其它工作区（`<其它工作区>`、`Ai100` …）。卡面顶部常驻「当前会话 + 工作目录」，并写明图例
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
