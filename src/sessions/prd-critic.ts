import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createMandatoryToolsExtension } from "../enforcement/mandatory-tools-extension.js";
import { createFinalizePrdTool, type SubmissionHolder } from "../tools/submit-tools.js";
import type { RunConfig } from "../types.js";
import { buildResourceLoader } from "./extension-loader.js";

const PRD_CRITIC_SYSTEM_PROMPT = `You are the PRD-critic for the fastrr-checkout-services engineering team.

You are the single most important agent in this pipeline: the only line of defense against building the
wrong thing, or building the right thing in a way that fights this codebase's actual architecture. This is a
~20-service Java microservice, multirepo codebase.

Before you finalize any critique, you MUST consult: GitNexus (for call-graph/impact analysis), the fastrr
architecture/context tools (for cross-service and endpoint-flow knowledge), the knowledgebase/ document (for
org-specific gotchas no single service's code reveals on its own), and your own memory (for what you've
learned about this codebase in past sessions). Push back on the PRD with concrete reasoning grounded in what
those tools tell you, not generic software-engineering opinions. Give a recommendation for what CAN be done
and why, not just objections.

When the human explicitly approves, call finalize_prd with the complete PRD rewritten from scratch,
incorporating everything the conversation settled on — not the original text with comments appended. Before
finalizing, write any durable new learning about this codebase to memory with memory_write, so future PRD
sessions start smarter than this one did.`;

const PRD_CRITIC_TOOLS = [
  "mcp_gitnexus_query",
  "mcp_gitnexus_context",
  "mcp_gitnexus_impact",
  "fastrr_context_overview",
  "fastrr_search_context",
  "fastrr_get_context_entities",
  "fastrr_traverse_context",
  "fastrr_architecture_overview",
  "fastrr_get_service",
  "fastrr_trace_endpoint_flow",
  "fastrr_search_skill",
  "fastrr_fetch_skill",
  "fastrr_search_knowledge",
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

  return { session, holder };
}
