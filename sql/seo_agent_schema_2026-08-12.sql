-- HornTech Ops Tracker - SEO Agent module schema
-- Created 2026-08-12. Pilot client: Power Dekor Floors (clients.id = 15)
-- Apply with: mysql -u'always-op' -p'<pass>' < seo_agent_schema_2026-08-12.sql

USE `always-op`;

-- ---------------------------------------------------------------
-- seo_profiles: one brief per client, hand maintained by admin,
-- read by the agent runner as the standing context block.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seo_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL,
  platform VARCHAR(50) DEFAULT '',
  domain VARCHAR(255) DEFAULT '',
  ga4_property VARCHAR(100) DEFAULT '',
  gsc_property VARCHAR(255) DEFAULT '',
  semrush_project VARCHAR(100) DEFAULT '',
  target_keywords JSON DEFAULT NULL,
  business_goals TEXT DEFAULT NULL,
  conversion_goals TEXT DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  status ENUM('active','archived') NOT NULL DEFAULT 'active',
  report_lang VARCHAR(8) NOT NULL DEFAULT 'en',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_seo_profile_client (client_id),
  FOREIGN KEY (client_id) REFERENCES clients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------
-- seo_plans: versioned Markdown strategy documents.
-- Only one row per client may sit in status='active'.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seo_plans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  body MEDIUMTEXT,
  status ENUM('draft','active','superseded','rejected') NOT NULL DEFAULT 'draft',
  authored_by VARCHAR(50) DEFAULT '',
  approved_by VARCHAR(50) DEFAULT '',
  reject_reason TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_seo_plans_client (client_id, status),
  FOREIGN KEY (client_id) REFERENCES clients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------
-- seo_tasks: the swimlane board. owner_type splits the work between
-- the agency team, the client, and the agent runner.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seo_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL,
  plan_id INT DEFAULT NULL,
  sprint VARCHAR(10) DEFAULT '',
  module ENUM('technical','onpage','content','local','offpage') NOT NULL DEFAULT 'technical',
  title VARCHAR(255) NOT NULL,
  detail TEXT DEFAULT NULL,
  owner_type ENUM('agency','client','agent') NOT NULL DEFAULT 'agency',
  priority ENUM('P0','P1','P2','P3') NOT NULL DEFAULT 'P2',
  status ENUM('proposed','approved','in_progress','review','done','blocked') NOT NULL DEFAULT 'proposed',
  output_url VARCHAR(500) DEFAULT '',
  attention TINYINT(1) NOT NULL DEFAULT 0,
  ops VARCHAR(255) DEFAULT '',
  result_note TEXT DEFAULT NULL,
  created_by VARCHAR(50) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_seo_tasks_client (client_id, owner_type, status),
  KEY idx_seo_tasks_plan (plan_id),
  FOREIGN KEY (client_id) REFERENCES clients(id),
  FOREIGN KEY (plan_id) REFERENCES seo_plans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------
-- agent_jobs: work queue. Created by the admin dashboard, claimed by the
-- worker on the ros box via a conditional UPDATE (optimistic lock, no
-- SKIP LOCKED: production is MariaDB 10.3). idx_agent_jobs_queue serves
-- the "oldest queued job" pick.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_jobs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL,
  type ENUM('discover','pull_data','plan','execute_task','apply_task','report') NOT NULL,
  payload JSON DEFAULT NULL,
  status ENUM('queued','running','done','failed') NOT NULL DEFAULT 'queued',
  log_text MEDIUMTEXT,
  token_usage INT NOT NULL DEFAULT 0,
  created_by VARCHAR(50) DEFAULT '',
  claimed_at TIMESTAMP NULL DEFAULT NULL,
  finished_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_agent_jobs_queue (status, id),
  KEY idx_agent_jobs_client (client_id, type, status),
  FOREIGN KEY (client_id) REFERENCES clients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------
-- seo_snapshots: raw period metrics pulled from GA4 / GSC / Semrush.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seo_snapshots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL,
  source ENUM('ga4','gsc','semrush','discovery') NOT NULL,
  period_start DATE DEFAULT NULL,
  period_end DATE DEFAULT NULL,
  data JSON DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_seo_snapshots_client (client_id, source, id),
  FOREIGN KEY (client_id) REFERENCES clients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------
