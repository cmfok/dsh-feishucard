---
title: "helper.cjs 内存盘点与瘦身评估（中台 #333，只读盘点·未动生产）"
date: 2026-10-14
tags: [dsh-feishucard, 内存, helper, 评估]
status: active
---

# helper.cjs 内存盘点与瘦身评估（中台 #333）

> 工单：#333「helper.cjs 每实例 ~83MB × 5 实例 ≈ 400MB，值得评估瘦身」。
> 性质：**只读盘点**（工单明令：给出安全压测方式后再动，禁止直接改生产）。
> 盘点人：HOME#ZCode-sess_ac1913c9，2026-10-14。

## 一、2026-10-14 实测内存账（生产 106.53.168.220）

命令：`ps aux | grep 'profiles/feishu/node'`、`free -m`、`ss -tln`（ssh my-server 只读白名单）。

| 进程 | 属主 | RSS | 说明 |
|---|---|---|---|
| dsh-feishu（3099）主进程 | ubuntu | ~140MB 量级（10-09 实测 140.7MB） | CM 个人 bot「cm」（cli_aa41…）专用 profile |
| └ helper.cjs ×1 | ubuntu | 69.8MB | 同上 bot 的长连接 |
| dsh-feishu-aiad（3200）主进程 | aiad | 432.7MB（peak 500.3MB，systemd status 实测） | 5 bot 共用一实例 |
| └ helper.cjs ×5 | aiad | 68.2~70.0MB ×5 ≈ 342MB | 每 bot 一长连接（0.8.6 后加了第 5 个 bot） |

- helper 合计：**6 实例 ≈ 412MB**（工单当时的 5 实例 ≈ 400MB，现 aiad 侧多 1 bot 变 6 个）。
- 整机：内存 3723MB（used 1574MB / available 2148MB），**swap 已用 1486MB / 3011MB** —— 换出压力真实存在，但 available 尚有 2.1G，非紧急。
- 3099 的「cm」bot 最近日志在正常收发卡片（journalctl -u dsh-feishu 实测）⇒ **6 个 helper 全部有存在理由，没有一个可白砍**。

## 二、83MB 的构成（为什么一个小文件吃这么多）

`helper.cjs` 全文 **129 行**（wc -l 实测），职责只有两件：①保住飞书官方 SDK 的 WebSocket 长连接；②把事件一行一个 JSON 从 stdout 转发给宿主。**内存大头不在代码，在运行时**：

1. Node 22 运行时基线（V8 堆初始 reserve、字节码、元空间）≈ 30-40MB；
2. `@larksuiteoapi/node-sdk` 依赖树全量加载（WebSocket 客户端、HTTP、序列化）≈ 20-30MB；
3. 运行期实际堆用量很小（事件转发流量低，0:03 CPU / 运行 23h）。

⇒ 每个 helper 的 RSS ≈ 运行时＋SDK 的**固定成本**，与 bot 消息量基本无关。

## 三、瘦身选项评估

### 选项 1：`--max-old-space-size` 压堆上限 —— 不推荐
- 压的是 V8 old space 上限，而 RSS 大头（运行时基线＋SDK 静态加载）不受它管；
- 实际堆占用本来就低（CPU 0:03/23h），压了预估省 <20MB/实例，还要动 systemd 单元（生产变更）；
- 结论：**性价比低，不做**。

### 选项 2：多 bot 共享一个 helper（1 进程 × N 条 WS）—— 中期方案，先压测再立项
- 原理：把「1 bot = 1 helper 进程」改成「1 实例 = 1 helper 进程内起 N 条 SDK 长连接」，固定成本（运行时＋SDK）只付一次；
- 理论收益：aiad 侧 5 helper → 1，省约 **4 × 60MB ≈ 240MB**（整机 RSS 的 ~6.5%，swap 压力缓解）；
- 代价/风险：
  - helper.cjs 协议要升级（事件需带 bot 维度路由回宿主，宿主 index.js 的 spawn/对账/重启逻辑全要适配）；
  - 单点化：helper 崩 = 5 bot 同时断连（现有自愈是 spawn 冷却 5s，影响面变大）；
  - 官方 SDK 对「同进程多 client 实例」无官方支持声明，属于我们自己扛的用法。
- 结论：**值得做但不急**，先按 §四压测拿数据再立项报 CM。

### 选项 3：3099「cm」bot 并入 aiad 实例 —— 另立议题，不掺和
- 可省一个 DSH 主进程（~88-140MB），bot 挪过去 helper 净 +1（+70MB），净省约 20-70MB；
- 但 cm bot 是 CM 个人专用 profile，独立 workspace/权限面，合并属架构变更且收益不确定；
- 结论：**不在本单范围**，如要做另立工单。

### 选项 4：什么都不做 —— 短期默认
- helper 是第二大头但 available 2.1G 尚宽裕；工单本身定位「观察项不是紧急项」；
- 保持每日常巡检对 6 helper RSS 与 swap 的观测即可。

## 四、安全压测方式（动生产前的必经步骤，照此顺序）

1. **staging 先行**（staging 自由区，`dsh-feishu-staging` 已在跑）：把选项 2 的多连接 helper 部署到 staging，用 ≥5 个测试 bot 桩跑：
   - 消息洪峰脚本：并发 50 条/分钟 × 10 分钟，观察 helper RSS 曲线（`ps` 每 10s 采样）与事件零丢失（序号对账）；
   - 断连恢复：kill helper 进程，验证宿主 5s 冷却后全部 bot 重连 ready；
   - 长跑：≥24h 无内存爬升（对比每小時 RSS 采样）。
2. **生产灰度**（走 G11 审批单，gatekeeper 剧本）：aiad 侧先并 2 个低频 bot 进共享 helper 跑 72h 观察，再全量。
3. **回滚预案**：systemd 单元与 helper.cjs 改前备份（`.bak-<日期>` 惯例），回滚＝换回旧文件＋重启（1 分钟内，见转交书 §五同款）。

## 五、结论

- 短期（本单闭环）：**不动**。6 helper 全部在岗、内存尚有 2.1G available；把本档作为观察基线，巡检盯 swap。
- 中期：选项 2（共享 helper）是唯一有实质收益（~240MB）的路，先按 §四在 staging 压测，数据齐了再报 CM 立项。
- 明确不做：选项 1（压堆上限，性价比低）。
