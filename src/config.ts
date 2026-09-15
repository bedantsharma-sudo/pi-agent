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

function parsePositiveInteger(value: string, envVarName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(
      `Environment variable ${envVarName} must be a positive integer, but got: ${value}`
    );
  }
  return parsed;
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
    maxLoopIterations: env.PIPELINE_MAX_LOOP_ITERATIONS
      ? parsePositiveInteger(env.PIPELINE_MAX_LOOP_ITERATIONS, "PIPELINE_MAX_LOOP_ITERATIONS")
      : 30,
  };
}
