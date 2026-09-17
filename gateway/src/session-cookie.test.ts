// gateway/src/session-cookie.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSessionCookie, verifySessionCookie } from "./session-cookie.js";

describe("session cookies", () => {
  it("round-trips a valid cookie back to its email", () => {
    const cookie = createSessionCookie("a@x.com", "secret");
    expect(verifySessionCookie(cookie, "secret")).toEqual({ email: "a@x.com" });
  });

  it("rejects a cookie verified with the wrong secret", () => {
    const cookie = createSessionCookie("a@x.com", "secret");
    expect(verifySessionCookie(cookie, "wrong-secret")).toBeNull();
  });

  it("rejects a tampered payload even if the signature format still parses", () => {
    const cookie = createSessionCookie("a@x.com", "secret");
    const [payload, signature] = cookie.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ email: "attacker@evil.com", exp: Date.now() + 1e9 })).toString(
      "base64url",
    );
    expect(verifySessionCookie(`${tamperedPayload}.${signature}`, "secret")).toBeNull();
    expect(payload).toBeTruthy(); // sanity: the original cookie did have a payload segment
  });

  it("rejects a malformed cookie string", () => {
    expect(verifySessionCookie("not-a-valid-cookie", "secret")).toBeNull();
  });

  it("rejects an expired cookie", () => {
    const almostExpiredSecret = "secret";
    const payload = Buffer.from(JSON.stringify({ email: "a@x.com", exp: Date.now() - 1000 })).toString("base64url");
    const signature = createHmac("sha256", almostExpiredSecret).update(payload).digest("base64url");
    expect(verifySessionCookie(`${payload}.${signature}`, almostExpiredSecret)).toBeNull();
  });
});
