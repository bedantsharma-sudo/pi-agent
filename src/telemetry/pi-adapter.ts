import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { StageHandle } from "./types.js";

const MAX_SUMMARY_LENGTH = 300;

function summarizeResult(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const text = content
    .map((item) =>
      item && typeof item === "object" && "text" in item ? String((item as { text?: unknown }).text ?? "") : "",
    )
    .join(" ")
    .trim();
  return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH)}…` : text;
}

/**
 * Bridges a Pi `AgentSession`'s tool-execution events onto the SDK-agnostic
 * `StageHandle` interface. This is the only file in the codebase that should know Pi's
 * event shapes for telemetry purposes — swap the underlying agent SDK for Google ADK,
 * Pydantic AI, etc. later, and only this file needs rewriting; `types.ts` and
 * `otel-pipeline-telemetry.ts` do not change.
 *
 * Uses `tool_execution_start`/`tool_execution_end` (fired via
 * `AgentSession.subscribe()`), not the `pi.on("tool_call"/"tool_result", ...)`
 * extension hooks the Supervisor guardrail/mandatory-tools extensions use — those exist
 * to gate/observe from *inside* a running session (see guardrail-extension.ts), while
 * this adapter observes from the outside, the same way orchestrator.ts's old debug
 * `console.log` did.
 */
export function attachSessionTelemetry(session: AgentSession, stage: StageHandle): () => void {
  const startTimes = new Map<string, number>();

  return session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      startTimes.set(event.toolCallId, Date.now());
      return;
    }
    if (event.type === "tool_execution_end") {
      const startedAt = startTimes.get(event.toolCallId) ?? Date.now();
      startTimes.delete(event.toolCallId);
      stage.recordToolCall({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        durationMs: Date.now() - startedAt,
        isError: Boolean(event.isError),
        resultSummary: summarizeResult(event.result?.content),
      });
    }
  });
}
