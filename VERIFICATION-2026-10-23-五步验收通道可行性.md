# #771 / #1894 五步真机验收 —— 通道可行性核查（严格只读）

- 核查日期：2026-10-23（机器 HOME，宿主 Qoder；A43 机器闸 rc=0、宿主判定 DEGRADED，属已知）
- 核查方式：**全链路只读**。只跑了 help/schema/auth status/profile list/chat-list/chat-members-list/chat-messages-list（read 级）＋ 本地文件读 ＋ 本机管理面 curl。**未发送任何飞书消息、未上传任何文件、未写任何库、未 ssh 任何环境、未做任何 mt.py/git 写操作。**
- 核查对象：dsh-feishucard 池 #771 / #1894 唯一未达成项「五步真机验收」；关联阻塞申报 #2252
- 判据原文出处：`output/g9-tickets/342/报告.md` §六（本仓 `VERIFICATION-2026-10-23-771-1894-resume发布验收核查.md` 问 3 已逐字摘录）

## 总判定：**B —— 通道存在，但代价是「以 CM 本人身份对外发真实消息」＋「往生产业务库写入测试数据」，需 CM 一句放行；执行主体仍是我（红线 A41）**

三条分项结论（详细证据见下文各节）：

1. **能定位到 hr bot 的会话**，chat_id 已实测钉死：`oc_1eda77a6563043f231681291452ffff4`（飞书显示名「觅人小友@鸿津」，app_id `cli_a97b99468779dbb4`）。问 1 的「无通道」断言**不成立**。
2. **resume 腿可走，但有一个此前没写清的技术前提**：桥的入站解析有**三条腿**（复用活句柄 → resume 持久化会话 → 新建），只有**桥进程重启后该会话的首条入站**才真正走 resume；不重启的话下一条消息走的是「复用活会话」，验不到 resume 腿（代码出处见 §二.3）。而「重启生产桥」＝生产写变更，须走审批单。
3. **五步第 3 步会往生产业务库真实写行，且判据里的表名已经过时**：现役写入目标是 `biz_g5v2_candidate / biz_g5v2_resume_analysis / biz_g5v2_delivery / biz_g5v2_question_bank`，v1 表 `biz_G5_resume_analysis` 自 2026-10-18 起**零操作**（源码注释明写）。这既说明「按现判据验收」物理上不可能出现新增行，也说明**必须先把判据表名更正**，否则拿不到绿灯。测试数据**没有隔离标记字段**，现成的清理脚本**硬拒生产库**，写进去的测试候选人会出现在 CM 看的候选人列表卡里（下游有读）。

因此：**这不是「agent 做不到」（不是 C），而是「agent 能做但要 CM 放行两件事」**（B）。唯一真正做不到的子项是 **L1/L2 员工档位那一腿**（见 §四）——它必须由一名真实员工的飞书账号亲手发消息，任何本机身份都替代不了，该子项按 C 处理。

---

## 〇、先更正任务给的前提（不更正会一路错下去）

**「本机桥管理面能查到 hr bot」这句不成立。** 实测本机 3080 管理面只有 HOME 自己的三个 bot，没有 hr：

```
curl -s --max-time 10 http://127.0.0.1:3080/feishu/admin/status
HTTP 200
{"ok":true,"bots":[
  {"appId":"cli_aaf77f129a78dcc8","name":"work",  "connection":"connected","lastChatId":"oc_ebe4ef87bc88cffb92b83c277c371070"},
  {"appId":"cli_aa23382208f89bdd","name":"FU足球","connection":"connected","lastChatId":""},
  {"appId":"cli_aa266e7b1b789d23","name":"BA篮球","connection":"connected","lastChatId":""}]}
```

hr bot 挂在**生产**桥 `dsh-feishu-aiad.service`（多 bot），管理面在生产机自身的 `127.0.0.1:3200`（本机不可达）。出处：本仓 `DIAGNOSIS-2026-10-11-生产桥管理面3099.md:36`（生产 5 个 bot 长连接＝搞钱搭子/扒数小酱/知识津仔/**觅人小友**/MAIN）、`:88-93`（3099 属 CM 个人 bot 那条服务，aiad 桥 admin 面在 3200）。

