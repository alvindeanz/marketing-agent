# Discover spec v1

Version: v2 (2026-08-13). v1 wrote English section anchors and confidence labels; v2 switches dossier anchors and labels to Chinese ([确认]/[推断]/[未知]). Dossiers stamped v1 predate that change.

This is your work instruction for a discovery run. The runner has already
collected the T1 material listed below and pasted it after this spec. Follow
this document exactly. The output of this run becomes the factual base for a 90
day plan, and a later plan run will cite your conclusions by their confidence
label, so a wrong label is worse than a missing conclusion.

## The only test that matters

A finding earns its place if it would change a decision in the 90 day plan.
Interesting but decision neutral material is a cost with no return. Leave it out.

The plan makes exactly six kinds of decision. Your dossier exists to inform them:

1. Which queries and pages to attack first, from demand, current rank, difficulty.
2. Build new content or improve what exists, from the keyword universe and the
   formats that win in this niche.
3. Whether link building is worth doing this quarter, from the authority gap
   against the sites that actually outrank this client.
4. Whether local SEO is worth doing, from local intent share and local rivals.
5. What not to do, with evidence.
6. Technical priority, from site structure and index coverage.

## Confidence labels, mandatory

The dossier is written in Chinese, so the labels are Chinese too. Every
conclusion carries exactly one label, in brackets, at the end of the sentence:

- `[确认]` the material in front of you states it directly. Quote the number.
- `[推断]` you reasoned to it from the material. Say from what, in the same
  sentence.
- `[未知]` you cannot tell from this material. Say what would settle it.

These three strings are machine anchors. Reproduce them exactly, do not
translate them back to English, do not invent a fourth label.

A sentence with no label is a defect. Never label something 确认 because it is
plausible, and never soften an 未知 into a 推断 to look complete.

## T1 material, already collected

- `competitors`: organic competitor list from the gate, with overlap counts.
- `rankings`: the client's own ranking keywords.
- `keyword-gap` against the top 2 or 3 real competitors, types `missing` and
  `untapped`.
- `domain-overview` per rival: authority score and referring domains, client versus
  competitors. May be absent, treat absence as an unknown, not as parity.
- Sitemap inventory: URL count, sections, depth distribution.
- Index gap approximation: sitemap URLs that never appear in Search Console page
  data. Search Console only lists pages that got impressions, so this is a
  signal about thin or unindexed pages, never proof of deindexing.
- Search Console and GA4 snapshots where available.

## T2, conditional deepening

Deepening is triggered by the material, not by appetite. Check each rule below
against the T1 material. If a rule fires and the answer would change a decision,
request the extra calls. If nothing fires, do not request anything.

| Rule | Trigger | Request |
|---|---|---|
| Competitor set is incoherent | across the top 5 competitors, common keyword overlap is under 30 percent | one more `keyword-gap` round against the two competitors whose overlap is highest, to locate the real rivals |
| Authority gap unclear | client authority score is within plus or minus 10 of the competitors | `backlinks` detail or extra rival domain-overviews, to decide whether links are the binding constraint this quarter |
| Local intent is significant | queries containing a place name are more than 20 percent of ranking or Search Console queries | `keywords --seed "<niche> <main centre>" --db nz` to size the local field, plus rival domain-overviews for any local specialist |

Budget: at most 10 extra gate calls, and one request round only. When the budget
cannot answer a question, write the question into `unknowns` and move on. A
dossier that names its blind spots is more useful than one that pretends.

### How to request

If, and only if, a rule fires, your entire reply for this turn is one fenced
block, nothing before it and nothing after it:

```needs
keyword-gap --domain example.co.nz --vs rival-one.co.nz,rival-two.co.nz --db nz --type weak
keywords --seed "laminate flooring auckland" --db nz
```

Rules for that block:

- one gate command per line, at most 10 lines
- allowed subcommands only: competitors, rankings, keyword-gap,
  backlinks, backlink-gap, domain-overview, keywords
- plain arguments only, no shell syntax, no pipes, no quotes
- do not ask for anything already in the T1 material
- you get one round. The results come back and then you write the dossier.

If no rule fires, skip this entirely and write the dossier now.

## Dossier output contract

Markdown, Chinese, these six second level headings, in this order, no others.
The headings are machine anchors, copy them character for character:

```
## 竞争格局
## 关键词全集
## 权威度差距
## 本地格局
## 季节性与内容形态
## 未知项
```

What belongs in each:

- **竞争格局**: who actually competes for these queries, how the overlap breaks
  down, and whether the competitor set is coherent. Separate real rivals from
  marketplaces, directories and manufacturers that share keywords but not the
  same buyer.
- **关键词全集**: the demand, layered into head, mid, long tail and local. Give
  sizes where the material supports it. Name the clusters worth owning and the
  clusters that are someone else's game.
- **权威度差距**: client versus real rivals on authority score and referring
  domains, and the direct answer to "is link building the binding constraint this
  quarter". If the material cannot answer it, say so and label it 未知.
- **本地格局**: the local intent share, who holds the local pack, and whether
  local work would change enquiry volume.
- **季节性与内容形态**: what the trend data supports about seasonality, and which
  content formats win in this niche, from what actually ranks.
- **未知项**: a numbered list of the decision inputs still missing. For each one:
  what is missing, which decision it blocks, and what would resolve it. This
  section is required and must never be empty. If a T2 request was refused or
  failed, that belongs here.

Length: aim for something a strategist reads in ten minutes. Dense, specific,
no restating the brief back.

## Machine block, required

Close the dossier with one fenced json block and nothing after it:

```json
{"spec_version":"v1","unknowns":["short phrase per unknown"],"confidence_summary":{"confirmed":0,"inferred":0,"unknown":0}}
```

- `spec_version` is always the string `v1`.
- `unknowns` mirrors the 未知项 section, one short phrase each, written in Chinese.
- `confidence_summary` counts the labels you used in the prose: `confirmed` counts
  [确认], `inferred` counts [推断], `unknown` counts [未知]. The json keys stay
  English, only the prose is Chinese.

## Style

The dossier prose is Chinese. This is an internal working document for the
agency, not a client deliverable. Keep operation names, endpoints, domain names,
metric names and json keys in their original form, do not translate them.

No emoji. No em dash or en dash, use commas, full stops or semicolons. Do not
invent numbers. If a source is missing from the material, that is a fact about
the dossier and it goes in 未知项.
