#!/bin/bash
# 载荷：删除五步验收写入生产的合成候选人数据（AC-0200 选项 B 的事后清理，CM 已批该代价）
# r2 修因：R1 用 sudo /usr/bin/mysql 直连、无凭证 ⇒ STEP0 读候选人即 rc=20 失败退出（实测零写入，370 号仍在）。
#          本版改走生产在册包装器 /opt/scripts/shared/mysql_root（root 凭证由 credential_loader 从加密库取）。
# 单号：G11#2216-synthcleanup-r2-20261023    作者：HOME#Qoder-sess_684a508d
# 只删本次合成样本（candidate_id=370 / name 含 HECHENG-TEST-001），其余数据一律不碰。
set -u
TICKET="${1:-G11#2216-synthcleanup-r2-20261023}"
TS=$(date +%Y%m%d%H%M%S)
BAK="/opt/.trash_prod-20261023"
LOG="$BAK/synthcleanup-r2-$TS.log"
CAND_ID=370
DB=ecommerce_db
MYSQL="sudo /opt/scripts/shared/mysql_root -B -N"  # root 凭证走在册包装器（口令由 credential_loader 从加密库取，不落命令行）
PDF=/srv/aiad/agents/hr/downloaded_files/2026-10-23-051929_synthetic-resume-HECHENG-TEST-001.pdf

fail() { echo "FATAL rc=$1: $2" | tee -a "$LOG"; exit "$1"; }
mkdir -p "$BAK" || fail 10 "备份目录建不出来"
echo "=== synthcleanup $TS ticket=$TICKET candidate_id=$CAND_ID ===" > "$LOG"

# ── STEP0 前提核验：必须确认 370 就是我们写入的合成样本，否则拒绝执行 ──
NAME=$($MYSQL -e "SELECT name FROM $DB.biz_g5v2_candidate WHERE id=$CAND_ID" 2>>"$LOG") || fail 20 "读候选人失败"
[ -n "$NAME" ] || fail 21 "candidate_id=$CAND_ID 不存在（可能已清理），本单无需执行，幂等退出"
case "$NAME" in
  *HECHENG-TEST-001*) echo "STEP0 ok 目标确认＝合成样本：$NAME" | tee -a "$LOG" ;;
  *) fail 22 "candidate_id=$CAND_ID 的姓名不含 HECHENG-TEST-001（实测=$NAME）⇒ 不是本次合成样本，拒绝删除" ;;
esac

# ── STEP1 先备份后删除：四张 v2 表逐表导出留档 ──
for T in biz_g5v2_candidate biz_g5v2_resume_analysis biz_g5v2_delivery biz_g5v2_question_bank; do
  [ -n "$($MYSQL -e "SHOW TABLES LIKE '$T' FROM $DB" 2>>"$LOG")" ] || { echo "NOTE 表不存在，跳过：$T" | tee -a "$LOG"; continue; }
  $MYSQL -e "SELECT * FROM $DB.$T WHERE id=$CAND_ID OR candidate_id=$CAND_ID" >> "$BAK/synthcleanup-r2-$TS-$T.tsv" 2>>"$LOG" \
    && echo "BACKUP ok $T → $BAK/synthcleanup-r2-$TS-$T.tsv" | tee -a "$LOG" \
    || fail 30 "备份导出失败：$T"
done

# ── STEP2 逐表删除（参数化按主键/外键号，不靠姓名模糊匹配）──
for T in biz_g5v2_resume_analysis biz_g5v2_delivery biz_g5v2_question_bank biz_g5v2_candidate; do
  [ -n "$($MYSQL -e "SHOW TABLES LIKE '$T' FROM $DB" 2>>"$LOG")" ] || { echo "SKIP 无此表：$T" | tee -a "$LOG"; continue; }
  COL=id; [ "$T" != "biz_g5v2_candidate" ] && COL=candidate_id
  $MYSQL -e "DELETE FROM $DB.$T WHERE $COL=$CAND_ID" 2>>"$LOG" && echo "DELETE ok $T WHERE $COL=$CAND_ID" | tee -a "$LOG" || fail 40 "删除失败：$T"
done

# ── STEP3 复验清零：任何一张表仍能查到该号即报错（不静默）──
LEFT=0
for T in biz_g5v2_candidate biz_g5v2_resume_analysis biz_g5v2_delivery biz_g5v2_question_bank; do
  [ -n "$($MYSQL -e "SHOW TABLES LIKE '$T' FROM $DB" 2>>"$LOG")" ] || continue
  COL=id; [ "$T" != "biz_g5v2_candidate" ] && COL=candidate_id
  N=$($MYSQL -e "SELECT COUNT(*) FROM $DB.$T WHERE $COL=$CAND_ID" 2>>"$LOG") || fail 50 "复验查询失败：$T"
  echo "VERIFY $T 残留=$N" | tee -a "$LOG"
  [ "$N" = "0" ] || LEFT=1
done
[ "$LEFT" = "0" ] || fail 60 "复验未清零，见上面 VERIFY 行"

# ── STEP4 合成 PDF 移入回收目录（不直接 rm，保留证据）──
if [ -f "$PDF" ]; then
  mv "$PDF" "$BAK/" && echo "MV ok 合成简历已移入 $BAK" | tee -a "$LOG" || fail 70 "合成 PDF 移档失败"
else
  echo "NOTE 合成 PDF 不在原位（可能已移档）：$PDF" | tee -a "$LOG"
fi

# ── STEP5 生产变更留痕（含审批单号）──
{
  echo ""
  echo "- $TS | HOME#Qoder-sess_684a508d | $TICKET | 删除五步验收写入生产的合成候选人数据（candidate_id=$CAND_ID，四张 v2 表逐表备份后按号删除并复验清零，合成 PDF 移入 $BAK） | 通过：复验残留=0"
} >> /opt/scripts/OPS_CHANGELOG.md 2>>"$LOG" || echo "STEP5 WARN OPS_CHANGELOG 写入失败，见 $LOG" | tee -a "$LOG"

echo "CLEANUP_DONE ticket=$TICKET candidate_id=$CAND_ID 备份与日志在 $BAK" | tee -a "$LOG"
exit 0
