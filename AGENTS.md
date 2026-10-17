# dsh-feishucard 项目规则（AGENTS.md）

> 桥插件：DSH ↔ 飞书（流式回复卡、多 bot、/命令、审批卡）。版本与逐版部署记录见 `CHANGELOG.md`；
> 本地开发档案（不进 Git，`.gitignore` 的 `*.local` 命中）见 `DEV-PURPOSE.local.md`。
> 建档：2026-10-14（HOME#ZCode-sess_ac1913c9，A15 碰即建＋中台 #330 收尾 c）。

## 铁律（CM 历次裁决，按最新在上排列）

1. **禁止随意重启**（CM 2026-10-01 明令，最高优先，全文见 `DEV-PURPOSE.local.md`）：本机改源码保存即生效（profiles junction + HMR）；改配置/装卸插件/改依赖才需重启，且必须 CM 明示。每轮回复如实标注「线上现跑哪一版 ＋ 待生效清单」，不许让 CM 以为改动已生效。
2. **发布闸门**：`npm run check` → `check-packaging` → `identity-inject --selftest` → 全量 `npm run smoke` 0 红 → **staging 先行验证** → 生产走 G11 审批单（gatekeeper）。生产重启避开 G9 观察期审计窗口（现行：观察期至 2026-10-15）。
3. **插件边界与降级标准（CM 2026-10-09 拍板）**：权威文本 `AIAD/插件边界与降级标准.md`。三档降级语义全插件强制——
   - **L1 权限挂**：统一文案「目前服务不可用，请联系管理员」，fail-closed 不变（CM 2026-10-04 裁决），拒的同时告警管理员（G9 `g9_alert_watch.py`）。落地：0.8.6 两处身份 deny 支路 ＋ smoke 用例 114。
   - **L2 工具挂**：工具失败返回结构化错误文字引导 agent 如实表述「该工具暂时不可用」＋声明未经工具/数据核实，禁止假装成功；同插件其他工具照常。落地：0.8.14 `tools/execute` L2 引导瀑布 ＋ smoke 对照组。
   - **L3 卡片挂**：渲染失败自动退纯文本（已实现），覆盖面由 smoke 用例钉住。
4. **接口登记制度**（标准 §四）：对外接口唯一登记处 = `INTERFACE.md`（六要素），**代码改了接口必须同轮改它**，「代码有但这里没有」＝漂移＝bug。
5. **多 bot 预设边界**（CM 2026-10-09 #171 拍板）：跨 bot 职责红线——每 bot 可经 `agentPreset` 指定预设（hr bot → preset-hr），挂载失败必须日志可见、不静默回落（0.8.5）。

## 决策台账（A34 项目自管）

- 位置：`decisions/` 目录，一篇一裁决（CM 拍板实录＋落地指针，首行 `[已落地→<路径>]`），长文叙述留这里。
- 机器台账（2026-10-17 建成，取代原「ledger 脚本待建」口径）：追加只走
  `powershell -File AIAD/scripts/ledger.ps1 -Action append -Machine HOME -Root <工作区根> -Project dsh-feishucard -Title … -BodyFile …`
  → 落 `0-必读文件/CM决策台账-HOME.md`，台账号 `H-D<N>` 自动取号（该目录已进本仓 `.gitignore`，属内部台账不入库）。
  🔴 信息中台关单（`mt.py close`）对「已有 CM 裁决」的单强制要求 `--landed <文件路径>#<台账号>`，
  所以每条裁决**必须**有台账本里的台账号，否则关不掉（固化回写闸 B9）。

## 工程速查

- 冒烟：`npm run smoke`（mock 飞书、`feedInbound` 驱动；**0 红 = 可交付**，红一条也要先修）
- 语法：`npm run check`
- staging：`ssh staging-gz`，服务 `dsh-feishu-staging.service`（supervisor bot），插件路径 `/srv/aiad/.dsh/profiles/feishu/node_modules/dsh-feishucard`（Agent 自由区）
- 生产：`ssh my-server` **只读白名单**（journalctl/status/cat 等），服务 `dsh-feishu-aiad.service`（多 bot）＋ `dsh-feishu.service`（3099，CM 个人 bot）；**生产写变更一律走 G11 审批单**，禁止直改
- 会话 id 口径：本桥自建会话 `fs-main-<36进制时间戳>`；显示层短 id 取**尾 8 位**（#529）
