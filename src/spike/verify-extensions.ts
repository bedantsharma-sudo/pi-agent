/**
 * Task 3 spike: confirm pi-mcp-extension, pi-memory, and pi-agent-dashboard's bridge
 * extension actually attach to a session created headlessly via the SDK
 * (`createAgentSession` + `DefaultResourceLoader`), not just one the interactive
 * `pi` CLI spawns.
 *
 * See SPIKE_FINDINGS.md at the repo root for what this discovered and what had to
 * change from the plan's original assumption.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);

/**
 * Resolves the directory of an installed Pi extension package, given its npm
 * package name. This is the exact shape confirmed working by this spike: all
 * three packages (pi-mcp-extension, pi-memory, @blackbelt-technology/pi-agent-dashboard)
 * declare a `"pi": { "extensions": [...] }` field in their package.json that points
 * at the real entry file relative to the package root, and DefaultResourceLoader's
 * package-manager code (`readPiManifest` / `resolveLocalExtensionSource`) resolves
 * that manifest automatically when given the package root directory. Pointing at a
 * specific file (e.g. `<dir>/dist/index.js`) was NOT needed and is NOT the right
 * fallback for these three packages if this ever breaks again — check the target
 * package's package.json `pi.extensions` field first.
 */
function resolveExtensionDir(packageName: string): string {
  const pkgJsonPath = require.resolve(`${packageName}/package.json`);
  return dirname(pkgJsonPath);
}

async function main() {
  const gitnexusCommand = process.env.GITNEXUS_MCP_COMMAND;
  if (!gitnexusCommand) {
    throw new Error(
      "Set GITNEXUS_MCP_COMMAND to the shell command that launches GitNexus's MCP stdio server " +
        "(see Task 3 Step 2 in the implementation plan for where to find it).",
    );
  }

  const spikeDir = join(process.cwd(), ".spike-workspace");
  await mkdir(spikeDir, { recursive: true });

  // pi-mcp-extension reads its server list from <cwd>/.pi/mcp.json, where cwd is the
  // session's cwd (ctx.cwd), not process.cwd() at import time. createAgentSession is
  // called below with cwd: spikeDir, so this is the directory that matters.
  const mcpConfigDir = join(spikeDir, ".pi");
  await mkdir(mcpConfigDir, { recursive: true });
  const [command, ...args] = gitnexusCommand.split(" ");
  await writeFile(
    join(mcpConfigDir, "mcp.json"),
    JSON.stringify(
      { mcpServers: { gitnexus: { command, args, transport: "stdio", lifecycle: "eager" } } },
      null,
      2,
    ),
  );

  const memoryDir = join(spikeDir, "memory");
  await mkdir(memoryDir, { recursive: true });
  process.env.PI_MEMORY_DIR = memoryDir;

  const additionalExtensionPaths = [
    resolveExtensionDir("pi-mcp-extension"),
    resolveExtensionDir("pi-memory"),
    resolveExtensionDir("@blackbelt-technology/pi-agent-dashboard"),
  ];

  // DefaultResourceLoaderOptions.agentDir is required (not optional) despite the
  // plan's original snippet omitting it — omitting it is a TS compile error.
  const loader = new DefaultResourceLoader({
    cwd: spikeDir,
    agentDir: getAgentDir(),
    additionalExtensionPaths,
  });
  await loader.reload();

  // getExtensions() returns a LoadExtensionsResult ({ extensions, errors, runtime }),
  // not an array — the plan's original snippet treated it as one directly, which
  // would fail at the `.map`/`.length` calls below.
  const { extensions, errors } = loader.getExtensions();
  console.log(
    "Loaded extensions:",
    extensions.map((e) => e.resolvedPath),
  );
  if (errors.length > 0) {
    console.log("Extension load errors:", errors);
  }
  if (extensions.length < 3) {
    throw new Error(
      `Expected 3 extensions to load, got ${extensions.length}. additionalExtensionPaths may need to point ` +
        "at a specific entry file rather than the package root — inspect each resolved directory's " +
        "package.json 'main'/'exports' field, adjust resolveExtensionDir here, and record what actually " +
        "worked in SPIKE_FINDINGS.md.",
    );
  }

  let modelRuntime: ModelRuntime;
  try {
    modelRuntime = await ModelRuntime.create();
  } catch (error) {
    console.error(
      "\nModelRuntime.create() failed — this means no model credential is configured " +
        "(~/.pi/agent/auth.json or ANTHROPIC_API_KEY). This is a DIFFERENT failure mode from " +
        "extension loading, which already succeeded above (3/3 extensions loaded). Re-run with " +
        "credentials available to verify (a) and (b).",
    );
    throw error;
  }

  const { session } = await createAgentSession({
    cwd: spikeDir,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(spikeDir),
  });

  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  console.log("\n--- (a) Verifying a GitNexus MCP tool is callable ---");
  await session.prompt(
    "Call whichever tool lets you query the GitNexus knowledge graph, asking a trivial question like " +
      "'what is this repo about'. Report the raw tool result back to me verbatim.",
  );

  console.log("\n--- (b) Verifying pi-memory round-trips ---");
  await session.prompt(
    "Use the memory_write tool to write a note with the exact text 'spike-verification-marker' under any " +
      "key, then use memory_read to read it back and report exactly what you get.",
  );

  const memoryFile = join(memoryDir, "MEMORY.md");
  const memoryContents = await readFile(memoryFile, "utf-8").catch(() => "");
  if (!memoryContents.includes("spike-verification-marker")) {
    throw new Error(
      `Expected ${memoryFile} to contain the marker — pi-memory may not persist to PI_MEMORY_DIR, or uses ` +
        `a different file layout than assumed. Inspect ${memoryDir} directly and record findings.`,
    );
  }

  console.log(
    "\n(a) and (b) passed. For (c): start @blackbelt-technology/pi-agent-dashboard pointed at " +
      `${spikeDir}, open it in a browser, and manually confirm this session appears live and named.`,
  );
}

main().catch((error) => {
  console.error("Spike failed:", error);
  process.exitCode = 1;
});
