import { createRequire } from "node:module";
import { dirname } from "node:path";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);

/**
 * Resolves the directory of an installed Pi extension package, given its npm package
 * name. Confirmed working as-is by Task 3's spike (see SPIKE_FINDINGS.md): each of
 * pi-mcp-extension, pi-memory, and @blackbelt-technology/pi-agent-dashboard declares a
 * `"pi": { "extensions": [...] }` field in its package.json, and
 * DefaultResourceLoader's package-manager code resolves that manifest automatically
 * when handed the package root directory — no fallback to a specific entry file is
 * needed.
 */
export function resolveExtensionDir(packageName: string): string {
  return dirname(require.resolve(`${packageName}/package.json`));
}

export interface BuildLoaderOptions {
  cwd: string;
  includeMemory: boolean;
  includeDashboard: boolean;
  systemPrompt?: string;
  extraFactories?: Array<ExtensionFactory | InlineExtension>;
}

export function buildResourceLoader(options: BuildLoaderOptions): DefaultResourceLoader {
  const additionalExtensionPaths = [resolveExtensionDir("pi-mcp-extension")];
  if (options.includeMemory) {
    additionalExtensionPaths.push(resolveExtensionDir("pi-memory"));
  }
  if (options.includeDashboard) {
    additionalExtensionPaths.push(resolveExtensionDir("@blackbelt-technology/pi-agent-dashboard"));
  }
  return new DefaultResourceLoader({
    cwd: options.cwd,
    // Required, not optional, despite the plan's original sketch omitting it — see
    // SPIKE_FINDINGS.md "What had to change from the plan's sketch" (#1).
    agentDir: getAgentDir(),
    additionalExtensionPaths,
    extensionFactories: options.extraFactories ?? [],
    ...(options.systemPrompt ? { systemPromptOverride: () => options.systemPrompt! } : {}),
  });
}
