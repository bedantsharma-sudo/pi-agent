# Agent Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Node/TypeScript orchestrator for the agentic coding pipeline — PRD-critic, Planner, Coder, Reviewer, Supervisor — that takes a PRD to a human-reviewable GitLab MR against `fastrr-checkout-services`.

**Architecture:** A single orchestrator process creates and drives five `AgentSession`s via the Pi SDK (`@earendil-works/pi-coding-agent`). Each role gets its own system prompt, scoped tool allowlist, and (for the loop roles) session lifecycle. Every stage transition is a dedicated "submit tool" call. The Supervisor is a `tool_call` hook attached to the loop sessions, not a sixth session. MR creation is a deterministic orchestrator-level `glab` CLI call.

**Tech Stack:** Node.js ≥20, TypeScript (strict, ES2022, NodeNext modules), `@earendil-works/pi-coding-agent` (Pi SDK, installed at `0.85.1`), `typebox` for tool parameter schemas, `vitest` for testing, `pi-mcp-extension` + `pi-memory` + `@blackbelt-technology/pi-agent-dashboard` as Pi extensions, `glab` CLI (external dependency, not npm).

**Spec:** `/Users/bedantsharma/agent-pipeline/docs/superpowers/specs/2026-09-15-agent-pipeline-design.md`

## Global Constraints

- **Don't foreclose the multi-user infra spec** (`/Users/bedantsharma/agent-pipeline/docs/superpowers/specs/2026-09-15-multi-user-infra-design.md`): all credentials/paths/identity come from `RunConfig`, populated from environment variables — never hardcoded. The orchestrator is a pure function of `(RunConfig) -> PipelineResult`, invocable as a clean parameterized unit of work — no module-level mutable state, no assumption of a single fixed filesystem location beyond what `RunConfig` specifies. This is what lets the future gateway spin up one job container per user/run without any rework here.
- **`maxLoopIterations` is a run parameter** (spec §6), default 30, never a hardcoded constant.
- **Every handoff between stages is a dedicated submit tool** whose parameters are the structured artifact (spec §7/§8) — never scrape free-text output.
- **PII/secrets never get logged or committed** — the audit log (§9) stores a PRD hash, not credentials; `.env`/`.spike-workspace/` stay gitignored.
- **TDD**: every task with non-trivial logic starts with a failing test.
- **Tier-1 guardrail rules and the mandatory-tool-use gate must be pure functions** (spec §13), independently unit-testable without mocking Pi's session/event types.

---

## Task 1: Test runner

**Files:**
- Modify: `package.json`
- Create: `src/smoke.test.ts`

**Interfaces:**
- Produces: `npm test` runs vitest; all later tasks assume this works.

- [ ] **Step 1: Install vitest**

```bash
cd /Users/bedantsharma/pi-pipeline && npm install -D vitest
```

- [ ] **Step 2: Add the test script**

In `package.json`, add to `"scripts"`:

```json
"test": "vitest run"
```

- [ ] **Step 3: Write a smoke test**

`src/smoke.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

describe("test runner", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Run it**

Run: `npm test`
Expected: 1 test file, 1 test, PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/smoke.test.ts
git commit -m "test: add vitest test runner"
```

---

## Task 2: RunConfig — shared types and env-var loader

**Files:**
- Create: `src/types.ts`
- Create: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Produces: `RunConfig`, `PlanArtifact`, `ReviewVerdict`, `TestRunResult`, `ManualActionEntry`, `SupervisorReport` (all consumed by every later task); `loadRunConfig(env, input): RunConfig`.

- [ ] **Step 1: Write `src/types.ts`**

```typescript
export interface RunConfig {
  runId: string;
  prdText: string;
  workspaceRoot: string;
  humanIdentity: string;
  maxLoopIterations: number;
  auditLogPath: string;
  memoryDir: string;
  piProjectRoot: string;
}

export interface PlanArtifact {
  planMarkdown: string;
  services: string[];
  notes: string;
}

export interface ReviewVerdict {
  status: "approve" | "revise";
  findings: string[];
}

export interface TestRunResult {
  passed: boolean;
  summary: string;
}

export interface ManualActionEntry {
  attemptedAction: string;
  reason: string;
  requiredManualStep: string;
}

export interface SupervisorReport {
  outcome: "success" | "escalation";
  manualActions: ManualActionEntry[];
  summary: string;
}
```

- [ ] **Step 2: Write the failing test for `loadRunConfig`**

`src/config.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { loadRunConfig } from "./config.js";

const baseEnv = {
  PIPELINE_WORKSPACE_ROOT: "/tmp/workspace",
  PIPELINE_AUDIT_LOG_PATH: "/tmp/workspace/audit.jsonl",
  PIPELINE_MEMORY_DIR: "/tmp/workspace/memory",
  PIPELINE_PROJECT_ROOT: "/tmp/pi-pipeline",
};

describe("loadRunConfig", () => {
  it("builds a RunConfig from env vars and inputs", () => {
    const config = loadRunConfig(baseEnv, { prdText: "Add X", humanIdentity: "alice@example.com" });
    expect(config.workspaceRoot).toBe("/tmp/workspace");
    expect(config.auditLogPath).toBe("/tmp/workspace/audit.jsonl");
    expect(config.memoryDir).toBe("/tmp/workspace/memory");
    expect(config.piProjectRoot).toBe("/tmp/pi-pipeline");
    expect(config.prdText).toBe("Add X");
    expect(config.humanIdentity).toBe("alice@example.com");
    expect(config.maxLoopIterations).toBe(30);
    expect(config.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("honors PIPELINE_MAX_LOOP_ITERATIONS override", () => {
    const config = loadRunConfig(
      { ...baseEnv, PIPELINE_MAX_LOOP_ITERATIONS: "5" },
      { prdText: "Add X", humanIdentity: "alice@example.com" },
    );
    expect(config.maxLoopIterations).toBe(5);
  });

  it("throws a clear error when PIPELINE_WORKSPACE_ROOT is missing", () => {
    const { PIPELINE_WORKSPACE_ROOT, ...rest } = baseEnv;
    expect(() => loadRunConfig(rest, { prdText: "Add X", humanIdentity: "alice@example.com" })).toThrow(
      "PIPELINE_WORKSPACE_ROOT",
    );
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- config.test`
Expected: FAIL — `Cannot find module './config.js'` (file doesn't exist yet).

- [ ] **Step 4: Implement `src/config.ts`**

```typescript
import { randomUUID } from "node:crypto";
import type { RunConfig } from "./types.js";

export interface RunConfigInput {
  prdText: string;
  humanIdentity: string;
}

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function loadRunConfig(env: Record<string, string | undefined>, input: RunConfigInput): RunConfig {
  return {
    runId: randomUUID(),
    prdText: input.prdText,
    humanIdentity: input.humanIdentity,
    workspaceRoot: requireEnv(env, "PIPELINE_WORKSPACE_ROOT"),
    auditLogPath: requireEnv(env, "PIPELINE_AUDIT_LOG_PATH"),
    memoryDir: requireEnv(env, "PIPELINE_MEMORY_DIR"),
    piProjectRoot: requireEnv(env, "PIPELINE_PROJECT_ROOT"),
    maxLoopIterations: env.PIPELINE_MAX_LOOP_ITERATIONS ? Number(env.PIPELINE_MAX_LOOP_ITERATIONS) : 30,
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- config.test`
Expected: 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts src/config.test.ts
git commit -m "feat: add RunConfig type and env-var loader"
```

---

## Task 3: Extension-loading spike (verify before building further)

This is spec §12's flagged risk: confirm `pi-mcp-extension`, `pi-memory`, and `pi-agent-dashboard` actually attach to an SDK-created (headless) session, not just an interactively-spawned one. **Do this before Task 4 onward** — if the mechanism doesn't work as assumed, later tasks' extension-loading code needs to change to match reality, not the other way around.

**Files:**
- Create: `src/spike/verify-extensions.ts`
- Create: `SPIKE_FINDINGS.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `resolveExtensionDir(packageName): string` — the pattern Task 13-16's session factories reuse, corrected if this spike finds it wrong.

- [ ] **Step 1: Install the three extension packages**

```bash
cd /Users/bedantsharma/pi-pipeline && npm install pi-mcp-extension pi-memory @blackbelt-technology/pi-agent-dashboard
```

If any package name doesn't resolve on the registry, stop and confirm the correct package name before continuing (this plan's assumed names come from prior research, not a guarantee).

- [ ] **Step 2: Find the real GitNexus MCP launch command**

This repo's root `CLAUDE.md` (`/Users/bedantsharma/fastrr-checkout-services/CLAUDE.md`) references GitNexus via `npx gitnexus analyze` for indexing — but the spike needs the command that launches GitNexus as an **MCP stdio server**, not the indexer. Check `npx gitnexus --help` in `fastrr-checkout-services`, and the `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` file in that repo, for the exact invocation. Do not guess — if it's not documented, ask before proceeding.

- [ ] **Step 3: Write the spike script**

`src/spike/verify-extensions.ts`:

