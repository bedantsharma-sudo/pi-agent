import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createGuardrailExtension, type AllowedServicesHolder } from "../supervisor/guardrail-extension.js";
import { createSubmitPlanTool, type SubmissionHolder } from "../tools/submit-tools.js";
import type { ManualActionEntry, PlanArtifact, RunConfig } from "../types.js";
import { buildResourceLoader } from "./extension-loader.js";

const PLANNER_SYSTEM_PROMPT = `You are the Planner for the fastrr-checkout-services engineering team.

Given an approved PRD, research which of the ~20 services need changes. Actively pattern-match against
existing conventions in this codebase — for example, payment reads route through payment-aggregator, not
directly to payment-core; report logic lives in dashboard-service. You are explicitly biased against adding
a new service-to-service or service-to-database connection where an existing endpoint could be reused or
extended instead — use GitNexus and the architecture/context tools to confirm what already exists before
proposing something new. Flag the Java version for each affected service (check its pom.xml — this codebase
has both Java 11 and Java 21 services, and fastrr-common is versioned differently per Java version).

You never write code yourself. When you receive the Reviewer's findings on a later iteration, revise the
plan to address them and call submit_plan again with the updated plan.

Call submit_plan when your plan is ready.`;

const PLANNER_TOOLS = [
  "mcp__gitnexus",
  "mcp__fastrr",
  "read",
  "grep",
  "submit_plan",
];

export interface PlannerSessionResult {
  session: AgentSession;
  holder: SubmissionHolder<PlanArtifact>;
}

export async function createPlannerSession(
  config: RunConfig,
  modelRuntime: ModelRuntime,
  manualActions: ManualActionEntry[],
  allowedServicesHolder: AllowedServicesHolder,
): Promise<PlannerSessionResult> {
  const holder: SubmissionHolder<PlanArtifact> = { value: undefined };

  const loader = buildResourceLoader({
    cwd: config.piProjectRoot,
    includeMemory: false,
    includeDashboard: true,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    extraFactories: [createGuardrailExtension(manualActions, allowedServicesHolder)],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    // Loader discovery cwd (extensions/mcp.json) is piProjectRoot, set above via buildResourceLoader.
    // This separate cwd is where built-in read/grep actually operate — the Planner needs to read
    // code across the workspace to spot conventions, not the orchestrator's own project directory.
    cwd: config.workspaceRoot,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(config.piProjectRoot),
    customTools: [createSubmitPlanTool(holder)],
    tools: PLANNER_TOOLS,
  });

  return { session, holder };
}
