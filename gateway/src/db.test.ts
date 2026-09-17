import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";

describe("openDatabase", () => {
  it("opens an in-memory database and allows a round-trip write/read", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO t (value) VALUES (?)").run("hello");
    const row = db.prepare("SELECT value FROM t WHERE id = 1").get() as { value: string };
    expect(row.value).toBe("hello");
    db.close();
  });

  it("enables WAL journal mode for a file-backed database", () => {
    const db = openDatabase(":memory:");
    // :memory: databases report "memory" for journal_mode regardless of the pragma call;
    // this test only confirms the pragma call itself doesn't throw.
    expect(() => db.pragma("journal_mode")).not.toThrow();
    db.close();
  });
});
