import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { appendAuditLogEntry, hashPrdText } from "./audit-log.js";
import { runLoop } from "./loop.js";
import { createMergeRequest } from "./mr.js";
import { createCoderSession } from "./sessions/coder.js";
import { createPlannerSession } from "./sessions/planner.js";
import { createPrdCriticSession } from "./sessions/prd-critic.js";
import { createReviewerSession } from "./sessions/reviewer.js";
import type { AllowedServicesHolder } from "./supervisor/guardrail-extension.js";
import { buildEscalationReport, buildSuccessReport, formatReportAsMarkdown } from "./supervisor/report.js";
import type { ManualActionEntry, RunConfig } from "./types.js";

export interface PipelineResult {
  outcome: "mr_opened" | "escalated";
  mrUrl?: string;
  reportMarkdown: string;
}

export interface HumanIo {
  askHuman: (prompt: string) => Promise<string>;
  isApproved: (humanReply: string) => boolean;
}

export async function runPipeline(config: RunConfig, io: HumanIo): Promise<PipelineResult> {
  const modelRuntime = await ModelRuntime.create();
  const manualActions: ManualActionEntry[] = [];

  // --- Stage 1: PRD-critic (interactive, gated on explicit human approval) ---
  const { session: critic, holder: prdHolder } = await createPrdCriticSession(config, modelRuntime);
  // A human is directly conversing with this session, so its responses must actually reach the
  // terminal — unlike the loop sessions below, which rely on pi-agent-dashboard for visibility
  // instead of raw stdout, since nobody is meant to be watching them turn-by-turn.
  critic.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });
  await critic.prompt(`Here is the PRD to critique:\n\n${config.prdText}`);

  let approved = false;
  while (!approved) {
    const humanReply = await io.askHuman("Respond to the PRD-critic (or type your approval):");
    approved = io.isApproved(humanReply);
    await critic.prompt(humanReply);
  }
  if (!prdHolder.value) {
    throw new Error("PRD-critic did not call finalize_prd after approval");
  }

  await appendAuditLogEntry(config.auditLogPath, {
    timestamp: new Date().toISOString(),
    humanIdentifier: config.humanIdentity,
    runId: config.runId,
    prdHash: hashPrdText(prdHolder.value),
  });

  // --- Stage 2: the autonomous Planner/Coder/Reviewer loop ---
  const allowedServicesHolder: AllowedServicesHolder = { services: [] };
  const planner = await createPlannerSession(config, modelRuntime, manualActions, allowedServicesHolder);
  const coder = await createCoderSession(config, modelRuntime, manualActions, allowedServicesHolder);
  const reviewer = await createReviewerSession(config, modelRuntime, manualActions, allowedServicesHolder);

  await planner.session.prompt(`Approved PRD:\n\n${prdHolder.value}`);

  const outcome = await runLoop({ planner, coder, reviewer }, config.maxLoopIterations, allowedServicesHolder);

  if (outcome.result === "escalation") {
    const report = buildEscalationReport(manualActions, prdHolder.value, outcome.planHistory, outcome.rejectionHistory);
    return { outcome: "escalated", reportMarkdown: formatReportAsMarkdown(report) };
  }

  const report = buildSuccessReport(
    manualActions,
    `Completed in ${outcome.iterations} iteration(s). Services touched: ${outcome.finalPlan.services.join(", ")}.`,
  );
  const reportMarkdown = formatReportAsMarkdown(report);

  const primaryRepo = outcome.finalPlan.services[0];
  if (!primaryRepo) {
    throw new Error("Final plan named no services — cannot open an MR");
  }
  const { url } = await createMergeRequest({
    repoPath: `${config.workspaceRoot}/${primaryRepo}`,
    title: `[pipeline] ${outcome.finalPlan.planMarkdown.split("\n")[0].slice(0, 80)}`,
    description: reportMarkdown,
    sourceBranch: `pipeline/${config.runId}`,
  });

  return { outcome: "mr_opened", mrUrl: url, reportMarkdown };
}
