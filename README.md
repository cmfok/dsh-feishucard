# dsh-feishucard — DSH ↔ Feishu Streaming Card Bridge

把飞书（Lark）机器人接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 会话——完全自研（非 fork）。官方 SDK **长连接**收发（无需公网 IP/域名/隧道）、每聊天独立专属会话、`/new /switch /list /help` 命令、处理中表情回执，以及**流式回复卡片**：过程话语内联 + 工具调用折叠面板 + 限流/退避/熔断/文本兜底。

A self-developed (not a fork) bridge between Feishu (Lark) chats and DeepSeek Harness agent sessions: official-SDK long connection (no public URL needed), dedicated per-chat sessions, `/new /switch /list /help` commands, a typing reaction, and a **streaming reply card** — inline agent notes, collapsible tool-call panels with status symbols, and rate-limit / backoff / circuit-breaker / plain-text fallback reliability.

单包即用：Host 插件（桥接逻辑）+ helper 子进程（长连接）+ bundle 补丁（自动注册）。One package, three pieces: host plugin, long-connection helper subprocess, and an auto-registered bundle patch.

> 独立自研，不依赖任何第三方 DSH 飞书插件。配置独立存放于 `~/.dsh-feishucard/`；检测到旧生态路径（`~/.cc-connect/`）有配置时启动自动迁移一次。不要与其他 DSH 飞书插件同时安装（同一飞书 App 的 WS 长连接互踢）。
> Fully independent. Config lives in `~/.dsh-feishucard/`; a legacy config found at `~/.cc-connect/` is auto-migrated once on boot. Do not install alongside other DSH Feishu plugins (two WS long connections on one app kick each other).

> ⚠️ **Windows 开发陷阱（2026-08-15 实测）**：本包以 `file:` 依赖安装后，DSH profile 的 `node_modules/dsh-feishucard/` 是**实体副本而非软链**——改源文件后 dsh 仍加载旧副本，改动"重启也不生效"。改代码后必须同步副本：`cp index.js helper.cjs <profile>/node_modules/dsh-feishucard/`（或重新 `dsh plugin --profile web add dsh-feishucard`），再重启 dsh。排查"改了没生效"先 `md5sum` 对比源与副本。

## 功能 / Features

- **长连接收发 / Long-connection messaging**：`im.message.receive_v1` 官方 SDK WebSocket → 注入 Agent 会话 → 交互卡片回复同一会话，全程无需公网地址。Official SDK WebSocket; no public IP, domain, or tunnel required.
- **流式回复卡片 / Streaming reply card**：
  - 收到消息即建卡「正在工作中…」，agent 干活时实时 PATCH 更新。A card appears instantly and is PATCH-updated live as the agent works.
  - **过程话语**（agent 每步说的话）按事件顺序内联可见。Inline agent narration, in event order.
  - **工具调用折叠面板**：🛠️ 每工具一行「状态符号 · 工具名 · 参数摘要 · 失败原因」，默认折叠。Collapsible tool-call panels: status symbol, tool name, arg summary, failure reason per line.
  - 完成 sealed：最终回复入卡、状态行消失、面板保持折叠。Sealed with the final reply; status line removed.
  - 可靠性：串行更新队列 + 400ms 限流合并 + 指数退避 + 5 次熔断 + 15s 超时 + 卡片失败自动降级纯文本。Serialized queue, 400ms coalescing, exponential backoff, 5-failure breaker, 15s timeout, text fallback.
- **每聊天独立会话 / Dedicated per-chat sessions**：每个飞书聊天专属 Agent 会话池（绝不串进 GUI 会话）；首条消息自动创建；持久化 + 重启恢复（live 会话直接复用、上下文不丢）；`/new [名称]`、`/switch <序号>`、`/list`、`/help`。Never shares GUI sessions; auto-created on first message; live sessions are reused across restarts so context is preserved.
- **处理中表情 / Typing reaction**：消息到达加 `OnIt`，回复送达后撤销（`reactionEmoji` 可配，`none` 关闭）。`OnIt` reaction added on arrival, removed after delivery.
- **工具 / Model tool**：`feishu_send`（agent 主动发消息，`appId` 指定机器人，缺省发到最近会话）。Proactive messaging from the agent.
- **审批卡片 / Approval card**：dsh 会话的工具调用需要确认时（audit 哨兵等），飞书弹出交互卡片「✅ 允许一次 / ❌ 拒绝」按钮，点击即回决策（`card.action.trigger` 长连接事件）；5 分钟超时自动拒绝、会话取消自动取消——避免飞书通道下审批无人应答导致会话永久挂起。Approval `approval/request` for plugin-owned sessions is answered via a button card; timeout auto-rejects.
- **保活 / Keep-alive**：helper 崩溃自动重启（5s 冷却防重复）+ 凭据变更自动重连 + SDK 自带重连 + 状态可观测。Crash-restart with spawn cooldown, auto-reconnect, observable connection status.
- **多机器人 / Multi-bot**：一个实例多个机器人，各自绑定工作区。One instance, many bots, one workspace each.

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
      "workspace": "C:\\path\\to\\workspace",
      "appId": "cli_xxxxxxxxxxxxxxxx",
      "appSecret": "your_app_secret",
      "reactionEmoji": "OnIt"
    }
  ]
}
```

会话状态持久化在 `~/.dsh-feishucard/state-<appId>.json`。配置支持热更新（10 秒轮询），改完无需重启。Session state persists to `~/.dsh-feishucard/state-<appId>.json`; config is hot-reloaded every 10s.

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

## 开发 / Development

```sh
npm i                          # 安装依赖 / install deps
npm run check                  # node --check 语法检查 / syntax check
npm run smoke                  # 冒烟测试：mock DSH ctx + mock 飞书 API，跑完整回合链路
```

冒烟测试覆盖 / covered by the smoke suite：helper 注册、入站消息管线（会话创建/消息投递）、流式卡片（create/PATCH/schema/工具面板/状态符号/note/seal）、命令处理、链路稳定性。Helper registration, inbound pipeline, streaming card lifecycle, commands, end-to-end stability.

## License

MIT
