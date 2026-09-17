// gateway/src/jwt.ts
import type { LocalUser } from "./local-users.js";

export interface ScopedJwt {
  token: string;
}

// A POST-shaped fetch, distinct from fastrr-auth.ts's FetchLike (which only types a GET-style
// call with a headers init) — this task needs method/headers/body, so it gets its own local
// injectable type rather than widening the other module's, which would loosen that module's
// test-injection type for no benefit to it.
export type PostFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

// Deliberately does NOT sign locally with a shared secret this project would have to hold.
// This calls the same real /internal/sign-jwt endpoint agent_one's own frontend calls
// (frontend/lib/server-auth.ts:15-35 -> agents/apis/auth.py:31-35), which signs HS256 with
// MCP_JWT_SECRET server-side. Delegating signing this way means a token this gateway hands
// out is guaranteed to validate against the real fastrr_* tool servers, without this project
// ever needing that secret provisioned to it.
export async function mintScopedJwt(
  user: LocalUser,
  agentServerBaseUrl: string,
  fetchImpl: PostFetchLike = fetch,
): Promise<ScopedJwt> {
  const response = await fetchImpl(`${agentServerBaseUrl}/internal/sign-jwt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, name: user.name, role: user.role }),
  });
  const body = response.ok ? ((await response.json()) as { token?: string }) : undefined;
  if (!body?.token) {
    throw new Error(`Failed to mint JWT for ${user.email}`);
  }
  return { token: body.token };
}
