# 342 五步真机验收（AC-0200 选项 B）现场记录 — 2026-10-23 05:17–05:21

会话身份：HOME#Qoder-sess_684a508d｜验收对象：生产桥 dsh-feishu-aiad（0.8.24，装载行 v0.8.24 md5=ed170eb2 bytes=782128）
目标会话：CM↔hr bot「觅人小友@鸿津」chat_id `oc_1eda77a6563043f231681291452ffff4`（app_id cli_a97b99468779dbb4）
前置：0.8.24 生产部署 serial 202610230013 DONE rc=0（05:11:55），服务 ActiveEnter 05:11:47 唯一一次重启，05:11:52→05:17:50 该会话零入站（resume 腿未被消费）。

## 一、已跑绿的判据（原文取自生产日志，未采信脚本自述）

判据 1＋2「老聊天直接发消息（不 /new）实测 resume 腿，接管会话工具面齐全」——**绿**：

- 05:17:55 `im.message.receive_v1`（我以 CM 身份发「列出你当前可用工具名」，消息 id om_x100b6293968780a4c0833030dd9935d 卡面回执）
- 05:17:55 `[fs] standard agent preset mounted: hr (bot=hr, agentPreset=hr) session=fs-main-mvjeb1yw` ← #771 主判据（preset 挂载留痕）
- 05:17:55 `[fs] #350 session model binding check (resume): fs-main-mvjeb1yw → zai-coding-cn/glm-5.3-flash（本会话上一条在用）` ← **确属 resume 腿**（沿用既有会话句柄，不是新建会话）
- 05:17:55 `[fs] identity-local absent path=/srv/aiad/.dsh-feishucard/identity_map.local.json code=ENOENT impact=本机无增量表 ⇒ 仅按主表解析（设计内状态）` ← #1866 第 4 项三态留痕在生产真实触发（此前只有本地自测）
- 05:17:55 `identity: agent=fs-main-mvjeb1yw open_id=ou_3eb13a90e… -> OK 廖泽辉 source=identity_map@v1.1 tableOk=true`
- 05:18:11 `turn sealed: status=sealed silent=false failure=none reply_len=833` 且回复正文起头为「当前可用工具共 35 个：**招聘/人事类** 1. schedule_interview 2. **analyze_resume — 简历AI评分** 3. evaluation_chat …」
  ← #557／#156「模型可见层」判据（工具确实下发给模型且被模型自述可见），**green**
- 同窗口 `preset mount failed` 计数 0、无 `#771 preset tools (still) missing` 行

判据 3「员工真实发一份简历 → 工具调用 → :8703 收文件 → v2 表新增行 → 评分卡送达」——**部分完成、结束时仍在跑**：

- 05:19:28 我发送合成简历 PDF（`synthetic-resume-HECHENG-TEST-001.pdf`，958 B，内容逐行标注 SYNTHETIC／DO NOT CONTACT／示例号码 13800000000／邮箱 example.invalid）
- 05:19:29 `[fs] inbound file saved: /srv/aiad/agents/hr/downloaded_files/2026-10-23-051929_synthetic-resume-HECHENG-TEST-001.pdf (958 bytes)` ← 文件接收腿 **绿**
- 05:19:34 `turn sealed ... reply="✅ 已收到简历文件 …，等你指示再处理。" failure=none`
- 05:19:46 我发「分析刚才这份简历并评分」
- 05:19:55 `buildCardPayload: card=d56adee1 status=running cursor=54 blocks=2 notes=0 tools=1` ← **卡片出现「工具调用 (1)」**，工具被真实调用，判据 3 的工具腿开始
- 05:20:00→05:21:27 多次只读取日志：本轮仍未 `turn sealed`（analyze_resume 走引擎耗时）
- 05:21:27 只读查库 `SELECT id,name,created_at FROM ecommerce_db.biz_g5v2_candidate ORDER BY id DESC LIMIT 5`：最新仍为 369「测试员工」2026-10-22 18:57:13 ⇒ **合成候选人此刻尚未落库**

## 二、本文件结束时（05:21）的真实状态，以及必须跟完的尾巴

1. 判据 1／2／3 的文件接收与工具调用腿已有生产原文实锤；判据 3 的「落库＋评分卡」两条**未取得**，因为该轮在记录时刻仍在运行。
2. **尾巴（不得丢）**：若该轮最终落库，会在 `biz_g5v2_candidate` 及其关联 v2 表写入这份合成简历的候选人行（无 is_test 标记，会进 HR 列表卡、可被约面报号命中）。AC-0200 选项 B 的代价就是这条，收尾必须走一张删除审批单（run-script，按 approval-form 发单前三查＋本地五段体检闸），删除条件按候选人 name 唯一串 `HECHENG-TEST-001`／落库后的实际 id 逐号删除，执行后复验清零。
3. 下一轮固定动作：
   - 取 `--since 05:19:46` 段日志看本轮是否 sealed、工具名与结果；
   - 查 `biz_g5v2_candidate`（列名实况：id／name／created_at，**无 phone／source 列**）＋ `biz_g5v2_resume_analysis`／`biz_g5v2_delivery`／`biz_g5v2_question_bank` 是否新增 HECHENG-TEST-001；
   - 查到了 → 出删除单并跟到终态；没查到（引擎超时/失败）→ 归因按报错分层（不得把引擎失败读成「工具没修好」，#720 同款教训），判据 3 另择窗口重跑；
   - 判据 3 两条补齐后才 close #2252／#771／#1894，--landed 指本文件。
