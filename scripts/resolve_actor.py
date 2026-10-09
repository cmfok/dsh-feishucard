#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""resolve_actor.py —— 内层身份解析（NODE1 规格补丁 v3 §2.4 · D3/D4）

纯函数：不读时钟、不写文件、不调网络（HOME 侧可断网单测）。
fail-closed：任何认不出的情形一律拒绝，绝不拿姓名模糊匹配放行。

用法（被 HOME 的 handleInbound 经 MCP 调用，也可命令行自测）：
    from resolve_actor import resolveActor
    actor, err = resolveActor(open_id, identity_map, job_grants)
    #   err = None 或错误码字符串；job_grants = 岗位授权表 dict（契约 §六 D3：
    #   入参一律是【表对象】，读文件与缓存留在调用侧；缺表/坏表 ⇒ fail-closed 全拒）

错误码（9 种，逐字对接 HOME）：map_unavailable / no_open_id / unknown_person /
duplicate_open_id / open_id_missing / job_not_granted / not_active /
unknown_status / (自助兜底另记 identity.unverified)

────────────────────────────────────────────────────────────────────
2026-10-09 契约 V1.2 实施收口（中台 #158 · 验收＝身份-授权契约-v1 §七 V1-V10）：
  ① 裸名 grants_until ⇒ extra_grants_until（契约 §2.1 键名以 policy_axis.py 为准）
  ② 人级不再存/输出 grants —— 挂岗位后 grants 只从 job_grants.json 按 job_id 现取（契约 §四）
  ③ 兼职/待入职 ⇒ unknown_status 拒（CM 2026-10-05 V1.2 裁决：均不可上岗；原「放行断言」已翻转）
  ④ unknown_status 门禁：status 既非「在职」也不在明确不可上岗清单 ⇒ 拒
     （补 §五第 3 条的 fail-open 洞：新状态/未填不再自动获得权限）
  ⑤ job_id 真查 job_grants["jobs"][].id（原「非空即过」是空判；审批卡号 ≠ 岗位，V3/V4）
  ⑥ 输出补 writable_scopes / item_grants / is_cm（原断供 ⇒ R5 可写/子项例外/CM 特判全失效）
  ⑦ 输出收窄为契约 §二 的 13 字段（channels 移除 —— policy_axis.User 无此字段、全仓无消费方）
