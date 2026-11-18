# dsh-feishucard

把 DeepSeek Harness 的 agent 会话接进飞书 / Lark：一条长连接、一张会自己更新的流式回复卡。

Bridge DeepSeek Harness agent sessions into Feishu (Lark) chats — one long connection, one live-updating reply card.

> 非官方项目，与 DeepSeek、飞书 / Lark 官方无隶属关系。Not affiliated with DeepSeek or Feishu / Lark.

## 功能矩阵 / Feature matrix

| 功能 | 说明 |
|:--|:--|
| 流式回复卡 | 一个回合一张卡，边跑边更新；工具调用折叠成可展开面板并带状态符号 |
| 无需公网 | 走官方 SDK 的 WebSocket 长连接，不要公网 IP、域名或内网穿透 |
| 单实例多 bot | 一个 DSH 进程挂多个飞书机器人，每个 bot 绑定自己的工作区 |
| 每会话独立 agent 会话 | 飞书里每个私聊/群各对应一条独立的 agent 会话，上下文互不串 |
| 群里 @ 才回 | 群聊默认只在被 @ 时响应；私聊总是响应 |
| 命令 | `/new` `/switch` `/list` `/help` `/model` |
| 审批与提问卡片 | 工具审批、agent 反问都以飞书卡片下发，点按钮即作答 |
| 身份注入（可选） | 把入站消息解析到具体的人，并用权威值覆写工具调用的身份字段 |
| 可靠性兜底 | 限流退避、熔断、纯文本降级，卡片发不出去也不会丢回复 |
| 图片与文件 | 入站图片/文件落盘并作为附件进入会话 |

## 工作方式 / How it works

一个 npm 包内含三部分：Host 插件、长连接子进程 helper、以及一份自动注册的 bundle 补丁（`cordis.patch.yml`）。插件启动后由 helper 维护飞书长连接；消息进来转成 agent 回合，回合进展持续 PATCH 到同一张卡片上。

## 安装 / Install

```sh
npm i dsh-feishucard
```

或用 DSH 的插件命令装进指定 profile：

```sh
dsh plugin --profile web add dsh-feishucard
```

装完重启该 profile 的 DSH 进程即可生效（配置变更与依赖安装都需要重启）。

要求：Node.js >= 22.15.0；需要 DSH Host 的 `@deepseek-ai/dsh-tools` 在 `>=0.1.0-rc.5 <0.3.0-0` 区间内。

## 配置 / Configuration

默认读取 `~/.dsh-feishucard/feishu.config.json`（可用环境变量 `FS_CONFIG_DIR` 指向别的目录）。

```json
{
  "bots": [
    {
      "name": "我的飞书机器人",
      "workspace": "/absolute/path/to/your/workspace",
      "appId": "cli_xxxxxxxxxxxxxxxx",
      "appSecret": "your_app_secret"
    }
  ]
}
```

`workspace` 必填，是这个 bot 服务的 agent 工作区绝对路径；`appId` / `appSecret` 来自飞书开放平台的**自建应用**，需开启**机器人**能力与**长连接**接收方式。

完整字段（含每个可选项的默认值与含义）见仓库里的 `feishu.config.example.json`，那里每个键都写了说明。

### 常用的几个开关

| 键 | 默认 | 作用 |
|:--|:--|:--|
| `mode` | `"full"` | `"stable"` 是精简渲染档，群聊与受限环境用 |
| `groupRelay` | `"self_only"` | 群聊里没 @ 本 bot 的消息如何处理：`self_only`/`off` 忽略、`mentions_any` 只收 @ 了别的 agent 的、`all` 全收（有速率限制） |
| `approvalForm` | `false` | 设为 `true` 才把沙箱审批做成卡片通道 |
| `identityGuard` | `false` | 身份闸；开启后按 open_id 查身份表，拿不到身份就拒绝执行 |
| `splitConclusionMinMs` | `30000` | 超过这个耗时的回合，结论单独发一张新卡（新消息才会触发飞书通知） |

## 命令 / Commands

| 命令 | 作用 |
|:--|:--|
| `/new` | 开一条新会话 |
| `/switch` | 切换会话（工作区 → 会话 两级选择） |
| `/list` | 列出会话 |
| `/model` | 查看与切换模型 |
| `/help` | 帮助 |

## 安全与边界 / Security notes

- 插件代码在 Host 进程里、以你自己的权限运行 —— 它能读你的文件、用你的凭证、访问网络。工具审批不会沙箱化插件自身。
- `appSecret` 只存在本机配置文件里，不随包分发；本包发布物中只有 `*.example.json` 占位符。
- `identityGuard` 默认关闭。关闭时不判权、不查身份表，但飞书回合里的严格身份字段（`open_id` / `union_id` / `person_id` / `sender_open_id` / `sender_union_id`）仍不会原样转发模型自报值：有入站真值就用真值覆写，没有就剔除并留审计行。
- 两个飞书桥插件（本包与其它同类）**不要同时装进同一个 profile**：它们会争抢同一条长连接。

## 兼容性 / Compatibility

- Node.js `>=22.15.0`
- DSH（DeepSeek Harness）`0.2.x` 系列
- 飞书 / Lark 自建应用 + 机器人能力 + 长连接接收

## 开发 / Development

```sh
npm run check     # 语法检查
npm run smoke     # 全量冒烟
```

## 许可 / License

MIT，见 [LICENSE](./LICENSE)。安全问题请按 [SECURITY.md](./SECURITY.md) 的方式报告。
