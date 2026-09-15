export interface RunConfig {
  runId: string;
  prdText: string;
  workspaceRoot: string;
  humanIdentity: string;
  maxLoopIterations: number;
  auditLogPath: string;
  memoryDir: string;
  piProjectRoot: string;
}

export interface PlanArtifact {
  planMarkdown: string;
  services: string[];
  notes: string;
}

export interface ReviewVerdict {
  status: "approve" | "revise";
  findings: string[];
}

export interface TestRunResult {
  passed: boolean;
  summary: string;
}

export interface ManualActionEntry {
  attemptedAction: string;
  reason: string;
  requiredManualStep: string;
}

export interface SupervisorReport {
  outcome: "success" | "escalation";
  manualActions: ManualActionEntry[];
  summary: string;
}
