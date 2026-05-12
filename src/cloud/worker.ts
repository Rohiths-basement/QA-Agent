import path from "node:path";
import type { AgentConfig, RunRequest } from "../types.js";
import { runQaAgent } from "../orchestrator/qaAgent.js";
import { createRunId, nowIso } from "../utils/time.js";
import { envBoolean, envNumber, envString } from "./env.js";
import { uploadArtifacts } from "./artifacts.js";
import { analyzeImpact, seedUrlsForImpact } from "./impactAnalyzer.js";
import { createJobStore, newQueuedJob } from "./jobStore.js";
import { postSlackMessage } from "./slack.js";
import { planRunRequest } from "./runControl.js";

const DEFAULT_BASE_URL = "https://sso.unified-apps.com/login";
const DEFAULT_WIKI_URL = "https://wiki.unified-apps.com/";

export async function runCloudWorker(): Promise<void> {
  const request = await readRunRequest();
  const jobId = envString("QA_JOB_ID", createRunId()) ?? createRunId();
  const store = createJobStore();
  await store.init();
  await store.createJob(newQueuedJob(jobId, request));
  await store.updateJob(jobId, { status: "running", startedAt: nowIso() });

  try {
    const config = await configForRequest(jobId, request);
    if (config.runRequest?.budgetUsd) process.env.OPENROUTER_MAX_RUN_COST_USD = String(config.runRequest.budgetUsd);
    const result = await runQaAgent(config);
    const uploadedUrls = await uploadArtifacts({ runId: result.runId, artifactDir: config.artifactDir });
    const reportUrls = uploadedUrls.length ? uploadedUrls : [result.reportJsonPath, result.reportHtmlPath];
    await store.updateJob(jobId, {
      status: result.status,
      completedAt: nowIso(),
      reportUrls
    });
    await postSlackMessage({
      ...(request.slackChannel ? { channel: request.slackChannel } : {}),
      ...(request.slackThreadTs ? { threadTs: request.slackThreadTs } : {}),
      text: `QA job ${jobId} ${result.status}. Reports:\n${reportUrls.join("\n")}`
    }).catch(console.error);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.updateJob(jobId, { status: "failed", completedAt: nowIso(), error: message });
    await postSlackMessage({
      ...(request.slackChannel ? { channel: request.slackChannel } : {}),
      ...(request.slackThreadTs ? { threadTs: request.slackThreadTs } : {}),
      text: `QA job ${jobId} failed: ${message}`
    }).catch(console.error);
    throw error;
  }
}

async function configForRequest(jobId: string, request: RunRequest): Promise<AgentConfig> {
  const planned = await planRunRequest(request);
  if (planned.plan.runScope === "clarify") throw new Error(planned.plan.missingInfo.join(" ") || "Run request needs more detail.");
  const effectiveRequest = planned.request;
  const baseUrl = envString("UNIFIED_QA_BASE_URL", DEFAULT_BASE_URL) ?? DEFAULT_BASE_URL;
  const impactPlan = await analyzeImpact(effectiveRequest);
  const seedUrls = effectiveRequest.seedUrls?.length ? effectiveRequest.seedUrls : seedUrlsForImpact(impactPlan, baseUrl);
  const isTargetedScreen = effectiveRequest.type === "screen";
  const defaultMaxSteps = effectiveRequest.type === "full" || effectiveRequest.type === "baseline"
    ? envNumber("QA_FULL_RUN_MAX_STEPS", 1000)
    : envNumber("QA_TARGETED_RUN_MAX_STEPS", 80);
  const artifactDir = path.resolve(envString("QA_ARTIFACT_DIR", "/tmp/qa-artifacts/runs") ?? "/tmp/qa-artifacts/runs");
  const storagePath = path.resolve(envString("QA_STORAGE_PATH", `/tmp/qa-agent/${jobId}.sqlite`) ?? `/tmp/qa-agent/${jobId}.sqlite`);
  const vectorStoreId = envString("OPENAI_VECTOR_STORE_ID");
  const wikiJsonlPath = envString("QA_WIKI_JSONL", "data/wiki/articles.jsonl");
  const credentialsFile = envString("QA_CREDENTIALS_FILE");

  return {
    baseUrl,
    wikiUrl: envString("UNIFIED_QA_WIKI_URL", DEFAULT_WIKI_URL) ?? DEFAULT_WIKI_URL,
    runId: jobId,
    tenant: effectiveRequest.tenant,
    role: effectiveRequest.role,
    maxSteps: effectiveRequest.maxSteps ?? defaultMaxSteps,
    headless: !envBoolean("QA_HEADED", false),
    useStagehand: effectiveRequest.enableStagehand === true || envBoolean("QA_ENABLE_STAGEHAND", false),
    approvalMode: "block",
    ...(vectorStoreId ? { vectorStoreId } : {}),
    ...(wikiJsonlPath ? { wikiJsonlPath } : {}),
    model: effectiveRequest.budgetProfile?.selectedModel ?? envString("QA_ORACLE_MODEL", envString("OPENROUTER_ORACLE_LIGHT_MODEL", "openai/gpt-5.1-chat")) ?? "openai/gpt-5.1-chat",
    storagePath,
    artifactDir,
    ...(credentialsFile ? { credentialsFile } : {}),
    ...(seedUrls.length ? { seedUrls } : {}),
    discoverLinks: isTargetedScreen ? false : effectiveRequest.type !== "screen",
    runRequest: effectiveRequest
  };
}

async function readRunRequest(): Promise<RunRequest> {
  const raw = envString("RUN_REQUEST_JSON");
  if (raw) return JSON.parse(raw) as RunRequest;
  return {
    type: "full",
    tenant: envString("UNIFIED_QA_TENANT", "demo") ?? "demo",
    role: envString("UNIFIED_QA_ROLE", "admin") ?? "admin",
    actionPolicy: "sandbox_mutation"
  };
}
