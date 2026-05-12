import { applyBudgetProfile } from "../budget/budgetPolicy.js";
import { analyzePullRequestImpact, runRequestFromPrImpact } from "../github/prAnalyzer.js";
import type { ImpactPlan, PrImpactPlan, QaJob, RunRequest } from "../types.js";
import { createRunId, nowIso } from "../utils/time.js";
import { envString } from "./env.js";
import { analyzeImpact, seedUrlsForImpact } from "./impactAnalyzer.js";
import { createJobLauncher } from "./jobLauncher.js";
import { createJobStore, newQueuedJob } from "./jobStore.js";

const DEFAULT_BASE_URL = "https://sso.unified-apps.com/login";

export interface PlannedRun {
  request: RunRequest;
  plan: ImpactPlan;
  prImpact?: PrImpactPlan;
}

export interface QueuedRun {
  jobId: string;
  request: RunRequest;
  plan: ImpactPlan;
  prImpact?: PrImpactPlan;
  executionId?: string;
}

export async function planRunRequest(request: RunRequest): Promise<PlannedRun> {
  const budgeted = applyBudgetProfile(request);
  if (budgeted.prUrl) {
    const prImpact = await analyzePullRequestImpact({
      prUrl: budgeted.prUrl,
      tenant: budgeted.tenant,
      role: budgeted.role,
      ...(budgeted.budgetUsd ? { budgetUsd: budgeted.budgetUsd } : {}),
      ...(budgeted.requestedBy ? { requestedBy: budgeted.requestedBy } : {}),
      ...(budgeted.slackChannel ? { slackChannel: budgeted.slackChannel } : {}),
      ...(budgeted.slackThreadTs ? { slackThreadTs: budgeted.slackThreadTs } : {})
    });
    const prRequest = runRequestFromPrImpact({
      source: budgeted,
      impact: prImpact,
      baseUrl: envString("UNIFIED_QA_BASE_URL", DEFAULT_BASE_URL) ?? DEFAULT_BASE_URL
    });
    const plan: ImpactPlan = {
      modules: prImpact.modules,
      routes: prImpact.routes,
      wikiCitations: [],
      confidence: prImpact.confidence,
      missingInfo: prImpact.confidence < 0.35 ? ["Could not map this PR to a module or route. Add a screen URL or module name."] : [],
      runScope: prImpact.confidence < 0.35 ? "clarify" : "targeted"
    };
    return { request: prRequest, plan, prImpact };
  }

  const plan = await analyzeImpact(budgeted);
  if (plan.runScope === "clarify") return { request: budgeted, plan };
  const baseUrl = envString("UNIFIED_QA_BASE_URL", DEFAULT_BASE_URL) ?? DEFAULT_BASE_URL;
  const seedUrls = budgeted.seedUrls?.length ? budgeted.seedUrls : seedUrlsForImpact(plan, baseUrl);
  return {
    request: {
      ...budgeted,
      ...(seedUrls.length ? { seedUrls } : {}),
      ...(plan.modules.length ? { targetModules: plan.modules } : {})
    },
    plan
  };
}

export async function queueQaRun(request: RunRequest): Promise<QueuedRun> {
  const planned = await planRunRequest(request);
  if (planned.plan.runScope === "clarify") {
    throw new ClarificationNeededError(planned.plan.missingInfo.join(" ") || "Provide a more specific QA target.");
  }

  const jobId = createRunId();
  const store = createJobStore();
  await store.init();
  await store.createJob(newQueuedJob(jobId, planned.request));

  const launcher = createJobLauncher();
  try {
    const execution = await launcher.launch({ jobId, request: planned.request });
    await store.updateJob(jobId, {
      status: "queued",
      ...(execution.executionId ? { cloudRunExecutionId: execution.executionId } : {})
    });
    return {
      jobId,
      request: planned.request,
      plan: planned.plan,
      ...(planned.prImpact ? { prImpact: planned.prImpact } : {}),
      ...(execution.executionId ? { executionId: execution.executionId } : {})
    };
  } catch (error) {
    await store.updateJob(jobId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      completedAt: nowIso()
    });
    throw error;
  }
}

export async function getQaJob(jobId: string | undefined): Promise<QaJob | undefined> {
  if (!jobId) return undefined;
  const store = createJobStore();
  await store.init();
  return store.getJob(jobId);
}

export function qaStatusText(job: QaJob | undefined): string {
  if (!job) return "I could not find that QA job.";
  return `QA job ${job.jobId} is ${job.status}${job.error ? `: ${job.error}` : "."}`;
}

export function qaReportText(job: QaJob | undefined): string {
  if (!job) return "I could not find that QA job.";
  if (!job.reportUrls?.length) return `QA job ${job.jobId} has no report artifacts yet. Current status: ${job.status}.`;
  return `QA job ${job.jobId} report artifacts:\n${job.reportUrls.join("\n")}`;
}

export class ClarificationNeededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClarificationNeededError";
  }
}
