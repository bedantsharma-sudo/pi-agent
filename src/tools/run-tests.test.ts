import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunTestsTool, runMavenTests } from "./run-tests.js";

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

describe("createRunTestsTool - workspace boundary enforcement", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "workspace-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("rejects repo path that escapes workspace boundary", async () => {
    const tool = createRunTestsTool(workspaceDir);
    const result = await tool.execute("test-call", { repo: "../../../etc/passwd" });

    const details = result.details as { passed: boolean; summary: string };
    expect(details.passed).toBe(false);
    expect(details.summary).toContain("workspace boundary");
  });

  it("allows repo path that stays within workspace boundary", async () => {
    const tool = createRunTestsTool(workspaceDir);
    // Using a valid repo path within the workspace (even if it doesn't exist, it should pass the boundary check)
    const result = await tool.execute("test-call", { repo: "aggregator-service" });

    const details = result.details as { passed: boolean; summary: string };
    // This will fail at mvn execution (no pom.xml), but should not fail at boundary check
    expect(details.summary).not.toContain("workspace boundary");
  });
});
