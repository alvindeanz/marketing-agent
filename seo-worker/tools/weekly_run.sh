#!/bin/bash
# weekly_run.sh — 每周批跑：顺序对全部 active 客户跑 harness，一次一个防内存挤兑，
# 末尾吐一页汇总（各家收了什么、卡了什么、等谁）。人触发，不挂 cron 不违反硬规矩 1。
# 用法：SEO_AGENT_TOKEN=<jwt> bash tools/weekly_run.sh [client_id ...]
#       不带参数 = 全部 active 客户；带参数 = 只跑这几家。
set -uo pipefail
cd "$(dirname "$0")/.."
API="${MA_API:-https://always.horntech-dev.com/seo-api.php}"
TOKEN="${SEO_AGENT_TOKEN:-}"
[ -z "$TOKEN" ] && { echo "缺 SEO_AGENT_TOKEN"; exit 2; }
STAMP=$(date +%Y%m%d-%H%M)
DIGEST="/tmp/weekly_run_${STAMP}.md"

if [ $# -gt 0 ]; then
  IDS="$*"
else
  IDS=$(curl -sf -H "Authorization: Bearer $TOKEN" "$API/clients" | python3 -c "
import json,sys
rows=json.load(sys.stdin)
rows=rows.get('clients') or rows
print(' '.join(str(c.get('client_id')) for c in rows if str(c.get('status'))=='active'))")
fi
echo "# 每周批跑汇总 $STAMP" > "$DIGEST"
echo "客户: $IDS" >> "$DIGEST"

for cid in $IDS; do
  echo "===== client $cid $(date +%H:%M:%S)"
  OUT=$(node seo-worker/tools/harness.js "$cid" 2>&1)
  RC=$?
  {
    echo; echo "## client $cid（退出码 $RC）"
    # 汇总只留人要看的：处置行、放行卡、阻塞、闸中止
    echo "$OUT" | grep -E "本期|处置|放行卡|阻塞|确认闸|中止|失败|收口|folded|卡反馈" | head -20
  } >> "$DIGEST"
  # 单客户失败不拖垮整轮
  [ $RC -ne 0 ] && echo "  (client $cid 退出码 $RC，已记汇总，继续下一家)"
done
echo; echo "================ 汇总 ================"
cat "$DIGEST"
echo; echo "汇总文件: $DIGEST"
