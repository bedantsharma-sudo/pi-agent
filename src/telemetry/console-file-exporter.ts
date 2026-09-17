import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hrTimeToMilliseconds, type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

function statusLabel(span: ReadableSpan): string {
  // SpanStatusCode: UNSET = 0, OK = 1, ERROR = 2
  if (span.status.code === 2) return "ERROR";
  return "ok";
}

function formatAttributes(span: ReadableSpan): string {
  const entries = Object.entries(span.attributes).filter(([key]) => key !== "pipeline.result_summary");
  if (entries.length === 0) return "";
  return " " + entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ");
}

/**
 * Prints one concise, human-readable line per span as it ends (real-time "what's
 * happening now" visibility — this is what replaces the ad-hoc `[tool call] →` stdout
 * prints), and appends the full span as a JSON line to a per-run file for later
 * inspection/replay. No batching: spans are exported as they complete, since the whole
 * point is live visibility into a running pipeline, not export efficiency.
 */
export class ConsoleFileSpanExporter implements SpanExporter {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      for (const span of spans) {
        const durationMs = hrTimeToMilliseconds(span.duration);
        const status = statusLabel(span);
        const resultSummary = span.attributes["pipeline.result_summary"];
        const summarySuffix = typeof resultSummary === "string" && resultSummary.length > 0 ? ` — ${resultSummary}` : "";
        console.log(`[telemetry] ${span.name} (${durationMs.toFixed(0)}ms) ${status}${formatAttributes(span)}${summarySuffix}`);

        const line = {
          name: span.name,
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          parentSpanId: span.parentSpanContext?.spanId,
          startTime: hrTimeToMilliseconds(span.startTime),
          durationMs,
          status,
          attributes: span.attributes,
          events: span.events.map((event) => ({
            name: event.name,
            time: hrTimeToMilliseconds(event.time),
            attributes: event.attributes,
          })),
        };
        appendFileSync(this.filePath, JSON.stringify(line) + "\n");
      }
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      resultCallback({ code: ExportResultCode.FAILED, error: error as Error });
    }
  }

  async shutdown(): Promise<void> {}
}
