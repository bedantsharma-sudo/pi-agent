import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { PlanArtifact, ReviewVerdict } from "../types.js";

export interface SubmissionHolder<T> {
  value: T | undefined;
}

export function createFinalizePrdTool(holder: SubmissionHolder<string>) {
  return defineTool({
    name: "finalize_prd",
    label: "Finalize PRD",
    description:
      "Ends the PRD-critique conversation by submitting the fully rewritten PRD. Only call this after the " +
      "human has explicitly approved.",
    parameters: Type.Object({
      rewritten_prd: Type.String({ description: "The complete PRD, rewritten from scratch" }),
    }),
    execute: async (_toolCallId, params) => {
      holder.value = params.rewritten_prd;
      return { content: [{ type: "text" as const, text: "PRD finalized." }], details: {} };
    },
  });
}

export function createSubmitPlanTool(holder: SubmissionHolder<PlanArtifact>) {
  return defineTool({
    name: "submit_plan",
    label: "Submit Plan",
    description: "Submits the implementation plan for the Coder to work from.",
    parameters: Type.Object({
      plan_markdown: Type.String({ description: "The full plan, in markdown" }),
      services: Type.Array(Type.String(), {
        description: "Repo directory names (relative to the workspace root) that need changes",
      }),
      notes: Type.String({ description: "Additional notes for the Coder, e.g. Java version per service" }),
    }),
    execute: async (_toolCallId, params) => {
      holder.value = { planMarkdown: params.plan_markdown, services: params.services, notes: params.notes };
      return {
        content: [{ type: "text" as const, text: `Plan submitted, targeting: ${params.services.join(", ")}` }],
        details: {},
      };
    },
  });
}

export function createSubmitForReviewTool(holder: SubmissionHolder<{ diffSummary: string }>) {
  return defineTool({
    name: "submit_for_review",
    label: "Submit For Review",
    description:
      "Submits the implemented change for the Reviewer's judgment. Only call this after run_tests has " +
      "reported a passing run.",
    parameters: Type.Object({
      diff_summary: Type.String({ description: "A summary of what changed and why" }),
    }),
    execute: async (_toolCallId, params) => {
      holder.value = { diffSummary: params.diff_summary };
      return { content: [{ type: "text" as const, text: "Submitted for review." }], details: {} };
    },
  });
}

export function createSubmitVerdictTool(holder: SubmissionHolder<ReviewVerdict>) {
  return defineTool({
    name: "submit_verdict",
    label: "Submit Verdict",
    description:
      "Submits the review verdict: 'approve' ends the pipeline loop and opens an MR; 'revise' sends " +
      "findings back to the Planner.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("approve"), Type.Literal("revise")]),
      findings: Type.Array(Type.String(), { description: "Specific issues found, empty if approving" }),
    }),
    execute: async (_toolCallId, params) => {
      holder.value = { status: params.status, findings: params.findings };
      return { content: [{ type: "text" as const, text: `Verdict: ${params.status}` }], details: {} };
    },
  });
}
