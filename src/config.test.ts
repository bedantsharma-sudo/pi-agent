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
