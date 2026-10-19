# DIAGNOSIS：format v4 source kind 拒收反复发作（#2009 未除根，真凶=两个自研钩子包）

> 2026-10-20 01:xx 排查定案｜中台 #2063（已 close 留痕）｜#2009 史段已补记关联

## 一句话

三 bot 反复上卡「本轮没有产生回复：format v4 message requires a producer-owned source kind · UNKNOWN」的真凶**不是** #2009 修的桥写入点，而是 10-19 下午新装的两个自研钩子包（dsh-session-gate、dsh-rule-hooks）用旧版裸 `kind:'plugin'` 往会话 inbox 注入消息，撞上 v4 准入校验。

## 时间线（全部本机实证）

| 本地时间 | 事件 | 证据 |
|---|---|---|
| 10-19 15:10 | dsh-session-gate 安装（A43 身份闸，redCard 注入） | 目录 mtime |
| 10-19 15:25 | dsh-rule-hooks 安装（六钩子，injectText） | 目录 mtime |
| 10-19 15:50 | **第一张 v4 失败卡** | message-index.json |
| 10-19 17:58 | CM 首次飞书报障（BA bot） | #2009 |
| 10-19 18:52 | #2009 修桥 reportCommandFailure（非主因） | bak-20261019-1826 |
| 10-19 20:23 | 全进程重启（桥修复+自愈生效） | 进程 CreationDate |
| 10-19 23:32 → 10-20 00:43 | 继续炸 8 张卡，「炸→自愈重建→又炸」循环 | message-index 14 条 |

## 机制（代码钉死）

1. v4 准入校验 `assertV4SourceRowAdmission`（dsh-session-format-v3-to-v4，经 dsh-session-persistence-jsonl 读+写两路都跑）：任何消息 `source.kind === 'plugin'`（裸，不带插件名的旧包装）⇒ `SessionFormatError` ⇒ 整轮拒收。
2. `agent.inject(msg)` → inbox(next-step) → 下一个 step 开始时拼接落盘（`agent/inbox/spliced` 的 inserted 数组同样校验）→ 拒 ⇒ 会话写入冻结。
3. **轮次不死**：handoff-gate audit 证明冻结后工具仍在执行（00:25-00:27 连续 ALLOW）——冻结的是持久化，不是推理；LLM 下一步调用时错误冒泡 → `normalizeLlmFailure` 包成 code=UNKNOWN → 桥上卡「…· UNKNOWN」。
4. **自愈无效的原因**：新会话首调触发 session-gate 注入 → 又写裸 plugin → 死循环。

## 断头轮指纹（会话侧）

四个断头会话全部冻结在 `step/start` 之后、无 `turn/end`：fs-main-mvfg90gi（00:09）、fs-main-mvff9q1e（23:41）、fs-main-mvfgtaeb（00:24）、fs-main-mvfc5tsj（21:35）。会话文件本身永远干净（被拒的写入不落盘），错误只存在于飞书卡与桥侧 message-index。

## 修复（2026-10-20 01:15 生效）

- 4 处 `source: { kind: "plugin", plugin: name }` → 生产者自有 kind：
  - `dsh-rule-hooks` → `{ kind: "rule-hooks", plugin: name }`（L176/L181）
  - `dsh-session-gate` → `{ kind: "session-gate", plugin: name }`（L92/L100）
- **真身与部署副本双改**：`scripts/dsh-hooks/{rule-hooks,session-gate}/`（同步区）＋ `~/.dsh/profiles/web/node_modules/`（真实复制副本，非 Junction），diff 一致。
- 备份四件 `*.bak-20261020-v4sourcefix`；`node --check` 过；`restart-dsh-web.cmd` 重启（新 PID 34804，三桥 helper 01:15:05 起齐）。
- 依据：v4 校验 default 分支放行任意非空 kind；先例=官方 hooks-claude-code 用 `{kind:"hooks-claude-code"}`、vision-router 用 `{kind:'plugin:dsh-vision-router'}`。

## 遗留与防复发

- `scripts/dsh-hooks/` 整目录 git 未跟踪（#2063 close 时 landed_untracked 提示）——建议纳入 git 管控，否则跨机同步/回滚无据。
- `smoke.mjs`、`prod-index-20261018.js` 内残留裸 plugin 写法：前者是模拟旧行为的测试件、后者是快照死文件，均非运行入口，不动。
- 自研钩子包今后新增 `agent.inject` 一律用生产者自有 kind，禁用裸 `kind:'plugin'`（v3 时代写法已退役）。
