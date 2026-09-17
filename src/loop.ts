import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AllowedServicesHolder } from "./supervisor/guardrail-extension.js";
import type { PlanArtifact, ReviewVerdict } from "./types.js";
import type { SubmissionHolder } from "./tools/submit-tools.js";
import type { PipelineTelemetry } from "./telemetry/types.js";

export interface LoopSessions {
  planner: { session: Pick<AgentSession, "prompt">; holder: SubmissionHolder<PlanArtifact> };
  coder: { session: Pick<AgentSession, "prompt">; holder: SubmissionHolder<{ diffSummary: string }> };
  reviewer: { session: Pick<AgentSession, "prompt">; holder: SubmissionHolder<ReviewVerdict> };
}

export interface LoopOutcome {
  result: "success" | "escalation";
  iterations: number;
  finalPlan: PlanArtifact;
  planHistory: string[];
  rejectionHistory: string[];
}

export async function runLoop(
  sessions: LoopSessions,
  maxLoopIterations: number,
  allowedServicesHolder: AllowedServicesHolder,
  telemetry?: PipelineTelemetry,
): Promise<LoopOutcome> {
  const planHistory: string[] = [];
  const rejectionHistory: string[] = [];

  await sessions.planner.session.prompt("Produce the plan.");
  let plan = sessions.planner.holder.value;
  if (!plan) {
    throw new Error("Planner did not call submit_plan");
  }
  allowedServicesHolder.services = plan.services;

  for (let iteration = 1; iteration <= maxLoopIterations; iteration++) {
    telemetry?.recordLoopIteration(iteration, maxLoopIterations);
    planHistory.push(plan.planMarkdown);

    await sessions.coder.session.prompt(
      `Implement this plan:\n\n${plan.planMarkdown}\n\nTarget services: ${plan.services.join(", ")}\n\n${plan.notes}`,
    );
    if (!sessions.coder.holder.value) {
      throw new Error("Coder did not call submit_for_review");
    }

    await sessions.reviewer.session.prompt(
      `Review this change:\n\n${sessions.coder.holder.value.diffSummary}`,
    );
    const verdict = sessions.reviewer.holder.value;
    if (!verdict) {
      throw new Error("Reviewer did not call submit_verdict");
    }

    if (verdict.status === "approve") {
      return { result: "success", iterations: iteration, finalPlan: plan, planHistory, rejectionHistory };
    }

    rejectionHistory.push(...verdict.findings);

    if (iteration === maxLoopIterations) {
      // Cap reached on this same iteration's rejection — escalate without asking the
      // Planner for a revision that would never be consumed.
      break;
    }

    await sessions.planner.session.prompt(
      `The Reviewer sent this back with findings: ${verdict.findings.join("; ")}. Revise the plan and call submit_plan again.`,
    );
    const revisedPlan = sessions.planner.holder.value;
    if (!revisedPlan) {
      throw new Error("Planner did not call submit_plan on revision");
    }
    plan = revisedPlan;
    allowedServicesHolder.services = plan.services;
  }

  return { result: "escalation", iterations: maxLoopIterations, finalPlan: plan, planHistory, rejectionHistory };
}
