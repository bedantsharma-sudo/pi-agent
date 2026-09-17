import { describe, expect, it, vi } from "vitest";
import { commitAndPushChanges, listUntrackedFiles, snapshotWorkspaceUntracked } from "./git-commit-push.js";

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
