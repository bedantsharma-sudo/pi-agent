export class SessionToolTracker {
  private calledTools = new Set<string>();

  recordCall(toolName: string): void {
    this.calledTools.add(toolName);
  }

  hasCalled(toolName: string): boolean {
    return this.calledTools.has(toolName);
  }
}

export interface SubmitGateResult {
  allowed: boolean;
  reason?: string;
}

export function checkSubmitGate(tracker: SessionToolTracker, requiredTools: string[]): SubmitGateResult {
  const missing = requiredTools.filter((tool) => !tracker.hasCalled(tool));
  if (missing.length > 0) {
    return { allowed: false, reason: `Cannot finalize yet — must call these tools first: ${missing.join(", ")}` };
  }
  return { allowed: true };
}
