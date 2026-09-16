import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkSubmitGate, SessionToolTracker } from "./tool-tracker.js";

export function createMandatoryToolsExtension(submitToolName: string, requiredTools: string[]) {
  const tracker = new SessionToolTracker();
  return function mandatoryToolsExtension(pi: ExtensionAPI) {
    pi.on("tool_call", (event) => {
      tracker.recordCall(event.toolName);
      if (event.toolName === submitToolName) {
        const gate = checkSubmitGate(tracker, requiredTools);
        if (!gate.allowed) {
          return { block: true as const, reason: gate.reason };
        }
      }
      return undefined;
    });
  };
}