**结论**：不能指望「本机管理面 → hr bot 身份」这条路；hr 身份要从登记表＋飞书侧反查。下面就是这么做的。

---

## 一、问 1：能不能定位到 hr bot 的那个会话？—— 能，chat_id 已钉死

### 1.1 hr bot 的应用身份（本地文件，零 API）

- `AIAD/G8-基础设施/shared/feishu_bots.json:45-58`（Bot 唯一登记处）：`name: "HR Bot"`、`profile: "hr"`、`app_id: "cli_a97b99468779dbb4"`、`status: active`、`category: data`。
- 同文件 `chats` 节只登记了一个**群**：`oc_76ddd28f68d34d45d44b03f5e890aca6`（面试通知群），**没有登记 CM↔hr 的单聊**——登记面对这个会话是空白，所以必须去飞书侧实测。

### 1.2 用 user 身份列单聊，再按 app_id 反查（只读，共 3+1 次 API）

命令形态（flags 属于子命令，实测可用）：

```
lark-cli im +chat-list --types p2p --as user --page-size 100 --page-all --jq '[.data.chats[]?|{chat_id,name}]'
lark-cli im +chat-members-list --chat-id oc_1eda77a6563043f231681291452ffff4 --member-types bot --as user --jq '[.data.bots[]?|{app_id,name}]'
```

第一条返回 124 个 p2p 会话（`--page-all` 已翻完，末条序号 123）。第二条的关键输出：

```
[page 1] fetching...
Found 0 user(s) and 1 bot(s)
[ { "app_id": "cli_a97b99468779dbb4", "name": "觅人小友@鸿津" } ]
```

⇒ **CM↔hr bot 的单聊 chat_id ＝ `oc_1eda77a6563043f231681291452ffff4`**，会话内唯一 bot 成员就是生产 hr 应用。

排除过程一并留下（防后人再猜）——三个看着最像的名字实测都是**别的应用**：

| 会话名 | chat_id | 实测 app_id | 是否 hr |
|---|---|---|---|
| HR_test | `oc_155d0bce047b87e5cde126207a99b13f` | `cli_aa83f5717b789bde` | ❌ |
| HR_Staging | `oc_35c64690cdd1d8dbe7fb10a90aa30362` | `cli_aa4181ad73b9dbb5` | ❌ |
| DSH_Server | `oc_85b7a86040cb922d82b93473bbb6cdc6` | `cli_aa41184045b89cc2` | ❌ |

（这三条各一次 `+chat-members-list`，命令形态同上。）

**注意**：名字里带「test / Staging」的都不是生产 hr；生产 hr 的显示名是业务向的「觅人小友@鸿津」，靠名字猜必错。

### 1.3 会话可读性（只读判据，供后续验收用）

`auth status` 实测 user 身份 available=true、userName「C M」、scope 含 `im:message.p2p_msg:get_as_user`／`im:chat:read`／`im:message.send_as_user`。**读历史已实测通过**（见 §二.2），拉了 20 条、`has_more: true`。

---

## 二、问 2：这个会话能不能走 resume 腿？—— 能，但「下一条消息必走 resume」是错的，必须先重启桥

### 2.1 会话指针的存储位置（代码实测，非记忆）

- `dsh-feishucard/index.js:12`（文件头 State 说明）：`State: ~/.dsh-feishucard/state-<appId>.json (per-bot chat/session map)`
- `index.js:654-658`：`configDir = () => process.env.FS_CONFIG_DIR || join(homedir(), '.dsh-feishucard')`；`statePathFor(appId)` → 同目录 `state-<appId 去非字母数字>.json`
- `index.js:4105-4135`（`loadChats`）：从该文件恢复 `sessions / activeIndex / remounts(#771 熔断计数) / kind / peer / peerUnion`——**跨重启恢复会话指针的机制就在这**
- `index.js:4137` `persistChats(bot, chats)` 落盘

