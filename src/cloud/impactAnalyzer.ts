import type { ImpactPlan, RunRequest } from "../types.js";

interface ModuleHint {
  module: string;
  keywords: string[];
  routes: string[];
  citations: Array<{ title: string; url: string }>;
}

const MODULE_HINTS: ModuleHint[] = [
  {
    module: "CAD",
    keywords: ["cad", "dispatch", "incident", "call taking", "map"],
    routes: ["/cad", "/cad/map", "/dispatch"],
    citations: [{ title: "Unified CAD", url: "https://wiki.unified-apps.com/" }]
  },
  {
    module: "Crew Scheduling",
    keywords: ["crew", "schedule", "scheduling", "shift", "roster"],
    routes: ["/crew", "/scheduling", "/schedule"],
    citations: [{ title: "Crew Scheduling", url: "https://wiki.unified-apps.com/" }]
  },
  {
    module: "CloudPCR",
    keywords: ["cloudpcr", "pcr", "patient", "ems", "chart"],
    routes: ["/cloudpcr", "/pcr", "/charts"],
    citations: [{ title: "CloudPCR", url: "https://wiki.unified-apps.com/" }]
  },
  {
    module: "Reports",
    keywords: ["report", "analytics", "dashboard", "export"],
    routes: ["/reports", "/analytics", "/dashboard"],
    citations: [{ title: "Reports", url: "https://wiki.unified-apps.com/" }]
  },
  {
    module: "Settings",
    keywords: ["settings", "configuration", "admin", "permission", "role"],
    routes: ["/settings", "/admin", "/roles"],
    citations: [{ title: "Settings", url: "https://wiki.unified-apps.com/" }]
  }
];

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

export async function analyzeImpact(request: RunRequest): Promise<ImpactPlan> {
  const prompt = request.prompt ?? "";
  const urls = Array.from(prompt.matchAll(URL_RE), (match) => stripTrailingPunctuation(match[0]));
  const hintedModules = hintsForPrompt(prompt);
  const routes = unique([
    ...(request.seedUrls ?? []),
    ...urls,
    ...hintedModules.flatMap((hint) => hint.routes)
  ]);

  if (request.type === "full" || request.type === "baseline" || request.type === "wiki_sync") {
    return {
      modules: hintedModules.map((hint) => hint.module),
      routes: unique([...(request.seedUrls ?? []), ...urls]),
      wikiCitations: hintedModules.flatMap((hint) => hint.citations),
      confidence: 1,
      missingInfo: [],
      runScope: "full"
    };
  }

  if (!prompt && !routes.length && !(request.targetModules?.length)) {
    return {
      modules: [],
      routes: [],
      wikiCitations: [],
      confidence: 0,
      missingInfo: ["Provide a URL, module name, screen name, or short flow description."],
      runScope: "clarify"
    };
  }

  const modules = unique([...(request.targetModules ?? []), ...hintedModules.map((hint) => hint.module)]);
  const confidence = urls.length || request.seedUrls?.length ? 0.9 : hintedModules.length ? 0.65 : 0.35;
  return {
    modules,
    routes,
    wikiCitations: hintedModules.flatMap((hint) => hint.citations),
    confidence,
    missingInfo: confidence < 0.5 ? ["Could not confidently map the prompt to a known module; a targeted seed URL would improve accuracy."] : [],
    runScope: confidence < 0.35 ? "clarify" : "targeted"
  };
}

export function seedUrlsForImpact(plan: ImpactPlan, baseUrl: string): string[] {
  return unique(plan.routes.map((route) => {
    try {
      return new URL(route, baseUrl).toString();
    } catch {
      return undefined;
    }
  }).filter((url): url is string => Boolean(url)));
}

function hintsForPrompt(prompt: string): ModuleHint[] {
  const normalized = prompt.toLowerCase();
  return MODULE_HINTS.filter((hint) => hint.keywords.some((keyword) => normalized.includes(keyword)));
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;]+$/g, "");
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
