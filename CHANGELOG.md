# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
