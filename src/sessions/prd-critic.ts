import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createMandatoryToolsExtension } from "../enforcement/mandatory-tools-extension.js";
import { createFinalizePrdTool, type SubmissionHolder } from "../tools/submit-tools.js";
import type { RunConfig } from "../types.js";
import { activateSession, buildResourceLoader } from "./extension-loader.js";

const PRD_CRITIC_SYSTEM_PROMPT = `You are the PRD-critic for the fastrr-checkout-services engineering team.

You are the single most important agent in this pipeline: the only line of defense against building the
wrong thing, or building the right thing in a way that fights this codebase's actual architecture. This is a
~20-service Java microservice, multirepo codebase.

Before you finalize any critique, you MUST consult: GitNexus (for call-graph/impact analysis), the
\`knowledgebase/\` folder at the root of this workspace (for org-specific gotchas no single service's code reveals on its own — read
\`knowledgebase/00-cross-cutting-gotchas.md\` first, always; then read whichever subsystem file(s) match the
service(s) the PRD is likely to touch, per the table in \`knowledgebase/README.md\`), and your own memory
(for what you've learned about this codebase in past sessions). Push back on the PRD with concrete reasoning
grounded in what those tools tell you, not generic software-engineering opinions. Give a recommendation for
what CAN be done and why, not just objections.

When the human explicitly approves, call finalize_prd with the complete PRD rewritten from scratch,
incorporating everything the conversation settled on — not the original text with comments appended. Before
finalizing, write any durable new learning about this codebase to memory with memory_write, so future PRD
sessions start smarter than this one did.`;

// "mcp__gitnexus" / "mcp__fastrr" group-style names do not resolve to anything — this SDK
// has no group/wildcard tool-name syntax, and pi-mcp-extension registers each MCP tool
// individually as "mcp_<server>_<tool>" (confirmed empirically: passing "mcp__gitnexus" in
// `tools:` silently drops every GitNexus tool with no error, leaving the critic with none of
// them). Real tool names must be listed individually.
//
// fastrr_* tools (fastrr_context_overview, fastrr_search_context, etc.) are NOT included below
// because no fastrr MCP server is configured in .pi/mcp.json yet — only "gitnexus" is. Per
// HANDOVER.md, reaching the fastrr_* tools requires the agent_one-style SSO/JWT flow that
// hasn't been built. Until that server is registered, listing fastrr_* names here would be
// dead weight (same silent no-op as the group-name bug above), not a working capability.
const PRD_CRITIC_TOOLS = [
  "mcp_gitnexus_query",
  "mcp_gitnexus_context",
  "mcp_gitnexus_impact",
  "read",
  "grep",
  "memory_write",
  "memory_read",
  "memory_search",
  "finalize_prd",
];

const PRD_CRITIC_REQUIRED_BEFORE_FINALIZE = ["mcp_gitnexus_query", "memory_read", "memory_search"];

export interface PrdCriticSessionResult {
  session: AgentSession;
  holder: SubmissionHolder<string>;
}

export async function createPrdCriticSession(
  config: RunConfig,
  modelRuntime: ModelRuntime,
): Promise<PrdCriticSessionResult> {
  const holder: SubmissionHolder<string> = { value: undefined };
  const mandatoryTools = createMandatoryToolsExtension("finalize_prd", PRD_CRITIC_REQUIRED_BEFORE_FINALIZE);

  // pi-memory resolves PI_MEMORY_DIR once, at module-import time, into a module-level
  // cached variable (see node_modules/pi-memory/index.ts:60) — it is not read fresh on
  // every call. Setting this env var a second time within the same live process, aiming
  // at a different memory scope, will silently no-op rather than error: pi-memory will
  // keep using whatever directory was in effect the first time it was imported. This
  // function assumes it is called at most once per process, which holds for every
  // includeMemory: true session factory currently in this plan (see SPIKE_FINDINGS.md).
  process.env.PI_MEMORY_DIR = join(config.memoryDir, "prd-critic");

  const loader = buildResourceLoader({
    cwd: config.piProjectRoot,
    includeMemory: true,
    includeDashboard: true,
    systemPrompt: PRD_CRITIC_SYSTEM_PROMPT,
    extraFactories: [mandatoryTools],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    // Loader discovery cwd (extensions/mcp.json) is piProjectRoot, set above via buildResourceLoader.
    // This separate cwd is where built-in read/grep actually operate — the critic needs to read
    // knowledgebase/ and code under the workspace, not the orchestrator's own project directory.
    // (Confirmed independent per the SDK docs: "When you pass a custom ResourceLoader, cwd and
    // agentDir no longer control resource discovery. They still influence... tool path resolution.")
    cwd: config.workspaceRoot,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(config.piProjectRoot),
    customTools: [createFinalizePrdTool(holder)],
    tools: PRD_CRITIC_TOOLS,
  });
  await activateSession(session);

  return { session, holder };
}
