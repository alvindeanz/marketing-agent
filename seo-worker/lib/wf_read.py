#!/usr/bin/env python3
"""WebForger 后台只读取数器（/api/doc §24 分析接口），chat 工具带用。零 LLM。
用法（在客户工作区目录下跑，凭据自动读 ./.secrets.env 的 WF_*）:
  wf_read.py leads [status=inbox] [k=v ...]     询盘线索列表（meta 带 gclid/gbraid/wbraid）
  wf_read.py funnel [days=30]                   站内漏斗 visits→engaged→form_start→lead
  wf_read.py overview [range=28d] [tzMode=store] 访问概览
  wf_read.py get <path>                          任意 GET，路径限只读白名单
可用 --workspace <dir> 指定工作区。只许 GET，白名单外路径一律拒。
时钟口径：funnel 恒 UTC，leads UTC，overview 默认 UTC（tzMode=store 转店铺时区），报数时说明。
对外询盘数以本后台口径为准，广告归因看每条 meta 里的 gclid/gbraid。"""
import json
import os
import sys
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
# 只读白名单：§24 分析面。写端点一个都不进来。
READ_PREFIXES = ("/api/stats/", "/api/leads/list", "/api/ads-feedback/status")


def load_env(ws):
    p = os.path.join(ws, ".secrets.env")
    if not os.path.isfile(p):
        print("工作区没有 .secrets.env（不是 WebForger 客户或凭据未落位）: " + p, file=sys.stderr)
        sys.exit(2)
    env = {}
    with open(p) as f:
        for line in f:
            line = line.strip()
            if line.startswith("export "):
                line = line[7:]
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")
    for k in ("WF_API", "WF_SITE_ID", "WF_BOT_EMAIL", "WF_BOT_PASSWORD"):
        if not env.get(k):
            print(".secrets.env 缺 " + k + "，这个客户的 WF 凭据不全", file=sys.stderr)
            sys.exit(2)
    return env


def req(url, token=None, payload=None):
    headers = {"User-Agent": UA, "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:300]
        print("HTTP " + str(e.code) + " " + url.split("?")[0] + " :: " + body, file=sys.stderr)
        sys.exit(1)


def main():
    args = sys.argv[1:]
    ws = os.getcwd()
    if "--workspace" in args:
        i = args.index("--workspace")
        ws = args[i + 1]
        del args[i : i + 2]
    if not args:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, rest = args[0], args[1:]
    env = load_env(ws)
    api, site = env["WF_API"].rstrip("/"), env["WF_SITE_ID"]

    kv = dict(a.split("=", 1) for a in rest if "=" in a)
    if cmd == "leads":
        path = "/api/leads/list"
        kv.setdefault("status", "inbox")
    elif cmd == "funnel":
        path = "/api/stats/" + site + "/funnel"
        kv.setdefault("days", "30")
    elif cmd == "overview":
        path = "/api/stats/overview"
        kv.setdefault("range", "28d")
    elif cmd == "get":
        if not rest:
            print("get 需要一个路径参数", file=sys.stderr)
            return 2
        path = rest[0].split("?")[0]
        q = rest[0].split("?", 1)
        kv = dict(urllib.parse.parse_qsl(q[1])) if len(q) > 1 else {}
    else:
        print("未知命令 " + cmd + "，可用: leads / funnel / overview / get", file=sys.stderr)
        return 2
    if not path.startswith(READ_PREFIXES):
        print("路径不在只读白名单内，拒绝: " + path, file=sys.stderr)
        return 2

    login = req(api + "/api/auth/login", payload={"email": env["WF_BOT_EMAIL"], "password": env["WF_BOT_PASSWORD"]})
    token = login.get("token")
    if not token:
        print("WF 登录失败: " + json.dumps(login, ensure_ascii=False)[:200], file=sys.stderr)
        return 1
    url = api + path + ("?" + urllib.parse.urlencode(kv) if kv else "")
    out = req(url, token=token)
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
