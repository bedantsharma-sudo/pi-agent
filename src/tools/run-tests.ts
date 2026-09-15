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
