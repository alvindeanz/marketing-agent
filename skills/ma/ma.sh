#!/bin/bash
# ma.sh — MA (Always Agent) 看板只读查询 + 反馈回流，给 agent 线程用。
# 认证：MA_TOKEN 环境变量，或 /data/aira/.secrets/ma_skill.jwt（600）。
# 边界：本脚本只封装 auth_user 级端点（读 + 反馈）。批准/放行/改判是 admin 端点，
#       服务端会拒绝，也不要试。维护人 aira，改动走 marketing-agent 仓 + COLLAB 登记。
set -euo pipefail
API="${MA_API:-https://always.horntech-dev.com/seo-api.php}"
TOKEN="${MA_TOKEN:-}"
[ -z "$TOKEN" ] && [ -f /data/aira/.secrets/ma_skill.jwt ] && TOKEN=$(cat /data/aira/.secrets/ma_skill.jwt)
if [ -z "$TOKEN" ]; then
  echo "没有 token：设 MA_TOKEN 或把 JWT 放 /data/aira/.secrets/ma_skill.jwt（找 aira/Alvin 开）" >&2; exit 2
fi
req(){ local m="$1" p="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sf -X "$m" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$body" "$API$p"
  else
    curl -sf -X "$m" -H "Authorization: Bearer $TOKEN" "$API$p"
  fi
}
py(){ python3 -c "$1"; }
resolve(){ # 客户名或 id -> id（唯一命中才通过）
  case "$1" in (''|*[!0-9]*) ;; (*) echo "$1"; return;; esac
  req GET /clients | QUERY="$1" py '
import json,sys,os
q=os.environ["QUERY"].lower()
rows=json.load(sys.stdin); rows=rows.get("clients") or rows
hit=[c for c in rows if q in str(c.get("name","")).lower() or q in str(c.get("domain","")).lower()]
if len(hit)==1: print(hit[0].get("client_id") or hit[0].get("id"))
else:
    print("client 匹配到 %d 个: %s" % (len(hit), ", ".join("%s(%s)"%(c["name"],c.get("client_id") or c.get("id")) for c in hit[:8])), file=sys.stderr); sys.exit(3)
'
}
cmd="${1:-help}"; shift || true
case "$cmd" in
clients)
  req GET /clients | py '
import json,sys
rows=json.load(sys.stdin); rows=rows.get("clients") or rows
for c in rows: print("%s\t%s\t%s\t%s" % (c.get("client_id") or c.get("id"),c.get("name"),c.get("domain",""),c.get("status") or c.get("archived","")))'
  ;;
context) # 一个客户的干活上下文：档案 + 活跃方案头 + confirmed facts + 开放任务
  cid=$(resolve "${1:?用法: ma.sh context <客户名或id>}")
  { req GET "/profile?client_id=$cid"; echo; req GET "/facts?client_id=$cid"; echo; req GET "/tasks?client_id=$cid"; } | py '
import json,sys
prof,facts,tasks=[json.loads(l) for l in sys.stdin.read().strip().split("\n")]
p=prof.get("profile") or prof
print("== profile =="); [print(" %s: %s"%(k,str(v)[:200])) for k,v in p.items() if v not in (None,"",[]) and k not in ("id",)]
fs=facts.get("facts") or facts
print("== facts（unconfirmed 的别当定论用）==")
for f in fs: print(" [%s|%s] %s = %s"%(f.get("source"),f.get("status"),f.get("fact_key"),str(f.get("value"))[:180]))
ts=tasks.get("tasks") or tasks
print("== open tasks ==")
for t in ts:
    if t.get("status") in ("done","accepted","dropped","closed"): continue
    print(" #%s [%s/%s] %s %s | %s"%(t["id"],t.get("status"),t.get("human_state",""),t.get("sprint",""),t.get("priority",""),str(t.get("title"))[:80]))'
  ;;
tasks)
  cid=$(resolve "${1:?用法: ma.sh tasks <客户>}")
  req GET "/tasks?client_id=$cid" | py '
import json,sys
ts=json.load(sys.stdin); ts=ts.get("tasks") or ts
for t in ts: print("#%s\t%s\t%s\t%s\t%s"%(t["id"],t.get("status"),t.get("human_state",""),t.get("sprint",""),str(t.get("title"))[:90]))'
  ;;
task)
  cid=$(resolve "${1:?用法: ma.sh task <客户> <任务id>}"); tid="${2:?任务id}"
  req GET "/tasks?client_id=$cid" | TID="$tid" py '
