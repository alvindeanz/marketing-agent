#!/usr/bin/env node
'use strict';
// 可选：从已发布的选题规划生成「博客选题确认卡」任务（通用模式，客户逐题勾选）。
// 用法：SEO_AGENT_TOKEN=<admin jwt> node tools/blog_topic_card.js <client_id> <slug> <plan_url> [--sprint S1] [--mode we_write|client_writes]
// 只建任务进闸A，卡本体由 execute 客户版产物通道出（与词表/mapping 确认卡同产线）。
// mode 语义（2026-09-19 设计）：we_write = 客户勾选后放行我方写稿；client_writes = 卡即交付物，
//   勾选生成等稿跟踪，稿到转上传加内链（haakaa 型）。折叠分支未接通前，mode 只写进任务说明供折叠时人裁。
const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = process.env.SEO_AGENT_TOKEN || '';
const [cid, slug, planUrl] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const sprint = arg('--sprint', 'S1');
const mode = arg('--mode', 'we_write');
if (!cid || !slug || !planUrl || !TOKEN) { console.error('用法：SEO_AGENT_TOKEN=... node tools/blog_topic_card.js <client_id> <slug> <plan_url> [--sprint S1] [--mode we_write|client_writes]'); process.exit(2); }

const detail = `产出客户版博客选题确认卡，发布为 reports/blog_topics_confirmation_${new Date().toISOString().slice(0, 7)}.html，通用模式（对齐词表/mapping 确认卡产线）。
语言：按客户工作区 CLAUDE.md 的沟通语言口径，动笔前先查，没写就停下报人，不许按站点语言猜。
内容来源：选题规划 ${planUrl} （逐题带 GSC 证据，不重复造）。
卡面结构：
1. 开场一句话：这是接下来几个月的博客选题建议，请逐题确认或调整。
2. 每题一行：拟标题（站点语言原文）/目标词/一句话角度/写完导流到哪个页/建议月份。按规划的月份分组展示。
3. 每题勾选「写 / 不写 / 换角度（留言）」，页尾整体表态加留言框。
4. 到期条款：发出后 10 个工作日未回复按建议执行；执行模式 ${mode === 'client_writes' ? 'client_writes：客户自己写稿，本卡即选题交付，勾选后生成等稿跟踪，稿到我方上传加内链' : 'we_write：客户勾选后放行我方按月写稿'}。
硬规则：零考核语言；零内部信息（不提工具名，GSC 数据写「搜索数据」）；零破折号零 emoji；导流页链接实测 200 才上卡，未建页写待建。`;

(async () => {
  const r = await fetch(API + '/tasks', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: Number(cid), title: `博客选题确认卡（${slug}，客户 review）`, module: 'onpage', sprint, priority: 'P1', owner_type: 'agent', detail }) });
  const j = await r.json();
  if (!r.ok) { console.error('建任务失败', r.status, JSON.stringify(j).slice(0, 200)); process.exit(1); }
  console.log(`任务 #${j.id} 已建，闸A job ${j.review_job_id}。判 do 后 harness --ids ${j.id} 推出卡。`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