⇒ 生产 hr 的那份指针文件＝`/srv/aiad/.dsh-feishucard/state-clia97b99468779dbb4.json`。**agent 读不到**（`ops_read.sh ls/cat/tail` 对该目录 `Permission denied`，已在 `output/g9-tickets/342/报告.md` §三.2 实测登记，本次未重试同类生产通道）。本机同结构目录实测在位、但没有 hr 那份（`ls C:\Users\CMFOK\.dsh-feishucard\` 只见 `state-cliaa23382208f89bdd / cliaa266e7b1b789d23 / cliaa470597b9f95bd1 / cliaaf77f129a78dcc8` 四份，对应 FU/BA/CODEX/work，无 hr）——**符合预期**：hr 跑在生产，不在本机。

### 2.2 用历史消息反证「这个 chat 确实有会话、且不是每次 /new」（只读实测）

```
lark-cli im +chat-messages-list --chat-id oc_1eda77a6563043f231681291452ffff4 --as user --order desc --page-size 20 --no-reactions
```

关键条目（原文照录，取 2026-10-23 02:38 那一刻的快照；更早历史 `has_more:true` 未取）：

```
2026-10-22 18:25 | user  | text       | /new
2026-10-22 18:25 | app hr| interactive| 新建会话并切换成功 🗂 工作区：hr（路径:agents/hr）🤖 模型 zai-coding-cn/glm-5.3-flash（旧会话 fs-main-mvf9bfcd 已停……）
2026-10-22 18:25 | user  | text       | 你去帮我创建一个面试：有一个员工叫"测试账号"，约今天面试……
2026-10-22 18:26 | app hr| interactive| ✅ 约面成功 - 候选人：测试账号 …… 已创建日历并发通知到面试群
2026-10-22 18:40 | app hr| interactive| 💬 文字评价 · 测试账号 ……
2026-10-22 17:37 | user  | post       | 你去帮我创建一个面试：……（同一条，17:38 报「约面脚本运行出错：退出码 1」）
2026-10-20 15:39 | app hr| interactive| 梁婉君简历分析（真实简历分析卡，ID:367，全职主播）
2026-10-19 21:58 | user  | text       | 候选人列表
```

能钉死的三件事：

1. **该 chat 有绑定的 DSH 会话，且存在会话更替史**：18:25 的 `/new` 卡片明确「旧会话 `fs-main-mvf9bfcd` 已停」⇒ 之前一直有个持久化会话被接管，resume 腿在这条 chat 上是**真实在用的**（不是每次新建）。
2. **`/new` 不是常态**：17:37 那条消息之前**没有** `/new`，agent 直接接管老会话答了（17:38 的错误卡带「🧠 18.5K/1M ｜ 缓存命中 98.1%」的会话态页脚——同一会话续跑的痕迹）；`/new` 在 18:25 才出现，且是为了解决具体问题（避免两个会话同时往这个群发卡），不是例行动作。
3. **判据「近期没有发过 /new」需要带时刻**：取样时刻 2026-10-23 02:38 能看到最近一次 `/new` ＝ 2026-10-22 18:25（约 8 小时前），**当天 18:25 之后到 18:40 的三条都是新会话在自己身上续跑**。所以「有一条老会话指针会被复用」成立，但「很久没 /new」不成立——若要拿「纯 resume 腿、无近期 /new」的窗口，得往后看。

### 2.3 ⚠️ 必须写进验收方案的机制更正：**下一条消息未必走 resume**

`index.js:4304-4336`（`resolveAgent`，实测阅读）定义的入站解析顺序是三条腿：

```
if (entry.handle) return ensurePresetTools(...)                 // (0) 本进程已有句柄 → 直接复用
const live = list.find(a => a.id === entry.id)                  // (1) DSH 启动会恢复会话 → "reused live session"
if (live) { ... return ensurePresetTools(bot, chat, live) }
// (2) Otherwise try resume (prepares the persisted session).
const handle = await resumeDedicated(bot, entry.id, mainAgent)
```

配合 `index.js:3999-4001` 的原话：**「resume 腿的触发条件是『本进程还没这个会话的句柄』＝重启后每条会话的首个入站」**。

⇒ 结论：
- 若桥进程自 10-22 18:25 建会话以来**没重启过**，今天再发一条消息走的是 (0)/(1) 复用活会话，**验不到 resume 腿**；
- 要**确定**命中 resume 腿，必须先让生产桥重启一次（`dsh-feishu-aiad`）——属生产写变更，须走 G11 审批单（`dsh-feishucard/AGENTS.md` 铁律 2、`AIAD/0-必读文件/规则/04` 与 `prod-delivery` 通道），且重启会断全部 bot 30-60 秒。
- 替代路径（不动生产）：等某次**本来就计划内**的 0.8.17+ 批次发布重启后，取该 bot 的第一条真实入站作为 resume 样本。

**验收观测点（代码里真实存在的留痕，别只靠 agent 自述）**：`index.js:4167-4231` 的 `#771 根治 B` 腿——`presetToolsMissing` 判定（:4162，`.every(name => tools.get(name, agent) === undefined)`）、招牌键 `DEFAULT_PRESET_SIGNATURE_TOOLS = ['read']`（:4119）、四条留痕「熔断跳过／重建中／重建成功／重建失败」（:4202/4207/4227/4231）。判据应是生产 journal 里 `preset mounted: hr (bot=hr, agentPreset=hr)` ＋ `preset mount failed=0` ＋ 无 `#771 preset tools (still) missing`。

