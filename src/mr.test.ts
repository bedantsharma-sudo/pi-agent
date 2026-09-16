import { describe, expect, it, vi } from "vitest";
import { createMergeRequest } from "./mr.js";

describe("createMergeRequest", () => {
  it("builds the glab command with title and description and parses the returned URL", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "https://gitlab.example.com/team/repo/-/merge_requests/42\n" });
    const result = await createMergeRequest(
      {
        repoPath: "/workspace/aggregator-service",
        title: "Add health check endpoint",
        description: "## Summary\n\nAdds /health.\n",
        sourceBranch: "feature/health-check",
      },
      exec,
    );
    expect(result.url).toBe("https://gitlab.example.com/team/repo/-/merge_requests/42");
    expect(exec).toHaveBeenCalledWith(
      "glab",
      ["mr", "create", "--title", "Add health check endpoint", "--description", "## Summary\n\nAdds /health.\n", "--source-branch", "feature/health-check", "--fill"],
      { cwd: "/workspace/aggregator-service" },
    );
  });

  it("throws with the raw glab error output when the command fails", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("glab: not authenticated"));
    await expect(
      createMergeRequest(
        { repoPath: "/workspace/aggregator-service", title: "t", description: "d", sourceBranch: "b" },
        exec,
      ),
    ).rejects.toThrow("glab: not authenticated");
  });
});
