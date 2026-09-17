import { describe, expect, it, vi } from "vitest";
import {
  commitAndPushChanges,
  listUntrackedFiles,
  prepareServiceBranch,
  prepareWorkspaceBranches,
  snapshotWorkspaceUntracked,
} from "./git-commit-push.js";

function statusOutput(lines: string[]): { stdout: string } {
  return { stdout: lines.join("\n") + (lines.length ? "\n" : "") };
}

describe("listUntrackedFiles", () => {
  it("returns the set of untracked file paths reported by git", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "AGENTS.md\n.claude/settings.json\n" });
    const result = await listUntrackedFiles("/workspace/payment-core", exec);
    expect(result).toEqual(new Set(["AGENTS.md", ".claude/settings.json"]));
    expect(exec).toHaveBeenCalledWith("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: "/workspace/payment-core",
    });
  });

  it("returns an empty set when there are no untracked files", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "" });
    const result = await listUntrackedFiles("/workspace/payment-core", exec);
    expect(result).toEqual(new Set());
  });
});

describe("snapshotWorkspaceUntracked", () => {
  it("snapshots untracked files for every directory that is a git repo, skipping ones that aren't", async () => {
    const readDirFn = vi.fn().mockResolvedValue(["payment-core", "payment-aggregator", "README.md"]);
    const exec = vi.fn().mockImplementation(async (_cmd, _args, { cwd }: { cwd: string }) => {
      if (cwd.endsWith("payment-core")) return { stdout: "AGENTS.md\n" };
      if (cwd.endsWith("payment-aggregator")) return { stdout: "" };
      throw new Error("not a git repository");
    });

    const result = await snapshotWorkspaceUntracked("/workspace", exec, readDirFn);

    expect(result.get("payment-core")).toEqual(new Set(["AGENTS.md"]));
    expect(result.get("payment-aggregator")).toEqual(new Set());
    expect(result.has("README.md")).toBe(false);
    expect(readDirFn).toHaveBeenCalledWith("/workspace");
  });
});

describe("prepareServiceBranch", () => {
  it("discovers the repo's real default branch, fetches it fresh, and cuts the pipeline branch from it", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "refs/remotes/origin/release_j21\n" }) // symbolic-ref
      .mockResolvedValueOnce({ stdout: "" }) // fetch
      .mockResolvedValueOnce({ stdout: "" }); // checkout -B

    await prepareServiceBranch("/workspace/payment-core", "pipeline/abc", exec);

    expect(exec).toHaveBeenNthCalledWith(1, "git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: "/workspace/payment-core",
    });
    expect(exec).toHaveBeenNthCalledWith(2, "git", ["fetch", "origin", "release_j21"], {
      cwd: "/workspace/payment-core",
    });
    expect(exec).toHaveBeenNthCalledWith(3, "git", ["checkout", "-B", "pipeline/abc", "origin/release_j21"], {
      cwd: "/workspace/payment-core",
    });
  });

  it("resolves a different base branch name for a repo whose default is 'release', not 'release_j21'", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "refs/remotes/origin/release\n" })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });

    await prepareServiceBranch("/workspace/fastrr-oms", "pipeline/abc", exec);

    expect(exec).toHaveBeenNthCalledWith(2, "git", ["fetch", "origin", "release"], { cwd: "/workspace/fastrr-oms" });
    expect(exec).toHaveBeenNthCalledWith(3, "git", ["checkout", "-B", "pipeline/abc", "origin/release"], {
      cwd: "/workspace/fastrr-oms",
    });
  });

  it("propagates an error when the repo has no configured origin/HEAD, rather than guessing a base branch", async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error("fatal: ref refs/remotes/origin/HEAD is not a symbolic ref"));
    await expect(prepareServiceBranch("/workspace/payment-core", "pipeline/abc", exec)).rejects.toThrow(
      "not a symbolic ref",
    );
  });
});

describe("prepareWorkspaceBranches", () => {
  it("prepares every git-repo directory under workspaceRoot, skipping non-repos", async () => {
    const readDirFn = vi.fn().mockResolvedValue(["payment-core", "payment-aggregator", "README.md"]);
    const exec = vi.fn().mockImplementation(async (cmd, args, { cwd }: { cwd: string }) => {
      if (cwd.endsWith("README.md")) throw new Error("not a git repository");
      if (args[0] === "symbolic-ref") return { stdout: "refs/remotes/origin/release_j21\n" };
      return { stdout: "" };
    });

    await prepareWorkspaceBranches("/workspace", "pipeline/abc", exec, readDirFn);

    // "fetch" only happens after symbolic-ref *succeeds*, so this reflects repos that were
    // actually prepared, not just attempted (exec.mock.calls records rejected attempts too).
    const preparedRepos = exec.mock.calls
      .filter(([, args]) => args[0] === "fetch")
      .map(([, , opts]) => (opts as { cwd: string }).cwd);
    expect(preparedRepos.sort()).toEqual(["/workspace/payment-aggregator", "/workspace/payment-core"]);
  });

  it("does not let one repo's failure stop the others from being prepared", async () => {
    const readDirFn = vi.fn().mockResolvedValue(["broken-repo", "payment-core"]);
    const exec = vi.fn().mockImplementation(async (cmd, args, { cwd }: { cwd: string }) => {
      if (cwd.endsWith("broken-repo")) throw new Error("fatal: not a git repository");
      return { stdout: "refs/remotes/origin/release_j21\n" };
    });

    await prepareWorkspaceBranches("/workspace", "pipeline/abc", exec, readDirFn);

    const preparedRepos = exec.mock.calls
      .filter(([, args]) => args[0] === "fetch")
      .map(([, , opts]) => (opts as { cwd: string }).cwd);
    expect(preparedRepos).toEqual(["/workspace/payment-core"]);
  });
});