---

## 三、问 3：跑这套验收会往生产写什么？—— 会真实写生产业务库；且判据表名已过时

### 3.1 判据表名 `biz_G5_resume_analysis` 已经作废（三处独立证据）

| 证据 | 出处 | 内容 |
|---|---|---|
| 源码 | `AIAD/G5-人事管理/v2/tasks/analyze_resume_final.py:635-638` | 「v1 遗留表 biz_G5_resume_analysis **零操作**（2026-10-18 #374/#1705 修复，H-D19/H-D22：旧表仅历史只读兜底）。原先此处的『查重 → DELETE 旧记录 → 条件 INSERT（G5_V1_MIRROR_WRITE）』已整体移除」 |
| 裁决 | `AIAD/G5-人事管理/0-必读文件/CM决策台账-HOME.md:105`（H-D13）、`:160`（H-D9/D10 系） | 「v1 镜像表默认停写…观察期确认无人引用后退役」；「G5 候选人数据只留 v2 权威库——权威源为 biz_g5v2_candidate / biz_g5v2_resume_analysis…旧表不再写入」 |
| 现役写入 | 同上 `analyze_resume_final.py:640-651` | 「写 v2 权威库…**已写 v2 权威库：candidate=… delivery=… analysis=… 题目=… 道**」；写不进去直接报错中止、**不发卡**（防假绿灯） |

⇒ **照 §六 原判据去查 `biz_G5_resume_analysis` 新增行，物理上永远不会出现**（不是缺陷，是判据过时）。第 4 步应改为 `biz_g5v2_resume_analysis` 新增行 ＋ `biz_g5v2_candidate` 新建/复用 ＋ `biz_g5v2_delivery` ＋ `biz_g5v2_question_bank`。这条要 append 回 #771/#1894，否则下次照抄仍判不出。

### 3.2 生产库还是测试库？—— 生产库 `ecommerce_db`，无旁路

`AIAD/G5-人事管理/v2/service/v2_intake.py:50-57`、`v2_app.py:145-162`（实测阅读）：

```python
dbname = os.environ.get("G5V2_DB_NAME") or "ecommerce_db"   # 生产实例不配 → 默认生产库
```

