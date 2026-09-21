#!/bin/bash
# weekly_pull.sh — 周日 cron：调 POST /jobs/pull_sweep，给全部 active 客户各排一个
# pull_data job，harness 的轮转与判定就不会拿三周前的库存数据做决策。
# pull_data 零 LLM（runners/pull_data.js 头注），挂 cron 不违反硬规矩 1，规矩禁的是
# cron 触发 LLM；harness / 判决 / 放行仍然全部人触发。
# token 用 worker 的 serviceToken（端点是 auth_worker），从 ros 本机 config.json 读。
# cron 安装（root，ros 是 UTC）：周六 14:00 UTC = 周日 02:00 NZST（夏令时 03:00）：
#   0 14 * * 6 /bin/bash /data/aira/projects/MA/marketing-agent/seo-worker/tools/weekly_pull.sh >> /data/aira/seo-worker/logs/weekly_pull.log 2>&1
set -uo pipefail
API="${MA_API:-https://always.horntech-dev.com/seo-api.php}"
CFG="${WORKER_CFG:-/data/aira/seo-worker/config.json}"
TOKEN="${SEO_WORKER_TOKEN:-$(python3 -c "import json;print(json.load(open('$CFG'))['serviceToken'])" 2>/dev/null)}"
[ -z "$TOKEN" ] && { echo "$(date -u +%FT%TZ) 缺 token：$CFG 读不到 serviceToken"; exit 2; }

OUT=$(curl -sf -X POST -H "Authorization: Bearer $TOKEN" "$API/jobs/pull_sweep")
RC=$?
if [ $RC -ne 0 ] || [ -z "$OUT" ]; then
  echo "$(date -u +%FT%TZ) pull_sweep 请求失败（curl 退出码 $RC）"
  exit 1
fi
echo "$(date -u +%FT%TZ) $OUT"
