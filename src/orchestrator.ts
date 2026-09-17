import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { appendAuditLogEntry, hashPrdText } from "./audit-log.js";
import { runLoop } from "./loop.js";
import { createMergeRequest } from "./mr.js";
import { createCoderSession } from "./sessions/coder.js";
import { createPlannerSession } from "./sessions/planner.js";
import { createPrdCriticSession } from "./sessions/prd-critic.js";
import { ensureWorkspaceMcpConfig } from "./sessions/extension-loader.js";
import { createReviewerSession } from "./sessions/reviewer.js";
import type { AllowedServicesHolder } from "./supervisor/guardrail-extension.js";
import { buildEscalationReport, buildSuccessReport, formatReportAsMarkdown } from "./supervisor/report.js";
import type { ManualActionEntry, RunConfig } from "./types.js";
import { createOtelPipelineTelemetry } from "./telemetry/otel-pipeline-telemetry.js";
import { attachSessionTelemetry } from "./telemetry/pi-adapter.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface PipelineResult {
  outcome: "mr_opened" | "escalated";
  mrUrl?: string;
  reportMarkdown: string;
}

export interface HumanIo {
  askHuman: (prompt: string) => Promise<string>;
  isApproved: (humanReply: string) => boolean;
}

// Raw assistant text isn't part of telemetry (see src/telemetry/ — that's structured
// spans for tool calls/stages/guardrail decisions, not conversational text) but is
// still worth streaming to stdout: for the critic, a human is directly conversing with
// it; for the loop sessions, nobody watches turn-by-turn, but seeing the model's live
// reasoning is still useful when something looks stuck.
function streamAssistantText(session: AgentSession, label?: string): () => void {
  return session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(label ? `[${label}] ${event.assistantMessageEvent.delta}` : event.assistantMessageEvent.delta);
    }
  });
}

export async function runPipeline(config: RunConfig, io: HumanIo): Promise<PipelineResult> {
  const modelRuntime = await ModelRuntime.create();
  const manualActions: ManualActionEntry[] = [];

  // Must run before any session factory — see ensureWorkspaceMcpConfig's own comment for why.
  await ensureWorkspaceMcpConfig(config.piProjectRoot, config.workspaceRoot);

  const telemetry = createOtelPipelineTelemetry(join(config.workspaceRoot, "telemetry", `${config.runId}.jsonl`));
  telemetry.startRun(config.runId, { "pipeline.human_identity": config.humanIdentity });

  try {
    // --- Stage 1: PRD-critic (interactive, gated on explicit human approval) ---
    const { session: critic, holder: prdHolder } = await createPrdCriticSession(config, modelRuntime);
    const stopCriticText = streamAssistantText(critic);
    const criticStage = telemetry.startStage("prd-critic");
    const stopCriticTelemetry = attachSessionTelemetry(critic, criticStage);

    await critic.prompt(`Here is the PRD to critique:\n\n${config.prdText}`);

    let approved = false;
    while (!approved) {
      const humanReply = await io.askHuman("Respond to the PRD-critic (or type your approval):");
      approved = io.isApproved(humanReply);
      await critic.prompt(humanReply);
    }
    stopCriticText();
    stopCriticTelemetry();
    if (!prdHolder.value) {
      criticStage.end("error", "finalize_prd was never called after approval");
      throw new Error("PRD-critic did not call finalize_prd after approval");
    }
    criticStage.end("ok");

    await appendAuditLogEntry(config.auditLogPath, {
      timestamp: new Date().toISOString(),
      humanIdentifier: config.humanIdentity,
      runId: config.runId,
      prdHash: hashPrdText(prdHolder.value),
    });

    // --- Stage 2: the autonomous Planner/Coder/Reviewer loop ---
    const allowedServicesHolder: AllowedServicesHolder = { services: [] };
    const planner = await createPlannerSession(config, modelRuntime, manualActions, allowedServicesHolder, telemetry);
    const coder = await createCoderSession(config, modelRuntime, manualActions, allowedServicesHolder, telemetry);
    const reviewer = await createReviewerSession(config, modelRuntime, manualActions, allowedServicesHolder, telemetry);

    // These three sessions persist for the whole loop (spec §4), so each gets one
    // session-scoped stage span covering every turn across every iteration, rather than
    // a span per prompt — loop.ts's own recordLoopIteration calls mark iteration
    // boundaries within it. See extension-loader.ts's activateSession comment and
    // SPIKE_FINDINGS.md for why bindExtensions()/mcp.json placement matter here too.
    const plannerStage = telemetry.startStage("planner");
    const coderStage = telemetry.startStage("coder");
    const reviewerStage = telemetry.startStage("reviewer");
    const stopHandles = [
      streamAssistantText(planner.session, "Planner"),
      streamAssistantText(coder.session, "Coder"),
      streamAssistantText(reviewer.session, "Reviewer"),
      attachSessionTelemetry(planner.session, plannerStage),
      attachSessionTelemetry(coder.session, coderStage),
      attachSessionTelemetry(reviewer.session, reviewerStage),
    ];

    await planner.session.prompt(`Approved PRD:\n\n${prdHolder.value}`);

    let outcome: Awaited<ReturnType<typeof runLoop>>;
    try {
      outcome = await runLoop({ planner, coder, reviewer }, config.maxLoopIterations, allowedServicesHolder, telemetry);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      plannerStage.end("error", detail);
      coderStage.end("error", detail);
      reviewerStage.end("error", detail);
      throw error;
    } finally {
      for (const stop of stopHandles) stop();
    }

    if (outcome.result === "escalation") {
      plannerStage.end("ok", "escalated");
      coderStage.end("ok", "escalated");
      reviewerStage.end("ok", "escalated");
      const report = buildEscalationReport(manualActions, prdHolder.value, outcome.planHistory, outcome.rejectionHistory);
      const reportMarkdown = formatReportAsMarkdown(report);
      telemetry.endRun("escalated", `${outcome.iterations} iteration(s), no approval`);
      return { outcome: "escalated", reportMarkdown };
    }
    plannerStage.end("ok");
    coderStage.end("ok");
    reviewerStage.end("ok");

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

    telemetry.endRun("mr_opened", url);
    return { outcome: "mr_opened", mrUrl: url, reportMarkdown };
  } catch (error) {
    telemetry.endRun("failed", error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    // Flush every buffered span even on failure — the whole point of this telemetry is
    // to see *why* a run failed or got stuck, so losing spans on the failure path would
    // defeat the purpose.
    await telemetry.shutdown();
  }
}