- 简历链的真实执行体是生产常驻服务 `http://127.0.0.1:8703`（`AIAD/G5-人事管理/INTERFACE.md:19`：「G5 v2 服务（简历分析等重活的后端执行体）」；:26/:27 各工具薄壳一律 `POST 127.0.0.1:8703`，且「挂载于 hr bot」）。**hr bot 走的这条链不经过 `G5V2_DB_NAME` 覆盖**，落生产库。
- 另有 `db()` 生产库直连闸（`v2_app.py:149-159`，中台 #351）：只放行「ExecStart 直跑 v2_app.py」或显式 `G5V2_DB_ALLOW_PROD=1`，**裸 CLI/临时脚本 import 即拒**。⇒ 这条闸防的是脚本误操作，**拦不住真走服务链产生的业务写入**——不能拿它当「验收不会污染生产」的依据。

### 3.3 有没有测试数据隔离机制？—— 没有行级标记，只有「另一套库＋另一实例」，而本链用不上

- **表结构无 `is_test`/测试来源标记**：`AIAD/G5-人事管理/v2/db/schema_v1.sql:9-30`（`biz_g5v2_candidate` 全列实测，只有 `source_channel`（默认 'boss直聘'）、`hrm_record_id`、`progress_status` 等，无任何测试位）；`:33-45`（`biz_g5v2_delivery` 有 `delivered_by_open_id`，记录投递人，但不是测试标记）；`:48-70`（`biz_g5v2_resume_analysis` 无测试位）。
- **既有隔离机制＝验证库**：`AIAD/G5-人事管理/AGENTS.md` 上线门禁节 + `验收测试资料包.md:9`（2026-10-09 起）——验证库 `ecommerce_verify` ＋ 验证实例 `g5v2-web-verify`(:8704，`G5V2_DB_NAME=ecommerce_verify` ＋ `G5V2_DRYRUN=1` 发卡干跑不出网) ＋ 造数 `v2/tasks/seed_verify.py --reset`（**固定 id 段 9000-9099，物理隔离，幂等**）。**但这套只覆盖 Web/gate 侧**；hr bot 的简历分析链打的是 :8703 生产服务，落生产库，**干跑开关不在这条腿上**。
- **现成清理脚本硬拒生产库**：`AIAD/G5-人事管理/v2/test/cleanup_v2intake_test_rows.py:40-52` `_guard_target()`——「目标主机必须显式指定为本机」「目标数据库必须显式指定为 `*_verify` 测试库」「`ecommerce_db` → 拒绝」。⇒ **一旦在生产库写入测试候选人，项目自带的清理通道是被关死的**，善后只能走生产变更审批（手工 DELETE ＋ 备份），或按 `AGENTS.md` 的「演示数据常驻、谁验谁 reset」口径挂着。
- **既有先例（可作参照，不是可滥用的理由）**：同一条 chat 的历史里，CM 本人 2026-10-22 18:25 就在**生产**用「测试账号」跑过一次约面（`✅ 约面成功 - 候选人：测试账号 …已创建日历并发通知到面试群`），17:38 那次失败卡还把 `db来源` 的取数来源（`ro_user=/G5_DB_RO_USER`、`database=/G5_DB_NAME`，非密钥值）打在了员工可见卡面上。⇒ 生产里存在合成候选人（「测试账号」）是**有先例、CM 自己动过手**的形态；但这不代表 agent 可以自行判定「生产写测试数据＝自由区」。

### 3.4 写进去会不会进 HR 业务口径？—— 会，至少三个下游

| 下游 | 出处 | 影响 |
|---|---|---|
| 候选人列表卡 | `AIAD/G5-人事管理/v2/service/candidates_card.py`（同套 v2 service，读 `biz_g5v2_candidate`）；`V2开发-阶段一-完工演示流程单-20261005.md:17` 的验收判据原文就是「`biz_g5v2_resume_analysis` 新行…**候选人列表卡里能看到这个人**」 | 测试行直接出现在 CM/HR 看的列表里 |
| 约面流程 | `AIAD/G5-人事管理/02-约面流程自动化/scripts/约面流程/schedule_interview.py:354-356`（`LEFT JOIN biz_g5v2_resume_analysis`）、`:95/:203`（`CANDIDATE_TABLE`，`find_candidate_by_id` 兜底旧表） | 测试候选人可被「报号约面」命中（台账 :544 记过 CM 报「76」命中旧表的实况） |
| 登记页/谈薪/入职等 | `v2/service/register_page.py`、`salary_gateway.py`、`onboard_page.py`（同目录读同表族）；`AIAD/G5-人事管理/验收测试资料包.md:22-26` 就是拿在库候选人 id 做演示入口 | 测试行进入后续流程的可选集 |
| 投影/对账 | `AIAD/G5-人事管理/AGENTS.md` 2026-10-06 裁决：飞书 Base `JA8VbLwEca4695sXHiTcGMrqnwc` **只读归档、任何脚本不许再写** | 不会二次扩散到多维表格（好消息），但 MySQL 内是活数据 |

