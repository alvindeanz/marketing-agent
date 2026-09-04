#!/usr/bin/env bash
# SEO agent 系统部署脚本。用法：
#   ./deploy.sh check    只读：显示本地与线上（ros worker + 250 看板）的漂移和线上版本
#   ./deploy.sh worker   部署 seo-worker 到 ros：备份 -> 同步白名单 -> 语法/加载校验 -> 哈希比对 -> 重启 -> 失败自动回滚
#   ./deploy.sh api      部署 seo-api.php + seo-agent.html 到 250：先传 /tmp 远端 php -l 过了才落位
# 凭据从同目录 .deploy-env 读取（gitignored），需要 ROS_PASS 与 BT_PASS 两个变量。
set -euo pipefail
cd "$(dirname "$0")"

ROS="alvin@192.168.10.205";        ROS_DIR="/data/aira/seo-worker"
BT="clawagent@192.168.10.250";     BT_DIR="/www/wwwroot/always"
WORKER_SRC="seo-worker"
# worker 同步白名单：只有这些进 ros，config.json/secrets/workspace 永不触碰
WHITELIST=(listener.js runner_host.js lib runners specs)

[ -f .deploy-env ] || { echo "缺 .deploy-env（含 ROS_PASS/BT_PASS），拒绝继续"; exit 1; }
source .deploy-env
SSH_BT=(sshpass -p "$BT_PASS" ssh -o StrictHostKeyChecking=no "$BT")

# ros 侧三个动作。脚本在 ros 本机以 root 跑时（$ROS_DIR 就在本地）不走 ssh，直接本地执行；
# 2026-08-29 起 .deploy-env 里的 ROS_PASS 已失效，本机模式是主路径，ssh 模式留给从别的机器部署。
if [ -d "$ROS_DIR" ] && [ "$(id -u)" = "0" ]; then ROS_LOCAL=1; else ROS_LOCAL=0; fi
ros_sh(){   # ros_sh "<shell>"，stdin 透传
  if [ "$ROS_LOCAL" = 1 ]; then bash -c "$1"; else sshpass -p "$ROS_PASS" ssh -o StrictHostKeyChecking=no "$ROS" "$1"; fi
}
ros_sudo(){ # 需要 root 的命令
  if [ "$ROS_LOCAL" = 1 ]; then bash -c "$1"; else sshpass -p "$ROS_PASS" ssh -o StrictHostKeyChecking=no "$ROS" "printf '%s\n' \"\$ROS_PASS\" | sudo -S $1"; fi
}
ros_rsync(){ # ros_rsync <rsync flags...> <src>；目标固定 $ROS_DIR/
  if [ "$ROS_LOCAL" = 1 ]; then rsync "$@" "$ROS_DIR/"; else sshpass -p "$ROS_PASS" rsync -e "ssh -o StrictHostKeyChecking=no" "$@" "$ROS:$ROS_DIR/"; fi
}

rev(){ git rev-parse --short HEAD 2>/dev/null || echo "no-git"; }
dirty(){ [ -n "$(git status --porcelain seo-worker seo-api.php static/seo-agent.html sql 2>/dev/null)" ]; }

warn_dirty(){
  if dirty; then
    echo "警告：SEO 相关文件有未 commit 改动，线上将无法用 git rev 追溯这次部署。建议先 commit。"
    git status --short seo-worker seo-api.php static/seo-agent.html sql | sed 's/^/    /'
  fi
}

manifest_local(){ # 本地白名单文件 md5 清单（BSD md5 -r 输出转 GNU 格式）
  ( cd "$WORKER_SRC" && find "${WHITELIST[@]}" -type f 2>/dev/null | sort | while read -r f; do
      md5 -r "$f" 2>/dev/null || md5sum "$f"; done ) | awk '{print $1"  "$2}'
}

case "${1:-}" in
check)
  echo "== 本地版本: $(rev) =="; warn_dirty
  echo "== ros worker 线上版本（$([ "$ROS_LOCAL" = 1 ] && echo 本机 || echo ssh)） =="
  ros_sh "cat $ROS_DIR/DEPLOYED 2>/dev/null || echo '（无 DEPLOYED 记录，脚本上线前的部署）'"
  echo "== ros worker 漂移（rsync -c 空跑，无输出即一致） =="
  for item in "${WHITELIST[@]}"; do
    ros_rsync -rcin --delete "$WORKER_SRC/$item" | sed 's/^/    /' || true
  done
  echo "== 250 看板线上版本 =="
  "${SSH_BT[@]}" "cat $BT_DIR/DEPLOYED-seo 2>/dev/null || echo '（无 DEPLOYED-seo 记录）'"
  echo "== 250 看板漂移 =="
  for f in seo-api.php static/seo-agent.html; do
    L=$(md5 -q "$f" 2>/dev/null || md5sum "$f" | cut -d' ' -f1)
    R=$("${SSH_BT[@]}" "md5sum $BT_DIR/$(basename "$f") 2>/dev/null | cut -d' ' -f1")
    [ "$L" = "$R" ] && echo "    $(basename "$f") 一致" || echo "    $(basename "$f") 不一致 local=$L remote=$R"
  done
  ;;