-- seo_facts: the durable knowledge base per client. The agent files
-- unconfirmed findings, a human confirms them; confirmed facts are
-- never silently overwritten by a later agent run.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seo_facts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL,
  fact_key VARCHAR(100) NOT NULL,
  value TEXT DEFAULT NULL,
  source ENUM('agent','client','manual') NOT NULL DEFAULT 'manual',
  status ENUM('unconfirmed','confirmed') NOT NULL DEFAULT 'unconfirmed',
  updated_by VARCHAR(50) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_seo_facts_client_key (client_id, fact_key),
  KEY idx_seo_facts_status (client_id, status),
  FOREIGN KEY (client_id) REFERENCES clients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------
-- Seed: pilot client Power Dekor Floors (clients.id = 15)
-- ---------------------------------------------------------------
INSERT INTO seo_profiles
  (client_id, platform, domain, ga4_property, gsc_property, semrush_project,
   target_keywords, business_goals, conversion_goals, notes)
VALUES
  (15,
   'WebForger',
   'https://www.powerdekorfloors.co.nz/',
   '363223275',
   'https://www.powerdekorfloors.co.nz/',
   '',
   NULL,
   'Premium flooring supplier in NZ. Lead generation site, no ecommerce.',
   'Form submissions and phone clicks',
   'GSC data before 2026-07-14 polluted by jacktoto gambling spam hack (WP era, cleaned after WebForger migration). Always exclude query regex (jack|jek|jak|jeck)\\s?toto and misspelling variants from baselines.')
ON DUPLICATE KEY UPDATE
  platform=VALUES(platform),
  domain=VALUES(domain),
  ga4_property=VALUES(ga4_property),
  gsc_property=VALUES(gsc_property),
  business_goals=VALUES(business_goals),
  conversion_goals=VALUES(conversion_goals),
  notes=VALUES(notes);

-- ---------------------------------------------------------------
-- Migration 2026-08-13: discover feature.
-- Already applied by hand on production (MariaDB 10.3). Kept here so a
-- database created from the 08-12 version of this file can catch up;
-- CREATE TABLE IF NOT EXISTS above will not touch existing tables.
-- Re-running these on an up-to-date DB errors as duplicate column /
-- identical enum, which is safe to ignore.
-- ---------------------------------------------------------------
-- ALTER TABLE seo_snapshots MODIFY source ENUM('ga4','gsc','semrush','discovery') NOT NULL;
-- ALTER TABLE seo_tasks ADD COLUMN priority ENUM('P0','P1','P2','P3') NOT NULL DEFAULT 'P2' AFTER owner_type;
-- ALTER TABLE agent_jobs MODIFY type ENUM('discover','pull_data','plan','execute_task','report') NOT NULL;

-- ---------------------------------------------------------------
-- Migration 2026-08-13b: multi-client console.
-- Already applied by hand on production. seo_facts is covered by the
-- CREATE TABLE IF NOT EXISTS above; only the seo_profiles column needs
-- an ALTER on a database created from an earlier version of this file.
-- ---------------------------------------------------------------
-- ALTER TABLE seo_profiles ADD COLUMN status ENUM('active','archived') NOT NULL DEFAULT 'active' AFTER notes;

-- ---------------------------------------------------------------
-- Migration 2026-08-13c: batch gate (approve-with-exclusions, release
-- queue, exception queue). Already applied by hand on production.
-- ---------------------------------------------------------------
-- ALTER TABLE agent_jobs MODIFY type ENUM('discover','pull_data','plan','execute_task','apply_task','report') NOT NULL;
-- ALTER TABLE seo_profiles ADD COLUMN report_lang VARCHAR(8) NOT NULL DEFAULT 'en' AFTER status;
-- ALTER TABLE seo_tasks ADD COLUMN attention TINYINT(1) NOT NULL DEFAULT 0 AFTER output_url;
-- ALTER TABLE seo_tasks ADD COLUMN ops VARCHAR(255) DEFAULT '' AFTER attention;
-- ALTER TABLE seo_tasks ADD COLUMN result_note TEXT DEFAULT NULL AFTER ops;

