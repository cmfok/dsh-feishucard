#!/bin/bash
# 载荷：删除五步验收写入生产的合成候选人数据（AC-0200 选项 B 的事后清理，CM 已批该代价）——r4 修因版
# 单号：G11#2216-synthcleanup-r4-20261023    作者：HOME#Qoder-sess_684a508d
#
# 为什么出 r4（两版实测失败教训，逐条对症）：
#   R1（05:35 FAILED rc=20）：用 sudo /usr/bin/mysql 直连、无凭证 ⇒ 第一步读候选人即失败，零改动。
#   R2（05:46 DONE rc=0 但零删除）：表存在性检查写成 SHOW TABLES LIKE 'x' FROM db（MySQL 无此语法，
#       实测 1064）⇒ 每次检查都「取到空值」，脚本把「SQL 报错」误判成「表不存在」，逐表 SKIP 掉了
#       备份与删除，最后 CLEANUP_DONE rc=0 并向 OPS_CHANGELOG 写了「复验残留=0」的假结论行。
#   R4 追加修因：落点核对闸拦到 r3 载荷里有 /srv 落点变量而卡面未声明；合成简历经实测已在
#       /opt/.trash_prod-20261023（R2 唯一真实生效的动作），故本版删掉文件步，载荷落点只剩卡面声明的回收目录。
#   ⇒ r3 起已落的三处硬改保持：①存在性/计数一律走 information_schema 与显式 SELECT，不再用 SHOW TABLES；
#      ②所有取数一律「必须是数字/必须是预期形状」才放行，报错或空值即 fail-closed（不当成 0、不当成不存在）；
#      ③收尾追加 OPS_CHANGELOG 更正行，写明 R2 那行是误记、真实删除由本单完成。
set -u
TICKET="${1:-G11#2216-synthcleanup-r4-20261023}"
TS=$(date +%Y%m%d%H%M%S)
BAK="/opt/.trash_prod-20261023"
LOG="$BAK/synthcleanup-r4-$TS.log"
CAND_ID=370
DB=ecommerce_db
MYSQL="sudo /opt/scripts/shared/mysql_root -B -N"
TABLES="biz_g5v2_candidate biz_g5v2_resume_analysis biz_g5v2_delivery biz_g5v2_question_bank"

fail() { echo "FATAL rc=$1: $2" | tee -a "$LOG"; exit "$1"; }
# must_number <标签> <取数结果> —— 空值或非数字一律视为查询失败（报错被误判成 0 是本单要根治的缺陷）
must_number() { case "$2" in ''|*[!0-9]*) fail 25 "取数失败（$1）：期望纯数字，实测=[$2]" ;; esac; }

mkdir -p "$BAK" || fail 10 "备份目录建不出来"
echo "=== synthcleanup r4 $TS ticket=$TICKET candidate_id=$CAND_ID ===" > "$LOG"

# ── STEP0 连接自检：先证明「取数成功」与「取数失败」两种形状可分辨，再往下走 ──
PROBE=$($MYSQL -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB'" 2>>"$LOG") \
  || fail 20 "数据库连接自检失败（未取到任何计数）"
must_number "STEP0 连接自检计数" "$PROBE"
[ "$PROBE" -gt 0 ] || fail 21 "STEP0 自检计数为 0，库 $DB 里没有任何表？异常，停止执行"
echo "STEP0 ok 连接可用，$DB 表数=$PROBE" | tee -a "$LOG"

# ── STEP1 前提核验：370 必须读得到、且姓名是合成样本 ──
NAME=$($MYSQL -e "SELECT name FROM $DB.biz_g5v2_candidate WHERE id=$CAND_ID" 2>>"$LOG") || fail 30 "读候选人失败"
[ -n "$NAME" ] || { echo "NOTE 370 号已不在候选人表 ⇒ 本步幂等跳过删除，只做复验与留痕" | tee -a "$LOG"; ALREADY=1; }
if [ "${ALREADY:-0}" = "0" ]; then
  case "$NAME" in
    *HECHENG-TEST-001*) echo "STEP1 ok 目标确认＝合成样本：$NAME" | tee -a "$LOG" ;;
    *) fail 32 "candidate_id=$CAND_ID 姓名不含 HECHENG-TEST-001（实测=$NAME）⇒ 不是本次合成样本，拒绝删除" ;;
  esac
