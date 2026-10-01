# DSH 0.2.0-rc.2 升级前兼容盘点（2026-10-02）

## ⚠️ 事故：升级后「全部任务都超时、没反应」（2026-10-02 03:2x–04:0x，已恢复）

**现象（CM 原话）**：dsh 全部卡住，直接全部任务都超时，没反应；期间两次重启（03:47:59、04:01:16）。

**证据链**

| 项 | 证据 | 判断 |
|---|---|---|
| 0.2 的 DeepSeek 模型目录**只有两个 id** | `dsh-llm-deepseek/lib/index.js` 的 `DEFAULT_MODELS` ＝ **`deepseek-flash`**（DeepSeek-V41-Flash）＋ **`deepseek-v4-pro`**（DeepSeek-V4-Pro） | **旧 id `deepseek-v4-flash` 已被移出目录**（＝ 0.1.7 release notes「移除 V4 Flash」＋「部分旧模型 ID 被移除」那两条） |
| 我们会话存的还是旧 id | 会话 request/header 里出现 `"model":"deepseek-v4-flash"` | 已保存的选择指向一个 **0.2 目录里没有的 id** |
| 恢复方式是"换模型" | 最近 request/header 出现 `deepseek-v4-pro` ＋ `deepseek-flash`；系统提示连续两次「model changed: … → flash → v4-pro」 | **换到目录内的 id 就通了** ⇒ 强指向"旧 id 请求挂起 → 超时" |
| 不是我的回填改动 | 冻结窗口（03:26:14 回填上线 → 03:47:59 重启）内 `web.log` **零 `[fs]` 行、零报错**；回填只读、512KB 上限、全 try/catch | ✅ 排除 |

**结论**：`deepseek-v4-flash` 是 **0.1.x 的模型 id**，0.2 目录里没有 ⇒ 还选着它的会话请求会挂起直到超时。
**这不是插件问题，是模型 id 迁移。**

**残留风险**：其它会话、以及另外两个 bot（`P:\FU` 足球 / `P:\BA` 篮球）若也保存了 `deepseek-v4-flash`，
用到它们时会复现同样超时 ⇒ 统一改成 `deepseek-flash`（快、省）或 `deepseek-v4-pro`（强、贵）。

**排查手法（下次直接照做）**：`web.log` 里**没有**模型层报错（模型 HTTP 层不写这个日志），判据是
① 模型目录里还有没有这个 id ② 会话 request/header 里的历史与最新 model ③ 系统提示里的「model changed」。

---

## ★ 升级结果（2026-10-02 03:0x，已上线并验收）

宿主现为 **`@deepseek-ai/dsh@0.2.0-rc.2`**，飞书桥已恢复。验收全绿：

| 项 | 结果 | 证据 |
|---|---|---|
| 插件未被跳过 | ✅ | `[fs] plugin apply #1 v0.4.14`；`--dump-config` 零告警零跳过 |
| 飞书桥 | ✅ | `helper spawned` ×3 → **`long connection ready` ×3** |
| 模型 | ✅ | 会话 v3/v4 均为 `"model":"deepseek-v4-flash"` / `"provider":"deepseek-official"` |
| HMR | ✅ | `hmr watching [...]`；保存 index.js 后 `hmr reload plugin` → `plugin apply #2` |
| 历史会话 | ✅ | 本会话上下文续上；迁移为 `session.v4.jsonl.zstd`，**旧 v3 文件原样保留** |

**升级后必须修的第二个破坏性变更（升级前没预判到）** 🔴

- 症状：`[fs] helper start failed: ctx.shell.start is not a function` 刷屏，
  **`long connection ready` 0 次 ⇒ 飞书完全收不到消息**（helper 是长连接的实际持有者）。
- 根因：0.2 新增 `@deepseek-ai/dsh-shell`，`ShellExecutor` 抽象方法为
  `resolve(request)` / **`execute(spec)`**，旧的 `start` 已被移除。
- **更隐蔽的第二处**：0.2 的 `resolve()` 会填 `timeoutMs` 并按 `onExpiry` 处理，
  **默认 `'kill'` 会把长驻 helper 直接杀掉** ⇒ 必须显式 **`onExpiry:'none'`**。
- 修法（已落 `index.js`）：`useExecute ? ctx.shell.execute(spec) : ctx.shell.start(spec)`，
  并对新版本传 `onExpiry:'none'`；返回句柄形状兼容（`status` / `kill()` / `readOutput().delta`）。
