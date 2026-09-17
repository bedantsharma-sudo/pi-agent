import { describe, expect, it } from "vitest";
import { checkTier1Rules } from "./tier1-rules.js";

describe("checkTier1Rules", () => {
  it("blocks a bash command that creates a DB index directly", () => {
    const result = checkTier1Rules("bash", { command: "mysql -e 'CREATE INDEX idx_x ON orders(x)'" }, ["fastrr-oms"]);
    expect(result.matched).toBe(true);
    expect(result.reason).toContain("index");
  });

  it("blocks ALTER TABLE", () => {
    const result = checkTier1Rules("bash", { command: "psql -c 'ALTER TABLE orders ADD COLUMN x int'" }, ["fastrr-oms"]);
    expect(result.matched).toBe(true);
  });

  it("blocks DROP TABLE/INDEX/DATABASE", () => {
    expect(checkTier1Rules("bash", { command: "DROP TABLE orders" }, []).matched).toBe(true);
    expect(checkTier1Rules("bash", { command: "DROP INDEX idx_x" }, []).matched).toBe(true);
    expect(checkTier1Rules("bash", { command: "DROP DATABASE fastrr" }, []).matched).toBe(true);
  });

  it("blocks running a schema migration tool directly", () => {
    const result = checkTier1Rules("bash", { command: "flyway migrate" }, []);
    expect(result.matched).toBe(true);
  });

  it("allows an ordinary bash command", () => {
    const result = checkTier1Rules("bash", { command: "mvn test -q" }, []);
    expect(result.matched).toBe(false);
  });

  it("blocks a write/edit outside the plan's declared services", () => {
    const result = checkTier1Rules("write", { path: "/workspace/payment-core/src/Main.java" }, ["aggregator-service"]);
    expect(result.matched).toBe(true);
    expect(result.reason).toContain("out of scope");
  });

  it("allows a write/edit inside a declared service", () => {
    const result = checkTier1Rules("write", { path: "/workspace/aggregator-service/src/Main.java" }, [
      "aggregator-service",
    ]);
    expect(result.matched).toBe(false);
  });

  it("allows any path when allowedServices is empty (not yet known)", () => {
    const result = checkTier1Rules("write", { path: "/workspace/anything/Main.java" }, []);
    expect(result.matched).toBe(false);
  });

  it("allows a relative path (no leading slash) starting with a declared service (regression)", () => {
    // Confirmed against a real run: the Coder passed a relative path like this for an
    // edit inside payment-aggregator, and it was wrongly blocked as out-of-scope.
    const result = checkTier1Rules(
      "edit",
      { path: "payment-aggregator/src/test/java/com/pickrr/payment/core/services/PgOrchestrationSwitchServiceTest.java" },
      ["payment-core", "payment-aggregator"],
    );
    expect(result.matched).toBe(false);
  });

  it("still blocks a relative path outside every declared service", () => {
    const result = checkTier1Rules("edit", { path: "fastrr-oms/src/Main.java" }, ["payment-core", "payment-aggregator"]);
    expect(result.matched).toBe(true);
  });
});
