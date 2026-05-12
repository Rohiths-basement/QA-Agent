import type { BudgetProfile, RunRequest } from "../types.js";

export const DEFAULT_LIGHT_MODEL = "openai/gpt-5.1-chat";
export const DEFAULT_HEAVY_MODEL = "openai/gpt-5.5";

export function budgetProfileFor(input: {
  budgetUsd?: number;
  prompt?: string;
  runType?: RunRequest["type"];
}): BudgetProfile {
  const budgetUsd = input.budgetUsd ?? parseBudgetUsd(input.prompt) ?? defaultBudgetFor(input.runType);
  const lightModel = process.env.OPENROUTER_ORACLE_LIGHT_MODEL ?? DEFAULT_LIGHT_MODEL;
  const heavyModel = process.env.OPENROUTER_ORACLE_HEAVY_MODEL ?? DEFAULT_HEAVY_MODEL;

  if (budgetUsd <= 5) {
    return {
      budgetUsd,
      tier: "micro",
      lightModel,
      heavyModel,
      selectedModel: lightModel,
      maxSteps: input.runType === "full" ? 40 : 12,
      maxDepth: 1,
      oracleFrequency: "minimal",
      allowStagehand: false,
      allowHeavyModel: false,
      rationale: "Small budget: prioritize deterministic Playwright checks, shallow scope, and cheap oracle calls only."
    };
  }
  if (budgetUsd <= 25) {
    return {
      budgetUsd,
      tier: "standard",
      lightModel,
      heavyModel,
      selectedModel: lightModel,
      maxSteps: input.runType === "full" ? 160 : 45,
      maxDepth: 2,
      oracleFrequency: "selective",
      allowStagehand: false,
      allowHeavyModel: false,
      rationale: "Standard budget: cover the targeted flow with selective oracle validation and bounded route expansion."
    };
  }
  if (budgetUsd <= 100) {
    return {
      budgetUsd,
      tier: "deep",
      lightModel,
      heavyModel,
      selectedModel: lightModel,
      maxSteps: input.runType === "full" ? 500 : 120,
      maxDepth: 4,
      oracleFrequency: "normal",
      allowStagehand: true,
      allowHeavyModel: true,
      rationale: "Deep budget: allow Stagehand discovery and heavy-model escalation for ambiguous screens or PR impact reasoning."
    };
  }
  return {
    budgetUsd,
    tier: "release",
    lightModel,
    heavyModel,
    selectedModel: heavyModel,
    maxSteps: input.runType === "full" ? 1200 : 250,
    maxDepth: 6,
    oracleFrequency: "aggressive",
    allowStagehand: true,
    allowHeavyModel: true,
    rationale: "Release budget: broaden coverage, use richer reasoning, and validate more screens against product/code context."
  };
}

export function applyBudgetProfile(request: RunRequest): RunRequest {
  const budgetProfile = budgetProfileFor({
    runType: request.type,
    ...(request.budgetUsd ? { budgetUsd: request.budgetUsd } : {}),
    ...(request.prompt ? { prompt: request.prompt } : {})
  });
  return {
    ...request,
    budgetUsd: budgetProfile.budgetUsd,
    budgetProfile,
    maxSteps: request.maxSteps ?? budgetProfile.maxSteps,
    maxDepth: request.maxDepth ?? budgetProfile.maxDepth,
    enableStagehand: request.enableStagehand ?? budgetProfile.allowStagehand
  };
}

export function parseBudgetUsd(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match = /(?:budget(?:\s+of|\s+is)?\s*)?\$([0-9]+(?:\.[0-9]{1,2})?)|\b([0-9]+(?:\.[0-9]{1,2})?)\s*(?:usd|dollars?)\b/i.exec(text);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function defaultBudgetFor(runType: RunRequest["type"] | undefined): number {
  if (runType === "full" || runType === "baseline") return 25;
  if (runType === "recent_change" || runType === "flow") return 15;
  return 5;
}