- **教训**：宿主大版本升级要按「**服务的方法签名**」逐条对，不只看插件 peer 与事件名。

**其他观察**

- `settings.yaml` → `settings.yaml.imported`（0.2 一次性导入，符合 release notes）。
- profile 的 `cordis.patch.yml` 被 0.2 **规范化重写**（保留了本插件所需的 HMR `root` 配置）。
- 会话日志按文件迁移：新写 `session.v4.jsonl.zstd`，旧 `session.v3.jsonl.zstd` **保留** ⇒
  **回滚比预想更安全**（v3 未被就地改写）。

---

## 〇、执行记录（2026-10-02 03:0x，CM 授权「开始」）

**做了什么（顺序）**

1. **备份**（`P:\Qoder\work\output\_dsh-upgrade-backup-20261002-025121\`）
   - `sessions\`（**1836 文件 / 1112 MB**，V3 会话日志 —— **不可逆项**）
   - `storages\`、`profile-web\`（package.json / pnpm-lock.yaml / pnpm-workspace.yaml /
     cordis.yml / cordis.patch.yml）、`settings.yaml`、`.credentials.yaml`、`AGENTS.md`、
     `dsh-npm` 的 `package.json` + `package-lock.json`
2. **改我们插件的 peer 范围**：`@deepseek-ai/dsh-tools` 从 `^0.1.0-rc.5`
   → **`>=0.1.0-rc.5 <0.3.0-0`**
3. **升 `dsh-vision-router` 2.1.7 → 2.3.0**（走官方 `dsh plugin --profile web add`）
4. **摘掉 `dsh-outline`**：只从 `dsh.profile.bundles` 移除（包与依赖保留，随时加回）
5. `npm install @deepseek-ai/dsh@0.2.0-rc.2`（113 新增 / 16 移除 / 285 变更，2 分钟）
6. **修 HMR patch 名**：`cordis.patch.yml` 里 `name: '@deepseek-ai/cordis-plugin-hmr'`
   → **`'@deepseek-ai/dsh-hmr'`**（0.2 已移除前者；`HmrConfig.root` 未变，已核源码）
7. **启动预演** `dsh --profile web --dump-config` → **零告警、零跳过**
8. 重启（唯一授权方式 `restart-dsh-web.cmd`）

**踩到并纠正的坑（重要）**

> **shost 的判定语义是 `semver.satisfies(v, range, { includePrerelease: true })`**
> —— 从 `@deepseek-ai/dsh-app-boot@0.2.0-rc.2` 的 `evaluatePluginCompatibility()` 原样抽出。
> 我一开始用 **默认 semver 语义** 判断，得出 `>=0.1.0-rc.5 <0.3.0-0` 连 `0.2.0-rc.2` 都不满足
> （因为 prerelease 默认不被范围接受），**差点把 peer 范围改错**。
> 按真实语义复验后：`^0.1.0-rc.5` → 0.2.0-rc.2 = **false（被拦）**；
> `>=0.1.0-rc.5 <0.3.0-0` → 0.1.6-alpha.1 / 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1 **全 true** ✅
>
> 判定函数的另外两个要点：① **只看 `name === '@deepseek-ai/dsh'` 或以 `@deepseek-ai/dsh-` 开头的 peer**；
> ② **插件没有 `peerDependencies` 字段 ⇒ 直接判兼容**（宿主盲区）。
> 豁免机制：`exemptions[`${name}@${version}`]` 里包含 runtimeVersion —— 即
> `dsh plugin --profile web allow-version <pkg>@<ver> --dsh-version <ver> --accept-risk`。

**预检结果（改完之后）**

```
目标运行时: dsh 0.2.0-rc.2
  [✅ 会加载] dsh-plugin-audit@0.1.2
  [✅ 会加载] dsh-vision-router@2.3.0
  [✅ 会加载] @qing3a/dsh-repo-context@0.1.0
  [✅ 会加载] dsh-feishucard@0.4.14
结果：0 个 bundle 会被 0.2 跳过
```

**回滚（三步）**

```powershell
# 1) dsh 本体回退
cd P:\Qoder\work\output\dsh-npm
Copy-Item "<备份>\package.json","<备份>\package-lock.json" . -Force
npm install

# 2) profile 配置回退（摘掉的 dsh-outline 加回、patch 名改回、vision-router 降级）
Copy-Item "<备份>\profile-web\*" C:\Users\CMFOK\.dsh\profiles\web\ -Force

