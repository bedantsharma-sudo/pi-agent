export interface Tier1Match {
  matched: boolean;
  reason?: string;
}

const BANNED_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bCREATE\s+INDEX\b/i,
    reason: "Creating a DB index directly is devops's responsibility in this org (knowledgebase/00-cross-cutting-gotchas.md #5).",
  },
  {
    pattern: /\bALTER\s+TABLE\b/i,
    reason: "Altering table schema directly is devops's responsibility in this org.",
  },
  {
    pattern: /\bDROP\s+(TABLE|INDEX|DATABASE)\b/i,
    reason: "Dropping database objects directly is devops's responsibility in this org.",
  },
  {
    pattern: /\b(flyway\s+migrate|liquibase\s+update)\b/i,
    reason: "Running schema migrations directly is devops's responsibility in this org.",
  },
];

function checkBash(input: Record<string, unknown>): Tier1Match {
  const command = String((input as { command?: string }).command ?? "");
  for (const { pattern, reason } of BANNED_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return { matched: true, reason };
    }
  }
  return { matched: false };
}

function checkFileScope(input: Record<string, unknown>, allowedServices: string[]): Tier1Match {
  if (allowedServices.length === 0) {
    return { matched: false };
  }
  const path = String((input as { path?: string }).path ?? "");
  const inScope = allowedServices.some((service) => path.includes(`/${service}/`));
  if (!inScope) {
    return {
      matched: true,
      reason: `Path "${path}" is out of scope — the plan only names ${allowedServices.join(", ")} as needing changes.`,
    };
  }
  return { matched: false };
}

export function checkTier1Rules(
  toolName: string,
  input: Record<string, unknown>,
  allowedServices: string[],
): Tier1Match {
  if (toolName === "bash") {
    return checkBash(input);
  }
  if (toolName === "write" || toolName === "edit") {
    return checkFileScope(input, allowedServices);
  }
  return { matched: false };
}
