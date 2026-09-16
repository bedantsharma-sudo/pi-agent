import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface AuditLogEntry {
  timestamp: string;
  humanIdentifier: string;
  runId: string;
  prdHash: string;
}

export function hashPrdText(prdText: string): string {
  return createHash("sha256").update(prdText).digest("hex");
}

export async function appendAuditLogEntry(auditLogPath: string, entry: AuditLogEntry): Promise<void> {
  await mkdir(dirname(auditLogPath), { recursive: true });
  await appendFile(auditLogPath, `${JSON.stringify(entry)}\n`, "utf-8");
}
