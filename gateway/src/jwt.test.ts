// gateway/src/jwt.test.ts
import { describe, expect, it, vi } from "vitest";
import { mintScopedJwt } from "./jwt.js";
import type { LocalUser } from "./local-users.js";

describe("mintScopedJwt", () => {
  const user: LocalUser = { email: "a@x.com", name: "A", role: "submit_prds", createdAt: "2026-01-01T00:00:00.000Z" };

  it("POSTs to {agentServerBaseUrl}/internal/sign-jwt with the user's identity and returns the token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: "signed.jwt.token" }) });
    const result = await mintScopedJwt(user, "https://agent-server.internal", fetchImpl);
    expect(result).toEqual({ token: "signed.jwt.token" });
    expect(fetchImpl).toHaveBeenCalledWith("https://agent-server.internal/internal/sign-jwt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@x.com", name: "A", role: "submit_prds" }),
    });
  });

  it("throws a descriptive error when the signing call fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(mintScopedJwt(user, "https://agent-server.internal", fetchImpl)).rejects.toThrow(
      "Failed to mint JWT for a@x.com",
    );
  });

  it("throws when the response has no token field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(mintScopedJwt(user, "https://agent-server.internal", fetchImpl)).rejects.toThrow(
      "Failed to mint JWT for a@x.com",
    );
  });
});
