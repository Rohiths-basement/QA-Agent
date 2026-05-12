import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentConfig, CandidateAction, ScreenState } from "../types.js";
import { CoverageEngine } from "../coverage/coverageEngine.js";
import { loadCredentialProfile } from "../credentials/credentials.js";
import { EmptyKnowledgeSearch } from "../knowledge/emptyKnowledgeSearch.js";
import { buildScreenQuery, type KnowledgeSearch } from "../knowledge/knowledgeSearch.js";
import { LocalKnowledgeSearch } from "../knowledge/localKnowledgeSearch.js";
import { OracleClient } from "../knowledge/oracleClient.js";
import { SqliteMemory } from "../memory/sqliteMemory.js";
import { SafeActionPolicy } from "../policy/safeActionPolicy.js";
import { Planner } from "../planner/planner.js";
import { generateReport } from "../report/reporter.js";
import { BrowserRuntime, type ExecuteResult } from "../runtime/browserRuntime.js";
import { Validator } from "../validator/validator.js";
import { ensureDir } from "../utils/fs.js";
import { shortHash } from "../utils/hash.js";
import { scopedUnifiedUrl } from "../utils/route.js";

export interface AgentRunResult {
  runId: string;
  status: "completed" | "failed" | "incomplete";
  reportJsonPath: string;
  reportHtmlPath: string;
}

