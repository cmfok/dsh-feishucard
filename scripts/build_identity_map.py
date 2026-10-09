#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_identity_map.py —— 身份映射表生成器（NODE1 v3 §2.2/§2.3 · D2）

- 幂等：重复跑不产生重复 people/pending
- 可 --dry-run（默认）：只打印将要发生的变化
- 数据源：① HRM 人员清单 seed（--seed，JSON 数组：name/job_id/channel/status/open_id）
          ② 飞书 contact.user.get（--via-contact；**应用身份**，2026-10-04 实测可用）
- 约束：cron 每天 1 次（03:20）· 飞书 API 日常 ≤ 3 次/天 · 不自造目录 · 输出 0640
- 凭证一律不写进映射表（app_id/ou_/union_id 是标识符不是凭证）

────────────────────────────────────────────────────────────────────────────
2026-10-04 修改记录（改：<home-maintainer>，经 CM 当日改派「身份表归我」）
原作者：<original-author>（01:14 首版，md5 215afec955f685fc19241f90a7f8ee9d）
改前备份：<deploy-dir>/build_identity_map.py.bak-20261004-0127-before-home-fix

改了什么（都为一个目标：把 HRM 表里【已有的 open_id】真正用起来）：
  ① seed 分支原来只取 name/job_id/channel/status ⇒ `open_ids` 恒为 {}
     ⇒ 反查必然传空字符串。现在吃 seed 的 `open_id`，写进 `open_ids{<app_id>: "ou_…"}`
     （key 用 app_id，与 resolve_actor「扫所有人的所有 app」的查找方式一致）。
  ② 反查分支原来取 `next(iter(person["open_ids"].values()), "")` ⇒ 空。
     现在显式挑第一个非空值；没有可查的 open_id 就跳过（留给 seed 补），不再空转。
  ③ 补 `aliases`（规格 §2.2 要求；§2.4 的自助兜底靠它）—— 首版完全没写 ⇒ 兜底无据可依。
  ④ `pending` 条目带上 `open_id`（若 seed 有）—— resolve_actor 的 `open_id_missing`
     判据靠 `pending[].open_id` 匹配；不带它那条错误码永远不可达。
  ⑤ 反查改走 `lark-cli … --as bot`，不再需要 app_secret 进本进程：
     实测 `--as bot`（应用身份）可把 ou_… 换成 union_id；用户身份则报
     `99991679 missing_scope`（缺 4 个 contact:* scope）—— 所以**不必开通讯录权限**。
     这样本脚本不接触任何凭证明文（H7）。
  ⑥ 删掉 `CONTACT_API.format(...)` 占位死代码。
  ⑦ 新增 `--max-calls`（默认 3，日常 cron 用；**首次建表传 40**）：
     首版把 3 写死，导致一次性建表根本跑不完。日常靠「已有 union_id 就跳过」保持 0~3 次。
────────────────────────────────────────────────────────────────────────────
2026-10-09 契约 V1.2 实施收口（中台 #158，验收＝身份-授权契约-v1 §七）：
  ⑧ 人级 entry 去 `grants`（挂岗位 ⇒ grants 只从岗位表现取，§四 连带改动）；
    限期键统一为 `extra_grants_until`（旧裸名全仓废弃，V2 机验零残留）；新增 `is_cm`（契约 §2.1，X3 主数据搬运）。
  ⑨ 存量主表如带人级 grants / 旧裸名限期键 ⇒ 用 --migrate-contract-v12 一次性清洗
    （只删键/搬键不改值；people 之外的字段不动）。
