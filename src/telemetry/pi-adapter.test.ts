import { describe, expect, it, vi } from "vitest";
import { attachSessionTelemetry } from "./pi-adapter.js";
import type { StageHandle } from "./types.js";

type Listener = (event: unknown) => void;

function makeFakeSession() {
  const listeners: Listener[] = [];
  return {
    subscribe: (listener: Listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
    emit: (event: unknown) => {
      for (const listener of listeners) listener(event);
    },
  };
}

describe("attachSessionTelemetry", () => {
  it("records a tool call once both tool_execution_start and tool_execution_end fire", () => {
    const session = makeFakeSession();
    const stage: StageHandle = { recordToolCall: vi.fn(), end: vi.fn() };
    attachSessionTelemetry(session as never, stage);

    session.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "mcp_gitnexus_query" });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "mcp_gitnexus_query",
      isError: false,
      result: { content: [{ type: "text", text: "3 results found" }] },
    });

    expect(stage.recordToolCall).toHaveBeenCalledTimes(1);
    const record = (stage.recordToolCall as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record.toolName).toBe("mcp_gitnexus_query");
    expect(record.isError).toBe(false);
    expect(record.resultSummary).toBe("3 results found");
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("marks the record as an error when isError is true", () => {
    const session = makeFakeSession();
    const stage: StageHandle = { recordToolCall: vi.fn(), end: vi.fn() };
    attachSessionTelemetry(session as never, stage);

    session.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read" });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      isError: true,
      result: { content: [{ type: "text", text: "ENOENT: no such file" }] },
    });

    const record = (stage.recordToolCall as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record.isError).toBe(true);
    expect(record.resultSummary).toBe("ENOENT: no such file");
  });

  it("truncates result summaries beyond 300 characters", () => {
    const session = makeFakeSession();
    const stage: StageHandle = { recordToolCall: vi.fn(), end: vi.fn() };
    attachSessionTelemetry(session as never, stage);

    const longText = "x".repeat(500);
    session.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "grep" });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "grep",
      isError: false,
      result: { content: [{ type: "text", text: longText }] },
    });

    const record = (stage.recordToolCall as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record.resultSummary.length).toBe(301); // 300 chars + ellipsis
  });

  it("stops recording after the returned unsubscribe function is called", () => {
    const session = makeFakeSession();
    const stage: StageHandle = { recordToolCall: vi.fn(), end: vi.fn() };
    const unsubscribe = attachSessionTelemetry(session as never, stage);
    unsubscribe();

    session.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read" });
    session.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", isError: false, result: { content: [] } });

    expect(stage.recordToolCall).not.toHaveBeenCalled();
  });
});
