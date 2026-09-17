# Handover

This is the implementation repo for the agentic coding pipeline: a multi-agent system, built on the [Pi](https://pi.dev) coding harness, that takes a feature from a PRD to a human-reviewable GitLab merge request against `fastrr-checkout-services` — plus the infrastructure to run it safely for a team of 30-40 people at once.

**Implementation is underway** (see "Current progress" below for exactly how far). Everything below is design context for whoever picks this up next — read this before touching orchestrator code, and read "Current progress" before assuming anything is or isn't built yet.

## Where the specs live

Design work happened in a **separate repo**, kept apart from this one deliberately so implementation work doesn't clutter the design history:

`/Users/bedantsharma/agent-pipeline/docs/superpowers/specs/`

Two specs plus one feasibility research doc, in dependency order:

1. **`2026-09-15-agent-pipeline-design.md`** — the pipeline itself: the five agents (PRD-critic, Planner, Coder, Reviewer, Supervisor), how they hand off work, tool access, enforcement, and how a run ends (local tests + a GitLab MR, nothing further).
2. **`2026-09-15-multi-user-infra-design.md`** — wraps #1 with SSO and per-user isolation so 30-40 people can run it concurrently on one shared box. Depends on #1; doesn't change how the pipeline itself behaves. **Revised 2026-09-17**: §11 now specs a forked/customized `pi-web` (not `pi-agent-dashboard`) as the per-user interactive UI — stage-progress tab, telemetry+memory tab, a read-only/admin-editable knowledgebase tab, and live steering into job-container sessions. §3 step 6 (JWT minting) was also corrected after implementing it for real — see "Gateway service" below.
3. **`2026-09-17-a2a-feasibility-research.md`** — research answering "should the five pipeline agents talk to each other over the A2A protocol / `pi-a2a-adaptor`?" **Verdict: no.** A2A is built for independently-deployed agents discovering each other dynamically, not a fixed known pipeline; `pi-a2a-adaptor` is client-only, third-party, and untested against headless SDK sessions. Adopting it would mean reversing the submit-tool/guardrail/Supervisor-as-hook architecture spec #1 already committed to, for a coarser-grained, harder-to-enforce model. Not acted on further.

Read all three before implementing — this document summarizes *why* things were decided, not *what* to build; the specs have the actual detail (schemas, tool tables, section-by-section design).

## Why Pi, and why the SDK (not RPC, not subprocesses)

Pi is fundamentally a **single-agent** harness — there's no native multi-agent orchestration. Its own docs point anyone building a multi-agent app at embedding it via the **Node/TypeScript SDK** (`createAgentSession`) rather than spawning `pi --mode rpc` subprocesses and talking JSONL over stdin/stdout — the docs explicitly say so. That settled the foundational architecture: this repo is a **Node/TypeScript orchestrator** that creates and drives multiple `AgentSession`s, one per pipeline role, not five independent CLI processes.

**Key open risk — partially resolved by the Task 3 spike (`SPIKE_FINDINGS.md`)**: none of Pi's docs show an explicit example of attaching `pi-mcp-extension` (MCP tool bridging), `pi-memory` (cross-run memory), or `pi-agent-dashboard` (visibility) to a session created *headlessly* via the SDK, as opposed to one the interactive CLI spawned. The extension-loading mechanism (`DefaultResourceLoader` + `additionalExtensionPaths`) is confirmed and generic — all three packages resolve via a `"pi": {"extensions": [...]}` manifest field in their `package.json`, pointed at by the package root directory, exactly as `resolveExtensionDir()` in `src/spike/verify-extensions.ts` does.

Empirically confirmed working on a headless SDK session: **MCP tool bridging (GitNexus, via `pi-mcp-extension`)** and **`pi-memory`'s write/read round-trip**. Both were verified end-to-end, not just by extension-count — a real GitNexus MCP tool call returned real results, and a memory write was independently confirmed on disk.

**Still open, and now concretely scoped rather than unknown**: `pi-agent-dashboard` visibility does **not** work out of the box. The bridge extension loads and discovers a running dashboard's endpoint, but the headless session never appeared in that dashboard's own `/api/health` session list, confirmed across two runs including one that stayed alive for 8+ seconds specifically to rule out a registration race. See `SPIKE_FINDINGS.md`'s "(c) pi-agent-dashboard visibility" section for what was ruled in/out and the recommended follow-up spike before any dashboard-dependent code (the multi-user infra design's per-user dashboard-instance plan) gets built on top of this.

