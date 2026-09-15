# Handover

This is the implementation repo for the agentic coding pipeline: a multi-agent system, built on the [Pi](https://pi.dev) coding harness, that takes a feature from a PRD to a human-reviewable GitLab merge request against `fastrr-checkout-services` — plus the infrastructure to run it safely for a team of 30-40 people at once.

**Nothing is implemented yet.** This repo currently contains only project scaffolding (`package.json`, `tsconfig.json`, an empty `src/index.ts`). Everything below is design context for whoever picks this up next — read this before writing any orchestrator code.

## Where the specs live

Design work happened in a **separate repo**, kept apart from this one deliberately so implementation work doesn't clutter the design history:

`/Users/bedantsharma/agent-pipeline/docs/superpowers/specs/`

Two specs, in dependency order:

1. **`2026-09-15-agent-pipeline-design.md`** — the pipeline itself: the five agents (PRD-critic, Planner, Coder, Reviewer, Supervisor), how they hand off work, tool access, enforcement, and how a run ends (local tests + a GitLab MR, nothing further).
2. **`2026-09-15-multi-user-infra-design.md`** — wraps #1 with SSO and per-user isolation so 30-40 people can run it concurrently on one shared box. Depends on #1; doesn't change how the pipeline itself behaves.

Read both in full before implementing — this document summarizes *why* things were decided, not *what* to build; the specs have the actual detail (schemas, tool tables, section-by-section design).

## Why Pi, and why the SDK (not RPC, not subprocesses)

Pi is fundamentally a **single-agent** harness — there's no native multi-agent orchestration. Its own docs point anyone building a multi-agent app at embedding it via the **Node/TypeScript SDK** (`createAgentSession`) rather than spawning `pi --mode rpc` subprocesses and talking JSONL over stdin/stdout — the docs explicitly say so. That settled the foundational architecture: this repo is a **Node/TypeScript orchestrator** that creates and drives multiple `AgentSession`s, one per pipeline role, not five independent CLI processes.

**One real risk carried forward, not yet resolved**: none of Pi's docs show an explicit example of attaching `pi-mcp-extension` (MCP tool bridging), `pi-memory` (cross-run memory), or `pi-agent-dashboard` (visibility) to a session created *headlessly* via the SDK, as opposed to one the interactive CLI spawned. The extension-loading mechanism (`DefaultResourceLoader` + `additionalExtensionPaths`/`extensionFactories`) is confirmed and generic, and all three ship as standard Pi extensions, so this is expected to work — but it's an inference. **The first real implementation step should be a small spike confirming this**, before writing the full orchestrator (spec #1 §12 has the exact spike shape).

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

## Immediate next step

Per the two specs' own next steps: invoke the `writing-plans` skill against spec #1 (the pipeline) to produce a phased implementation plan — starting with the extension-loading spike flagged above, since it's the cheapest way to de-risk the biggest open assumption before the rest of the build depends on it.
