import http from "node:http";
import { URL } from "node:url";
import { createRunId, nowIso } from "../utils/time.js";
import type { ImpactPlan, RunRequest } from "../types.js";
import { envString, envNumber } from "./env.js";
import { analyzeImpact, seedUrlsForImpact } from "./impactAnalyzer.js";
import { createJobLauncher } from "./jobLauncher.js";
import { createJobStore, newQueuedJob } from "./jobStore.js";
import { parseConversationalQaText, parseQaText, postSlackMessage, verifySlackRequest, type SlackCommandIntent } from "./slack.js";

const DEFAULT_BASE_URL = "https://sso.unified-apps.com/login";

export async function startCloudApi(): Promise<void> {
  const port = envNumber("PORT", 8080);
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error(error);
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`qa-api listening on :${port}`);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, service: "qa-api", checkedAt: nowIso() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/status") {
    await handleStatus(url.searchParams.get("jobId"), res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/slack/commands") {
    await handleSlackCommand(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/slack/events") {
    await handleSlackEvent(req, res);
    return;
  }
  sendJson(res, 404, { error: "Not found" });
}

async function handleSlackCommand(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const rawBody = await readRawBody(req);
  if (!verifyOrRejectSlack(req, rawBody, res)) return;

  const form = new URLSearchParams(rawBody);
  const channel = form.get("channel_id") ?? undefined;
  const user = form.get("user_id") ?? undefined;
  const text = form.get("text") ?? "";
  const intent = parseQaText(text, {
    ...(user ? { requestedBy: user } : {}),
    ...(channel ? { slackChannel: channel } : {}),
    defaultTenant: envString("UNIFIED_QA_TENANT", "demo") ?? "demo",
    defaultRole: envString("UNIFIED_QA_ROLE", "admin") ?? "admin"
  });

  const response = await executeIntent(intent);
  sendJson(res, 200, {
    response_type: "ephemeral",
    text: response
  });
}

async function handleSlackEvent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const rawBody = await readRawBody(req);
  if (!verifyOrRejectSlack(req, rawBody, res)) return;
  const payload = JSON.parse(rawBody) as SlackEventPayload;

  if (payload.type === "url_verification") {
    sendJson(res, 200, { challenge: payload.challenge });
    return;
  }

  sendJson(res, 200, { ok: true });
  const event = payload.event;
  if (!event?.text || event.bot_id) return;
  const intent = parseConversationalQaText(event.text, {
    ...(event.user ? { requestedBy: event.user } : {}),
    ...(event.channel ? { slackChannel: event.channel } : {}),
    ...(event.thread_ts ?? event.ts ? { slackThreadTs: event.thread_ts ?? event.ts } : {}),
    defaultTenant: envString("UNIFIED_QA_TENANT", "demo") ?? "demo",
    defaultRole: envString("UNIFIED_QA_ROLE", "admin") ?? "admin"
  });
  const response = await executeIntent(intent).catch((error) => `Could not start QA: ${error instanceof Error ? error.message : String(error)}`);
  await postSlackMessage({
    ...(event.channel ? { channel: event.channel } : {}),
    ...(event.thread_ts ?? event.ts ? { threadTs: event.thread_ts ?? event.ts } : {}),
    text: response
  }).catch(console.error);
}

async function executeIntent(intent: SlackCommandIntent): Promise<string> {
  if (intent.kind === "clarify") return intent.message;
  if (intent.kind === "status") return statusText(await getJob(intent.jobId));
  if (intent.kind === "report") return reportText(await getJob(intent.jobId));
  if (intent.kind === "approve") return `Approval ${intent.approvalRef} recorded. Approval enforcement is wired for policy gates; destructive execution remains blocked until worker-side approval consumption is enabled.`;

  const planned = await applyImpactPlan(intent.request);
  if (planned.plan.runScope === "clarify") {
    return `I need one more detail before running QA: ${planned.plan.missingInfo.join(" ")}`;
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
  } catch (error) {
    await store.updateJob(jobId, { status: "failed", error: error instanceof Error ? error.message : String(error), completedAt: nowIso() });
    throw error;
  }

  const scope = planned.plan.runScope === "full" ? "full app" : planned.plan.modules.length ? planned.plan.modules.join(", ") : "targeted flow";
  return `Queued QA job ${jobId} for ${scope}. Use /qa status ${jobId} or /qa report ${jobId}.`;
}

async function applyImpactPlan(request: RunRequest): Promise<{ request: RunRequest; plan: ImpactPlan }> {
  const plan = await analyzeImpact(request);
  if (plan.runScope === "clarify") return { request, plan };
  const baseUrl = envString("UNIFIED_QA_BASE_URL", DEFAULT_BASE_URL) ?? DEFAULT_BASE_URL;
  const seedUrls = request.seedUrls?.length ? request.seedUrls : seedUrlsForImpact(plan, baseUrl);
  return {
    request: {
      ...request,
      ...(seedUrls.length ? { seedUrls } : {}),
      ...(plan.modules.length ? { targetModules: plan.modules } : {})
    },
    plan
  };
}

async function getJob(jobId: string | undefined) {
  if (!jobId) return undefined;
  const store = createJobStore();
  await store.init();
  return store.getJob(jobId);
}

async function handleStatus(jobId: string | null, res: http.ServerResponse): Promise<void> {
  const job = await getJob(jobId ?? undefined);
  if (!job) {
    sendJson(res, 404, { error: "Job not found" });
    return;
  }
  sendJson(res, 200, job);
}

function statusText(job: Awaited<ReturnType<typeof getJob>>): string {
  if (!job) return "I could not find that QA job.";
  return `QA job ${job.jobId} is ${job.status}${job.error ? `: ${job.error}` : "."}`;
}

function reportText(job: Awaited<ReturnType<typeof getJob>>): string {
  if (!job) return "I could not find that QA job.";
  if (!job.reportUrls?.length) return `QA job ${job.jobId} has no report artifacts yet. Current status: ${job.status}.`;
  return `QA job ${job.jobId} report artifacts:\n${job.reportUrls.join("\n")}`;
}

function verifyOrRejectSlack(req: http.IncomingMessage, rawBody: string, res: http.ServerResponse): boolean {
  const signingSecret = envString("SLACK_SIGNING_SECRET");
  if (!signingSecret) {
    sendJson(res, 503, { error: "Slack signing secret is not configured." });
    return false;
  }
  const verified = verifySlackRequest({
    signingSecret,
    timestamp: header(req, "x-slack-request-timestamp"),
    signature: header(req, "x-slack-signature"),
    rawBody
  });
  if (!verified) {
    sendJson(res, 401, { error: "Invalid Slack signature." });
    return false;
  }
  return true;
}

async function readRawBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

interface SlackEventPayload {
  type?: string;
  challenge?: string;
  event?: {
    type?: string;
    text?: string;
    user?: string;
    bot_id?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
  };
}
