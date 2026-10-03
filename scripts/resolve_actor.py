#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""resolve_actor.py —— 内层身份解析（NODE1 规格补丁 v3 §2.4 · D3/D4）

纯函数：不读时钟、不写文件、不调网络（HOME 侧可断网单测）。
fail-closed：任何认不出的情形一律拒绝，绝不拿姓名模糊匹配放行。

用法（被 HOME 的 handleInbound 经 MCP 调用，也可命令行自测）：
    from resolve_actor import resolveActor
    actor, err = resolveActor(open_id, identity_map)   # err=None 或 ResolveError 字符串

错误码（7 种，逐字对接 HOME）：map_unavailable / no_open_id / unknown_person /
duplicate_open_id / open_id_missing / job_not_granted / (自助兜底另记 identity.unverified)
"""
import json

# ── 错误码 ──────────────────────────────────────────────────────────────
E_MAP_UNAVAILABLE = "map_unavailable"
E_NO_OPEN_ID      = "no_open_id"
E_UNKNOWN_PERSON  = "unknown_person"
E_DUPLICATE       = "duplicate_open_id"
E_MISSING         = "open_id_missing"
E_NOT_GRANTED     = "job_not_granted"

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

def resolveActor(open_id, identity_map):
    """按 §2.4 返回 (actor, None) 或 (None, 错误码)。

    actor 结构（D4，policy_axis.User 六字段 + channels + source）：
      { name, scopes[], grants{}, extra_grants{}, grants_until{},
        channels[], source }
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

    # ④ 在职校验（离职 = 未知）
    if str(person.get("status", "")) not in ("在职", "active"):
        return None, E_UNKNOWN_PERSON

    # ⑤ 岗位授权：job_id 必须已批（未批 = job_not_granted）
    if not person.get("job_id"):
        return None, E_NOT_GRANTED

    # ⑥ 组装 actor（六字段 + channels + source，字段与 policy_axis.User 对齐）
    return ({
        "name": person.get("name", ""),
        "scopes": list(person.get("scopes", [])),
        "grants": dict(person.get("grants", {})),
        "extra_grants": dict(person.get("extra_grants", {})),
        "grants_until": dict(person.get("grants_until", {})),
        "channels": list(person.get("channels", [])),
        "source": f"identity_map@v{m.get('v', '?')}",
    }), None


# ── 合成身份自测（§2.4：可用合成身份单测，不需要真数据）────────────────
if __name__ == "__main__":
    MAP = {
        "v": 1, "people": [
            {"union_id": "on_cm", "open_ids": {"cli_main": "ou_cm_main", "cli_hr": "ou_cm_hr"},
             "name": "陈明", "job_id": "CR-POST-20261003-01", "channels": ["main"],
             "status": "在职", "scopes": ["公司"], "grants": {"报表": "L1"}},
            {"union_id": "on_wgh", "open_ids": {"cli_main": "ou_wgh_main"},
             "name": "伍国衡", "job_id": "", "status": "在职"},   # 岗位未批
            {"union_id": "on_gone", "open_ids": {}, "name": "离职者", "status": "离职"},
        ],
        "pending": [{"name": "李四", "open_id": "ou_lisi_unk", "reason": "union_id 未取到"}],
    }
    cases = [
        ("ou_cm_main", None),          # 命中
        ("ou_cm_hr",   None),          # 跨 app 命中同一 union_id
        ("ou_unk",     E_UNKNOWN_PERSON),
        ("ou_lisi_unk", E_MISSING),    # pending 显式列出
        ("",            E_NO_OPEN_ID),
    ]
    bad = 0
    for ou, want in cases:
        actor, err = resolveActor(ou, MAP)
        got = err if err else "OK:" + actor["name"]
        want_s = want or "OK:陈明"
        flag = "✅" if got == want_s else "❌"
        if got != want_s:
            bad += 1
        print(f"{flag} {ou or '(空)'} → {got}")
    # duplicate：临时造一个
    m2 = dict(MAP); m2["people"] = MAP["people"] + [dict(MAP["people"][0])]
    _, err = resolveActor("ou_cm_main", m2)
    print(("✅" if err == E_DUPLICATE else "❌") + " duplicate → " + str(err))
    # job 未批
    _, err = resolveActor("ou_wgh_main", MAP)
    print(("✅" if err == E_NOT_GRANTED else "❌") + " job_not_granted → " + str(err))
    # 离职
    _, err = resolveActor("ou_gone_main", MAP)
    print(("✅" if err == E_UNKNOWN_PERSON else "❌") + " 离职 → " + str(err))
    print("自测失败数:", bad)
