# dsh-feishucard — DSH ↔ Feishu Streaming Card Bridge

把飞书（Lark）机器人接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 会话——完全自研（非 fork）。官方 SDK **长连接**收发（无需公网 IP/域名/隧道）、每聊天独立专属会话、`/new /switch /list /help` 命令、处理中表情回执，以及**流式回复卡片**：过程话语内联 + 工具调用折叠面板 + 限流/退避/熔断/文本兜底。

A self-developed (not a fork) bridge between Feishu (Lark) chats and DeepSeek Harness agent sessions: official-SDK long connection (no public URL needed), dedicated per-chat sessions, `/new /switch /list /help` commands, a typing reaction, and a **streaming reply card** — inline agent notes, collapsible tool-call panels with status symbols, and rate-limit / backoff / circuit-breaker / plain-text fallback reliability.

> 📌 **需求与功能状态的唯一登记处 = `需求与功能清单.md`**（CM 2026-10-06 裁决建立：「所有的功能清单放在那里，我提需求就在里面补一句，完成了就打个勾」）。
> 接手前先读它：☐=没做，🔴=**已裁决但没实现**（漂移，优先做），✅ 才有证据。本 README 只放门面与部署现状，`CHANGELOG.md` 记"哪版改了什么"，`功能基线.md` 记"哪条判据由哪个用例钉住"。

## 功能矩阵 / Feature matrix

| 功能 | 说明 |
|:--|:--|
| 流式回复卡片 | 过程话语内联 + 工具调用折叠面板（带状态符号）+ 内联 agent 备注；失败时纯文本降级 |
| 单实例多 bot | 一个 DSH 实例挂多个飞书机器人，各自绑定 workspace 与 `AGENTS.md` |
| 群里 @ 才回复 | 群聊只在被 @ 时处理（避免多 bot 互相刷屏）；单聊照常全处理 |
| 审批卡 / 提问卡 | 工具审批与 `ask_user_question` 直接落到飞书卡片，点按钮即回 |
| `/switch` 两级选择 | 先选工作区（与 GUI 侧边栏同源），再选会话：接管或新建；另有 `/list` `/new` `/help` |
| 身份注入 | 入站消息按 `open_id` 解析为「人」；工具入参里的身份字段由身份表覆写 |
| Agent 互认（0.8.0） | 群里 @ 到了谁、这条消息是谁发的、卡片被谁点的——三个身份都会标注并喂给 agent；出站 `@[名字]` 展开成**真 @**（能唤醒对方 bot）。🔴 **只标注、不授权**：权限仍然只认身份闸门解析出来的那个人 |
| bot 名单采集 | `scripts/collect_bot_roster.mjs` 采集同群 bot 的 `union_id` / 本应用视角 `ou`，插件按 mtime 热读。飞书成员接口**只返回人不返回 bot**（真机取证 V5），所以名单必须自己采 |
| 群接力（默认关） | `groupRelay` 默认 `self_only`＝与旧版一字不动（没 @ 本 bot 的群消息一律忽略）；显式 opt-in 才放宽，内置三层防互刷预算 |
| 长连接收发 | 官方 SDK WebSocket 长连接，无需公网 IP / 域名 / 隧道 |
| 可靠性兜底 | 限流 / 退避 / 熔断 / 纯文本降级；helper 崩溃后可自动拉起 |

English summary: streaming reply card, many bots in one instance (own workspace + `AGENTS.md` each),
mention-gated group replies, approval / ask cards, two-level `/switch` picker, identity injection,
long-connection transport, and rate-limit / backoff / circuit-breaker / text fallback.
Since 0.8.0 also: agent mutual recognition (who was mentioned, who sent the message, who tapped the
card — annotated for the agent, never used as authorization), outbound `@[name]` that really pings
another bot, a collected bot roster, and an opt-in group relay with anti-loop budgets (default off).

单包即用：Host 插件（桥接逻辑）+ helper 子进程（长连接）+ bundle 补丁（自动注册）。One package, three pieces: host plugin, long-connection helper subprocess, and an auto-registered bundle patch.

> 独立自研，不依赖任何第三方 DSH 飞书插件。配置独立存放于 `~/.dsh-feishucard/`；检测到旧生态路径（`~/.cc-connect/`）有配置时启动自动迁移一次。不要与其他 DSH 飞书插件同时安装（同一飞书 App 的 WS 长连接互踢）。
> Fully independent. Config lives in `~/.dsh-feishucard/`; a legacy config found at `~/.cc-connect/` is auto-migrated once on boot. Do not install alongside other DSH Feishu plugins (two WS long connections on one app kick each other).

> ✅ **更正（2026-10-02 实测，推翻本文件 2026-08-15 / 2026-09-18 的旧结论）**：本机 DSH profile 里
> `~/.dsh/profiles/web/node_modules/dsh-feishucard` 是**目录联接（Junction）**，直接指向本仓库
> （`Get-Item` 报 `LinkType: Junction`、`Target: <本仓库路径>`）⇒ **改源码 = 改 profile 副本**，
> 配合 `@deepseek-ai/dsh-hmr`（0.2 起；0.1.x 时期为 `cordis-plugin-hmr`）**保存即热重载**。
> **实证**：2026-10-02 同一轮里连续 4 次保存，日志依次出现 `plugin apply #8 / #9 / #10 / #11`，
> 每次的 `md5` / `bytes` 都与源码一致。
> **旧结论「实体副本、HMR 覆盖不到源码、必须 sync + 重启」在本机不成立，已作废。**
> 若你的安装方式不是 Junction（例如 `file:` 物化出实体副本），`npm run sync` 仍是正确兜底 ——
> 体检 + 备份 + 同步 + 哈希复验，`--dry-run` 只体检（退出码非 0 = 副本与源码不一致）。
> 复验"线上跑的是哪一版"：`grep 'plugin apply' <dsh日志>`，行内含 `v<版本> md5=<前8位> bytes=<大小>`。
>
> Corrected 2026-10-02: on this machine the profile entry is a **junction** to this repo, so the HMR
> watcher and the running copy coincide — **saving the source hot-reloads the plugin** (verified:
> `plugin apply #8–#11` on four consecutive saves). The older "copy, not symlink ⇒ sync + restart
> required" note is stale; `npm run sync` remains the correct fallback for non-junction installs.

> ⚠️ **重启 dsh web 必须走带 key 的启动器（2026-09-08 事故教训）**：部署机上 `DEEPSEEK_API_KEY` 通常放在**用户环境变量**（Windows 注册表 `HKCU\Environment`）——它不在 dsh 凭据文件里、dsh 也没有 .env 层去读它。**裸 `node <dsh包>/lib/bin.js web` 启动 = 进程没有 key = 所有 LLM 调用失败 = 飞书全部空白回复**。需要重启时，请通过你本机的 dsh 启动脚本/计划任务（会先注入用户环境变量再拉起 dsh）；**不要 kill 进程后用裸 node 拉起**。排查"为什么空白回复"先看进程环境里有没有 `DEEPSEEK_API_KEY`。

> ⚠️ **session 事件 API 跨版本差异（2026-09-14 事故教训）**：DSH **0.1.0-rc.5（公开版）**暴露的是
> `agent.session.events`（数组，下标=seq）；**0.1.2-rc.1（内含 dev 版）**把它废弃为
> `agent.session.snapshotEvents()`。两者不通用——写死任一版本都会在另一版本上炸
> （0.1.0-rc.5 上写死 `snapshotEvents` 的症状 = 入站消息一进 `runTurn` 就
> `TypeError: snapshotEvents is not a function`，**机器人收消息但永不回复**）。
> 本包统一走 `sessionEvents(session)` 兼容取值（有 snapshot 用 snapshot，否则退回 events），
> 改这块代码前先确认目标版本的**真实** API（以部署机上实际运行的那版为准，不是 dev 仓库）。

## 功能 / Features

- **长连接收发 / Long-connection messaging**：`im.message.receive_v1` 官方 SDK WebSocket → 注入 Agent 会话 → 交互卡片回复同一会话，全程无需公网地址。Official SDK WebSocket; no public IP, domain, or tunnel required.
- **流式回复卡片 / Streaming reply card**：
  - 收到消息即建卡「正在工作中…」，agent 干活时实时 PATCH 更新。A card appears instantly and is PATCH-updated live as the agent works.
  - **过程话语**（agent 每步说的话）按事件顺序内联可见。Inline agent narration, in event order.
  - **工具调用折叠面板**：🛠️ 每工具一行「状态符号 · 工具名 · 参数摘要 · 失败原因」，默认折叠。Collapsible tool-call panels: status symbol, tool name, arg summary, failure reason per line.
  - 完成 sealed：最终回复入卡、状态行消失、面板保持折叠。Sealed with the final reply; status line removed.
  - 可靠性：串行更新队列 + 400ms 限流合并 + 指数退避 + 5 次熔断 + 15s 超时 + 卡片失败自动降级纯文本。Serialized queue, 400ms coalescing, exponential backoff, 5-failure breaker, 15s timeout, text fallback.