**风险定级**：**这是生产业务数据写入，不是自由区操作**，必须列为「需 CM 批准」项。缓释建议（供 CM 选）：① 姓名一律用「测试账号」类合成标识（有 10-22 先例）、不引入真实个人信息；② 岗位挑一个非当期招聘热点岗位；③ 事先约定善后方式（谁删、要不要备份行、还是按「演示数据常驻」留着）；④ 五步链本身依赖 #720（GLM 引擎 key 生产通道）与 #557（模型可见性）先闭环，否则第 3 步的 401/无工具会伪装成「工具没修好」。

---

## 四、问 4：有没有 L1/L2 员工身份通道？—— 没有，且 bot 身份不构成有效验证

### 4.1 本机可用身份的实测清单（不含任何密钥值）

```
lark-cli profile list      → 2 个 profile：cli_aae14aaa15b89cb6（active，user="C M"）、openclaw
lark-cli auth status       → user 身份 available=true，openId=ou_e3abe82b…（CM 本人），tokenStatus=needs_refresh（会自动续）
lark-cli auth status --profile hr         → {"ok":false,"error":{"subtype":"not_configured","message":"profile \"hr\" not found",
                                             "hint":"… pass one of: cli_aae14aaa15b89cb6, openclaw"}}
lark-cli auth status --profile openclaw   → appId cli_a978077613391bcb：bot ready，**user missing（no user logged in）**
```

（任务里说的 `~/AppData/Roaming/lark-cli/` 实测不存在：`ls: cannot access '/c/Users/CMFOK/AppData/Roaming/lark-cli/'`——lark-cli 的配置不在那个路径；能信的是 `profile list` 的枚举结果。`bot.json`/`hermes/` 两个名字在 profile 清单里没有对应项。）

⇒ 本机只有 **一个 user 身份＝CM（L5 最高档）**；`hr` profile 不存在（不能以 hr 应用身份发）；`openclaw`（SuperOC，`cli_a978077613391bcb`）只有 bot 身份、且它是**另一个应用**、不在那条 hr 单聊里。

### 4.2 为什么「以 bot 身份发消息」不构成 L1/L2 路径的有效验证（三条独立理由）

1. **档位是从「入站事件的 open_id」算出来的，不是从发消息的客户端算的**。桥侧身份注入只认服务端给的发送者：`dsh-feishucard/index.js:6153-6155`「身份只来自 `evt.sender.sender_id.open_id`（服务端给的、伪造不了）；拿不到身份 ⇒ 拒绝（**无表就拒**）」；档位读取 `index.js:1482-1492 actorVisibleTier()`——`is_cm` 视作 5，否则从 `actor.grants`（「类别→档位」向量）取最高档比对 L3。
2. **bot 发送解析不到「人」，只会命中 fail-closed 的拒支，验不到 L1/L2 的放行面**：`index.js:8092-8095`「认不出是谁 ⇒ 拒（fail-closed，与 identityGuard 同口径）…我认不出你的身份（事件里没有可用的 open_id），因此不能放行」。身份表是**按人**登记的：`output/g9-identity/identity_map.json`（本机镜像，updated 2026-10-17T23:17:11）共 70 人、其中 40 人在 hr 应用 `cli_a97b99468779dbb4` 下有 open_id，`is_cm` 只有 1 人，status 取值含 在职/离职/待入职/终止办理。G9 判定入口同样按 open_id：`AIAD/G9-Agent基座/engine/g9_engine_v2.py:266 def decide(open_id, table, fields, data, probe=None)`。⇒ 用 bot 身份发进去，测到的是「无身份被拒」，与「员工档位下工具面/降级文案长什么样」完全不是一回事。
3. **档位不可得时，桥连表现都会退化**：`identityGuard` 生产默认关（限制性闸门维持默认关，H-D451 口径；`VERIFICATION-2026-10-23-2216-系统级报错档位降级.md:92` 原话「生产 bot 配置 identityGuard 默认关…此时**所有用户（含 CM）看到系统级失败都是统一话术**（fail-closed）…若 CM 希望本人直看原因，需给相应 bot 开 identityGuard 并保证 CM 在身份表」；本机 `C:\Users\CMFOK\.dsh-feishucard\feishu.config.json` 实测三个 bot 均未写该键＝默认关）。⇒ 即使有 bot 通道，也测不出「普通员工档位」的差异。