-- ---------------------------------------------------------------
-- Migration 2026-08-21: feedback box. A human writes a plain language
-- note on a task, the feedback runner parses it into facts and a
-- summary. seo-api.php creates the table and widens the agent_jobs enum
-- lazily on the first feedback request, so these are documentation and
-- a manual catch-up path, not a required step.
-- ---------------------------------------------------------------
-- CREATE TABLE IF NOT EXISTS seo_feedback (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   client_id INT NOT NULL,
--   task_id INT NOT NULL,
--   source ENUM('manual','client') NOT NULL DEFAULT 'manual',
--   `text` MEDIUMTEXT,
--   images TEXT DEFAULT NULL,
--   status ENUM('pending','parsed','failed') NOT NULL DEFAULT 'pending',
--   parsed_note TEXT DEFAULT NULL,
--   job_id INT DEFAULT NULL,
--   created_by VARCHAR(64) NOT NULL DEFAULT '',
--   created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
--   parsed_at TIMESTAMP NULL DEFAULT NULL,
--   KEY idx_seo_feedback_task (task_id, id),
--   KEY idx_seo_feedback_client (client_id, id)
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- On a database that already has seo_feedback without the screenshot column:
-- ALTER TABLE seo_feedback ADD COLUMN images TEXT DEFAULT NULL AFTER `text`;
--
-- Screenshots themselves are files, not rows. They live in
-- /www/wwwroot/always-uploads/feedback/ , deliberately outside the webroot
-- /www/wwwroot/always/ , and are only reachable through GET /feedback_file/{name}.
-- The directory must be writable by the php-fpm user.

-- ---------------------------------------------------------------
-- Migration 2026-08-21b: triage job. A read only pass where the
-- house keeping agent reads the whole client pipeline and writes a
-- diagnosis. seo-api.php widens the enum lazily (ensure_job_types
-- checks value by value, so any intermediate state heals in one go).
-- ---------------------------------------------------------------
-- ALTER TABLE agent_jobs MODIFY type ENUM('discover','pull_data','plan','execute_task','apply_task','report','feedback','triage') NOT NULL;

-- ---------------------------------------------------------------
-- Migration 2026-08-23: content registry + cannibalisation check.
-- A new snapshot source holding the mechanical enumeration of every
-- page, collection, collection item and blog post (drafts included)
-- on the client's platform, plus the query level cannibalisation
-- signal computed from the GSC query x page rows.
-- seo-api.php widens the enum lazily on the first POST /snapshots
-- (ensure_snapshot_sources checks value by value, so a database at
-- any intermediate state heals in one ALTER). Listed here so a
-- database built from this file alone still catches up.
-- ---------------------------------------------------------------
-- ALTER TABLE seo_snapshots MODIFY source ENUM('ga4','gsc','semrush','discovery','content_registry') NOT NULL;

-- ---------------------------------------------------------------
-- Migration 2026-08-24: 日粒度时序（数据洞察一期）。
-- seo_snapshots 存的是 28 天窗口的一大坨 JSON，能看当期总量看不了连续趋势。
-- seo_metrics_daily 把同样的数据摊成 (客户, 日期, 指标名) 三元组，一行一个点，
-- Dashboard 的趋势图、逐层转化率曲线、排名分档、品牌词拆分全部读它。
-- seo-api.php 的 ensure_metrics_schema() 在首次访问 /metrics /events /profile
-- /context 时惰性建表并补 seo_profiles.brand_regex，所以下面这些是文档和
-- 手工补课路径，不是必须先跑的步骤。
--
-- 幂等的全部依据是 UNIQUE KEY (client_id,d,m)：worker 重跑同一窗口只覆盖
-- 同名同日的值，不堆重复行，所以 backfill_metrics job 可以随便重跑。
-- ---------------------------------------------------------------
-- CREATE TABLE IF NOT EXISTS seo_metrics_daily (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   client_id INT NOT NULL,
--   d DATE NOT NULL,
--   m VARCHAR(40) NOT NULL,
--   v DOUBLE NOT NULL DEFAULT 0,
--   updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
--   UNIQUE KEY uq_seo_metrics_daily (client_id, d, m),
--   KEY idx_seo_metrics_daily_read (client_id, m, d)
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--
-- 品牌词拆分要一条正则区分品牌搜索和非品牌搜索。人工填优先，
-- 留空由 worker 从客户名（有词边界，最准）或域名主体确定性推导。
-- ALTER TABLE seo_profiles ADD COLUMN brand_regex TEXT DEFAULT NULL AFTER target_keywords;
--
-- 回填 job。ensure_job_types() 逐值检查，所以任何中间状态一次 ALTER 就能追上。
-- ALTER TABLE agent_jobs MODIFY type ENUM('discover','pull_data','plan','execute_task','apply_task','report','feedback','triage','ruling','backfill_metrics') NOT NULL;
--
-- m 列的取值范围见 seo-api.php 的 METRIC_NAMES，那是唯一权威清单。
-- 不做成 ENUM 是有意的：指标会持续增加，VARCHAR 加一个名字不用 ALTER 全表。
