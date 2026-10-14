#!/bin/bash
# weekly_run.sh — 半月轮批跑（每月 1 号与 15 号开轮，2026-10-07 Alvin 定）：跑前快照 →
# 顺序对客户跑 harness（一次一个防内存挤兑）→ 跑后快照 → weekly_digest.py 出结构化收尾
# （顺利几家、卡壳几条、按原因分组的人工修复清单）。
# 不传 client_id 时全量 active，paid 客户（services=sem/paid/both）排在前（2026-10-14 Alvin 批）。
# 人触发，不挂 cron，不违反硬规矩 1。文件名沿用 weekly_ 前缀，口径以本注释为准。
# 用法：SEO_AGENT_TOKEN=<jwt> bash tools/weekly_run.sh [client_id ...]
set -uo pipefail
cd "$(dirname "$0")/../.."
API="${MA_API:-https://always.horntech-dev.com/seo-api.php}"
TOKEN="${SEO_AGENT_TOKEN:-}"
[ -z "$TOKEN" ] && { echo "缺 SEO_AGENT_TOKEN"; exit 2; }
# RUN_TAG：并行双道支持（2026-10-10）。两个 weekly_run 进程各带一半客户同时跑时，
# 用 RUN_TAG=a / RUN_TAG=b 区分 run 目录防撞；同客户互斥在服务端，跨客户并行安全。
STAMP=$(date +%Y%m%d-%H%M)${RUN_TAG:+-$RUN_TAG}
HIST="${WEEKLY_HIST:-/data/aira/projects/MA/weekly_runs}"
WORK="$HIST/run_${STAMP}"
mkdir -p "$WORK"
PREV=$(ls -d "$HIST"/run_* 2>/dev/null | grep -v "run_${STAMP}" | sort | tail -1)

if [ $# -gt 0 ]; then
  IDS="$*"
else
  IDS=$(curl -sf -H "Authorization: Bearer $TOKEN" "$API/clients" | python3 -c "
import json,sys
rows=json.load(sys.stdin)
rows=rows.get('clients') or rows
act=[c for c in rows if str(c.get('status'))=='active']
# paid 优先（2026-10-14 Alvin 批）：sem/paid/both 在前，组内保持 API 的名字序
act.sort(key=lambda c: 0 if str(c.get('services') or '').lower() in ('sem','paid','both') else 1)
print(' '.join(str(c.get('client_id')) for c in act))")
fi

python3 seo-worker/tools/weekly_digest.py snapshot "$WORK/before.json" $IDS

for cid in $IDS; do
  echo "===== client $cid $(date +%H:%M:%S)"
  node seo-worker/tools/harness.js "$cid" > "$WORK/harness_$cid.log" 2>&1
  RC=$?
  tail -4 "$WORK/harness_$cid.log"
  [ $RC -ne 0 ] && echo "  (client $cid 退出码 $RC，日志 $WORK/harness_$cid.log，继续下一家)"
done

python3 seo-worker/tools/weekly_digest.py snapshot "$WORK/after.json" $IDS
python3 seo-worker/tools/weekly_digest.py digest "$WORK/before.json" "$WORK/after.json" "${PREV:+$PREV/after.json}" > "$WORK/digest.md"
echo
cat "$WORK/digest.md"
echo
echo "收尾文件: $WORK/digest.md（各家 harness 全量日志同目录）"
