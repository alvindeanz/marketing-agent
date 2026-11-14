#!/bin/bash
# round_remind.sh — 半月轮开轮提醒（零 LLM，2026-10-14 Alvin 批）。每月 1 号与 15 号的
# NZ 早上由 cron 触发，用 Aira 的 bot token 给 Alvin 发一条 Discord 私信提醒。
# 2026-11-14 Alvin 改：原先发 horntech-sem 群，改发 DM 不再刷群。开轮动作仍回 MA 线程说
# （DM 会话不带 MA 项目上下文）。DM 发不了（对方关了私信等）才退回群里 @ 人，提醒不能丢。
# claude-bot 对 bot 来源消息不响应（src/bot.py 的 message.author.bot 分支），所以这条
# 消息不会触发任何 LLM，不违反硬规矩 1：开轮动作（三桶扫描 / weekly_run）仍全部人触发。
# cron（root，ros 是 UTC；20:00 UTC = 次日 09:00 NZDT / 08:00 NZST）：
#   0 20 14 * * /bin/bash .../round_remind.sh
#   0 20 28-31 * * [ "$(date -u -d tomorrow +\%d)" = "01" ] && /bin/bash .../round_remind.sh
set -u
ENVF="${CLAUDE_BOT_ENV:-/data/claude-bot/.env}"
TOKEN=$(grep '^DISCORD_TOKEN_AIRA=' "$ENVF" 2>/dev/null | cut -d= -f2-)
[ -z "$TOKEN" ] && { echo "$(date -u +%FT%TZ) 缺 DISCORD_TOKEN_AIRA（$ENVF）"; exit 2; }
FALLBACK_CHANNEL="${ROUND_REMIND_CHANNEL:-1478576726802956359}"
MENTION="${ROUND_REMIND_MENTION:-962284688309878785}"
API="https://discord.com/api/v10"
NZDAY=$(TZ=Pacific/Auckland date +%-d)

post() { # $1=频道 id  $2=1 则带 @（群里要 @，私信不用）
  local body
  body=$(python3 - "$NZDAY" "$MENTION" "$2" "${ROUND_REMIND_NOTE:-}" <<'EOF'
import json, sys
day, mention, at, note = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
msg = (note + ("<@" + mention + "> " if at == "1" else "")
       + "半月轮开轮提醒（NZ " + day + " 号轮，paid 客户优先）。"
       "pull_sweep 已在凌晨排队取数。开轮三步：fleet_digest 三桶扫描，"
       "weekly_run 批跑 harness，收尾 digest 加放行卡清单。到 MA 线程说一句开跑我就跑。")
print(json.dumps({"content": msg}, ensure_ascii=False))
EOF
)
  curl -s -m 30 -X POST -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" \
    "$API/channels/$1/messages" -d "$body"
}

DM=$(curl -s -m 30 -X POST -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" \
  "$API/users/@me/channels" -d "{\"recipient_id\":\"$MENTION\"}" \
  | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("id") or "")
except Exception: print("")')
OUT=""
[ -n "$DM" ] && OUT=$(post "$DM" 0)
if echo "$OUT" | grep -q '"id"'; then
  echo "$(date -u +%FT%TZ) 提醒已发私信（NZ ${NZDAY} 号轮）"
  exit 0
fi
echo "$(date -u +%FT%TZ) 私信发送失败，退回频道：${OUT:-开不了私信频道}"
OUT=$(post "$FALLBACK_CHANNEL" 1)
if echo "$OUT" | grep -q '"id"'; then
  echo "$(date -u +%FT%TZ) 提醒已发频道（NZ ${NZDAY} 号轮）"
else
  echo "$(date -u +%FT%TZ) 发送失败：$OUT"
  exit 1
fi
