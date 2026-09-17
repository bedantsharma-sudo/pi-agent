import { describe, expect, it } from "vitest";
import { createThrashDetectorExtension, normalizeFailureSignature, ThrashDetector } from "./thrash-detector.js";

describe("normalizeFailureSignature", () => {
  it("collapses digit runs so line numbers/timestamps don't defeat matching", () => {
    const a = "ExceptionInInitializerError at RazorpayService.java:142, took 3821ms";
    const b = "ExceptionInInitializerError at RazorpayService.java:198, took 4110ms";
    expect(normalizeFailureSignature(a)).toBe(normalizeFailureSignature(b));
  });

  it("still distinguishes genuinely different failures", () => {
    const a = "cannot find symbol: method builder()";
    const b = "MongoTimeoutException: mongo-01.dev.internal:27017";
    expect(normalizeFailureSignature(a)).not.toBe(normalizeFailureSignature(b));
  });
});

describe("ThrashDetector", () => {
  it("does not flag a passing result", () => {
    const detector = new ThrashDetector(3);
    const result = detector.recordResult(true, "135/136 tests passed");
    expect(result.thrashDetected).toBe(false);
    expect(result.consecutiveFailures).toBe(0);
  });

  it("does not flag fewer consecutive failures than the threshold", () => {
    const detector = new ThrashDetector(3);
    expect(detector.recordResult(false, "cannot find symbol: builder()").thrashDetected).toBe(false);
    expect(detector.recordResult(false, "cannot find symbol: builder()").thrashDetected).toBe(false);
  });

  it("fires exactly once, on the call that crosses the threshold", () => {
    const detector = new ThrashDetector(3);
    expect(detector.recordResult(false, "cannot find symbol: builder()").thrashDetected).toBe(false);
    expect(detector.recordResult(false, "cannot find symbol: builder()").thrashDetected).toBe(false);
    const third = detector.recordResult(false, "cannot find symbol: builder()");
    expect(third.thrashDetected).toBe(true);
    expect(third.consecutiveFailures).toBe(3);
    // Same signature, streak continues past the threshold — must not fire again for this streak.
    const fourth = detector.recordResult(false, "cannot find symbol: builder()");
    expect(fourth.thrashDetected).toBe(false);
    expect(fourth.consecutiveFailures).toBe(4);
  });

  it("resets the streak when the failure signature changes", () => {
    const detector = new ThrashDetector(3);
    detector.recordResult(false, "cannot find symbol: builder()");
    detector.recordResult(false, "cannot find symbol: builder()");
    const changed = detector.recordResult(false, "MongoTimeoutException: mongo-01.dev.internal");
    expect(changed.thrashDetected).toBe(false);
    expect(changed.consecutiveFailures).toBe(1);
  });

  it("resets the streak on a passing run, so a later identical failure can re-trigger", () => {
    const detector = new ThrashDetector(3);
    detector.recordResult(false, "cannot find symbol: builder()");
    detector.recordResult(false, "cannot find symbol: builder()");
    detector.recordResult(true, "all tests passed");
    expect(detector.recordResult(false, "cannot find symbol: builder()").thrashDetected).toBe(false);
    expect(detector.recordResult(false, "cannot find symbol: builder()").thrashDetected).toBe(false);
    expect(detector.recordResult(false, "cannot find symbol: builder()").thrashDetected).toBe(true);
  });

  it("tolerates a custom threshold", () => {
    const detector = new ThrashDetector(2);
    expect(detector.recordResult(false, "boom").thrashDetected).toBe(false);
    expect(detector.recordResult(false, "boom").thrashDetected).toBe(true);
  });
});

// Minimal fake of the ExtensionAPI surface this extension actually uses, so the
// halt-and-block wiring (the part that makes this more than a logging feature) is covered,
// not just the pure ThrashDetector counter above.
function createFakePi() {
  const handlers: Record<string, ((event: unknown) => unknown)[]> = {};
  return {
    pi: {
      on(event: string, handler: (event: unknown) => unknown) {
        (handlers[event] ??= []).push(handler);
      },
    },
    async fireToolResult(event: unknown) {
      const results = [];
      for (const handler of handlers.tool_result ?? []) {
        results.push(await handler(event));
      }
      return results;
    },
    async fireToolCall(event: unknown) {
      const results = [];
      for (const handler of handlers.tool_call ?? []) {
        results.push(await handler(event));
      }
      return results;
    },
  };
}

describe("createThrashDetectorExtension", () => {
  it("does not block tool calls before the threshold is crossed", async () => {
    const manualActions: import("../types.js").ManualActionEntry[] = [];
    const extension = createThrashDetectorExtension(manualActions, undefined, 3);
    const { pi, fireToolResult, fireToolCall } = createFakePi();
    extension(pi as never);

    await fireToolResult({ toolName: "run_tests", details: { passed: false, summary: "cannot find symbol: builder()" } });
    const [callResult] = await fireToolCall({ toolName: "bash", input: { command: "mvn test" } });
    expect(callResult).toBeUndefined();
    expect(manualActions).toHaveLength(0);
  });

  it("halts the session and records a manualAction once the threshold is crossed", async () => {
    const manualActions: import("../types.js").ManualActionEntry[] = [];
    const warnings: import("../telemetry/types.js").ThrashWarningRecord[] = [];
    const telemetry = { recordThrashWarning: (record: import("../telemetry/types.js").ThrashWarningRecord) => warnings.push(record) };
    const extension = createThrashDetectorExtension(manualActions, telemetry as never, 3);
    const { pi, fireToolResult, fireToolCall } = createFakePi();
    extension(pi as never);

    for (let i = 0; i < 3; i++) {
      await fireToolResult({ toolName: "run_tests", details: { passed: false, summary: "cannot find symbol: builder()" } });
    }
    expect(manualActions).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].consecutiveFailures).toBe(3);

    // Every subsequent tool call — not just another run_tests — must now be blocked and
    // terminated, "stop the Coder until further notice", regardless of which tool it tries next.
    const [blocked] = await fireToolCall({ toolName: "edit", input: { path: "/workspace/payment-core/pom.xml" } });
    expect(blocked).toMatchObject({ block: true, terminate: true });
  });

  it("ignores tool_result events for tools other than run_tests", async () => {
    const manualActions: import("../types.js").ManualActionEntry[] = [];
    const extension = createThrashDetectorExtension(manualActions, undefined, 1);
    const { pi, fireToolResult, fireToolCall } = createFakePi();
    extension(pi as never);

    await fireToolResult({ toolName: "bash", details: undefined, isError: true });
    const [callResult] = await fireToolCall({ toolName: "bash", input: { command: "mvn test" } });
    expect(callResult).toBeUndefined();
    expect(manualActions).toHaveLength(0);
  });
});
