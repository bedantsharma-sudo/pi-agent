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
