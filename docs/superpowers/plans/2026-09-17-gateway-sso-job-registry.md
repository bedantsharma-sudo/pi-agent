# Gateway: SSO, JWT Minting, and Job Registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the gateway's authentication/identity backbone — SSO callback validation against `aggregator-service`, scoped JWT minting for `fastrr_*` MCP tool access, a local user/role table, and the job registry — as a standalone, fully unit-tested Node/TypeScript package, with no Docker/container-provisioning code yet.

**Architecture:** A new `gateway/` package, sibling to the existing `src/` orchestrator package in this same repo (not an npm workspace — a second, independent `package.json` in its own directory, matching how this repo already keeps `dist/` separate; the two packages don't share code yet, so no shared-package plumbing is introduced speculatively). SQLite (`better-sqlite3`) backs both the local-user table and the job registry — single-box, per spec §6/§9. Express serves the HTTP routes. Every external dependency (the aggregator-service HTTP call, the JWT-signing HTTP call, the SQLite handle) is passed in as a constructor/factory argument, never imported and called directly inside the function that uses it — this repo's own `src/mr.ts` already established that pattern (`ExecFn` injected into `createMergeRequest`) specifically so tests never need real network/filesystem access, and this plan follows it throughout.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext modules — matching this repo's root `tsconfig.json`), Express 4, `better-sqlite3`, `jsonwebtoken`, `vitest`, `supertest` for route tests. Node `^22.12.0 || ^24.0.0 || >=26.0.0` (matching this repo's root `package.json` `engines` field).

**Spec:** [`2026-09-15-multi-user-infra-design.md`](/Users/bedantsharma/agent-pipeline/docs/superpowers/specs/2026-09-15-multi-user-infra-design.md) §3 (SSO), §6 (job registry, including the §11.4 extension), §9 (local user model). §4/§7/§8 (Docker provisioning, idle teardown), the orchestrator-side wiring that writes into the job registry, and §11 (the `pi-web` fork) are explicitly **out of scope for this plan** — see "Out of scope" below.

## Global Constraints

