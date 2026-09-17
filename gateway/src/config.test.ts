import { describe, expect, it } from "vitest";
import { loadGatewayConfig } from "./config.js";

describe("loadGatewayConfig", () => {
  const baseEnv = {
    GATEWAY_DB_PATH: "/tmp/gateway.db",
    FASTRR_BASE_URL: "https://fastrr-admin.fastrr.com",
    AGENT_SERVER_BASE_URL: "https://agent-server.internal",
    GATEWAY_SESSION_SECRET: "test-secret",
  };

  it("loads all required fields with defaults for optional ones", () => {
    const config = loadGatewayConfig(baseEnv);
    expect(config).toEqual({
      port: 4000,
      dbPath: "/tmp/gateway.db",
      fastrrBaseUrl: "https://fastrr-admin.fastrr.com",
      agentServerBaseUrl: "https://agent-server.internal",
      sessionCookieSecret: "test-secret",
      seedAdminEmails: [],
    });
  });

  it("parses GATEWAY_PORT when set", () => {
    const config = loadGatewayConfig({ ...baseEnv, GATEWAY_PORT: "8080" });
    expect(config.port).toBe(8080);
  });

  it("parses a comma-separated GATEWAY_SEED_ADMIN_EMAILS, trimming whitespace", () => {
    const config = loadGatewayConfig({ ...baseEnv, GATEWAY_SEED_ADMIN_EMAILS: "a@x.com, b@y.com ,c@z.com" });
    expect(config.seedAdminEmails).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
  });

  it("throws naming the missing variable when a required one is absent", () => {
    const { GATEWAY_DB_PATH, ...rest } = baseEnv;
    expect(() => loadGatewayConfig(rest)).toThrow("GATEWAY_DB_PATH");
  });
});
