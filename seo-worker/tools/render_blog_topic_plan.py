#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""博客选题规划渲染器（零 LLM，通用化自 sunseeker 2026-09-10 版）。
用法：python3 tools/render_blog_topic_plan.py <slug> <plan.json> [gaps.json]
plan.json 由选题任务（agent）产出，结构：
  {"title","h1","sub","intro","outro","footer","range_label","window_label","made_on",
   "months":[{"tag","title","desc"}],
   "topics":[{"month","type"(新写/改写),"zh","en","kw":[..],"why","season","nodup","links"}]}
gaps.json 缺省取 clients/<slug>/notes/ 下最新的 topic_gaps_*.json。
输出：clients/<slug>/reports/blog_topic_plan_<slug>_<range>.html（文件名带 slug，防跨客户同名混淆，2026-09-19 规范）。
"""
import io, json, html, sys, glob, os

CSS = """*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;background:#f6f7f9;padding:32px 24px}
.wrap{max-width:1120px;margin:0 auto}
header.hero{background:#fff;border:1px solid #e2e6ea;border-radius:12px;padding:28px 32px;margin-bottom:20px}
header.hero h1{font-size:22px;font-weight:700;color:#0d1117;margin-bottom:8px}
header.hero .sub{color:#6c757d;font-size:13.5px;line-height:1.7}
header.hero .meta{margin-top:14px;display:flex;gap:18px;flex-wrap:wrap;font-size:12.5px;color:#475569}
header.hero .meta b{color:#0d1117}
section.card{background:#fff;border:1px solid #e2e6ea;border-radius:12px;padding:22px 26px;margin-bottom:18px;scroll-margin-top:20px}
section.card h2{font-size:16px;font-weight:700;color:#0d1117;margin-bottom:6px;display:flex;align-items:center;gap:10px}
section.card h2 .num{display:inline-block;min-width:26px;height:26px;line-height:26px;text-align:center;background:#0d1117;color:#fff;font-size:12px;border-radius:6px;font-weight:600;padding:0 7px}
section.card .desc{color:#6c757d;font-size:13px;margin-bottom:14px}
.why{background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:10px 14px;font-size:13px;color:#7c2d12;margin:12px 0}
.why b{color:#7c2d12}
.ok{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:10px 14px;font-size:13px;color:#14532d;margin:12px 0}
.ok b{color:#14532d}
.info{background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:10px 14px;font-size:13px;color:#1e3a8a;margin:12px 0}
.info b{color:#1d4ed8}
.note{font-size:12.5px;color:#475569;margin-top:10px;padding-top:10px;border-top:1px dashed #e2e6ea}
.note b{color:#0d1117}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
th{background:#f1f5f9;color:#475569;font-weight:600;text-align:left;padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid #cbd5e1}
td{padding:9px 10px;border-bottom:1px solid #e2e6ea;vertical-align:top}
td.kw{font-family:"SF Mono",Menlo,monospace;font-size:12px;color:#0969da}
td.num{font-family:"SF Mono",Menlo,monospace;font-size:12px;white-space:nowrap}
.topic{border:1px solid #e2e6ea;border-radius:10px;padding:16px 18px;margin-bottom:14px;background:#fcfcfd}
.topic .hd{display:flex;align-items:flex-start;gap:12px;margin-bottom:8px;flex-wrap:wrap}
.topic .mon{background:#0d1117;color:#fff;font-size:11px;font-weight:700;border-radius:5px;padding:3px 9px;white-space:nowrap}
.topic .tag{font-size:11px;font-weight:700;border-radius:5px;padding:3px 9px;white-space:nowrap}
.tag.new{background:#dbeafe;color:#1d4ed8}
.tag.rewrite{background:#fef3c7;color:#92400e}
.topic .tt{font-size:14.5px;font-weight:700;color:#0d1117;flex:1;min-width:260px}
.topic .en{font-size:12.5px;color:#475569;font-style:normal;margin-bottom:10px}
.topic dl{display:grid;grid-template-columns:96px 1fr;gap:6px 12px;font-size:12.5px;margin-top:8px}
.topic dt{color:#94a3b8;font-weight:600}
.topic dd{color:#334155}
.topic dd code{background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:11.5px}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:#475569;margin-top:10px}
footer{text-align:center;color:#94a3b8;font-size:12px;padding:24px 0;margin-top:20px}
@media(max-width:720px){.topic dl{grid-template-columns:1fr}}"""

def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(2)
    slug, plan_path = sys.argv[1], sys.argv[2]
    base = f"/data/aira/clients/{slug}"
    cfg = json.load(open(plan_path))
    gaps_path = sys.argv[3] if len(sys.argv) > 3 else sorted(glob.glob(f"{base}/notes/topic_gaps_*.json"))[-1]
    GAPS = json.load(open(gaps_path))
    site_key = slug if slug in GAPS.get("sites", {}) else list(GAPS["sites"])[0]
    G = GAPS["sites"][site_key]

    need = ["title","h1","sub","months","topics","range_label","window_label","made_on"]
    miss = [k for k in need if k not in cfg]
    if miss: print("plan.json 缺字段:", miss); sys.exit(1)
    for t in cfg["topics"]:
        for k in ("month","type","zh","en","kw","why","season","nodup","links"):
            if k not in t: print("topic 缺字段", k, t.get("zh","?")); sys.exit(1)

    def kwrow(kw):
        v = G.get(kw)
        if not v or not v.get("impr"): return "全站零展现"
        return f"{v['impr']} 曝光 / {v['clicks']} 点击 / 排名 {v['pos']}"
    def owner(kw):
        v = G.get(kw)
        if not v or not v.get("owner"): return "无"
        o = v["owner"][0]
        return f"{o['p']}（排名 {o['pos']}）"
    def render_topic(t):
        rows = "".join(
            f"<tr><td class='kw'>{html.escape(k)}</td><td class='num'>{kwrow(k)}</td>"
            f"<td style='font-size:12px;color:#6b7280'>{owner(k)}</td></tr>" for k in t["kw"])
        tag = "new" if t["type"] == "新写" else "rewrite"
        return (f'<div class="topic"><div class="hd"><span class="mon">{t["month"]}</span>'
                f'<span class="tag {tag}">{t["type"]}</span><span class="tt">{t["zh"]}</span></div>'
                f'<div class="en">建议标题：{html.escape(t["en"])}</div>'
                f'<table><thead><tr><th style="width:38%">目标词</th><th style="width:30%">近窗全站表现</th><th>当前由谁承接</th></tr></thead>'
                f'<tbody>{rows}</tbody></table>'
                f'<dl><dt>为什么写</dt><dd>{t["why"]}</dd><dt>为什么现在</dt><dd>{t["season"]}</dd>'
                f'<dt>不重复</dt><dd>{t["nodup"]}</dd><dt>内链去向</dt><dd>{t["links"]}</dd></dl></div>')

    months = []
    for m in cfg["months"]:
        body = "".join(render_topic(t) for t in cfg["topics"] if t["month"] == m["tag"])
        months.append(f'<section class="card" id="m{m["tag"].replace("-","")}">'
                      f'<h2><span class="num">{m["tag"]}</span>{m["title"]}</h2>'
                      f'<div class="desc">{m["desc"]}</div>{body}</section>')
    n_new = sum(1 for t in cfg["topics"] if t["type"] == "新写")
    legend = cfg.get("legend", f'<span><span class="tag new">新写</span> 共 {len(cfg["topics"])} 篇，其中新写 {n_new} 篇</span>')
    doc = (f'<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
           f'<meta name="viewport" content="width=device-width,initial-scale=1">'
           f'<meta name="robots" content="noindex, nofollow">'
           f'<title>{cfg["title"]}</title><style>{CSS}</style></head><body><div class="wrap">'
           f'<header class="hero"><h1>{cfg["h1"]}</h1><div class="sub">{cfg["sub"]}</div>'
           f'<div class="meta"><span><b>周期</b> {cfg["range_label"]}</span>'
           f'<span><b>数据窗口</b> {cfg["window_label"]}</span>'
           f'<span><b>成稿</b> {cfg["made_on"]}</span></div>'
           f'<div class="legend">{legend}</div></header>'
           f'{cfg.get("intro","")}{"".join(months)}{cfg.get("outro","")}'
           f'<footer>{cfg.get("footer","")}</footer></div></body></html>')
    rng = cfg.get("range_slug") or cfg["range_label"].replace(" ", "")
    out = f"{base}/reports/blog_topic_plan_{slug}_{rng}.html"
    io.open(out, "w", encoding="utf-8").write(doc)
    print(out)

if __name__ == "__main__":
    main()