## Why five separate `AgentSession`s, not one session playing five roles

Each role needs a genuinely different toolset, a different system-prompt "personality," and — critically — the PRD-critic needs to be interactive with a human while the loop agents run fully autonomously. Splitting these cleanly into distinct sessions, each with its own scoped tool allowlist, was simpler and safer than one session context-switching between very different jobs with very different trust levels (e.g. the Coder has `bash`/`write`/`edit`; the Reviewer deliberately doesn't, to keep it adversarial rather than trusting).

**Session lifecycle within the loop** (Planner → Coder → Reviewer) was a specific, deliberate choice: the *first* Planner→Coder and Coder→Reviewer handoffs create fresh sessions (cheap, clean role separation — the Coder doesn't need the Planner's raw research, just its conclusion). But once created, those three sessions **persist for the whole loop** — each subsequent handoff (Reviewer's verdict back to Planner, revised plan back to Coder, etc.) is a follow-up prompt into the *same* session, not a new one. This means each agent accumulates its own memory of everything it's done across iterations, while still only learning about the others' work through the deliberate handoff artifact at each transition, never their raw reasoning.

## Why every handoff is a dedicated "submit tool" call

Rather than the orchestrator guessing when an agent is "done" by parsing free text, each stage ends by calling a dedicated tool whose parameters *are* the structured handoff artifact (`finalize_prd`, `submit_plan`, `submit_for_review`, `submit_verdict`). This does three things at once: gives a reliable completion signal, produces a clean structured artifact for the next stage, and — the reason it matters most — gives a natural place to **enforce** things mechanically rather than just instructing them in a prompt. Pi's `tool_call` hook can block a submit tool outright until prerequisites are met, which is how "the PRD-critic must use GitNexus/knowledgebase/memory before finalizing" and "the Coder must have a passing test run before submitting for review" become real constraints instead of suggestions an LLM might skip.

## Why the PRD-critic gets the most tooling and the only cross-run memory

It's the single highest-leverage agent in the pipeline — the only line of defense against building the wrong thing, or building the right thing in a way that fights this codebase's actual conventions. It gets GitNexus, the `fastrr_*` architecture/context MCP tools, the `fastrr_search_skill`/`fastrr_search_knowledge` tools (a separate system from `knowledgebase/`, confirmed not overlapping), and `pi-memory` scoped specifically to this role (not per-OS-user) so it accumulates codebase knowledge across every PRD session run by anyone, not just personal preferences of one human. The Planner gets the same architecture/context tools (it needs to spot existing conventions too — e.g. "payment reads route through payment-aggregator, not directly to payment-core") but not the memory or the skill/knowledge-search tools — those stay critic-only.

Deliberately **not** given to any of the five roles: the org's production-observability MCP toolset (Grafana, ClickHouse/Mongo/Postgres query tools, Sentry, Jenkins staging, Langfuse, SigNoz). These are debugging/operations tools, not "plan and build a new feature" tools, and Jenkins specifically conflicts with the explicit decision to run tests locally rather than trigger staging builds.

## Why the Supervisor is a hook, not a sixth conversational agent

Two-tier design: **Tier 1** is deterministic pattern-matching (no model call) against known org-process violations — seeded directly from `knowledgebase/00-cross-cutting-gotchas.md` and the subsystem files, since that document is precisely the "how we actually do things here" knowledge a generic coding agent has no other way to know (the canonical example: don't let the Coder write its own `CREATE INDEX` migration — that's devops's job here). **Tier 2** is a one-shot, stateless model call for gray areas that don't match a known-safe or known-bad pattern but touch a risk-flagged category — deliberately *not* a full persistent `AgentSession`, to keep the common case (an ordinary code edit) fast and free of any model call at all. The 30-iteration loop cap is a **configurable run parameter**, not a hardcoded constant, specifically so it can be tuned experimentally later without a code change.

## Why the pipeline stops at an MR, not a deploy

Explicit scope decision: local test execution + opening a GitLab MR is the finish line. Merging, further CI, and deployment are other teams' responsibility — the pipeline was never meant to own that. MR creation itself is a **deterministic orchestrator-level step** (`glab mr create`, run directly by the orchestrator), not something any agent invokes as a tool call — a malformed flag on an MR-creation command is a bad place for model unreliability to show up, so it isn't left to an LLM's tool call at all.

## Why `pi-agent-dashboard`, and why it needed a workaround for multi-tenancy

Chosen over the simpler `pi-web` because it's purpose-built for multi-agent visibility (distinct agent cards, live graph, per-agent timeline) and ships with real OAuth. But investigating it further (for the infra spec) turned up a real gap: **it has no per-user session isolation** — its OAuth gates who can open the dashboard at all, not what they see once inside; the README describes one shared session list with no ownership model. It also expects a standard OAuth2/OIDC handshake, which doesn't match how Fastrr Admin's actual auth flow works. Resolution: don't ask it to do multi-tenancy it wasn't built for — every user gets their **own** dashboard instance, scoped to nothing but their own session directory, reachable only through this project's own gateway after real SSO. The dashboard's job shrinks to pure visualization; identity and isolation are owned entirely by this project.

## Why SSO reuses `agent_one`'s flow exactly, instead of building something new

`agent_one` (`/Users/bedantsharma/PycharmProjects/agent_one`) already has a complete, working pattern: redirect to `fastrr-admin.fastrr.com/auth-and-redirect`, validate the returned token against **aggregator-service directly** (`GET /api/ve1/aggregator-service/user/login-detail/` with `X-Auth-Token`), then mint a short-lived scoped JWT for talking to internal tool servers, forwarded raw (no re-signing) at every hop. Reusing this exactly — rather than inventing a parallel auth story — means this project's `fastrr_*` MCP tool calls can authenticate against the **same** tool infrastructure `agent_one` already uses, scoped per pipeline-user via the same JWT claims, instead of needing a bespoke credential system. It also resolves what was otherwise a v1 stopgap in the pipeline spec (audit-log identity for PRD approval was going to be a CLI prompt until this flow made it a real authenticated email).

## Why three isolation tiers instead of one process per user

Two requirements pulled in different directions: "on-demand, cheap when idle" (30-40 users, most idle most of the time) versus "must never die mid-task" (a running Planner/Coder/Reviewer loop can't be killed just because the owning user's laptop is closed or they went idle). Rather than pick one, the design splits into three tiers with different lifecycle rules: a **persistent workspace** (disk only — worktrees, session files, memory, audit log; nothing to tear down), an **interactive container** (dashboard + PRD-critic dialogue; on-demand, safe to kill after inactivity since everything's already persisted to disk), and a **job container** (the actual autonomous loop; immune to idle-teardown entirely once a PRD is approved, runs to a terminal state regardless of the user's presence — the same mental model as a CI build that keeps running after you close the browser tab). A small job registry is what makes the teardown-immunity real: the idle reaper always checks it first and refuses to touch anything marked `running`.

Docker was the isolation mechanism, not a bespoke sandbox — Pi has **no built-in sandboxing** of its own (confirmed directly from its security docs: tools run with the full OS permissions of whatever process runs them), so with 30-40 people sharing one box and the Coder agent holding `bash`/`write`/`edit`, per-user container boundaries are load-bearing, not optional polish.

## What's explicitly deferred, and why

- **Cross-run memory for Planner/Coder/Reviewer** — only the PRD-critic has it. The other three already get full within-run context via persistent sessions; cross-run learning for them wasn't asked for and adds real curation complexity (stale/wrong "learned" conventions biasing future runs) without a concrete need yet.
- **Slack/email notifications** — the Supervisor's report is a plain structured object; today it's delivered into the MR description and echoed to chat. Delivery is deliberately a separate concern from report-building specifically so these can be added later without touching the Supervisor's own logic.
- **Deploy automation** — out of scope entirely; this pipeline's job ends at an open MR.
- **Full crash-resume after a hard host failure mid-job** — Docker's `--restart unless-stopped` protects against benign hiccups (daemon restarts etc.); a genuine host crash mid-run is accepted as a manual-investigation failure for v1, not something auto-recovered.
- **Multi-box scaling** — not built now, but every isolation boundary (per-user containers, the job registry, the concurrency queue) is expressed in terms that don't assume "this specific machine," so it's meant to be additive later, not a rework.

## Current progress (as of 2026-09-16)

Implementation follows a 21-task plan at `docs/superpowers/plans/2026-09-15-agent-pipeline-implementation.md`, executed via subagent-driven development (a fresh implementer + reviewer per task) in the git worktree `.worktrees/feature-agent-pipeline-implementation` on branch `feature/agent-pipeline-implementation` — **this branch, not `master`, is where all the actual code lives right now.** `master` still only has the original scaffolding. If you're reading this from `master`, switch to that branch/worktree first.

Live status ledger: `.superpowers/sdd/2026-09-15-agent-pipeline-implementation/progress.md` (inside that worktree) — it has the full task-by-task history (implementer/reviewer verdicts, fix rounds, rulings). This section is a summary of it, not a replacement.

**Done (Tasks 1-6 of 21, all reviewed clean):**
- Task 1 — vitest test runner
- Task 2 — `RunConfig`/shared types (`src/types.ts`) and the env-var-driven config loader (`src/config.ts`)
- Task 3 — the extension-loading spike (see `SPIKE_FINDINGS.md` and the "Why Pi..." section above) — this is what confirmed GitNexus MCP bridging and `pi-memory` work on headless SDK sessions, and that `pi-agent-dashboard` visibility currently does **not**
- Task 4 — Supervisor Tier-1 deterministic guardrail rules (`src/supervisor/tier1-rules.ts`)
- Task 5 — Supervisor Tier-2 gray-zone matcher (`src/supervisor/tier2-matcher.ts`)
- Task 6 — mandatory tool-use tracker and submit gate (`src/enforcement/tool-tracker.ts`)

**In progress:** Task 7 (`run_tests` custom tool) — implemented and through one fix round (added a subprocess timeout, workspace-boundary enforcement against path-escape via the LLM-supplied `repo` parameter, and restricted the spawned process's environment to just `PATH`/`JAVA_HOME`/`M2_HOME`) — the scoped re-review confirming that fix round is what's running next.

**Not started (Tasks 8-21):** the Tier-2 model classifier, the submit-tool factories, wiring the Supervisor/enforcement hooks into actual `pi.on("tool_call")` handlers, all five session factories (PRD-critic/Planner/Coder/Reviewer + the loop driver), the audit log, GitLab MR creation via `glab`, the top-level orchestrator, the CLI entry point, and finally an end-to-end validation run against a real low-stakes PRD. In short: every individual building block so far is real and tested in isolation, but **nothing is wired together into a runnable pipeline yet** — that assembly happens in the later tasks (roughly 13-20).

## Bugs found from a live run, and fixed (2026-09-17)

A live end-to-end run against `fastrr-checkout-services` (PRD: add a trivial success-response
endpoint to `payment-core`) completed the actual coding work correctly — Planner/Coder/Reviewer
converged in 2 iterations, `payment-core` and `payment-aggregator` were touched, tests passed —
but the run still died with an uncaught error. **Neither of these was a mistake by the Coder or
any other agent; both were bugs in the pipeline's own code**, now fixed with regression tests
(see `src/mr.test.ts` and `src/supervisor/tier1-rules.test.ts`):

- **`src/mr.ts` — the actual crash.** `createMergeRequest` always appended `--fill` to `glab mr
  create` *in addition to* the explicit `--title`/`--description` it always supplies. `glab
  1.112.0` hard-errors on that combination (`Usage of --title and --description overrides
  --fill`) instead of the older silent-override behavior. Since title/description are always
  supplied explicitly, `--fill` was never doing anything useful — removed.
- **`src/supervisor/tier1-rules.ts` — a false-positive guardrail block, contributing noise to
  the same run.** `checkFileScope` matched a path against an allowed service with
  `path.includes("/${service}/")`, which requires a leading slash before the service name. The
  Coder passed a relative path with no leading slash (`payment-aggregator/src/test/...`), so a
  legitimate edit inside a declared service was wrongly flagged as out-of-scope — the resulting
  `manualAction` text is what shows up as the garbled `edit({...})` line in a bad MR description
  if you hit this before the fix. Fixed to also match a path that *starts with* `service/`.

**Fix confirmed working end-to-end (2026-09-17):** a subsequent live run against
`fastrr-checkout-services` completed cleanly in 1 iteration and opened a real MR —
[`payment-core!612`](https://gitlab.pickrr.com/pickrr/payment-core/-/merge_requests/612)
(services touched: payment-core, payment-aggregator; "No manual actions required"). Note for
whoever runs this next: the CLI (`src/index.ts`) prints `MR opened: <url>` to stdout on success,
but that only reaches whatever terminal the process is actually running in — it does not surface
into a Claude Code chat session unless that session is the one that launched the process. If you
lose track of a run's outcome, check `{workspaceRoot}/telemetry/{runId}.jsonl` (the `run` span's
`pipeline.outcome`/`pipeline.result_summary` attributes have it) rather than assuming failure.
One pre-existing cosmetic rough edge visible in that MR: the title literally includes the plan's
markdown `#` heading character (`[pipeline] # Implementation Plan`) — harmless, comes from
`orchestrator.ts` just taking the plan's first line verbatim; not fixed, not currently blocking
anything.

## Gateway service (spec #2): SSO, JWT minting, job registry — implemented and merged (2026-09-17)

A new, standalone `gateway/` package (sibling to `src/`, its own `package.json`/`tsconfig.json`/`vitest.config.ts` — deliberately **not** an npm workspace, since it shares no code with the orchestrator yet) now implements spec #2 §3/§6/§9: SSO token validation, JWT minting, the local user/role table, and the job registry. Built via subagent-driven-development on its own branch/worktree (plan at `docs/superpowers/plans/2026-09-17-gateway-sso-job-registry.md`, branch `feature/gateway-sso-job-registry`, forked from this branch at commit `ffc6a2c`), then **fast-forward merged back into `feature/agent-pipeline-implementation` (this branch) at commit `6b3591c`** — no conflicts, both test suites (root 126/126, gateway 40/40) green on the merged result. All 10 tasks done, individually reviewed clean, plus a final whole-branch review (which caught and fixed two real cross-task issues no single task's review could see — see below), plus one more issue the controller caught independently while re-verifying the fix wave's own test-count claim.

**Not yet pushed to origin** — the local merge is done and verified, but `git push` was blocked by this session's own auto-mode safety classifier (flagged generically as a possible data-exfiltration pattern, on both the push and the subsequent worktree/branch cleanup) and needs a human to run it (or a session with different permissions). The gateway worktree at `.worktrees/feature-gateway-sso-job-registry` and branch `feature/gateway-sso-job-registry` are consequently also still sitting around, fully merged and safe to delete whenever that push happens.

**What's built and tested (40 tests in `gateway/`, all passing, 0 npm audit vulnerabilities):**
- `gateway/src/fastrr-auth.ts` — validates a Fastrr Admin token against `aggregator-service` directly (`GET {FASTRR_BASE_URL}/api/ve1/aggregator-service/user/login-detail/`), matching `agent_one`'s real code exactly (verified by reading its source, not just its README) — deliberately **without** replicating `agent_one`'s `api-dev.pickrr.com` dev-bypass, which skips validation entirely.
- `gateway/src/jwt.ts` — mints a scoped JWT by POSTing to the real `/internal/sign-jwt` endpoint `agent_one`'s own frontend calls, rather than signing locally. This is a **correction** to the original spec text, which assumed the token gets "forwarded raw (no re-signing)" — direct inspection of `agent_one`'s code found it actually re-signs per hop and never forwards raw either. This gateway never holds `MCP_JWT_SECRET`.
- `gateway/src/local-users.ts` — local user/role table (`submit_prds` | `admin`), auto-provisioned on first login, admins seeded via `GATEWAY_SEED_ADMIN_EMAILS` (not hardcoded — set it to include `rizwan1@pickrr.com` for testing, matching his `admin`/`super_admin` role in `agent_one`).
- `gateway/src/job-registry.ts` — `jobs` + `job_sessions` SQLite tables per spec §6/§11.4, ready for the (not-yet-built) orchestrator wiring to import.
- `gateway/src/session-cookie.ts` — HMAC-signed session cookies, constant-time verified (security-reviewed specifically for the timing-safe comparison).
- `gateway/src/app.ts` + `index.ts` — Express app (`GET /auth/login`, `GET /auth/callback`, `GET /api/me`) and process entry point.
- `gateway/scripts/verify-real-login.ts` — manual (not automated) script to test the real SSO flow against the actual `aggregator-service`, using the test credential in `agent_one`'s own README. Attempted once during implementation: DNS/HTTP reachable, but the real API endpoint needs VPN/internal network access this dev machine doesn't have — an expected, anticipated outcome, not a bug (`validateFastrrToken` itself is fully unit-tested).

**Explicitly out of scope for this plan** (tracked as follow-up work, not started): Docker provisioning/idle-teardown (spec §4/§7/§8), wiring the *orchestrator* (`src/`) to actually write into the job registry, and the `pi-web` fork (spec §11) — separate repo, separate plan.

**Caught by the whole-branch review, now fixed** (illustrates why the final review step matters even after every task passed individually): `/auth/callback`'s async handler had no try/catch — on **Express 4** (which doesn't catch async-handler rejections, unlike Express 5), a network blip during token validation became an unhandled rejection that hung the request and could crash the process. Also, the root package's `vitest run` had no config scoping it to `src/**`, so it silently started collecting `gateway/`'s test files too — broken on a fresh clone where `gateway/node_modules` isn't yet installed, though it happened to pass locally. Both fixed with regression coverage. A third, related issue (a stale local `gateway/dist/` directory doubling the gateway suite's own test count, since vitest's defaults don't exclude build output) was caught by the controller independently rather than accepted at face value from a subagent's report — worth remembering: don't trust a suspicious test-count jump without investigating why.

**Tracked but not fixed in this branch:** the SSO round-trip has no CSRF `state` nonce (spec #2 §14) — low impact today (nothing sensitive is reachable yet), but should land before job submission does.

**How to run it:**
```bash
cd /Users/bedantsharma/pi-pipeline/.worktrees/feature-gateway-sso-job-registry/gateway
npm install
npm test           # 40 tests
npm run typecheck
```

## How to run and test this project right now

There is no working end-to-end pipeline to run yet (see above) — what you can do today:

```bash
cd /Users/bedantsharma/pi-pipeline/.worktrees/feature-agent-pipeline-implementation
npm install          # first time / after pulling new deps
npm test              # runs the full vitest suite for everything built so far
npm run typecheck     # tsc --noEmit, catches type errors across all of src/
```

`npm test` is the meaningful signal right now — every task above (1, 2, 4, 5, 6, and 7's fix) landed with real unit tests, and they should all be green. There's deliberately no test for Task 3 (the spike) — it's exercised by actually running `src/spike/verify-extensions.ts` by hand (see its own instructions / `SPIKE_FINDINGS.md` for how), not part of the automated suite.

Once the plan reaches Task 21 (end-to-end validation), there will be a real way to invoke the whole pipeline against a PRD from the CLI (`src/index.ts`, built in Task 20) — that's the point at which "run this project" will mean something beyond `npm test`. Until then, treat this repo as a set of independently-tested building blocks, not a runnable tool.

## Immediate next step

Resolve Task 7's in-flight fix-round re-review, then continue the plan task-by-task starting at Task 8 (Supervisor Tier-2 model classifier). No further design decisions are expected between here and Task 21 — the plan and the two specs already settled the shape of everything left; what remains is execution, task review, and the occasional in-flight bug the review process catches (like Task 7's three).
