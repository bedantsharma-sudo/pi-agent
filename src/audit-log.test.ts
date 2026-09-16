import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAuditLogEntry, hashPrdText } from "./audit-log.js";

describe("hashPrdText", () => {
  it("is deterministic for the same text", () => {
    expect(hashPrdText("Add feature X")).toBe(hashPrdText("Add feature X"));
  });

  it("differs for different text", () => {
    expect(hashPrdText("Add feature X")).not.toBe(hashPrdText("Add feature Y"));
  });
});

describe("appendAuditLogEntry", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "audit-log-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the file and appends a JSONL entry, including nested directories", async () => {
    const logPath = join(dir, "nested", "audit.jsonl");
    await appendAuditLogEntry(logPath, {
      timestamp: "2026-09-15T00:00:00.000Z",
      humanIdentifier: "alice@example.com",
      runId: "abc-123",
      prdHash: hashPrdText("Add feature X"),
    });
    const contents = await readFile(logPath, "utf-8");
    const entry = JSON.parse(contents.trim());
    expect(entry.humanIdentifier).toBe("alice@example.com");
    expect(entry.runId).toBe("abc-123");
  });

  it("appends a second entry on a subsequent call without clobbering the first", async () => {
    const logPath = join(dir, "audit.jsonl");
    await appendAuditLogEntry(logPath, { timestamp: "t1", humanIdentifier: "alice", runId: "1", prdHash: "h1" });
    await appendAuditLogEntry(logPath, { timestamp: "t2", humanIdentifier: "bob", runId: "2", prdHash: "h2" });
    const lines = (await readFile(logPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
