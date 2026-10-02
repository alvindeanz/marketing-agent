#!/usr/bin/env python3
"""GA4 Data API 只读查询器，chat 工具带与取数脚本共用。零 LLM。
用法: ga4_query.py <property_id> <report_json|->   （参数为 - 时从 stdin 读 json）
report_json 两种写法，可混用：
  便捷式: {"dimensions":["sessionSourceMedium"],"metrics":["sessions","keyEvents"],
           "start":"2026-09-01","end":"2026-09-30","limit":1000}
  原生式: 直接给 Data API runReport 请求体字段（snake_case，如 dimension_filter、order_bys），
          便捷键会被归一化后合并，property 由本脚本填。
输出: 每行一个 JSON 对象（维度名与指标名作键），行数上限受 limit 约束（默认 1000）。
凭据: 服务账号 GA4_SA_FILE，默认 /data/aira/seo-worker/secrets/ga4_sa.json。
只能读: Data API 本身无写能力，这里也只调 run_report。"""
import json
import os
import sys

SA_FILE = os.environ.get("GA4_SA_FILE", "/data/aira/seo-worker/secrets/ga4_sa.json")
DEFAULT_LIMIT = 1000


def normalize(spec):
    """便捷键归一化成 RunReportRequest 字段。"""
    out = dict(spec)
    dims = out.pop("dimensions", [])
    mets = out.pop("metrics", [])
    out["dimensions"] = [{"name": d} if isinstance(d, str) else d for d in dims]
    out["metrics"] = [{"name": m} if isinstance(m, str) else m for m in mets]
    start = out.pop("start", None)
    end = out.pop("end", None)
    if start or end:
        out["date_ranges"] = [{"start_date": start or end, "end_date": end or start}]
    if not out.get("date_ranges"):
        print("report_json 缺日期：给 start/end 或 date_ranges", file=sys.stderr)
        sys.exit(2)
    if not out.get("limit"):
        out["limit"] = DEFAULT_LIMIT
    return out


def main():
    if len(sys.argv) < 3:
        print("usage: ga4_query.py <property_id> <report_json|->", file=sys.stderr)
        return 2
    prop = sys.argv[1].replace("properties/", "").strip()
    if not prop.isdigit():
        print("property_id 必须是纯数字（简报 profile 的 GA4 property）", file=sys.stderr)
        return 2
    raw = sys.stdin.read() if sys.argv[2] == "-" else sys.argv[2]
    try:
        spec = json.loads(raw)
    except Exception as e:
        print("report_json 不是合法 JSON: " + str(e), file=sys.stderr)
        return 2

    import warnings
    warnings.filterwarnings("ignore")
    from google.analytics.data_v1beta import BetaAnalyticsDataClient
    from google.analytics.data_v1beta.types import RunReportRequest
    from google.oauth2 import service_account

    creds = service_account.Credentials.from_service_account_file(
        SA_FILE, scopes=["https://www.googleapis.com/auth/analytics.readonly"]
    )
    client = BetaAnalyticsDataClient(credentials=creds)
    req_dict = normalize(spec)
    req_dict["property"] = "properties/" + prop
    resp = client.run_report(RunReportRequest(req_dict))

    dim_names = [h.name for h in resp.dimension_headers]
    met_names = [h.name for h in resp.metric_headers]
    for row in resp.rows:
        out = {}
        for n, v in zip(dim_names, row.dimension_values):
            out[n] = v.value
        for n, v in zip(met_names, row.metric_values):
            out[n] = v.value
        print(json.dumps(out, ensure_ascii=False))
    print("row_count=" + str(resp.row_count), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
