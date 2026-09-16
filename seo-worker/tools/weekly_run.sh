#!/bin/bash
# weekly_run.sh — 每周批跑：跑前快照 → 顺序对客户跑 harness（一次一个防内存挤兑）→
# 跑后快照 → weekly_digest.py 出结构化收尾（顺利几家、卡壳几条、按原因分组的人工修复清单）。
# 人触发，不挂 cron，不违反硬规矩 1。
# 用法：SEO_AGENT_TOKEN=<jwt> bash tools/weekly_run.sh [client_id ...]
set -uo pipefail
cd "$(dirname "$0")/.."
API="${MA_API:-https://always.horntech-dev.com/seo-api.php}"
TOKEN="${SEO_AGENT_TOKEN:-}"
[ -z "$TOKEN" ] && { echo "缺 SEO_AGENT_TOKEN"; exit 2; }
STAMP=$(date +%Y%m%d-%H%M)
WORK="/tmp/weekly_run_${STAMP}"
mkdir -p "$WORK"

if [ $# -gt 0 ]; then
  IDS="$*"
else
  IDS=$(curl -sf -H "Authorization: Bearer $TOKEN" "$API/clients" | python3 -c "
import json,sys
rows=json.load(sys.stdin)
rows=rows.get('clients') or rows
print(' '.join(str(c.get('client_id')) for c in rows if str(c.get('status'))=='active'))")
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
python3 seo-worker/tools/weekly_digest.py digest "$WORK/before.json" "$WORK/after.json" > "$WORK/digest.md"
echo
cat "$WORK/digest.md"
echo
echo "收尾文件: $WORK/digest.md（各家 harness 全量日志同目录）"
