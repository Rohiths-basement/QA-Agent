#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { readAgentConfig, stringOption } from "./config.js";

const command = process.argv[2] ?? "help";
const args = process.argv.slice(3);

try {
  switch (command) {
    case "ingest-wiki":
      await ingestWiki(args);
      break;
    case "upload-kb":
      await uploadKb(args);
      break;
    case "run":
      await runAgent(args);
      break;
    case "api":
      await serveApi();
      break;
    case "worker":
      await runWorker();
      break;
    case "live":
      await serveLive();
      break;
    case "index-code":
      await indexCode(args);
      break;
    case "analyze-pr":
      await analyzePr(args);
      break;
    case "report":
      await report(args);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function ingestWiki(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string", short: "u" },
      out: { type: "string", short: "o", default: "data/wiki" },
      limit: { type: "string" },
      "max-depth": { type: "string" }
    }
  });
  const { crawlWiki } = await import("./wiki/crawler.js");
  const rootUrl = stringOption(values.url) ?? "https://wiki.unified-apps.com/";
  const manifest = await crawlWiki({
    rootUrl,
    outDir: stringOption(values.out) ?? "data/wiki",
    ...(values.limit ? { limit: Number(values.limit) } : {}),
    ...(values["max-depth"] ? { maxDepth: Number(values["max-depth"]) } : {})
  });
  console.log(`Crawled ${manifest.articleCount} articles`);
  console.log(`Manifest: ${path.join(path.resolve(stringOption(values.out) ?? "data/wiki"), "manifest.json")}`);
}

async function uploadKb(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      manifest: { type: "string", short: "m", default: "data/wiki/manifest.json" },
      "vector-store-id": { type: "string" },
      "vector-store-name": { type: "string" },
      "batch-size": { type: "string" },
      consolidated: { type: "boolean" }
    }
  });
  const { uploadWikiToOpenAiVectorStore } = await import("./knowledge/openaiVectorStore.js");
  const vectorStoreId = stringOption(values["vector-store-id"]);
  const vectorStoreName = stringOption(values["vector-store-name"]);
  const result = await uploadWikiToOpenAiVectorStore({
    manifestPath: stringOption(values.manifest) ?? "data/wiki/manifest.json",
    ...(vectorStoreId ? { vectorStoreId } : {}),
    ...(vectorStoreName ? { vectorStoreName } : {}),
    ...(values["batch-size"] ? { batchSize: Number(values["batch-size"]) } : {}),
    ...(values.consolidated ? { consolidated: true } : {})
  });
  console.log(`Vector store: ${result.vectorStoreId}`);
  console.log(`Uploaded files: ${result.uploadedFiles}`);
  console.log(`Mapping: ${result.mappingPath}`);
}

async function runAgent(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "base-url": { type: "string" },
      "wiki-url": { type: "string" },
      "wiki-jsonl": { type: "string" },
      "run-id": { type: "string" },
      resume: { type: "string" },
      tenant: { type: "string" },
      role: { type: "string" },
      "max-steps": { type: "string" },
      headed: { type: "boolean" },
      stagehand: { type: "boolean" },
      "allow-destructive": { type: "boolean" },
      "vector-store-id": { type: "string" },
      model: { type: "string" },
      "storage-path": { type: "string" },
      "artifact-dir": { type: "string" },
      "credentials-file": { type: "string" },
      "seed-url": { type: "string" },
      "no-discovery": { type: "boolean" }
    }
  });
  const config = readAgentConfig(values);
  const { runQaAgent } = await import("./orchestrator/qaAgent.js");
  const result = await runQaAgent(config);
  console.log(`Run ${result.status}: ${result.runId}`);
  console.log(`JSON report: ${result.reportJsonPath}`);
  console.log(`HTML report: ${result.reportHtmlPath}`);
}

async function serveApi(): Promise<void> {
  const { startCloudApi } = await import("./cloud/api.js");
  await startCloudApi();
}

async function runWorker(): Promise<void> {
  const { runCloudWorker } = await import("./cloud/worker.js");
  await runCloudWorker();
}

async function serveLive(): Promise<void> {
  const { startLiveApi } = await import("./live/liveApi.js");
  await startLiveApi();
}

async function indexCode(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      org: { type: "string", default: "Unified-Solutions-EMS" },
      "limit-repos": { type: "string" },
      "no-embed": { type: "boolean" }
    }
  });
  const { indexUnifiedCodebase } = await import("./codegraph/indexer.js");
  const result = await indexUnifiedCodebase({
    org: stringOption(values.org) ?? "Unified-Solutions-EMS",
    ...(values["limit-repos"] ? { limitRepos: Number(values["limit-repos"]) } : {}),
    ...(values["no-embed"] ? { embed: false } : {})
  });
  console.log(JSON.stringify(result, null, 2));
}

async function analyzePr(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string", short: "u" },
      tenant: { type: "string" },
      role: { type: "string" },
      budget: { type: "string" }
    }
  });
  const prUrl = stringOption(values.url) ?? positionals[0];
  if (!prUrl) throw new Error("Missing PR URL. Use analyze-pr <github-pr-url>.");
  const { analyzePullRequestImpact } = await import("./github/prAnalyzer.js");
  const result = await analyzePullRequestImpact({
    prUrl,
    tenant: stringOption(values.tenant) ?? process.env.UNIFIED_QA_TENANT ?? "demo",
    role: stringOption(values.role) ?? process.env.UNIFIED_QA_ROLE ?? "admin",
    ...(values.budget ? { budgetUsd: Number(values.budget) } : {})
  });
  console.log(JSON.stringify(result, null, 2));
}

async function report(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "run-id": { type: "string" },
      "storage-path": { type: "string", default: ".qa/qa-agent.sqlite" },
      "artifact-dir": { type: "string", default: "artifacts/runs" }
    }
  });
  const runId = stringOption(values["run-id"]);
  if (!runId) throw new Error("Missing --run-id");
  const [{ SqliteMemory }, { generateReport }] = await Promise.all([
    import("./memory/sqliteMemory.js"),
    import("./report/reporter.js")
  ]);
  const memory = new SqliteMemory(path.resolve(stringOption(values["storage-path"]) ?? ".qa/qa-agent.sqlite"));
  try {
    const result = await generateReport({
      memory,
      runId,
      artifactDir: path.resolve(stringOption(values["artifact-dir"]) ?? "artifacts/runs")
    });
    console.log(`JSON report: ${result.jsonPath}`);
    console.log(`HTML report: ${result.htmlPath}`);
  } finally {
    memory.close();
  }
}

function printHelp(): void {
  console.log(`Unified QA Agent

Commands:
  ingest-wiki --url https://wiki.unified-apps.com/ [--out data/wiki]
  upload-kb --manifest data/wiki/manifest.json [--vector-store-id vs_...] [--consolidated]
  run --base-url https://sso.unified-apps.com/login [--stagehand] [--resume <runId>]
  api
  worker
  live
  index-code --org Unified-Solutions-EMS [--limit-repos 18] [--no-embed]
  analyze-pr <github-pr-url> [--budget 10]
  report --run-id <runId>

Common run options:
  --tenant demo --role admin
  --max-steps 1000
  --wiki-jsonl data/wiki/articles.jsonl
  --vector-store-id <id>
  --model openai/gpt-5.1-chat
  --seed-url https://app.unified-apps.com/path[,https://...]
  --no-discovery
  --headed
  --allow-destructive
`);
}
