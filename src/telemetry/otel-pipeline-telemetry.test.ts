import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { createPipelineTelemetryWithExporter } from "./otel-pipeline-telemetry.js";

// InMemorySpanExporter.shutdown() clears its buffer (confirmed empirically, not
// documented in its .d.ts) — every test must read getFinishedSpans() BEFORE calling
// telemetry.shutdown(), never after.

describe("createPipelineTelemetryWithExporter", () => {
  it("records a run span with the run id and human identity", () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createPipelineTelemetryWithExporter(exporter);
    telemetry.startRun("run-1", { "pipeline.human_identity": "alice@example.com" });
    telemetry.endRun("mr_opened", "https://gitlab.example.com/mr/1");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("run");
    expect(spans[0].attributes["pipeline.run_id"]).toBe("run-1");
    expect(spans[0].attributes["pipeline.human_identity"]).toBe("alice@example.com");
    expect(spans[0].attributes["pipeline.outcome"]).toBe("mr_opened");
  });

  it("nests stage spans under the run span, and tool-call spans under their stage", () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createPipelineTelemetryWithExporter(exporter);
    telemetry.startRun("run-1");
    const stage = telemetry.startStage("prd-critic");
    stage.recordToolCall({
      toolName: "mcp_gitnexus_query",
      toolCallId: "call-1",
      durationMs: 50,
      isError: false,
      resultSummary: "found 3 results",
    });
    stage.end("ok");
    telemetry.endRun("mr_opened");

    const spans = exporter.getFinishedSpans();
    const runSpan = spans.find((s) => s.name === "run")!;
    const stageSpan = spans.find((s) => s.name === "stage:prd-critic")!;
    const toolSpan = spans.find((s) => s.name === "tool_call:mcp_gitnexus_query")!;

    expect(stageSpan.parentSpanContext?.spanId).toBe(runSpan.spanContext().spanId);
    expect(toolSpan.parentSpanContext?.spanId).toBe(stageSpan.spanContext().spanId);
    expect(toolSpan.attributes["pipeline.result_summary"]).toBe("found 3 results");
    expect(stageSpan.attributes["pipeline.outcome"]).toBe("ok");
  });

  it("marks a tool-call span as ERROR when the tool call failed", () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createPipelineTelemetryWithExporter(exporter);
    telemetry.startRun("run-1");
    const stage = telemetry.startStage("prd-critic");
    stage.recordToolCall({
      toolName: "mcp_gitnexus_query",
      toolCallId: "call-1",
      durationMs: 10,
      isError: true,
      resultSummary: "connection refused",
    });
    stage.end("ok");
    telemetry.endRun("mr_opened");

    const toolSpan = exporter.getFinishedSpans().find((s) => s.name === "tool_call:mcp_gitnexus_query")!;
    expect(toolSpan.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it("records a blocked guardrail decision as an ERROR-status span", () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createPipelineTelemetryWithExporter(exporter);
    telemetry.startRun("run-1");
    telemetry.recordGuardrailDecision({
      tier: 1,
      toolName: "bash",
      blocked: true,
      reason: "Creating a DB index directly is devops's responsibility",
    });
    telemetry.endRun("mr_opened");

    const span = exporter.getFinishedSpans().find((s) => s.name === "guardrail:tier1")!;
    expect(span.attributes["pipeline.blocked"]).toBe(true);
    expect(span.status.code).toBe(2); // ERROR
  });

  it("records loop iterations as their own spans", () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createPipelineTelemetryWithExporter(exporter);
    telemetry.startRun("run-1");
    telemetry.recordLoopIteration(1, 30);
    telemetry.recordLoopIteration(2, 30);
    telemetry.endRun("mr_opened");

    const iterationSpans = exporter.getFinishedSpans().filter((s) => s.name === "loop_iteration");
    expect(iterationSpans).toHaveLength(2);
    expect(iterationSpans[1].attributes["pipeline.iteration"]).toBe(2);
  });

  it("shuts down the provider without throwing", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createPipelineTelemetryWithExporter(exporter);
    telemetry.startRun("run-1");
    telemetry.endRun("mr_opened");
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });
});