```typescript
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);

function resolveExtensionDir(packageName: string): string {
  const pkgJsonPath = require.resolve(`${packageName}/package.json`);
  return dirname(pkgJsonPath);
}

async function main() {
  const gitnexusCommand = process.env.GITNEXUS_MCP_COMMAND;
  if (!gitnexusCommand) {
    throw new Error(
      "Set GITNEXUS_MCP_COMMAND to the shell command that launches GitNexus's MCP stdio server " +
        "(see Task 3 Step 2 in the implementation plan for where to find it).",
    );
  }

  const spikeDir = join(process.cwd(), ".spike-workspace");
  await mkdir(spikeDir, { recursive: true });

  // pi-mcp-extension reads its server list from .pi/mcp.json relative to cwd.
  const mcpConfigDir = join(spikeDir, ".pi");
  await mkdir(mcpConfigDir, { recursive: true });
  const [command, ...args] = gitnexusCommand.split(" ");
  await writeFile(
    join(mcpConfigDir, "mcp.json"),
    JSON.stringify(
      { mcpServers: { gitnexus: { command, args, transport: "stdio", lifecycle: "eager" } } },
      null,
      2,
    ),
  );

  const memoryDir = join(spikeDir, "memory");
  await mkdir(memoryDir, { recursive: true });
  process.env.PI_MEMORY_DIR = memoryDir;

  const additionalExtensionPaths = [
    resolveExtensionDir("pi-mcp-extension"),
    resolveExtensionDir("pi-memory"),
    resolveExtensionDir("@blackbelt-technology/pi-agent-dashboard"),
  ];

  const loader = new DefaultResourceLoader({ cwd: spikeDir, additionalExtensionPaths });
  await loader.reload();

  const extensions = loader.getExtensions();
  console.log(
    "Loaded extensions:",
    extensions.map((e) => e.name ?? "(unnamed)"),
  );
  if (extensions.length < 3) {
    throw new Error(
      `Expected 3 extensions to load, got ${extensions.length}. additionalExtensionPaths may need to point ` +
        "at a specific entry file rather than the package root — inspect each resolved directory's " +
        "package.json 'main'/'exports' field, adjust resolveExtensionDir here, and record what actually " +
        "worked in SPIKE_FINDINGS.md.",
    );
  }

  const modelRuntime = await ModelRuntime.create();
  const { session } = await createAgentSession({
    cwd: spikeDir,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(spikeDir),
  });

  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  console.log("\n--- (a) Verifying a GitNexus MCP tool is callable ---");
  await session.prompt(
    "Call whichever tool lets you query the GitNexus knowledge graph, asking a trivial question like " +
      "'what is this repo about'. Report the raw tool result back to me verbatim.",
  );

  console.log("\n--- (b) Verifying pi-memory round-trips ---");
  await session.prompt(
    "Use the memory_write tool to write a note with the exact text 'spike-verification-marker' under any " +
      "key, then use memory_read to read it back and report exactly what you get.",
  );

  const memoryFile = join(memoryDir, "MEMORY.md");
  const memoryContents = await readFile(memoryFile, "utf-8").catch(() => "");
  if (!memoryContents.includes("spike-verification-marker")) {
    throw new Error(
      `Expected ${memoryFile} to contain the marker — pi-memory may not persist to PI_MEMORY_DIR, or uses ` +
        `a different file layout than assumed. Inspect ${memoryDir} directly and record findings.`,
    );
  }

  console.log(
    "\n(a) and (b) passed. For (c): start @blackbelt-technology/pi-agent-dashboard pointed at " +
      `${spikeDir}, open it in a browser, and manually confirm this session appears live and named.`,
  );
}

main().catch((error) => {
  console.error("Spike failed:", error);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Run it**

```bash
GITNEXUS_MCP_COMMAND="<command found in Step 2>" npx tsx src/spike/verify-extensions.ts
```

- [ ] **Step 5: Iterate until (a) and (b) pass**

If the extension-count check or the memory-marker check fails, the error message names what to inspect. Adjust `resolveExtensionDir` (e.g. point at a specific file like `<dir>/dist/index.js` instead of the bare directory) or the `.pi/mcp.json` shape based on the actual error, and re-run. This iteration **is** the task — do not skip past a failure by weakening the assertions.

- [ ] **Step 6: Manually verify (c)**

Install and run `@blackbelt-technology/pi-agent-dashboard` pointed at `.spike-workspace`, per its own README. Open it in a browser and confirm the spike's session shows up, named and live.

- [ ] **Step 7: Record findings**

Write `SPIKE_FINDINGS.md` at the repo root: what worked as documented, what had to change (exact working `additionalExtensionPaths` shape, any config file quirks, whether (c) worked), and update `HANDOVER.md`'s "Key open risk" section to reflect the resolved (or still-open) state.

- [ ] **Step 8: Gitignore the spike workspace and commit**

Add `.spike-workspace/` to `.gitignore`.

```bash
git add .gitignore src/spike/verify-extensions.ts SPIKE_FINDINGS.md HANDOVER.md package.json package-lock.json
git commit -m "spike: verify pi-mcp-extension/pi-memory/pi-agent-dashboard attach to SDK sessions"
```

---

## Task 4: Supervisor Tier-1 guardrail rules (pure functions)

**Files:**
- Create: `src/supervisor/tier1-rules.ts`
- Test: `src/supervisor/tier1-rules.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `checkTier1Rules(toolName: string, input: Record<string, unknown>, allowedServices: string[]): Tier1Match`, consumed by Task 9's guardrail extension.

- [ ] **Step 1: Write the failing tests**

`src/supervisor/tier1-rules.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { checkTier1Rules } from "./tier1-rules.js";

describe("checkTier1Rules", () => {
  it("blocks a bash command that creates a DB index directly", () => {
    const result = checkTier1Rules("bash", { command: "mysql -e 'CREATE INDEX idx_x ON orders(x)'" }, ["fastrr-oms"]);
    expect(result.matched).toBe(true);
    expect(result.reason).toContain("index");
  });

  it("blocks ALTER TABLE", () => {
    const result = checkTier1Rules("bash", { command: "psql -c 'ALTER TABLE orders ADD COLUMN x int'" }, ["fastrr-oms"]);
    expect(result.matched).toBe(true);
  });

  it("blocks DROP TABLE/INDEX/DATABASE", () => {
    expect(checkTier1Rules("bash", { command: "DROP TABLE orders" }, []).matched).toBe(true);
    expect(checkTier1Rules("bash", { command: "DROP INDEX idx_x" }, []).matched).toBe(true);
    expect(checkTier1Rules("bash", { command: "DROP DATABASE fastrr" }, []).matched).toBe(true);
  });

  it("blocks running a schema migration tool directly", () => {
    const result = checkTier1Rules("bash", { command: "flyway migrate" }, []);
    expect(result.matched).toBe(true);
  });

  it("allows an ordinary bash command", () => {
    const result = checkTier1Rules("bash", { command: "mvn test -q" }, []);
    expect(result.matched).toBe(false);
  });

  it("blocks a write/edit outside the plan's declared services", () => {
    const result = checkTier1Rules("write", { path: "/workspace/payment-core/src/Main.java" }, ["aggregator-service"]);
    expect(result.matched).toBe(true);
    expect(result.reason).toContain("out of scope");
  });

  it("allows a write/edit inside a declared service", () => {
    const result = checkTier1Rules("write", { path: "/workspace/aggregator-service/src/Main.java" }, [
      "aggregator-service",
    ]);
    expect(result.matched).toBe(false);
  });

  it("allows any path when allowedServices is empty (not yet known)", () => {
    const result = checkTier1Rules("write", { path: "/workspace/anything/Main.java" }, []);
    expect(result.matched).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tier1-rules.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/supervisor/tier1-rules.ts`**

```typescript
export interface Tier1Match {
  matched: boolean;
  reason?: string;
}

const BANNED_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bCREATE\s+INDEX\b/i,
    reason: "Creating a DB index directly is devops's responsibility in this org (knowledgebase/00-cross-cutting-gotchas.md #5).",
  },
  {
    pattern: /\bALTER\s+TABLE\b/i,
    reason: "Altering table schema directly is devops's responsibility in this org.",
  },
  {
    pattern: /\bDROP\s+(TABLE|INDEX|DATABASE)\b/i,
    reason: "Dropping database objects directly is devops's responsibility in this org.",
  },
  {
    pattern: /\b(flyway\s+migrate|liquibase\s+update)\b/i,
    reason: "Running schema migrations directly is devops's responsibility in this org.",
  },
];

function checkBash(input: Record<string, unknown>): Tier1Match {
  const command = String((input as { command?: string }).command ?? "");
  for (const { pattern, reason } of BANNED_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return { matched: true, reason };
    }
  }
  return { matched: false };
}

function checkFileScope(input: Record<string, unknown>, allowedServices: string[]): Tier1Match {
  if (allowedServices.length === 0) {
    return { matched: false };
  }
  const path = String((input as { path?: string }).path ?? "");
  const inScope = allowedServices.some((service) => path.includes(`/${service}/`));
  if (!inScope) {
    return {
      matched: true,
      reason: `Path "${path}" is out of scope — the plan only names ${allowedServices.join(", ")} as needing changes.`,
    };
  }
  return { matched: false };
}

export function checkTier1Rules(
  toolName: string,
  input: Record<string, unknown>,
  allowedServices: string[],
): Tier1Match {
  if (toolName === "bash") {
    return checkBash(input);
  }
  if (toolName === "write" || toolName === "edit") {
    return checkFileScope(input, allowedServices);
  }
  return { matched: false };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tier1-rules.test`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/tier1-rules.ts src/supervisor/tier1-rules.test.ts
git commit -m "feat: add Supervisor Tier-1 deterministic guardrail rules"
```

---

## Task 5: Supervisor Tier-2 gray-zone matcher (pure function)

**Files:**
- Create: `src/supervisor/tier2-matcher.ts`
- Test: `src/supervisor/tier2-matcher.test.ts`

**Interfaces:**
- Produces: `needsTier2Judgment(toolName: string, input: Record<string, unknown>): boolean`, consumed by Task 9.

- [ ] **Step 1: Write the failing tests**

`src/supervisor/tier2-matcher.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { needsTier2Judgment } from "./tier2-matcher.js";