# 3) 会话日志回退（**只在 0.2 把 V3 迁移成 V4 且 0.1.6 读不了时**才需要）
robocopy "<备份>\sessions" C:\Users\CMFOK\.dsh\sessions /E
```
`<备份>` = `P:\Qoder\work\output\_dsh-upgrade-backup-20261002-025121`
（路径也记在 `P:\Qoder\work\output\_dsh-upgrade-backup-LATEST.txt`）

---

> 结论先行：**当前不能直接升**。升完 `dsh-feishucard` 会被 0.2 宿主在组合阶段**整体跳过**
> （`rows: []`，装了但静默不生效）⇒ CM 在飞书上**彻底失联**且没有明显提示。
> 修法很小（改一行 peer 范围），但必须先改。

## 一、当前环境

| 项 | 值 |
|---|---|
| 已装 `@deepseek-ai/dsh` | **0.1.6-alpha.1**（`P:\Qoder\work\output\dsh-npm`） |
| registry 最新 | **0.2.0-rc.2**（prerelease，2026-09-29 发布） |
| 线上进程 | PID 28300 `node node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open`（cwd = dsh-npm） |
| profile | `C:\Users\CMFOK\.dsh\profiles\web` |
| 子包变化 | 全线 0.1.6-alpha.1 → 0.2.0-rc.2；新增 10 包；移除 `cordis-plugin-hmr`（改 `dsh-hmr`） |
| `npm install --dry-run` | 113 新增 / 16 移除 / 285 变更，**零冲突** |

## 二、致命项：0.2 宿主的「插件兼容性预检」

- 从 **0.1.7-rc.1** 起，dsh 启动时会检查 profile bundle 的 `peerDependencies` 中
  **以 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-` 开头的键**；不满足就
  `dsh: skipping profile bundle "X"` —— **整包跳过，不是降级**。
- **宿主的两大盲区**（实测，见 dsh-compat-vet §2.4/§3）：
  1. 插件**没有 `peerDependencies` 字段** ⇒ 直接判为兼容；
  2. **不看** `dsh.engines.dsh` / `dsh.compatibility.dsh` 这类野生声明，也不看 `engines.node`。
- **豁免机制**：`compatibility.json`（`dsh plugin --profile web allow-version <pkg>@<ver> --dsh-version <v> --accept-risk`）。

### 我们的插件踩的正是这一条

```json
// P:\Qoder\work\Ai100\projects\dsh-feishucard\package.json
"peerDependencies": { "@deepseek-ai/dsh-tools": "^0.1.0-rc.5" }
```
`^0.1.0-rc.5` ＝ `>=0.1.0-rc.5 <0.2.0` ⇒ **不含 0.2.0-rc.2** ⇒ 被拦。