describe("commitAndPushChanges", () => {
  it("returns committed:false and does nothing else when there are no changes", async () => {
    const exec = vi.fn().mockResolvedValue(statusOutput([]));
    const result = await commitAndPushChanges(
      {
        repoPath: "/workspace/payment-core",
        branchName: "pipeline/abc",
        commitMessage: "msg",
        preExistingUntrackedFiles: new Set(),
      },
      exec,
    );
    expect(result).toEqual({ committed: false });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain"], { cwd: "/workspace/payment-core" });
  });

  it("commits modified tracked files and pushes, skipping checkout-branch failures gracefully via -B", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(statusOutput([" M src/Main.java", " M pom.xml"])) // status
      .mockResolvedValueOnce({ stdout: "" }) // checkout -B
      .mockResolvedValueOnce({ stdout: "" }) // add -u
      .mockResolvedValueOnce({ stdout: "" }) // commit
      .mockResolvedValueOnce({ stdout: "" }); // push

    const result = await commitAndPushChanges(
      {
        repoPath: "/workspace/payment-core",
        branchName: "pipeline/abc",
        commitMessage: "msg",
        preExistingUntrackedFiles: new Set(),
      },
      exec,
    );

    expect(result).toEqual({ committed: true });
    expect(exec).toHaveBeenNthCalledWith(2, "git", ["checkout", "-B", "pipeline/abc"], {
      cwd: "/workspace/payment-core",
    });
    expect(exec).toHaveBeenNthCalledWith(3, "git", ["add", "-u"], { cwd: "/workspace/payment-core" });
    expect(exec).toHaveBeenNthCalledWith(4, "git", ["commit", "-m", "msg"], { cwd: "/workspace/payment-core" });
    expect(exec).toHaveBeenNthCalledWith(5, "git", ["push", "-u", "origin", "pipeline/abc"], {
      cwd: "/workspace/payment-core",
    });
  });

  it("stages newly-created untracked files but excludes pre-existing untracked ones", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(
        statusOutput([
          " M src/Main.java",
          "?? src/NewTest.java",
          "?? AGENTS.md", // pre-existing, must be excluded
        ]),
      )
      .mockResolvedValueOnce({ stdout: "" }) // checkout -B
      .mockResolvedValueOnce({ stdout: "" }) // add -u
      .mockResolvedValueOnce({ stdout: "" }) // add -- src/NewTest.java
      .mockResolvedValueOnce({ stdout: "" }) // commit
      .mockResolvedValueOnce({ stdout: "" }); // push

    const result = await commitAndPushChanges(
      {
        repoPath: "/workspace/payment-core",
        branchName: "pipeline/abc",
        commitMessage: "msg",
        preExistingUntrackedFiles: new Set(["AGENTS.md"]),
      },
      exec,
    );

    expect(result).toEqual({ committed: true });
    expect(exec).toHaveBeenNthCalledWith(4, "git", ["add", "--", "src/NewTest.java"], {
      cwd: "/workspace/payment-core",
    });
    // Never staged the pre-existing untracked file.
    const addCalls = exec.mock.calls.filter(([cmd, args]) => cmd === "git" && args[0] === "add");
    for (const [, args] of addCalls) {
      expect(args).not.toContain("AGENTS.md");
    }
  });

  it("reports committed:false when the only changes present are pre-existing untracked files", async () => {
    const exec = vi.fn().mockResolvedValueOnce(statusOutput(["?? AGENTS.md", "?? .claude/settings.json"]));
    const result = await commitAndPushChanges(
      {
        repoPath: "/workspace/payment-core",
        branchName: "pipeline/abc",
        commitMessage: "msg",
        preExistingUntrackedFiles: new Set(["AGENTS.md", ".claude/settings.json"]),
      },
      exec,
    );
    expect(result).toEqual({ committed: false });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("does not call add -- with an empty file list when every change is a tracked modification", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(statusOutput([" M src/Main.java"]))
      .mockResolvedValueOnce({ stdout: "" }) // checkout -B
      .mockResolvedValueOnce({ stdout: "" }) // add -u
      .mockResolvedValueOnce({ stdout: "" }) // commit
      .mockResolvedValueOnce({ stdout: "" }); // push

    await commitAndPushChanges(
      {
        repoPath: "/workspace/payment-core",
        branchName: "pipeline/abc",
        commitMessage: "msg",
        preExistingUntrackedFiles: new Set(),
      },
      exec,
    );

    expect(exec).toHaveBeenCalledTimes(5); // status, checkout -B, add -u, commit, push
    const addDashDashCalls = exec.mock.calls.filter(([cmd, args]) => cmd === "git" && args[0] === "add" && args[1] === "--");
    expect(addDashDashCalls).toHaveLength(0);
  });

  it("propagates an error from any git step without swallowing it", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(statusOutput([" M src/Main.java"]))
      .mockResolvedValueOnce({ stdout: "" }) // checkout -B
      .mockResolvedValueOnce({ stdout: "" }) // add -u
      .mockRejectedValueOnce(new Error("nothing to commit")); // commit fails

    await expect(
      commitAndPushChanges(
        {
          repoPath: "/workspace/payment-core",
          branchName: "pipeline/abc",
          commitMessage: "msg",
          preExistingUntrackedFiles: new Set(),
        },
        exec,
      ),
    ).rejects.toThrow("nothing to commit");
  });
});
