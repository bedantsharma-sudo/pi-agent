export interface GatewayConfig {
  port: number;
  dbPath: string;
  fastrrBaseUrl: string;
  agentServerBaseUrl: string;
  sessionCookieSecret: string;
  seedAdminEmails: string[];
}

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function loadGatewayConfig(env: Record<string, string | undefined>): GatewayConfig {
  return {
    port: env.GATEWAY_PORT ? Number(env.GATEWAY_PORT) : 4000,
    dbPath: requireEnv(env, "GATEWAY_DB_PATH"),
    fastrrBaseUrl: requireEnv(env, "FASTRR_BASE_URL"),
    agentServerBaseUrl: requireEnv(env, "AGENT_SERVER_BASE_URL"),
    sessionCookieSecret: requireEnv(env, "GATEWAY_SESSION_SECRET"),
    seedAdminEmails: (env.GATEWAY_SEED_ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
