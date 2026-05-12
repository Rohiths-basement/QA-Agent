import http from "node:http";
import { URL } from "node:url";
import { nowIso } from "../utils/time.js";
import { envString, envNumber } from "./env.js";
import { handleHermesMcpRequest } from "../hermes/mcp.js";
import { ClarificationNeededError, getQaJob, qaReportText, qaStatusText, queueQaRun } from "./runControl.js";
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
  if (url.pathname === "/mcp") {
    await handleHermesMcpRequest(req, res);
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
  if (intent.kind === "status") return qaStatusText(await getQaJob(intent.jobId));
  if (intent.kind === "report") return qaReportText(await getQaJob(intent.jobId));
  if (intent.kind === "approve") return `Approval ${intent.approvalRef} recorded. Approval enforcement is wired for policy gates; destructive execution remains blocked until worker-side approval consumption is enabled.`;

  try {
    const queued = await queueQaRun(intent.request);
    const scope = queued.prImpact
      ? `PR impact (${queued.prImpact.modules.join(", ") || "targeted routes"})`
      : queued.plan.runScope === "full"
        ? "full app"
        : queued.plan.modules.length
          ? queued.plan.modules.join(", ")
          : "targeted flow";
    const budget = queued.request.budgetProfile
      ? ` Budget tier: ${queued.request.budgetProfile.tier} ($${queued.request.budgetProfile.budgetUsd}).`
      : "";
    return `Queued QA job ${queued.jobId} for ${scope}.${budget} Use /qa status ${queued.jobId} or /qa report ${queued.jobId}.`;
  } catch (error) {
    if (error instanceof ClarificationNeededError) return `I need one more detail before running QA: ${error.message}`;
    throw error;
  }
}

async function handleStatus(jobId: string | null, res: http.ServerResponse): Promise<void> {
  const job = await getQaJob(jobId ?? undefined);
  if (!job) {
    sendJson(res, 404, { error: "Job not found" });
    return;
  }
  sendJson(res, 200, job);
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
