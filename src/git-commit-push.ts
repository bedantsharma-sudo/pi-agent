import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ExecFn = (command: string, args: string[], options: { cwd: string }) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = async (command, args, options) => execFileAsync(command, args, options);

/**
 * Untracked files already present in a repo before this run touched it — dev-tooling cruft
 * like `.claude/`/`AGENTS.md` that happens to sit untracked in a service checkout has nothing
 * to do with any given pipeline run and must never be swept into its commit. Callers snapshot
 * this once per repo before the Coder gets a turn (see orchestrator.ts) and pass it back in.
 */
export async function listUntrackedFiles(repoPath: string, exec: ExecFn = defaultExec): Promise<Set<string>> {
  const { stdout } = await exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repoPath });
  return new Set(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

export type ReadDirFn = (path: string) => Promise<string[]>;

const defaultReadDir: ReadDirFn = (path) => readdir(path);

/**
 * Snapshots untracked files for every git-repo directory directly under `workspaceRoot`, so
 * `commitAndPushChanges` can later tell "the Coder created this file" apart from "this file was
 * already sitting there, untracked, before the run started" — for whichever services end up
 * touched. Taken once, before the loop starts, rather than only for the plan's declared
 * services, since (a) revisions can change which services are touched across iterations and
 * (b) it must happen before the Coder's first edit regardless of which services those turn out
 * to be. A directory that isn't a git repo (git ls-files errors) is silently skipped — only
 * this workspace's actual service checkouts matter here.
 */
export async function snapshotWorkspaceUntracked(
  workspaceRoot: string,
  exec: ExecFn = defaultExec,
  readDirFn: ReadDirFn = defaultReadDir,
): Promise<Map<string, Set<string>>> {
  const entries = await readDirFn(workspaceRoot);
  const snapshot = new Map<string, Set<string>>();
  for (const entry of entries) {
    try {
      snapshot.set(entry, await listUntrackedFiles(`${workspaceRoot}/${entry}`, exec));
    } catch {
      // Not a git repo (or some other git error) — not a service checkout, skip it.
    }
  }
  return snapshot;
}

/**
 * Checks out a fresh, dedicated branch for this run in a single repo, cut from that repo's
 * *actual* default branch — discovered per-repo via `origin/HEAD` rather than hardcoded, since
 * different services in this org use different conventions (`release_j21` for Java-21-migrated
 * services, `release` for the rest still on Java 11 — confirmed empirically, not guessed).
 * Fetches that base fresh before cutting the branch so the Coder never starts from a stale local
 * ref. Without this, the Coder just edits whatever happens to already be checked out — which is
 * exactly what caused a real run's changes to land on top of an unrelated pre-existing feature
 * branch with ~10 unrelated commits, rather than a clean branch of their own.
 */
export async function prepareServiceBranch(
  repoPath: string,
  branchName: string,
  exec: ExecFn = defaultExec,
): Promise<void> {
  const { stdout: headRef } = await exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: repoPath });
  const baseBranch = headRef.trim().replace(/^refs\/remotes\/origin\//, "");
  await exec("git", ["fetch", "origin", baseBranch], { cwd: repoPath });
  await exec("git", ["checkout", "-B", branchName, `origin/${baseBranch}`], { cwd: repoPath });
}

/**
 * Runs prepareServiceBranch for every git-repo directory under `workspaceRoot` — like
 * snapshotWorkspaceUntracked, done for the whole workspace up front (before the loop starts,
 * before the Coder's first turn) rather than only for the plan's eventual services, since which
 * services end up touched isn't known until the Planner submits (and can change across
 * revisions). A directory that isn't a git repo, or that errors for any other reason, is
 * skipped rather than aborting the whole run — one broken/unrelated directory under
 * workspaceRoot shouldn't block every other service from being prepared correctly.
 */
export async function prepareWorkspaceBranches(
  workspaceRoot: string,
  branchName: string,
  exec: ExecFn = defaultExec,
  readDirFn: ReadDirFn = defaultReadDir,
): Promise<void> {
  const entries = await readDirFn(workspaceRoot);
  for (const entry of entries) {
    try {
      await prepareServiceBranch(`${workspaceRoot}/${entry}`, branchName, exec);
    } catch {
      // Not a git repo (or some other git error) — not a service checkout, skip it.
    }
  }
}

export interface CommitAndPushOptions {
  repoPath: string;
  branchName: string;
  commitMessage: string;
  preExistingUntrackedFiles: Set<string>;
}

export interface CommitAndPushResult {
  /** false when there was nothing relevant to commit — the caller should not open an MR for this repo. */
  committed: boolean;
}

// The Coder session's file edits (via the write/edit tools, or bash) land in the working tree
// but nothing else in this pipeline ever commits or pushes them — this is the deterministic
// orchestrator-level step that does, mirroring mr.ts's own reasoning for why MR creation isn't
// left to an LLM tool call either: a malformed commit is a bad place for model unreliability to
// show up.
export async function commitAndPushChanges(
  options: CommitAndPushOptions,
  exec: ExecFn = defaultExec,
): Promise<CommitAndPushResult> {
  const { stdout: statusOutput } = await exec("git", ["status", "--porcelain"], { cwd: options.repoPath });
  const statusLines = statusOutput
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  const relevantLines = statusLines.filter((line) => {
    if (!line.startsWith("??")) return true; // tracked modification/deletion — always relevant
    const path = line.slice(2).trim();
    return !options.preExistingUntrackedFiles.has(path);
  });

  if (relevantLines.length === 0) {
    return { committed: false };
  }

  // -B (not -b): idempotent if a previous partial run already created/pushed this branch name.
  await exec("git", ["checkout", "-B", options.branchName], { cwd: options.repoPath });
  await exec("git", ["add", "-u"], { cwd: options.repoPath });

  const newUntrackedPaths = relevantLines
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(2).trim());
  if (newUntrackedPaths.length > 0) {
    await exec("git", ["add", "--", ...newUntrackedPaths], { cwd: options.repoPath });
  }

  await exec("git", ["commit", "-m", options.commitMessage], { cwd: options.repoPath });
  await exec("git", ["push", "-u", "origin", options.branchName], { cwd: options.repoPath });

  return { committed: true };
}
