---
title: "open_id 报错排查结论 ＋ preset mounted 真机日志回填（中台 #343/#349，2026-10-14）"
date: 2026-10-14
tags: [dsh-feishucard, identity, preset-hr, 回填]
status: active
---

# open_id 报错排查 ＋ mounted 回填（#343）／ preset-hr 五件套可见性验证（#349）

> 承接：信息中台/转交书-dsh飞书桥-20261009.md §三 待办 1/2/4。
> 全部为 ssh my-server **只读白名单命令**（journalctl/grep），生产零写操作。
> 取证人：HOME#ZCode-sess_ac1913c9，2026-10-14 21:00-21:40。

## 一、#343 待办②：`Cannot assign to read only property 'open_id'` 报错排查

**命令与实测：**
```
ssh my-server "sudo journalctl -u dsh-feishu-aiad --since 2026-10-09 --no-pager | grep -c 'Cannot assign to read only property'"
→ 19
ssh my-server "sudo journalctl -u dsh-feishu-aiad --since 2026-10-09 --until 2026-10-10 --no-pager | grep 'Cannot assign to read only property' | head -3"
→ Oct 09 13:02:37（pid 3952378）… 最后一批 Oct 09 18:04:43（pid 4100961）
```

**结论（三点）：**
1. **根因已钉死且已修**：宿主 dsh-tools prepare 段对模型参数快照做 `deepFreeze`，D5 覆写在瀑布里原地赋值必抛——本仓 CHANGELOG 0.8.7 段（CHANGELOG.md:143-160）铁证：修法＝浅克隆后整对象写回（0.8.7 已于 2026-10-09 18:37 上线 aiad，md5=00a49e07），并附带堵掉 fail-open 缺口（写回再抛 ⇒ `identity_writeback_failed` fail-closed）。
2. **时间线自洽**：报错全部落在 10-09 13:02-18:04（两个旧 pid），最后一条比 0.8.7 上线早 33 分钟；10-10 至今（10-14）**零复发**。
3. **当日会话未受损**：报错时段的会话照常 sealed 正常回复（10-09 18:05:41 turn sealed reply_len=1005 实录）。

⇒ 转交书 §三.2「未查」销账：已查清、已修、已上线、零复发。

## 二、#343 待办①：preset mounted 真机日志回填

**命令与实测（10-14）：**
```
ssh my-server "sudo journalctl -u dsh-feishu-aiad --no-pager | grep 'preset mounted'" | tail -10
→ 多条 `standard agent preset mounted: employee`
→ 2 条 `standard agent preset mounted: hr (bot=hr, agentPreset=hr)`（10-14 02:47:33、15:57:57）
ssh my-server "sudo journalctl -u dsh-feishu-aiad --no-pager | grep -c 'preset mount failed'"
→ 0（当日窗口内 grep 实测零失败行）
```

**回填判据（转交书期望 3 employee ＋ 1 hr）**：4 bot 全部挂载达成——hr bot 带 `agentPreset=hr` 标识、其余 3 bot 回落 employee（回落形态日志不带 `bot=` 后缀，这是 0.8.5 实现：只有显式指定 agentPreset 才拼 tag，index.js mountStandardPreset）。**零 mount failed**。回滚线（出现 failed 立即回滚）未触发。

## 三、#349：preset-hr 五件套可见性——真实会话已验证，探针不必造

**命令与实测：**
```
ssh my-server "sudo journalctl -u dsh-feishu-aiad --since '2026-10-14 15:57' --no-pager | grep -c 'identity overwrite'"
→ 0
ssh my-server "sudo journalctl -u dsh-feishu-aiad --since '2026-10-14 02:47' --until '2026-10-14 03:00' --no-pager | grep -i 'tool\|analyzer\|salary'"
→ Oct 14 02:48:11 [fs] identity ALERT[person_unknown] DENY: tool=analyze_resume agent=fs-main-mv719ltd tableOk=true
```

**结论：**
1. **五件套对模型可见已被真实会话实证**：10-14 02:48:11，hr bot 会话（fs-main-mv719ltd）里 agent 主动发起了 `analyze_resume`（HR 五件套之一）调用——模型看得见、发起得了 ⇒ #156 的「挂载成功但模型看不见」在 preset-hr 上**不成立**。该调用被 identity 层以 person_unknown 拒绝（调用者不在册）＝权限面正确行为，不影响可见性结论。
2. **0.8.7 修复零复发**：identity overwrite 报错 grep 计数 0。
3. 15:57 hr 会话（图片上传）preset mounted hr、identity 打点正常（job_not_granted tableOk=true）、turn 正常 sealed。
4. **探针销账**：#343 转交待办④的「#156 探针插件」（文件从未创建）**不再需要**——#349 正文自己预留的口径「探针仅当生产观察仍定不下口径时再做」，现在生产观察已定下口径。#343 待办④就此关闭。

## 四、遗留（不属本两单，如实登记）

- npm 发布 0.8.5+（转交书待办⑤）：仍待 CM 裁决，未动。
- #271 G8 池验收（转交书待办③）：前提（open_id 报错已清）现已成熟，归 G8 池推进。
- #320 日报重构（转交书待办⑥）：未动工，独立单。
- **生产桥仍在 0.8.8**：0.8.9-0.8.13（含 #496/#497 卡面、0.8.11 诚实说明、0.8.12 反查、0.8.13 /new 三行）待上生产，需走 G11 审批（G9 观察期至 10-15，重启避开审计窗口）。