**员工侧通道本身是存在的、只是不在我手里**：40 名员工在 hr 应用下有 open_id（= 有过交互），历史消息里 10-19/10-20 的真实简历分析卡、约面催办卡也证明员工在用自己的账号跟它说话。**要验 L1/L2，必须由一名在职员工在自己的飞书单聊里亲手发那份 PDF**，agent 无法代为产生该身份（lark-cli 的 user 授权只能本人交互式 OAuth）。这一子项＝ **(C)**。

---

## 五、所以这张单怎么走：执行前缺的东西，与需要 CM 批的具体条目

### 5.1 需要 CM 批准（放行）的，就三条，都是「批不批」而不是「做不做」

1. **允许我以 CM 本人身份在那条 hr 单聊（`oc_1eda77a6563043f231681291452ffff4`）发消息**。代价：这条会话的回复卡面会由生产桥发出、CM 的飞书会出现真实往返；若中途触达面试群等对外面，也是真实消息。
2. **允许往生产业务库 `ecommerce_db` 写入一条合成候选人链**（`biz_g5v2_candidate / biz_g5v2_delivery / biz_g5v2_resume_analysis / biz_g5v2_question_bank`）。请一并批「善后口径」：用「测试账号」类合成名 ＋ 事后手工 DELETE（备份整行→删，须另走生产审批单，因 `cleanup_v2intake_test_rows.py` 硬拒生产库）／或按「演示数据常驻、谁验谁 reset」留着不删——两个都行，选一个。
3. **允许（或不允许）为拿 resume 样本而重启一次生产桥 `dsh-feishu-aiad`**（断全部 bot 30-60 秒，走 G11 审批单）。若不批，则 resume 腿只能等下一次本来计划内的发布重启顺带取样，第 2 步验收（「老聊天不 /new 实测 resume 腿」）不能单独判定。

以上三条批下来后，**执行主体是我**：我发消息、我上传、我查库、我出对照表；CM 不碰键盘（红线 A41）。

### 5.2 与验收判据本身的偏差（需 append 回 #771/#1894，属事实更正不是新裁决）

- 第 4 步表名：`biz_G5_resume_analysis` → **`biz_g5v2_resume_analysis`**（§3.1 三处证据）。
- 第 2 步「resume 腿」：**必须绑定一次进程重启**才成立（§2.3 `index.js:3999-4001`），否则同一条消息走「复用活会话」，验不到目标腿——原判据「老聊天直接发消息（不 /new）」写少了这个前提，照做会拿到假绿灯。
- 员工档位那一腿**判据不变但执行方变**：只能由真实员工动手（§四）。若 CM 认为这一腿可由「HR 侧安排员工」完成，那这张单该拆成两张：B 类（CM 放行、agent 执行）＋ 员工档单子（转派 G5 域/HR，不属本池能力）。
- 第 3 步的两个外部前置：#720（GLM 引擎 key 生产通道）、#557（挂载成功但工具下发可见性）—— 本核查未验证其闭环状态（只读单子里既有口径），执行前须先看这两张单，否则报错会伪装成「修复没生效」。