import json,sys,os
ts=json.load(sys.stdin); ts=ts.get("tasks") or ts
t=[x for x in ts if str(x["id"])==os.environ["TID"]]
if not t: print("该客户下没有这个任务", file=sys.stderr); sys.exit(3)
t=t[0]
for k in ("id","title","status","human_state","wait_reason","sprint","priority","module","ops","detail","review_verdict","review_reason","review_adjust","result_note"):
    v=t.get(k)
    if v not in (None,""): print("%s:\n  %s\n"%(k,str(v)[:3000]))'
  ;;
facts)
  cid=$(resolve "${1:?用法: ma.sh facts <客户> [关键词]}"); pat="${2:-}"
  req GET "/facts?client_id=$cid" | PAT="$pat" py '
import json,sys,os
fs=json.load(sys.stdin); fs=fs.get("facts") or fs
p=os.environ["PAT"].lower()
for f in fs:
    line="[%s|%s] %s = %s"%(f.get("source"),f.get("status"),f.get("fact_key"),str(f.get("value"))[:300])
    if not p or p in line.lower(): print(line)'
  ;;
plan)
  cid=$(resolve "${1:?用法: ma.sh plan <客户>}")
  pid=$(req GET "/plans?client_id=$cid" | py '
import json,sys
ps=json.load(sys.stdin); ps=ps.get("plans") or ps
act=[p for p in ps if p.get("status")=="active"] or ps[-1:]
print(act[-1]["id"] if act else "")')
  [ -z "$pid" ] && { echo "无方案" >&2; exit 3; }
  req GET "/plans/$pid" | py '
import json,sys
p=json.load(sys.stdin); p=p.get("plan") or p
print("plan #%s v%s [%s]\n"%(p["id"],p.get("version"),p.get("status"))); print(p.get("body",""))'
  ;;
queue)
  req GET /jobs/queue | py '
import json,sys
q=json.load(sys.stdin)
for j in q.get("running",[]): print("running #%s %s cid=%s task=%s %ss"%(j["id"],j["type"],j["client_id"],j.get("task_id"),j.get("elapsed_sec")))
for j in q.get("queued",[]): print("queued  #%s %s cid=%s task=%s pos=%s"%(j["id"],j["type"],j["client_id"],j.get("task_id"),j.get("position")))
if not q.get("running") and not q.get("queued"): print("队列空")'
  ;;
chat) # 向 MA 提问（会触发一次看板 opus 会话，答案带该客户全部台账上下文）
  cid=$(resolve "${1:?用法: ma.sh chat <客户> <一句话>}"); shift; text="$*"
  [ -z "$text" ] && { echo "说点什么" >&2; exit 2; }
  BODY=$(CID="$cid" TEXT="$text" py 'import json,os;print(json.dumps({"client_id":int(os.environ["CID"]),"text":os.environ["TEXT"]}))')
  req POST /inbox/chat "$BODY" | py '
import json,sys
r=json.load(sys.stdin)
print("已开会话 root_id=%s job=%s，稍后用 ma.sh chat-read %s 取回复"%(r.get("root_id"),r.get("job_id"),r.get("root_id")))'
  ;;
chat-read)
  rid="${1:?用法: ma.sh chat-read <root_id>}"
  req GET "/inbox/$rid" | py '
import json,sys
r=json.load(sys.stdin)
for m in (r.get("messages") or r.get("thread") or []):
    print("[%s] %s"%(m.get("kind",m.get("role","")),str(m.get("body",""))[:2000]))'
  ;;
task-feedback) # 把一线观察写回某个任务（走 feedback 抽取管线，落 unconfirmed facts）
  cid=$(resolve "${1:?用法: ma.sh task-feedback <客户> <任务id> <正文>}"); tid="${2:?任务id}"; shift 2; text="$*"
  [ -z "$text" ] && { echo "写点内容" >&2; exit 2; }
  BODY=$(TEXT="$text" py 'import json,os;print(json.dumps({"text":os.environ["TEXT"]}))')
  req POST "/tasks/$tid/feedback" "$BODY" | py 'import json,sys;r=json.load(sys.stdin);print("已提交 job=%s"%r.get("job_id"))'
  ;;
*)
  cat <<'EOF'
用法: ma.sh <verb> ...
  clients                         全部客户 (id/name/domain)
  context <客户>                  干活前拉全上下文: 档案+facts+开放任务
  tasks <客户> | task <客户> <id> 任务列表 / 单任务全文
  facts <客户> [关键词]           事实台账 (注意 unconfirmed 标记)
  plan <客户>                     活跃 90 天方案全文
  queue                           worker 队列
  chat <客户> <问题>              问 MA (触发一次看板会话, chat-read 取回复)
  task-feedback <客户> <任务id> <正文>  一线观察回流 (落 unconfirmed facts)
客户可用名字模糊匹配, 唯一命中才执行。token 见脚本头注释。
EOF
  ;;
esac
