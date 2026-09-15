import { execFile } from "node:child_process";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { TestRunResult } from "../types.js";

const execFileAsync = promisify(execFile);

export async function runMavenTests(repoPath: string): Promise<TestRunResult> {
  try {
    // Build minimal env containing only PATH, JAVA_HOME, M2_HOME
    const env: Record<string, string> = {};
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.JAVA_HOME) env.JAVA_HOME = process.env.JAVA_HOME;
    if (process.env.M2_HOME) env.M2_HOME = process.env.M2_HOME;

    const { stdout } = await execFileAsync("mvn", ["test", "-q"], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024 * 20,
      timeout: 600_000, // 10 minutes
      killSignal: "SIGKILL",
      env,
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
      // Enforce workspace boundary: resolve both paths and verify repo is still a descendant
      const resolvedWorkspace = resolve(workspaceRoot);
      const resolvedRepo = resolve(workspaceRoot, params.repo);

      if (!resolvedRepo.startsWith(resolvedWorkspace + sep)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Tests FAILED.\nAttempted to run tests outside workspace boundary.`,
            },
          ],
          details: {
            passed: false,
            summary: `Attempted to run tests outside workspace boundary. Workspace: ${resolvedWorkspace}, requested: ${params.repo} (resolved to: ${resolvedRepo})`,
          },
        };
      }

      const result = await runMavenTests(resolvedRepo);
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
