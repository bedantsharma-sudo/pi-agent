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
  // rowid as a secondary sort key breaks ties deterministically in insertion order — two jobs
  // created in the same test (or the same millisecond in production) would otherwise have an
  // unspecified relative order under started_at DESC alone.
  const listByUserStmt = db.prepare<[string], JobRow>(
    "SELECT * FROM jobs WHERE user_email = ? ORDER BY started_at DESC, rowid DESC",
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
