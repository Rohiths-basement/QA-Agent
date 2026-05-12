import crypto from "node:crypto";
import type { RunActionPolicy, RunRequest } from "../types.js";
import { envString } from "./env.js";

export type SlackCommandIntent =
  | { kind: "run"; request: RunRequest }
  | { kind: "status"; jobId: string }
  | { kind: "report"; jobId: string }
  | { kind: "approve"; approvalRef: string }
  | { kind: "clarify"; message: string };

export interface SlackContext {
  requestedBy?: string;
  slackChannel?: string;
  slackThreadTs?: string;
  defaultTenant: string;
  defaultRole: string;
}

export function verifySlackRequest(input: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  maxSkewSeconds?: number;
}): boolean {
  if (!input.timestamp || !input.signature) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const requestSeconds = Number(input.timestamp);
  if (!Number.isFinite(requestSeconds)) return false;
  if (Math.abs(nowSeconds - requestSeconds) > (input.maxSkewSeconds ?? 300)) return false;

  const base = `v0:${input.timestamp}:${input.rawBody}`;
  const digest = `v0=${crypto.createHmac("sha256", input.signingSecret).update(base).digest("hex")}`;
  return timingSafeEqual(digest, input.signature);
}

export function parseQaText(text: string, context: SlackContext): SlackCommandIntent {
  const [verbRaw, ...rest] = text.trim().split(/\s+/);
  const verb = (verbRaw ?? "").toLowerCase();
  const prompt = rest.join(" ").trim();

  if (!verb) {
    return { kind: "clarify", message: "Try `/qa full`, `/qa recent <change>`, `/qa screen <url-or-description>`, or `/qa flow <description>`." };
  }
  if (verb === "status") return prompt ? { kind: "status", jobId: prompt } : { kind: "clarify", message: "Send `/qa status <jobId>`." };
  if (verb === "report") return prompt ? { kind: "report", jobId: prompt } : { kind: "clarify", message: "Send `/qa report <jobId>`." };
  if (verb === "approve") return prompt ? { kind: "approve", approvalRef: prompt } : { kind: "clarify", message: "Send `/qa approve <jobId/actionId>`." };

  if (verb === "full" || verb === "baseline") {
    const parsed = parseTenantRoleBudget(prompt, context);
    return {
      kind: "run",
      request: baseRequest({
        type: verb === "baseline" ? "baseline" : "full",
        prompt,
        tenant: parsed.tenant,
        role: parsed.role,
        actionPolicy: "sandbox_mutation",
        context,
        ...(parsed.budgetUsd ? { budgetUsd: parsed.budgetUsd } : {})
      })
    };
  }

  if (verb === "recent" || verb === "screen" || verb === "flow") {
    if (!prompt) {
      return { kind: "clarify", message: `Send a target after /qa ${verb}, for example /qa ${verb} CAD map.` };
    }
    return {
      kind: "run",
      request: baseRequest({
        type: verb === "recent" ? "recent_change" : verb,
        prompt,
        tenant: context.defaultTenant,
        role: context.defaultRole,
        actionPolicy: "read_only",
        context,
        seedUrls: extractUrls(prompt)
      })
    };
  }

  return parseConversationalQaText(text, context);
}

export function parseConversationalQaText(text: string, context: SlackContext): SlackCommandIntent {
  const cleaned = text.replace(/<@[A-Z0-9]+>/gi, "").trim();
  const normalized = cleaned.toLowerCase();
  if (!/(qa|test|check|validate)/.test(normalized)) {
    return { kind: "clarify", message: "I can run QA for full app, recent changes, a screen, or a flow. What should I test?" };
  }
  const isFull = /\b(full|end-to-end|e2e|entire app|whole app)\b/.test(normalized);
  const isRecent = /\b(recent|changed|change|release|new feature|impact)\b/.test(normalized);
  const isFlow = /\b(flow|workflow|journey)\b/.test(normalized);
  const type = isFull ? "full" : isRecent ? "recent_change" : isFlow ? "flow" : "screen";
  return {
    kind: "run",
    request: baseRequest({
      type,
      prompt: cleaned,
      tenant: context.defaultTenant,
      role: context.defaultRole,
      actionPolicy: isFull ? "sandbox_mutation" : "read_only",
      context,
      seedUrls: extractUrls(cleaned)
    })
  };
}

export async function postSlackMessage(input: {
  channel?: string;
  threadTs?: string;
  text: string;
  blocks?: unknown[];
}): Promise<void> {
  const token = envString("SLACK_BOT_TOKEN");
  if (!token || !input.channel) {
    console.log(`[slack] ${input.text}`);
    return;
  }

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      channel: input.channel,
      text: input.text,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      ...(input.blocks ? { blocks: input.blocks } : {})
    })
  });
  const json = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!json.ok) throw new Error(`Slack post failed: ${json.error ?? response.statusText}`);
}

function baseRequest(input: {
  type: RunRequest["type"];
  prompt?: string;
  tenant: string;
  role: string;
  budgetUsd?: number;
  actionPolicy: RunActionPolicy;
  context: SlackContext;
  seedUrls?: string[];
}): RunRequest {
  return {
    type: input.type,
    tenant: input.tenant,
    role: input.role,
    actionPolicy: input.actionPolicy,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.budgetUsd ? { budgetUsd: input.budgetUsd } : {}),
    ...(input.context.requestedBy ? { requestedBy: input.context.requestedBy } : {}),
    ...(input.context.slackChannel ? { slackChannel: input.context.slackChannel } : {}),
    ...(input.context.slackThreadTs ? { slackThreadTs: input.context.slackThreadTs } : {}),
    ...(input.seedUrls?.length ? { seedUrls: input.seedUrls } : {})
  };
}

function parseTenantRoleBudget(text: string, context: SlackContext): { tenant: string; role: string; budgetUsd?: number } {
  const words = text.split(/\s+/).filter(Boolean);
  const budgetWord = words.find((word) => /^\$?\d+(\.\d+)?$/.test(word));
  const budgetUsd = budgetWord ? Number(budgetWord.replace("$", "")) : undefined;
  const nonBudget = words.filter((word) => word !== budgetWord);
  return {
    tenant: nonBudget[0] ?? context.defaultTenant,
    role: nonBudget[1] ?? context.defaultRole,
    ...(budgetUsd ? { budgetUsd } : {})
  };
}

function extractUrls(text: string): string[] {
  return Array.from(text.matchAll(/https?:\/\/[^\s<>"')]+/gi), (match) => match[0].replace(/[),.;]+$/g, ""));
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
