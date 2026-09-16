import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createGuardrailExtension, type AllowedServicesHolder } from "../supervisor/guardrail-extension.js";
import { createRunTestsTool } from "../tools/run-tests.js";
import { createSubmitVerdictTool, type SubmissionHolder } from "../tools/submit-tools.js";
import type { ManualActionEntry, ReviewVerdict, RunConfig } from "../types.js";
import { buildResourceLoader } from "./extension-loader.js";

const REVIEWER_SYSTEM_PROMPT = `You are the Reviewer for the fastrr-checkout-services engineering team.

You are deliberately adversarial toward the Coder's work — your job is to find every issue, not to be
agreeable. Never trust the Coder's claim that tests pass: always re-run run_tests yourself for every service
touched, independently. Review the actual diff for correctness, and check whether it respects this
codebase's conventions (use GitNexus to verify blast radius was actually considered).

Call submit_verdict with status "approve" only when you have independently confirmed passing tests and have
no unresolved findings. Otherwise call it with status "revise" and specific, actionable findings — vague
feedback like "needs improvement" is not acceptable; name the exact issue and where it is.`;

const REVIEWER_TOOLS = ["read", "grep", "bash", "mcp__gitnexus", "run_tests", "submit_verdict"];

export interface ReviewerSessionResult {
  session: AgentSession;
  holder: SubmissionHolder<ReviewVerdict>;
}

export async function createReviewerSession(
  config: RunConfig,
  modelRuntime: ModelRuntime,
  manualActions: ManualActionEntry[],
  allowedServicesHolder: AllowedServicesHolder,
): Promise<ReviewerSessionResult> {
  const holder: SubmissionHolder<ReviewVerdict> = { value: undefined };

  const loader = buildResourceLoader({
    cwd: config.piProjectRoot,
    includeMemory: false,
    includeDashboard: true,
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    extraFactories: [createGuardrailExtension(manualActions, allowedServicesHolder)],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    // Loader discovery cwd (extensions/mcp.json) is piProjectRoot, set above via buildResourceLoader.
    // This separate cwd is where built-in read/grep/bash actually operate — the Reviewer needs to
    // inspect and test the workspace's checked-out services, not the orchestrator's own project
    // directory. See the PRD-critic factory for the fuller rationale on why these two cwds are
    // deliberately different.
    cwd: config.workspaceRoot,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(config.piProjectRoot),
    customTools: [createSubmitVerdictTool(holder), createRunTestsTool(config.workspaceRoot)],
    tools: REVIEWER_TOOLS,
  });

  return { session, holder };
}
