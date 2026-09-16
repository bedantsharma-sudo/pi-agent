import { describe, expect, it } from "vitest";
import { buildEscalationReport, buildSuccessReport, formatReportAsMarkdown } from "./report.js";

describe("Supervisor report builders", () => {
  it("builds a success report", () => {
    const report = buildSuccessReport([{ attemptedAction: "a", reason: "b", requiredManualStep: "c" }], "Run summary");
    expect(report.outcome).toBe("success");
    expect(report.manualActions).toHaveLength(1);
    expect(report.summary).toBe("Run summary");
  });

  it("builds an escalation report including PRD, plans, and rejections", () => {
    const report = buildEscalationReport([], "Add feature X", ["plan v1", "plan v2"], ["missing tests", "wrong service"]);
    expect(report.outcome).toBe("escalation");
    expect(report.summary).toContain("Add feature X");
    expect(report.summary).toContain("plan v1");
    expect(report.summary).toContain("missing tests");
  });

  it("formats a success report as markdown with a manual-actions checklist", () => {
    const report = buildSuccessReport([{ attemptedAction: "a", reason: "b", requiredManualStep: "c" }], "All good");
    const markdown = formatReportAsMarkdown(report);
    expect(markdown).toContain("Before taking this live");
    expect(markdown).toContain("**a**: b — c");
  });

  it("formats a report with no manual actions as 'no actions required'", () => {
    const report = buildSuccessReport([], "All good");
    const markdown = formatReportAsMarkdown(report);
    expect(markdown).toContain("No manual actions required");
  });
});
