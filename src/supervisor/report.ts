import type { ManualActionEntry, SupervisorReport } from "../types.js";

export function buildSuccessReport(manualActions: ManualActionEntry[], runSummary: string): SupervisorReport {
  return { outcome: "success", manualActions, summary: runSummary };
}

export function buildEscalationReport(
  manualActions: ManualActionEntry[],
  prdText: string,
  recentPlans: string[],
  recentRejections: string[],
): SupervisorReport {
  const lines = [
    "## Escalation: iteration cap reached without approval",
    "",
    "### PRD",
    prdText,
    "",
    "### Recent plan versions",
    ...recentPlans.map((plan, index) => `#### Iteration ${index + 1}\n${plan}`),
    "",
    "### Recent Reviewer rejections",
    ...recentRejections.map((rejection) => `- ${rejection}`),
  ];
  return { outcome: "escalation", manualActions, summary: lines.join("\n") };
}

export function formatReportAsMarkdown(report: SupervisorReport): string {
  const header = report.outcome === "success" ? "## Before taking this live" : "## Escalation report";
  const actions =
    report.manualActions.length === 0
      ? "_No manual actions required._"
      : report.manualActions.map((a) => `- **${a.attemptedAction}**: ${a.reason} — ${a.requiredManualStep}`).join("\n");
  return `${header}\n\n${actions}\n\n---\n\n${report.summary}`;
}
