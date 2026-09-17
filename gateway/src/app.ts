// gateway/src/app.ts
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { LocalUserStore } from "./local-users.js";
import type { JobRegistry } from "./job-registry.js";
import { validateFastrrToken as defaultValidateFastrrToken, type FastrrIdentity } from "./fastrr-auth.js";
import { mintScopedJwt as defaultMintScopedJwt, type ScopedJwt } from "./jwt.js";
import { createSessionCookie, verifySessionCookie } from "./session-cookie.js";
import type { LocalUser } from "./local-users.js";

const SESSION_COOKIE_NAME = "pipeline_session";
const SOURCE = "pi-pipeline";

export interface GatewayAppDeps {
  localUsers: LocalUserStore;
  jobRegistry: JobRegistry;
  fastrrBaseUrl: string;
  agentServerBaseUrl: string;
  sessionCookieSecret: string;
  validateFastrrToken?: (email: string, token: string, fastrrBaseUrl: string) => Promise<FastrrIdentity | null>;
  mintScopedJwt?: (user: LocalUser, agentServerBaseUrl: string) => Promise<ScopedJwt>;
}

function parseSessionCookie(req: Request, secret: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!match) return null;
  const cookieValue = match.slice(`${SESSION_COOKIE_NAME}=`.length);
  const payload = verifySessionCookie(cookieValue, secret);
  return payload?.email ?? null;
}

export function createGatewayApp(deps: GatewayAppDeps): Express {
  const validateFastrrToken = deps.validateFastrrToken ?? defaultValidateFastrrToken;
  const mintScopedJwt = deps.mintScopedJwt ?? defaultMintScopedJwt;
  const app = express();

  // This is deliberately the fixed, public Fastrr Admin login-portal domain — NOT
  // deps.fastrrBaseUrl. Spec §3 step 1 hits fastrr-admin.fastrr.com literally (the
  // human-facing redirect), while deps.fastrrBaseUrl (used below in /auth/callback) is the
  // separate, independently-configurable base for the server-to-server aggregator-service API
  // call (spec §3 step 3) — agent_one keys a dev-bypass off that second value pointing at a
  // completely different domain (api-dev.pickrr.com), confirming the two are not meant to be
  // the same setting. Do not collapse these into one config value.
  app.get("/auth/login", (_req: Request, res: Response) => {
    res.redirect(`https://fastrr-admin.fastrr.com/auth-and-redirect?source=${SOURCE}`);
  });

  app.get("/auth/callback", async (req: Request, res: Response) => {
    const email = typeof req.query.email === "string" ? req.query.email : undefined;
    const token = typeof req.query.token === "string" ? req.query.token : undefined;
    if (!email || !token) {
      res.status(400).json({ error: "Missing email or token query parameter" });
      return;
    }

    let identity: FastrrIdentity | null;
    try {
      identity = await validateFastrrToken(email, token, deps.fastrrBaseUrl);
    } catch (err) {
      res.status(502).json({ error: "Upstream identity provider unavailable" });
      return;
    }
    if (!identity) {
      res.status(401).json({ error: "Fastrr Admin token validation failed" });
      return;
    }

    deps.localUsers.getOrProvision(identity.email, identity.name);
    const cookie = createSessionCookie(identity.email, deps.sessionCookieSecret);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=${cookie}; HttpOnly; Path=/; SameSite=Lax`);
    res.redirect("/");
  });

  app.get("/api/me", (req: Request, res: Response) => {
    const email = parseSessionCookie(req, deps.sessionCookieSecret);
    if (!email) {
      res.status(401).json({ error: "No valid session" });
      return;
    }
    const user = deps.localUsers.get(email);
    if (!user) {
      res.status(401).json({ error: "No valid session" });
      return;
    }
    res.json({ email: user.email, name: user.name, role: user.role });
  });

  // Terminal safety net: catches anything thrown/rejected by a route handler that wasn't
  // already handled locally, so a single misbehaving request can't crash the process.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal error" });
  });

  return app;
}
