import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createMandatoryToolsExtension } from "../enforcement/mandatory-tools-extension.js";
import { createGuardrailExtension, type AllowedServicesHolder } from "../supervisor/guardrail-extension.js";
import { createRunTestsTool } from "../tools/run-tests.js";
import { createSubmitForReviewTool, type SubmissionHolder } from "../tools/submit-tools.js";
import type { ManualActionEntry, RunConfig } from "../types.js";
import { buildResourceLoader } from "./extension-loader.js";

const CODER_SYSTEM_PROMPT = `You are the Coder for the fastrr-checkout-services engineering team.

Implement the plan you're given: write the tests first, then the code, for exactly the services named in
the plan. Use GitNexus's impact analysis before editing any existing symbol, per this codebase's own
convention. You cannot call submit_for_review until run_tests reports a passing run for every service you
touched — this is enforced, not optional. If run_tests fails, fix the issue and run it again.

When you receive revised plan instructions after a Reviewer rejection, address every finding before
resubmitting.`;

const CODER_TOOLS = ["bash", "edit", "write", "read", "grep", "mcp_gitnexus_query", "mcp_gitnexus_impact", "run_tests", "submit_for_review"];

export interface CoderSessionResult {
  session: AgentSession;
  holder: SubmissionHolder<{ diffSummary: string }>;
}

export async function createCoderSession(
  config: RunConfig,
  modelRuntime: ModelRuntime,
  manualActions: ManualActionEntry[],
  allowedServicesHolder: AllowedServicesHolder,
): Promise<CoderSessionResult> {
  const holder: SubmissionHolder<{ diffSummary: string }> = { value: undefined };
  const mandatoryTools = createMandatoryToolsExtension("submit_for_review", ["run_tests"]);
  const guardrail = createGuardrailExtension(manualActions, allowedServicesHolder);

  const loader = buildResourceLoader({
    cwd: config.piProjectRoot,
    includeMemory: false,
    includeDashboard: true,
    systemPrompt: CODER_SYSTEM_PROMPT,
    extraFactories: [mandatoryTools, guardrail],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    // Loader discovery cwd (extensions/mcp.json) is piProjectRoot, set above via buildResourceLoader.
    // This separate cwd is where built-in bash/edit/write/read actually operate — the Coder needs to
    // act on the workspace's checked-out services, not the orchestrator's own project directory. See
    // the PRD-critic factory for the fuller rationale on why these two cwds are deliberately different.
    cwd: config.workspaceRoot,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(config.piProjectRoot),
    customTools: [createSubmitForReviewTool(holder), createRunTestsTool(config.workspaceRoot)],
    tools: CODER_TOOLS,
  });

  return { session, holder };
}
