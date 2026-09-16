// getModel lives at the "/compat" subpath, not the package root — pi-ai's main entry
// point doesn't re-export it (see @earendil-works/pi-coding-agent's own createAgentSession
// doc comment, which is stale on this point).
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

export interface Tier2Verdict {
  decision: "allow" | "block" | "flag";
  reason: string;
}

// Cache the in-flight promise itself, not the resolved value: if two callers invoke
// getRuntime() concurrently before the first ModelRuntime.create() resolves, they must
// both await the same creation rather than each seeing `undefined` and racing to create
// their own runtime (whichever resolved last would silently "win" as the cache).
let cachedRuntimePromise: Promise<ModelRuntime> | undefined;

async function getRuntime(): Promise<ModelRuntime> {
  cachedRuntimePromise ??= ModelRuntime.create();
  return cachedRuntimePromise;
}

export async function classifyGrayArea(toolName: string, input: Record<string, unknown>): Promise<Tier2Verdict> {
  const runtime = await getRuntime();
  const model = getModel("anthropic", "claude-haiku-4-5");
  if (!model) {
    return { decision: "flag", reason: "Tier-2 classifier model unavailable; flagging for manual review by default." };
  }

  const { session } = await createAgentSession({
    model,
    modelRuntime: runtime,
    tools: [],
    sessionManager: SessionManager.inMemory(),
  });

  let responseText = "";
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      responseText += event.assistantMessageEvent.delta;
    }
  });

  await session.prompt(
    `A coding agent is about to call tool "${toolName}" with input ${JSON.stringify(input)}. This touches a ` +
      "category this org treats carefully (schema/migration files, cron/scheduler code, Kafka topic config, " +
      'secrets, or cross-service DB access). Reply with exactly one word on the first line: "allow" if this ' +
      'looks like a normal, safe code change, "block" if this should not be done by an automated agent and ' +
      'needs a human/devops action instead, or "flag" if it is probably fine but worth a human ' +
      "double-checking before going live. Then on a new line, give a one-sentence reason.",
  );

  const [firstLine, ...rest] = responseText.trim().split("\n");
  // Strip everything but letters so trailing punctuation ("block.") or markdown
  // ("**block**") don't prevent a clean match, while still requiring the whole first
  // line to reduce to the decision word (so it embedded mid-sentence, e.g. "I think
  // block is right", does NOT count as a match).
  const cleaned = firstLine.trim().toLowerCase().replace(/[^a-z]/g, "");
  const reason = rest.join(" ").trim() || "No reason given by classifier.";

  // Fail-safe, not fail-open: this classifier exists to catch risky changes, so only an
  // exact, clean "allow" is treated as allow. "block" is likewise exact. Anything else —
  // "flag" itself, unparseable output, an unexpected word — defaults to "flag" for human
  // review, matching the model-unavailable branch above rather than silently allowing.
  if (cleaned === "block") {
    return { decision: "block", reason };
  }
  if (cleaned === "allow") {
    return { decision: "allow", reason };
  }
  return { decision: "flag", reason };
}
