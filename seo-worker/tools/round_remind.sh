#!/bin/bash
# round_remind.sh — 半月轮开轮提醒（零 LLM，2026-10-14 Alvin 批）。每月 1 号与 15 号的
# NZ 早上由 cron 触发，用 Aira 的 bot token 往 Discord #horntech 发一条纯文本提醒。
# claude-bot 对 bot 来源消息不响应（src/bot.py 的 message.author.bot 分支），所以这条
# 消息不会触发任何 LLM，不违反硬规矩 1：开轮动作（三桶扫描 / weekly_run）仍全部人触发。
# cron（root，ros 是 UTC；20:00 UTC = 次日 09:00 NZDT / 08:00 NZST）：
#   0 20 14 * * /bin/bash .../round_remind.sh
#   0 20 28-31 * * [ "$(date -u -d tomorrow +\%d)" = "01" ] && /bin/bash .../round_remind.sh
set -u
ENVF="${CLAUDE_BOT_ENV:-/data/claude-bot/.env}"
TOKEN=$(grep '^DISCORD_TOKEN_AIRA=' "$ENVF" 2>/dev/null | cut -d= -f2-)
[ -z "$TOKEN" ] && { echo "$(date -u +%FT%TZ) 缺 DISCORD_TOKEN_AIRA（$ENVF）"; exit 2; }
CHANNEL="${ROUND_REMIND_CHANNEL:-1478576726802956359}"
MENTION="${ROUND_REMIND_MENTION:-962284688309878785}"

NZDAY=$(TZ=Pacific/Auckland date +%-d)
BODY=$(python3 - "$NZDAY" "$MENTION" <<'EOF'
import json, sys
day, mention = sys.argv[1], sys.argv[2]
msg = ("<@" + mention + "> 半月轮开轮提醒（NZ " + day + " 号轮，paid 客户优先）。"
       "pull_sweep 已在凌晨排队取数。开轮三步：fleet_digest 三桶扫描，"
       "weekly_run 批跑 harness，收尾 digest 加放行卡清单。一句话我就开跑。")
print(json.dumps({"content": msg}, ensure_ascii=False))
EOF
)
OUT=$(curl -s -m 30 -X POST \
  -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" \
  "https://discord.com/api/v10/channels/$CHANNEL/messages" -d "$BODY")
if echo "$OUT" | grep -q '"id"'; then
  echo "$(date -u +%FT%TZ) 提醒已发（NZ ${NZDAY} 号轮）"
else
  echo "$(date -u +%FT%TZ) 发送失败：$OUT"
  exit 1
fi
