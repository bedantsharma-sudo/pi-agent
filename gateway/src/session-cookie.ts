// gateway/src/session-cookie.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionPayload {
  email: string;
}

interface SignedPayload {
  email: string;
  exp: number;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — not spec-mandated, chosen as a reasonable
// default for a browser session cookie; easy to make configurable later if it needs tuning.

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionCookie(email: string, secret: string): string {
  const payload: SignedPayload = { email, exp: Date.now() + SESSION_TTL_MS };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifySessionCookie(cookieValue: string, secret: string): SessionPayload | null {
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;

  const expectedSignature = sign(encodedPayload, secret);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  let payload: SignedPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.email !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp < Date.now()) return null;
  return { email: payload.email };
}
