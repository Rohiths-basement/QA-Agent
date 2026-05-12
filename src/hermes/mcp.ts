import type http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { budgetProfileFor } from "../budget/budgetPolicy.js";
import { CodeGraphStore } from "../codegraph/codeGraphStore.js";
import { envString } from "../cloud/env.js";
import { getQaJob, qaReportText, qaStatusText, queueQaRun } from "../cloud/runControl.js";
import { indexUnifiedCodebase } from "../codegraph/indexer.js";
import { analyzePullRequestImpact } from "../github/prAnalyzer.js";
import type { RunRequest } from "../types.js";
import { liveSessionManager, type LiveActionInput, type StartSessionInput } from "../live/liveSessionManager.js";

const DEFAULT_TENANT = "demo";
const DEFAULT_ROLE = "admin";

export async function handleHermesMcpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const token = envString("QA_MCP_TOKEN") ?? envString("QA_INTERNAL_TOKEN");
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const server = createHermesMcpServer();
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true
  });
  try {
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res);
  } finally {
    await server.close().catch(() => undefined);
  }
}

export function createHermesMcpServer(): McpServer {
  const server = new McpServer({
    name: "unified-qa-hermes-tools",
    version: "0.1.0"
  });

  server.tool(
    "budget_plan_run",
    "Estimate the QA budget tier, selected model, max steps, max depth, and Stagehand policy for a request.",
    {
      prompt: z.string().optional(),
      type: z.enum(["full", "recent_change", "screen", "flow", "baseline", "wiki_sync"]).optional(),
      budgetUsd: z.number().positive().optional()
    },
    async (args) => textResult(budgetProfileFor({
      ...(args.prompt ? { prompt: args.prompt } : {}),
      ...(args.type ? { runType: args.type } : {}),
      ...(args.budgetUsd ? { budgetUsd: args.budgetUsd } : {})
    }))
  );

  server.tool(
    "qa_run_full",
    "Queue a full end-to-end QA run.",
    {
      tenant: z.string().optional(),
      role: z.string().optional(),
      budgetUsd: z.number().positive().optional(),
      prompt: z.string().optional()
    },
    async (args) => textResult(await queueRun({
      type: "full",
      prompt: args.prompt ?? "Full app QA run from Hermes",
      tenant: tenant(args.tenant),
      role: role(args.role),
      actionPolicy: "sandbox_mutation",
      ...(args.budgetUsd ? { budgetUsd: args.budgetUsd } : {})
    }))
  );

  server.tool(
    "qa_run_targeted",
    "Queue a targeted QA run for a screen, flow, module, or natural-language change description.",
    {
      prompt: z.string(),
      seedUrls: z.array(z.string().url()).optional(),
      type: z.enum(["recent_change", "screen", "flow"]).optional(),
      tenant: z.string().optional(),
      role: z.string().optional(),
      budgetUsd: z.number().positive().optional()
    },
    async (args) => textResult(await queueRun({
      type: args.type ?? "screen",
      prompt: args.prompt,
      tenant: tenant(args.tenant),
      role: role(args.role),
      actionPolicy: "read_only",
      ...(args.seedUrls?.length ? { seedUrls: args.seedUrls } : {}),
      ...(args.budgetUsd ? { budgetUsd: args.budgetUsd } : {})
    }))
  );

  server.tool(
    "qa_analyze_pr",
    "Analyze a GitHub PR and return likely impacted modules/routes without starting a browser run.",
    {
      prUrl: z.string().url(),
      tenant: z.string().optional(),
      role: z.string().optional(),
      budgetUsd: z.number().positive().optional()
    },
    async (args) => textResult(await analyzePullRequestImpact({
      prUrl: args.prUrl,
      tenant: tenant(args.tenant),
      role: role(args.role),
      ...(args.budgetUsd ? { budgetUsd: args.budgetUsd } : {})
    }))
  );

  server.tool(
    "qa_run_pr",
    "Analyze a GitHub PR, map impact to the app, and queue a targeted QA run.",
    {
      prUrl: z.string().url(),
      tenant: z.string().optional(),
      role: z.string().optional(),
      budgetUsd: z.number().positive().optional(),
      prompt: z.string().optional()
    },
    async (args) => textResult(await queueRun({
      type: "recent_change",
      prompt: args.prompt ?? `PR QA for ${args.prUrl}`,
      tenant: tenant(args.tenant),
      role: role(args.role),
      actionPolicy: "read_only",
      prUrl: args.prUrl,
      ...(args.budgetUsd ? { budgetUsd: args.budgetUsd } : {})
    }))
  );

  server.tool(
    "qa_get_status",
    "Get the status of a queued or completed QA job.",
    { jobId: z.string() },
    async (args) => textResult(qaStatusText(await getQaJob(args.jobId)))
  );

  server.tool(
    "qa_get_report",
    "Get report artifact links for a QA job.",
    { jobId: z.string() },
    async (args) => textResult(qaReportText(await getQaJob(args.jobId)))
  );

  server.tool(
    "live_start_session",
    "Start an interactive browser session for conversational QA.",
    {
      tenant: z.string().optional(),
      role: z.string().optional(),
      seedUrl: z.string().url().optional()
    },
    async (args) => textResult(await liveStart({
      tenant: tenant(args.tenant),
      role: role(args.role),
      ...(args.seedUrl ? { seedUrl: args.seedUrl } : {})
    }))
  );

  server.tool(
    "live_observe_screen",
    "Observe the current page in an interactive browser session and summarize visible controls, inputs, tables, console errors, and network failures.",
    { sessionId: z.string() },
    async (args) => textResult(compactObservation(await liveObserve(args.sessionId)))
  );

  server.tool(
    "live_act_on_screen",
    "Execute one safe action in an interactive browser session, then observe the resulting screen.",
    {
      sessionId: z.string(),
      label: z.string().optional(),
      selectorHint: z.string().optional(),
      href: z.string().url().optional(),
      inputValue: z.string().optional(),
      instruction: z.string().optional(),
      allowMutation: z.boolean().optional()
    },
    async (args) => textResult(compactObservation(await liveAct(args.sessionId, {
      ...(args.label ? { label: args.label } : {}),
      ...(args.selectorHint ? { selectorHint: args.selectorHint } : {}),
      ...(args.href ? { href: args.href } : {}),
      ...(args.inputValue ? { inputValue: args.inputValue } : {}),
      ...(args.instruction ? { instruction: args.instruction } : {}),
      ...(args.allowMutation ? { allowMutation: args.allowMutation } : {})
    })))
  );

  server.tool(
    "live_close_session",
    "Close an interactive browser session.",
    { sessionId: z.string() },
    async (args) => textResult(await liveClose(args.sessionId))
  );

  server.tool(
    "kg_search_code",
    "Search the Cloud SQL/pgvector-backed code graph registry for impacted files, routes, modules, symbols, or UI strings.",
    {
      query: z.string(),
      limit: z.number().int().positive().max(25).optional()
    },
    async (args) => {
      const store = new CodeGraphStore();
      await store.init();
      return textResult(await store.search(args.query, args.limit ?? 8));
    }
  );

  server.tool(
    "kg_index_codebase",
    "Index GitHub org repositories into the code graph. This is long-running; use sparingly from Hermes.",
    {
      org: z.string().optional(),
      limitRepos: z.number().int().positive().max(100).optional(),
      embed: z.boolean().optional()
    },
    async (args) => textResult(await indexUnifiedCodebase({
      ...(args.org ? { org: args.org } : {}),
      ...(args.limitRepos ? { limitRepos: args.limitRepos } : {}),
      ...(typeof args.embed === "boolean" ? { embed: args.embed } : {})
    }))
  );

  return server;
}

