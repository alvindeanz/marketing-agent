#!/usr/bin/env bash
# gym_trace_pull.sh — 把 Mac worker 本地的 trace 并回 NFS 单一账本（零 LLM，人触发，随 label_stats 跑）。
#
# 背景（2026-10-27 实测）：Mac 的 /data/aira 是本机盘不是 NFS 挂载（NFS 只挂了 clients/tools/scripts
# 三个子目录），所以 Mac worker 的 trace 落在它自己的 /data/aira/seo-worker/traces/，不在 ros 的账本里。
# 按硬规矩 8 这是合法的 worker 隔离态，账本聚合放读取侧：job 目录名含全局唯一的 job id，
# rsync 合并不会撞；golden 只在 NFS 一份，不从 Mac 拉；.last_prune 是各机自己的清扫标记，不混。
# Mac 不在线不算错（exit 0 带提示），下次跑 label_stats 时拉平即可。
set -euo pipefail
MAC="${GYM_MAC:-aira@192.168.10.215}"
KEY="${GYM_MAC_KEY:-/root/.ssh/aira_mac_deploy}"
SRC="/data/aira/seo-worker/traces/"
DST="${TRACES_DIR:-/data/aira/seo-worker/traces}/"

if ! ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "$MAC" true 2>/dev/null; then
  echo "[gym_trace_pull] mac worker 不在线或 ssh 不通，跳过（账本缺口下次拉平）"
  exit 0
fi
rsync -a --exclude 'golden/' --exclude '.last_prune' \
  -e "ssh -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
  "$MAC:$SRC" "$DST"
echo "[gym_trace_pull] mac traces 已并入 $DST"
