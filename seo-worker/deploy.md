# SEO worker deployment

Target: Ubuntu 22.04, node v22, ordinary user `alvin`, install path `/data/aira/seo-worker/`.
Zero npm dependencies, node built-ins only, so there is no install step for packages.

## 0. What this thing is

A long lived listener that claims jobs a human queued in the board and runs them.
It never schedules an LLM by itself. The poll timer only asks the API whether a job
exists. Empty queue, nothing happens.

## 1. Copy the code

From the Mac, in `projects/ops-tracker/`:

    rsync -av --exclude config.json --exclude 'secrets/*' --exclude 'logs/*' \
      seo-worker/ alvin@192.168.10.205:/data/aira/seo-worker/

Or with scp if rsync is not available:

    scp -r seo-worker alvin@192.168.10.205:/data/aira/

On the box:

    mkdir -p /data/aira/seo-worker/logs /data/aira/seo-worker/secrets
    chmod 700 /data/aira/seo-worker/secrets
    mkdir -p /data/aira/clients/powerdekorfloors

## 2. Generate config.json on the box

`config.json` is never committed and never copied from the Mac. Create it in place:

    cd /data/aira/seo-worker
    cp config.json.example config.json
    chmod 600 config.json
    ${EDITOR:-nano} config.json

Fields worth checking:

| field | value |
|---|---|
| apiBase | https://always.horntech-dev.com/seo-api.php |
| serviceToken | seo-worker-svc-9f3a71c2e8d4 |
| wakePort | 8377 |
| wakeSecret | seo-wake-2f8c1b7e (must match what the PHP board sends) |
| pollIntervalSec | 300 |
| ga4KeyFile | secrets/ga4_sa.json (relative paths resolve against the worker root) |
| claudeBin | claude, or the absolute path from `which claude` |
| claudeModel | opus, used by execute_task and report |
| planModel | fable, used by the plan runner only |
| discoverModel | opus, used by the discover runner only |
| applyModel | opus, used by apply_task, the only runner that writes to a site |
| feedbackModel | sonnet, used by the feedback runner |
| imageModel | sonnet, the visual check on every generated blog image |
| jobTimeoutMin | 30 |
| cacheTtlHours | 24, see below |
| seoqSsh | seoq, the ssh Host alias for the SEMrush gate |
| semrushDb | nz |
| workspaceRoot | /data/aira/clients |

`cacheTtlHours`, `seoqSsh`, `semrushDb`, `planModel` and `imageModel` are newer fields. An
existing config.json without them keeps working, the loader falls back to those defaults, so
adding them is optional and safe.

`cacheTtlHours` controls the pull_data snapshot cache. Before pulling a source, the runner
looks at the newest snapshot for that source in GET /context. If its `created_at` is
younger than the ttl, that source is skipped and the job log says
`gsc: cache hit (age 5h), skipped`. Queue the job with payload `{"fresh": true}` to bypass
the cache and pull every source. Set the ttl to 0 to disable caching entirely. An
unparseable or missing `created_at` counts as a miss, so it pulls fresh.

Validate it before starting anything:

    node -e "console.log(JSON.stringify(require('/data/aira/seo-worker/lib/config').load(),null,2))"

Missing apiBase, serviceToken or wakeSecret makes the listener exit 1 at startup on purpose.

## 3. Google service account key

Put the GA4 and GSC service account JSON at `/data/aira/seo-worker/secrets/ga4_sa.json`:

    chmod 600 /data/aira/seo-worker/secrets/ga4_sa.json

The same service account is used for both APIs, so it needs:

- GA4: added as a Viewer on the GA4 property.
- Search Console: added as a restricted user on the property in `profile.gsc_property`.
  The property string must match Search Console exactly, either `sc-domain:example.com`
  or `https://example.com/`.

Scopes requested at runtime: `analytics.readonly` and `webmasters.readonly`.

## 3b. SEMrush through the seoq gate

The worker never talks to SEMrush directly. It shells out to the internal seoq gate, which
carries its own 24 hour cache, so repeat calls are cheap and do not drive a browser.

