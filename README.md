# dsh-feishucard

把飞书（Lark）机器人接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 会话——**自研实现**（非 fork）：官方 SDK **长连接**接收消息（无需公网 IP/域名/隧道）、每聊天独立专属会话、`/new /switch /list /help` 命令、处理中表情回执，以及**流式回复卡片**（Streaming Card：工具调用折叠面板 + 状态符号 + 过程话语内联 + 限流/退避/熔断/文本兜底）。

单包即用：Host 插件（桥接逻辑）+ helper 子进程（长连接）+ bundle 补丁（自动注册）。

> 本包为独立自研实现，不依赖任何第三方 DSH 飞书插件。配置**独立存放**于 `~/.dsh-feishucard/`；若检测到旧生态路径（`~/.cc-connect/`）有配置，启动时会**自动迁移一次**，无需重新填写凭证。不要与其他 DSH 飞书插件同时安装（同一飞书 App 的 WS 长连接互踢）。

## 功能

- **长连接收发**：`im.message.receive_v1` 官方 SDK WebSocket → 注入 Agent 会话 → 回复以交互卡片发回同一会话，全程无需公网地址
- **流式回复卡片**：
  - 收到消息即建卡「正在工作中…」，agent 干活时**实时 PATCH 更新**
  - **过程话语**（agent 每步说的话）按事件顺序内联可见
  - **工具调用折叠面板**（🛠️ 每工具一行「状态符号 · 工具名 · 参数摘要 · 失败原因」，默认折叠）
  - 完成 sealed：最终回复入卡、状态行消失、面板保持折叠
  - 可靠性：串行更新队列 + 400ms 限流合并 + 指数退避 + 5 次熔断 + 15s 超时 + 卡片失败自动降级纯文本
- **每聊天独立会话**：每个飞书聊天拥有专属 Agent 会话池（绝不串进 GUI 会话）；首条消息自动创建；会话持久化（重启恢复，live 会话直接复用、上下文不丢）；`/new [名称]`、`/switch <序号>`、`/list`、`/help`
- **处理中表情**：消息到达加 `OnIt` 表情，回复送达后撤销（可配 `reactionEmoji`，`none` 关闭）
- **工具**：`feishu_send`（agent 可主动发消息，`appId` 指定机器人，缺省发到最近会话）
- **保活**：helper 子进程崩溃自动重启（带冷却防重复）+ 凭据变更自动重连 + 官方 SDK 自带重连 + 连接状态可观测（日志/状态接口）
- **多机器人**：一个实例同时运行多个机器人，每个绑定一个工作区

## 安装

```sh
dsh plugin --profile web add dsh-feishucard
dsh web   # 重启
```

> 首次安装若提示 `ERR_PNPM_IGNORED_BUILDS`（pnpm ≥10 默认拦截 `protobufjs` 构建脚本）：编辑 `$DSH_HOME/profiles/web/pnpm-workspace.yaml`，把 `allowBuilds` 下的 `protobufjs` 改为 `true` 后重跑安装命令。
>
> 本地开发安装：`dsh plugin --profile web add <本包目录>` 或 `file:<本包目录>`。

配置写在 **`~/.dsh-feishucard/feishu.config.json`**（与仓库解耦）：

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

会话状态持久化在 `~/.dsh-feishucard/state-<appId>.json`。配置支持热更新（10 秒轮询），改完无需重启。

> 从旧插件迁移：无需手动操作。首次启动若 `~/.dsh-feishucard/feishu.config.json` 不存在而 `~/.cc-connect/feishu.config.json` 存在，会自动复制迁移（日志可见 `migrated config from legacy ...`）。

### 飞书开放平台一次性配置

- 创建**企业自建应用**，启用机器人
- 权限：`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`、`im:message.reaction`（可选，处理中表情用）
- 事件与回调 → 订阅方式选「**使用长连接接收事件**」→ 添加事件 `im.message.receive_v1`
- 创建版本并发布

## 架构

```
飞书开放平台 ⇄ WebSocket 长连接 ⇄ helper.cjs（官方 SDK WSClient）
                                        ⇅ stdout JSON 行（ready/status/event/error）
                                   index.js（Host 插件，id=feishu-stream）
                                        ⇅ ctx.agents（dedicated 会话）/ fetch（卡片 API）
                                   Agent 会话（绑定配置工作区）
```

- 事件轮询：`agent.session.events`（assistant/message → note；tool/call、tool/result → 工具面板），300ms 轮询 + seal 前补扫（快速回合不丢中间过程）
- 会话恢复：优先复用 live 会话（`agents.list()` 命中 → 上下文保留），其次 resume 持久化会话，最后才新建
- 卡片：`POST /im/v1/messages` 创建 → `PATCH /im/v1/messages/{id}` 更新 → sealed 终态
- 配置热读：10s 检查变更；helper 每机器人一个子进程，崩溃自动重启（5s 冷却防重复 spawn）

## 开发

```sh
npm i                          # 安装 @larksuiteoapi/node-sdk（helper 用）
npm run check                  # node --check 语法检查
npm run smoke                  # 冒烟测试：mock DSH ctx + mock 飞书 API，跑完整回合链路
```

冒烟测试覆盖：helper 注册、入站消息管线（会话创建/消息投递）、流式卡片（create/PATCH/schema/工具面板/状态符号/note/seal）、命令处理、链路稳定性。

## License

MIT
