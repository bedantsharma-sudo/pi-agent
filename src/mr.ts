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
  // `--fill` derives title/description from commits and is mutually exclusive with passing
  // them explicitly — glab 1.112.0 hard-errors ("Usage of --title and --description overrides
  // --fill") rather than silently ignoring it like older versions did. We always pass an
  // explicit title/description (the orchestrator never calls this without both), so --fill
  // must never be added here.
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
    ],
    { cwd: options.repoPath },
  );
  return { url: stdout.trim() };
}