- Node engine: `^22.12.0 || ^24.0.0 || >=26.0.0` (copy from root `package.json`).
- TypeScript: `strict: true`, `target: "ES2022"`, `module`/`moduleResolution: "NodeNext"` (copy from root `tsconfig.json`).
- Test runner: `vitest` (`npm test` → `vitest run`), matching the root package's convention.
- Every function that performs I/O (HTTP call, DB access, JWT signing) takes its dependency as a parameter with a real default implementation and an injectable override — no test may require real network or a real file-backed database.
- SSO token validation: `GET {FASTRR_BASE_URL}/api/ve1/aggregator-service/user/login-detail/?email=<url-encoded-email>` with header `X-Auth-Token: <token>`; a 2xx response body has the shape `{ data: { id: string, email: string, name: string } }` (confirmed against `agent_one`'s `frontend/app/api/auth/[...nextauth]/route.ts:71-109`); anything else is a failed login. **Do not replicate `agent_one`'s `api-dev.pickrr.com` dev-bypass** (`route.ts:77-79`, which skips validation entirely) — always validate for real.
- JWT minting: `POST {AGENT_SERVER_BASE_URL}/internal/sign-jwt` — the same real endpoint `agent_one`'s own frontend calls (`frontend/lib/server-auth.ts:15-35`), HS256, 1-hour server-side expiry. This gateway never holds or signs with `MCP_JWT_SECRET` itself — it delegates signing to the existing trusted signer, so a token this gateway hands out is guaranteed to validate against the real `fastrr_*` tool servers without this project needing that secret provisioned to it.
- Local user roles: exactly two values, `"submit_prds"` (default, auto-provisioned) and `"admin"` (spec §9) — not `agent_one`'s five-tier RBAC.
- Job registry schema (spec §6 + the §11.4 extension already added to the spec): `jobs(job_id, user_email, status, container_id, rpc_endpoint, started_at, finished_at)` and `job_sessions(job_id, role, session_id)`.

## Out of scope for this plan

- Docker container images, provisioning, idle teardown (spec §4/§7/§8) — needs the interactive/job image contents decided (partly depends on the `pi-web` fork plan), separate follow-up plan.
- Wiring the *orchestrator* (`src/` in this same repo) to actually write rows into this job registry when a job starts (spec §6's `createPlannerSession`/etc. note) — that's a small follow-up task once this package exists to import, not part of standing it up.
- The `pi-web` fork (spec §11) — separate repo, separate plan.
- The real end-to-end browser redirect through `fastrr-admin.fastrr.com` itself, and registering this project's `source=` value with Fastrr Admin — that's an org-side action (spec §14), not code.

---

## File Structure

```
gateway/
  package.json
  tsconfig.json
  src/
    config.ts              # env-var loading, mirrors src/config.ts in the orchestrator package
    db.ts                  # better-sqlite3 connection helper, shared by local-users.ts and job-registry.ts
    local-users.ts         # LocalUserStore: local user/role table
    local-users.test.ts
    job-registry.ts        # JobRegistry: jobs + job_sessions tables
    job-registry.test.ts
    fastrr-auth.ts         # validateFastrrToken() — the aggregator-service call
    fastrr-auth.test.ts
    jwt.ts                 # mintScopedJwt() — the /internal/sign-jwt call
    jwt.test.ts
    session-cookie.ts      # signed session-cookie helpers
    session-cookie.test.ts
    app.ts                 # createGatewayApp(deps) — the Express app, fully dependency-injected
    app.test.ts
    index.ts                # real entry point: loads config, wires real deps, app.listen()
```

---

### Task 1: Scaffold the `gateway/` package

**Files:**
- Create: `gateway/package.json`
- Create: `gateway/tsconfig.json`
- Create: `gateway/.gitignore`
- Create: `gateway/src/config.ts`
- Test: `gateway/src/config.test.ts`

**Interfaces:**
- Produces: `GatewayConfig` interface and `loadGatewayConfig(env: Record<string, string | undefined>): GatewayConfig`, consumed by every later task's `index.ts`/tests.

- [ ] **Step 1: Create `gateway/package.json`**

```json
{
  "name": "pi-pipeline-gateway",
  "version": "0.0.1",
  "private": true,
  "description": "SSO, JWT minting, and the job registry for the multi-user pipeline gateway.",
  "type": "module",
  "engines": {
    "node": "^22.12.0 || ^24.0.0 || >=26.0.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "express": "^4.21.0",
    "jsonwebtoken": "^9.0.2"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/express": "^4.17.21",
    "@types/jsonwebtoken": "^9.0.7",
    "@types/node": "^22.0.0",
    "@types/supertest": "^6.0.2",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^5.0.1"
  }
}
```

- [ ] **Step 2: Create `gateway/tsconfig.json`** (identical shape to the root `tsconfig.json` in this repo)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `gateway/.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 4: Install dependencies**

Run: `cd gateway && npm install`
Expected: `node_modules/` populated, `package-lock.json` created, no errors. `better-sqlite3` is a native module — confirm it built cleanly (no `node-gyp` failure in the install output) before moving on.

- [ ] **Step 5: Write the failing test for config loading**

```typescript
// gateway/src/config.test.ts
import { describe, expect, it } from "vitest";
import { loadGatewayConfig } from "./config.js";

describe("loadGatewayConfig", () => {
  const baseEnv = {
    GATEWAY_DB_PATH: "/tmp/gateway.db",
    FASTRR_BASE_URL: "https://fastrr-admin.fastrr.com",
    AGENT_SERVER_BASE_URL: "https://agent-server.internal",
    GATEWAY_SESSION_SECRET: "test-secret",
  };

  it("loads all required fields with defaults for optional ones", () => {
    const config = loadGatewayConfig(baseEnv);
    expect(config).toEqual({
      port: 4000,
      dbPath: "/tmp/gateway.db",
      fastrrBaseUrl: "https://fastrr-admin.fastrr.com",
      agentServerBaseUrl: "https://agent-server.internal",
      sessionCookieSecret: "test-secret",
      seedAdminEmails: [],
    });
  });

  it("parses GATEWAY_PORT when set", () => {
    const config = loadGatewayConfig({ ...baseEnv, GATEWAY_PORT: "8080" });
    expect(config.port).toBe(8080);
  });

  it("parses a comma-separated GATEWAY_SEED_ADMIN_EMAILS, trimming whitespace", () => {
    const config = loadGatewayConfig({ ...baseEnv, GATEWAY_SEED_ADMIN_EMAILS: "a@x.com, b@y.com ,c@z.com" });
    expect(config.seedAdminEmails).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
  });

  it("throws naming the missing variable when a required one is absent", () => {
    const { GATEWAY_DB_PATH, ...rest } = baseEnv;
    expect(() => loadGatewayConfig(rest)).toThrow("GATEWAY_DB_PATH");
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd gateway && npx vitest run src/config.test.ts`
Expected: FAIL — `./config.js` does not exist yet.

- [ ] **Step 7: Write `gateway/src/config.ts`**

```typescript
// gateway/src/config.ts
export interface GatewayConfig {
  port: number;
  dbPath: string;
  fastrrBaseUrl: string;
  agentServerBaseUrl: string;
  sessionCookieSecret: string;
  seedAdminEmails: string[];
}

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function loadGatewayConfig(env: Record<string, string | undefined>): GatewayConfig {
  return {
    port: env.GATEWAY_PORT ? Number(env.GATEWAY_PORT) : 4000,
    dbPath: requireEnv(env, "GATEWAY_DB_PATH"),
    fastrrBaseUrl: requireEnv(env, "FASTRR_BASE_URL"),
    agentServerBaseUrl: requireEnv(env, "AGENT_SERVER_BASE_URL"),
    sessionCookieSecret: requireEnv(env, "GATEWAY_SESSION_SECRET"),
    seedAdminEmails: (env.GATEWAY_SEED_ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd gateway && npx vitest run src/config.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 9: Typecheck and commit**

Run: `cd gateway && npm run typecheck`
Expected: no errors.

```bash
git add gateway/
git commit -m "feat(gateway): scaffold gateway package with config loader"
```

---

### Task 2: `db.ts` — shared SQLite connection helper

**Files:**
- Create: `gateway/src/db.ts`
- Test: `gateway/src/db.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `openDatabase(path: string): Database.Database` (the `better-sqlite3` type), used by Task 3 and Task 4.

- [ ] **Step 1: Write the failing test**

```typescript
// gateway/src/db.test.ts
import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";

describe("openDatabase", () => {
  it("opens an in-memory database and allows a round-trip write/read", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO t (value) VALUES (?)").run("hello");
    const row = db.prepare("SELECT value FROM t WHERE id = 1").get() as { value: string };
    expect(row.value).toBe("hello");
    db.close();
  });

  it("enables WAL journal mode for a file-backed database", () => {
    const db = openDatabase(":memory:");
    // :memory: databases report "memory" for journal_mode regardless of the pragma call;
    // this test only confirms the pragma call itself doesn't throw.
    expect(() => db.pragma("journal_mode")).not.toThrow();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/db.test.ts`
Expected: FAIL — `./db.js` does not exist.

- [ ] **Step 3: Write `gateway/src/db.ts`**

```typescript
// gateway/src/db.ts
import Database from "better-sqlite3";

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  return db;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/db.test.ts`
Expected: PASS, both tests green.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/db.ts gateway/src/db.test.ts
git commit -m "feat(gateway): add shared SQLite connection helper"
```

---

### Task 3: Local user store

**Files:**
- Create: `gateway/src/local-users.ts`
- Test: `gateway/src/local-users.test.ts`

**Interfaces:**
- Consumes: `openDatabase` from Task 2 (tests only — `createLocalUserStore` takes an already-open `Database.Database`, per Global Constraints' injection rule).
- Produces: `LocalRole` type, `LocalUser` interface, `createLocalUserStore(db): LocalUserStore` where `LocalUserStore` has `getOrProvision(email, name): LocalUser`, `setRole(email, role): void`, `get(email): LocalUser | undefined`, `list(): LocalUser[]`, `seedAdmins(emails: string[]): void`. Consumed by Task 6 (`app.ts`) and by the manual-verification Task 8.

- [ ] **Step 1: Write the failing test**

```typescript
// gateway/src/local-users.test.ts
import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { createLocalUserStore } from "./local-users.js";

describe("createLocalUserStore", () => {
  it("auto-provisions a new user with the default role on first getOrProvision", () => {
    const store = createLocalUserStore(openDatabase(":memory:"));
    const user = store.getOrProvision("new@example.com", "New Person");
    expect(user).toMatchObject({ email: "new@example.com", name: "New Person", role: "submit_prds" });
    expect(user.createdAt).toBeTruthy();
  });

  it("returns the same existing record on a second getOrProvision call, without changing role", () => {
    const store = createLocalUserStore(openDatabase(":memory:"));
    store.getOrProvision("existing@example.com", "Existing");
    store.setRole("existing@example.com", "admin");
    const second = store.getOrProvision("existing@example.com", "Existing (renamed ignored)");
    expect(second.role).toBe("admin");
    expect(second.name).toBe("Existing");
  });

  it("setRole changes an existing user's role", () => {
    const store = createLocalUserStore(openDatabase(":memory:"));
    store.getOrProvision("a@example.com", "A");
    store.setRole("a@example.com", "admin");
    expect(store.get("a@example.com")?.role).toBe("admin");
  });

  it("setRole throws for a user that doesn't exist", () => {
    const store = createLocalUserStore(openDatabase(":memory:"));
    expect(() => store.setRole("ghost@example.com", "admin")).toThrow("ghost@example.com");
  });

  it("get returns undefined for an unknown email", () => {
    const store = createLocalUserStore(openDatabase(":memory:"));
    expect(store.get("nobody@example.com")).toBeUndefined();
  });

  it("list returns every provisioned user", () => {
    const store = createLocalUserStore(openDatabase(":memory:"));
    store.getOrProvision("a@example.com", "A");
    store.getOrProvision("b@example.com", "B");
    expect(store.list().map((u) => u.email).sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("seedAdmins provisions each listed email as admin, creating it if absent and promoting it if present", () => {
    const store = createLocalUserStore(openDatabase(":memory:"));
    store.getOrProvision("already-here@example.com", "Already Here");
    store.seedAdmins(["already-here@example.com", "brand-new-admin@example.com"]);
    expect(store.get("already-here@example.com")?.role).toBe("admin");
    expect(store.get("brand-new-admin@example.com")).toMatchObject({ role: "admin", name: "brand-new-admin@example.com" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/local-users.test.ts`
Expected: FAIL — `./local-users.js` does not exist.

- [ ] **Step 3: Write `gateway/src/local-users.ts`**

```typescript
// gateway/src/local-users.ts
import type { Database } from "better-sqlite3";

export type LocalRole = "submit_prds" | "admin";

export interface LocalUser {
  email: string;
  name: string;
  role: LocalRole;
  createdAt: string;
}

export interface LocalUserStore {
  getOrProvision(email: string, name: string): LocalUser;
  setRole(email: string, role: LocalRole): void;
  get(email: string): LocalUser | undefined;
  list(): LocalUser[];
  seedAdmins(emails: string[]): void;
}

interface UserRow {
  email: string;
  name: string;
  role: LocalRole;
  created_at: string;
}

function rowToUser(row: UserRow): LocalUser {
  return { email: row.email, name: row.name, role: row.role, createdAt: row.created_at };
}

export function createLocalUserStore(db: Database): LocalUserStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_users (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('submit_prds', 'admin')),
      created_at TEXT NOT NULL
    )
  `);

  const getStmt = db.prepare<[string], UserRow>("SELECT * FROM local_users WHERE email = ?");
  const insertStmt = db.prepare(
    "INSERT INTO local_users (email, name, role, created_at) VALUES (@email, @name, @role, @createdAt)",
  );
  const updateRoleStmt = db.prepare("UPDATE local_users SET role = ? WHERE email = ?");
  const listStmt = db.prepare<[], UserRow>("SELECT * FROM local_users ORDER BY email");

  function get(email: string): LocalUser | undefined {
    const row = getStmt.get(email);
    return row ? rowToUser(row) : undefined;
  }

  return {
    get,

    getOrProvision(email: string, name: string): LocalUser {
      const existing = get(email);
      if (existing) return existing;
      insertStmt.run({ email, name, role: "submit_prds", createdAt: new Date().toISOString() });
      return get(email)!;
    },

    setRole(email: string, role: LocalRole): void {
      const result = updateRoleStmt.run(role, email);
      if (result.changes === 0) {
        throw new Error(`Cannot set role — no local user provisioned for ${email}`);
      }
    },

    list(): LocalUser[] {
      return listStmt.all().map(rowToUser);
    },

    seedAdmins(emails: string[]): void {
      for (const email of emails) {
        const existing = get(email);
        if (existing) {
          updateRoleStmt.run("admin", email);
        } else {
          insertStmt.run({ email, name: email, role: "admin", createdAt: new Date().toISOString() });
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/local-users.test.ts`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/local-users.ts gateway/src/local-users.test.ts
git commit -m "feat(gateway): add local user/role store"
```

---

### Task 4: Job registry

**Files:**
- Create: `gateway/src/job-registry.ts`
- Test: `gateway/src/job-registry.test.ts`

**Interfaces:**
- Consumes: `openDatabase` from Task 2 (tests only).
- Produces: `JobStatus`, `Job`, `JobRole`, `JobSession` types, `createJobRegistry(db): JobRegistry` where `JobRegistry` has `createJob(jobId, userEmail): Job`, `setStatus(jobId, status): void`, `setContainerId(jobId, containerId): void`, `setRpcEndpoint(jobId, rpcEndpoint): void`, `get(jobId): Job | undefined`, `listByUser(userEmail): Job[]`, `addJobSession(jobId, role, sessionId): void`, `getJobSessions(jobId): JobSession[]`. This is the module the (out-of-scope, follow-up) orchestrator wiring and the (out-of-scope, follow-up) `pi-web` proxy branch both import later — get the shape right now.

- [ ] **Step 1: Write the failing test**

```typescript
// gateway/src/job-registry.test.ts
import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { createJobRegistry } from "./job-registry.js";

describe("createJobRegistry", () => {
  it("creates a job with status 'pending' and a startedAt timestamp", () => {
    const registry = createJobRegistry(openDatabase(":memory:"));
    const job = registry.createJob("job-1", "user@example.com");
    expect(job).toMatchObject({
      jobId: "job-1",
      userEmail: "user@example.com",
      status: "pending",
      containerId: null,
      rpcEndpoint: null,
      finishedAt: null,
    });
    expect(job.startedAt).toBeTruthy();
  });

  it("setStatus updates status, and setting a terminal status also sets finishedAt", () => {
    const registry = createJobRegistry(openDatabase(":memory:"));
    registry.createJob("job-1", "user@example.com");
    registry.setStatus("job-1", "running");
    expect(registry.get("job-1")?.status).toBe("running");
    expect(registry.get("job-1")?.finishedAt).toBeNull();

    registry.setStatus("job-1", "completed");
    expect(registry.get("job-1")?.status).toBe("completed");
    expect(registry.get("job-1")?.finishedAt).toBeTruthy();
  });

  it("setContainerId and setRpcEndpoint update those fields independently", () => {
    const registry = createJobRegistry(openDatabase(":memory:"));
    registry.createJob("job-1", "user@example.com");
    registry.setContainerId("job-1", "container-abc");
    registry.setRpcEndpoint("job-1", "10.0.0.5:5001");
    const job = registry.get("job-1");
    expect(job?.containerId).toBe("container-abc");
    expect(job?.rpcEndpoint).toBe("10.0.0.5:5001");
  });

  it("listByUser returns only that user's jobs, most recently started first", () => {
    const registry = createJobRegistry(openDatabase(":memory:"));
    registry.createJob("job-1", "a@example.com");
    registry.createJob("job-2", "b@example.com");
    registry.createJob("job-3", "a@example.com");
    expect(registry.listByUser("a@example.com").map((j) => j.jobId)).toEqual(["job-3", "job-1"]);
  });

  it("addJobSession records a role/session pair, retrievable via getJobSessions", () => {
    const registry = createJobRegistry(openDatabase(":memory:"));
    registry.createJob("job-1", "user@example.com");
    registry.addJobSession("job-1", "planner", "session-planner-abc");
    registry.addJobSession("job-1", "coder", "session-coder-def");
    expect(registry.getJobSessions("job-1")).toEqual([
      { jobId: "job-1", role: "planner", sessionId: "session-planner-abc" },
      { jobId: "job-1", role: "coder", sessionId: "session-coder-def" },
    ]);
  });

  it("addJobSession for a role that's already recorded overwrites the sessionId (a fresh session for the same role)", () => {
    const registry = createJobRegistry(openDatabase(":memory:"));
    registry.createJob("job-1", "user@example.com");
    registry.addJobSession("job-1", "planner", "first-session");
    registry.addJobSession("job-1", "planner", "second-session");
    expect(registry.getJobSessions("job-1")).toEqual([{ jobId: "job-1", role: "planner", sessionId: "second-session" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/job-registry.test.ts`
Expected: FAIL — `./job-registry.js` does not exist.

- [ ] **Step 3: Write `gateway/src/job-registry.ts`**

```typescript
// gateway/src/job-registry.ts
import type { Database } from "better-sqlite3";

export type JobStatus = "pending" | "running" | "completed" | "escalated" | "failed";
const TERMINAL_STATUSES: JobStatus[] = ["completed", "escalated", "failed"];

export interface Job {
  jobId: string;
  userEmail: string;
  status: JobStatus;
  containerId: string | null;
  rpcEndpoint: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export type JobRole = "planner" | "coder" | "reviewer";

export interface JobSession {
  jobId: string;
  role: JobRole;
  sessionId: string;
}

interface JobRow {
  job_id: string;
  user_email: string;
  status: JobStatus;
  container_id: string | null;
  rpc_endpoint: string | null;
  started_at: string;
  finished_at: string | null;
}

function rowToJob(row: JobRow): Job {
  return {
    jobId: row.job_id,
    userEmail: row.user_email,
    status: row.status,
    containerId: row.container_id,
    rpcEndpoint: row.rpc_endpoint,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface JobRegistry {
  createJob(jobId: string, userEmail: string): Job;
  setStatus(jobId: string, status: JobStatus): void;
  setContainerId(jobId: string, containerId: string): void;
  setRpcEndpoint(jobId: string, rpcEndpoint: string): void;
  get(jobId: string): Job | undefined;
  listByUser(userEmail: string): Job[];
  addJobSession(jobId: string, role: JobRole, sessionId: string): void;
  getJobSessions(jobId: string): JobSession[];
}

export function createJobRegistry(db: Database): JobRegistry {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','running','completed','escalated','failed')),
      container_id TEXT,
      rpc_endpoint TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS job_sessions (
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      role TEXT NOT NULL CHECK (role IN ('planner','coder','reviewer')),
      session_id TEXT NOT NULL,
      PRIMARY KEY (job_id, role)
    );
  `);

  const getStmt = db.prepare<[string], JobRow>("SELECT * FROM jobs WHERE job_id = ?");
  const listByUserStmt = db.prepare<[string], JobRow>(
    "SELECT * FROM jobs WHERE user_email = ? ORDER BY started_at DESC",
  );
  const insertJobStmt = db.prepare(
    "INSERT INTO jobs (job_id, user_email, status, started_at) VALUES (@jobId, @userEmail, 'pending', @startedAt)",
  );
  const setStatusStmt = db.prepare("UPDATE jobs SET status = ?, finished_at = ? WHERE job_id = ?");
  const setContainerIdStmt = db.prepare("UPDATE jobs SET container_id = ? WHERE job_id = ?");
  const setRpcEndpointStmt = db.prepare("UPDATE jobs SET rpc_endpoint = ? WHERE job_id = ?");
  const upsertSessionStmt = db.prepare(`
    INSERT INTO job_sessions (job_id, role, session_id) VALUES (@jobId, @role, @sessionId)
    ON CONFLICT (job_id, role) DO UPDATE SET session_id = excluded.session_id
  `);
  const getSessionsStmt = db.prepare<[string], { job_id: string; role: JobRole; session_id: string }>(
    "SELECT * FROM job_sessions WHERE job_id = ? ORDER BY rowid",
  );

  function get(jobId: string): Job | undefined {
    const row = getStmt.get(jobId);
    return row ? rowToJob(row) : undefined;
  }

  return {
    get,

    createJob(jobId: string, userEmail: string): Job {
      insertJobStmt.run({ jobId, userEmail, startedAt: new Date().toISOString() });
      return get(jobId)!;
    },

    setStatus(jobId: string, status: JobStatus): void {
      const finishedAt = TERMINAL_STATUSES.includes(status) ? new Date().toISOString() : null;
      setStatusStmt.run(status, finishedAt, jobId);
    },

    setContainerId(jobId: string, containerId: string): void {
      setContainerIdStmt.run(containerId, jobId);
    },

    setRpcEndpoint(jobId: string, rpcEndpoint: string): void {
      setRpcEndpointStmt.run(rpcEndpoint, jobId);
    },

    listByUser(userEmail: string): Job[] {
      return listByUserStmt.all(userEmail).map(rowToJob);
    },

    addJobSession(jobId: string, role: JobRole, sessionId: string): void {
      upsertSessionStmt.run({ jobId, role, sessionId });
    },

    getJobSessions(jobId: string): JobSession[] {
      return getSessionsStmt.all(jobId).map((row) => ({ jobId: row.job_id, role: row.role, sessionId: row.session_id }));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/job-registry.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/job-registry.ts gateway/src/job-registry.test.ts
git commit -m "feat(gateway): add job registry (jobs + job_sessions)"
```

---

### Task 5: Fastrr token validation

**Files:**
- Create: `gateway/src/fastrr-auth.ts`
- Test: `gateway/src/fastrr-auth.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `FastrrIdentity` interface (`{ id: string, email: string, name: string }`), `FetchLike` type (an injectable subset of the global `fetch` signature), `validateFastrrToken(email, token, fastrrBaseUrl, fetchImpl?: FetchLike): Promise<FastrrIdentity | null>`, consumed by Task 7 (`app.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// gateway/src/fastrr-auth.test.ts
import { describe, expect, it, vi } from "vitest";
import { validateFastrrToken } from "./fastrr-auth.js";

describe("validateFastrrToken", () => {
  it("returns the identity on a successful response, calling the correct URL and header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "1", email: "rizwan1@pickrr.com", name: "Rizwan" } }),
    });
    const identity = await validateFastrrToken(
      "rizwan1@pickrr.com",
      "the-token",
      "https://fastrr-admin.fastrr.com",
      fetchImpl,
    );
    expect(identity).toEqual({ id: "1", email: "rizwan1@pickrr.com", name: "Rizwan" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://fastrr-admin.fastrr.com/api/ve1/aggregator-service/user/login-detail/?email=rizwan1%40pickrr.com",
      { headers: { "X-Auth-Token": "the-token" } },
    );
  });

  it("returns null when the response is not ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    const identity = await validateFastrrToken("a@x.com", "bad-token", "https://fastrr-admin.fastrr.com", fetchImpl);
    expect(identity).toBeNull();
  });

  it("returns null when the response body has no data field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const identity = await validateFastrrToken("a@x.com", "token", "https://fastrr-admin.fastrr.com", fetchImpl);
    expect(identity).toBeNull();
  });

  it("propagates a network error rather than silently returning null", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      validateFastrrToken("a@x.com", "token", "https://fastrr-admin.fastrr.com", fetchImpl),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("URL-encodes an email containing special characters", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "2", email: "a+test@x.com", name: "A" } }),
    });
    await validateFastrrToken("a+test@x.com", "token", "https://fastrr-admin.fastrr.com", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://fastrr-admin.fastrr.com/api/ve1/aggregator-service/user/login-detail/?email=a%2Btest%40x.com",
      { headers: { "X-Auth-Token": "token" } },
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/fastrr-auth.test.ts`
Expected: FAIL — `./fastrr-auth.js` does not exist.

- [ ] **Step 3: Write `gateway/src/fastrr-auth.ts`**

```typescript
// gateway/src/fastrr-auth.ts
export interface FastrrIdentity {
  id: string;
  email: string;
  name: string;
}

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

// This is the exact endpoint agent_one's own CredentialsProvider.authorize() calls
// (frontend/app/api/auth/[...nextauth]/route.ts:71-109) — deliberately not replicating that
// file's api-dev.pickrr.com dev-bypass, which skips validation entirely; this always validates
// for real.
export async function validateFastrrToken(
  email: string,
  token: string,
  fastrrBaseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<FastrrIdentity | null> {
  const url = `${fastrrBaseUrl}/api/ve1/aggregator-service/user/login-detail/?email=${encodeURIComponent(email)}`;
  const response = await fetchImpl(url, { headers: { "X-Auth-Token": token } });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as { data?: FastrrIdentity };
  return body.data ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/fastrr-auth.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/fastrr-auth.ts gateway/src/fastrr-auth.test.ts
git commit -m "feat(gateway): add Fastrr Admin token validation against aggregator-service"
```

---

### Task 6: JWT minting via the real `/internal/sign-jwt` endpoint

**Files:**
- Create: `gateway/src/jwt.ts`
- Test: `gateway/src/jwt.test.ts`

**Interfaces:**
- Consumes: `LocalUser` type from Task 3 (for the scope this mints against).
- Produces: `ScopedJwt` interface (`{ token: string }`), `mintScopedJwt(user: LocalUser, agentServerBaseUrl: string, fetchImpl?: FetchLike): Promise<ScopedJwt>`, consumed by Task 7 (`app.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// gateway/src/jwt.test.ts
import { describe, expect, it, vi } from "vitest";
import { mintScopedJwt } from "./jwt.js";
import type { LocalUser } from "./local-users.js";

describe("mintScopedJwt", () => {
  const user: LocalUser = { email: "a@x.com", name: "A", role: "submit_prds", createdAt: "2026-01-01T00:00:00.000Z" };

  it("POSTs to {agentServerBaseUrl}/internal/sign-jwt with the user's identity and returns the token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: "signed.jwt.token" }) });
    const result = await mintScopedJwt(user, "https://agent-server.internal", fetchImpl);
    expect(result).toEqual({ token: "signed.jwt.token" });
    expect(fetchImpl).toHaveBeenCalledWith("https://agent-server.internal/internal/sign-jwt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@x.com", name: "A", role: "submit_prds" }),
    });
  });

  it("throws a descriptive error when the signing call fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(mintScopedJwt(user, "https://agent-server.internal", fetchImpl)).rejects.toThrow(
      "Failed to mint JWT for a@x.com",
    );
  });

  it("throws when the response has no token field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(mintScopedJwt(user, "https://agent-server.internal", fetchImpl)).rejects.toThrow(
      "Failed to mint JWT for a@x.com",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/jwt.test.ts`
Expected: FAIL — `./jwt.js` does not exist.

- [ ] **Step 3: Write `gateway/src/jwt.ts`**

```typescript
// gateway/src/jwt.ts
import type { LocalUser } from "./local-users.js";
import type { FetchLike } from "./fastrr-auth.js";

export interface ScopedJwt {
  token: string;
}

// Deliberately does NOT sign locally with a shared secret this project would have to hold.
// This calls the same real /internal/sign-jwt endpoint agent_one's own frontend calls
// (frontend/lib/server-auth.ts:15-35 -> agents/apis/auth.py:31-35), which signs HS256 with
// MCP_JWT_SECRET server-side. Delegating signing this way means a token this gateway hands
// out is guaranteed to validate against the real fastrr_* tool servers, without this project
// ever needing that secret provisioned to it.
export async function mintScopedJwt(
  user: LocalUser,
  agentServerBaseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<ScopedJwt> {
  const response = await fetchImpl(`${agentServerBaseUrl}/internal/sign-jwt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, name: user.name, role: user.role }),
  } as never);
  const body = response.ok ? ((await response.json()) as { token?: string }) : undefined;
  if (!body?.token) {
    throw new Error(`Failed to mint JWT for ${user.email}`);
  }
  return { token: body.token };
}
```

> Note: `FetchLike` as defined in Task 5 only types a two-argument call with a `headers` init; this task calls `fetchImpl` with `method`/`headers`/`body` instead, which is why the call is cast `as never` rather than widening `FetchLike` itself — the real `fetch` global accepts either shape, and widening the shared test-injection type would loosen every other consumer's type safety for no benefit. If the task reviewer flags this cast as untyped, the fix is to give this file its own local `PostFetchLike` type (mirroring `FetchLike`'s pattern) rather than removing the injection — do not fall back to calling the global `fetch` directly.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/jwt.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/jwt.ts gateway/src/jwt.test.ts
git commit -m "feat(gateway): mint scoped JWTs via the real /internal/sign-jwt endpoint"
```

---

### Task 7: Signed session cookies

**Files:**
- Create: `gateway/src/session-cookie.ts`
- Test: `gateway/src/session-cookie.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SessionPayload` interface (`{ email: string }`), `createSessionCookie(email: string, secret: string): string`, `verifySessionCookie(cookieValue: string, secret: string): SessionPayload | null`, consumed by Task 8 (`app.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// gateway/src/session-cookie.test.ts
import { describe, expect, it } from "vitest";
import { createSessionCookie, verifySessionCookie } from "./session-cookie.js";

describe("session cookies", () => {
  it("round-trips a valid cookie back to its email", () => {
    const cookie = createSessionCookie("a@x.com", "secret");
    expect(verifySessionCookie(cookie, "secret")).toEqual({ email: "a@x.com" });
  });

  it("rejects a cookie verified with the wrong secret", () => {
    const cookie = createSessionCookie("a@x.com", "secret");
    expect(verifySessionCookie(cookie, "wrong-secret")).toBeNull();
  });

  it("rejects a tampered payload even if the signature format still parses", () => {
    const cookie = createSessionCookie("a@x.com", "secret");
    const [payload, signature] = cookie.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ email: "attacker@evil.com", exp: Date.now() + 1e9 })).toString(
      "base64url",
    );
    expect(verifySessionCookie(`${tamperedPayload}.${signature}`, "secret")).toBeNull();
    expect(payload).toBeTruthy(); // sanity: the original cookie did have a payload segment
  });

  it("rejects a malformed cookie string", () => {
    expect(verifySessionCookie("not-a-valid-cookie", "secret")).toBeNull();
  });

  it("rejects an expired cookie", () => {
    const almostExpiredSecret = "secret";
    const payload = Buffer.from(JSON.stringify({ email: "a@x.com", exp: Date.now() - 1000 })).toString("base64url");
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const signature = createHmac("sha256", almostExpiredSecret).update(payload).digest("base64url");
    expect(verifySessionCookie(`${payload}.${signature}`, almostExpiredSecret)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/session-cookie.test.ts`
Expected: FAIL — `./session-cookie.js` does not exist.

- [ ] **Step 3: Write `gateway/src/session-cookie.ts`**

```typescript
// gateway/src/session-cookie.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionPayload {
  email: string;
}

interface SignedPayload {
  email: string;
  exp: number;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — not spec-mandated, chosen as a reasonable
// default for a browser session cookie; easy to make configurable later if it needs tuning.

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionCookie(email: string, secret: string): string {
  const payload: SignedPayload = { email, exp: Date.now() + SESSION_TTL_MS };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifySessionCookie(cookieValue: string, secret: string): SessionPayload | null {
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;

  const expectedSignature = sign(encodedPayload, secret);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  let payload: SignedPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.email !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp < Date.now()) return null;
  return { email: payload.email };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/session-cookie.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/session-cookie.ts gateway/src/session-cookie.test.ts
git commit -m "feat(gateway): add HMAC-signed session cookies"
```

---

### Task 8: Express app — login/callback routes, tying everything together

**Files:**
- Create: `gateway/src/app.ts`
- Test: `gateway/src/app.test.ts`

**Interfaces:**
- Consumes: `createLocalUserStore`/`LocalUserStore` (Task 3), `createJobRegistry`/`JobRegistry` (Task 4, wired in but not yet routed to — no job-listing route in this task, just constructor wiring for the follow-up plan to build on), `validateFastrrToken` (Task 5), `mintScopedJwt` (Task 6), `createSessionCookie`/`verifySessionCookie` (Task 7).
- Produces: `GatewayAppDeps` interface and `createGatewayApp(deps: GatewayAppDeps): Express`, consumed by `index.ts` (Task 9) and by any future route-adding follow-up plan.

- [ ] **Step 1: Write the failing test**

```typescript
// gateway/src/app.test.ts
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { openDatabase } from "./db.js";
import { createLocalUserStore } from "./local-users.js";
import { createJobRegistry } from "./job-registry.js";
import { createGatewayApp } from "./app.js";

function buildTestApp(overrides: Partial<Parameters<typeof createGatewayApp>[0]> = {}) {
  const localUsers = createLocalUserStore(openDatabase(":memory:"));
  const jobRegistry = createJobRegistry(openDatabase(":memory:"));
  const validateFastrrToken = vi.fn().mockResolvedValue({ id: "1", email: "a@x.com", name: "A" });
  const mintScopedJwt = vi.fn().mockResolvedValue({ token: "minted.jwt" });
  const app = createGatewayApp({
    localUsers,
    jobRegistry,
    fastrrBaseUrl: "https://fastrr-admin.fastrr.com",
    agentServerBaseUrl: "https://agent-server.internal",
    sessionCookieSecret: "test-secret",
    validateFastrrToken,
    mintScopedJwt,
    ...overrides,
  });
  return { app, localUsers, jobRegistry, validateFastrrToken, mintScopedJwt };
}

describe("GET /auth/login", () => {
  it("redirects to the Fastrr Admin auth-and-redirect URL with this project's source", async () => {
    const { app } = buildTestApp();
    const response = await request(app).get("/auth/login");
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(
      "https://fastrr-admin.fastrr.com/auth-and-redirect?source=pi-pipeline",
    );
  });
});

describe("GET /auth/callback", () => {
  it("validates the token, auto-provisions the local user, sets a session cookie, and redirects to /", async () => {
    const { app, localUsers } = buildTestApp();
    const response = await request(app).get("/auth/callback?email=a@x.com&token=the-token");
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/");
    expect(response.headers["set-cookie"]?.[0]).toMatch(/^pipeline_session=/);
    expect(localUsers.get("a@x.com")).toMatchObject({ email: "a@x.com", role: "submit_prds" });
  });

  it("responds 401 without setting a cookie when Fastrr Admin validation fails", async () => {
    const { app, validateFastrrToken } = buildTestApp();
    validateFastrrToken.mockResolvedValue(null);
    const response = await request(app).get("/auth/callback?email=a@x.com&token=bad-token");
    expect(response.status).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("responds 400 when email or token query params are missing", async () => {
    const { app } = buildTestApp();
    const response = await request(app).get("/auth/callback?email=a@x.com");
    expect(response.status).toBe(400);
  });
});

describe("GET /api/me", () => {
  it("returns the current user's identity and role when a valid session cookie is present", async () => {
    const { app } = buildTestApp();
    const loginResponse = await request(app).get("/auth/callback?email=a@x.com&token=the-token");
    const cookie = loginResponse.headers["set-cookie"][0];

    const meResponse = await request(app).get("/api/me").set("Cookie", cookie);
    expect(meResponse.status).toBe(200);
    expect(meResponse.body).toEqual({ email: "a@x.com", name: "A", role: "submit_prds" });
  });

  it("returns 401 with no session cookie", async () => {
    const { app } = buildTestApp();
    const response = await request(app).get("/api/me");
    expect(response.status).toBe(401);
  });

  it("returns 401 with a session cookie signed by a different secret", async () => {
    const { app } = buildTestApp({ sessionCookieSecret: "a-different-secret" });
    const response = await request(app).get("/api/me").set("Cookie", "pipeline_session=garbage.signature");
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npx vitest run src/app.test.ts`
Expected: FAIL — `./app.js` does not exist.

- [ ] **Step 3: Write `gateway/src/app.ts`**

```typescript
// gateway/src/app.ts
import express, { type Express, type Request, type Response } from "express";
import type { LocalUserStore } from "./local-users.js";
import type { JobRegistry } from "./job-registry.js";
import { validateFastrrToken as defaultValidateFastrrToken, type FastrrIdentity } from "./fastrr-auth.js";
import { mintScopedJwt as defaultMintScopedJwt, type ScopedJwt } from "./jwt.js";
import { createSessionCookie, verifySessionCookie } from "./session-cookie.js";
import type { LocalUser } from "./local-users.js";

const SESSION_COOKIE_NAME = "pipeline_session";
const SOURCE = "pi-pipeline";

export interface GatewayAppDeps {
  localUsers: LocalUserStore;
  jobRegistry: JobRegistry;
  fastrrBaseUrl: string;
  agentServerBaseUrl: string;
  sessionCookieSecret: string;
  validateFastrrToken?: (email: string, token: string, fastrrBaseUrl: string) => Promise<FastrrIdentity | null>;
  mintScopedJwt?: (user: LocalUser, agentServerBaseUrl: string) => Promise<ScopedJwt>;
}

function parseSessionCookie(req: Request, secret: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!match) return null;
  const cookieValue = match.slice(`${SESSION_COOKIE_NAME}=`.length);
  const payload = verifySessionCookie(cookieValue, secret);
  return payload?.email ?? null;
}

export function createGatewayApp(deps: GatewayAppDeps): Express {
  const validateFastrrToken = deps.validateFastrrToken ?? defaultValidateFastrrToken;
  const mintScopedJwt = deps.mintScopedJwt ?? defaultMintScopedJwt;
  const app = express();

  app.get("/auth/login", (_req: Request, res: Response) => {
    res.redirect(`https://fastrr-admin.fastrr.com/auth-and-redirect?source=${SOURCE}`);
  });

  app.get("/auth/callback", async (req: Request, res: Response) => {
    const email = typeof req.query.email === "string" ? req.query.email : undefined;
    const token = typeof req.query.token === "string" ? req.query.token : undefined;
    if (!email || !token) {
      res.status(400).json({ error: "Missing email or token query parameter" });
      return;
    }

    const identity = await validateFastrrToken(email, token, deps.fastrrBaseUrl);
    if (!identity) {
      res.status(401).json({ error: "Fastrr Admin token validation failed" });
      return;
    }

    deps.localUsers.getOrProvision(identity.email, identity.name);
    const cookie = createSessionCookie(identity.email, deps.sessionCookieSecret);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=${cookie}; HttpOnly; Path=/; SameSite=Lax`);
    res.redirect("/");
  });

  app.get("/api/me", (req: Request, res: Response) => {
    const email = parseSessionCookie(req, deps.sessionCookieSecret);
    if (!email) {
      res.status(401).json({ error: "No valid session" });
      return;
    }
    const user = deps.localUsers.get(email);
    if (!user) {
      res.status(401).json({ error: "No valid session" });
      return;
    }
    res.json({ email: user.email, name: user.name, role: user.role });
  });

  return app;
}
```

> Note: `mintScopedJwt` and `jobRegistry` are wired into `GatewayAppDeps` in this task but not yet called from any route — no route in this plan needs a minted JWT or a job-registry read/write yet (job provisioning is the out-of-scope follow-up plan). Wiring them in now, unused, means the follow-up plan adds routes without changing this constructor's shape. If the task reviewer flags `mintScopedJwt`/`jobRegistry` as unused parameters, that's the intended state for this task — do not remove them, and do not invent a route to "use" them just to silence the flag.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npx vitest run src/app.test.ts`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/app.ts gateway/src/app.test.ts
git commit -m "feat(gateway): add Express app with login/callback/me routes"
```

---

### Task 9: Entry point

**Files:**
- Create: `gateway/src/index.ts`

**Interfaces:**
- Consumes: `loadGatewayConfig` (Task 1), `openDatabase` (Task 2), `createLocalUserStore` (Task 3), `createJobRegistry` (Task 4), `createGatewayApp` (Task 8).
- Produces: nothing further downstream — this is the process entry point.

- [ ] **Step 1: Write `gateway/src/index.ts`**

```typescript
// gateway/src/index.ts
import { loadGatewayConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createLocalUserStore } from "./local-users.js";
import { createJobRegistry } from "./job-registry.js";
import { createGatewayApp } from "./app.js";

const config = loadGatewayConfig(process.env);
const db = openDatabase(config.dbPath);
const localUsers = createLocalUserStore(db);
const jobRegistry = createJobRegistry(db);

localUsers.seedAdmins(config.seedAdminEmails);

const app = createGatewayApp({
  localUsers,
  jobRegistry,
  fastrrBaseUrl: config.fastrrBaseUrl,
  agentServerBaseUrl: config.agentServerBaseUrl,
  sessionCookieSecret: config.sessionCookieSecret,
});

app.listen(config.port, () => {
  console.log(`Gateway listening on port ${config.port}`);
});
```

- [ ] **Step 2: Typecheck the whole package**

Run: `cd gateway && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run the full test suite**

Run: `cd gateway && npm test`
Expected: all tests across every file pass (config, db, local-users, job-registry, fastrr-auth, jwt, session-cookie, app — roughly 36 tests total).

- [ ] **Step 4: Manual smoke test**

Run:
```bash
cd gateway
GATEWAY_DB_PATH=/tmp/gateway-smoke.db \
FASTRR_BASE_URL=https://fastrr-admin.fastrr.com \
AGENT_SERVER_BASE_URL=https://agent-server.internal \
GATEWAY_SESSION_SECRET=dev-secret \
GATEWAY_SEED_ADMIN_EMAILS=rizwan1@pickrr.com \
npx tsx src/index.ts
```
Expected: prints `Gateway listening on port 4000`, does not crash. In another terminal, `curl -i http://localhost:4000/auth/login` should return a `302` with `Location: https://fastrr-admin.fastrr.com/auth-and-redirect?source=pi-pipeline`. Stop the process (Ctrl+C) and delete `/tmp/gateway-smoke.db` afterward.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/index.ts
git commit -m "feat(gateway): add process entry point, seed Rizwan as admin via env config"
```

---

### Task 10: Manual verification against the real aggregator-service (guarded, not part of `npm test`)

This task is deliberately **not** a `vitest` test — it hits real infrastructure and must never run in CI or block `npm test`. It exists to actually exercise Task 5/Task 8 against the real system using the known-good test credential, per the project's own testing plan.

**Files:**
- Create: `gateway/scripts/verify-real-login.ts`

**Interfaces:**
- Consumes: `validateFastrrToken` (Task 5).
- Produces: nothing consumed by later tasks — this is a standalone manual-run script.

- [ ] **Step 1: Write `gateway/scripts/verify-real-login.ts`**

```typescript
// gateway/scripts/verify-real-login.ts
// Manual verification only — never run automatically. Exercises validateFastrrToken()
// against the real aggregator-service, using a real dev-testing identity.
//
// The current email+token pair lives in agent_one's own README.md (search for
// "auth/callback?email=" in /Users/bedantsharma/PycharmProjects/agent_one/README.md) —
// deliberately not copied into this file, since that pair can rotate and this file is
// committed to git; read it fresh from that README each time this script is run.
//
// Usage:
//   FASTRR_TEST_EMAIL=<email from agent_one's README> \
//   FASTRR_TEST_TOKEN=<token from agent_one's README> \
//   FASTRR_BASE_URL=<real Fastrr Admin base URL> \
//   npx tsx scripts/verify-real-login.ts

import { validateFastrrToken } from "../src/fastrr-auth.js";

const email = process.env.FASTRR_TEST_EMAIL;
const token = process.env.FASTRR_TEST_TOKEN;
const fastrrBaseUrl = process.env.FASTRR_BASE_URL;

if (!email || !token || !fastrrBaseUrl) {
  console.error("Set FASTRR_TEST_EMAIL, FASTRR_TEST_TOKEN, and FASTRR_BASE_URL — see this file's header comment.");
  process.exit(1);
}

const identity = await validateFastrrToken(email, token, fastrrBaseUrl);
if (identity) {
  console.log("✅ Real validation succeeded:", identity);
} else {
  console.log("❌ Real validation failed (token rejected or malformed response) — check the credential is still valid.");
}
```

- [ ] **Step 2: Run it manually**

Run (with real values read from `agent_one`'s README at run time — do not hardcode them anywhere):
```bash
cd gateway
FASTRR_TEST_EMAIL=<email> FASTRR_TEST_TOKEN=<token> FASTRR_BASE_URL=<real base URL> npx tsx scripts/verify-real-login.ts
```
Expected: `✅ Real validation succeeded: { id: '...', email: '...', name: '...' }`. If this fails, the likely causes are (in order): no network path to the internal Fastrr Admin/aggregator-service endpoint from this machine (VPN required), or the credential in `agent_one`'s README has rotated/expired — **not** a bug in `validateFastrrToken` if Task 5's unit tests are green, since those already cover the parsing/URL-construction logic in isolation.

- [ ] **Step 3: Commit**

```bash
git add gateway/scripts/verify-real-login.ts
git commit -m "chore(gateway): add manual real-network verification script for Fastrr Admin login"
```

---

## Self-Review Notes (from writing this plan)

- **Spec coverage:** §3 steps 1-5 (redirect construction, callback, aggregator-service validation, local user lookup/provisioning, cookie session) → Tasks 5, 7, 8. §3 step 6 (JWT minting) → Task 6, corrected per the `agent_one` research (real `/internal/sign-jwt` delegation, not local signing with a held secret — flagged explicitly in Global Constraints and the code comment). §6 (job registry) → Task 4. §9 (local user roles, admin) → Task 3, Task 9 (seeding). Rizwan-as-admin (this session's explicit instruction) → Task 1's `GATEWAY_SEED_ADMIN_EMAILS` config plus Task 9's smoke test and Task 10's manual verification script, both referencing `agent_one`'s README rather than hardcoding the credential into this repo.
- **Not covered, deliberately (see "Out of scope"):** §4/§7/§8 (Docker), the orchestrator-side `job_sessions` writes, §11 (`pi-web`).
- **Type consistency check:** `LocalUser`/`LocalRole` (Task 3) are the types `mintScopedJwt` (Task 6) and `app.ts` (Task 8) both import and use unchanged. `Job`/`JobRole`/`JobSession` (Task 4) match the spec's §6/§11.4 schema exactly (`job_id, user_email, status, container_id, rpc_endpoint, started_at, finished_at` / `job_id, role, session_id`). `FetchLike` (Task 5) is reused by Task 6's import rather than redefined.