- **每聊天独立会话 / Dedicated per-chat sessions**：每个飞书聊天专属 Agent 会话池（绝不串进 GUI 会话）；首条消息自动创建；持久化 + 重启恢复（live 会话直接复用、上下文不丢）；`/new [名称]`、`/switch`（**先选工作区 → 再选该工作区的会话**）、`/list`（当前工作区的会话）、`/plan [off]`、`/goal`、**`/compact`（压缩上下文；agent 空闲时才可用）**、`/stop`、`/help`。Never shares GUI sessions; auto-created on first message; live sessions are reused across restarts so context is preserved.
- **处理中表情 / Typing reaction**：消息到达加 `OnIt`，回复送达后撤销（`reactionEmoji` 可配，`none` 关闭）。`OnIt` reaction added on arrival, removed after delivery.
- **工具 / Model tool**：`feishu_send`（agent 主动发消息，`appId` 指定机器人，缺省发到最近会话）。Proactive messaging from the agent.
- **审批卡片 / Approval card**：dsh 会话的工具调用需要确认时（audit 哨兵等），飞书弹出交互卡片「✅ 允许一次 / ❌ 拒绝」按钮，点击即回决策（`card.action.trigger` 长连接事件）；**10 分钟**超时自动拒绝（2026-09-16 由 3 分钟延长；卡面文案由 `APPROVAL_TIMEOUT_MIN` 推导，不再写死）、会话取消自动取消——避免飞书通道下审批无人应答导致会话永久挂起。Approval `approval/request` for plugin-owned sessions is answered via a button card; timeout auto-rejects. **默认开启**（见上方开关表）。
- **审批走服务层直连（2026-10-02，0.2 适配）**：DSH 0.2 起 `@deepseek-ai/dsh-api-remotes` 的 forwarded
  waterfall 会在**根级更早**截走 `approval/request`（只要浏览器端连着就交给 GUI），插件监听**永远轮不到**
  —— 实测升级后 `approval/request received` 出现 **0 次**（0.1.x 时代有 70 次），症状就是「审批只弹电脑、
  飞书收不到卡」。修法：**包一层审批服务的 `decide()`**（工具是按对象取的：`ctx.get('approval')`），
  只接管飞书自己的会话，GUI / 子代理的审批原样交回。现已覆盖**沙箱越权升级**
  （`sandbox_permissions` + `justification`）这类此前拦不到的请求。
  Since 0.2 the GUI bridge pre-empts `approval/request` at the root scope; the plugin now wraps the
  approval **service's `decide()`** instead, so escalations reach Feishu (GUI/subagent approvals still delegate).
- **已授全权时不弹卡（2026-10-02，0.4.18）**：插件的这道闸过去**不看会话档位**，在
  `danger-full-access`（用户已给全部权限）下也会因为命令里出现 `ssh`／`curl` 等关键词而弹卡
  —— 实测 `git push` 的 `$env:GIT_SSH_COMMAND = 'ssh …'` 就连发了两张。
  现在 `tools/pre-execute` 先读 `ctx.get('sandboxPolicy').resolve({ session })`，
  **`mode === 'danger-full-access'` 直接放行**：**全权模式 = 零审批卡；受限模式 = 只有越权才弹卡**。
  When the session already runs at `danger-full-access`, the plugin adds no gate of its own.
- **保活 / Keep-alive**：helper 崩溃自动重启（5s 冷却防重复）+ 凭据变更自动重连 + SDK 自带重连 + 状态可观测。Crash-restart with spawn cooldown, auto-reconnect, observable connection status.
- **多机器人 / Multi-bot**：一个实例多个机器人，各自绑定工作区。One instance, many bots, one workspace each.
- **目标模式进度卡 / Goal-round progress cards（2026-09-16，经评审确定方案 A）**：目标模式（goal 模式）的续轮**不经过飞书入站**，过去在飞书完全看不到它在干什么。现在插件订阅 `agent/status`：某轮由目标轮驱动 → 自动建卡「🎯 目标模式 · 第 N 轮开始，正在工作…」，**复用与普通回合同一套**流式卡（过程话语 / 工具面板 / 表格换卡全部生效），轮结束封口写「✅ 本轮结束」。只报目标轮，其它自动回合不建卡（不刷屏）。Goal-round continuations never pass through Feishu inbound, so they used to be invisible; an `agent/status` hook now opens the same streaming card per goal round.
- **`/goal` 命令 / Goal command**：飞书里直接 ` /goal <目标> ` 即可让当前会话进入目标模式（透传到 harness 的 `command-goal`，`pause`/`resume`/`clear`/`edit <新目标>` 子命令同样可用；无参数 = 查看状态）。命令注册表不可用时兜底直连 `goals` 服务创建目标。`/goal <objective>` starts goal mode for that chat's session from Feishu; subcommands pass through to the harness command.
- **`/switch` 两级：工作区 → 会话 / Two-level workspace & session picker（2026-10-02 重做，维护者 定稿 A 方案）**：`/switch` 先发**工作区卡** —— 列出 DSH `workspaceRegistry` 里注册的工作区（**与 GUI 侧边栏同源**），每行显示路径、会话数、🟡 运行中数量、目录是否还在（⚠️ 不存在），并标出 ▶ 当前工作区，按钮「N 进入看会话」/「N 在这里新建」；点「进入」（或 `/switch <工作区序号>`）再发**该工作区的会话卡**，每行「接管 / 新建」，底部「← 返回工作区列表」。🟡 运行中的会话只给"新建"（同一会话被两处同时驱动会写坏历史）。文字兜底 `/switch <工作区序号> [<会话序号>|new]`；`/list` ＝ **当前工作区的会话**（当前工作区 ＝ 活跃会话的 cwd）。新建/接管时会话会**挂进工作区注册表**（best-effort）⇒ GUI 侧边栏也立刻看得到。`/switch` posts a workspace card first (from the DSH `workspaceRegistry`, the same source the GUI sidebar uses), then that workspace's session card; text fallbacks `/switch <ws> [<session>|new]`, and `/list` lists the current workspace's sessions.

- **文件收件 / File inbox（2026-09-09）**：飞书文件/图片/语音消息不再被静默丢弃——自动下载到 fileInbox（配置项，缺省 <workspace>/downloaded_files；**2026-10-02 前实际从未生效**：下载链读 `evt.msg_type` 而 `normalizeEvent()` 只给 `message_type` ⇒ 文件消息被静默丢弃；现在两个键都给，**失败也会明说** HTTP 码；**2026-10-03 起**：文件名**没有扩展名时按文件头补**（jpg/png/gif/webp/bmp/pdf/zip，认不出补 `.bin`；已有扩展名的原样保留），时间戳用**本地时间** `YYYY-MM-DD-HHMMSS`），并向会话注入「收到文件+本地路径」，agent 可直接读取。Inbound Feishu file/image/audio messages are downloaded to fileInbox and surfaced to the agent with a local path.
- **热重载打断提示 / Hot-reload interrupt notice（2026-10-02 复原并加固）**：保存插件源码即热重载（junction + HMR），而重载会拆掉插件作用域 ⇒ 正在跑的回合被 `aborted(disposed)` 中断。此时插件会在**该会话里**发一条纯文本说明（「♻️ 插件已热重载：上一轮被热重载打断（不是模型出错，也不是你的操作）…」），免得看起来像"说到一半莫名停了"。同一会话只提示一次（幂等）；重载时本来没有回合在跑 ⇒ **不发任何东西**（无噪声）。When a hot reload aborts an in-flight turn, the plugin posts an explanatory notice into that chat (once per session; silent when nothing was running).
- **子代理回执即播报 / Subagent settlement broadcast（2026-10-01 改造①）**：子代理一完成**立刻**播报 ——
  ① 纯文本（必达）② 详情卡（带**正确的子代理 id**）。判据是会话事件里的正式字段 `source.kind === 'subagent-settled'`，
  **不看回合状态**（旧实现在"回合启动那一拍"回扫，而回执比它晚落盘 ⇒ 永远不开卡）。
  普通飞书回合正在跑时只发文本不建卡（避免同内容两张卡）；`childId#seq` 去重。
  A settlement notice is broadcast the moment it lands (plain text + a card naming the right child), independent of turn state; per-bot `notifyAgentNotices:false` disables it.
- **卡片底部「目标条」/ Goal footer（2026-10-01 改造③）**：卡片最底部一个折叠面板 —— 折叠＝一行
  「目标模式状态 ｜ 🧠 上下文/窗口（占比） ｜ 💾 缓存命中率」，点开＝状态/续行/创建时间 ＋ **目标全文**。
  含 `⚠️ 已创建但续行已停（/goal resume 恢复）` 这一格：dsh 重启后会 disarm 所有活跃 goal，卡面直接可见。
  A collapsible footer showing goal state + full objective + context usage (%) + prompt-cache hit rate.
- **选项卡分栏换行 / Wrapping option card（2026-10-01 改造④）**：选项正文用 markdown（自动换行、全文显示），
  按钮只负责"选这一项"；`flex_mode:'stretch'` 让窄屏自动上下堆叠。**选项数量不再限 5 个**。
  Option text wraps (JSON 2.0 column layout) instead of being truncated inside a button; no 5-option cap.
- **引用回复透传 / Quote passthrough（2026-10-01 改造⑤）**：长按引用某条消息/某张卡片再回复时，
  被引内容的摘要会随正文一起进会话（「（你在引用这条消息：…）」）；只用本地登记表，不新增飞书权限。
  Quoted-message摘要 is injected into the session so the agent knows what the reply refers to; no extra Feishu scope needed.
