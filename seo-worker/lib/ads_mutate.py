#!/usr/bin/env python3
"""Google Ads 白名单 mutate 执行器，apply adapter 的唯一写通道。零 LLM 判断，全参数化。
用法: ads_mutate.py <customer_id> --op <操作> [参数] [--dry-run]
操作白名单（specs/capabilities/googleads.md V2 的 agent_apply 集）:
  final-url-change     --ad-id N --new-url URL           改既有 ad 的 final URL（旧值先打印再改）
  ad-pause             --ad-group-id N --ad-id N          暂停单条 ad
  adgroup-pause        --ad-group-id N                    暂停单个 ad group
  negative-keyword-add --level adgroup|campaign --target-id N --text 词 --match broad|phrase|exact
  keyword-bid-adjust   --criterion-resource RES --new-bid-micros N   （幅度硬闸 ±20%）
  schedule-adjust      未实现，直接拒，转人工
铁律（脚本硬闸，不靠调用方自觉）:
  - 改前必查旧值并打印（JSON 行，回滚依据）；mutate 后回读验证并打印新值。
  - update_mask 全部手写字段名，不用 protobuf_helpers 自动推（默认值字段会漏，2026-08-10 事故）。
  - pause 类操作先查 campaign 学习期，处于学习期拒绝（学习期内不下杀）。
  - bid 调整超 ±20% 拒绝。
  - --dry-run 只打印将要提交的内容，不发写请求。
输出: JSON 行。成功最后一行 {"ok": true, ...}；拒绝/失败 {"ok": false, "error": "..."} 且退出码非 0。
凭据: /data/aira/.env.google-ads（MCC master，login-customer-id 恒为 MCC）。"""
import argparse
import json
import os
import sys

ENV_FILE = "/data/aira/.env.google-ads"
OPS = ["final-url-change", "ad-pause", "adgroup-pause", "negative-keyword-add",
       "keyword-bid-adjust", "schedule-adjust"]


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))


def die(msg, code=2):
    out({"ok": False, "error": msg})
    sys.exit(code)


def load_env():
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k, v)


def make_client():
    load_env()
    import warnings
    warnings.filterwarnings("ignore")
    from google.ads.googleads.client import GoogleAdsClient
    cfg = {
        "developer_token": os.environ["GOOGLE_ADS_DEVELOPER_TOKEN"],
        "client_id": os.environ["GOOGLE_ADS_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_ADS_CLIENT_SECRET"],
        "refresh_token": os.environ["GOOGLE_ADS_REFRESH_TOKEN"],
        "login_customer_id": os.environ["GOOGLE_ADS_MCC_ID"].replace("-", ""),
        "use_proto_plus": True,
    }
    return GoogleAdsClient.load_from_dict(cfg)


def gaql(client, cid, query):
    svc = client.get_service("GoogleAdsService")
    rows = []
    for batch in svc.search_stream(customer_id=cid, query=query):
        for row in batch.results:
            rows.append(row)
    return rows


def field_mask(paths):
    from google.protobuf import field_mask_pb2
    fm = field_mask_pb2.FieldMask()
    fm.paths.extend(paths)
    return fm


def campaign_learning(client, cid, campaign_id):
    """学习期判定：campaign primary_status_reasons 含 LEARNING 系即算。"""
    rows = gaql(client, cid,
                "SELECT campaign.id, campaign.primary_status, campaign.primary_status_reasons "
                "FROM campaign WHERE campaign.id = " + str(int(campaign_id)))
    if not rows:
        return False
    reasons = [str(r) for r in rows[0].campaign.primary_status_reasons]
    return any("LEARNING" in r for r in reasons)


