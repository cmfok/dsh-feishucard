# DIAGNOSIS 2026-10-19：/model 桥直存默认模型撞 HMR 嵌套事务

> 现象（CM 10-19 14:35 飞书报障，回执原文）：切 `zai-coding-cn/glm-5.3-flash`，
> 「下一条请求会用 …但默认值未写入（桥直存报错：HMR transactions cannot be nested）⇒ 重连/恢复后可能跳回旧默认」。

## 链路（代码已钉死）

1. `/model` 切换 → `switchModelForAgent`（index.js:9526）→ 宿主 `sessionController.selectModel`
2. #124 落地校验 `verifyDefaultModelLanded`（index.js:9570）：回读 3 拍没等到 → **桥直存** `dm.saveSelection`（index.js:9587-9594，4 秒上界）
3. 直存抛错被 catch（index.js:9589-9591）→ `persistDetail='桥直存报错：HMR transactions cannot be nested'`
4. 回执走 `confirmed && !persisted` 分支（index.js:9628-9635）＝ CM 收到的那段话

## 报错来源与根因

- 「HMR transactions cannot be nested」＝ DSH 宿主 HMR（插件热重载）的**嵌套事务保护**：
  一次热重载事务未完成时又发起第二个，宿主拒绝。
- 桥源码在 HMR 监听范围内（2026-10-02 CM 拍板配的热重载，台账 §HMR），**保存 index.js 即触发重载事务**；
  `saveSelection` 写 profile 又会触发配置热更事务。两个事务在时间窗内撞车 ⇒ 嵌套 ⇒ 直存被拒 ⇒ 默认值没写进去。
- **钉不死的部分（如实记）**：宿主侧报错栈没进 web.log（logger sink 不同，先例见台账 947 行），
  精确触发时序（是插件重载撞配置热更，还是反向）缺宿主日志佐证；报错 message 本身与桥侧代码路径已钉死。

## 结构性根因（为什么「反反复复」）

同一条「默认模型」链路三进宫：
| 日期 | 单号 | 形态 |
|---|---|---|
| 10-07 | 中台 #124 | 切换假成功（宿主②半静默不执行）|
| 10-13 | 中台 #560 [high] | /new 新会话默认模型注入不稳定（**仍 open**）|
| 10-19 | 本单 | 桥直存撞 HMR 嵌套事务 |

共性：①桥是 12366 行单文件，所有功能共处一体，改谁都可能碰共享面；②常驻进程 + HMR 热重载，任何更新都在活体上动刀；
③修好的路径（#124 的回读→直存→再回读闭环）**没有固化成自动回归用例**——全量冒烟（#560 口径：802 卡/872 秒）没盖住这条，时序竞态冒烟也难复现。

## 方案（待 CM 拍板，A37 方案对比）

1. **对症补丁**：`verifyDefaultModelLanded` 直存 catch 里识别该报错，退避 1.5s 重试一次（仍在 4 秒上界内适度放宽至 ~6 秒），HMR 事务是瞬时的，重试大概率落地。代价：改动小；局限：只治这一种撞法。
2. **回归闸（推荐同步上）**：把「/model 切换→默认值落地」连同 #124 断言固化进 selftest（既有 selftest-*.mjs 模式），并列入改动后必跑清单；挂每日巡检 ⑥ 检查 selftest 是否随版本更新。代价：要先盘点已修好路径清单。
3. **拆文件（中长期）**：index.js 按功能域拆模块，物理隔离改动面。代价：大动干戈，需专门批次。

## 关联

- 中台池 `dsh-feishucard`：#124（已闭环先例）、#560（open，同链路）
- 台账：`Ai100/obsidian/系统/项目/DSH接入飞书/飞书端问题台账-20261001.md` §HMR

## 处置结果（2026-10-19 15:0x，本会话顺手修，方案 1＋2 落地）

- **方案 1（对症补丁）已落地**：直存抽成 `saveOnce`，对 `/transactions cannot be nested/i` 报错退避
  1.5s（新常量 `DM_HMR_RETRY_BACKOFF_MS`）重试一次；其余报错照旧如实带回。版本 0.8.21，CHANGELOG 已记。
- **方案 2（回归闸）已落地**：新增 `selftest-model-land-20261019.mjs`（从 index.js 原文抽 DM 区块直测，
  同 selftest-timeout-token 手法）10 断言全绿；变异自测（删重试块重跑）三红 exit 1，闸有效。
- **验证**：node --check 过；纯 CRLF 保持（12377 行零孤立 LF）；桥活体正常（保存后 web.log 持续处理消息）。
  **真机终验＝下次 /model 切换回执 persisted=ok**（HMR 应已自动热载新代码）。
- **方案 3（拆模块）未动**：中长期项，另行立项。
