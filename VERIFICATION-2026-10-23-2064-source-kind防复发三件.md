# 2064 · DSH source.kind 防复发三件 · 收口验证（2026-10-23）

> 机器：HOME（CMHOMEPC）｜A43 闸 exit 0（DEGRADED 放行，宿主未被识别，机器身份本身已核实）
> 工单：信息中台 dsh-feishucard #2064（medium，H-D362 防复发三件）
> 裁决依据：H-D362（v4 source.kind 新规）＋ **H-D390（2026-10-22 CM 采纳选项 1：接入 machine-doctor.ps1，
> 复用每日巡检 ⑥v 既有链）**——注意工单原文「优先每日巡检 daily-patrol.py」与后到的 H-D390 裁决
> 不一致，按「新旧冲突以最新为准」执行 H-D390 的 machine-doctor 接法。

## 件1：smoke.mjs 头部 v3 历史格式警示注释 —— 已做（先前会话完成，本次仅确认）

- 证据：`dsh-feishucard/scripts/smoke.mjs:1-2`
  `// v3 historical message format appears in fixtures below for compatibility simulation only;`
  `// do not copy those fixtures into runtime code.`
- 与 git log 提交 `9cc894f`（H-D362 件1）吻合。**本次未改动该文件**（并行代理冲突面，遵守约束）。

## 件2：检查点接入日常巡检面 —— 本次完成（主战场）

先实测核对：接线**此前并未落**——`check-dsh-plugin-source-kind.mjs` 全库 grep 只命中脚本自身。
另注：工单写的路径 `dsh-feishucard\scripts\check-dsh-plugin-source-kind.mjs` 不准确，
检查点实存于 **work 根** `P:\Qoder\work\scripts\check-dsh-plugin-source-kind.mjs`（H-D362 原文相对路径即此）。

本次改动（唯一改动文件，work 根 scripts/，独占写权内）：

- `scripts/machine-doctor.ps1` V1.0-26101901 → **V1.1-26102301**
  - 头部 Purpose 增补第 [7] 项说明（`:15-23`）
  - 新增检查段 `[7] DSH source.kind compliance`（`:218-250`）：
    node 调 `scripts/check-dsh-plugin-source-kind.mjs`（只读扫描），
    **fail-loud 四态全报红**：脚本缺失→RED；node 缺失→RED；非零退出（1=违规/2=环境异常）→RED 附明细；
    抛异常→RED。仅 exit 0 记 ok。
- `scripts/daily-patrol.py` **零改动**——其 ⑥v（`step6v_machine_fit`，`:2000-2037`）本就子进程跑
  machine-doctor 并抓 ` RED [` 行进 findings，doctor 新红项自动经此链进每日巡检（即 H-D390 选项 1 的复用链）。

### 实测输出（2026-10-23 01:2x，本机真实执行）

1. 检查点直跑：
   `node scripts/check-dsh-plugin-source-kind.mjs` → `scanned=1509 violations=0`，**exit=0**
   （台账旧数字 1673 系 10-20 时点，node_modules 内容随时间变化，属正常）
2. doctor 全量（接线后、变异前）：`ok  [7/7 source-kind] source.kind checkpoint exit 0 (scanned=1509 violations=0)`
3. **变异反证（防假绿）**：临时造 `scripts/dsh-hooks/_tmp-mutation-2064.mjs`
   （内含 `source: { kind: 'plugin', ... }` 裸包装）：
   - 检查点直跑 → `RED P:/Qoder/work/scripts/dsh-hooks/_tmp-mutation-2064.mjs @138`，
     `scanned=1510 violations=1`，**exit=1**
   - doctor → `RED [7/7 source-kind] source.kind checkpoint exit 1: RED ... scanned=1510 violations=1`，exit 1
   - 巡检 ⑥v 实调（import daily-patrol 后真跑 `step6v_machine_fit`）→ 输出
     `⑥v 🔴 装配体检红 2 项（rc=1）`，findings 含
     `⑥v 本机装配体检红 2 项（rc=1）：… source.kind checkpoint exit 1: RED …`——**红项全链传导成立**
   - 变异件已用 `scripts/trash.ps1` 移回收站删除（成功=1），目录复查仅剩 rule-hooks/session-gate
4. 清理后回绿复测：检查点 `scanned=1509 violations=0` exit=0；doctor `[7/7] ok`；
   ⑥v 实调 findings 只剩存量红 1 项（下述）。

### 附带发现（非本单范围，如实上报）

doctor `[4/6 sync-rules]` 报红为**存量问题**：work 根 `.stignore` 无 `/.mailbox.local.json` 排除行
（grep 实测零命中，文件未被本次任何改动触碰），意味着身份文件可能被另一台机器 Syncthing 覆盖
（2026-10-04 事故同源）。归机器装配/信息中台域，待另行处置。

## 件3：vision-router 升 3.0.4 顺手统一 source 形态 —— 未做（前提已消失）

实测：vision-router 插件包已于 2026-10-21 退役移出运行面，归档在
`output/dsh-install/_trash/dsh-vision-router-remove-20261021/`（含 removed-original/），
运行面 `~/.dsh` 仅剩旧日志目录，无现役代码可统一。工单标注「可选」，**无需再做**。
（检查点内 `VISION_BASE_MSG` 豁免（`check-dsh-plugin-source-kind.mjs:41-43`）作为历史白名单保留不碍事。）

## 结论

件1 ✅（先前已做，本次确认）｜件2 ✅（本次接线 machine-doctor → ⑥v，变异反证能报红、清理后回绿）｜
件3 ➖（对象已退役，不做）。#2064 防复发三件收口完成，运行代码零改动，无 git 操作（由主会话统一提交）。