### 5.3 本次花费与调用计数（额度诚实申报）

lark-cli API 只读调用共 **8 次**：`+chat-list --types p2p --page-all` 2 次（第 1 次只为看形态，第 2 次落盘）、`+chat-members-list` 4 次（3 次排除＋1 次命中）、`+chat-messages-list` 2 次（第 1 次 jq 路径写错返回空、第 2 次取 `.data.messages` 成功）。零写调用、零文件上传、零发消息。`auth status`／`profile list`／`--help`／`skills read` 均为本地操作不计额度。

---

## 附：只读命令索引（可逐条独立复跑）

| # | 命令形态（本地/只读） | 拿到什么 |
|---|---|---|
| 1 | `powershell -File scripts\verify-machine-identity.ps1` | exit 0、machine=HOME、宿主 DEGRADED（如实带出） |
| 2 | `curl -s http://127.0.0.1:3080/feishu/admin/status` | 本机桥只有 work/FU/BA 三 bot，**无 hr**（§〇） |
| 3 | `lark-cli auth status` | user 身份 available=true、CM 本人、scope 三条关键项 |
| 4 | `lark-cli profile list`；`lark-cli auth status --profile hr`；`--profile openclaw` | 只有 2 个 profile；hr 不存在；openclaw 无 user 身份（§四.1） |
| 5 | `lark-cli im +chat-list --types p2p --as user --page-all --jq '[.data.chats[]?|{chat_id,name}]'` | 124 个单聊清单（落 `tmp/p2p-chats.json`） |
| 6 | `lark-cli im +chat-members-list --chat-id <id> --member-types bot --as user --jq '[.data.bots[]?|{app_id,name}]'` | app_id 反查；命中 `cli_a97b99468779dbb4` = `oc_1eda77…`（§一.2） |
| 7 | `lark-cli im +chat-messages-list --chat-id oc_1eda77… --as user --order desc --page-size 20 --no-reactions` | `/new` 与老会话 `fs-main-mvf9bfcd` 的接管痕迹（§二.2）；落 `tmp/hr-msgs.json` |
| 8 | 本地读：`dsh-feishucard/index.js`（:12/:654-658/:3999-4001/:4105-4137/:4162-4231/:4304-4336/:1482-1492/:6153-6160/:8092-8095）、`AIAD/G8-基础设施/shared/feishu_bots.json`、`AIAD/G5-人事管理/{v2/tasks/analyze_resume_final.py,v2/service/{v2_app,v2_intake}.py,v2/db/schema_v1.sql,v2/test/cleanup_v2intake_test_rows.py,INTERFACE.md,AGENTS.md,验收测试资料包.md}`、`output/g9-identity/identity_map.json`、`AIAD/G9-Agent基座/engine/g9_engine_v2.py` | 会话指针存储／三腿解析／v1 表退役／生产库落点／无测试标记／清理脚本拒生产／身份判定口径 |

**未找到项（已尝试，如实登记）**：
- 生产 hr 会话指针文件 `/srv/aiad/.dsh-feishucard/state-clia97b99468779dbb4.json` 实照：本机无通道可达（本轮未试 ssh，按任务约束禁止），既有实测拒因登记见 `output/g9-tickets/342/报告.md` §三.2（`ops_read.sh ls/cat/tail` → `Permission denied`）。
- 生产 hr bot 的 `identityGuard` 实配值：读不到（`/srv/aiad/.dsh/profiles/feishu/feishu.config.json` 不在只读白名单面内）。只能引用成文口径（H-D451 ＋ `VERIFICATION-2026-10-23-2216…:92`「默认关」）。
- `lark-cli` 在 `%APPDATA%/lark-cli/` 下的 `bot.json`、`hermes/`：`ls` 实测该目录不存在（`No such file or directory`）；本机 profile 枚举以 `lark-cli profile list` 为准，已列全（2 个）。