**同类真实事故（一模一样的症状）**：[dsh-mcp-connector issue #101](https://github.com/duhu2000/dsh-mcp-connector/issues/101)
—— 单条 peer `@deepseek-ai/dsh-mcp-client: ^0.1.1-rc.2` 就让整个 bundle 被跳过，
`list_bundles` 返回 `error.code = "incompatible-version"` / `rows: []`，
用户侧表现是「插件还在、功能全没了、没有任何提示」。

## 三、profile 逐 bundle 体检（目标 0.2.0-rc.2）

| bundle | 约束性 peer | 0.2 是否被拦 | 处置 |
|---|---|---|---|
| **dsh-feishucard**（我们的卡片） | `@deepseek-ai/dsh-tools ^0.1.0-rc.5` | ❌ **会被拦** | **改一行** → `">=0.1.0-rc.5 <0.3.0-0"` |
| dsh-outline 0.1.6 | `^0.1.0-rc.6` ×5 | ❌ 会被拦 | npm 最新**就是 0.1.6**，无 0.2 适配版 ⇒ 只能等 / 隔离 |
| dsh-vision-router 2.1.7 | `^0.1.x`（llm-deepseek / anonymous-user-id） | ❌ 会被拦 | **升 2.3.0**（已声明 `>=0.2.0-rc.2 <0.3.0-0`）✅ |
| dsh-plugin-audit 0.1.2 | 只有 `cordis` / `schemastery` | ✅ 不受检（宿主盲区） | 无需动 |
| @qing3a/dsh-repo-context 0.1.0 | 全是 `*` | ✅ | 无需动 |
| dsh-sticky-note 0.2.3 | `^0.1.0-rc.6` | 会被拦，但**不在 `dsh.profile.bundles` 里** | 不加载，无视 |
| @dsh-external/dsh-split-panes | 全是 `*` | ✅（也不在 bundles） | 无视 |

## 四、我们插件的 API 兼容性（已逐条对源码，**兼容**）

拉到 0.2.0-rc.2 的 9 个关键包 tarball 逐条核对：

| 接触点 | 0.2.0-rc.2 | 结论 |
|---|---|---|
| `import { defineTool } from '@deepseek-ai/dsh-tools'` | 仍在导出表 | ✅ |
| `ctx.on('tools/execute')` / `'tools/pre-execute'` | `ctx.waterfall(carrier, …)` 原样 | ✅ |
| `user-questions/request`（`scopeTarget(agent, agent)`） | 原样 | ✅ |
| `approval/request` 转发白名单 | 仍在 | ✅ |
| `agent/status`、`goal/changed`、`goal/activation-changed` | 三个都在 | ✅ |
| `agent.ctx / steer / send(msg,target,wakeup) / whenIdle / cancel / inject` | 六个全在 | ✅ |
| `session.snapshotEvents()` / `append(type,data)` | 仍在（**但已弃用**）；签名向后兼容 | ⚠️ 可用，该排期迁移 |
| `commands.execute(agent, line, attachments, signal)` | 签名一字不差 | ✅ |
| `materializeFinalResult` 的 `error: result.error` 无条件写法 | 一模一样 | ✅ 我们的「必须抛错」修法仍正确 |
| `dsh web` 子命令 | 仍在 | ✅ |

## 五、网上反馈（0.2.0-rc 这一版）

- **官方仓库没有开放 issue**（搜 `repo:deepseek-ai/deepseek-harness` 的 issues 返回 0 条，社区走 Discussions）。
- 官方 rc.2 release notes 里有一条**正对我们**的修复：
  「修复切换会话或返回对话后**计划审阅无法打开**、「查看全文」消失」—— 即计划审查 GUI 侧的老 bug，rc.2 修好了。
- **会话迁移类报错**（0.1.7 起 Session 日志升级 **V4**，我们本地还是 **V3**）：
  - Discussion **#5978**「更新到最新 master 后，部分历史会话无法加载（v0 迁移校验过度严格）」
  - Discussion **#5694**「Failed to load history: failed to observe session」
- 生态为这件事长出两个专门的守卫插件：
  [dsh-compat-vet](https://www.npmjs.com/package/dsh-compat-vet)、
  [dsh-upgrade-guard](https://github.com/wqx11235/dsh-upgrade-guard)（后者维护「已知破坏性契约」表：
  0.1.1→0.1.2 模块表变严 / 0.1.2→0.1.5 inject 契约 / 0.1.6→0.1.7 `settingsScope` 移除 /
  0.1.7 primitives 图标改名 / 0.1.7 会话消息 V4 `source` 契约）。

### 与我们直接相关的 0.2 破坏性变更（官方 release notes 摘录）

1. `agent/session-start` → 异步串行 `agent/created`（**我们没用**）。
2. 弃用 `session.snapshotEvents/eventAt/ownEvents`（**我们在用**，0.2.0-rc.2 仍存在）。
3. Session 日志升级 **V4**（我们是 V3）。
4. 热更新**取消事务回滚**：激活失败可能部分生效。
5. 移除 `cordis-plugin-hmr`，改 `dsh-hmr`（**我们的「保存即热重载」依赖它**）。
6. 插件安装/启动做**兼容性预检**，可对确切版本给豁免。

## 六、建议的升级顺序（待 CM 拍板）

1. **改 peer 范围**（`dsh-feishucard/package.json`）：
   `"@deepseek-ai/dsh-tools": "^0.1.0-rc.5"` → `">=0.1.0-rc.5 <0.3.0-0"`。
   依据：① 已逐条核对 0.2.0-rc.2 的 API 面（见第四节）；② 新范围仍含当前 0.1.6-alpha.1 ⇒ 不影响现网。
2. **升 `dsh-vision-router` 2.1.7 → 2.3.0**（否则它也会被拦）。
3. **决定 `dsh-outline`**：没有 0.2 适配版 ⇒ 接受被跳过，或临时隔离。
4. `cd P:\Qoder\work\output\dsh-npm; npm install @deepseek-ai/dsh@0.2.0-rc.2`
5. 重启（**唯一授权方式**）：`cmd /c "P:\Qoder\work\output\dsh-install\restart-dsh-web.cmd"`
6. 重启后立刻验：飞书收发 → 插件 apply 行 → **HMR 是否还灵** → 历史会话能否打开 → 计划审查卡。

**回滚**：`npm install @deepseek-ai/dsh@0.1.6-alpha.1` + 恢复 `package.json.bak-pre020` /
`package-lock.json.bak-pre020`，再重启。

---

## 七、升级后验收（2026-10-01 晚，CM 亲测）

| 验收项 | 结论 | 出处 |
|---|---|---|
| DeepSeek Flash 模型可用 | ✅ | CM 2026-10-01 亲测「恢复了，可以用了」；会话 `--P-Qoder-work--/session-618fbbaf-1e8a-4948-8b28-0b4405e511a1/session.v4.jsonl.zstd` 两次 `request/header` **均为 `deepseek-flash`**（30 帧全文只有这一个 id） |
| `/list` | ✅ | CM 亲测「都能用」（含新增的 dsh 原生标题回填） |
| `/compact` 压缩 | ✅ | CM 亲测（0.2 上原本最担心的一项） |
| 旧 id `deepseek-v4-flash` | ✅ **API 直连实测可用**（不依赖目录） | 我 2026-10-01 直连 `https://api.deepseek.com/anthropic` 打 `POST /v1/messages` → **HTTP 200**，回包 `model = deepseek-v4-flash`，`usage = {input:31, output:16}`（另一个 404 是 base 打错到根域名，非模型问题） |

### 关键证伪：「旧 id 被移出目录 ⇒ 请求挂起」**不成立**

- `@deepseek-ai/dsh-llm-deepseek/lib/index.js:503-512` `modelInfo()`：
  请求的 id **没命中目录也不抛错**，只降级成
  `{provider, id, name, inputModalities:["text"]}`，`contextWindow` / `maxTokens` 回落默认值 ——
  **wire 上仍按原 id 照传给 API**。目录按源码注释是 *advisory*（`:41`）。
- ⇒ 此前我给出的因果链 **没有代码依据**（A24：无出处的断言）。
- ⇒ **已用 API 直连坐实**（`_probe_old_model.mjs`，key 从用户级环境变量取，值不打印）：
  `deepseek-v4-flash` → **HTTP 200**，回包 `model = deepseek-v4-flash`、
  `usage = {"input_tokens":31,"output_tokens":16}`；对照组 `deepseek-flash` 同样 200。
  ⇒ **旧 id 仍被 DeepSeek 服务**，目录缺失与请求成败无关。
- ⇒ **不需要改那 808 个会话文件**。真要把旧 id 补回目录，改插件配置即可：
  `:321 models: z.array(catalogModel).default(DEFAULT_MODELS)` —— 但该配置**启动时合并**
  ⇒ 要重启（须 CM 授权），且目录本身不拦请求，属可选项。
- **兜底**：`:17 DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5` = **5 分钟空闲超时**
  ⇒ 最坏是 5 分钟后明确报错，**不会无限挂死**（这也说明当初的长时间卡死另有原因）。

### 残留清单（**已证明无需处置**，只列出来备查）

`_scan_stale_model.cjs` 全量扫描 **1837 个会话，808 个仍存 `deepseek-v4-flash`** ——
**不用改**：① 目录不拦请求（代码证伪）；② API 实测 200；③ 最坏也有 5 分钟空闲超时兜底。
⚠️ 但**当初那次长时间卡死的根因仍未定位**（不是模型 id 失效，这条线索断了）。
其中 CM 会 `/switch` 到的主会话：

| workspace | 会话 | 模型 |
|---|---|---|
| `--P-Qoder-work--` | `fs-main-mu7y0u8l`（会话 3）、`fs-main-mup1y7yi`（会话 6）、`fs-main-mupoeiy4` | ⚠️ 旧 id |
| `--P-FU--` | `fs-main-mu2yt7oi`、`fs-main-muaz3fdd` | ⚠️ 旧 id |
| `--P-BA--` | `fs-main-mumyza49` | ⚠️ 旧 id |
| `--P-Qoder-work-Ai100--` | `fs-main-mstaqo1r`、`fs-main-mthl7tdp` | ⚠️ 旧 id |
| 当前活跃 | work `fs-main-muppqw21`、FU `fs-main-mupctftm`、BA `fs-main-mupcvmw7` | ✅ 已离开 |