────────────────────────────────────────────────────────────────────
"""
import json

# ── 错误码 ──────────────────────────────────────────────────────────────
E_MAP_UNAVAILABLE = "map_unavailable"
E_NO_OPEN_ID      = "no_open_id"
E_UNKNOWN_PERSON  = "unknown_person"
E_DUPLICATE       = "duplicate_open_id"
E_MISSING         = "open_id_missing"
E_NOT_GRANTED     = "job_not_granted"
E_NOT_ACTIVE      = "not_active"      # 离职/终止办理/兼职终止 —— 正常拒绝，≠ 不认识
E_UNKNOWN_STATUS  = "unknown_status"  # 兼职/待入职（V1.2 裁决不可上岗）＋ 清单外新状态/未填

# ── 在职口径（契约 §五，V1.2 定死）────────────────────────────────────
# 「可上岗」只含 在职（X3 枚举口径，CM 2026-10-05 裁决）；
# 离职三态 = not_active（正常拒绝，上层不得对它走「问姓名」兜底 —— 那是给 unknown_person 的）；
# 其余一切（兼职 / 待入职 / 未填 / 未来新状态）= unknown_status 拒并报警 —— fail-closed。
_ACTIVE_STATUS = ("在职",)
_INACTIVE_STATUS = ("离职", "终止办理", "兼职终止")

# 契约 §二：actor 的 13 字段（判定 8 ＋ 标识/追溯 5），多一个少一个都算不合规（V1 机验用）
ACTOR_KEYS = (
    "name", "scopes", "grants", "extra_grants", "extra_grants_until",
    "writable_scopes", "is_cm", "item_grants",
    "open_id", "union_id", "person_id", "job_id", "source",
)

def _load(raw):
    """容错读映射表：dict 直接用；str 当作 JSON 串解析。其余 = map_unavailable"""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise ValueError(E_MAP_UNAVAILABLE)
    raise ValueError(E_MAP_UNAVAILABLE)

def _job_lookup(job_grants):
    """容错取岗位授权表：返回 {岗位id: 岗位对象}。表缺失/形状不对 ⇒ 空 dict（fail-closed 全拒）。"""
    if not isinstance(job_grants, dict):
        return {}
    jobs = job_grants.get("jobs")
    if not isinstance(jobs, list):
        return {}
    out = {}
    for j in jobs:
        if isinstance(j, dict) and str(j.get("id", "") or "").strip():
            out[str(j["id"]).strip()] = j
    return out

def resolveActor(open_id, identity_map, job_grants=None):
    """按契约 §六 D3 返回 (actor, None) 或 (None, 错误码)。

    actor 结构（契约 §二 的 13 字段，判定 8 ＋ 标识/追溯 5）：
      { name, scopes[], grants{}, extra_grants{}, extra_grants_until{},
        writable_scopes[], is_cm, item_grants{},            ← 判定 8（键名与 policy_axis.User 逐字一致）
        open_id, union_id, person_id, job_id, source }      ← 标识/追溯 5
    grants / writable_scopes / item_grants 一律从岗位表按 job_id 现取（§四：挂岗位不挂人）。
    """
    # ① open_id 本身缺失
    if not open_id or not str(open_id).strip():
        return None, E_NO_OPEN_ID

    # ② 映射表可用性
    try:
        m = _load(identity_map)
    except ValueError as e:
        return None, str(e)
    if not isinstance(m, dict) or not isinstance(m.get("people"), list):
        return None, E_MAP_UNAVAILABLE

    # ③ 在 open_ids 缓存里反查 union_id（app 无关：扫所有人的所有 app）
    hits = []
    for person in m["people"]:
        for app, ou in (person.get("open_ids") or {}).items():
            if ou == open_id:
                hits.append(person)
                break
    if len(hits) > 1:
        return None, E_DUPLICATE          # ≥2 人 ⇒ 判表损坏
    if not hits:
        # pending 里显式列出的人 ⇒ open_id_missing（等补），否则彻底未知
        for p in m.get("pending", []):
            if p.get("open_id") == open_id:
                return None, E_MISSING
        return None, E_UNKNOWN_PERSON

    person = hits[0]

    # ④ 在职校验 —— 契约 §五（V1.2 定死，2026-10-09 收口）
    #
    #    离职三态 ⇒ not_active（正常拒绝，≠「不认识」）；
    #    其余一切 ⇒ 必须是「在职」才放行：兼职/待入职（CM V1.2 裁决均不可上岗）
    #    与清单外的新状态/未填一律 unknown_status 拒 —— 原「反向排除其余一律放行」
    #    是 fail-open（HRM 冒出任何新状态 ⇒ 这人自动获得权限），本行把洞钉死（V10）。
    st = str(person.get("status", "") or "").strip()
    if st in _INACTIVE_STATUS:
        return None, E_NOT_ACTIVE
    if st not in _ACTIVE_STATUS:
        return None, E_UNKNOWN_STATUS

    # ⑤ 岗位授权：job_id 必须真查岗位表（契约 §三：非空即过 = 穾判，作废）
    #    · job_id 空 ⇒ job_not_granted
    #    · 查无此岗位（含把审批卡号当 job_id 填的）⇒ job_not_granted（V3/V4）
    #    · job_grants 缺失/坏表 ⇒ 岗位集合为空 ⇒ 全拒（fail-closed，不许因缺表放行）
    jid = str(person.get("job_id", "") or "").strip()
    jobs = _job_lookup(job_grants)
    if not jid or jid not in jobs:
        return None, E_NOT_GRANTED
    job = jobs[jid]

    # ⑥ 组装 actor —— 契约 §二 的 13 字段（2026-10-09 收口）
    #
    #    判定 8 字段与 `policy_axis.User` 键名逐字一致；
    #    grants / writable_scopes / item_grants 从岗位表现取（人级已去 grants，§四）；
    #    item_grants 线上形状＝竖线拼接键（如「财务|净利」），policy_axis/_gate 载入时转元组。
    #    ⚠️ `open_id` 必须回带：它是内核 `IDENTITY_KEYS` 的成员，
    #       不带就会被【删除】而非覆写（2026-10-04 实测过的坑）。
    return ({
        # 判定 8（policy_axis.User）
        "name": person.get("name", ""),
        "scopes": list(person.get("scopes", [])),
        "grants": dict(job.get("grants", {})),
        "extra_grants": dict(person.get("extra_grants", {})),
        "extra_grants_until": dict(person.get("extra_grants_until", {})),
        "writable_scopes": list(job.get("writable_scopes", [])),
        "is_cm": bool(person.get("is_cm", False)),
        "item_grants": dict(job.get("item_grants", {})),
        # 标识/追溯 5
        "open_id": str(open_id),
        "union_id": str(person.get("union_id") or ""),
        "person_id": str(person.get("person_id") or ""),
        "job_id": jid,
        "source": f"identity_map@v{m.get('v', '?')}",
    }), None


# ── 合成身份自测（§2.4：可用合成身份单测，不需要真数据）────────────────
if __name__ == "__main__":
    # 岗位授权夹具（镜像 job_grants.json 形状：jobs 数组、岗位名在 .id、卡号在 .card）
    JG = {
        "v": 1, "jobs": [
            {"id": "电商运营助理", "card": "CR-POST-20261003-01",
             "grants": {"销售": "L2", "财务": "L1"}, "item_grants": {"财务|净利": "L2"},
             "writable_scopes": []},
            {"id": "运营", "card": "CR-POST-20261003-02",
             "grants": {"销售": "L2", "财务": "L1"}, "item_grants": {},
             "writable_scopes": ["业务线:天猫"]},
        ],
    }
    MAP = {
        "v": 1, "people": [
            {"union_id": "on_cm", "open_ids": {"cli_main": "ou_cm_main", "cli_hr": "ou_cm_hr"},
             "person_id": "P-001", "name": "陈明", "job_id": "电商运营助理",
             "channels": ["main"], "is_cm": True,
             "status": "在职", "scopes": ["公司"],
             "extra_grants": {}, "extra_grants_until": {}},
            {"union_id": "on_wgh", "open_ids": {"cli_main": "ou_wgh_main"},
             "name": "伍国衡", "job_id": "", "status": "在职"},   # 岗位未批
            # ⚠️ 必须给 open_ids —— 否则他在【匹配阶段】就落到 unknown_person，
            #    根本走不到第 ④ 步的在职校验 ⇒ 这条自测就成了**假绿灯**
            #    （2026-10-04 实测：改了 not_active 后自测仍打印 ✅ unknown_person，就是栽在这里）。
            {"union_id": "on_gone", "open_ids": {"cli_main": "ou_gone_main"},
             "name": "离职者", "status": "离职"},
            # 🔴 V1.2 裁决（2026-10-05）：兼职/待入职【均不可上岗】⇒ unknown_status 拒。
            #    （旧版这里固化的是「放行断言」，#158 收口时已翻转 —— 防回归方向反过来。）
            {"union_id": "on_pt", "open_ids": {"cli_main": "ou_pt_main"},
             "name": "兼职者", "job_id": "J-PT", "status": "兼职"},
            {"union_id": "on_pre", "open_ids": {"cli_main": "ou_pre_main"},
             "name": "待入职者", "job_id": "J-PRE", "status": "待入职"},
            # 🔴 V10 回归用例：清单外新状态（既非在职也非明确不可上岗）⇒ 必须拒
            {"union_id": "on_new", "open_ids": {"cli_main": "ou_new_main"},
             "name": "新状态者", "job_id": "电商运营助理", "status": "停薪留职"},
            # 🔴 V10 配套：status 未填 ⇒ 两边都不在 ⇒ 同样拒
            {"union_id": "on_blank", "open_ids": {"cli_main": "ou_blank_main"},
             "name": "未填者", "job_id": "电商运营助理", "status": ""},
        ],
        "pending": [
            {"name": "李四", "open_id": "ou_lisi_unk", "reason": "union_id 未取到"},
            # 🔴 V9 反面：pending 无 open_id 键 ⇒ 该人来信只能是 unknown_person（码不可达假象被堵）
            {"name": "王五", "reason": "资料未齐"},
        ],
    }
    cases = [
        ("ou_cm_main",  "OK:陈明"),      # 命中
        ("ou_cm_hr",    "OK:陈明"),      # 跨 app 命中同一 union_id
        ("ou_pt_main",  E_UNKNOWN_STATUS),   # 🔴 兼职 ⇒ 拒（V1.2 裁决；旧版固化放行已翻转）
        ("ou_pre_main", E_UNKNOWN_STATUS),   # 🔴 待入职 ⇒ 拒（同上）
        ("ou_new_main", E_UNKNOWN_STATUS),   # 🔴 清单外新状态 ⇒ 拒（V10，堵 fail-open 洞）
        ("ou_blank_main", E_UNKNOWN_STATUS), # 🔴 status 未填 ⇒ 拒
        ("ou_unk",      E_UNKNOWN_PERSON),
        ("ou_lisi_unk", E_MISSING),      # pending 显式列出（带 open_id）
        ("ou_wangwu",   E_UNKNOWN_PERSON),   # pending 无 open_id 键 ⇒ 只能 unknown_person（V9）
        ("",            E_NO_OPEN_ID),
    ]
    bad = 0
    for ou, want in cases:
        actor, err = resolveActor(ou, MAP, JG)
        got = err if err else "OK:" + actor["name"]
        flag = "✅" if got == want else "❌"
        if got != want:
            bad += 1
        print(f"{flag} {ou or '(空)'} → {got}")
    # duplicate：临时造一个
    m2 = dict(MAP); m2["people"] = MAP["people"] + [dict(MAP["people"][0])]
    _, err = resolveActor("ou_cm_main", m2, JG)
    print(("✅" if err == E_DUPLICATE else "❌") + " duplicate → " + str(err))
    # job 未批（空 job_id）
    _, err = resolveActor("ou_wgh_main", MAP, JG)
    print(("✅" if err == E_NOT_GRANTED else "❌") + " job_not_granted(空) → " + str(err))
    # V4：审批卡号冒充 job_id ⇒ 必须拒（卡号在 jobs[].card，不在 .id）
    m3 = dict(MAP); m3["people"] = [dict(MAP["people"][0], job_id="CR-POST-20261003-01")] + MAP["people"][1:]
    _, err = resolveActor("ou_cm_main", m3, JG)
    print(("✅" if err == E_NOT_GRANTED else "❌") + " V4 卡号冒充 job_id → " + str(err))
    # V3 后半：岗位表里根本没有的岗位名 ⇒ 拒
    m4 = dict(MAP); m4["people"] = [dict(MAP["people"][0], job_id="主播")] + MAP["people"][1:]
    _, err = resolveActor("ou_cm_main", m4, JG)
    print(("✅" if err == E_NOT_GRANTED else "❌") + " V3 未批岗位 → " + str(err))
    # fail-closed：job_grants 缺表 ⇒ 即使在职+有名岗位也拒（不许因缺表放行）
    _, err = resolveActor("ou_cm_main", MAP, None)
    print(("✅" if err == E_NOT_GRANTED else "❌") + " 缺岗位表 fail-closed → " + str(err))
    # 离职 —— 必须是独立的 `not_active`，**不能**再混成 unknown_person
    _, err = resolveActor("ou_gone_main", MAP, JG)
    print(("✅" if err == E_NOT_ACTIVE else "❌") + " 离职 → " + str(err))
    # 反面断言：**完全不认识**的人仍然是 unknown_person —— 两者不可混
    _, err = resolveActor("ou_nobody_main", MAP, JG)
    print(("✅" if err == E_UNKNOWN_PERSON else "❌") + " 陌生人 → " + str(err))
    # 画像层：`open_id` 必须**回带**；13 字段不多不少（契约 §二）
    a, _e = resolveActor("ou_cm_main", MAP, JG)
    _got = (a or {}).get("open_id")
    print(("✅" if _got == "ou_cm_main" else "❌") + " 画像层 open_id → " + str(_got))
    _keys_ok = set((a or {}).keys()) == set(ACTOR_KEYS)
    print(("✅" if _keys_ok else "❌") + " 13 字段不多不少 → " + str(sorted((a or {}).keys())))
    # ⑥ 挂岗位现取：grants/writable_scopes/item_grants 来自岗位表，is_cm 来自人册
    _g_ok = (a or {}).get("grants") == {"销售": "L2", "财务": "L1"} and \
            (a or {}).get("item_grants") == {"财务|净利": "L2"} and \
            (a or {}).get("writable_scopes") == [] and (a or {}).get("is_cm") is True
    print(("✅" if _g_ok else "❌") + " 挂岗位现取 grants/item_grants/writable_scopes/is_cm")
    print("自测失败数:", bad)
    raise SystemExit(1 if bad else 0)