────────────────────────────────────────────────────────────────────────────
"""
import argparse
import datetime
import json
import os
import subprocess
import sys

MAP_PATH = "<deploy-dir>/identity_map.json"
LARK = "/usr/local/bin/lark-cli"


def load_map():
    if os.path.isfile(MAP_PATH):
        with open(MAP_PATH, encoding="utf-8-sig") as f:
            return json.load(f)
    return {"v": 1, "updated": None, "source": "", "primary_key": "union_id",
            "people": [], "pending": []}


def save(m):
    m["updated"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    tmp = MAP_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(m, f, ensure_ascii=False, indent=1)
    os.chmod(tmp, 0o640)
    os.replace(tmp, MAP_PATH)


def _lark_prefix():
    """cron 一般以 root 跑；交互跑则要 sudo（lark-cli 的凭证在 /root/.lark-cli）。"""
    return [] if os.geteuid() == 0 else ["sudo"]


def contact_get_union_id(open_id):
    """open_id -> union_id（应用身份）。返回 (union_id, 原因)；成功时原因为 None。"""
    if not open_id:
        return None, "no_open_id"
    cmd = _lark_prefix() + [
        LARK, "api", "GET",
        "/open-apis/contact/v3/users/" + open_id + "?user_id_type=open_id",
        "--as", "bot", "--format", "json",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except Exception as e:                                   # noqa: BLE001
        return None, "exec_failed: " + str(e)[:80]
    out = (r.stdout or "").strip()
    i = out.find("{")
    if i < 0:
        return None, "no_json: " + ((out or r.stderr or "")[:80])
    try:
        d = json.loads(out[i:])
    except Exception as e:                                   # noqa: BLE001
        return None, "bad_json: " + str(e)[:60]
    if not d.get("ok"):
        err = d.get("error") or {}
        return None, "api code=%s %s" % (err.get("code"), str(err.get("message"))[:60])
    u = ((d.get("data") or {}).get("user") or {})
    if u.get("union_id"):
        return u["union_id"], None
    return None, "no_union_id_in_response"


def migrate_contract_v12(m):
    """契约 V1.2 收口迁移（中台 #158）：存量主表一次性清洗，只删键/搬键，不改任何判定数据。

    ① 人级 `grants` 整键删除（契约 §四：挂岗位 ⇒ grants 只从岗位表现取；
       残留人级 grants 不会被新版 resolve_actor 读到，留着只会误导排障）。
    ② 旧裸名限期键整体改名 `extra_grants_until`（值原样搬运）——
       🔴 不搬 ＝ 第 3 层限期数据【静默失效】（新版只读新键 ⇒ 永远空 dict），V2 点名的失效模式。
    ③ 补 `is_cm` 默认 False（契约 §2.1；CM 本人一行由人工/主数据置 true）。
    返回 (迁移人数, 限期搬运条数)。
    """
    n_people = 0
    n_until = 0
    for person in m.get("people", []):
        if not isinstance(person, dict):
            continue
        changed = False
        if "grants" in person:
            person.pop("grants", None)
            changed = True
        if "grants_until" in person:
            old = person.pop("grants_until") or {}
            merged = dict(person.get("extra_grants_until") or {})
            for k, v in old.items():
                merged.setdefault(k, v)
                n_until += 1
            person["extra_grants_until"] = merged
            changed = True
        if "is_cm" not in person:
            person["is_cm"] = False
            changed = True
        if changed:
            n_people += 1
    return n_people, n_until


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="不加= dry-run")
    ap.add_argument("--migrate-contract-v12", action="store_true",
                    help="契约 V1.2 收口迁移：人级去 grants、grants_until⇒extra_grants_until、补 is_cm")
    ap.add_argument("--seed", help="HRM 人员清单 JSON：[{name,job_id,channel,status,open_id}]")
    ap.add_argument("--via-contact", action="store_true",
                    help="用飞书通讯录（应用身份）把 open_id 换成 union_id")
    ap.add_argument("--app-id", default="",
                    help="open_ids 的 key（该 bot 的 app_id），例 cli_xxxxxxxxxxxxxxxx")
    ap.add_argument("--max-calls", type=int, default=3,
                    help="本次最多几次 contact 调用（日常 3；**首次建表传 40**）")
    args = ap.parse_args()

    m = load_map()

    # ⓪ 契约 V1.2 收口迁移（可选；--apply 才落盘）
    if args.migrate_contract_v12:
        n_people, n_until = migrate_contract_v12(m)
        print("%s 契约V1.2迁移: 清洗 %d 人（限期键搬运 %d 条；grants 删键、is_cm 补默认）" % (
            "[apply]" if args.apply else "[dry]  ", n_people, n_until))

    known = {p.get("name") for p in m.get("people", [])}
    pending_names = {p.get("name") for p in m.get("pending", [])}
    calls = 0
    added = 0
    skipped = 0
    patched = 0        # 2026-10-04 修：已存在的人被【补上】open_ids 的条数（原版永远是 0）
    removed = 0        # 2026-10-04 修：资料补齐后从 pending 里【移除】的条数（原版永远不清）

    # ① seed ⇒ people（有 open_id 就一并写进 open_ids）
    if args.seed and os.path.isfile(args.seed):
        for person in json.load(open(args.seed, encoding="utf-8-sig")):
            nm = (person.get("name") or "").strip()
            if not nm:
                continue
            if nm in known:
                # 🔴 2026-10-04 修（自己发现）：原版"已存在就 continue" ⇒ **open_ids 永远补不进去**。
                #    后果："增量补全"名不副实 —— 权限开了、或从 HRM 的 ☑️飞书帐号 字段拿到 open_id 之后，
                #    **表里已经有的人反而补不上**（只有全新的人才会写 open_ids）。
                #    现在：已存在的人**也补 open_ids**（同 app 不同值才覆盖，相同则算 skipped）。
                oid_old = (person.get("open_id") or "").strip()
                existing = next((p for p in m["people"] if p.get("name") == nm), None)
                if existing is not None and oid_old and args.app_id:
                    oids = existing.setdefault("open_ids", {})
                    if oids.get(args.app_id) != oid_old:
                        if args.apply:
                            oids[args.app_id] = oid_old
                        patched += 1
                        print("%s 补 open_ids[%s]: %s" % (
                            "[apply]" if args.apply else "[dry]  ", args.app_id, nm))
                    else:
                        skipped += 1
                else:
                    skipped += 1
                continue
            oid = (person.get("open_id") or "").strip()
            open_ids = {}
            if oid and args.app_id:
                open_ids[args.app_id] = oid
            entry = {
                "union_id": None,
                "open_ids": open_ids,
                "person_id": person.get("person_id", ""),
                "name": nm,
                "job_id": person.get("job_id", ""),
                "channel": person.get("channel", ""),
                "status": person.get("status", ""),
                "aliases": [nm],                      # 规格 §2.2；自助兜底靠它
                "scopes": person.get("scopes", []),
                # 🔴 契约 §四（2026-10-09 收口 #158）：挂岗位 ⇒ 人级【不许再存 grants】——
                #    grants/writable_scopes/item_grants 一律由 resolve_actor 按 job_id
                #    从 job_grants.json 现取；改一个岗位不用重刷全表，也不会出现
                #    「表说批了 L1、这人还带着 L2」的人级漂移。人级只留第 3 层（个人叠加）。
                "extra_grants": person.get("extra_grants", {}),
                "extra_grants_until": person.get("extra_grants_until", {}),
                "is_cm": bool(person.get("is_cm", False)),
                "confirmed_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
            }
            if args.apply:
                m["people"].append(entry)
                known.add(nm)
            added += 1
            print("%s seed: %s (job=%s, open_id=%s)" % (
                "[apply]" if args.apply else "[dry]  ", nm,
                entry["job_id"] or "未批", "有" if oid else "无"))

    # ② pending：岗位未批 或 open_id 未取到的人显式列出，并【带上 open_id】
    if args.seed and os.path.isfile(args.seed):
        for person in json.load(open(args.seed, encoding="utf-8-sig")):
            nm = (person.get("name") or "").strip()
            if not nm or nm in pending_names:
                continue
            oid = (person.get("open_id") or "").strip()
            reason = None
            if not person.get("job_id"):
                reason = "岗位未批（job_not_granted 前置）"
            elif not oid:
                reason = "open_id 未取到（HRM 该行 Openid 为空）"
            if not reason:
                continue
            # 🔑 `open_id` 键**必须存在**（表里没有就写 null，**不许省略键**）—— `0225` §一 口径：
            #    ① `resolve_actor` 的 `open_id_missing` 判据读 `pending[].open_id`；
            #    ② "这条 pending 到底有没有 id"必须能从结构上看出来 ——
            #       **省略键** ≠ **值为 null**：前者分不清「本来就没有」还是「忘了写」。
            item = {"name": nm, "reason": reason, "open_id": oid or None}
            if args.apply:
                m.setdefault("pending", []).append(item)
                pending_names.add(nm)
            print("%s pending: %s (%s)" % ("[apply]" if args.apply else "[dry]  ", nm, reason))

    # ②-补：把【现在已齐备】的人从 pending 里移除 —— 否则 reason 会永远停在过时状态，
    #        而 D3 的 open_id_missing 判定正是读 pending。
    #        2026-10-04 实测：吴址欣 / 李扬精 补上 open_id 之后仍挂在 pending，
    #        理由还写着"open_id 未取到" —— 那就是脏数据。
    #        判据：已有 open_ids（任一 app）且 job_id 非空 ⇒ 不再属于"资料没齐"。
    if m.get("pending"):
        keep = []
        for item in m["pending"]:
            pp = next((p for p in m["people"] if p.get("name") == item.get("name")), None)
            if pp and (pp.get("open_ids") or {}) and pp.get("job_id"):
                removed += 1
                print("%s pending 移除（资料已齐）: %s" % (
                    "[apply]" if args.apply else "[dry]  ", item.get("name")))
                continue
            keep.append(item)
        if args.apply:
            m["pending"] = keep

    # ③ contact 反查（应用身份；增量：已有 union_id 的不再查）
    if args.via_contact:
        for person in m["people"]:
            if calls >= args.max_calls:
                print("⚠️ 已达本次上限 %d 次，停止（下次接着跑，已回填的不重复）" % args.max_calls)
                break
            if person.get("union_id"):
                continue
            cand = [ou for ou in (person.get("open_ids") or {}).values() if ou]
            if not cand:
                continue                  # 没有 open_id 可查 ⇒ 留给 seed 补，不空转
            calls += 1
            union_id, why = contact_get_union_id(cand[0])
            if union_id:
                if args.apply:
                    person["union_id"] = union_id
                print("%s 回填 union_id: %s" % ("[apply]" if args.apply else "[dry]  ", person.get("name")))
            else:
                print("⚠️ %s 反查失败: %s" % (person.get("name"), why))

    if args.apply:
        save(m)
        print("已写入 %s：people=%d pending=%d api_calls=%d 新增=%d 跳过=%d" % (
            MAP_PATH, len(m["people"]), len(m.get("pending", [])), calls, added, skipped))
    else:
        print("[dry-run] people=%d pending=%d api_calls=%d 新增=%d 跳过=%d —— 加 --apply 落盘" % (
            len(m["people"]), len(m.get("pending", [])), calls, added, skipped))


if __name__ == "__main__":
    main()
