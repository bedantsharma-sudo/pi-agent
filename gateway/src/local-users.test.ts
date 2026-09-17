import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { createLocalUserStore } from "./local-users.js";

describe("createLocalUserStore", () => {
  it("auto-provisions a new user with the default role on first getOrProvision", () => {
    const store = createLocalUserStore(openDatabase(":memory:"));
    const user = store.getOrProvision("new@example.com", "New Person");
    expect(user).toMatchObject({ email: "new@example.com", name: "New Person", role: "submit_prds" });
    expect(user.createdAt).toBeTruthy();
  });

  it("returns the same existing record on a second getOrProvision call, without changing role", () => {
    const store = createLocalUserStore(openDatabase(":memory:"));
    store.getOrProvision("existing@example.com", "Existing");
    store.setRole("existing@example.com", "admin");
    const second = store.getOrProvision("existing@example.com", "Existing (renamed ignored)");
    expect(second.role).toBe("admin");
    expect(second.name).toBe("Existing");
  });

  it("setRole changes an existing user's role", () => {
    const store = createLocalUserStore(openDatabase(":memory:"));
    store.getOrProvision("a@example.com", "A");
    store.setRole("a@example.com", "admin");
    expect(store.get("a@example.com")?.role).toBe("admin");
  });

  it("setRole throws for a user that doesn't exist", () => {
    const store = createLocalUserStore(openDatabase(":memory:"));
    expect(() => store.setRole("ghost@example.com", "admin")).toThrow("ghost@example.com");
  });

  it("get returns undefined for an unknown email", () => {
    const store = createLocalUserStore(openDatabase(":memory:"));
    expect(store.get("nobody@example.com")).toBeUndefined();
  });

  it("list returns every provisioned user", () => {
    const store = createLocalUserStore(openDatabase(":memory:"));
    store.getOrProvision("a@example.com", "A");
    store.getOrProvision("b@example.com", "B");
    expect(store.list().map((u) => u.email).sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("seedAdmins provisions each listed email as admin, creating it if absent and promoting it if present", () => {
    const store = createLocalUserStore(openDatabase(":memory:"));
    store.getOrProvision("already-here@example.com", "Already Here");
    store.seedAdmins(["already-here@example.com", "brand-new-admin@example.com"]);
    expect(store.get("already-here@example.com")?.role).toBe("admin");
    expect(store.get("brand-new-admin@example.com")).toMatchObject({ role: "admin", name: "brand-new-admin@example.com" });
  });
});
