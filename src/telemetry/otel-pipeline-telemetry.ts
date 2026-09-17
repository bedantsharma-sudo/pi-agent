import { ROOT_CONTEXT, SpanStatusCode, trace, type Span, type Tracer } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ConsoleFileSpanExporter } from "./console-file-exporter.js";
import type {
  GuardrailDecisionRecord,
  PipelineTelemetry,
  StageHandle,
  StageName,
  ThrashWarningRecord,
  ToolCallRecord,
} from "./types.js";

class OtelStageHandle implements StageHandle {
  constructor(
    private readonly span: Span,
    private readonly tracer: Tracer,
  ) {}

  recordToolCall(record: ToolCallRecord): void {
    const endTimeMs = Date.now();
    const startTimeMs = endTimeMs - record.durationMs;
    const parentContext = trace.setSpan(ROOT_CONTEXT, this.span);
    const child = this.tracer.startSpan(`tool_call:${record.toolName}`, { startTime: startTimeMs }, parentContext);
    child.setAttributes({
      "pipeline.tool_name": record.toolName,
      "pipeline.tool_call_id": record.toolCallId,
      "pipeline.result_summary": record.resultSummary,
    });
    if (record.isError) {
      child.setStatus({ code: SpanStatusCode.ERROR, message: record.resultSummary });
    }
    child.end(endTimeMs);
  }

  end(outcome: "ok" | "error", detail?: string): void {
    this.span.setAttribute("pipeline.outcome", outcome);
    if (detail) {
      this.span.setAttribute("pipeline.result_summary", detail);
    }
    if (outcome === "error") {
      this.span.setStatus({ code: SpanStatusCode.ERROR, message: detail });
    }
    this.span.end();
  }
}

/**
 * OTel-backed implementation of the abstract `PipelineTelemetry` interface (see
 * types.ts for why this split exists), parameterized over the exporter so tests can
 * inject an `InMemorySpanExporter` instead of writing real files/console output.
 * `createOtelPipelineTelemetry` below is the production entry point.
 */
export function createPipelineTelemetryWithExporter(exporter: SpanExporter): PipelineTelemetry {
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "pi-pipeline" }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("pi-pipeline");
  let runSpan: Span | undefined;

  return {
    startRun(runId, attributes) {
      runSpan = tracer.startSpan("run", { attributes: { "pipeline.run_id": runId, ...attributes } });
    },

    endRun(outcome, detail) {
      if (!runSpan) return;
      runSpan.setAttribute("pipeline.outcome", outcome);
      if (detail) {
        runSpan.setAttribute("pipeline.result_summary", detail);
      }
      runSpan.end();
    },

    startStage(name: StageName, iteration?: number): StageHandle {
      if (!runSpan) {
        throw new Error("startStage() called before startRun()");
      }
      const parentContext = trace.setSpan(ROOT_CONTEXT, runSpan);
      const span = tracer.startSpan(`stage:${name}`, undefined, parentContext);
      span.setAttributes({
        "pipeline.stage": name,
        ...(iteration !== undefined ? { "pipeline.iteration": iteration } : {}),
      });
      return new OtelStageHandle(span, tracer);
    },

    recordLoopIteration(iteration, maxIterations) {
      if (!runSpan) return;
      const parentContext = trace.setSpan(ROOT_CONTEXT, runSpan);
      const span = tracer.startSpan("loop_iteration", undefined, parentContext);
      span.setAttributes({ "pipeline.iteration": iteration, "pipeline.max_iterations": maxIterations });
      span.end();
    },

    recordGuardrailDecision(record: GuardrailDecisionRecord) {
      if (!runSpan) return;
      const parentContext = trace.setSpan(ROOT_CONTEXT, runSpan);
      const span = tracer.startSpan(`guardrail:tier${record.tier}`, undefined, parentContext);
      span.setAttributes({
        "pipeline.tool_name": record.toolName,
        "pipeline.blocked": record.blocked,
        "pipeline.result_summary": record.reason,
      });
      if (record.blocked) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: record.reason });
      }
      span.end();
    },

    recordThrashWarning(record: ThrashWarningRecord) {
      if (!runSpan) return;
      const parentContext = trace.setSpan(ROOT_CONTEXT, runSpan);
      const span = tracer.startSpan("supervisor:thrash_detected", undefined, parentContext);
      span.setAttributes({
        "pipeline.tool_name": record.toolName,
        "pipeline.consecutive_failures": record.consecutiveFailures,
        "pipeline.result_summary": record.reason,
      });
      // ERROR status, same as a blocked guardrail decision, so this stands out in the live
      // console stream and the run's telemetry file even if the run is later killed before
      // the Supervisor's final report would otherwise have surfaced it.
      span.setStatus({ code: SpanStatusCode.ERROR, message: record.reason });
      span.end();
    },

    async shutdown() {
      await provider.shutdown();
    },
  };
}

/**
 * Production entry point: spans go to `filePath` (JSON lines) and stdout (one concise
 * line per span) via `ConsoleFileSpanExporter` — see that file's own comment for why
 * this uses a `SimpleSpanProcessor`, not batched.
 */
export function createOtelPipelineTelemetry(filePath: string): PipelineTelemetry {
  return createPipelineTelemetryWithExporter(new ConsoleFileSpanExporter(filePath));
}