- **计划审查卡 / Plan-review card（2026-10-01 起；2026-10-02 改版）**：计划模式里 `exit_plan_mode` 提交的**退出申请**现在会发到飞书 ——
  卡头「📋 计划已写好，等你批准」，正文是**完整计划**，底下一排**两个控件**：
  **`批准`＝整块可点击的深绿色块（`interactive_container` + `green-600`，白字居中）** / **`拒绝`＝红底白字按钮**（`danger_filled`）。
  也可以直接回文字（精确回「批准」/「同意」＝批准；带补充说明＝修改意见回给模型）。
  三条实现约束（都是真机踩出来的）：① 飞书 2.0 **按钮颜色枚举里没有绿色**；② 绿**不能**挂在
  `column.background_style` 上 —— 官方注明该字段**需客户端 v7.9+**（维护者 手机上根本没渲染），且会被
  `width:'fill'` 的按钮整列盖住 ⇒ 绿必须用**整块可点击容器**做；③ markdown 文字要 `text_align:'center'` 居中，
  且加粗**不能**跨在 `<font>` 标签里外（`<font color='white'>**批准</font>**` 会把标签原文当文字漏出来）。
  **为什么以前收不到**：`exit_plan_mode` 走的是 `userQuestions` **服务**（不是 `ask_user_question` 工具），
  旧实现只拦了工具那一层 ⇒ 申请只发给了连着的 GUI 客户端。现在补了服务层 `user-questions/request` 接管
  （与 `approval/request` 同构，仅接管飞书自己的会话；GUI/子代理的提问一律交回 harness）。
  `exit_plan_mode`'s review prompt now reaches Feishu via a service-level `user-questions/request` takeover, not just the tool-level one.

- **审批单卡 / Approval form（2026-10-03 新增；0.6.1 按真机反馈改版；0.6.2 起为可选通道）**：AI 要发「权限变更审批单」这类**可读可点**的单子时用它 ——
  卡面：**短值字段两列并排**（单号 / 置信度…）· **长文本各占一整行**（变更类型 / 证据来源…；判据见下）→
  ① 类别 × L 档变化（🔹不变 / 🔸收窄）→ ② 技能变化（➕新增 / ➖取消 / ✅不变）→ ③ 证据原文（引用块）→ ④ 影响面 → ⑤ 不批的后果 →
  **两个带色按钮**：`✅ 采纳`(primary 蓝) / `❌ 驳回`(danger 红)（没有「⑥ 操作」标题，也没有第三个「我要改」——要提意见直接回消息）。
  **短/长判据**：字段显式 `short:true/false` 优先；否则**纯 ASCII/数字且 ≤24 字 ⇒ 短**（并排）、**含中日韩文字 ⇒ 长**（独占一行）。
  **⚠️ 默认关（可选通道）**：要在 `~/.dsh-feishucard/feishu.config.json` 里给某个 bot 加 `"approvalForm": true` 才启用。
  **0.7.0 起改为「方案 B：工具始终注册」**——这样 Agent 能主动告诉你"这里有审批单通道、要不要开"；
  没开的 bot 调用会被**明确拒绝**并把"怎么打开"写在返回里（可被 AI 直接转告）。**改完 10 秒内自动生效，不用重启**。
  **分区可泛化**：除了本仓的「身份标签」预设（`categories/skills/evidence/impact/risk`），也可以直接给
  `sections: [{title, lines}]` 做**任意**审批单（标题自动补 ①~⑩）。
  两条触达入口：**工具 `feishu_approval_form`**（结构化参数，发卡后**等他点**，把选择当**工具结果**返回；
  目标会话自动取调用方 agent 的飞书会话，非飞书会话明确报错、绝不瞎发）· 或 `ask_user_question` 的
  `questions[0].card` 适配（回答按 `selected:[选择]` 回传，调用方零改动）。
  **硬规矩**：一张卡只装一个人、一件事；30 分钟没点 ⇒ **可见地**作废（卡变超时态 + 一条纯文本，**绝不默认通过或驳回**）；
  **点完只换按钮那一行、正文全留**（0.7.0；见下条"审批卡保留正文"），旧卡再点给可见提示而不是静默失败。
- **失败必须可见 / Fail-visible（0.7.0）**：卡片被飞书拒、熔断、重试耗尽 ⇒ ①**先抢救正文**（把发不出去的片段摘掉后重发纯文本）
  ②**告诉用户**（带飞书原始 `code`）③**给 Agent 一条可读回执**（它会知道自己"没送达"，不会以为发成功了就收工）。
  同一原因 **2 分钟**内只发一次；所有纯文本兜底都过**唯一收口点** `stripUnsendable()`（本地图片路径、卡片不支持的 HTML 标签）。
- **图片/文件真送达 / Real image & file delivery（0.7.0；0.7.1 补齐文件侧）**：飞书卡片图片**只认 `img_key`**（本地路径会让**整张卡**被拒），
  所以发卡前会把正文里的 `![](本地路径)` **自动上传换 key**（`im/v1/images`），图片真的显示；**0.7.1 起**本地**文件**链接
  `[季度报告.pdf](D:\…\x.pdf)` 走 `im/v1/files` 上传后作为**文件消息**发出（卡面只留「（文件已发送：…）」；同一 chat+path 只发一次，
  路径不存在则**原样不动**，不误伤普通超链接）。超限（图片 >10MB / 文件 >30MB）与权限不足都给**明确提示**；
  **附件安全闸（0.7.1）**：扩展名白名单 + 图片按文件头验真 + 凭证/密钥类名字与内容一律不传；
  **授权类疑似二维码不自动上传**（改发链接，遵守"授权只发链接"那条规矩）。
- **状态栏三模式 / Three session modes（0.7.0）**：状态栏首段是 `🧭 普通模式 / 📋 计划模式 / 🎯 目标模式`，
  判据是现成可读源（会话事件 `plan/mode` ＋ 目标快照），读不到就显示"普通"，不猜。
- **计划 → 目标承接（0.7.0）**：计划审批卡 = **行1**`批准/拒绝` ＋ **行2**整行 `🎯 以目标模式跑`；
  点行2 ＝ 退出计划模式 ＋ 用**计划全文**建目标 ＋ 卡变回执（正文保留）。建目标失败会明说，不留半截状态。
- **审批卡保留正文 / Keep the body after a tap（0.7.0）**：审批类卡片（计划审批卡、审批单卡）点完**不再撤消息、不再整卡重建**，
  只把**按钮那一行**换成「✅ 你已经审批过了：…（时间）」；超时/作废同理。
- **重载自动续跑 / Auto-resume after reload（0.7.0）**：插件热重载打断那一轮后，新实例不只播报，
  还会**自动把那一轮接上**（注入「从断点继续，别重做」）；每会话一次。
- **提问卡按钮上色 / Colored option buttons（2026-10-03）**：选项按钮现在带 `type`（飞书不传就是灰的）——
  规则：显式 `buttonType` > 词义（驳回/拒绝/取消… ⇒ 红）> 第一个 ⇒ 蓝 > 其余灰；**向后兼容**，不传不报错。
  `ask_user_question` option buttons now carry a `type` (primary / danger / default) instead of all being grey.

## 快速开始 / Quick Start

```sh
dsh plugin --profile web add dsh-feishucard
dsh web   # 重启 / restart
```

> 首次安装若提示 `ERR_PNPM_IGNORED_BUILDS`（pnpm ≥10 默认拦截 `protobufjs` 构建脚本）：编辑 `$DSH_HOME/profiles/web/pnpm-workspace.yaml`，把 `allowBuilds` 下的 `protobufjs` 改为 `true` 后重跑安装命令。
> If pnpm blocks `protobufjs`'s build script, set `allowBuilds.protobufjs` to `true` in the profile's `pnpm-workspace.yaml` and re-run.
>
> 本地开发安装 / local install: `dsh plugin --profile web add <本包目录>` 或 `file:<本包目录>`。

### 配置 / Configuration

写在 **`~/.dsh-feishucard/feishu.config.json`**（与仓库解耦 / decoupled from any repo）：

```json
{
  "bots": [
    {
      "name": "我的机器人",
      "workspace": "<你的工作区绝对路径>",
      "appId": "cli_xxxxxxxxxxxxxxxx",
      "appSecret": "your_app_secret",
      "reactionEmoji": "OnIt"
    }
  ]
}
```

会话状态持久化在 `~/.dsh-feishucard/state-<appId>.json`。配置支持热更新（10 秒轮询），改完无需重启。Session state persists to `~/.dsh-feishucard/state-<appId>.json`; config is hot-reloaded every 10s.

**开关 / Switches**（环境变量作用于整个插件进程 / env vars are process-wide）：

| 变量 / Variable | 缺省 / Default | 作用 / Effect |
| --- | --- | --- |
| `DSH_FEISHU_GOAL_CARDS` | `1`（开） | 设 `0` 全局关闭「目标模式进度卡」。Set `0` to disable goal-round progress cards. |
| `DSH_FEISHU_APPROVAL` | `1`（开） | **默认开启**。2026-10-02 改口径：「手机上得要能审批才行，**不可以关了**」（2026-09-16 的"默认关闭、不许改回"按  作废）。设 `0`／`false`／`off`／`no` 关闭。覆盖**沙箱越权升级**（`sandbox_permissions`）的审批。**会话已是 `danger-full-access`（用户已授全权）时一律不弹卡** —— 插件不再加一道（2026-10-02 修，见 CHANGELOG 0.4.18）。 |
| `FS_CONFIG_DIR` | `~/.dsh-feishucard` | 配置文件目录（测试用）。 |

per-bot 配置项 `notifyGoalRounds`（`false` 关闭该机器人的目标卡）写在 `feishu.config.json` 的对应 bot 里。Per-bot `notifyGoalRounds: false` disables goal cards for that bot only.

**`splitConclusionMinMs`（per-bot，毫秒，默认 `30000`）** —— 本轮耗时 ≥ 该值才把**结论单独发一张新卡**
（新卡＝新消息 ⇒ 飞书会提醒；过程卡退化成"工作日志"，结论不会重复）。短任务维持单卡。
设 `0` = 每轮都分卡。