worker)
  warn_dirty
  # 0. drain 检查：有 runner_host 在跑就拒绝重启（FORCE_DEPLOY=1 越过）。重启会
  #    杀掉跑到一半的 job（2026-09-04 job390 僵尸事故）；被杀的 job 下次启动会被
  #    收尸判 failed 不再留僵尸，但白烧的模型钱回不来，能等就等。
  RUNNING_JOBS=$(ros_sh "pgrep -af 'runner_host.js' || true")
  if [ -n "$RUNNING_JOBS" ] && [ "${FORCE_DEPLOY:-0}" != "1" ]; then
    echo "拒绝部署：worker 有 job 在跑。等它跑完再发，或 FORCE_DEPLOY=1 强发（会杀掉这些）："
    echo "$RUNNING_JOBS" | sed 's/^/    /'
    exit 1
  fi
  TS=$(date +%Y%m%d-%H%M%S); BAK="$ROS_DIR/.bak-deploy-$TS"
  echo "[1/6] ros 侧备份到 $BAK"
  ros_sh "cd $ROS_DIR && mkdir -p $BAK && cp -r ${WHITELIST[*]} $BAK/"
  echo "[2/6] rsync 同步白名单（校验和模式）"
  for item in "${WHITELIST[@]}"; do ros_rsync -rc --delete "$WORKER_SRC/$item"; done
  echo "[3/6] 双端哈希清单比对"
  manifest_local > /tmp/seo-worker.manifest
  ros_sh "cd $ROS_DIR && md5sum -c --quiet -" < /tmp/seo-worker.manifest \
    && echo "    全部一致" || { echo "哈希比对失败，回滚"; ros_sh "cd $ROS_DIR && cp -r $BAK/* . "; exit 1; }
  echo "[4/6] 语法与加载校验"
  # 注意：runner_host.js 顶层直接调 main()，require 它会真执行，只做 node --check；runners/*.js 与 lib 可安全 require
  if ! ros_sh "cd $ROS_DIR && for f in \$(find ${WHITELIST[*]} -name '*.js'); do node --check \$f || exit 1; done \
      && for r in runners/*.js lib/*.js; do node -e \"require('$ROS_DIR/'+process.argv[1])\" \$r || exit 1; done"; then
    echo "校验失败，回滚并恢复服务"
    ros_sh "cd $ROS_DIR && cp -r $BAK/* ."; ros_sudo "systemctl restart seo-worker"
    exit 1
  fi
  echo "[5/6] 重启 seo-worker"
  ros_sudo "systemctl restart seo-worker && sleep 2 && systemctl is-active seo-worker" \
    || { echo "重启后不 active，回滚"; ros_sh "cd $ROS_DIR && cp -r $BAK/* ."; ros_sudo "systemctl restart seo-worker"; exit 1; }
  echo "[6/6] 写 DEPLOYED 记录，清理 30 天前旧备份"
  ros_sh "printf 'rev %s\ndate %s\nmanifest_md5 %s\n' '$(rev)' '$TS' '$(md5 -q /tmp/seo-worker.manifest 2>/dev/null || md5sum /tmp/seo-worker.manifest | cut -d' ' -f1)' > $ROS_DIR/DEPLOYED; find $ROS_DIR -maxdepth 1 -name '.bak-deploy-*' -mtime +30 -exec rm -rf {} +"
  echo "worker 部署完成：rev $(rev)"
  ;;

api)
  warn_dirty
  TS=$(date +%Y%m%d-%H%M%S)
  echo "[1/3] 上传到 250:/tmp 并远端 php -l"
  sshpass -p "$BT_PASS" scp -o StrictHostKeyChecking=no seo-api.php "$BT:/tmp/seo-api.php.new"
  sshpass -p "$BT_PASS" scp -o StrictHostKeyChecking=no static/seo-agent.html "$BT:/tmp/seo-agent.html.new"
  sshpass -p "$BT_PASS" scp -o StrictHostKeyChecking=no seo-worker/specs/release_policy.json "$BT:/tmp/release_policy.json.new"
  "${SSH_BT[@]}" "php -l /tmp/seo-api.php.new" || { echo "php -l 失败，线上未动"; exit 1; }
  echo "[2/3] 备份并落位"
  "${SSH_BT[@]}" "cp $BT_DIR/seo-api.php $BT_DIR/seo-api.php.bak-$TS && cp $BT_DIR/seo-agent.html $BT_DIR/seo-agent.html.bak-$TS \
    && mv /tmp/seo-api.php.new $BT_DIR/seo-api.php && mv /tmp/seo-agent.html.new $BT_DIR/seo-agent.html && mv /tmp/release_policy.json.new $BT_DIR/release_policy.json"
  echo "[3/3] 哈希比对 + DEPLOYED 记录"
  for f in seo-api.php static/seo-agent.html; do
    L=$(md5 -q "$f" 2>/dev/null || md5sum "$f" | cut -d' ' -f1)
    R=$("${SSH_BT[@]}" "md5sum $BT_DIR/$(basename "$f") | cut -d' ' -f1")
    [ "$L" = "$R" ] || { echo "$(basename "$f") 哈希不一致，检查！"; exit 1; }
  done
  "${SSH_BT[@]}" "printf 'rev %s\ndate %s\n' '$(rev)' '$TS' > $BT_DIR/DEPLOYED-seo; find $BT_DIR -maxdepth 1 -name '*.bak-*' -mtime +30 -delete"
  echo "api 部署完成：rev $(rev)（PHP 即时生效，无需重启）"
  ;;

*) echo "用法: ./deploy.sh check|worker|api"; exit 1;;
esac
