import type { ExecuteResult } from "../runtime/browserRuntime.js";
import type { Finding, FindingCategory, FindingSeverity, OracleJudgment, RetrievedChunk, ScreenState } from "../types.js";
import { shortHash } from "../utils/hash.js";
import { nowIso } from "../utils/time.js";

export interface ValidatorOptions {
  runId: string;
  tenant: string;
  role: string;
}

export class Validator {
  constructor(private readonly options: ValidatorOptions) {}

  validateScreen(input: {
    screen: ScreenState;
    chunks: RetrievedChunk[];
    oracle: OracleJudgment;
    execution?: ExecuteResult;
    steps: string[];
  }): Finding[] {
    const findings: Finding[] = [];
    const { screen, chunks, oracle, execution, steps } = input;

    if (execution && !execution.success) {
      findings.push(this.finding({
        screen,
        severity: "P2",
        category: "functional_bug",
        title: `Action failed on ${screen.title || screen.url}`,
        expected: "The selected browser action should complete or present a clear validation state.",
        actual: execution.error ?? "The action failed without a detailed error.",
        steps,
        ...(execution.tracePath ? { tracePath: execution.tracePath } : {}),
        citationUrls: chunks.map((chunk) => chunk.url)
      }));
    }

    const consoleErrors = screen.consoleEvents.filter((event) => event.type === "error");
    if (consoleErrors.length) {
      findings.push(this.finding({
        screen,
        severity: "P2",
        category: "console_runtime_error",
        title: "Console errors detected",
        expected: "Screen should load without uncaught runtime errors.",
        actual: consoleErrors.map((event) => event.text).slice(0, 5).join("\n"),
        steps,
        citationUrls: []
      }));
    }

    const failedNetwork = screen.networkEvents.filter((event) => event.failureText || (event.status && event.status >= 400));
    if (failedNetwork.length) {
      findings.push(this.finding({
        screen,
        severity: failedNetwork.some((event) => (event.status ?? 0) >= 500) ? "P1" : "P2",
        category: "network_api_failure",
        title: "Failed network/API requests detected",
        expected: "Critical page requests should complete successfully.",
        actual: failedNetwork.map((event) => `${event.method} ${event.status ?? event.failureText} ${event.url}`).slice(0, 8).join("\n"),
        steps,
        citationUrls: []
      }));
    }

    if (screen.pageType === "error") {
      findings.push(this.finding({
        screen,
        severity: /login|auth|unauthorized|forbidden/i.test(screen.visibleText) ? "P0" : "P1",
        category: "broken_navigation",
        title: "Error page reached during QA flow",
        expected: "The route should render a valid Unified application screen.",
        actual: screen.visibleText.slice(0, 1_000),
        steps,
        citationUrls: chunks.map((chunk) => chunk.url)
      }));
    }

    for (const mismatch of oracle.mismatches) {
      findings.push(this.finding({
        screen,
        severity: normalizeSeverity(mismatch.severity),
        category: normalizeCategory(mismatch.category),
        title: mismatch.title,
        expected: mismatch.expected,
        actual: mismatch.actual,
        steps,
        citationUrls: mismatch.citationUrls
      }));
    }

    return findings;
  }

  private finding(input: {
    screen: ScreenState;
    severity: FindingSeverity;
    category: FindingCategory;
    title: string;
    expected: string;
    actual: string;
    steps: string[];
    tracePath?: string;
    citationUrls: string[];
  }): Finding {
    const createdAt = nowIso();
    return {
      id: shortHash(`${this.options.runId}:${input.screen.routeKey}:${input.category}:${input.title}:${input.actual}`, 24),
      runId: this.options.runId,
      severity: input.severity,
      category: input.category,
      title: input.title,
      route: input.screen.url,
      tenant: this.options.tenant,
      role: this.options.role,
      steps: input.steps,
      expected: input.expected,
      actual: input.actual,
      ...(input.screen.screenshotPath ? { screenshotPath: input.screen.screenshotPath } : {}),
      ...(input.tracePath ? { tracePath: input.tracePath } : {}),
      consoleEvidence: input.screen.consoleEvents,
      networkEvidence: input.screen.networkEvents,
      citationUrls: input.citationUrls,
      createdAt
    };
  }
}

function normalizeSeverity(value: string): FindingSeverity {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3" ? value : "P2";
}

function normalizeCategory(value: string): FindingCategory {
  const allowed: FindingCategory[] = [
    "functional_bug",
    "workflow_mismatch",
    "wiki_product_mismatch",
    "copy_text_issue",
    "layout_display_issue",
    "accessibility_issue",
    "validation_issue",
    "broken_navigation",
    "auth_permission_issue",
    "console_runtime_error",
    "network_api_failure",
    "data_persistence_issue",
    "flaky_timeout_issue"
  ];
  return allowed.includes(value as FindingCategory) ? value as FindingCategory : "functional_bug";
}