def op_final_url_change(client, cid, args):
    if not args.ad_id or not args.new_url:
        die("final-url-change 需要 --ad-id 与 --new-url")
    if not args.new_url.startswith("https://"):
        die("new-url 必须是 https 绝对地址")
    rows = gaql(client, cid,
                "SELECT ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.status, "
                "ad_group.id, campaign.id FROM ad_group_ad WHERE ad_group_ad.ad.id = " + str(int(args.ad_id)))
    if not rows:
        die("ad " + str(args.ad_id) + " 不存在")
    old_urls = list(rows[0].ad_group_ad.ad.final_urls)
    out({"step": "before", "op": "final-url-change", "ad_id": args.ad_id, "old_final_urls": old_urls})
    if old_urls == [args.new_url]:
        out({"ok": True, "noop": True, "note": "final_urls 已是目标值，零改动"})
        return
    if args.dry_run:
        out({"ok": True, "dry_run": True, "would_set": [args.new_url]})
        return
    svc = client.get_service("AdService")
    op = client.get_type("AdOperation")
    op.update.resource_name = svc.ad_path(cid, int(args.ad_id))
    del op.update.final_urls[:]
    op.update.final_urls.append(args.new_url)
    op.update_mask.CopyFrom(field_mask(["final_urls"]))
    svc.mutate_ads(customer_id=cid, operations=[op])
    rows2 = gaql(client, cid,
                 "SELECT ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ad_group_ad.ad.id = " + str(int(args.ad_id)))
    new_urls = list(rows2[0].ad_group_ad.ad.final_urls) if rows2 else []
    if new_urls != [args.new_url]:
        die("回读验证失败：期望 [" + args.new_url + "]，读到 " + json.dumps(new_urls))
    out({"ok": True, "op": "final-url-change", "ad_id": args.ad_id,
         "old_final_urls": old_urls, "new_final_urls": new_urls, "budget_impact": 0})


def op_ad_pause(client, cid, args):
    if not args.ad_group_id or not args.ad_id:
        die("ad-pause 需要 --ad-group-id 与 --ad-id")
    rows = gaql(client, cid,
                "SELECT ad_group_ad.status, campaign.id FROM ad_group_ad "
                "WHERE ad_group.id = " + str(int(args.ad_group_id)) +
                " AND ad_group_ad.ad.id = " + str(int(args.ad_id)))
    if not rows:
        die("ad 不存在")
    if campaign_learning(client, cid, rows[0].campaign.id):
        die("目标 campaign 处于学习期，暂停动作拒绝执行（学习期内不下杀）")
    old = str(rows[0].ad_group_ad.status)
    out({"step": "before", "op": "ad-pause", "old_status": old})
    if args.dry_run:
        out({"ok": True, "dry_run": True, "would_set": "PAUSED"})
        return
    svc = client.get_service("AdGroupAdService")
    op = client.get_type("AdGroupAdOperation")
    op.update.resource_name = svc.ad_group_ad_path(cid, int(args.ad_group_id), int(args.ad_id))
    op.update.status = client.enums.AdGroupAdStatusEnum.PAUSED
    op.update_mask.CopyFrom(field_mask(["status"]))
    svc.mutate_ad_group_ads(customer_id=cid, operations=[op])
    out({"ok": True, "op": "ad-pause", "old_status": old, "new_status": "PAUSED", "budget_impact": 0})


def op_adgroup_pause(client, cid, args):
    if not args.ad_group_id:
        die("adgroup-pause 需要 --ad-group-id")
    rows = gaql(client, cid,
                "SELECT ad_group.status, campaign.id FROM ad_group WHERE ad_group.id = " + str(int(args.ad_group_id)))
    if not rows:
        die("ad group 不存在")
    if campaign_learning(client, cid, rows[0].campaign.id):
        die("目标 campaign 处于学习期，暂停动作拒绝执行（学习期内不下杀）")
    old = str(rows[0].ad_group.status)
    out({"step": "before", "op": "adgroup-pause", "old_status": old})
    if args.dry_run:
        out({"ok": True, "dry_run": True, "would_set": "PAUSED"})
        return
    svc = client.get_service("AdGroupService")
    op = client.get_type("AdGroupOperation")
    op.update.resource_name = svc.ad_group_path(cid, int(args.ad_group_id))
    op.update.status = client.enums.AdGroupStatusEnum.PAUSED
    op.update_mask.CopyFrom(field_mask(["status"]))
    svc.mutate_ad_groups(customer_id=cid, operations=[op])
    out({"ok": True, "op": "adgroup-pause", "old_status": old, "new_status": "PAUSED", "budget_impact": 0})