describe("needsTier2Judgment", () => {
  it("flags writes to a migrations directory", () => {
    expect(needsTier2Judgment("write", { path: "/workspace/fastrr-oms/src/main/resources/migrations/V2.sql" })).toBe(true);
  });

  it("flags writes to scheduler-service", () => {
    expect(needsTier2Judgment("edit", { path: "/workspace/scheduler-service/src/Job.java" })).toBe(true);
  });

  it("flags writes to production/staging properties files", () => {
    expect(needsTier2Judgment("write", { path: "/workspace/aggregator-service/application-prod.properties" })).toBe(true);
  });

  it("flags cron/quartz-related paths", () => {
    expect(needsTier2Judgment("edit", { path: "/workspace/fastrr-oms/src/main/java/CronController.java" })).toBe(true);
  });

  it("does not flag an ordinary service file", () => {
    expect(needsTier2Judgment("edit", { path: "/workspace/aggregator-service/src/main/java/Foo.java" })).toBe(false);
  });

  it("does not flag non-write/edit tools", () => {
    expect(needsTier2Judgment("bash", { command: "mvn test" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tier2-matcher.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/supervisor/tier2-matcher.ts`**

```typescript
const RISKY_PATH_PATTERNS: RegExp[] = [
  /\/migrations?\//i,
  /\/scheduler-service\//i,
  /application-(prod|staging)\.properties$/i,
  /cron|quartz/i,
];

export function needsTier2Judgment(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== "write" && toolName !== "edit") {
    return false;
  }
  const path = String((input as { path?: string }).path ?? "");
  return RISKY_PATH_PATTERNS.some((pattern) => pattern.test(path));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tier2-matcher.test`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/tier2-matcher.ts src/supervisor/tier2-matcher.test.ts
git commit -m "feat: add Supervisor Tier-2 gray-zone matcher"
```

---

## Task 6: Mandatory tool-use tracker and submit gate (pure logic)

**Files:**
- Create: `src/enforcement/tool-tracker.ts`
- Test: `src/enforcement/tool-tracker.test.ts`

**Interfaces:**
- Produces: `SessionToolTracker` class, `checkSubmitGate(tracker, requiredTools): SubmitGateResult`, consumed by Task 10.

- [ ] **Step 1: Write the failing tests**

`src/enforcement/tool-tracker.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { checkSubmitGate, SessionToolTracker } from "./tool-tracker.js";

describe("SessionToolTracker + checkSubmitGate", () => {
  it("blocks when a required tool has not been called", () => {
    const tracker = new SessionToolTracker();
    tracker.recordCall("mcp_gitnexus_query");
    const gate = checkSubmitGate(tracker, ["mcp_gitnexus_query", "memory_read"]);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("memory_read");
  });

  it("allows when all required tools have been called", () => {
    const tracker = new SessionToolTracker();
    tracker.recordCall("mcp_gitnexus_query");
    tracker.recordCall("memory_read");
    const gate = checkSubmitGate(tracker, ["mcp_gitnexus_query", "memory_read"]);
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBeUndefined();
  });

  it("allows immediately when no tools are required", () => {
    const tracker = new SessionToolTracker();
    const gate = checkSubmitGate(tracker, []);
    expect(gate.allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tool-tracker.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/enforcement/tool-tracker.ts`**

```typescript
export class SessionToolTracker {
  private calledTools = new Set<string>();

  recordCall(toolName: string): void {
    this.calledTools.add(toolName);
  }

  hasCalled(toolName: string): boolean {
    return this.calledTools.has(toolName);
  }
}

export interface SubmitGateResult {
  allowed: boolean;
  reason?: string;
}

export function checkSubmitGate(tracker: SessionToolTracker, requiredTools: string[]): SubmitGateResult {
  const missing = requiredTools.filter((tool) => !tracker.hasCalled(tool));
  if (missing.length > 0) {
    return { allowed: false, reason: `Cannot finalize yet — must call these tools first: ${missing.join(", ")}` };
  }
  return { allowed: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tool-tracker.test`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/enforcement/tool-tracker.ts src/enforcement/tool-tracker.test.ts
git commit -m "feat: add mandatory tool-use tracker and submit gate"
```

---

## Task 7: `run_tests` custom tool

**Files:**
- Create: `src/tools/run-tests.ts`
- Test: `src/tools/run-tests.test.ts`

**Interfaces:**
- Consumes: `TestRunResult` (Task 2).
- Produces: `runMavenTests(repoPath: string): Promise<TestRunResult>`, `createRunTestsTool(workspaceRoot: string)`, consumed by Task 15/16 (Coder/Reviewer sessions).

- [ ] **Step 1: Write the failing test**

`src/tools/run-tests.test.ts`:

```typescript
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMavenTests } from "./run-tests.js";

describe("runMavenTests", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "run-tests-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports failure with a summary when mvn is not runnable in the target dir", async () => {
    // No pom.xml present, so `mvn test` fails fast — this exercises the failure path
    // without depending on a real Maven build being available in the test environment.
    const result = await runMavenTests(dir);
    expect(result.passed).toBe(false);
    expect(result.summary.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- run-tests.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/run-tests.ts`**

```typescript
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { TestRunResult } from "../types.js";

const execFileAsync = promisify(execFile);

export async function runMavenTests(repoPath: string): Promise<TestRunResult> {
  try {
    const { stdout } = await execFileAsync("mvn", ["test", "-q"], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024 * 20,
    });
    return { passed: true, summary: stdout.slice(-2000) };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message: string };
    const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim() || err.message;
    return { passed: false, summary: output.slice(-4000) };
  }
}

export function createRunTestsTool(workspaceRoot: string) {
  return defineTool({
    name: "run_tests",
    label: "Run Tests",
    description: "Runs the Maven test suite for the given repo and returns structured pass/fail.",
    parameters: Type.Object({
      repo: Type.String({ description: "Repo directory name relative to the workspace root, e.g. 'aggregator-service'" }),
    }),
    execute: async (_toolCallId, params) => {
      const repoPath = join(workspaceRoot, params.repo);
      const result = await runMavenTests(repoPath);
      return {
        content: [
          {
            type: "text" as const,
            text: result.passed ? `Tests passed.\n${result.summary}` : `Tests FAILED.\n${result.summary}`,
          },
        ],
        details: result,
      };
    },
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- run-tests.test`
Expected: 1 test PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/run-tests.ts src/tools/run-tests.test.ts
git commit -m "feat: add run_tests custom tool"
```

---

## Task 8: Submit-tool factories

**Files:**
- Create: `src/tools/submit-tools.ts`
- Test: `src/tools/submit-tools.test.ts`

**Interfaces:**
- Consumes: `PlanArtifact`, `ReviewVerdict` (Task 2).
- Produces: `SubmissionHolder<T>`, `createFinalizePrdTool`, `createSubmitPlanTool`, `createSubmitForReviewTool`, `createSubmitVerdictTool` — consumed by Task 13-16.

- [ ] **Step 1: Write the failing tests**

`src/tools/submit-tools.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  createFinalizePrdTool,
  createSubmitForReviewTool,
  createSubmitPlanTool,
  createSubmitVerdictTool,
} from "./submit-tools.js";

describe("submit tools", () => {
  it("finalize_prd captures the rewritten PRD into the holder", async () => {
    const holder: { value: string | undefined } = { value: undefined };
    const tool = createFinalizePrdTool(holder);
    await tool.execute("call-1", { rewritten_prd: "Full new PRD text" }, undefined as never, undefined as never, undefined as never);
    expect(holder.value).toBe("Full new PRD text");
  });

  it("submit_plan captures a structured PlanArtifact", async () => {
    const holder: { value: import("../types.js").PlanArtifact | undefined } = { value: undefined };
    const tool = createSubmitPlanTool(holder);
    await tool.execute(
      "call-1",
      { plan_markdown: "# Plan", services: ["aggregator-service"], notes: "Java 11" },
      undefined as never,
      undefined as never,
      undefined as never,
    );
    expect(holder.value).toEqual({ planMarkdown: "# Plan", services: ["aggregator-service"], notes: "Java 11" });
  });

  it("submit_for_review captures a diff summary", async () => {
    const holder: { value: { diffSummary: string } | undefined } = { value: undefined };
    const tool = createSubmitForReviewTool(holder);
    await tool.execute("call-1", { diff_summary: "Added health check" }, undefined as never, undefined as never, undefined as never);
    expect(holder.value).toEqual({ diffSummary: "Added health check" });
  });

  it("submit_verdict captures a structured ReviewVerdict", async () => {
    const holder: { value: import("../types.js").ReviewVerdict | undefined } = { value: undefined };
    const tool = createSubmitVerdictTool(holder);
    await tool.execute("call-1", { status: "revise", findings: ["missing null check"] }, undefined as never, undefined as never, undefined as never);
    expect(holder.value).toEqual({ status: "revise", findings: ["missing null check"] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- submit-tools.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/submit-tools.ts`**

```typescript
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { PlanArtifact, ReviewVerdict } from "../types.js";

export interface SubmissionHolder<T> {
  value: T | undefined;
}

export function createFinalizePrdTool(holder: SubmissionHolder<string>) {
  return defineTool({
    name: "finalize_prd",
    label: "Finalize PRD",
    description:
      "Ends the PRD-critique conversation by submitting the fully rewritten PRD. Only call this after the " +
      "human has explicitly approved.",
    parameters: Type.Object({
      rewritten_prd: Type.String({ description: "The complete PRD, rewritten from scratch" }),
    }),
    execute: async (_toolCallId, params) => {
      holder.value = params.rewritten_prd;
      return { content: [{ type: "text" as const, text: "PRD finalized." }], details: {} };
    },
  });
}

export function createSubmitPlanTool(holder: SubmissionHolder<PlanArtifact>) {
  return defineTool({
    name: "submit_plan",
    label: "Submit Plan",
    description: "Submits the implementation plan for the Coder to work from.",
    parameters: Type.Object({
      plan_markdown: Type.String({ description: "The full plan, in markdown" }),
      services: Type.Array(Type.String(), {
        description: "Repo directory names (relative to the workspace root) that need changes",
      }),
      notes: Type.String({ description: "Additional notes for the Coder, e.g. Java version per service" }),
    }),
    execute: async (_toolCallId, params) => {
      holder.value = { planMarkdown: params.plan_markdown, services: params.services, notes: params.notes };
      return {
        content: [{ type: "text" as const, text: `Plan submitted, targeting: ${params.services.join(", ")}` }],
        details: {},
      };
    },
  });
}

export function createSubmitForReviewTool(holder: SubmissionHolder<{ diffSummary: string }>) {
  return defineTool({
    name: "submit_for_review",
    label: "Submit For Review",
    description:
      "Submits the implemented change for the Reviewer's judgment. Only call this after run_tests has " +
      "reported a passing run.",
    parameters: Type.Object({
      diff_summary: Type.String({ description: "A summary of what changed and why" }),
    }),
    execute: async (_toolCallId, params) => {
      holder.value = { diffSummary: params.diff_summary };
      return { content: [{ type: "text" as const, text: "Submitted for review." }], details: {} };
    },
  });
}

export function createSubmitVerdictTool(holder: SubmissionHolder<ReviewVerdict>) {
  return defineTool({
    name: "submit_verdict",
    label: "Submit Verdict",
    description:
      "Submits the review verdict: 'approve' ends the pipeline loop and opens an MR; 'revise' sends " +
      "findings back to the Planner.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("approve"), Type.Literal("revise")]),
      findings: Type.Array(Type.String(), { description: "Specific issues found, empty if approving" }),
    }),
    execute: async (_toolCallId, params) => {
      holder.value = { status: params.status, findings: params.findings };
      return { content: [{ type: "text" as const, text: `Verdict: ${params.status}` }], details: {} };
    },
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- submit-tools.test`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/submit-tools.ts src/tools/submit-tools.test.ts
git commit -m "feat: add submit-tool factories for stage handoffs"
```

---

## Task 9: Supervisor Tier-2 model classifier

**Files:**
- Create: `src/supervisor/tier2-judgment.ts`

**Interfaces:**
- Consumes: `ModelRuntime`, `getModel` (Pi SDK / `@earendil-works/pi-ai`).
- Produces: `classifyGrayArea(toolName, input): Promise<Tier2Verdict>`, consumed by Task 10.

This task is a thin wrapper around a real model call — it is verified manually/by integration test (Task 19's end-to-end run), not unit-tested with a mocked LLM, since mocking the model call would only test the mock.

- [ ] **Step 1: Implement `src/supervisor/tier2-judgment.ts`**

```typescript
import { getModel } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

export interface Tier2Verdict {
  decision: "allow" | "block" | "flag";
  reason: string;
}

let cachedRuntime: ModelRuntime | undefined;

async function getRuntime(): Promise<ModelRuntime> {
  if (!cachedRuntime) {
    cachedRuntime = await ModelRuntime.create();
  }
  return cachedRuntime;
}

export async function classifyGrayArea(toolName: string, input: Record<string, unknown>): Promise<Tier2Verdict> {
  const runtime = await getRuntime();
  const model = getModel("anthropic", "claude-haiku-4-5");
  if (!model) {
    return { decision: "flag", reason: "Tier-2 classifier model unavailable; flagging for manual review by default." };
  }

  const { session } = await createAgentSession({
    model,
    modelRuntime: runtime,
    tools: [],
    sessionManager: SessionManager.inMemory(),
  });

  let responseText = "";
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      responseText += event.assistantMessageEvent.delta;
    }
  });

  await session.prompt(
    `A coding agent is about to call tool "${toolName}" with input ${JSON.stringify(input)}. This touches a ` +
      "category this org treats carefully (schema/migration files, cron/scheduler code, Kafka topic config, " +
      'secrets, or cross-service DB access). Reply with exactly one word on the first line: "allow" if this ' +
      'looks like a normal, safe code change, "block" if this should not be done by an automated agent and ' +
      'needs a human/devops action instead, or "flag" if it is probably fine but worth a human ' +
      "double-checking before going live. Then on a new line, give a one-sentence reason.",
  );

  const [firstLine, ...rest] = responseText.trim().split("\n");
  const decision = firstLine.trim().toLowerCase();
  const reason = rest.join(" ").trim() || "No reason given by classifier.";

  if (decision === "block" || decision === "flag") {
    return { decision, reason };
  }
  return { decision: "allow", reason };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/supervisor/tier2-judgment.ts
git commit -m "feat: add Supervisor Tier-2 model classifier for gray-zone tool calls"
```

---

## Task 10: Supervisor guardrail extension and mandatory-tools extension

**Files:**
- Create: `src/supervisor/guardrail-extension.ts`
- Create: `src/enforcement/mandatory-tools-extension.ts`
- Test: `src/supervisor/guardrail-extension.test.ts`

**Interfaces:**
- Consumes: `checkTier1Rules` (Task 4), `needsTier2Judgment` (Task 5), `classifyGrayArea` (Task 9), `SessionToolTracker`/`checkSubmitGate` (Task 6), `ManualActionEntry` (Task 2).
- Produces: `AllowedServicesHolder` (mutable `{ services: string[] }`), `createGuardrailExtension(manualActions, allowedServicesHolder): ExtensionFactory`, `createMandatoryToolsExtension(submitToolName, requiredTools): ExtensionFactory` — consumed by Task 14-16 (guardrail) and Task 13/15 (mandatory tools); the holder itself is created and mutated in Task 19/Task 17.

Only the manual-actions accumulation logic is unit-tested directly (it's pure); the `pi.on("tool_call", ...)` wiring itself is exercised by the end-to-end task (Task 19/21), since it needs a real `ExtensionAPI`/`AgentSession` to invoke meaningfully.

- [ ] **Step 1: Write the failing test for the accumulation logic**

`src/supervisor/guardrail-extension.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { evaluateToolCall } from "./guardrail-extension.js";

describe("evaluateToolCall", () => {
  it("blocks and records a Tier-1 violation without calling the model", async () => {
    const manualActions: import("../types.js").ManualActionEntry[] = [];
    const result = await evaluateToolCall(
      "bash",
      { command: "CREATE INDEX idx ON orders(x)" },
      [],
      manualActions,
      async () => {
        throw new Error("classifyGrayArea should not be called for a Tier-1 match");
      },
    );
    expect(result?.block).toBe(true);
    expect(manualActions).toHaveLength(1);
    expect(manualActions[0].reason).toContain("index");
  });

  it("passes through an ordinary tool call untouched", async () => {
    const manualActions: import("../types.js").ManualActionEntry[] = [];
    const result = await evaluateToolCall("bash", { command: "mvn test" }, [], manualActions, async () => {
      throw new Error("classifyGrayArea should not be called");
    });
    expect(result).toBeUndefined();
    expect(manualActions).toHaveLength(0);
  });

  it("blocks and records when Tier-2 classifier returns block", async () => {
    const manualActions: import("../types.js").ManualActionEntry[] = [];
    const result = await evaluateToolCall(
      "write",
      { path: "/workspace/fastrr-oms/migrations/V2.sql" },
      [],
      manualActions,
      async () => ({ decision: "block", reason: "This is a schema migration" }),
    );
    expect(result?.block).toBe(true);
    expect(manualActions).toHaveLength(1);
  });

  it("flags without blocking when Tier-2 classifier returns flag", async () => {
    const manualActions: import("../types.js").ManualActionEntry[] = [];
    const result = await evaluateToolCall(
      "write",
      { path: "/workspace/fastrr-oms/migrations/V2.sql" },
      [],
      manualActions,
      async () => ({ decision: "flag", reason: "Probably fine, double-check before go-live" }),
    );
    expect(result).toBeUndefined();
    expect(manualActions).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- guardrail-extension.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/supervisor/guardrail-extension.ts`**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ManualActionEntry } from "../types.js";
import { checkTier1Rules } from "./tier1-rules.js";
import { needsTier2Judgment } from "./tier2-matcher.js";
import { classifyGrayArea, type Tier2Verdict } from "./tier2-judgment.js";

export interface GuardrailBlockResult {
  block: true;
  reason: string;
}

function recordManualAction(
  manualActions: ManualActionEntry[],
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
): void {
  manualActions.push({
    attemptedAction: `${toolName}(${JSON.stringify(input).slice(0, 200)})`,
    reason,
    requiredManualStep: reason,
  });
}

export async function evaluateToolCall(
  toolName: string,
  input: Record<string, unknown>,
  allowedServices: string[],
  manualActions: ManualActionEntry[],
  classify: (toolName: string, input: Record<string, unknown>) => Promise<Tier2Verdict>,
): Promise<GuardrailBlockResult | undefined> {
  const tier1 = checkTier1Rules(toolName, input, allowedServices);
  if (tier1.matched) {
    recordManualAction(manualActions, toolName, input, tier1.reason ?? "Blocked by Tier-1 guardrail rule");
    return { block: true, reason: tier1.reason ?? "Blocked by Tier-1 guardrail rule" };
  }

  if (needsTier2Judgment(toolName, input)) {
    const verdict = await classify(toolName, input);
    if (verdict.decision === "block") {
      recordManualAction(manualActions, toolName, input, verdict.reason);
      return { block: true, reason: verdict.reason };
    }
    if (verdict.decision === "flag") {
      recordManualAction(manualActions, toolName, input, verdict.reason);
    }
  }

  return undefined;
}

// The Planner's declared services can change across loop iterations (a revision can legitimately
// re-scope the plan), but Coder/Reviewer sessions are created once and persist for the whole loop
// (spec §4) — so this can't be a value captured once at session-creation time. The orchestrator
// mutates `allowedServicesHolder.services` each time a new plan is submitted (see Task 17), and this
// hook reads it fresh on every tool call.
export interface AllowedServicesHolder {
  services: string[];
}

export function createGuardrailExtension(manualActions: ManualActionEntry[], allowedServicesHolder: AllowedServicesHolder) {
  return function guardrailExtension(pi: ExtensionAPI) {
    pi.on("tool_call", async (event) => {
      if (
        isToolCallEventType("bash", event) ||
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event)
      ) {
        return evaluateToolCall(
          event.toolName,
          event.input as Record<string, unknown>,
          allowedServicesHolder.services,
          manualActions,
          classifyGrayArea,
        );
      }
      return undefined;
    });
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- guardrail-extension.test`
Expected: 4 tests PASS.

- [ ] **Step 5: Implement `src/enforcement/mandatory-tools-extension.ts`**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkSubmitGate, SessionToolTracker } from "./tool-tracker.js";

export function createMandatoryToolsExtension(submitToolName: string, requiredTools: string[]) {
  const tracker = new SessionToolTracker();
  return function mandatoryToolsExtension(pi: ExtensionAPI) {
    pi.on("tool_call", (event) => {
      tracker.recordCall(event.toolName);
      if (event.toolName === submitToolName) {
        const gate = checkSubmitGate(tracker, requiredTools);
        if (!gate.allowed) {
          return { block: true as const, reason: gate.reason };
        }
      }
      return undefined;
    });
  };
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/supervisor/guardrail-extension.ts src/supervisor/guardrail-extension.test.ts src/enforcement/mandatory-tools-extension.ts
git commit -m "feat: wire Supervisor guardrail and mandatory-tool-use into tool_call hooks"
```

---

## Task 11: Supervisor report builder

**Files:**
- Create: `src/supervisor/report.ts`
- Test: `src/supervisor/report.test.ts`

**Interfaces:**
- Consumes: `SupervisorReport`, `ManualActionEntry` (Task 2).
- Produces: `buildSuccessReport`, `buildEscalationReport`, `formatReportAsMarkdown` — consumed by Task 17 (loop driver) and Task 18 (MR creation).

- [ ] **Step 1: Write the failing tests**

`src/supervisor/report.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildEscalationReport, buildSuccessReport, formatReportAsMarkdown } from "./report.js";

describe("Supervisor report builders", () => {
  it("builds a success report", () => {
    const report = buildSuccessReport([{ attemptedAction: "a", reason: "b", requiredManualStep: "c" }], "Run summary");
    expect(report.outcome).toBe("success");
    expect(report.manualActions).toHaveLength(1);
    expect(report.summary).toBe("Run summary");
  });

  it("builds an escalation report including PRD, plans, and rejections", () => {
    const report = buildEscalationReport([], "Add feature X", ["plan v1", "plan v2"], ["missing tests", "wrong service"]);
    expect(report.outcome).toBe("escalation");
    expect(report.summary).toContain("Add feature X");
    expect(report.summary).toContain("plan v1");
    expect(report.summary).toContain("missing tests");
  });

  it("formats a success report as markdown with a manual-actions checklist", () => {
    const report = buildSuccessReport([{ attemptedAction: "a", reason: "b", requiredManualStep: "c" }], "All good");
    const markdown = formatReportAsMarkdown(report);
    expect(markdown).toContain("Before taking this live");
    expect(markdown).toContain("**a**: b — c");
  });

  it("formats a report with no manual actions as 'no actions required'", () => {
    const report = buildSuccessReport([], "All good");
    const markdown = formatReportAsMarkdown(report);
    expect(markdown).toContain("No manual actions required");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- report.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/supervisor/report.ts`**

```typescript
import type { ManualActionEntry, SupervisorReport } from "../types.js";

export function buildSuccessReport(manualActions: ManualActionEntry[], runSummary: string): SupervisorReport {
  return { outcome: "success", manualActions, summary: runSummary };
}

export function buildEscalationReport(
  manualActions: ManualActionEntry[],
  prdText: string,
  recentPlans: string[],
  recentRejections: string[],
): SupervisorReport {
  const lines = [
    "## Escalation: iteration cap reached without approval",
    "",
    "### PRD",
    prdText,
    "",
    "### Recent plan versions",
    ...recentPlans.map((plan, index) => `#### Iteration ${index + 1}\n${plan}`),
    "",
    "### Recent Reviewer rejections",
    ...recentRejections.map((rejection) => `- ${rejection}`),
  ];
  return { outcome: "escalation", manualActions, summary: lines.join("\n") };
}

export function formatReportAsMarkdown(report: SupervisorReport): string {
  const header = report.outcome === "success" ? "## Before taking this live" : "## Escalation report";
  const actions =
    report.manualActions.length === 0
      ? "_No manual actions required._"
      : report.manualActions.map((a) => `- **${a.attemptedAction}**: ${a.reason} — ${a.requiredManualStep}`).join("\n");
  return `${header}\n\n${actions}\n\n---\n\n${report.summary}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- report.test`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/report.ts src/supervisor/report.test.ts
git commit -m "feat: add Supervisor report builders (success and escalation)"
```

---

## Task 12: Audit log writer

**Files:**
- Create: `src/audit-log.ts`
- Test: `src/audit-log.test.ts`

**Interfaces:**
- Produces: `hashPrdText(text): string`, `appendAuditLogEntry(path, entry): Promise<void>`, `AuditLogEntry` — consumed by Task 19 (top-level orchestrator).

- [ ] **Step 1: Write the failing tests**

`src/audit-log.test.ts`:

```typescript
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAuditLogEntry, hashPrdText } from "./audit-log.js";

describe("hashPrdText", () => {
  it("is deterministic for the same text", () => {
    expect(hashPrdText("Add feature X")).toBe(hashPrdText("Add feature X"));
  });

  it("differs for different text", () => {
    expect(hashPrdText("Add feature X")).not.toBe(hashPrdText("Add feature Y"));
  });
});

describe("appendAuditLogEntry", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "audit-log-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the file and appends a JSONL entry, including nested directories", async () => {
    const logPath = join(dir, "nested", "audit.jsonl");
    await appendAuditLogEntry(logPath, {
      timestamp: "2026-09-15T00:00:00.000Z",
      humanIdentifier: "alice@example.com",
      runId: "abc-123",
      prdHash: hashPrdText("Add feature X"),
    });
    const contents = await readFile(logPath, "utf-8");
    const entry = JSON.parse(contents.trim());
    expect(entry.humanIdentifier).toBe("alice@example.com");
    expect(entry.runId).toBe("abc-123");
  });

  it("appends a second entry on a subsequent call without clobbering the first", async () => {
    const logPath = join(dir, "audit.jsonl");
    await appendAuditLogEntry(logPath, { timestamp: "t1", humanIdentifier: "alice", runId: "1", prdHash: "h1" });
    await appendAuditLogEntry(logPath, { timestamp: "t2", humanIdentifier: "bob", runId: "2", prdHash: "h2" });
    const lines = (await readFile(logPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- audit-log.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/audit-log.ts`**

```typescript
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface AuditLogEntry {
  timestamp: string;
  humanIdentifier: string;
  runId: string;
  prdHash: string;
}

export function hashPrdText(prdText: string): string {
  return createHash("sha256").update(prdText).digest("hex");
}

export async function appendAuditLogEntry(auditLogPath: string, entry: AuditLogEntry): Promise<void> {
  await mkdir(dirname(auditLogPath), { recursive: true });
  await appendFile(auditLogPath, `${JSON.stringify(entry)}\n`, "utf-8");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- audit-log.test`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/audit-log.ts src/audit-log.test.ts
git commit -m "feat: add append-only audit log writer for PRD approval"
```

---

## Task 13: Extension-loader helper and PRD-critic session factory

**Files:**
- Create: `src/sessions/extension-loader.ts`
- Create: `src/sessions/prd-critic.ts`

**Interfaces:**
- Consumes: `resolveExtensionDir` pattern validated in Task 3 (`SPIKE_FINDINGS.md` — adjust this task's `resolveExtensionDir` if the spike found a different working shape); `createMandatoryToolsExtension` (Task 10); `createFinalizePrdTool` (Task 8); `RunConfig` (Task 2).
- Produces: `buildResourceLoader(options)`, `createPrdCriticSession(config, modelRuntime)` — consumed by Task 19 (orchestrator).

No new unit tests here — this task wires real Pi SDK calls together, which is exercised by the end-to-end task (Task 21), not mocked in isolation.

- [ ] **Step 1: Implement `src/sessions/extension-loader.ts`**

Before writing this, re-read `SPIKE_FINDINGS.md` from Task 3 and match whatever `resolveExtensionDir` shape it found actually works — the version below is the plan's best-guess default, not a guarantee.

```typescript
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);

export function resolveExtensionDir(packageName: string): string {
  return dirname(require.resolve(`${packageName}/package.json`));
}

export interface BuildLoaderOptions {
  cwd: string;
  includeMemory: boolean;
  includeDashboard: boolean;
  systemPrompt?: string;
  extraFactories?: Array<ExtensionFactory | InlineExtension>;
}

export function buildResourceLoader(options: BuildLoaderOptions): DefaultResourceLoader {
  const additionalExtensionPaths = [resolveExtensionDir("pi-mcp-extension")];
  if (options.includeMemory) {
    additionalExtensionPaths.push(resolveExtensionDir("pi-memory"));
  }
  if (options.includeDashboard) {
    additionalExtensionPaths.push(resolveExtensionDir("@blackbelt-technology/pi-agent-dashboard"));
  }
  return new DefaultResourceLoader({
    cwd: options.cwd,
    additionalExtensionPaths,
    extensionFactories: options.extraFactories ?? [],
    ...(options.systemPrompt ? { systemPromptOverride: () => options.systemPrompt! } : {}),
  });
}
```

- [ ] **Step 2: Implement `src/sessions/prd-critic.ts`**

```typescript
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createMandatoryToolsExtension } from "../enforcement/mandatory-tools-extension.js";
import { createFinalizePrdTool, type SubmissionHolder } from "../tools/submit-tools.js";
import type { RunConfig } from "../types.js";
import { buildResourceLoader } from "./extension-loader.js";

const PRD_CRITIC_SYSTEM_PROMPT = `You are the PRD-critic for the fastrr-checkout-services engineering team.

You are the single most important agent in this pipeline: the only line of defense against building the
wrong thing, or building the right thing in a way that fights this codebase's actual architecture. This is a
~20-service Java microservice, multirepo codebase.

Before you finalize any critique, you MUST consult: GitNexus (for call-graph/impact analysis), the fastrr
architecture/context tools (for cross-service and endpoint-flow knowledge), the knowledgebase/ document (for
org-specific gotchas no single service's code reveals on its own), and your own memory (for what you've
learned about this codebase in past sessions). Push back on the PRD with concrete reasoning grounded in what
those tools tell you, not generic software-engineering opinions. Give a recommendation for what CAN be done
and why, not just objections.

When the human explicitly approves, call finalize_prd with the complete PRD rewritten from scratch,
incorporating everything the conversation settled on — not the original text with comments appended. Before
finalizing, write any durable new learning about this codebase to memory with memory_write, so future PRD
sessions start smarter than this one did.`;

const PRD_CRITIC_TOOLS = [
  "mcp_gitnexus_query",
  "mcp_gitnexus_context",
  "mcp_gitnexus_impact",
  "fastrr_context_overview",
  "fastrr_search_context",
  "fastrr_get_context_entities",
  "fastrr_traverse_context",
  "fastrr_architecture_overview",
  "fastrr_get_service",
  "fastrr_trace_endpoint_flow",
  "fastrr_search_skill",
  "fastrr_fetch_skill",
  "fastrr_search_knowledge",
  "read",
  "grep",
  "memory_write",
  "memory_read",
  "memory_search",
  "finalize_prd",
];

const PRD_CRITIC_REQUIRED_BEFORE_FINALIZE = ["mcp_gitnexus_query", "memory_read", "memory_search"];

export interface PrdCriticSessionResult {
  session: AgentSession;
  holder: SubmissionHolder<string>;
}

export async function createPrdCriticSession(
  config: RunConfig,
  modelRuntime: ModelRuntime,
): Promise<PrdCriticSessionResult> {
  const holder: SubmissionHolder<string> = { value: undefined };
  const mandatoryTools = createMandatoryToolsExtension("finalize_prd", PRD_CRITIC_REQUIRED_BEFORE_FINALIZE);

  process.env.PI_MEMORY_DIR = join(config.memoryDir, "prd-critic");

  const loader = buildResourceLoader({
    cwd: config.piProjectRoot,
    includeMemory: true,
    includeDashboard: true,
    systemPrompt: PRD_CRITIC_SYSTEM_PROMPT,
    extraFactories: [mandatoryTools],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    // Loader discovery cwd (extensions/mcp.json) is piProjectRoot, set above via buildResourceLoader.
    // This separate cwd is where built-in read/grep actually operate — the critic needs to read
    // knowledgebase/ and code under the workspace, not the orchestrator's own project directory.
    // (Confirmed independent per the SDK docs: "When you pass a custom ResourceLoader, cwd and
    // agentDir no longer control resource discovery. They still influence... tool path resolution.")
    cwd: config.workspaceRoot,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(config.piProjectRoot),
    customTools: [createFinalizePrdTool(holder)],
    tools: PRD_CRITIC_TOOLS,
  });

  return { session, holder };
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Tool names like `mcp_gitnexus_query`/`fastrr_*` are only validated at runtime against what the MCP servers actually expose — confirm the exact names once GitNexus/fastrr MCP connections are live, per Task 3's findings.)

- [ ] **Step 4: Commit**

```bash
git add src/sessions/extension-loader.ts src/sessions/prd-critic.ts
git commit -m "feat: add resource-loader helper and PRD-critic session factory"
```

---

## Task 14: Planner session factory

**Files:**
- Create: `src/sessions/planner.ts`

**Interfaces:**
- Consumes: `buildResourceLoader` (Task 13), `createSubmitPlanTool` (Task 8), `createGuardrailExtension`/`AllowedServicesHolder` (Task 10), `RunConfig`, `PlanArtifact`, `ManualActionEntry` (Task 2).
- Produces: `createPlannerSession(config, modelRuntime, manualActions, allowedServicesHolder): Promise<{session, holder}>` — consumed by Task 19.

- [ ] **Step 1: Implement `src/sessions/planner.ts`**

```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createGuardrailExtension, type AllowedServicesHolder } from "../supervisor/guardrail-extension.js";
import { createSubmitPlanTool, type SubmissionHolder } from "../tools/submit-tools.js";
import type { ManualActionEntry, PlanArtifact, RunConfig } from "../types.js";
import { buildResourceLoader } from "./extension-loader.js";

const PLANNER_SYSTEM_PROMPT = `You are the Planner for the fastrr-checkout-services engineering team.

Given an approved PRD, research which of the ~20 services need changes. Actively pattern-match against
existing conventions in this codebase — for example, payment reads route through payment-aggregator, not
directly to payment-core; report logic lives in dashboard-service. You are explicitly biased against adding
a new service-to-service or service-to-database connection where an existing endpoint could be reused or
extended instead — use GitNexus and the architecture/context tools to confirm what already exists before
proposing something new. Flag the Java version for each affected service (check its pom.xml — this codebase
has both Java 11 and Java 21 services, and fastrr-common is versioned differently per Java version).

You never write code yourself. When you receive the Reviewer's findings on a later iteration, revise the
plan to address them and call submit_plan again with the updated plan.

Call submit_plan when your plan is ready.`;

const PLANNER_TOOLS = [
  "mcp_gitnexus_query",
  "mcp_gitnexus_context",
  "mcp_gitnexus_impact",
  "fastrr_context_overview",
  "fastrr_search_context",
  "fastrr_get_context_entities",
  "fastrr_traverse_context",
  "fastrr_architecture_overview",
  "fastrr_get_service",
  "fastrr_trace_endpoint_flow",
  "read",
  "grep",
  "submit_plan",
];

export interface PlannerSessionResult {
  session: AgentSession;
  holder: SubmissionHolder<PlanArtifact>;
}

export async function createPlannerSession(
  config: RunConfig,
  modelRuntime: ModelRuntime,
  manualActions: ManualActionEntry[],
  allowedServicesHolder: AllowedServicesHolder,
): Promise<PlannerSessionResult> {
  const holder: SubmissionHolder<PlanArtifact> = { value: undefined };

  const loader = buildResourceLoader({
    cwd: config.piProjectRoot,
    includeMemory: false,
    includeDashboard: true,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    extraFactories: [createGuardrailExtension(manualActions, allowedServicesHolder)],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    // See the PRD-critic factory for why these two cwds are deliberately different.
    cwd: config.workspaceRoot,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(config.piProjectRoot),
    customTools: [createSubmitPlanTool(holder)],
    tools: PLANNER_TOOLS,
  });

  return { session, holder };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/sessions/planner.ts
git commit -m "feat: add Planner session factory"
```

---

## Task 15: Coder session factory

**Files:**
- Create: `src/sessions/coder.ts`

**Interfaces:**
- Consumes: `buildResourceLoader` (Task 13), `createSubmitForReviewTool` (Task 8), `createRunTestsTool` (Task 7), `createMandatoryToolsExtension`, `createGuardrailExtension`/`AllowedServicesHolder` (Task 10), `RunConfig`, `ManualActionEntry`.
- Produces: `createCoderSession(config, modelRuntime, manualActions, allowedServicesHolder): Promise<{session, holder}>` — consumed by Task 19.

- [ ] **Step 1: Implement `src/sessions/coder.ts`**

```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createMandatoryToolsExtension } from "../enforcement/mandatory-tools-extension.js";
import { createGuardrailExtension, type AllowedServicesHolder } from "../supervisor/guardrail-extension.js";
import { createRunTestsTool } from "../tools/run-tests.js";
import { createSubmitForReviewTool, type SubmissionHolder } from "../tools/submit-tools.js";
import type { ManualActionEntry, RunConfig } from "../types.js";
import { buildResourceLoader } from "./extension-loader.js";

const CODER_SYSTEM_PROMPT = `You are the Coder for the fastrr-checkout-services engineering team.

Implement the plan you're given: write the tests first, then the code, for exactly the services named in
the plan. Use GitNexus's impact analysis before editing any existing symbol, per this codebase's own
convention. You cannot call submit_for_review until run_tests reports a passing run for every service you
touched — this is enforced, not optional. If run_tests fails, fix the issue and run it again.

When you receive revised plan instructions after a Reviewer rejection, address every finding before
resubmitting.`;

const CODER_TOOLS = ["bash", "edit", "write", "read", "grep", "mcp_gitnexus_query", "mcp_gitnexus_impact", "run_tests", "submit_for_review"];

export interface CoderSessionResult {
  session: AgentSession;
  holder: SubmissionHolder<{ diffSummary: string }>;
}

export async function createCoderSession(
  config: RunConfig,
  modelRuntime: ModelRuntime,
  manualActions: ManualActionEntry[],
  allowedServicesHolder: AllowedServicesHolder,
): Promise<CoderSessionResult> {
  const holder: SubmissionHolder<{ diffSummary: string }> = { value: undefined };
  const mandatoryTools = createMandatoryToolsExtension("submit_for_review", ["run_tests"]);
  const guardrail = createGuardrailExtension(manualActions, allowedServicesHolder);

  const loader = buildResourceLoader({
    cwd: config.piProjectRoot,
    includeMemory: false,
    includeDashboard: true,
    systemPrompt: CODER_SYSTEM_PROMPT,
    extraFactories: [mandatoryTools, guardrail],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    // See the PRD-critic factory for why these two cwds are deliberately different.
    cwd: config.workspaceRoot,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(config.piProjectRoot),
    customTools: [createSubmitForReviewTool(holder), createRunTestsTool(config.workspaceRoot)],
    tools: CODER_TOOLS,
  });

  return { session, holder };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/sessions/coder.ts
git commit -m "feat: add Coder session factory"
```

---

## Task 16: Reviewer session factory

**Files:**
- Create: `src/sessions/reviewer.ts`

**Interfaces:**
- Consumes: `buildResourceLoader` (Task 13), `createSubmitVerdictTool` (Task 8), `createRunTestsTool` (Task 7), `createGuardrailExtension`/`AllowedServicesHolder` (Task 10), `RunConfig`, `ReviewVerdict`, `ManualActionEntry`.
- Produces: `createReviewerSession(config, modelRuntime, manualActions, allowedServicesHolder): Promise<{session, holder}>` — consumed by Task 19.

- [ ] **Step 1: Implement `src/sessions/reviewer.ts`**

```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createGuardrailExtension, type AllowedServicesHolder } from "../supervisor/guardrail-extension.js";
import { createRunTestsTool } from "../tools/run-tests.js";
import { createSubmitVerdictTool, type SubmissionHolder } from "../tools/submit-tools.js";
import type { ManualActionEntry, ReviewVerdict, RunConfig } from "../types.js";
import { buildResourceLoader } from "./extension-loader.js";

const REVIEWER_SYSTEM_PROMPT = `You are the Reviewer for the fastrr-checkout-services engineering team.

You are deliberately adversarial toward the Coder's work — your job is to find every issue, not to be
agreeable. Never trust the Coder's claim that tests pass: always re-run run_tests yourself for every service
touched, independently. Review the actual diff for correctness, and check whether it respects this
codebase's conventions (use GitNexus to verify blast radius was actually considered).

Call submit_verdict with status "approve" only when you have independently confirmed passing tests and have
no unresolved findings. Otherwise call it with status "revise" and specific, actionable findings — vague
feedback like "needs improvement" is not acceptable; name the exact issue and where it is.`;

const REVIEWER_TOOLS = ["read", "grep", "bash", "mcp_gitnexus_query", "mcp_gitnexus_impact", "run_tests", "submit_verdict"];

export interface ReviewerSessionResult {
  session: AgentSession;
  holder: SubmissionHolder<ReviewVerdict>;
}

export async function createReviewerSession(
  config: RunConfig,
  modelRuntime: ModelRuntime,
  manualActions: ManualActionEntry[],
  allowedServicesHolder: AllowedServicesHolder,
): Promise<ReviewerSessionResult> {
  const holder: SubmissionHolder<ReviewVerdict> = { value: undefined };

  const loader = buildResourceLoader({
    cwd: config.piProjectRoot,
    includeMemory: false,
    includeDashboard: true,
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    extraFactories: [createGuardrailExtension(manualActions, allowedServicesHolder)],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    // See the PRD-critic factory for why these two cwds are deliberately different.
    cwd: config.workspaceRoot,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(config.piProjectRoot),
    customTools: [createSubmitVerdictTool(holder), createRunTestsTool(config.workspaceRoot)],
    tools: REVIEWER_TOOLS,
  });

  return { session, holder };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/sessions/reviewer.ts
git commit -m "feat: add Reviewer session factory"
```

---

## Task 17: Loop driver

**Files:**
- Create: `src/loop.ts`
- Test: `src/loop.test.ts`

**Interfaces:**
- Consumes: session factory result shapes (Task 14-16), `AllowedServicesHolder` (Task 10).
- Produces: `LoopOutcome`, `runLoop(sessions, maxLoopIterations, allowedServicesHolder): Promise<LoopOutcome>` — consumed by Task 19. (The Supervisor's `manualActions` accumulate as a side effect of the guardrail hooks already wired into each session in Tasks 14-16 — `runLoop` does not touch that array directly.)

The loop driver's control flow (fresh-vs-follow-up prompting, iteration counting, termination) is the part worth unit-testing directly, using fake session objects rather than real `AgentSession`s — this keeps the test fast and deterministic while still exercising the actual decision logic.

- [ ] **Step 1: Write the failing tests**

`src/loop.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { runLoop, type LoopSessions } from "./loop.js";
import type { PlanArtifact, ReviewVerdict } from "./types.js";

function makeFakeSessions(script: {
  plans: PlanArtifact[];
  verdicts: ReviewVerdict[];
}): LoopSessions {
  let planIndex = 0;
  let verdictIndex = 0;
  const plannerHolder: { value: PlanArtifact | undefined } = { value: undefined };
  const coderHolder: { value: { diffSummary: string } | undefined } = { value: undefined };
  const reviewerHolder: { value: ReviewVerdict | undefined } = { value: undefined };

  return {
    planner: {
      session: {
        prompt: async () => {
          plannerHolder.value = script.plans[planIndex++];
        },
      } as never,
      holder: plannerHolder,
    },
    coder: {
      session: {
        prompt: async () => {
          coderHolder.value = { diffSummary: "changed something" };
        },
      } as never,
      holder: coderHolder,
    },
    reviewer: {
      session: {
        prompt: async () => {
          reviewerHolder.value = script.verdicts[verdictIndex++];
        },
      } as never,
      holder: reviewerHolder,
    },
  };
}

describe("runLoop", () => {
  it("ends in success on the first iteration when the Reviewer approves immediately", async () => {
    const sessions = makeFakeSessions({
      plans: [{ planMarkdown: "p1", services: ["aggregator-service"], notes: "" }],
      verdicts: [{ status: "approve", findings: [] }],
    });
    const holder = { services: [] as string[] };
    const outcome = await runLoop(sessions, 30, holder);
    expect(outcome.result).toBe("success");
    expect(outcome.iterations).toBe(1);
    expect(holder.services).toEqual(["aggregator-service"]);
  });

  it("loops until approval, feeding revise findings back to the Planner, and keeps allowedServicesHolder current", async () => {
    const sessions = makeFakeSessions({
      plans: [
        { planMarkdown: "p1", services: ["aggregator-service"], notes: "" },
        { planMarkdown: "p2", services: ["aggregator-service", "payment-aggregator"], notes: "" },
      ],
      verdicts: [
        { status: "revise", findings: ["missing null check"] },
        { status: "approve", findings: [] },
      ],
    });
    const holder = { services: [] as string[] };
    const outcome = await runLoop(sessions, 30, holder);
    expect(outcome.result).toBe("success");
    expect(outcome.iterations).toBe(2);
    expect(outcome.rejectionHistory).toEqual(["missing null check"]);
    expect(holder.services).toEqual(["aggregator-service", "payment-aggregator"]);
  });

  it("escalates once maxLoopIterations is reached without approval", async () => {
    const plans = Array.from({ length: 3 }, (_, i) => ({
      planMarkdown: `p${i + 1}`,
      services: ["aggregator-service"],
      notes: "",
    }));
    const verdicts = Array.from({ length: 3 }, () => ({ status: "revise" as const, findings: ["still broken"] }));
    const sessions = makeFakeSessions({ plans, verdicts });
    const outcome = await runLoop(sessions, 3, { services: [] });
    expect(outcome.result).toBe("escalation");
    expect(outcome.iterations).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- loop.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/loop.ts`**

```typescript
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AllowedServicesHolder } from "./supervisor/guardrail-extension.js";
import type { PlanArtifact, ReviewVerdict } from "./types.js";
import type { SubmissionHolder } from "./tools/submit-tools.js";

export interface LoopSessions {
  planner: { session: Pick<AgentSession, "prompt">; holder: SubmissionHolder<PlanArtifact> };
  coder: { session: Pick<AgentSession, "prompt">; holder: SubmissionHolder<{ diffSummary: string }> };
  reviewer: { session: Pick<AgentSession, "prompt">; holder: SubmissionHolder<ReviewVerdict> };
}

export interface LoopOutcome {
  result: "success" | "escalation";
  iterations: number;
  finalPlan: PlanArtifact;
  planHistory: string[];
  rejectionHistory: string[];
}

export async function runLoop(
  sessions: LoopSessions,
  maxLoopIterations: number,
  allowedServicesHolder: AllowedServicesHolder,
): Promise<LoopOutcome> {
  const planHistory: string[] = [];
  const rejectionHistory: string[] = [];

  await sessions.planner.session.prompt("Produce the plan.");
  let plan = sessions.planner.holder.value;
  if (!plan) {
    throw new Error("Planner did not call submit_plan");
  }
  allowedServicesHolder.services = plan.services;

  for (let iteration = 1; iteration <= maxLoopIterations; iteration++) {
    planHistory.push(plan.planMarkdown);

    await sessions.coder.session.prompt(
      `Implement this plan:\n\n${plan.planMarkdown}\n\nTarget services: ${plan.services.join(", ")}\n\n${plan.notes}`,
    );
    if (!sessions.coder.holder.value) {
      throw new Error("Coder did not call submit_for_review");
    }

    await sessions.reviewer.session.prompt(
      `Review this change:\n\n${sessions.coder.holder.value.diffSummary}`,
    );
    const verdict = sessions.reviewer.holder.value;
    if (!verdict) {
      throw new Error("Reviewer did not call submit_verdict");
    }

    if (verdict.status === "approve") {
      return { result: "success", iterations: iteration, finalPlan: plan, planHistory, rejectionHistory };
    }

    rejectionHistory.push(...verdict.findings);

    await sessions.planner.session.prompt(
      `The Reviewer sent this back with findings: ${verdict.findings.join("; ")}. Revise the plan and call submit_plan again.`,
    );
    const revisedPlan = sessions.planner.holder.value;
    if (!revisedPlan) {
      throw new Error("Planner did not call submit_plan on revision");
    }
    plan = revisedPlan;
    allowedServicesHolder.services = plan.services;
  }

  return { result: "escalation", iterations: maxLoopIterations, finalPlan: plan, planHistory, rejectionHistory };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- loop.test`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/loop.ts src/loop.test.ts
git commit -m "feat: add Planner/Coder/Reviewer loop driver with iteration cap"
```

---

## Task 18: MR creation via `glab` CLI

**Files:**
- Create: `src/mr.ts`
- Test: `src/mr.test.ts`

**Interfaces:**
- Consumes: `SupervisorReport`, `formatReportAsMarkdown` (Task 11).
- Produces: `createMergeRequest(options): Promise<{ url: string }>` — consumed by Task 19.

- [ ] **Step 1: Write the failing test**

`src/mr.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createMergeRequest } from "./mr.js";

describe("createMergeRequest", () => {
  it("builds the glab command with title and description and parses the returned URL", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "https://gitlab.example.com/team/repo/-/merge_requests/42\n" });
    const result = await createMergeRequest(
      {
        repoPath: "/workspace/aggregator-service",
        title: "Add health check endpoint",
        description: "## Summary\n\nAdds /health.\n",
        sourceBranch: "feature/health-check",
      },
      exec,
    );
    expect(result.url).toBe("https://gitlab.example.com/team/repo/-/merge_requests/42");
    expect(exec).toHaveBeenCalledWith(
      "glab",
      ["mr", "create", "--title", "Add health check endpoint", "--description", "## Summary\n\nAdds /health.\n", "--source-branch", "feature/health-check", "--fill"],
      { cwd: "/workspace/aggregator-service" },
    );
  });

  it("throws with the raw glab error output when the command fails", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("glab: not authenticated"));
    await expect(
      createMergeRequest(
        { repoPath: "/workspace/aggregator-service", title: "t", description: "d", sourceBranch: "b" },
        exec,
      ),
    ).rejects.toThrow("glab: not authenticated");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- mr.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mr.ts`**

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CreateMergeRequestOptions {
  repoPath: string;
  title: string;
  description: string;
  sourceBranch: string;
}

export type ExecFn = (command: string, args: string[], options: { cwd: string }) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = async (command, args, options) => execFileAsync(command, args, options);

export async function createMergeRequest(
  options: CreateMergeRequestOptions,
  exec: ExecFn = defaultExec,
): Promise<{ url: string }> {
  const { stdout } = await exec(
    "glab",
    [
      "mr",
      "create",
      "--title",
      options.title,
      "--description",
      options.description,
      "--source-branch",
      options.sourceBranch,
      "--fill",
    ],
    { cwd: options.repoPath },
  );
  return { url: stdout.trim() };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- mr.test`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mr.ts src/mr.test.ts
git commit -m "feat: add glab-based MR creation"
```

---

## Task 19: Top-level orchestrator

**Files:**
- Create: `src/orchestrator.ts`

**Interfaces:**
- Consumes: `RunConfig`/`ManualActionEntry` (Task 2), `AllowedServicesHolder` (Task 10), `buildSuccessReport`/`buildEscalationReport`/`formatReportAsMarkdown` (Task 11), `appendAuditLogEntry`/`hashPrdText` (Task 12), `createPrdCriticSession` (Task 13), `createPlannerSession` (Task 14), `createCoderSession` (Task 15), `createReviewerSession` (Task 16), `runLoop` (Task 17), `createMergeRequest` (Task 18).
- Produces: `PipelineResult`, `HumanIo`, `runPipeline(config, io): Promise<PipelineResult>` — consumed by Task 20 (CLI entry point).

This task wires real Pi SDK calls and is exercised end-to-end by Task 21, not unit-tested with mocks — by this point every piece it calls has already been tested independently.

- [ ] **Step 1: Implement `src/orchestrator.ts`**

```typescript
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { appendAuditLogEntry, hashPrdText } from "./audit-log.js";
import { runLoop } from "./loop.js";
import { createMergeRequest } from "./mr.js";
import { createCoderSession } from "./sessions/coder.js";
import { createPlannerSession } from "./sessions/planner.js";
import { createPrdCriticSession } from "./sessions/prd-critic.js";
import { createReviewerSession } from "./sessions/reviewer.js";
import type { AllowedServicesHolder } from "./supervisor/guardrail-extension.js";
import { buildEscalationReport, buildSuccessReport, formatReportAsMarkdown } from "./supervisor/report.js";
import type { ManualActionEntry, RunConfig } from "./types.js";

export interface PipelineResult {
  outcome: "mr_opened" | "escalated";
  mrUrl?: string;
  reportMarkdown: string;
}

export interface HumanIo {
  askHuman: (prompt: string) => Promise<string>;
  isApproved: (humanReply: string) => boolean;
}

export async function runPipeline(config: RunConfig, io: HumanIo): Promise<PipelineResult> {
  const modelRuntime = await ModelRuntime.create();
  const manualActions: ManualActionEntry[] = [];

  // --- Stage 1: PRD-critic (interactive, gated on explicit human approval) ---
  const { session: critic, holder: prdHolder } = await createPrdCriticSession(config, modelRuntime);
  // A human is directly conversing with this session, so its responses must actually reach the
  // terminal — unlike the loop sessions below, which rely on pi-agent-dashboard for visibility
  // instead of raw stdout, since nobody is meant to be watching them turn-by-turn.
  critic.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });
  await critic.prompt(`Here is the PRD to critique:\n\n${config.prdText}`);

  let approved = false;
  while (!approved) {
    const humanReply = await io.askHuman("Respond to the PRD-critic (or type your approval):");
    approved = io.isApproved(humanReply);
    await critic.prompt(humanReply);
  }
  if (!prdHolder.value) {
    throw new Error("PRD-critic did not call finalize_prd after approval");
  }

  await appendAuditLogEntry(config.auditLogPath, {
    timestamp: new Date().toISOString(),
    humanIdentifier: config.humanIdentity,
    runId: config.runId,
    prdHash: hashPrdText(prdHolder.value),
  });

  // --- Stage 2: the autonomous Planner/Coder/Reviewer loop ---
  const allowedServicesHolder: AllowedServicesHolder = { services: [] };
  const planner = await createPlannerSession(config, modelRuntime, manualActions, allowedServicesHolder);
  const coder = await createCoderSession(config, modelRuntime, manualActions, allowedServicesHolder);
  const reviewer = await createReviewerSession(config, modelRuntime, manualActions, allowedServicesHolder);

  await planner.session.prompt(`Approved PRD:\n\n${prdHolder.value}`);

  const outcome = await runLoop({ planner, coder, reviewer }, config.maxLoopIterations, allowedServicesHolder);

  if (outcome.result === "escalation") {
    const report = buildEscalationReport(manualActions, prdHolder.value, outcome.planHistory, outcome.rejectionHistory);
    return { outcome: "escalated", reportMarkdown: formatReportAsMarkdown(report) };
  }

  const report = buildSuccessReport(
    manualActions,
    `Completed in ${outcome.iterations} iteration(s). Services touched: ${outcome.finalPlan.services.join(", ")}.`,
  );
  const reportMarkdown = formatReportAsMarkdown(report);

  const primaryRepo = outcome.finalPlan.services[0];
  if (!primaryRepo) {
    throw new Error("Final plan named no services — cannot open an MR");
  }
  const { url } = await createMergeRequest({
    repoPath: `${config.workspaceRoot}/${primaryRepo}`,
    title: `[pipeline] ${outcome.finalPlan.planMarkdown.split("\n")[0].slice(0, 80)}`,
    description: reportMarkdown,
    sourceBranch: `pipeline/${config.runId}`,
  });

  return { outcome: "mr_opened", mrUrl: url, reportMarkdown };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: add top-level pipeline orchestrator"
```

---

## Task 20: CLI entry point

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `loadRunConfig` (Task 2), `runPipeline` (Task 19).

- [ ] **Step 1: Implement `src/index.ts`**

```typescript
import { createInterface } from "node:readline/promises";
import { loadRunConfig } from "./config.js";
import { runPipeline } from "./orchestrator.js";

async function main() {
  const prdArgIndex = process.argv.indexOf("--prd");
  const humanArgIndex = process.argv.indexOf("--human");
  if (prdArgIndex === -1 || humanArgIndex === -1) {
    console.error("Usage: pi-pipeline --prd <path-to-prd.md> --human <email>");
    process.exitCode = 1;
    return;
  }

  const { readFile } = await import("node:fs/promises");
  const prdText = await readFile(process.argv[prdArgIndex + 1], "utf-8");
  const humanIdentity = process.argv[humanArgIndex + 1];

  const config = loadRunConfig(process.env, { prdText, humanIdentity });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const result = await runPipeline(config, {
    askHuman: (prompt) => rl.question(`${prompt}\n> `),
    isApproved: (reply) => /^(approve|approved|yes|lgtm)$/i.test(reply.trim()),
  });
  rl.close();

  if (result.outcome === "mr_opened") {
    console.log(`MR opened: ${result.mrUrl}`);
  } else {
    console.log("Pipeline escalated — no MR opened. See the report below:");
  }
  console.log(result.reportMarkdown);
}

main().catch((error) => {
  console.error("Pipeline run failed:", error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add CLI entry point for running the pipeline"
```

---

## Task 21: End-to-end validation (spec §13)

Not a unit test — a real run of the full pipeline against a deliberately low-stakes PRD, confirming the pieces actually work together the way Tasks 1-20 assumed.

**Files:**
- Create: `docs/e2e-validation-log.md` (record of what was run and observed)

- [ ] **Step 1: Prepare a low-stakes PRD**

Write a PRD requesting something trivial and safe on one small target repo (per spec §13's example: "add a health-check endpoint"). Save it as a local file, e.g. `/tmp/e2e-prd.md`.

- [ ] **Step 2: Run the pipeline against it**

```bash
PIPELINE_WORKSPACE_ROOT=/Users/bedantsharma/fastrr-checkout-services \
PIPELINE_AUDIT_LOG_PATH=/tmp/pipeline-audit.jsonl \
PIPELINE_MEMORY_DIR=/tmp/pipeline-memory \
PIPELINE_PROJECT_ROOT=/Users/bedantsharma/pi-pipeline \
GITNEXUS_MCP_COMMAND="<from Task 3>" \
npx tsx src/index.ts --prd /tmp/e2e-prd.md --human "your-email@example.com"
```

- [ ] **Step 3: Confirm each gate actually gates**

While the run is in progress or by inspecting its output afterward, confirm:
- The PRD-critic conversation actually blocks `finalize_prd` until GitNexus/memory tools were used this session (try approving immediately before any tool use, in a throwaway second run, and confirm it's rejected).
- `submit_for_review` is blocked if you interrupt the Coder before a passing `run_tests` call.
- Editing a file outside the plan's declared `services` is blocked by the Tier-1 guardrail (deliberately steer a throwaway run toward this to confirm).
- A deliberately-injected bad action (ask the PRD to require something like "add a migration that creates an index") results in a Tier-1 block and shows up in the final report's manual-actions checklist.

- [ ] **Step 4: Confirm the iteration cap**

In a separate throwaway run, set `PIPELINE_MAX_LOOP_ITERATIONS=1` and give the Reviewer a PRD/plan combination virtually guaranteed to need revision, confirming the run ends in `escalated` with a populated `ESCALATION_REPORT`-shaped output rather than looping forever.

- [ ] **Step 5: Confirm MR content**

For the successful run, open the created MR and confirm its description contains the Supervisor's report (manual-actions checklist + run summary), not just the raw diff.

- [ ] **Step 6: Record findings**

Write `docs/e2e-validation-log.md`: what was run, what passed, what didn't match expectations, and any follow-up fixes needed (file those as new tasks appended to this plan, or a new plan, rather than silently patching around them).

- [ ] **Step 7: Commit**

```bash
git add docs/e2e-validation-log.md
git commit -m "docs: record end-to-end pipeline validation run"
```
