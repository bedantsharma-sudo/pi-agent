// gateway/src/app.test.ts
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { openDatabase } from "./db.js";
import { createLocalUserStore } from "./local-users.js";
import { createJobRegistry } from "./job-registry.js";
import { createGatewayApp } from "./app.js";

function buildTestApp(overrides: Partial<Parameters<typeof createGatewayApp>[0]> = {}) {
  const localUsers = createLocalUserStore(openDatabase(":memory:"));
  const jobRegistry = createJobRegistry(openDatabase(":memory:"));
  const validateFastrrToken = vi.fn().mockResolvedValue({ id: "1", email: "a@x.com", name: "A" });
  const mintScopedJwt = vi.fn().mockResolvedValue({ token: "minted.jwt" });
  const app = createGatewayApp({
    localUsers,
    jobRegistry,
    fastrrBaseUrl: "https://fastrr-admin.fastrr.com",
    agentServerBaseUrl: "https://agent-server.internal",
    sessionCookieSecret: "test-secret",
    validateFastrrToken,
    mintScopedJwt,
    ...overrides,
  });
  return { app, localUsers, jobRegistry, validateFastrrToken, mintScopedJwt };
}

describe("GET /auth/login", () => {
  it("redirects to the Fastrr Admin auth-and-redirect URL with this project's source", async () => {
    const { app } = buildTestApp();
    const response = await request(app).get("/auth/login");
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(
      "https://fastrr-admin.fastrr.com/auth-and-redirect?source=pi-pipeline",
    );
  });
});

describe("GET /auth/callback", () => {
  it("validates the token, auto-provisions the local user, sets a session cookie, and redirects to /", async () => {
    const { app, localUsers } = buildTestApp();
    const response = await request(app).get("/auth/callback?email=a@x.com&token=the-token");
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/");
    expect(response.headers["set-cookie"]?.[0]).toMatch(/^pipeline_session=/);
    expect(localUsers.get("a@x.com")).toMatchObject({ email: "a@x.com", role: "submit_prds" });
  });

  it("responds 401 without setting a cookie when Fastrr Admin validation fails", async () => {
    const { app, validateFastrrToken } = buildTestApp();
    validateFastrrToken.mockResolvedValue(null);
    const response = await request(app).get("/auth/callback?email=a@x.com&token=bad-token");
    expect(response.status).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("responds 400 when email or token query params are missing", async () => {
    const { app } = buildTestApp();
    const response = await request(app).get("/auth/callback?email=a@x.com");
    expect(response.status).toBe(400);
  });

  it("responds 502 without hanging or throwing when Fastrr Admin validation rejects", async () => {
    const { app, validateFastrrToken } = buildTestApp();
    validateFastrrToken.mockRejectedValue(new Error("ECONNREFUSED"));
    const response = await request(app).get("/auth/callback?email=a@x.com&token=the-token");
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "Upstream identity provider unavailable" });
  });
});

describe("GET /api/me", () => {
  it("returns the current user's identity and role when a valid session cookie is present", async () => {
    const { app } = buildTestApp();
    const loginResponse = await request(app).get("/auth/callback?email=a@x.com&token=the-token");
    const cookie = loginResponse.headers["set-cookie"][0];

    const meResponse = await request(app).get("/api/me").set("Cookie", cookie);
    expect(meResponse.status).toBe(200);
    expect(meResponse.body).toEqual({ email: "a@x.com", name: "A", role: "submit_prds" });
  });

  it("returns 401 with no session cookie", async () => {
    const { app } = buildTestApp();
    const response = await request(app).get("/api/me");
    expect(response.status).toBe(401);
  });

  it("returns 401 with a session cookie signed by a different secret", async () => {
    const { app } = buildTestApp({ sessionCookieSecret: "a-different-secret" });
    const response = await request(app).get("/api/me").set("Cookie", "pipeline_session=garbage.signature");
    expect(response.status).toBe(401);
  });
});