async function queueRun(request: RunRequest) {
  const queued = await queueQaRun(request);
  return {
    jobId: queued.jobId,
    status: "queued",
    runScope: queued.plan.runScope,
    modules: queued.plan.modules,
    routes: queued.plan.routes,
    budgetProfile: queued.request.budgetProfile,
    prImpact: queued.prImpact,
    statusCommand: `/qa status ${queued.jobId}`,
    reportCommand: `/qa report ${queued.jobId}`
  };
}

async function liveStart(input: StartSessionInput) {
  const base = envString("QA_LIVE_API_URL");
  if (!base) return liveSessionManager.start(input);
  return liveFetch(`${base}/sessions`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

async function liveObserve(sessionId: string) {
  const base = envString("QA_LIVE_API_URL");
  if (!base) return liveSessionManager.observe(sessionId);
  return liveFetch(`${base}/sessions/${encodeURIComponent(sessionId)}/observe`, { method: "POST" });
}

async function liveAct(sessionId: string, input: LiveActionInput) {
  const base = envString("QA_LIVE_API_URL");
  if (!base) return liveSessionManager.act(sessionId, input);
  return liveFetch(`${base}/sessions/${encodeURIComponent(sessionId)}/act`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

async function liveClose(sessionId: string) {
  const base = envString("QA_LIVE_API_URL");
  if (!base) return liveSessionManager.close(sessionId);
  return liveFetch(`${base}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

async function liveFetch(url: string, init: RequestInit) {
  const token = envString("QA_INTERNAL_TOKEN");
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {})
    }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Live QA request failed (${response.status}): ${body}`);
  return body ? JSON.parse(body) as unknown : {};
}

function compactObservation(observation: unknown): unknown {
  if (!observation || typeof observation !== "object" || !("screen" in observation)) return observation;
  const value = observation as {
    sessionId: string;
    summary: string;
    screenshotUrl?: string;
    screen: {
      url: string;
      title: string;
      pageType: string;
      controls: Array<{ label: string; tag: string; href?: string; selectorHint?: string; visible: boolean; disabled: boolean }>;
      forms: unknown[];
      tables: unknown[];
      consoleEvents: unknown[];
      networkEvents: unknown[];
    };
  };
  return {
    sessionId: value.sessionId,
    summary: value.summary,
    url: value.screen.url,
    title: value.screen.title,
    pageType: value.screen.pageType,
    controls: value.screen.controls
      .filter((control) => control.visible && !control.disabled)
      .slice(0, 30)
      .map((control) => ({
        label: control.label,
        tag: control.tag,
        ...(control.href ? { href: control.href } : {}),
        ...(control.selectorHint ? { selectorHint: control.selectorHint } : {})
      })),
    forms: value.screen.forms,
    tables: value.screen.tables,
    consoleEvents: value.screen.consoleEvents,
    networkEvents: value.screen.networkEvents,
    ...(value.screenshotUrl ? { screenshotUrl: value.screenshotUrl } : {})
  };
}

function tenant(value: string | undefined): string {
  return value ?? envString("UNIFIED_QA_TENANT", DEFAULT_TENANT) ?? DEFAULT_TENANT;
}

function role(value: string | undefined): string {
  return value ?? envString("UNIFIED_QA_ROLE", DEFAULT_ROLE) ?? DEFAULT_ROLE;
}

function textResult(value: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
    }]
  };
}
