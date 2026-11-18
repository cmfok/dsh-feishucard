# 更新日志 / Changelog

本文件记录**对外可见**的能力变化。更早的历史见仓库提交记录。

格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [SemVer](https://semver.org/)。

## [0.8.44] - 2026-11-19

### Changed

- 历史上剩余的 14 处内部引用全部清除：日志标签里的内部工单编号（#350 / #1130 / #2626 / #2331）、
  提示语里的内部工具路径、自测用例标题里的内部编号，统一改为中性表述。
- 本版发布物不含任何内部标识（CM 0 处、真实姓名 0 处、内部工单号 0 处、内网路径 0 处），可复核。

## [0.8.43] - 2026-11-19

本次为**发布面整理**版本：不改任何运行逻辑，只把不该出现在公开物里的内部记录清掉，并把对外说明重写。
下面逐条写清改了什么、改了多少，方便对照 git diff 复核。

### 文档

| 文件 | 变化 |
|:--|:--|
| `README.md` | 重写。原 445 行内部工程日志移入 `docs/internal/README.internal.md`；新的对外说明 59 行，含功能矩阵、安装、配置字段表、安全边界、兼容性 |
| `CHANGELOG.md` | 本文件重写。原 5811 行内部版本流水移入 `docs/internal/CHANGELOG.internal.md`；对外只保留本条目起的记录 |
| `llms.txt` | 纳入发布物（`package.json` 的 `files`），供 AI 工具读取能力摘要 |

### 代码（仅注释与测试样本，运行行为不变）

| 文件 | 改动行数 | 内容 |
|:--|--:|:--|
| `index.js` | 600 | 注释里的内部决策记录、内部工单号、内部目录名改为中性表述 |
| `scripts/smoke.mjs` | 249 | 同样是注释与测试用例标签，测试逻辑未动 |
| `identity-inject.mjs` | 55 | 注释中性化；自测夹具里的真实姓名换成占位值，对应断言同步更新 |
| `scripts/test-collect-roster.mjs` | 48 | 注释中性化 |
| `g3-inbox-report.mjs` | 16 | 注释中性化；自测里的示例路径改为通用路径（前缀匹配逻辑与根路径无关，断言不变） |
| `evalchat-route.mjs` | 3 | 注释中性化 |
| `heal-handoff.mjs` | 2 | 注释中性化 |
| `scripts/check-identityguard-scope.mjs` | 2 | 注释中性化 |
| `scripts/collect_bot_roster.mjs` | 2 | 注释中性化 |
| `scripts/sync-to-profile.mjs` | 4 | 注释中性化 |
| `scripts/test-fold-tables.mjs` | 4 | 注释中性化 |
| `selftest-*.mjs`（5 个） | 各 1-3 | 注释中性化 |

### 运行期文案（会改变实际输出文本，但不改行为）

| 位置 | 改动 |
|:--|:--|
| `index.js` 同步闸提示语 | 「中台同步闸·桥注入」→「同步闸·桥注入」；「维护者 裁决口径」→「决策口径」；占位符 `<维护者原话>` → `<决策人原话>` |
| `index.js` 消息记忆标签 | 「维护者 的消息：」→「用户的消息：」 |
| `identity-inject.mjs` 自测输出 | 打印标签里的内部称谓改为中性词 |

### 新增

| 文件 | 作用 |
|:--|:--|
| `scripts/pre-publish-scrub.mjs` | 发布前只读检查器。扫的是 npm 真正会打包的那批文件，自带 `--self-test`（违规样本必须报红、干净样本必须报绿），红了就拒绝发布 |

### 元数据

- `package.json`：版本 `0.8.42` → `0.8.43`；`description` 重写为一句说清「是什么 + 独有卖点」并覆盖检索关键词；`files` 增加 `llms.txt`；`scripts` 增加 `scrub`。

### 验证

- `npm run check`（语法检查）通过
- `identity-inject.mjs --selftest`：81 项通过 / 0 失败
- `g3-inbox-report.mjs --selftest`：全部通过
- `scripts/pre-publish-scrub.mjs --self-test`：双向通过；实扫发布面干净
- 打包内容核对：16 个文件，无内部文档

## 更早版本

`0.8.42` 及以前不再逐条回填——完整历史见仓库提交记录与各版本 tag。