Prerequisite: user `alvin` on the worker box must have a working `Host seoq` block in
`~/.ssh/config` with key based auth. Verify before the first pull_data run:

    ssh -o BatchMode=yes seoq 'domain-overview --domain powerdekorfloors.co.nz --db nz'

Expect a single JSON object on stdout with `"status":"ok"`. stderr carries human progress
and is discarded. A refusal by the gate exits 77 and is still JSON, the worker reads the
`error` field from it. If this command asks for a password or hangs, BatchMode is not set
up and every SEMrush pull will fail after the 90 second timeout.

Failures here degrade the SEMrush section only. GSC and GA4 still store, and the job still
finishes as done, with `semrush: degraded` in the log.

## 4. Install the claude CLI

Native installer, no npm, lands in `~/.local/bin`:

    curl -fsSL https://claude.ai/install.sh | bash
    export PATH="$HOME/.local/bin:$PATH"
    claude --version

Then authenticate once, interactively, as user `alvin`:

    claude

Complete the OAuth flow in the browser. The credentials persist under `~/.claude`, and
every later headless run reuses them. Without this step every LLM job fails immediately
with an auth error, which is the intended behaviour, no silent skipping.

Note the systemd unit hardcodes `PATH=/home/alvin/.local/bin:...` because a unit does not
read the login profile.

## 5. Run it

### Option A, systemd user service (preferred)

    mkdir -p ~/.config/systemd/user
    cp /data/aira/seo-worker/seo-worker.service ~/.config/systemd/user/
    # check the node path first, edit ExecStart if it is not /usr/bin/node
    which node
    systemctl --user daemon-reload
    systemctl --user enable --now seo-worker
    systemctl --user status seo-worker

Keep it alive across logout and reboot:

    sudo loginctl enable-linger alvin

Logs:

    journalctl --user -u seo-worker -f
    tail -f /data/aira/seo-worker/logs/worker.log

### Option B, nohup

    cd /data/aira/seo-worker
    nohup node listener.js >> logs/worker.log 2>&1 &
    echo $! > logs/worker.pid

Stop with `kill $(cat logs/worker.pid)`.

## 6. Health check

    curl -s localhost:8377/health | head -40

Expect `{"ok":true,"state":"idle",...}` with `poll_interval_sec`, `jobs_done`, `jobs_failed`
and `last_error`. `state` is `busy` while a job runs, with `current_job` filled in.

Wake it by hand, same call the board makes:

    curl -s -X POST localhost:8377/wake -H 'X-Seo-Secret: seo-wake-2f8c1b7e' -d '{}'

Expect HTTP 202 `{"ok":true,...}`. A wrong or missing secret returns 401 and is logged.

## 7. If the board cannot reach port 8377

Symptom: clicking a button in the board queues the job, but the worker only picks it up
on the next poll, up to 5 minutes later. The queue still drains, so this is a latency
problem, not a data loss problem.

Check in this order:

1. Is it listening at all, and on which interface:
   `ss -lntp | grep 8377`. Expect `0.0.0.0:8377`. If it says `127.0.0.1:8377`, set
   `bindHost` to `0.0.0.0` in config.json and restart.
2. Local call works but remote does not, so it is the network:
   from the PHP box `curl -v -m 5 http://192.168.10.205:8377/health`.
3. ufw: `sudo ufw status`. If active,
   `sudo ufw allow from 192.168.10.0/24 to any port 8377 proto tcp`.
4. Anything else in the way: `sudo iptables -L -n | grep 8377`, and check whether the two
   machines are on the same VLAN.
5. Secret mismatch shows as HTTP 401 in the worker log with
   `wake rejected, bad or missing X-Seo-Secret`. Compare wakeSecret on both sides.

## 8. Smoke test after deploy

1. `curl -s localhost:8377/health` returns ok.
2. Queue a `pull_data` job for the client from the board, then watch the log. It should
   claim, hit GSC, GA4 and seoq, POST up to three snapshots and PATCH the job to done. No
   LLM involved. Run it a second time and the sources should report cache hits instead,
   which proves the ttl works. Use payload `{"fresh": true}` to force a real pull.
3. Only after pull_data works, queue a `plan` job. That one spawns claude, so it proves
   the OAuth login and the PATH are right.