> ✅ **2026-10-01 已修复（0.4.13）**：per-bot `splitConclusionMinMs` **现在真的生效** ——
> 此前配置归一化白名单（`normalizeConfig`）漏了这个字段，写进 `feishu.config.json` 会被丢掉
> （由 smoke 38 首次测「配置通道」时抓出）。**10 秒热读、不用重启**。
> 优先级：**bot 配置 → 环境变量 `DSH_FEISHU_SPLIT_MIN_MS` → 默认 `30000`**。

`splitConclusionMinMs` decides when a finished turn's conclusion is posted as a **new card** (so Feishu notifies).
Hot-reloaded from the bot config (10s), no restart needed — **fixed in 0.4.13**
(the field had been silently stripped by the config normaliser).

> ✅ **同一条结论不会重复发送（0.4.17）**：结论按「agent + 回复正文哈希」**跨插件代际**去重
> （`globalThis` 上的表，**先到先得**，窗口 120 秒）—— 修复「插件热重载留下上一代仍在
> `await whenIdle()` 的回合链条 ⇒ 新老两条链在同一秒各拆一张结论卡」造成的重复。
> **只在"本来就会开结论卡"的长回合生效**（短回合/纯旁白完全不受影响）。
> 命中时打日志 `[fs] duplicate conclusion suppressed: agent=… hash=… age_ms=…`。
> Duplicate conclusions are de-duplicated per agent + reply hash across plugin generations (120s window).

> 从旧插件迁移 / migrating from the legacy plugin：无需手动操作。首次启动若新路径无配置而 `~/.cc-connect/feishu.config.json` 存在，自动复制迁移（日志 `migrated config from legacy ...`）。Nothing to do — the legacy config is copied automatically on first boot.

### 飞书开放平台一次性配置 / One-time Feishu Open Platform setup

- 创建**企业自建应用**，启用机器人 / create an enterprise self-built app, enable the bot
- 权限 / permissions：`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`、`im:message.reaction`（可选 / optional）
- 事件与回调 → 订阅方式选「**使用长连接接收事件**」→ 添加事件 `im.message.receive_v1` / events & callbacks → long-connection mode → add `im.message.receive_v1`
- 创建版本并发布 / create a version and publish

## 架构 / Architecture

```
飞书开放平台 ⇄ WebSocket 长连接 ⇄ helper.cjs（官方 SDK WSClient / official SDK）
                                        ⇅ stdout JSON 行（ready/status/event/error）
                                   index.js（Host 插件，id=feishu-stream）
                                        ⇅ ctx.agents（dedicated 会话）/ fetch（卡片 API）
                                   Agent 会话（绑定配置工作区 / bound workspace）
```

- 事件轮询：`agent.session.events`（assistant/message → note；tool/call、tool/result → 工具面板），300ms 轮询 + seal 前补扫（快速回合不丢中间过程）。300ms polling plus a seal-time catch-up scan so fast turns keep their narration.
- 会话恢复 / session recovery：优先复用 live 会话（`agents.list()` 命中 → 上下文保留），其次 resume 持久化会话，最后才新建。Reuse live sessions first, then resume persisted ones, create only as a last resort.
- 卡片 / card：`POST /im/v1/messages` 创建 → `PATCH /im/v1/messages/{id}` 更新 → sealed 终态。
- 配置热读 / hot config：10s 轮询；helper 每机器人一个子进程，崩溃自动重启（5s 冷却）。One helper subprocess per bot, crash-restarted with a 5s cooldown.

## 身份闸门（可选，默认关）/ Identity Guard (opt-in)

> **默认关闭**。不开就完全不碰身份链路：不查表、不调 python、不写上下文、不拦工具，**零副作用**。

### 它解决什么

飞书入站事件里带的 `open_id` 是**服务端填的、伪造不了**；而消息正文里任何人都能打一段
「`[飞书 ou_…]`」来冒充。开着这道闸门时：

1. **入站**按事件自带的 `open_id` 查身份表 ⇒ 得到本轮 `actor`，存进**本轮上下文**（按 agentId，带 TTL）；
2. **每次工具调用前**，把 agent 传来的**任何身份字段覆写**成表里的真值（白名单外的字段删除）；
3. **拿不到身份 ⇒ 拒绝执行**（fail-closed）—— 「**执行不了**」好过「**资料泄露**」。

**非飞书回合**（GUI / 子代理 / 定时任务）**一律放行** —— 否则会把你自己的电脑锁死。

### 怎么开

在 bot 配置（`feishu.config.json`）里加一项：

```json
{ "bots": [ { "name": "work", "appId": "cli_…", "appSecret": "…", "identityGuard": true } ] }
```

> ⚠️ 该字段已进**配置白名单**；**不写就是关**。

### 身份表放哪

按顺序取**第一个存在的**：

1. 环境变量 `MAILBOX_IDENTITY_MAP`
2. **部署目录下的 `identity_map.json`**（服务器上的固定位置；想换路径就设 `MAILBOX_IDENTITY_MAP`）
3. **`<你的工作区>/output/g9-identity/identity_map.json`**
4. 从当前工作目录**逐级向上 6 层**
5. 内置的已知工作区兜底

**每台机器可另放一份【本地增量】** `~/.dsh-feishucard/identity_map.local.json`
（放在工作区**之外** ⇒ 不参与文件同步 ⇒ 多台机器**各写各的、互不覆盖**），只补本机 bot 的 `open_ids`。

### 怎么生成表

```bash
python scripts/build_identity_map.py --seed seed.json --app-id cli_xxxxxxxx --apply
```

- `--seed`：你自己的人事清单（JSON 数组），元素形如
  `{"name":"张三","job_id":"运营","channel":"运营组","status":"在职","open_id":"ou_…"}`
- `--app-id`：`open_ids` 那一层的 key —— **必须是收到消息的那个 bot 的 app_id**
  （飞书 `open_id` **每个应用各不相同**；用错 app 的 id 必然对不上，跨应用查会直接报 `open_id cross app`）
- `--via-contact`：可选，用**应用身份**调 `contact.user.get` 反查补 `union_id`（注意 API 额度，用 `--max-calls` 限制）
- **不加 `--apply` 就是 dry-run**（只打印将要发生的变化）；脚本**幂等**，重复跑不产生重复条目

**表结构见 [`identity_map.example.json`](identity_map.example.json)**
（***真实表含个人标识与人名，不进本仓库***）。

### 解析接口

`resolveActor(open_id, identity_map) -> (actor | None, err | None)` —— 见
[`scripts/resolve_actor.py`](scripts/resolve_actor.py)：**纯函数、无网络依赖**，自带 `--selftest`。

错误码：`map_unavailable` / `no_open_id` / `unknown_person` / `duplicate_open_id` /
`open_id_missing` / `job_not_granted` / **`not_active`**
（人已离职 / 终止办理 ⇒ **正常拒绝**；**与「不认识」分开报**）。

> **`not_active` 是 2026-10-04 追加的**：原先「离职」与「完全不认识这个 `open_id`」共用
> `unknown_person`，上层若按它做兜底（例如问姓名），**离职的人会被当成陌生人来处理** ——
> 而离职是正常拒绝，不该被兜底。

## Agent 互认与 @ 的语义（0.8.0）

三个此前**完全丢失**的信息现在都会喂给 agent（明细行只进会话上下文，**卡片上不出现**）：

| 信息 | 形态 | 来源 |
|:--|:--|:--|
| 这条消息谁发的 | 前缀 `[飞书 姓名] ` ＋ 尾部 `【发送方】kind=user\|bot name=… open_id=…` | `sender.sender_id` + roster |
| 这条消息 @ 了谁 | 正文里 `@_user_N` 还原成 `@名字`，尾部 `【本条 @ 的对象】@名(kind id=前10位)` | `mentions[]`（V1：对象或字符串两种形态都认） |
| 卡片是谁点的 | 审批/提问结果里的 `clicker` ＝ `[点击者 姓名\|ou前8位]` | `card.action.trigger` 的 `data.operator`（V3 形状） |

**出站 @**：`feishu_send` 的 `at` 参数，或正文里手写 `@[名字]` / `@「名字」` / `@all`，命中后展开成真 @。

> `@all` 必须是**独立 token**：后面紧跟 ASCII 标识符字符（`@all-hands`、`@all.png`、`@all_x`）
> 时视为别的词，**不展开**；紧跟中文（`@all大家安静`）时**照常展开**——那是本产品最常见的
> 「广播指令＋正文」写法，判成非 token 等于把你要的全群通知悄悄取消。

> ⚠️ **@ 是会通知人的**：@ 到活人＝对方收到消息提醒，@ 到别的 bot＝**唤醒那个 agent 跑一轮**。
> 所以解析不到时**保留原文**并追加 `（未能 @ 出：X）`，**重名歧义时一个都不 @** ——
> 宁可 @ 不出来，也不发幽灵 @。
> 卡片内 @ 失效时可整条降级为 `msg_type=post`（`DSH_FEISHU_AT_MODE=post`；post 内容必须包 `zh_cn` 层）。

> 🔴 **旁证不等于授权**：以上三条只解决「看得见」，**不改变权限口径**。能不能执行某动作，
> 仍然只认身份闸门 `resolveActor(open_id)` 解析到的人；名字对得上、roster 里有、卡片 operator
> 是熟脸——这些都**不是**授权依据。`identityGuard` 关着时，互认照常显示，权限照常不判。

**bot 名单**（跨应用 id 目录）：`node scripts/collect_bot_roster.mjs` 生成到
`FS_CONFIG_DIR`（默认 `~/.dsh-feishucard/`）`bot_roster.json`，**0600、放在工作区之外**，
插件按 mtime 热读；查不到 id 时打 `[fs] roster miss` 留痕，**不静默**。
必须自采的原因见取证 V5：飞书成员接口返回的成员**只有人不包含 bot**。

