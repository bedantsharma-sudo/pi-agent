const RISKY_PATH_PATTERNS: RegExp[] = [
  /\/migrations?\//i,
  /\/scheduler-service\//i,
  /application-(prod|staging)\.properties$/i,
  /cron|quartz/i,
];

export function needsTier2Judgment(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== "write" && toolName !== "edit") {
    return false;
  }
  const path = String((input as { path?: string }).path ?? "");
  return RISKY_PATH_PATTERNS.some((pattern) => pattern.test(path));
}
