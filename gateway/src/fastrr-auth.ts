// gateway/src/fastrr-auth.ts
export interface FastrrIdentity {
  id: string;
  email: string;
  name: string;
}

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

// This is the exact endpoint agent_one's own CredentialsProvider.authorize() calls
// (frontend/app/api/auth/[...nextauth]/route.ts:71-109) — deliberately not replicating that
// file's api-dev.pickrr.com dev-bypass, which skips validation entirely; this always validates
// for real.
export async function validateFastrrToken(
  email: string,
  token: string,
  fastrrBaseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<FastrrIdentity | null> {
  const url = `${fastrrBaseUrl}/api/ve1/aggregator-service/user/login-detail/?email=${encodeURIComponent(email)}`;
  const response = await fetchImpl(url, { headers: { "X-Auth-Token": token } });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as { data?: FastrrIdentity };
  return body.data ?? null;
}