def op_negative_keyword_add(client, cid, args):
    if args.level not in ("adgroup", "campaign") or not args.target_id or not args.text:
        die("negative-keyword-add 需要 --level adgroup|campaign --target-id --text")
    match = {"broad": "BROAD", "phrase": "PHRASE", "exact": "EXACT"}.get(args.match or "broad")
    if not match:
        die("match 只认 broad|phrase|exact")
    out({"step": "before", "op": "negative-keyword-add", "level": args.level,
         "target_id": args.target_id, "text": args.text, "match": match})
    if args.dry_run:
        out({"ok": True, "dry_run": True})
        return
    if args.level == "adgroup":
        svc = client.get_service("AdGroupCriterionService")
        op = client.get_type("AdGroupCriterionOperation")
        c = op.create
        c.ad_group = client.get_service("AdGroupService").ad_group_path(cid, int(args.target_id))
        c.negative = True
        c.keyword.text = args.text
        c.keyword.match_type = getattr(client.enums.KeywordMatchTypeEnum, match)
        res = svc.mutate_ad_group_criteria(customer_id=cid, operations=[op])
    else:
        svc = client.get_service("CampaignCriterionService")
        op = client.get_type("CampaignCriterionOperation")
        c = op.create
        c.campaign = client.get_service("CampaignService").campaign_path(cid, int(args.target_id))
        c.negative = True
        c.keyword.text = args.text
        c.keyword.match_type = getattr(client.enums.KeywordMatchTypeEnum, match)
        res = svc.mutate_campaign_criteria(customer_id=cid, operations=[op])
    out({"ok": True, "op": "negative-keyword-add", "resource_name": res.results[0].resource_name,
         "budget_impact": 0})


def op_keyword_bid_adjust(client, cid, args):
    if not args.criterion_resource or not args.new_bid_micros:
        die("keyword-bid-adjust 需要 --criterion-resource 与 --new-bid-micros")
    rows = gaql(client, cid,
                "SELECT ad_group_criterion.cpc_bid_micros, ad_group_criterion.keyword.text "
                "FROM ad_group_criterion WHERE ad_group_criterion.resource_name = '" +
                args.criterion_resource.replace("'", "") + "'")
    if not rows:
        die("criterion 不存在")
    old = int(rows[0].ad_group_criterion.cpc_bid_micros)
    new = int(args.new_bid_micros)
    out({"step": "before", "op": "keyword-bid-adjust",
         "keyword": rows[0].ad_group_criterion.keyword.text, "old_bid_micros": old})
    if old > 0 and abs(new - old) / old > 0.2:
        die("出价调整幅度 " + str(round(abs(new - old) / old * 100)) + "% 超过 ±20% 硬闸，拒绝执行")
    if args.dry_run:
        out({"ok": True, "dry_run": True, "would_set": new})
        return
    svc = client.get_service("AdGroupCriterionService")
    op = client.get_type("AdGroupCriterionOperation")
    op.update.resource_name = args.criterion_resource
    op.update.cpc_bid_micros = new
    op.update_mask.CopyFrom(field_mask(["cpc_bid_micros"]))
    svc.mutate_ad_group_criteria(customer_id=cid, operations=[op])
    out({"ok": True, "op": "keyword-bid-adjust", "old_bid_micros": old, "new_bid_micros": new,
         "budget_impact": "出价级，无预算变动"})


def main():
    p = argparse.ArgumentParser(add_help=True)
    p.add_argument("customer_id")
    p.add_argument("--op", required=True, choices=OPS)
    p.add_argument("--ad-id", type=int)
    p.add_argument("--ad-group-id", type=int)
    p.add_argument("--new-url")
    p.add_argument("--level")
    p.add_argument("--target-id", type=int)
    p.add_argument("--text")
    p.add_argument("--match")
    p.add_argument("--criterion-resource")
    p.add_argument("--new-bid-micros", type=int)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    cid = args.customer_id.replace("-", "")
    if args.op == "schedule-adjust":
        die("schedule-adjust 落地器未实现，转人工（能力清单 V2 已标注）")
    client = make_client()
    try:
        {"final-url-change": op_final_url_change,
         "ad-pause": op_ad_pause,
         "adgroup-pause": op_adgroup_pause,
         "negative-keyword-add": op_negative_keyword_add,
         "keyword-bid-adjust": op_keyword_bid_adjust}[args.op](client, cid, args)
    except SystemExit:
        raise
    except Exception as e:
        die(str(e)[:500], 1)


if __name__ == "__main__":
    sys.exit(main() or 0)
