import { describe, expect, it, vi } from "vitest";
import { runLoop, type LoopSessions } from "./loop.js";
import type { PlanArtifact, ReviewVerdict } from "./types.js";
import type { PipelineTelemetry } from "./telemetry/types.js";

function makeFakeSessions(script: {
  plans: PlanArtifact[];
  verdicts: ReviewVerdict[];
}): LoopSessions {
  let planIndex = 0;
  let verdictIndex = 0;
  const plannerHolder: { value: PlanArtifact | undefined } = { value: undefined };
  const coderHolder: { value: { diffSummary: string } | undefined } = { value: undefined };
  const reviewerHolder: { value: ReviewVerdict | undefined } = { value: undefined };

  return {
    planner: {
      session: {
        prompt: async () => {
          plannerHolder.value = script.plans[planIndex++];
        },
      } as never,
      holder: plannerHolder,
    },
    coder: {
      session: {
        prompt: async () => {
          coderHolder.value = { diffSummary: "changed something" };
        },
      } as never,
      holder: coderHolder,
    },
    reviewer: {
      session: {
        prompt: async () => {
          reviewerHolder.value = script.verdicts[verdictIndex++];
        },
      } as never,
      holder: reviewerHolder,
    },
  };
}

describe("runLoop", () => {
  it("ends in success on the first iteration when the Reviewer approves immediately", async () => {
    const sessions = makeFakeSessions({
      plans: [{ planMarkdown: "p1", services: ["aggregator-service"], notes: "" }],
      verdicts: [{ status: "approve", findings: [] }],
    });
    const holder = { services: [] as string[] };
    const outcome = await runLoop(sessions, 30, holder);
    expect(outcome.result).toBe("success");
    expect(outcome.iterations).toBe(1);
    expect(holder.services).toEqual(["aggregator-service"]);
  });

  it("loops until approval, feeding revise findings back to the Planner, and keeps allowedServicesHolder current", async () => {
    const sessions = makeFakeSessions({
      plans: [
        { planMarkdown: "p1", services: ["aggregator-service"], notes: "" },
        { planMarkdown: "p2", services: ["aggregator-service", "payment-aggregator"], notes: "" },
      ],
      verdicts: [
        { status: "revise", findings: ["missing null check"] },
        { status: "approve", findings: [] },
      ],
    });
    const holder = { services: [] as string[] };
    const outcome = await runLoop(sessions, 30, holder);
    expect(outcome.result).toBe("success");
    expect(outcome.iterations).toBe(2);
    expect(outcome.rejectionHistory).toEqual(["missing null check"]);
    expect(holder.services).toEqual(["aggregator-service", "payment-aggregator"]);
  });

  it("escalates once maxLoopIterations is reached without approval", async () => {
    const plans = Array.from({ length: 3 }, (_, i) => ({
      planMarkdown: `p${i + 1}`,
      services: ["aggregator-service"],
      notes: "",
    }));
    const verdicts = Array.from({ length: 3 }, () => ({ status: "revise" as const, findings: ["still broken"] }));
    const sessions = makeFakeSessions({ plans, verdicts });
    const outcome = await runLoop(sessions, 3, { services: [] });
    expect(outcome.result).toBe("escalation");
    expect(outcome.iterations).toBe(3);
  });

  it("records one loop_iteration telemetry call per iteration when telemetry is provided", async () => {
    const sessions = makeFakeSessions({
      plans: [
        { planMarkdown: "p1", services: ["aggregator-service"], notes: "" },
        { planMarkdown: "p2", services: ["aggregator-service"], notes: "" },
      ],
      verdicts: [
        { status: "revise", findings: ["missing null check"] },
        { status: "approve", findings: [] },
      ],
    });
    const telemetry: Pick<PipelineTelemetry, "recordLoopIteration"> = { recordLoopIteration: vi.fn() };
    await runLoop(sessions, 30, { services: [] }, telemetry as PipelineTelemetry);
    expect(telemetry.recordLoopIteration).toHaveBeenCalledTimes(2);
    expect(telemetry.recordLoopIteration).toHaveBeenNthCalledWith(1, 1, 30);
    expect(telemetry.recordLoopIteration).toHaveBeenNthCalledWith(2, 2, 30);
  });
});
