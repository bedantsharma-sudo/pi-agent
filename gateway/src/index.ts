// gateway/src/index.ts
import { loadGatewayConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createLocalUserStore } from "./local-users.js";
import { createJobRegistry } from "./job-registry.js";
import { createGatewayApp } from "./app.js";

const config = loadGatewayConfig(process.env);
const db = openDatabase(config.dbPath);
const localUsers = createLocalUserStore(db);
const jobRegistry = createJobRegistry(db);

localUsers.seedAdmins(config.seedAdminEmails);

const app = createGatewayApp({
  localUsers,
  jobRegistry,
  fastrrBaseUrl: config.fastrrBaseUrl,
  agentServerBaseUrl: config.agentServerBaseUrl,
  sessionCookieSecret: config.sessionCookieSecret,
});

app.listen(config.port, () => {
  console.log(`Gateway listening on port ${config.port}`);
});