**群接力 `groupRelay`**：默认 `self_only`＝没 @ 本 bot 的群消息一律忽略（与 0.7.x 一字不动）。
实测两个 bot 同群 5 分钟能刷出 **3666** 条事件，所以放宽只在 bot 配置或 `groupRelayChats`
群白名单**显式 opt-in** 时发生，并且内置三层预算：同一发送方 90s 内接力 >3 条 ⇒ 冻结该配对
10 分钟；同群 60s 内 >8 条 ⇒ 整群丢弃；群里出现**任意人**的消息 ⇒ 立刻清零复臂。
计数器**只对经 relay 转发的 bot 消息**生效，人发的消息永远不吃预算。

**per-bot 预设 `agentPreset`**（0.8.5，中台 #171 的收口机制）：**默认不写＝挂全局默认预设，
行为与旧版一字不动**。写了 ⇒ 该 bot 的所有会话（新建与复用）按 id 挂载指定的 agent 预设
（registry `mount(ctx, id?)` 官方通道，配置 10 秒热读生效）。id 查无 ⇒ `preset mount failed`
日志可见（带 `(bot=名, agentPreset=id)` 后缀），**不静默回落**——配置错误要显式失败。
用途：多 bot 共实例时把第三方工具只留在专用预设、其余 bot 显式挂基础预设，收掉
「工具挂 default ⇒ 实例内全员可见」的跨 bot 暴露面。

## 开发 / Development

```sh
npm i                          # 安装依赖 / install deps
npm run check                  # node --check 语法检查 / syntax check
npm run smoke                  # 冒烟测试：mock DSH ctx + mock 飞书 API，跑完整回合链路
npm run sync                   # 同步到 profile 副本（含体检 + 校验，--dry-run 只体检）
```

冒烟测试覆盖 / covered by the smoke suite：helper 注册、入站消息管线（会话创建/消息投递）、流式卡片（create/PATCH/schema/工具面板/状态符号/note/seal）、命令处理、链路稳定性。Helper registration, inbound pipeline, streaming card lifecycle, commands, end-to-end stability.

### 发布 / Releasing

发版由**维护者的私有工具链**执行 —— 发布脚本与内部规则**不随本仓库分发**
（公开仓库里只留机制说明，避免把内部流程与措辞带进发布物）。

每次发版强制 **四条硬闸门，任何一条不过就拒绝执行**（绝不静默跳过）：

1. 必须在 git 仓库里，且分支是 `master`
2. **工作区干净**（不把半成品发出去）
3. 🔑 **`CHANGELOG.md` 必须已有 `## [<version>]` 段** —— 这是防「漏写 CHANGELOG」的关键
4. 该 tag 未存在

另有一道**发布物完整性**闸门：递归比对「代码里相对 `import`/`require` 的文件」与 `package.json` 的 `files`，
缺任何一个就拒绝发版（**同一检查也进了 CI**，每次 push / PR 都会跑）。
**为什么必需**：**本地冒烟绿 ≠ 发出去的包能跑** ——
实测过 `files` 漏一个被相对导入的文件，本机全绿，而 `npm i` 装到别人机器上直接 `failed to import`。

> **为什么要有闸门**：发版要做五件事，**全靠人记就必漏**。实测后果是 CHANGELOG 缺了一版、
> tag 从 `v0.3.0` 之后再没打过 ⇒ 仓库首页的 Release 停在两个月前 ⇒ **看起来像停更**。

## 独立审查门槛 / Review gate

