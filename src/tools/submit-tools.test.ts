import { describe, expect, it } from "vitest";
import {
  createFinalizePrdTool,
  createSubmitForReviewTool,
  createSubmitPlanTool,
  createSubmitVerdictTool,
} from "./submit-tools.js";

describe("submit tools", () => {
  it("finalize_prd captures the rewritten PRD into the holder", async () => {
    const holder: { value: string | undefined } = { value: undefined };
    const tool = createFinalizePrdTool(holder);
    await tool.execute("call-1", { rewritten_prd: "Full new PRD text" }, undefined as never, undefined as never, undefined as never);
    expect(holder.value).toBe("Full new PRD text");
  });

  it("submit_plan captures a structured PlanArtifact", async () => {
    const holder: { value: import("../types.js").PlanArtifact | undefined } = { value: undefined };
    const tool = createSubmitPlanTool(holder);
    await tool.execute(
      "call-1",
      { plan_markdown: "# Plan", services: ["aggregator-service"], notes: "Java 11" },
      undefined as never,
      undefined as never,
      undefined as never,
    );
    expect(holder.value).toEqual({ planMarkdown: "# Plan", services: ["aggregator-service"], notes: "Java 11" });
  });

  it("submit_for_review captures a diff summary", async () => {
    const holder: { value: { diffSummary: string } | undefined } = { value: undefined };
    const tool = createSubmitForReviewTool(holder);
    await tool.execute("call-1", { diff_summary: "Added health check" }, undefined as never, undefined as never, undefined as never);
    expect(holder.value).toEqual({ diffSummary: "Added health check" });
  });

  it("submit_verdict captures a structured ReviewVerdict", async () => {
    const holder: { value: import("../types.js").ReviewVerdict | undefined } = { value: undefined };
    const tool = createSubmitVerdictTool(holder);
    await tool.execute("call-1", { status: "revise", findings: ["missing null check"] }, undefined as never, undefined as never, undefined as never);
    expect(holder.value).toEqual({ status: "revise", findings: ["missing null check"] });
  });
});
