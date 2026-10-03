# dsh-feishucard — DSH ↔ Feishu Streaming Card Bridge

把飞书（Lark）机器人接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 会话——完全自研（非 fork）。官方 SDK **长连接**收发（无需公网 IP/域名/隧道）、每聊天独立专属会话、`/new /switch /list /help` 命令、处理中表情回执，以及**流式回复卡片**：过程话语内联 + 工具调用折叠面板 + 限流/退避/熔断/文本兜底。

A self-developed (not a fork) bridge between Feishu (Lark) chats and DeepSeek Harness agent sessions: official-SDK long connection (no public URL needed), dedicated per-chat sessions, `/new /switch /list /help` commands, a typing reaction, and a **streaming reply card** — inline agent notes, collapsible tool-call panels with status symbols, and rate-limit / backoff / circuit-breaker / plain-text fallback reliability.

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

- **审批单卡 / Approval form（2026-10-03 新增；0.6.1 按真机反馈改版；0.6.2 起为**可选通道）**：AI 要发「权限变更审批单」这类**可读可点**的单子时用它 ——
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
缺任何一个就拒绝发版。**为什么必需**：**本地冒烟绿 ≠ 发出去的包能跑** ——
实测过 `files` 漏一个被相对导入的文件，本机全绿，而 `npm i` 装到服务器上直接 `failed to import`。

> **为什么要有闸门**：发版要做五件事，**全靠人记就必漏**。实测后果是 CHANGELOG 缺了一版、
> tag 从 `v0.3.0` 之后再没打过 ⇒ 仓库首页的 Release 停在两个月前 ⇒ **看起来像停更**。

## 独立审查门槛 / Review gate

推送前过一道**独立**的 AI 代码审查（`code-review-gate` skill，底座 [alibaba/open-code-review](https://github.com/alibaba/open-code-review)，模型 `deepseek-flash`）。
判据：出现 `critical` / `high` 即 **BLOCK，不得放行**；只出现 `medium` 为 WARN。报告落盘 `output/code-review/<repo>-<时间戳>/REPORT.md`。

- 门槛**只审不改** —— 出报告 → **逐条打开源码复核**（区分真缺陷与误报）→ 修 → **重跑一次**取证，不"改了就说好了"。
- 当前状态：`0.4.25` 修完上一轮 BLOCK 的全部 high/medium（复核 4/4 全真、零误报）。

## License

MIT
