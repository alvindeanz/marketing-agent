#!/usr/bin/env python3
"""GAQL 只读查询器，googleads.js 的子进程。零 LLM。
用法: gaql_query.py <customer_id> <GAQL>   （stdin 也可传 GAQL，参数为 - 时）
输出: 每行一个 JSON 对象（search_stream 的行，字段扁平化：a.b.c -> a_b_c）。
凭据: /data/aira/.env.google-ads（MCC master，login-customer-id 恒为 MCC）。
只许 SELECT：这里是拉数通道，任何 mutate 走 apply adapter 的白名单，不走这。"""
import json
import os
import sys

ENV_FILE = "/data/aira/.env.google-ads"

def load_env():
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k, v)

def flatten(obj, prefix, out):
    for k, v in obj.items():
        key = (prefix + "_" + k) if prefix else k
        if isinstance(v, dict):
            flatten(v, key, out)
        else:
            out[key] = v

def main():
    if len(sys.argv) < 3:
        print("usage: gaql_query.py <customer_id> <GAQL|->", file=sys.stderr)
        return 2
    customer_id = sys.argv[1].replace("-", "")
    query = sys.stdin.read() if sys.argv[2] == "-" else sys.argv[2]
    if not query.strip().lower().startswith("select"):
        print("only SELECT is allowed here", file=sys.stderr)
        return 2

    load_env()
    import warnings
    warnings.filterwarnings("ignore")
    from google.ads.googleads.client import GoogleAdsClient
    from google.protobuf.json_format import MessageToDict

    cfg = {
        "developer_token": os.environ["GOOGLE_ADS_DEVELOPER_TOKEN"],
        "client_id": os.environ["GOOGLE_ADS_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_ADS_CLIENT_SECRET"],
        "refresh_token": os.environ["GOOGLE_ADS_REFRESH_TOKEN"],
        "login_customer_id": os.environ["GOOGLE_ADS_MCC_ID"].replace("-", ""),
        "use_proto_plus": True,
    }
    client = GoogleAdsClient.load_from_dict(cfg)
    svc = client.get_service("GoogleAdsService")
    for batch in svc.search_stream(customer_id=customer_id, query=query):
        for row in batch.results:
            d = MessageToDict(row._pb, preserving_proto_field_name=True)
            flat = {}
            flatten(d, "", flat)
            print(json.dumps(flat, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # 错误进 stderr，一行，让 node 侧能抓到原因
        print("GAQL_ERROR: " + str(e).replace("\n", " ")[:500], file=sys.stderr)
        sys.exit(1)
