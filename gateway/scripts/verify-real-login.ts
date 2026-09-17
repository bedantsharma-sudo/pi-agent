// gateway/scripts/verify-real-login.ts
// Manual verification only — never run automatically. Exercises validateFastrrToken()
// against the real aggregator-service, using a real dev-testing identity.
//
// The current email+token pair lives in agent_one's own README.md (search for
// "auth/callback?email=" in /Users/bedantsharma/PycharmProjects/agent_one/README.md) —
// deliberately not copied into this file, since that pair can rotate and this file is
// committed to git; read it fresh from that README each time this script is run.
//
// Usage:
//   FASTRR_TEST_EMAIL=<email from agent_one's README> \
//   FASTRR_TEST_TOKEN=<token from agent_one's README> \
//   FASTRR_BASE_URL=<real Fastrr Admin base URL> \
//   npx tsx scripts/verify-real-login.ts

import { validateFastrrToken } from "../src/fastrr-auth.js";

const email = process.env.FASTRR_TEST_EMAIL;
const token = process.env.FASTRR_TEST_TOKEN;
const fastrrBaseUrl = process.env.FASTRR_BASE_URL;

if (!email || !token || !fastrrBaseUrl) {
  console.error("Set FASTRR_TEST_EMAIL, FASTRR_TEST_TOKEN, and FASTRR_BASE_URL — see this file's header comment.");
  process.exit(1);
}

const identity = await validateFastrrToken(email, token, fastrrBaseUrl);
if (identity) {
  console.log("✅ Real validation succeeded:", identity);
} else {
  console.log("❌ Real validation failed (token rejected or malformed response) — check the credential is still valid.");
}
