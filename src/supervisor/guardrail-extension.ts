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

function recordManualAction(
  manualActions: ManualActionEntry[],
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
): void {
  manualActions.push({
    attemptedAction: `${toolName}(${JSON.stringify(input).slice(0, 200)})`,
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
    const verdict = await classify(toolName, input);
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
