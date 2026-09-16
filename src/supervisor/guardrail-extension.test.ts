import { describe, expect, it } from "vitest";
import { evaluateToolCall } from "./guardrail-extension.js";

describe("evaluateToolCall", () => {
  it("blocks and records a Tier-1 violation without calling the model", async () => {
    const manualActions: import("../types.js").ManualActionEntry[] = [];
    const result = await evaluateToolCall(
      "bash",
      { command: "CREATE INDEX idx ON orders(x)" },
      [],
      manualActions,
      async () => {
        throw new Error("classifyGrayArea should not be called for a Tier-1 match");
      },
    );
    expect(result?.block).toBe(true);
    expect(manualActions).toHaveLength(1);
    expect(manualActions[0].reason).toContain("index");
  });

  it("passes through an ordinary tool call untouched", async () => {
    const manualActions: import("../types.js").ManualActionEntry[] = [];
    const result = await evaluateToolCall("bash", { command: "mvn test" }, [], manualActions, async () => {
      throw new Error("classifyGrayArea should not be called");
    });
    expect(result).toBeUndefined();
    expect(manualActions).toHaveLength(0);
  });

  it("blocks and records when Tier-2 classifier returns block", async () => {
    const manualActions: import("../types.js").ManualActionEntry[] = [];
    const result = await evaluateToolCall(
      "write",
      { path: "/workspace/fastrr-oms/migrations/V2.sql" },
      [],
      manualActions,
      async () => ({ decision: "block", reason: "This is a schema migration" }),
    );
    expect(result?.block).toBe(true);
    expect(manualActions).toHaveLength(1);
  });

  it("flags without blocking when Tier-2 classifier returns flag", async () => {
    const manualActions: import("../types.js").ManualActionEntry[] = [];
    const result = await evaluateToolCall(
      "write",
      { path: "/workspace/fastrr-oms/migrations/V2.sql" },
      [],
      manualActions,
      async () => ({ decision: "flag", reason: "Probably fine, double-check before go-live" }),
    );
    expect(result).toBeUndefined();
    expect(manualActions).toHaveLength(1);
  });

  it("does not propagate a classifier rejection and degrades to a flag-equivalent result", async () => {
    const manualActions: import("../types.js").ManualActionEntry[] = [];
    const result = await evaluateToolCall(
      "write",
      { path: "/workspace/fastrr-oms/migrations/V2.sql" },
      [],
      manualActions,
      async () => {
        throw new Error("network timeout calling classifier");
      },
    );
    expect(result).toBeUndefined();
    expect(manualActions).toHaveLength(1);
    expect(manualActions[0].reason).toContain("classifier failed");
    expect(manualActions[0].reason).toContain("network timeout calling classifier");
  });

  it("redacts secret-shaped content from the recorded attemptedAction", async () => {
    const manualActions: import("../types.js").ManualActionEntry[] = [];
    const result = await evaluateToolCall(
      "write",
      {
        path: "/workspace/fastrr-oms/migrations/V2.sql",
        content: 'password="SuperSecret123456789" token=abcdefghijklmnopqrstuvwxyz0123456789',
      },
      [],
      manualActions,
      async () => ({ decision: "flag", reason: "Probably fine, double-check before go-live" }),
    );
    expect(result).toBeUndefined();
    expect(manualActions).toHaveLength(1);
    expect(manualActions[0].attemptedAction).not.toContain("SuperSecret123456789");
    expect(manualActions[0].attemptedAction).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(manualActions[0].attemptedAction).toContain("[REDACTED]");
  });
});