推送前过一道**独立**的 AI 代码审查（`code-review-gate` skill，底座 [alibaba/open-code-review](https://github.com/alibaba/open-code-review)，模型 `deepseek-flash`）。
判据：出现 `critical` / `high` 即 **BLOCK，不得放行**；只出现 `medium` 为 WARN。报告落盘 `output/code-review/<repo>-<时间戳>/REPORT.md`。

- 门槛**只审不改** —— 出报告 → **逐条打开源码复核**（区分真缺陷与误报）→ 修 → **重跑一次**取证，不"改了就说好了"。
- 当前状态：`0.4.25` 修完上一轮 BLOCK 的全部 high/medium（复核 4/4 全真、零误报）。

## 权限设计裁决速查（CM 裁决回写，2026-10-05）

本节把散在台账/CHANGELOG 里的权限类裁决固化成速查，agent 不用再翻台账或问 CM：

- **审批形式 = 原生审批单**（D7，2026-09-25）。开通受限功能一律发审批单报 CM；**审批向 CM、批 1 次长期有效、维护者（CM）免审批**（0.7.17 经评审定案）。
- **两模式 full / stable**（0.7.17）：私聊按 `bot.cfg.mode`（缺省 full），**群聊一律 stable**。stable 折叠过程叙述，`/switch` 直接拒绝——**员工一个会话就够**（CM 裁决：普通员工切会话默认关闭、不能打开）。
- **员工档三开关的落点**：员工 preset 禁 plan/goal 工具；员工 bot 不开 `approvalForm`。
- **身份闸门 `identityGuard` 默认关**（0.7.18，本仓库会发布给外部）。开启后：按飞书服务端 `open_id` 查身份表覆写身份字段，**拿不到身份 ⇒ 拒绝执行**（fail-closed——CM 2026-10-04：「执行不了总比资料泄露好」）。
- **最小权限原则**（CM 2026-10-03）：权限首先收到最小，可以不开的先不开；有问题的列清单待 CM 拍板。
- **数据权限模型**（D23/D24，2026-09-30）：角色 × 数据域 × 级别；兼职只给 L0 公开信息（D43）。权限在**取数层**不在说话层（D146）——工具拿不到的数据就当不存在。
- 🔴 **线上现状（2026-10-06 06:58 部署 0.8.2 后复核）**：服务器 **9 份** `feishu.config.json`（`/home/agt*`×7 与 `/home/ubuntu` 各 1 个 bot、`/srv/aiad` 4 个 bot）**均未写** `identityGuard`（默认关）⇒ 收紧在线上尚未生效。⚠️ 0.8.1/0.8.2 两次整包覆盖只换代码五件 + 补建采集脚本，**不碰配置**（部署脚本里没有写 config 的步骤）⇒ 本条结论是实测而非推定（逐份 `grep -c identityGuard` 全为 0，`bots=` 那列是同一次遍历里 `grep -c appId` 的计数）。拦截器「有 owner 无记录 = 放行」与内核 deny 语义相反的偏差已按 CM 裁决（中台 **#36**）排进 **0.8.3**（功能基线缺口清单 **#11**），开启走金丝雀：先 1 个 bot 打点观察，再逐个推进。
- 🔴 **0.8.2 已上线（2026-10-06 06:58 服务器本地时间 = 22:58 UTC，全部为实测输出）**：`step46-deploy-082.sh` 单次跑完 `RC=0`（日志 `output/step46-deploy.log`）⇒ **10 份**副本的 `index.js`/`helper.cjs`/`identity-inject.mjs`/`package.json`/`scripts/collect_bot_roster.mjs` 各**只剩一个 md5**（`2d992282…`/`62ac162d…`/`ccacd1b1…`/`0861efe0…`/`7deb957a…`＝闸门 Z 清单）、`version` 全为 `0.8.2`、每份 `node --check` 全 OK；一次重启 `dsh-feishu-aiad` + `dsh-feishu`（其余单元 disabled 未动）⇒ 两单元 `active`、**长连接 aiad=4 / main=1**、`drain error` 各 **0**、5 个 helper 进程启动时间全在本次重启之后（`06:58:15`）、`ps` 里**明文凭证行数 = 0**（全部 `--cred <文件>` 形态）；两个实例的 `[fs] plugin apply` 自报 **`v0.8.2 md5=2d992282`**（与 Z 的 `index.js` 同源，A25 口径）。`/root/OPS_CHANGELOG.md` 已追加。🔴 **本批专属取证仍待真人点卡**：aiad 一个进程挂 4 个 bot＝「点 ✕ 卡片不动」那条缺陷的真实形态，需要 CM 在任一 bot 会话里发 `/switch` 后点「✕ 取消」，判据是**卡片当场消失**（按 CM 口径这不作为部署门槛，见功能基线第十五轮门槛段）。
- ⚠️ **采集脚本在服务器上的路径坑（2026-10-06 首次运行实测）**：`dsh-feishu-aiad` 单元里 `HOME=/srv/aiad`、`FS_CONFIG_DIR=/srv/aiad/.dsh-feishucard` 是 **systemd 注入的**，而 `aiad` 账号的真实 home 是 `/home/aiad`（那里没有 `.dsh-feishucard`）⇒ 直接 `sudo -u aiad node scripts/collect_bot_roster.mjs` 会去读 `/home/aiad/…` 并报「找不到配置」而**非零退出**（脚本行为正确：读不到配置不写空名单）。跑得通的形态必须显式带上这两个变量：`sudo -u aiad env HOME=/srv/aiad FS_CONFIG_DIR=/srv/aiad/.dsh-feishucard node <绝对路径>/scripts/collect_bot_roster.mjs`。**这是「以后挂 cron 时必须照抄」的口径**——cron 不继承 unit 的 `Environment=`，用默认路径的 cron 会天天失败退出（且不会写坏文件，因为那道闸在）。本次产出：`/srv/aiad/.dsh-feishucard/bot_roster.json`（`0600`，`aiad:aiad`，`bots=4 people=15 chats=9`；dry-run 与正式跑各一次，全天 2 次 ≤3 次上限）。**服务器此前一直没有这份名单**（全盘 `find -name bot_roster.json` 为空）⇒ 0.8.0 上线的互认功能在 aiad 上一直是"目录缺席"的降级态。
- 🔴 **服务器运行态的文件归属实测（2026-10-06 部署后取证）**：五条都**不是本批字节引入**，已全部投中台。**处置现状（CM 2026-10-06 授权「三件都做」，同日落地）**：① **#39 已修**、④ **#42 已修**、⑤ **#44 已修**；② **#40 未修**（改属主必须与重启同批，排下一次合法重启）、③ **#41 是事实记录不是缺陷**（其余会话的 11 次 restart，无法回溯修）（①②③ 由部署后翻日志取证抓到，④ 由为补闸门而新写的只读巡检脚本首跑抓到，⑤ 由取证 roster 时的调度面排查抓到）。
  - **① hr 的会话状态写不进盘**：`state-clia97b99468779dbb4.json`（appId `cli_a97b99468779dbb4` ＝ aiad 四个 bot 里的 hr）属主是 `ubuntu:ubuntu 664`，而单元是 `User=aiad / Group=agtagents` ⇒ 决定性判定是 `sudo -u aiad test -w` 返回**不可写**；全天 6 次 `[fs] state save failed: EACCES`（`04:56:03`–`05:42:16`）全部命中这一个文件，同目录另外三个 `state-*.json` 都是 `aiad:agtagents 664` 可写。写手是 04:55 一次以 ubuntu 身份执行的 clearsessions（同 mtime 的 `.bak-20261006-clearsessions` 为证）。⚠️ 「06:58 重启后该错误计数为 0」**不是自愈**——那个窗口里 hr 没有写盘事件（aiad 侧只有 1 条 `plugin apply`），恢复流量即复现。🔴 **07:4x 二次实测已把这句话钉成数据**：重启（`06:58:13`）后 40 多分钟里该目录**没有任何一个运行态文件被写过**——`message-index.json` 最后写 `05:42:20`、四个 `state-*.json` 分别停在 `05:26:40`/`05:22:50`/`04:55:45`/`10-05 04:08:33`，唯一变动的是 `bot_roster.json`（采集脚本写的，与 bot 无关）⇒ 错误计数为 0 的原因**确实是零写入事件**，不是问题消失。修法一条 `sudo chown aiad:agtagents`（不改内容、不需重启、可逆）⇒ 中台 **#39**，**✅ 2026-10-06 已修**（CM 授权后由 `step48-apply-perm-fixes.sh` 执行；改完决定性复测 `sudo -u aiad test -w` = **可写**，`step47` 复跑该文件从「!!」变「ok 可写」，未重启、其余字节未动）。
  - **② 凭证文件权限形态不一致**：同一目录的 `feishu.config.json` 是 `root:root 644`（里面装着 hr/analyst/okr/knowledge 四个 bot 的 `appSecret`），而其余 8 份全是「运行用户:agtagents 600」。实事求是定级：**当前不是正在泄露**——父目录 `drwx------ aiad:agtagents`，实测 `www-data`/`nobody`/`agtokr` 读 1 字节一律 `Permission denied`（`namei` 链卡在 `.dsh-feishucard` 那一级的 700）。但服务读到它靠的是 **others 可读位**，所以将来谁把它收成 600 而不同步改属主，aiad 下次重启就读不到配置、四个 bot 直接失联。修法必须与重启同批 ⇒ 排下一次合法重启，中台 **#40**（🔴 **未修**，且经 ①④ 修完后的 `step47` 复跑确认它是当前**唯一残留违规**：汇总「违规 1 处／偏松告警 0 处」，退出码仍为 1）。
  - **③ 一条运行事实**：`04:00–05:42` 之间 `dsh-feishu-aiad` 被其他会话 restart **11 次**（OPS_CHANGELOG 可辨是 G5 插件与 G8 feedback 通道的部署），我方 `06:58` 那次是第 12 次，也是 0.8.2 唯一需要的一次；已复核上线后 10 份副本五件 md5 仍等于闸门 Z ⇒ **不影响本次部署判定**，但违反红线⑳「改动攒批、一次完成」，已建议约定「动 aiad 服务前先查中台租约」，中台 **#41**。
  - **④ main 单元的运行态权限偏松**：为补闸门新写的只读巡检 `output/server-inspect-20261004/step47-check-runtime-perms.sh` 首跑抓到（存档 `output/step47-perms.log`：**违规 2 处／偏松告警 14 处／未落运行态的单元 0 个，退出码 1**）——`/home/ubuntu/.dsh-feishucard` 是 **775**（组外开放穿越），其下 9 个 `state-*.json` 与 `message-index.json` 全是 **644**，即会话内容对 others 全开。与 ①② 的区别是这条落在**告警**级（实测不可达），已投中台 **#42**（medium）。判定同样走**实测**而非看权限位：`www-data`/`aiad`/`nobody`/`agtagents` 逐一试读 1 字节一律 `Permission denied`，`namei` 链显示卡点在 `/home/ubuntu` 那一级是 `drwxr-x---`（750）⇒ **当前不是正在泄露**，但形态与 ② 同族（靠上一层权限挡着），一旦有人善意放开 `/home/ubuntu` 立刻全局可读。修法一条 `chmod 700`＋`chmod 600`，**属主不变 ⇒ 不需重启、可逆**。🔴 闸门自身经一次独立审查（判定 **BLOCK**，三条 critical 全是**假绿**通路）后重写：`sudo -u <probe> test -r` 会把「sudo runas 被拒」和「读不到」混成同一个非 0 ⇒ 真泄露会被静默降级成告警，所以现在**实测失败一律记违规**（远端入口 `sudo -n true` 不通即整体红、每单元先做 runas 对照、无可用探针返回 `UNKNOWN` 按违规处理），且每个单元都打出「可用探针」清单可核。⚠️ 那 14 处若按权限位直接定级，会被写成 14 条「真泄露」。✅ **2026-10-06 已修**（CM 授权）：目录 `775→700`、9 个运行态文件 `644→600`，属主未动 ⇒ 未重启；复测两条判据同时成立——`sudo -u ubuntu test -w` 对**全部**运行态文件仍可写（服务没被打断）、`www-data` 已**读不到** `message-index.json`；`step47` 复跑「偏松告警 14 → **0**」。同批把 aiad 侧 5 个 `664` 的运行态文件一并收成 `660`（同类追加，CM 总则 **#36**「能不开的都不开」），复测仍可写。
  - **⑤ `bot_roster.json` 没有任何调度在采它**：为取证 roster 合并语义而排查调度面，实测 `/etc/cron.d/`（12 个文件）、`/etc/crontab`、`/etc/cron.*/`、root/aiad/ubuntu 三份 crontab、`systemctl list-timers`（16 个）**一律查不到采集条目**；`index.js` 只**读**名单（`index.js:4136`）不生成，10 份部署副本 `scripts/` 里那份采集脚本**没有任何调用方** ⇒ 跨 bot 互认（真 @、认出发话者）依赖的这张表**只会静默变旧**，退群/新群/改名都不会自动反映，也没有报警（解析不到只打 `index.js:4187` 一行 `roster miss`）。同批还查到：线上名单 `07:00:41` 被重写过（mtime=ctime，符合脚本「写临时文件再 rename」形态），但 root/aiad/ubuntu 三份 shell history 与 `/root/OPS_CHANGELOG.md` **都没有这次操作** ⇒ 谁跑的查不出来，与 ③（多会话并发、互相不知情）同族。修法两步、都不需重启：挂 `/etc/cron.d/dsh-roster`（脚本头部纪律 ≤3 次/天 ⇒ 建议每天 1 次，`aiad` 身份、`--config/--out` 指 aiad 那份）＋把 `bots/people/chats` 三计数落日志让退化可见。⇒ 中台 **#44**／功能基线缺口 **#13**，**✅ 2026-10-06 已修**（CM 授权后新增 `/etc/cron.d/dsh-roster`，`root:root 644`，内容为每天 **1 次**（`30 4`，远低于脚本头部 ≤3 次/天的纪律上限）以 `aiad` 身份带**显式绝对路径**跑 `collect_bot_roster.mjs --config/--out` 指 aiad 那份、输出追加 `/var/log/dsh-roster.log`（`aiad:aiad 640`）——这里必须显式带路径，因为 §上一条评论记录的那个坑：**cron 不继承 unit 的 `Environment=`**，用默认路径的 cron 会天天失败退出）。挂前逐条验过可执行前提：`cron` 单元 active、`/usr/local/bin/node` 对 aiad 可执行、脚本本身可读、日志可写、文件末尾换行 OK；挂后 `step47` 复跑显示 `bot_roster.json` 为 `aiad:aiad 600` 且**运行用户可写**。**没有预跑采集**——当天已发生 2 次采集（`07:00:41` 那次来源不明 ＋ 我 `07:41` 的取证探针），留给 04:30 的调度自己开口。
- ✅ **三件已授权服务器修正落地（2026-10-06，CM「三件都做」）**：`step48-apply-perm-fixes.sh`（存档同目录，前置快照 `step48-perm-before.txt` ＋ 首跑快照 `step48-perm-before-run1.txt`）一次跑完 `rc=0` ⇒ **#39** chown、**#42** chmod 700/600、**#44** 挂 `/etc/cron.d/dsh-roster`；两单元全程 `active`、**长连接 5 个 helper 未断**（脚本设计为不 restart，故未重启）。复测用**同一把只读闸门** `step47`（存档 `step47-perms-postfix.log`）：**违规 2 → 1、偏松告警 14 → 0**，剩下那条就是 **#40**。🔴 **本批踩到一个自己造的坑，值得记下来**：首跑里 **#39 与 #44 被静默跳过**并报告「文件不在预期位置」——真根因是判据写成 `[ -f "$HR" ]`，而这条命令是以 `ubuntu` 身份执行的，目标在 `drwx------ aiad` 的目录里 ⇒ **非特权账号对"存在但无权限进入"的路径一律返回 false**，看起来像文件缺失。改成 `sudo -n test -f` 后两项都正常执行。同批第二个坑：快照用 `find -printf '%a'` 取到的是**访问时间**不是权限位（应为 `%m`），首跑那份快照里根本没有权限形态 ⇒ 重跑前先把首跑快照另存，避免把"改后状态"覆盖成"改前基线"。两条都是**判定方式错**而非**东西不存在**，与 A25「验证要用生产的方式」同源。
- ✅ **0.8.2 生产回归五场景自验（2026-10-06 13:4x–13:5x，CM 破例授权「用现有机器人发」，例外与测试消息 id 已记 `/root/OPS_CHANGELOG.md`）**：
  **单聊**✅（`om_x100b637cd03cc0a8c4f6e1ee5a646a1` → 正常回卡）；**群 @**✅（Ai内部测试群 `oc_0240dfe292c3055ac1feac327d5aa63a`，`om_x100b637ceee3d0a4dfaa4992eb5974d`）；
  **无 @ 丢弃**✅，且顺带证伪了「多 bot 同群串扰」的担心——同群双 bot 时只有被 @ 的那个响应，飞书 `open_id` 是**按应用隔离**的（同一个 bot 在不同 app 下是不同 `ou_`），桥的按 bot @ 判据在真机口径正确；
  **`/switch`**✅（stable 模式 bot 按设计**不进**会话切换流程，回一张拒绝卡；⚠️ 本会话踩到 harness 坑：Git Bash 把 `/switch` 转成 `C:/Program Files/Git/switch`，须 `MSYS_NO_PATHCONV=1`，属**发信方式**问题不是产品问题）；
  **审批卡**⚠️ **无触发面 ≠ 已验证**——线上 5 个 bot 的 config 全部**没有** `approvalForm` 键（员工档，按 #36 总则本就不开），且 `mode` 未设 danger-full-access ⇒ 生产上点不出这张卡，本场景**判"取不到证据"**，不记为通过（与 M1/M2 同一口径）。
  🔴 **`/model` 顺带查出三条真缺陷**（CM 的急件「卡片里切换模型从来没成功过」）：0.8.2 的切换机制本身**已在生产生效**（`/model deepseek-official/deepseek-v4-pro` → 日志 `selectModel ok`、`current=` 随即变成 v4-pro、卡上 ▶ 跟着移），失效的是**边界三条**——非清单模型名宿主抛英文原文、卡面 `<provider>/<model>` 占位符被飞书当标签吞成「/model /」导致用户按猜的写法发裸模型名而**静默重发一张卡**、文字档失败**一行日志都不留**。已投中台 **#47**（high），三条修复＋冒烟用例 104 归 0.8.3 批次。测试后 analyst 会话模型已恢复为宿主清单内的 `deepseek-official/deepseek-flash`（原值 `deepseek-v4-flash` 不在清单里，切回必被宿主拒绝——这条本身就是缺陷 A 的实证）。
- ✅ **0.8.3 定版 = 闸门 AB（2026-10-06，17 步全 `RC=0`，日志 `output/gate083ab.log` + 清单 `output/bytes083ab.txt`）**：全量冒烟 **831 ✅ / 0 ❌**、`SMOKE PASS (sentCards=519, sessions=33)`，`SMOKE_COLD` 三变体（form/notice/goal-off）各跑一遍同绿，STEP9 与 manifest 与现场字节**八件全等**、锁目录已释放。八件里本批只动三件：`index.js` `c73d76f209dac25c106b57ed6ce09633`（598909 B）、`scripts/smoke.mjs` `ee4f10feeff783a716dc44d655c6b541`、`package.json` `ba0b033ab3b42b333ed9aa7e1a4cf851`。🔴 **闸门字母 AA 已作废**（不是脏，是被超越）：AA 那次跑完之后为了收紧一条**弱断言**又动了 `scripts/smoke.mjs` 的字节 ⇒ 按「单次干净运行 + 跑完后字节没再动过」的口径整轮不作数，定版字母顺延为 AB。⚠️ **本会话自己踩的 A28 坑（已记 CHANGELOG）**：AB 的**第一次**尝试被 Bash 工具的 10 分钟上限杀掉（日志冻结在冒烟中段），`setsid nohup` 也随 shell 一起死，最后只有 PowerShell `Start-Process` 起的形式活下来——长任务必须脱离进程启动。
  **独立审查门槛两轮**：第二十一轮（AA 字节）**WARN** ⇒ 4 条核实为真并修掉（出站回显脱敏 `echoSafe`、清单读不到时不断言"清单里没有"、`sendModelPicker` 空清单跟进语的第二个尖括号、日志标签统一），1 条按理由拒绝；第二十二轮（AB 字节）**PASS** ⇒ 仅 1 条 low（`sampleChoicePath()` 空清单分支仍返回字面 `provider/model`），核对为**当前不可达的死分支**后拒绝改动（三道提前返回在 `index.js:7365`/`7425`/`7474`，本批字节已冻结，为一条不可达分支再作废一次闸门不值）。**反证第三轮**（`output/negctrl104f-20261006.log`，用 AA 的生产方式跑同一套冒烟）：新断言 **5 红 / 3 绿**——红的证明这 5 条不是恒真断言，3 条绿逐条给出判定（1 条前提断言 + 2 条"两版都该成立"的回归护栏，机制是 @all 展开后仍留 `id=all`，所以"没有 `@`"与"保留 all"在两版同真）。用例 104 由 16 条扩到 **24 条**。
- ✅ **0.8.3 已上线并真机回归（2026-10-06 16:09 部署 + 16:15–16:17 真机验证，全部实测）**：`step49-deploy-083.sh` 单次 `DEPLOY_RC=0`（日志 `output/deploy083-step49.log`）⇒ **10 份**副本 × 5 件运行文件全部落在 AB md5（每份先存 `.bak-pre083`）、逐份 `node --check` OK；中台 **#40** 同批收口（`/srv/aiad/.dsh-feishucard/feishu.config.json` `root:root 644` → `aiad:agtagents 600`，改前改后各实测一次「服务用户 aiad 仍可读写自己的配置」）；一次 `systemctl restart dsh-feishu-aiad dsh-feishu` ⇒ 两单元 `active`、**长连接 aiad=4 / main=1**、`drain error` 各 0、5 个 helper 启动时间全为 `16:09:51`、`ps` 里**明文凭证行数 = 0**；两个实例的 `[fs] plugin apply` 自报 **`v0.8.3 md5=c73d76f2 bytes=598909`**（与 AB 的 `index.js` 同源，A25 口径）；`/root/OPS_CHANGELOG.md` 已追加。🔴 **踩坑一条**：预检第一次报 `MISMATCH index.js 本地=c73d76f2 闸门=9a837813`——根因是部署脚本 `MANIFEST` 默认值还指着**已作废的 AA 清单**（我此前"已经改过了"的记忆是错的），改默认值为 `bytes083ab.txt` 后预检 `rc=0`。
  **真机三条取证（CM 破例授权「用现有机器人发」的口径沿用，例外与三条测试消息 id 已记 `/root/OPS_CHANGELOG.md`；lark-cli `--as user` 从生产入口发，bot 只被动回复）**，会话＝analyst 单聊 `oc_809f7c00ed97c0a2fcb41926642553bb`：
  ① **缺陷 B（卡面提示被飞书吞成「/model /」）✅ 已消失**——发 `/model`（`om_x100b637eacbffca4c345a5c0a54eebb`）回卡正文尾部现在是「点一下即切换；也可发文字：`/model provider/model`（例：`/model deepseek-official/deepseek-flash`）」，**真例路径完整可见**；日志 `[fs] /model: choices=2 providers=deepseek-official=2`。
  ② **缺陷 C（裸模型名静默重发一张卡）✅ 已修**——发 `/model deepseek-flash`（不带 provider，`om_x100b637eab2cb8a4c29bd80ffac4ea5`）⇒ 回卡「✅ 模型已切换为 `deepseek-official/deepseek-flash`（下一次请求开始用）」，日志 `[fs] /model: selectModel ok deepseek-official/deepseek-flash session=fs-main-muvrahja`（反查 provider 生效，且**没有**多发一张选择卡）。
  ③ **缺陷 A（宿主英文原文 + 失败零日志）✅ 已修**——发 `/model nosuchmodel-xyz`（`om_x100b637ea6bb40a8de2a63db917a457`）⇒ 回卡中文「没找到模型 `nosuchmodel-xyz`（宿主可用清单里没有这个名字）…」**无 `Select an available model…` 原文**，且日志新增一行 `[fs] /model 文字档无法解析: arg=nosuchmodel-xyz → 没找到模型…`（0.8.2 的失败路径一行都不留，这行就是"留痕"本身）。线上模型状态测后仍为 `deepseek-official/deepseek-flash`（与测前一致，无需复原）。
  ✅ **原「唯一未取证项」已由 CM 真机点击销项（2026-10-06 16:5x）**：**点卡上按钮 ⇒ 同一张卡原地 PATCH 成「✅ 已切换模型」**（`index.js:7447-7458`）——飞书的 `card.action.trigger` 只能由真人点击产生，程序无法伪造，故本地证据（冒烟用例 104 的「点卡不发新卡」断言 + 反证非恒真）之外必须等一次真人点击。CM 点击后原话：「切换模型组件现在正常能切换模型，它也能更新卡片，这个验证通过」⇒ **判据成立，0.8.3 本批取证全清**。出处＝CM 本会话口述，无独立消息 id；机器侧复核入口 `journalctl -u dsh-feishu* | grep '/model click'`。
  🔴 **定版字节与运行态的独立复核（2026-10-06 16:39，只读脚本 `output/server-inspect-20261004/step50-verify-083-live.sh`，存档 `output/step50-verify-083-live.log`）**：不复用部署日志，重新遍历那 **10 份**副本 ⇒ `index.js` **10/10 同一个 md5 `c73d76f2…`**、`helper.cjs` **10/10 `62ac162d…`**、`package.json` **10/10 `"version": "0.8.3"`**；两单元 `active`，`16:09:50` 之后 `long connection ready` 计数 **aiad=4 / main=1**，同窗口 **error 级 0 行**；`/srv/aiad/.dsh-feishucard/feishu.config.json` 仍为 `aiad:agtagents 600` 且实测**服务用户 aiad 可读**（#40 的收口状态没被后续动作回退）；`ps` 里 `appSecret=` 命令行形态 **0 行**。⚠️ **另记一条与 Git 无关的发布面缺口**：npm registry 上 `dsh-feishucard` 最高仍是 **0.7.21**（`npm view … versions` 实测 `[0.1.0, 0.3.0, 0.7.21]`）⇒ **0.8.0～0.8.3 从未发布到 npm**，本仓库是"发给外部"的定位与此不匹配；发布属对外动作，未获 CM 明确授权前不推。
  ✅ **发布面缺口已清（2026-10-09，CM 裁决「发布并推送，要用专门技能」）**：`dsh-feishucard@0.8.4` 已发布到 npm registry——先 `npm publish --dry-run` 审上传清单（12 文件 500.5 kB，无敏感内容），正式发布后双通道验证 `dist-tags latest=0.8.4`、registry 全版本 `['0.1.0','0.3.0','0.7.21','0.8.4']`；本机 npm 身份 `cmfok`。与 0.7.21 之间跳过的 0.8.0-0.8.3 不补发（版本号单调递增合规，历史版本无回补需求）。
- ✅ **0.8.4 定版 = 闸门 AC（2026-10-08，17 步全 `RC=0`，日志 `output/gate084ac.log` + 清单 `output/bytes084ac.txt`）**：全量冒烟 **959 ✅ / 0 ❌**、`SMOKE PASS (sentCards=637, sessions=45)`；`SMOKE_COLD` 三变体（form/notice/goal-off）各跑一遍同绿；`scripts/test-collect-roster.mjs` **12 格 / 44 条**全绿；反证三轮精确归因（M4b 3 红 / M5 1 红 / M6 2 红）＋ NEG（把 `index.js` 换回 0.8.3 字节）红集对照＝**NEW 只允许新增判别格、GONE 必须为 0**；STEP0==STEP9==工作区字节、锁目录已释放。本批运行面只动两件：`index.js` `cadbab1cf74e3957822fc68420737737`（**707798 B**）、`package.json` `9aa0151a95fb74bfbc04afca5a62fac6`。
  **门槛账（CM 2026-10-08 分层裁决 L1/L2）**：本批外部全量门槛（`ocr`）累计 **31 轮**（10-07 02:44 → 10-08 10:28）＝1 BLOCK / 25 WARN / 5 PASS、**4.31 亿 token**、约 299 分钟、247 条 findings（0 critical / 2 high / 70 medium / 175 low），**第 52 轮 PASS**（0 中危 / 4 低危）为终态外部证据；第 53 轮起账号余额被跑空（`402 Insufficient Balance`）⇒ 经 CM 裁定本次定版**不再跑外部门槛**，改用 **L1**（内置 CodeReview 子代理审终态字节，结论＝无 P0–P2 级问题）。第 52 轮那 4 条 low 中，2 条按「核对后**不改**、理由落在注释里」处置（`index.js:4543` 的 `loadGrants` 只取 `rows`、`index.js:10559` 的 teardown **不清** `pendingCapRequests`）。分层规则已回写 `AIAD/.qoder/rules/always-code-review.md`＋`code-review-gate` 技能，L2 起用前必须报「原因/目的/是否有必要/成本」。
- ✅ **0.8.4 已上线（2026-10-08 16:50，CM「三个都批准，不跑代码审查」= 定版推送 + 部署）**：`step50-deploy-084.sh` 单次 `rc=0`（日志 `output/deploy084-step50.log`）⇒ **现存 9 份**副本 × 5 件运行文件全部落在 AC md5（每份先存 `.bak-pre084`）、`package.json` **9/9 `"version": "0.8.4"`**、逐份 `node --check` OK、`scripts/collect_bot_roster.mjs` 在 8 份缺失副本上**补建**成功；一次 `systemctl restart dsh-feishu-aiad dsh-feishu` ⇒ 两单元 `active`、**长连接 aiad=4 / main=1**、`drain error` 各 **0**、`mount failed` 各 **0**、5 个 helper 启动时间全为 `16:50:05 / 16:50:10`（本次重启之后）、`ps` 里**明文凭证行数 = 0**；两个实例的 `[fs] plugin apply` 自报 **`v0.8.4 md5=cadbab1c bytes=707798`**（与 AC 的 `index.js` 同源，A25 口径）；`/srv/aiad/.dsh-feishucard/feishu.config.json` 复核仍是 `aiad:agtagents 600`（#40 未回退）；`/root/OPS_CHANGELOG.md` 已追加（`2026-10-08 08:50 UTC` 行）。
  🔴 **副本数 10 → 9 的落差已查明，不是漏覆盖**：第 10 份 `/opt/dshprof/profiles/feishu/node_modules/dsh-feishucard` 所在目录 **`/opt/dshprof` 已退役**——`/root/OPS_CHANGELOG.md` `2026-10-08 12:36` 那条（G8#18 尾巴清理）明确记录 `/home/ubuntu/.dsh/node_modules` 下 240 条软链**全部指向已删除的 `/opt/dshprof`**；本次部署前重新 `find /srv /home /opt -type d -name dsh-feishucard` ⇒ 全机**只剩 9 个目录**，脚本按目录遍历覆盖 ⇒ 对现存副本是 **9/9**，零遗漏。
  ⚠️ **中台 #56（`streamIdleTimeoutMs` 5→2）未随本批做，实况回写池内**：运行 profile `/srv/aiad/.dsh/profiles/feishu/cordis.patch.yml` 里**根本没有这个键**，全机唯一出现处是 SDK 样例 `/opt/dsh/node_modules/@deepseek-ai/dsh-sdk-minimal/cordis.patch.yml:31`（值 `172800000`＝48 小时，不是"5"）⇒ 找不到"5"在哪就不瞎改；且该 profile 的 `cordis.patch.yml` **当天 07:51 刚被别的操作者改过**（`aiad:agtagents`），盲写会覆盖他人动作。
  ✅ **#56 已钉死并落地（2026-10-09，CM 裁决 7C）**：源码级核查钉死参数形态——`streamIdleTimeoutMs` 是 `@deepseek-ai/dsh-llm-deepseek` / `dsh-llm-pi-ai` 适配器真实配置键，默认 **300000ms（5 分钟）**、字段 volatile、值域 (0, 2147483647]；「5→2」是「5 分钟→2 分钟」的**单位丢失简写**（300000→120000ms，出处 CHANGELOG 框架侧建议，经会话交接转抄变形），从来不存在字面量 5，本机找不到属必然。实况：feishu profile 走 `llm-pi-ai`（非 deepseek 适配器），已在 `zai-coding-cn` provider 段插入 `streamIdleTimeoutMs: 120000`（备份 `cordis.patch.yml.bak-20261009`，sudo YAML 解析验证 1 处值=120000），**未重启桥**——下次 `systemctl restart dsh-feishu*` 时生效；按 CHANGELOG 原定性它只防「流完全无数据」，防不了「有零星数据但零进展」的黑洞。
- ✅ **第七轮三条服务器挂账（M1/M2/M3）取证收口（2026-10-06 07:4x，全程只读）**：**M3 已用生产真实配置取证通过**——把线上 `bot_roster.json` 复制成 `/tmp` 探针文件、用**已部署的那份脚本**＋**生产同一份 config** 打真接口跑一遍（合并逻辑读的就是 `--out` 目标 ⇒ 线上名单一个字节不动，md5 前后同为 `ab7be3c2…`）：四个 bot 全采成功（hr 2 群／analyst 6／okr 1／knowledge 5，去重 `chats=9`），`bots=4 people=15 chats=9` 不变、**每个 bot 的 `views` 键一个没少**、29 行逐条摘要 `diff` 为 0 行 ⇒ 「再采一遍不抹 `views`」成立；桩侧那条 `views` 断言仍缺（挂 0.8.3）。**M1/M2 结论是「取不到证据」而不是「验证通过」**：全 journal 保留期内 `cred file write failed` 0 行、`CONCLUSION LOST` 0 行、relay 相关 0 行，重启后 error 级行 0、5 个 helper 1 秒内全连上 ⇒ 这两条路径在生产上从未被走到；M2 按**预防性修复**挂账，M1 补断言要改 `scripts/smoke.mjs`（闸门 Z 八件字节之一）⇒ 与缺口 **#10** 同批，不塞进 0.8.2。详见 CHANGELOG「本轮发现但不在本版修」。

## License

MIT