4. For a new client, queue `discover` before the first `plan`. It runs the gate calls,
   reads the sitemap, and writes a dossier to a `discovery` snapshot plus
   `seo-agent-output/dossier-<date>.md`, with the raw material kept under
   `temp/discover-<date>/`. The plan runner then folds that dossier into its briefing.

The discover runner works to `specs/discover.md`, which ships with the worker and is read
at run time, so a spec change takes effect on the next run with no code change. The spec
version is stamped into every dossier and into the header comment of every plan, which is
what makes a plan traceable back to the instructions that produced it. Keep the two in
sync: if you edit the spec in a way that changes its meaning, bump `spec_version` in the
spec and in `SPEC_VERSION` in `runners/discover.js`.

The discover run may ask for one extra round of gate calls, capped at 10. The runner, not
the model, decides what is allowed to run: anything outside the subcommand allow list in
`lib/seoq.js`, or carrying shell syntax, is refused and logged. If a client keeps its
sitemap somewhere unusual, set `sitemap_url` on the client profile.

## Two stage site changes

A task that carries `ops` from a platform capability manifest never goes straight to the
site. `execute_task` runs it in prepare mode and writes a change plan to
`seo-agent-output/change-plan-task-{id}.md`: call sequence, expected response per step,
before and after preview, rollback, verification steps. The task is left for review, and
its tools are read only with curl pinned to GET by the prompt.

After a human approves it, queue an `apply_task` job for the same task id. That runner
reads the same change plan file, executes it exactly, runs the plan's own verification,
and only then calls `POST /tasks/{id}/complete`. Anything unexpected aborts: the task
stays in review with the reason in its note, the job ends failed so a human sees it, and
nothing is retried automatically.

Prerequisites for apply on a client:

- `specs/capabilities/{platform}.md` exists and the client profile has `platform` set.
  Without a manifest, plans send every site changing task to the agency instead.
- The credentials file exists at
  `{workspaceRoot}/{client}/notes/{platform}_credentials.md`, mode 600. apply_task refuses
  to run without it. Credentials are read by the agent and must never appear in a change
  plan, an execution record or a task note.

Capability manifests are also what the plan runner injects into its briefing, but only the
planning view table between the `PLANNING_VIEW` markers. The full manifest, with endpoints
and risk notes, is only ever given to the prepare and apply stages.

## Language of the artifacts

Internal artifacts are Chinese: the plan body, the decision log, the dossier, task titles
and details, change plans and execution records. Machine anchors stay fixed literals:
`## 数据缺口` in plans, the six `## 竞争格局` style headings in dossiers, and the
`[确认]` / `[推断]` / `[未知]` confidence labels. All json keys stay English. Anything that
goes onto the client site, page copy, blog bodies, meta text, is written in the site
language, not Chinese.

The plan runner is the one to watch. It refreshes every source first, cache aware, then
distils the snapshots into a briefing under 15KB in plain node, then makes one LLM pass
with `planModel` and Read only tools. The prose lands in POST /plans as a draft, the task
block lands in POST /tasks/bulk as proposed tasks, and a copy of the raw output is kept in
`/data/aira/clients/powerdekorfloors/seo-agent-output/`. Read the job log for
`briefing distilled: N bytes`, `plan stored as draft, id ...` and the task ids.

If the model returns no task block, or the bulk call is rejected, the plan is still stored
and the job still ends done. The log says what was proposed so it can be keyed in by hand.
A failing POST /plans is different, that fails the job and dumps the full plan text into
the job log so nothing is lost.

## 9. Operational notes

- No retries anywhere by design. A failed job stays failed with the stack in its log,
  and a human requeues it.
- A job that exceeds `jobTimeoutMin` gets SIGTERM, then SIGKILL 15 seconds later, and is
  marked failed. The claude process is spawned in its own process group so the whole tree
  dies with it.
- One job at a time. A wake that arrives mid job sets a pending flag and the worker drains
  again as soon as it is free.
- Restarting the worker mid job orphans that job in `running` state on the server. Fix it
  from the board, the worker will not touch it again.
- LLM jobs use read only tools plus `Bash(curl:*)`. Nothing here can publish to a site.
  Site writing waits for the WebForger credential work.
