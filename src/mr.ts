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