fi

# ── STEP2 逐表：存在性用 information_schema 判（不再用 SHOW TABLES），备份→删除→复验 ──
for T in $TABLES; do
  EXIST=$($MYSQL -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB' AND table_name='$T'" 2>>"$LOG") \
    || fail 40 "存在性查询失败：$T"
  must_number "存在性计数 $T" "$EXIST"
  if [ "$EXIST" = "0" ]; then echo "NOTE 表不存在，跳过：$DB.$T（存在性查询实回 0）" | tee -a "$LOG"; continue; fi

  if [ "$T" = "biz_g5v2_candidate" ]; then COL=id; else COL=candidate_id; fi

  BEFORE=$($MYSQL -e "SELECT COUNT(*) FROM $DB.$T WHERE $COL=$CAND_ID" 2>>"$LOG") || fail 41 "删除前计数查询失败：$T"
  must_number "删除前计数 $T" "$BEFORE"
  echo "COUNT $T 删除前=$BEFORE" | tee -a "$LOG"

  if [ "$BEFORE" != "0" ]; then
    TSV="$BAK/synthcleanup-r4-$TS-$T.tsv"
    $MYSQL -e "SELECT * FROM $DB.$T WHERE $COL=$CAND_ID" > "$TSV" 2>>"$LOG" || fail 42 "备份导出失败：$T"
    [ -s "$TSV" ] || fail 43 "备份文件为空，拒绝删除：$T（$TSV）"
    echo "BACKUP ok $T $BEFORE 行 → $TSV" | tee -a "$LOG"

    $MYSQL -e "DELETE FROM $DB.$T WHERE $COL=$CAND_ID" 2>>"$LOG" || fail 44 "删除失败：$T"
    echo "DELETE ok $T WHERE $COL=$CAND_ID" | tee -a "$LOG"
  else
    echo "SKIP $T 无 $CAND_ID 号记录（删除前计数=0）" | tee -a "$LOG"
  fi

  AFTER=$($MYSQL -e "SELECT COUNT(*) FROM $DB.$T WHERE $COL=$CAND_ID" 2>>"$LOG") || fail 45 "复验查询失败：$T"
  must_number "复验计数 $T" "$AFTER"
  echo "VERIFY $T 残留=$AFTER" | tee -a "$LOG"
  [ "$AFTER" = "0" ] || fail 46 "复验未清零：$T 残留=$AFTER"
done

# ── STEP3 合成简历：R2 已实测把它移入回收目录，本单不再动文件（载荷落点只剩卡面声明的回收目录）──

# ── STEP4 留痕：更正 R2 的误记行，再写本单真实结果 ──
{
  echo ""
  echo "- $TS | HOME#Qoder-sess_684a508d | G11#2216-synthcleanup-r2-20261023 | 更正：该单执行回显 DONE rc=0 但实际零删除（表存在性检查语句语法不被 MySQL 支持，报错被脚本误判为「表不存在」而逐表跳过备份与删除），其「通过：复验残留=0」一行属误记，不作数；同单唯一真实生效的动作是合成简历 PDF 移入 $BAK。"
  echo ""
  echo "- $TS | HOME#Qoder-sess_684a508d | $TICKET | 删除五步验收写入生产的合成候选人数据（candidate_id=$CAND_ID）：$TABLES 逐表按 information_schema 判存在、逐表计数→SELECT 备份 TSV→按号 DELETE→复验计数必须为数字且为 0；取数失败或空值一律 fail-closed 不当作 0。 | 通过：逐表 VERIFY 残留=0（详见 $LOG）"
} >> /opt/scripts/OPS_CHANGELOG.md 2>>"$LOG" || fail 60 "OPS_CHANGELOG 留痕写入失败"

echo "CLEANUP_DONE ticket=$TICKET candidate_id=$CAND_ID 备份与日志在 $BAK" | tee -a "$LOG"
exit 0
