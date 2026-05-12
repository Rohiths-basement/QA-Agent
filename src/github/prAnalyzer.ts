import type { ImpactPlan, PrImpactPlan, PrImpactRequest, RunRequest } from "../types.js";
import { applyBudgetProfile } from "../budget/budgetPolicy.js";
import { seedUrlsForImpact } from "../cloud/impactAnalyzer.js";
import { envString } from "../cloud/env.js";
import { CodeGraphStore } from "../codegraph/codeGraphStore.js";
import { GitHubAppClient, githubConfigured, parseGitHubPrUrl } from "./githubApp.js";

const MODULE_ROUTE_HINTS: Record<string, string[]> = {
  CAD: ["/cad", "/cad/map", "/dispatch"],
  "Crew Scheduling": ["/crew", "/scheduling", "/schedule"],
  CloudPCR: ["/cloudpcr", "/pcr", "/charts"],
  Reports: ["/reports", "/analytics", "/dashboard"],
  Fleet: ["/fleet", "/trucks", "/vehicles"],
  Billing: ["/billing", "/account/billing"],
  SSO: ["/login", "/account", "/settings"],
  Settings: ["/settings", "/admin", "/roles"]
};

const DEFAULT_BASE_URL = "https://sso.unified-apps.com/login";

export async function analyzePullRequestImpact(input: PrImpactRequest): Promise<PrImpactPlan> {
  const ref = parseGitHubPrUrl(input.prUrl);
  const budgetProfile = applyBudgetProfile({
    type: "recent_change",
    tenant: input.tenant,
    role: input.role,
    prompt: `Analyze pull request ${input.prUrl}`,
    actionPolicy: "read_only",
    ...(input.budgetUsd ? { budgetUsd: input.budgetUsd } : {}),
    ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
    ...(input.slackChannel ? { slackChannel: input.slackChannel } : {}),
    ...(input.slackThreadTs ? { slackThreadTs: input.slackThreadTs } : {}),
    prUrl: input.prUrl
  }).budgetProfile;

  if (!githubConfigured()) {
    const modules = modulesFromPath(`${ref.repo} ${ref.url}`);
    return {
      prUrl: ref.url,
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      title: `PR #${ref.number}`,
      filesChanged: [],
      modules,
      routes: routeHintsForModules(modules),
      confidence: modules.length ? 0.45 : 0.2,
      summary: "GitHub App credentials are not configured, so impact was inferred only from the PR URL/repo name.",
      ...(budgetProfile ? { budgetProfile } : {})
    };
  }

  const github = new GitHubAppClient();
  const [pr, files] = await Promise.all([
    github.request<GitHubPullRequest>(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`),
    listChangedFiles(github, ref.owner, ref.repo, ref.number)
  ]);

  const changedPaths = files.map((file) => file.filename);
  const patchText = files.map((file) => `${file.filename}\n${file.patch ?? ""}`).join("\n\n").slice(0, 20_000);
  const graphHints = await searchCodeGraph(changedPaths, `${pr.title}\n${pr.body ?? ""}\n${patchText}`);
  const modules = unique([
    ...modulesFromPath(ref.repo),
    ...changedPaths.flatMap((filePath) => modulesFromPath(filePath)),
    ...modulesFromPath(`${pr.title} ${pr.body ?? ""}`),
    ...graphHints.flatMap((hint) => hint.modules ?? [])
  ]);
  const routes = unique([
    ...changedPaths.flatMap((filePath) => routesFromPath(filePath)),
    ...graphHints.flatMap((hint) => hint.routes ?? []),
    ...routeHintsForModules(modules)
  ]);
  const confidence = confidenceFor({ changedPaths, modules, routes, graphHints: graphHints.length });

  return {
    prUrl: ref.url,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: pr.title,
    filesChanged: changedPaths,
    modules,
    routes,
    confidence,
    summary: summaryForPr(pr, changedPaths, modules, routes, graphHints.length),
    ...(budgetProfile ? { budgetProfile } : {})
  };
}

export function runRequestFromPrImpact(input: {
  source: RunRequest;
  impact: PrImpactPlan;
  baseUrl?: string;
}): RunRequest {
  const impactPlan: ImpactPlan = {
    modules: input.impact.modules,
    routes: input.impact.routes,
    wikiCitations: [],
    confidence: input.impact.confidence,
    missingInfo: input.impact.confidence < 0.4 ? ["PR impact confidence is low; provide a target screen or module if this run is too broad."] : [],
    runScope: input.impact.routes.length || input.impact.modules.length ? "targeted" : "clarify"
  };
  const baseUrl = input.baseUrl ?? envString("UNIFIED_QA_BASE_URL", DEFAULT_BASE_URL) ?? DEFAULT_BASE_URL;
  const seedUrls = input.source.seedUrls?.length ? input.source.seedUrls : seedUrlsForImpact(impactPlan, baseUrl);
  return applyBudgetProfile({
    ...input.source,
    prompt: [
      input.source.prompt,
      `PR impact: ${input.impact.summary}`,
      input.impact.filesChanged.length ? `Files changed: ${input.impact.filesChanged.slice(0, 30).join(", ")}` : undefined
    ].filter(Boolean).join("\n"),
    ...(seedUrls.length ? { seedUrls } : {}),
    ...(input.impact.modules.length ? { targetModules: input.impact.modules } : {})
  });
}

async function listChangedFiles(
  github: GitHubAppClient,
  owner: string,
  repo: string,
  number: number
): Promise<GitHubPullFile[]> {
  const files: GitHubPullFile[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await github.request<GitHubPullFile[]>(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files;
}

async function searchCodeGraph(paths: string[], context: string) {
  const store = new CodeGraphStore();
  await store.init();
  const queries = unique([
    ...paths.slice(0, 12),
    ...paths.slice(0, 12).map((filePath) => filePath.split("/").at(-1) ?? filePath),
    ...modulesFromPath(context)
  ]).filter(Boolean);
  const batches = await Promise.all(queries.slice(0, 20).map((query) => store.search(query, 5).catch(() => [])));
  return uniqueBy(batches.flat(), (result) => result.chunkId);
}

function modulesFromPath(value: string): string[] {
  const source = value.toLowerCase();
  const modules = [
    ["CAD", /\bcad\b|dispatch|incident|call[-_\s]?taking|map/],
    ["Crew Scheduling", /crew|schedule|scheduling|shift|roster/],
    ["CloudPCR", /cloudpcr|\bpcr\b|patient|chart|ems/],
    ["Reports", /report|analytics|dashboard|export/],
    ["Fleet", /fleet|truck|vehicle|transport/],
    ["Billing", /billing|invoice|subscription|account/],
    ["SSO", /\bsso\b|auth|login|tenant|permission/],
    ["Settings", /settings|configuration|admin|role/]
  ].filter(([, pattern]) => (pattern as RegExp).test(source)).map(([module]) => module as string);
  return unique(modules);
}

function routesFromPath(filePath: string): string[] {
  const normalized = filePath.toLowerCase();
  const routes: string[] = [];
  for (const segment of normalized.split("/")) {
    if (/^(pages|routes|app|views)$/.test(segment)) continue;
    if (/^[a-z][a-z0-9_-]{2,}$/.test(segment) && !/\.[a-z0-9]+$/.test(segment)) routes.push(`/${segment}`);
  }
  return unique(routes.filter((route) => !/\/(src|components|lib|utils|test|tests|api)$/.test(route))).slice(0, 10);
}

function routeHintsForModules(modules: string[]): string[] {
  return unique(modules.flatMap((module) => MODULE_ROUTE_HINTS[module] ?? []));
}

function confidenceFor(input: { changedPaths: string[]; modules: string[]; routes: string[]; graphHints: number }): number {
  let confidence = 0.25;
  if (input.changedPaths.length) confidence += 0.2;
  if (input.modules.length) confidence += 0.2;
  if (input.routes.length) confidence += 0.2;
  if (input.graphHints) confidence += 0.15;
  return Math.min(confidence, 0.95);
}

function summaryForPr(
  pr: GitHubPullRequest,
  changedPaths: string[],
  modules: string[],
  routes: string[],
  graphHintCount: number
): string {
  const scope = modules.length ? modules.join(", ") : "unknown module";
  const routeText = routes.length ? `${routes.slice(0, 8).join(", ")}` : "no concrete routes found";
  return `${pr.title} changes ${changedPaths.length} files. Likely scope: ${scope}. Candidate routes: ${routeText}. Code graph matches: ${graphHintCount}.`;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const itemKey = key(item);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    out.push(item);
  }
  return out;
}

interface GitHubPullRequest {
  title: string;
  body?: string | null;
}

interface GitHubPullFile {
  filename: string;
  patch?: string;
}
