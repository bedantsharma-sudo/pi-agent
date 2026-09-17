import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ManualActionEntry, TestRunResult } from "../types.js";
import type { PipelineTelemetry } from "../telemetry/types.js";

const DEFAULT_THRESHOLD = 3;

// Line numbers, timestamps, and durations differ on every run even when the underlying
// failure is identical, so comparing two `run_tests` summaries verbatim almost never matches
// twice in a row even when the Coder is stuck re-hitting the exact same root cause. Collapsing
// digit runs to "#" keeps the signature stable across re-runs while still distinguishing
// genuinely different failures (different exception class, different failing test name).
export function normalizeFailureSignature(summary: string): string {
  return summary.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 500);
}

export interface ThrashCheckResult {
  /** True only on the call that first crosses the threshold — fires once per streak, not on every failure after. */
  thrashDetected: boolean;
  consecutiveFailures: number;
  signature: string;
}

/**
 * Pure, stateful counter: tracks consecutive `run_tests` failures that share a normalized
 * failure signature. Knows nothing about the SDK on purpose — see
 * `createThrashDetectorExtension` below for the `tool_call`/`tool_result` wiring this feeds.
 */
export class ThrashDetector {
  private consecutiveFailures = 0;
  private lastSignature: string | undefined;
  private firedForCurrentStreak = false;

  constructor(private readonly threshold: number = DEFAULT_THRESHOLD) {}

  recordResult(passed: boolean, summary: string): ThrashCheckResult {
    if (passed) {
      this.consecutiveFailures = 0;
      this.lastSignature = undefined;
      this.firedForCurrentStreak = false;
      return { thrashDetected: false, consecutiveFailures: 0, signature: "" };
    }

    const signature = normalizeFailureSignature(summary);
    if (signature === this.lastSignature) {
      this.consecutiveFailures += 1;
    } else {
      this.consecutiveFailures = 1;
      this.lastSignature = signature;
      this.firedForCurrentStreak = false;
    }

    const crossedThreshold = this.consecutiveFailures >= this.threshold && !this.firedForCurrentStreak;
    if (crossedThreshold) {
      this.firedForCurrentStreak = true;
    }

    return { thrashDetected: crossedThreshold, consecutiveFailures: this.consecutiveFailures, signature };
  }
}

/**
 * Wires `ThrashDetector` into the Coder session. On the run_tests call that crosses the
 * threshold, this both (a) records the incident for the human — a manualAction for the final
 * Supervisor report, plus a live telemetry span so it's visible even if the run is later killed
 * mid-turn — and (b) halts the Coder for the rest of the run: every subsequent tool call is
 * blocked with `terminate: true` until a human clears it, instead of letting it keep retrying
 * the same failing fix indefinitely. This is a deliberately blunt stop, not an attempt to guide
 * the Coder toward the right fix (that was considered and rejected — see task history).
 */
export function createThrashDetectorExtension(
  manualActions: ManualActionEntry[],
  telemetry?: PipelineTelemetry,
  threshold: number = DEFAULT_THRESHOLD,
) {
  const detector = new ThrashDetector(threshold);
  let halted = false;
  let haltReason = "";

  return function thrashDetectorExtension(pi: ExtensionAPI) {
    pi.on("tool_result", (event) => {
      if (halted || event.toolName !== "run_tests") {
        return undefined;
      }
      const details = event.details as TestRunResult | undefined;
      if (!details) {
        return undefined;
      }

      const check = detector.recordResult(details.passed, details.summary);
      if (!check.thrashDetected) {
        return undefined;
      }

      const signaturePreview = check.signature.length > 160 ? `${check.signature.slice(0, 160)}…` : check.signature;
      halted = true;
      haltReason =
        `run_tests failed ${check.consecutiveFailures} times in a row with the same apparent cause ` +
        `("${signaturePreview}"). This usually means the failure is not something the Coder can fix by ` +
        `editing more code (e.g. an environment/build-tooling mismatch rather than a code bug) — halting ` +
        `the Coder for human review instead of letting it keep retrying blindly.`;

      manualActions.push({
        attemptedAction: `run_tests (×${check.consecutiveFailures}, same failure signature)`,
        reason: haltReason,
        requiredManualStep:
          "Investigate the repeated run_tests failure yourself — it may not be a code issue at all — before letting the Coder continue. The Coder has been halted for the remainder of this run.",
      });
      telemetry?.recordThrashWarning({
        toolName: "run_tests",
        consecutiveFailures: check.consecutiveFailures,
        reason: haltReason,
      });
      return undefined;
    });

    pi.on("tool_call", () => {
      if (!halted) {
        return undefined;
      }
      // Block every further tool call in this session, not just the next run_tests — "stop the
      // Coder until further notice", not just stop it from re-running tests. `terminate: true`
      // asks the SDK to end the turn early once every tool in the batch is blocked this way.
      return { block: true as const, reason: haltReason, terminate: true as const };
    });
  };
}