export async function runQaAgent(config: AgentConfig): Promise<AgentRunResult> {
  await ensureDir(path.join(config.artifactDir, config.runId ?? "unknown"));
  const runId = config.resumeRunId ?? config.runId;
  if (!runId) throw new Error("A run id is required.");

  const memory = new SqliteMemory(config.storagePath);
  const runtime = new BrowserRuntime({
    runId,
    baseUrl: config.baseUrl,
    artifactDir: config.artifactDir,
    headless: config.headless,
    useStagehand: config.useStagehand,
    tenant: config.tenant,
    role: config.role
  });

  try {
    const credentials = await loadCredentialProfile({
      tenant: config.tenant,
      role: config.role,
      ...(config.credentialsFile ? { credentialsFile: config.credentialsFile } : {})
    });
    memory.createRun({
      runId,
      baseUrl: config.baseUrl,
      tenant: config.tenant,
      role: config.role,
      metadata: {
        wikiUrl: config.wikiUrl,
        vectorStoreId: config.vectorStoreId,
        stagehand: config.useStagehand,
        seedUrls: config.seedUrls ?? [],
        discoverLinks: config.discoverLinks !== false,
        runRequest: config.runRequest ?? null
      }
    });

    const knowledgeSearch = await buildKnowledgeSearch(config);
    const oracle = new OracleClient({ model: config.model, ...(config.vectorStoreId ? { vectorStoreId: config.vectorStoreId } : {}) });
    const coverage = new CoverageEngine(memory, runId);
    const policy = new SafeActionPolicy({ runId, approvalMode: config.approvalMode });
    const planner = new Planner(policy, runId);
    const validator = new Validator({ runId, tenant: config.tenant, role: config.role });
    const attemptedActions = new Set(memory.listActions(runId).map((action) => action.id));
    const steps: string[] = [`Start QA run ${runId}`];

    await runtime.init();
    const resumeUrl = config.resumeRunId ? coverage.nextQueuedUrl() : undefined;
    if (resumeUrl) {
      await runtime.goto(resumeUrl);
      steps.push(`Resume from queued route ${resumeUrl}`);
    } else {
      await runtime.login(credentials);
      steps.push(`Login as ${config.tenant}/${config.role}`);
      const seedUrl = queueSeedUrls(config.seedUrls ?? [], config.baseUrl, coverage);
      if (seedUrl) {
        await runtime.goto(seedUrl);
        steps.push(`Navigate to requested seed route ${seedUrl}`);
      }
    }

    let lastExecution: ExecuteResult | undefined;
    let status: AgentRunResult["status"] = "incomplete";

    let step = 0;
    for (; step < config.maxSteps; step += 1) {
      const screen = await runtime.observe();
      coverage.recordObservation(screen);
      if (config.discoverLinks !== false) discoverRoutesFromScreen(screen, coverage);

      const stagehandObservations = config.useStagehand
        ? await runtime.stagehandObserve("Find actionable controls, navigation targets, forms, and destructive actions on this screen.")
        : [];
      if (stagehandObservations.length) {
        memory.recordEvidence({
          id: shortHash(`${runId}:${screen.routeKey}:stagehand:${step}`, 24),
          runId,
          routeKey: screen.routeKey,
          type: "stagehand_observe",
          data: stagehandObservations
        });
      }

      const chunks = await knowledgeSearch.search(buildScreenQuery(screen), { maxResults: 8 });
      const oracleJudgment = await oracle.judge(screen, chunks);
      const findings = validator.validateScreen({
        screen,
        chunks,
        oracle: oracleJudgment,
        ...(lastExecution ? { execution: lastExecution } : {}),
        steps: [...steps, `Observe ${screen.url}`]
      });

      for (const finding of findings) memory.recordFinding(finding);
      memory.recordEvidence({
        id: shortHash(`${runId}:${screen.routeKey}:oracle:${step}`, 24),
        runId,
        routeKey: screen.routeKey,
        type: "oracle_judgment",
        data: oracleJudgment
      });
      coverage.markValidated(screen);
      lastExecution = undefined;

      const decision = planner.chooseNextAction(screen, attemptedActions);
      for (const policyDecision of decision.policyDecisions) {
        if (policyDecision.decision !== "allow") {
          memory.recordAction({
            id: policyDecision.action.id,
            runId,
            routeKey: screen.routeKey,
            kind: policyDecision.action.kind,
            label: policyDecision.action.label,
            risk: policyDecision.action.risk,
            status: policyDecision.decision === "deny" ? "blocked" : "skipped",
            reason: policyDecision.reason
          });
          attemptedActions.add(policyDecision.action.id);
        }
      }

      if (!decision.action) {
        const nextRoute = memory.nextQueuedRoute(runId);
        if (!nextRoute) {
          status = "completed";
          break;
        }
        try {
          await runtime.goto(nextRoute.url);
          steps.push(`Navigate to queued route ${nextRoute.url}`);
        } catch (error) {
          coverage.markRouteFailed(nextRoute.routeKey);
          steps.push(`Failed to navigate queued route ${nextRoute.url}: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      const action = decision.action;
      attemptedActions.add(action.id);
      memory.recordAction({
        id: action.id,
        runId,
        routeKey: screen.routeKey,
        kind: action.kind,
        label: action.label,
        risk: action.risk,
        status: "queued",
        reason: "Selected by planner"
      });
      steps.push(`Execute ${action.kind}: ${action.label}`);
      lastExecution = await runtime.execute(action);
      memory.recordAction({
        id: action.id,
        runId,
        routeKey: screen.routeKey,
        kind: action.kind,
        label: action.label,
        risk: action.risk,
        status: lastExecution.success ? "executed" : "failed",
        reason: lastExecution.success ? action.expectedResult : lastExecution.error ?? "Action failed"
      });

      const nextRouteKey = coverage.queueDiscoveredUrl(lastExecution.afterUrl);
      coverage.recordTransition(screen.routeKey, nextRouteKey, action);
    }

    if (status !== "completed" && step >= config.maxSteps) {
      memory.recordEvidence({
        id: shortHash(`${runId}:safety-step-limit`, 24),
        runId,
        routeKey: "run",
        type: "run_limit",
        data: {
          maxSteps: config.maxSteps,
          message: "Run stopped at the configured safety step limit before the route frontier was exhausted."
        }
      });
    }

    if (status !== "completed") {
      status = coverage.isExhausted() ? "completed" : "incomplete";
    }
    memory.markRunStatus(runId, status);
    const report = await generateReport({ memory, runId, artifactDir: config.artifactDir });
    return { runId, status, reportJsonPath: report.jsonPath, reportHtmlPath: report.htmlPath };
  } catch (error) {
    memory.markRunStatus(runId, "failed");
    const report = await generateReport({ memory, runId, artifactDir: config.artifactDir }).catch(() => ({
      jsonPath: "",
      htmlPath: ""
    }));
    if (error instanceof Error) error.message = `QA run failed: ${error.message}`;
    throw error;
  } finally {
    await runtime.close().catch(() => undefined);
    memory.close();
  }
}

async function buildKnowledgeSearch(config: AgentConfig): Promise<KnowledgeSearch> {
  if (config.wikiJsonlPath && existsSync(config.wikiJsonlPath)) {
    return LocalKnowledgeSearch.fromJsonl(config.wikiJsonlPath);
  }
  return new EmptyKnowledgeSearch();
}

function discoverRoutesFromScreen(screen: ScreenState, coverage: CoverageEngine): void {
  for (const control of screen.controls) {
    if (!control.href) continue;
    const url = scopedUnifiedUrl(screen.url, control.href);
    if (url) coverage.queueDiscoveredUrl(url);
  }
}

function queueSeedUrls(seedUrls: string[], baseUrl: string, coverage: CoverageEngine): string | undefined {
  const scopedSeeds = seedUrls
    .map((seedUrl) => scopedUnifiedUrl(baseUrl, seedUrl) ?? scopedUnifiedUrl(seedUrl, seedUrl))
    .filter((seedUrl): seedUrl is string => Boolean(seedUrl));
  for (const seedUrl of scopedSeeds) coverage.queueDiscoveredUrl(seedUrl);
  return scopedSeeds[0];
}