4. 附件落盘位置：生产 `/srv/aiad/agents/hr/downloaded_files/2026-10-23-051929_synthetic-resume-HECHENG-TEST-001.pdf`（合成件，删除单一并登记处置）。


## 三、05:22:29 该轮跑绿（追加，判据③补齐）

- 05:22:22 `buildCardPayload ... tools=1`（工具调用持续可见）→ **05:22:29 `turn sealed: status=sealed silent=false failure=none reply_len=33`**，回复正文「✅ 分析完成，评分卡已发送给你（约1-3分钟内送达，请留意飞书）。」
- 同刻 `conclusion split: agent=fs-main-mvjeb1yw elapsed=161525ms threshold=30000ms tools=1`（161 秒长回合走结论分卡路径，非失败）
- 05:22:29–05:22:30 `card created msg=om_x100b6293a7ace0a4dea82efdd34132d` ＋ `conclusion card opened` ＋ `card reply delivered to oc_1eda77a…` ⇒ **评分卡送达 CM 飞书会话**这一条有原文实锤
- 05:23 只读查库 `biz_g5v2_candidate`：**id=370，name＝HECHENG-TEST-001（测试文件标注名，非真实姓名），created_at＝2026-10-23 05:22:21**；`biz_g5v2_resume_analysis`：**id=87，candidate_id=370，created_at 同刻**
⇒ 五步判据（①工具面齐全 ②resume 腿沿用原会话句柄 ③简历文件被收件 ④analyze_resume 真实调用并落库 ⑤评分卡送达）**全部为真**，#771／#1894／#2252 的验收前置达成。

## 四、合成数据清理单（本单的尾巴，已按纪律出单）

- 单号 **G11#2216-synthcleanup-20261023**，审批实例 `66509A4F-6CB9-4B09-B2FC-8F76DA03B06D`（serial 202610230015）
- 载荷 `b0825-cleanup-synth-20261023.sh`（sha256 `ca457d9fbbc9c77193471e108fdf4b83703a3158bc4e91e3c71911fa94ee51b2`，bash -n 过、LF 零 CR）＋ `b0825-cleanup-MANIFEST.sha256` 已投投递口；staging 门禁真跑结论行 `GATE_CLEANUP_R1_OK`，凭证 `verify-receipt.json`（verified_on=staging）
- 脚本六道防线：先回读 370 姓名、不含 HECHENG-TEST-001 即 fail-closed 拒绝；370 不存在即幂等退出；四表逐表 SELECT 导出 TSV 到 `/opt/.trash_prod-20261023` 后再按号 DELETE；逐表复验残留计数必须为 0；合成 PDF **移动**而非 rm 到同目录；OPS_CHANGELOG 留痕带单号
- 申请件 `out/deploy-request.json` **尚未投递**（等审批）：05:25／05:26 两次回查实例＝PENDING，按纪律记录在案；批准后再投（一投一回查，不重投）


## 五、清理链 r1→r4 全记录（含一次「rc=0 但零删除」的假成功，实测钉死）

| 单号 | 网关回显 | 实测真值 | 根因 |
|---|---|---|---|
| G11#2216-synthcleanup-20261023（serial …0015） | FAILED rc=44，内层 FATAL rc=20 | 库零改动（只读复查 370 号在位） | 脚本用 `sudo /usr/bin/mysql` 直连、无凭证 |
| …-r2-…（serial …0017，实例 6D80B7CF 之外的 AEBC0892） | **DONE rc=0** | **库零删除**，仅 PDF 移档成功；并往 OPS_CHANGELOG 写了「复验残留=0」 | 表存在性写成 `SHOW TABLES LIKE 'x' FROM db`（MySQL 不认，实测 1064），报错返回空值被脚本当成「表不存在」⇒ 逐表跳过备份与删除 |
| …-r3-…（实例 9AAA3F72，已批不用） | 未投递 | — | 出单前落点核对闸拦下：载荷含 `/srv` 落点变量而卡面未声明 |
| …-r4-…（serial …0018，实例 6D80B7CF） | DONE rc=0 | **真删除**：四表逐表 COUNT 1/1/1/13 → 备份 TSV → DELETE → VERIFY 全为 0（日志 /opt/.trash_prod-20261023/synthcleanup-r4-20261023055800.log） | 存在性/计数改走 information_schema 与显式 SELECT；取数非纯数字即 fail-closed |

教训两条（已回写成全局闸，不再只靠自觉）：
1. **「网关回显 DONE rc=0」不等于「动作发生」**——内层脚本把 SQL 报错当成「查无此表」就能零删除还打成功结论。
   复验必须拿到**数字**（不能是空值），且要独立只读复查目标行确实消失。
2. `scripts/check-deploy-readiness.py` 新增**四要素⑥**（`check_sql_failclosed`）：⑥a 拦 `SHOW TABLES LIKE … FROM` 这种不被 MySQL 支持的语序；
   ⑥b 拦「`VAR=$(…mysql…)` 取数既无 `|| fail`、其后也无空值/非数字判定」。
   变异反证：致祸件 r2 必红、现行件 r4 必绿，`--self-test` 全绿（SELF-TEST-OK）。
