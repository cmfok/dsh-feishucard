---
title: "dsh-feishucard 对外接口登记（INTERFACE）"
date: 2026-10-09
tags: [接口登记, dsh-feishucard, AIAD]
status: active
---

# dsh-feishucard 对外接口登记

> 依据 `AIAD/插件边界与降级标准.md` §四建立（CM 2026-10-09 拍板）。
> 变更纪律：改下面任何一项必须**同一轮改本文件**；「代码有但这里没有」＝漂移＝bug。
> 依赖方向总览：本插件（L3 通道）→ 只读消费 G9 身份资产（L1）；G5/G9 工具插件**不依赖**本插件。

| # | 名称与路径 | 用途 | 调用方法 | 默认 | 依赖方向 |
|---|-----------|------|---------|------|---------|
| 1 | 环境变量 `MAILBOX_IDENTITY_MAP` | 覆盖身份表路径 | 部署时设为绝对路径；未设则按候选顺序（服务器固定路径→工作区 output/g9-identity/→cwd 向上 6 层→已知工作区兜底） | 未设 | 我 → G9 身份表（只读） |
| 2 | 环境变量 `MAILBOX_RESOLVER` | 覆盖 resolver 脚本路径 | 同上候选顺序；仅 `MAILBOX_RESOLVER_FORCE_PY=1` 时需要 | 未设 | 我 → G9 resolver |
| 3 | 环境变量 `MAILBOX_IDENTITY_LOCAL` | 本机增量身份表（各机独立，不参与同步） | 默认 `~/.dsh-feishucard/identity_map.local.json`；只按 name 补 `open_ids` | 未设（用默认路径） | 我 → 本机增量表 |
| 4 | 环境变量 `MAILBOX_RESOLVER_FORCE_PY` | 强制走 Python 解析通道 | 设 `1` 启用；默认纯 JS 镜像（零外部依赖） | 关 | 内部开关 |
| 5 | 服务器文件 `/opt/scripts/G9/identity_map.json` | 身份主表（open_id→人） | 直接读（fail-closed：表不可达＝拒＋文案「目前服务不可用，请联系管理员」） | — | 我 → G9（跨项目消费，**变更须 G9 侧同步本文件**） |
| 6 | 服务器文件 `/opt/scripts/G9/resolve_actor.py` | 身份解析器（FORCE_PY 时 spawn） | spawnSync python | — | 我 → G9（同上） |
| 7 | 配置文件 `feishu.config.json`（`~/.dsh-feishucard/`） | bots 数组（多 bot 定义） | 改后 10 秒热更新，无需重启 | — | 我自有；⚠️ G9 的 open_id 采集脚本会来读它（**反向依赖，标准 §一 不允许，待治理**） |
| 8 | 数据文件 `capability_grants.json`（configDir 下） | 能力审批表（0600） | 只经插件读写（读-改-写临时文件+rename）；读失败＝按未获授权 | 总闸 capabilityGuard **关** | 我自有（CM 审批数据） |
| 9 | 数据文件 `bot_roster.json`（configDir 下） | 同群 bot 名单 | `scripts/collect_bot_roster.mjs` 采集；插件按 mtime 热读 | — | 我自有 |
| 10 | `helper-cred-*.json`（`~/.dsh-feishucard/`） | helper 进程凭证 | helper.cjs 启动参数传入；含 appSecret，禁明文外泄 | — | 我自有（机密） |
| 11 | 端口 3099 / 3200 | 两个 feishu profile 的 DSH web 实例（systemd `dsh-feishu` / `dsh-feishu-aiad`） | systemd 管理；**禁止随意重启**（DEV-PURPOSE.local.md 最高令） | 常驻 | 我 → DSH 宿主 |
| 12 | 端口 3081 | web profile（网页 GUI，`--trusted-host` 映射 3080） | systemd；同上 | 常驻 | 我 → DSH 宿主 |

## 消费方须知（谁在依赖我）
- 8+ 个飞书 bot 的全部收发经本插件；G5/G9 工具插件的工具注册**不经**本插件（拔掉桥＝工具与权限照跑，仅飞书通道断，由看门狗恢复）。
- G9 的 `open_id采集-通讯录批量-20261007/pull_openid_by_contact.py` 读本插件 `feishu.config.json` 取凭证——这是唯一已知的反向依赖，待治理（标准 §一）。
