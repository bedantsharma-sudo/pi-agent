// gateway/src/fastrr-auth.test.ts
import { describe, expect, it, vi } from "vitest";
import { validateFastrrToken } from "./fastrr-auth.js";

describe("validateFastrrToken", () => {
  it("returns the identity on a successful response, calling the correct URL and header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "1", email: "rizwan1@pickrr.com", name: "Rizwan" } }),
    });
    const identity = await validateFastrrToken(
      "rizwan1@pickrr.com",
      "the-token",
      "https://fastrr-admin.fastrr.com",
      fetchImpl,
    );
    expect(identity).toEqual({ id: "1", email: "rizwan1@pickrr.com", name: "Rizwan" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://fastrr-admin.fastrr.com/api/ve1/aggregator-service/user/login-detail/?email=rizwan1%40pickrr.com",
      { headers: { "X-Auth-Token": "the-token" } },
    );
  });

  it("returns null when the response is not ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    const identity = await validateFastrrToken("a@x.com", "bad-token", "https://fastrr-admin.fastrr.com", fetchImpl);
    expect(identity).toBeNull();
  });

  it("returns null when the response body has no data field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const identity = await validateFastrrToken("a@x.com", "token", "https://fastrr-admin.fastrr.com", fetchImpl);
    expect(identity).toBeNull();
  });

  it("propagates a network error rather than silently returning null", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      validateFastrrToken("a@x.com", "token", "https://fastrr-admin.fastrr.com", fetchImpl),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("URL-encodes an email containing special characters", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "2", email: "a+test@x.com", name: "A" } }),
    });
    await validateFastrrToken("a+test@x.com", "token", "https://fastrr-admin.fastrr.com", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://fastrr-admin.fastrr.com/api/ve1/aggregator-service/user/login-detail/?email=a%2Btest%40x.com",
      { headers: { "X-Auth-Token": "token" } },
    );
  });
});
