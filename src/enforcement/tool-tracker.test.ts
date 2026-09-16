import { describe, expect, it } from "vitest";
import { checkSubmitGate, SessionToolTracker } from "./tool-tracker.js";

describe("SessionToolTracker + checkSubmitGate", () => {
  it("blocks when a required tool has not been called", () => {
    const tracker = new SessionToolTracker();
    tracker.recordCall("mcp__gitnexus");
    const gate = checkSubmitGate(tracker, ["mcp__gitnexus", "memory_read"]);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("memory_read");
  });

  it("allows when all required tools have been called", () => {
    const tracker = new SessionToolTracker();
    tracker.recordCall("mcp__gitnexus");
    tracker.recordCall("memory_read");
    const gate = checkSubmitGate(tracker, ["mcp__gitnexus", "memory_read"]);
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBeUndefined();
  });

  it("allows immediately when no tools are required", () => {
    const tracker = new SessionToolTracker();
    const gate = checkSubmitGate(tracker, []);
    expect(gate.allowed).toBe(true);
  });
});
