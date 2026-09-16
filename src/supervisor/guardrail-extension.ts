import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ManualActionEntry } from "../types.js";
import { checkTier1Rules } from "./tier1-rules.js";
import { needsTier2Judgment } from "./tier2-matcher.js";
import { classifyGrayArea, type Tier2Verdict } from "./tier2-judgment.js";

export interface GuardrailBlockResult {
  block: true;
  reason: string;
}

// Scoped narrowly: scrub the obvious secret shapes (labeled credentials, bearer tokens, and long
// base64/hex-looking blobs), not a general secrets-detection engine. manualActions entries get
// surfaced in the final Supervisor report for human/audit review, so raw tool-call input that
// happens to contain a credential must not be echoed verbatim.
function redactSecrets(text: string): string {
  let redacted = text;
  // Labeled credential fields, e.g. "password":"...", password=..., token: ..., Authorization=...
  redacted = redacted.replace(
    /\b(password|passwd|pwd|token|api[_-]?key|secret|access[_-]?key|authorization)\b(\s*[:=]\s*)"?([^\s"&,}]+)"?/gi,
    (_match, key: string, sep: string) => `${key}${sep}[REDACTED]`,
  );
  // Bearer tokens in an Authorization header value.
  redacted = redacted.replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");
  // Long base64/hex-looking blobs (20+ contiguous alphanumeric characters) not already caught above.
  redacted = redacted.replace(/\b[A-Za-z0-9]{20,}\b/g, "[REDACTED]");
  return redacted;
}

function recordManualAction(
  manualActions: ManualActionEntry[],
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
): void {
  const redactedInput = redactSecrets(JSON.stringify(input));
  manualActions.push({
    attemptedAction: `${toolName}(${redactedInput.slice(0, 200)})`,
    reason,
    requiredManualStep: reason,
  });
}

export async function evaluateToolCall(
  toolName: string,
  input: Record<string, unknown>,
  allowedServices: string[],
  manualActions: ManualActionEntry[],
  classify: (toolName: string, input: Record<string, unknown>) => Promise<Tier2Verdict>,
): Promise<GuardrailBlockResult | undefined> {
  const tier1 = checkTier1Rules(toolName, input, allowedServices);
  if (tier1.matched) {
    recordManualAction(manualActions, toolName, input, tier1.reason ?? "Blocked by Tier-1 guardrail rule");
    return { block: true, reason: tier1.reason ?? "Blocked by Tier-1 guardrail rule" };
  }

  if (needsTier2Judgment(toolName, input)) {
    let verdict: Tier2Verdict;
    try {
      verdict = await classify(toolName, input);
    } catch (error) {
      // A transient classifier failure (network error, timeout, rate limit) must not propagate:
      // the SDK's tool_call dispatcher has no try/catch around this handler, so an uncaught
      // rejection here would abort tool-call dispatch for the entire session. Degrade the same
      // way classifyGrayArea itself does when the model is unavailable: treat it as "flag".
      const message = error instanceof Error ? error.message : String(error);
      recordManualAction(
        manualActions,
        toolName,
        input,
        `Tier-2 classifier failed (${message}); flagging for manual review by default.`,
      );
      return undefined;
    }
    if (verdict.decision === "block") {
      recordManualAction(manualActions, toolName, input, verdict.reason);
      return { block: true, reason: verdict.reason };
    }
    if (verdict.decision === "flag") {
      recordManualAction(manualActions, toolName, input, verdict.reason);
    }
  }

  return undefined;
}

// The Planner's declared services can change across loop iterations (a revision can legitimately
// re-scope the plan), but Coder/Reviewer sessions are created once and persist for the whole loop
// (spec §4) — so this can't be a value captured once at session-creation time. The orchestrator
// mutates `allowedServicesHolder.services` each time a new plan is submitted (see Task 17), and this
// hook reads it fresh on every tool call.
export interface AllowedServicesHolder {
  services: string[];
}

export function createGuardrailExtension(manualActions: ManualActionEntry[], allowedServicesHolder: AllowedServicesHolder) {
  return function guardrailExtension(pi: ExtensionAPI) {
    pi.on("tool_call", async (event) => {
      if (
        isToolCallEventType("bash", event) ||
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event)
      ) {
        return evaluateToolCall(
          event.toolName,
          event.input as Record<string, unknown>,
          allowedServicesHolder.services,
          manualActions,
          classifyGrayArea,
        );
      }
      return undefined;
    });
  };
}
