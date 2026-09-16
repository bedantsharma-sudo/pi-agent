import { createInterface } from "node:readline/promises";
import { loadRunConfig } from "./config.js";
import { runPipeline } from "./orchestrator.js";

async function main() {
  const prdArgIndex = process.argv.indexOf("--prd");
  const humanArgIndex = process.argv.indexOf("--human");
  if (prdArgIndex === -1 || humanArgIndex === -1) {
    console.error("Usage: pi-pipeline --prd <path-to-prd.md> --human <email>");
    process.exitCode = 1;
    return;
  }

  const { readFile } = await import("node:fs/promises");
  const prdText = await readFile(process.argv[prdArgIndex + 1], "utf-8");
  const humanIdentity = process.argv[humanArgIndex + 1];

  const config = loadRunConfig(process.env, { prdText, humanIdentity });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const result = await runPipeline(config, {
      askHuman: (prompt) => rl.question(`${prompt}\n> `),
      isApproved: (reply) => /^(approve|approved|yes|lgtm)$/i.test(reply.trim()),
    });

    if (result.outcome === "mr_opened") {
      console.log(`MR opened: ${result.mrUrl}`);
    } else {
      console.log("Pipeline escalated — no MR opened. See the report below:");
    }
    console.log(result.reportMarkdown);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error("Pipeline run failed:", error);
  process.exitCode = 1;
});
