import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";

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
    // Without this, DefaultResourceLoader auto-discovers and merges in whatever's
    // registered in this machine's ~/.pi/agent/settings.json (e.g. a stale, globally
    // installed pi-mcp-adapter from prior interactive `pi` CLI use) alongside the
    // project-local extensions above — exactly the risk flagged in SPIKE_FINDINGS.md's
    // "(b) pi-memory round-trip" section. Confirmed to matter here, not just a
    // theoretical risk: on this dev machine, without noExtensions, the globally
    // registered pi-mcp-adapter's session_start handler throws ("MCP initialization
    // failed: Theme not initialized. Call initTheme() first." — it assumes an
    // interactive TUI theme that a headless SDK session never initializes), and that
    // breaks eager MCP server startup for GitNexus entirely.
    noExtensions: true,
    ...(options.systemPrompt ? { systemPromptOverride: () => options.systemPrompt! } : {}),
  });
}

/**
 * `createAgentSession()` (the plain SDK path every session factory in this project uses)
 * never fires the "session_start" extension event — that only happens via the interactive
 * CLI/TUI/RPC entry points, which call `session.bindExtensions()` themselves.
 * pi-mcp-extension's eager MCP-server connection (and therefore every `mcp_<server>_*`
 * tool's registration) and pi-agent-dashboard's session-registration handshake are both
 * wired to "session_start", not to extension load time — without this call, those tools
 * silently don't exist yet, and the model has no way to know why.
 *
 * Confirmed empirically (not just from reading the SDK source): before this call,
 * `session.getActiveToolNames()` contains no `mcp_gitnexus_*` tools at all; immediately
 * after `bindExtensions({})` resolves (no extra delay needed — it awaits the eager
 * connection internally), they're all present. Every session factory must call this
 * before its first `session.prompt()`.
 */
export async function activateSession(session: AgentSession): Promise<void> {
  await session.bindExtensions({});
}

/**
 * Every session factory in this project deliberately uses two different `cwd`s: the
 * ResourceLoader's discovery `cwd` is `piProjectRoot` (this repo), but the `AgentSession`
 * itself is created with `cwd: workspaceRoot` (the checked-out services), so built-in
 * read/edit/write/bash operate on the right filesystem location.
 *
 * pi-mcp-extension does NOT respect that split: its "session_start" handler re-resolves
 * `.pi/mcp.json` using the extension's `ExtensionContext.cwd`, which is the *session's*
 * cwd (workspaceRoot), not the loader's discovery cwd — confirmed empirically (not just
 * from reading the source): with `.pi/mcp.json` only present at piProjectRoot,
 * `session.getActiveToolNames()` never contains any `mcp_gitnexus_*` tool, even after
 * `activateSession()`. Copying the same config to workspaceRoot before creating any
 * session fixes it. This must run once per run, before the first session factory call.
 */
export async function ensureWorkspaceMcpConfig(piProjectRoot: string, workspaceRoot: string): Promise<void> {
  const sourcePath = join(piProjectRoot, ".pi", "mcp.json");
  const contents = await readFile(sourcePath, "utf-8");
  const destDir = join(workspaceRoot, ".pi");
  await mkdir(destDir, { recursive: true });
  await writeFile(join(destDir, "mcp.json"), contents);
}
