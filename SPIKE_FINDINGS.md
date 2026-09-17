# Spike findings: extension loading on a headless SDK session

Task 3 of the implementation plan. Verifies whether `pi-mcp-extension`, `pi-memory`,
and `@blackbelt-technology/pi-agent-dashboard` attach to an `AgentSession` created via
`createAgentSession()` (the SDK path this project's orchestrator uses), as opposed to
one the interactive `pi` CLI spawns.

Run with:

```bash
GITNEXUS_MCP_COMMAND="npx gitnexus mcp" npx tsx src/spike/verify-extensions.ts
```

## Summary

| Check | Result |
|---|---|
| (a) GitNexus MCP tool callable from a headless session | **Confirmed working — but see correction below** |
| (b) pi-memory round-trips (write → read) | **Confirmed working** |
| (c) Session appears live/named in pi-agent-dashboard | **Confirmed NOT working**, at least not out of the box |

> **Correction, added after Task 21 live testing hit `finalize_prd` failing in a loop:**
> `createAgentSession()` alone does **not** make GitNexus tools callable. The plain SDK
> path never fires the `"session_start"` extension event — only `session.bindExtensions()`
> does that (the interactive CLI/TUI/RPC entry points call it; the SDK function itself
> never does), and pi-mcp-extension's eager MCP-server connection (so every
> `mcp_<server>_<tool>` tool's registration) is wired to `"session_start"`, not to
> extension-load time. This spike's own script never called `bindExtensions()` either, so
> (a) passing here was very likely a false positive specific to this dev machine's
> pre-existing `pi` state (see the Credentials note above re: this machine's leftover
> `~/.pi` config) rather than something the mechanism guarantees — re-run today, this
> exact script's session has no `mcp_gitnexus_*` tools until `bindExtensions({})` is
> called explicitly. Two further, compounding issues surfaced fixing this for real, both
> now fixed in `src/sessions/extension-loader.ts`:
> - This machine's globally-registered `pi-mcp-adapter` (see `~/.pi/agent/settings.json`)
>   gets auto-discovered alongside the project-local `pi-mcp-extension` unless
>   `noExtensions: true` is set, and its `session_start` handler throws in a headless
>   context ("Theme not initialized"), which was silently breaking eager MCP startup.
> - pi-mcp-extension re-resolves `.pi/mcp.json` at `session_start` using the *session's*
>   `cwd`, not the `ResourceLoader`'s discovery `cwd` — this project deliberately uses two
>   different `cwd`s (loader cwd = `piProjectRoot`, session cwd = `workspaceRoot`), so
>   `.pi/mcp.json` needs to exist at `workspaceRoot` too, not just `piProjectRoot`.
>
> See `src/sessions/extension-loader.ts`'s `activateSession()` and
> `ensureWorkspaceMcpConfig()` for the actual fixes and how each was confirmed.

The plan's original code sketch (task-3-brief.md Step 3) had two bugs that had to be
fixed before it would even compile/run — see "What had to change" below. Once fixed,
the core mechanism — `DefaultResourceLoader` with `additionalExtensionPaths` pointed at
each package's root directory — works exactly as the plan assumed, for (a) and (b).
(c) does not, and the reason is a real open question, not a spike bug (see below).

## What had to change from the plan's sketch

1. **`DefaultResourceLoaderOptions.agentDir` is required, not optional.** The plan's
   snippet called `new DefaultResourceLoader({ cwd: spikeDir, additionalExtensionPaths })`
   with no `agentDir` — this is a TypeScript compile error against
   `@earendil-works/pi-coding-agent@0.85.1`'s actual type
   (`dist/core/resource-loader.d.ts`: `agentDir: string` is not marked `?`). Fixed by
   passing `agentDir: getAgentDir()` (exported from the package root).

2. **`loader.getExtensions()` returns `LoadExtensionsResult` (`{ extensions, errors,
   runtime }`), not an array.** The plan's snippet did
   `extensions.map(...)`/`extensions.length` directly on the return value, which would
   throw or type-error immediately. Fixed by destructuring
   `const { extensions, errors } = loader.getExtensions();` and using `extensions` from
   there. Also switched the logged field from `e.name` (the `Extension` interface has
   no `name` field) to `e.resolvedPath`, which is the actually-useful identifier for
   debugging.

3. **`resolveExtensionDir(packageName)` returning the bare package root turned out to
   be exactly right, with no fallback needed** — the opposite of what the plan's Step 5
   anticipated ("point at a specific file like `<dir>/dist/index.js`"). All three
   packages declare a `"pi": { "extensions": ["./relative/path.ts"] }` field in their
   `package.json`, and `DefaultResourceLoader`'s package-manager code
   (`readPiManifest` / `resolveLocalExtensionSource` in
   `dist/core/package-manager.js`) resolves that manifest automatically when handed
   the package root. No iteration on `resolveExtensionDir` itself was needed — it's
   already correct as written in the plan and is safe for Task 13-16 to reuse verbatim.

With both bugs fixed, `npx tsc -p tsconfig.json --noEmit` is clean and the script runs
to completion.

## Credentials note

The task brief flagged that `ModelRuntime.create()` needing a working model credential
is a distinct failure mode from extension loading, and asked for it to be reported
separately if hit. It was **not** hit on this machine, but not for the reason the brief
anticipated: `~/.pi/agent/auth.json` is empty (`{}`) and `ANTHROPIC_API_KEY` is unset in
this environment, so an Anthropic credential specifically was not available. However,
this development machine has a pre-existing interactive `pi` install with
`~/.pi/agent/settings.json` configured to use `google/gemini-3.1-pro-preview` as its
model, and a `GEMINI_API_KEY` is set in the shell environment — `ModelRuntime.create()`
picked that up and used it, so `session.prompt()` calls actually ran against Gemini, not
Anthropic. The spike's (a)/(b) results above are genuine model-completed tool calls, not
mocked — but on a machine with no `pi`-ecosystem history at all and no
`ANTHROPIC_API_KEY`/other provider key set, `ModelRuntime.create()` would be expected to
throw for lack of any credential, exactly as the brief anticipated. Task 13-16's session
factories should not assume a model is implicitly available the way this spike run
did — that came from an artifact of this particular developer machine, not something
the SDK guarantees.

## (a) GitNexus MCP tool — confirmed working

The session, created entirely headlessly via `createAgentSession()`, called a real
GitNexus MCP tool (via `pi-mcp-extension` bridging to `npx gitnexus mcp` over stdio,
configured through `<spikeDir>/.pi/mcp.json`) and got back real, well-formed JSON
results (a `query` response with `processes`/`process_symbols`/`definitions`/`timing`).
This confirms the plan's core assumption for (a): MCP tool bridging attaches correctly
to a headless SDK session, no different from an interactive one.

One incidental note for whoever wires this up for real (Task 13-16): the query results
returned were from a *different* indexed repo than `fastrr-checkout-services` (the
paths were TypeScript/Python, not this monorepo's Java services) — `gitnexus mcp`
serves *all* repos registered in this machine's global GitNexus index, and which one
answers a query depends on what's in scope for that query, not on the session's `cwd`
alone. Production session factories will need to either scope the query more precisely
or confirm GitNexus resolves by cwd/path context when actually invoked against a real
project directory — this spike's `.spike-workspace` cwd has no meaningful codebase in
it, so it isn't a representative test of *which* repo gets queried, only that the tool
call mechanism itself works end-to-end.

## (b) pi-memory round-trip — confirmed working

The session called `memory_write` (mode `long_term`) with the marker text, then
`memory_read`, and got the marker back verbatim. Independently confirmed by reading
`<spikeDir>/memory/MEMORY.md` directly after the run — it contains:

```
<!-- 2026-09-15 18:44:01 [01a0a533] -->
spike-verification-marker
```

`PI_MEMORY_DIR` set as an env var before `loader.reload()` is respected — pi-memory
picks it up and writes there rather than any default location. This confirms the
plan's assumption for (b).

**Caching caveat found later (during Task 13 review), noted here for visibility**:
`pi-memory` resolves `PI_MEMORY_DIR` once, at module-import time, into a module-level
cached variable (`node_modules/pi-memory/index.ts:60`) — it does not re-read the env var
on every call. This spike's single round-trip didn't exercise it, but it matters for any
production session factory: setting `PI_MEMORY_DIR` a second time within the same live
process, aiming at a different memory scope, will silently no-op rather than error —
pi-memory keeps using whichever directory was in effect the first time it was imported.
Task 13-16's session factories must assume they are called at most once per process if
they set this env var (true for every `includeMemory: true` factory in the current
plan); a future design that needs multiple distinct memory scopes live in one process
will need process-level isolation (e.g. one process per session), not in-process
reconfiguration of this env var.

**A conflict surfaced during this check that matters for production use**: this
development machine already has a *different, older* copy of `pi-memory` installed
globally at `~/.pi/agent/npm/node_modules/pi-memory` (registered in
`~/.pi/agent/settings.json`'s `packages` list, presumably from prior interactive `pi`
CLI use). `DefaultResourceLoader` auto-discovers and loads *both* copies — the
project-local one from `additionalExtensionPaths` and the global one from settings —
and reports tool-name conflicts (`memory_write`, `memory_read`, `scratchpad`, etc. all
collide) as non-fatal diagnostics in `getExtensions().errors`, not as a hard failure.
Precedence went to whichever loaded first (in this spike, the `additionalExtensionPaths`
entries are merged before the auto-discovered ones, so the project-local copy won and
the round-trip test used the right `PI_MEMORY_DIR`) — but this is load-order-dependent,
not an explicit override. **Task 13-16's session factories should not assume a clean
extension environment**: on any machine that already has `pi`-ecosystem packages
installed globally (a real possibility for anyone on the team who's used `pi`
interactively before), extension loading will silently merge in whatever's globally
configured, and name collisions will be resolved by load order rather than intent. If
this pipeline needs a guaranteed-isolated extension set, `noExtensions: true` on
`DefaultResourceLoaderOptions` (loading only `additionalExtensionPaths`, skipping
auto-discovery) is worth evaluating for the real implementation — this spike does not
use it, to stay faithful to the plan's original snippet, but it directly explains this
finding.

## (c) pi-agent-dashboard visibility — confirmed NOT working

This is a real negative finding, not an unverified one.

The bridge extension (`packages/extension/src/bridge.ts`, resolved via the same
`"pi": {"extensions": [...]}` manifest mechanism as the other two) loads without error
and logs that it discovered an existing dashboard gateway on this machine:

```
[dashboard] endpoint ws+unix:///Users/bedantsharma/.pi/dashboard/gateway-9999.sock:/ (source=rendezvous-record pinned=false)
```

This machine already has `@blackbelt-technology/pi-agent-dashboard`'s Electron app
running (a pre-existing install, unrelated to this spike), with its server listening on
`http://localhost:8000` and a working `/api/health` endpoint. Rather than only doing a
visual "open a browser and look" check (this agent environment has no interactive
display), the spike verified (c) more precisely, at the actual data source a browser
would render: it queried `/api/health` directly, twice — once when the process had
already exited, once during a controlled run modified to stay alive and idle for 8
seconds after finishing its prompts, specifically to rule out a race where the session
just hadn't registered yet.

In both cases, `/api/health` reported the same result: `"activeSessions":1,
"totalSessions":6"`, with the *one* active agent listed being a pre-existing, unrelated
session (`cwd: "/Users/bedantsharma/fastrr-checkout-services/agent"`) that has nothing
to do with this spike. The spike's own session (confirmed session id
`01a0a537-28f5-7131-8c94-e92a629720ea` in the timed run) never appeared in the
dashboard's session list, active or total, despite the bridge extension loading cleanly
and finding a live endpoint.

**This is an open risk, not resolved by this spike.** Plausible causes, not confirmed:

- Session registration may require a real on-disk `SessionManager` (this spike uses
  `SessionManager.inMemory()`, matching the plan's snippet) that the dashboard server
  discovers by scanning a known sessions directory, rather than a push-based handshake
  from the bridge.
- The bridge's endpoint discovery (`source=rendezvous-record pinned=false`) may only be
  a passive "found a socket" step, with actual `session_register` protocol messages
  (seen referenced in the bridge's source) gated behind something this spike didn't
  trigger — e.g. an explicit `/dashboard-connect` command, a `PI_DASHBOARD_SOCKET` env
  var the dashboard normally injects into sessions *it* spawns, or a cwd/project
  association the dashboard requires before it'll track a session.
- `sessionStartEvent` defaults to `{ type: "session_start", reason: "startup" }` inside
  `AgentSession` even when not explicitly passed (confirmed by reading
  `dist/core/agent-session.js`), so a missing `session_start` firing is *not* the
  explanation — the event does fire; something downstream of it isn't completing
  registration.

**Recommendation for Task 13-16**: don't build the dashboard-visibility story on the
assumption that loading the bridge extension is sufficient. Before relying on
`pi-agent-dashboard` for the pipeline's per-user visibility requirement (see
`HANDOVER.md`), do a follow-up spike specifically on *dashboard registration* — with a
real on-disk `SessionManager`, an explicitly-started (not auto-discovered) dashboard
server instance pointed at that workspace, and instrumentation or a debugger on the
bridge's `session_register` path — before writing any dashboard-dependent code.

## Files changed

- `src/spike/verify-extensions.ts` — the spike script (fixed per above)
- `SPIKE_FINDINGS.md` — this file
- `.gitignore` — added `.spike-workspace/`
- `HANDOVER.md` — "Key open risk" section updated to reflect (a)/(b) resolved, (c) now
  a concretely-scoped open risk (see diff there)
- `package.json` / `package-lock.json` — added `pi-mcp-extension`, `pi-memory`,
  `@blackbelt-technology/pi-agent-dashboard` as dependencies
