# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
