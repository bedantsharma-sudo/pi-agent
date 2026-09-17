/**
 * SDK-agnostic telemetry interface. Nothing outside `src/telemetry/` should import
 * `@earendil-works/pi-coding-agent`'s event types for observability purposes — call
 * sites (orchestrator, loop, session factories, the guardrail extension) only ever see
 * `PipelineTelemetry`/`StageHandle`. If the underlying agent SDK is ever swapped (Google
 * ADK, Pydantic AI, etc.), only `src/telemetry/pi-adapter.ts` needs to change; this
 * interface and its OTel-backed implementation do not.
 */

export type StageName = "prd-critic" | "planner" | "coder" | "reviewer";

export interface ToolCallRecord {
  toolName: string;
  toolCallId: string;
  durationMs: number;
  isError: boolean;
  /** Truncated, human-readable summary of the tool result — never raw secrets. */
  resultSummary: string;
}

export interface GuardrailDecisionRecord {
  tier: 1 | 2;
  toolName: string;
  blocked: boolean;
  reason: string;
}

export interface ThrashWarningRecord {
  toolName: string;
  consecutiveFailures: number;
  reason: string;
}

export interface StageHandle {
  recordToolCall(record: ToolCallRecord): void;
  end(outcome: "ok" | "error", detail?: string): void;
}

export interface PipelineTelemetry {
  startRun(runId: string, attributes?: Record<string, string | number>): void;
  endRun(outcome: string, detail?: string): void;
  /** `iteration` is omitted for the PRD-critic stage, which doesn't loop. */
  startStage(name: StageName, iteration?: number): StageHandle;
  recordLoopIteration(iteration: number, maxIterations: number): void;
  recordGuardrailDecision(record: GuardrailDecisionRecord): void;
  /** Fired when the same tool has failed with the same apparent cause several times in a row (see thrash-detector.ts). */
  recordThrashWarning(record: ThrashWarningRecord): void;
  /** Flushes any buffered spans. Call once, at the very end of a run. */
  shutdown(): Promise<void>;
}
