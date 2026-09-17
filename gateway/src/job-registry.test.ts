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
