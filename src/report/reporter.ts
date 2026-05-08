import { writeFile } from "node:fs/promises";
import path from "node:path";
import { SqliteMemory } from "../memory/sqliteMemory.js";
import { ensureDir, writeJson } from "../utils/fs.js";

export async function generateReport(input: {
  memory: SqliteMemory;
  runId: string;
  artifactDir: string;
}): Promise<{ jsonPath: string; htmlPath: string }> {
  const runDir = path.join(input.artifactDir, input.runId);
  await ensureDir(runDir);
  const summary = input.memory.getRunSummary(input.runId);
  const routes = input.memory.listRoutes(input.runId);
  const actions = input.memory.listActions(input.runId);
  const findings = input.memory.listFindings(input.runId);
  const report = { summary, routes, actions, findings };
  const jsonPath = path.join(runDir, "report.json");
  const htmlPath = path.join(runDir, "report.html");
  await writeJson(jsonPath, report);
  await writeFile(htmlPath, renderHtml(report, runDir), "utf8");
  return { jsonPath, htmlPath };
}

function renderHtml(report: ReturnType<typeof buildReportShape>, runDir: string): string {
  const findings = report.findings.map((finding) => `
    <article class="finding ${finding.severity}">
      <h3>${escapeHtml(finding.severity)} - ${escapeHtml(finding.title)}</h3>
      <p><strong>Category:</strong> ${escapeHtml(finding.category)}</p>
      <p><strong>Route:</strong> ${escapeHtml(finding.route)}</p>
      <p><strong>Expected:</strong> ${escapeHtml(finding.expected)}</p>
      <p><strong>Actual:</strong> ${escapeHtml(finding.actual)}</p>
      <p><strong>Steps:</strong></p>
      <ol>${finding.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
      ${finding.screenshotPath ? `<p><a href="${relativeLink(runDir, finding.screenshotPath)}">Screenshot</a></p>` : ""}
      ${finding.tracePath ? `<p><a href="${relativeLink(runDir, finding.tracePath)}">Trace</a></p>` : ""}
      ${finding.citationUrls.length ? `<p><strong>Wiki citations:</strong> ${finding.citationUrls.map((url) => `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`).join(", ")}</p>` : ""}
    </article>
  `).join("\n");

  const routes = report.routes.map((route) => `
    <tr>
      <td>${escapeHtml(route.status)}</td>
      <td>${escapeHtml(route.pageType)}</td>
      <td><a href="${escapeHtml(route.url)}">${escapeHtml(route.url)}</a></td>
      <td>${route.visitCount}</td>
    </tr>
  `).join("\n");

  const actions = report.actions.map((action) => `
    <tr>
      <td>${escapeHtml(action.status)}</td>
      <td>${escapeHtml(action.kind)}</td>
      <td>${escapeHtml(action.risk)}</td>
      <td>${escapeHtml(action.label)}</td>
      <td>${escapeHtml(action.reason)}</td>
    </tr>
  `).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Unified QA Report ${escapeHtml(report.summary.runId)}</title>
  <style>
    body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #1f2933; }
    h1, h2, h3 { margin: 0 0 12px; }
    .summary { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 12px; margin: 20px 0; }
    .metric { border: 1px solid #d8dee4; border-radius: 8px; padding: 12px; background: #f8fafc; }
    .metric strong { display: block; font-size: 22px; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0 28px; }
    th, td { border: 1px solid #d8dee4; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #eef2f6; }
    .finding { border: 1px solid #d8dee4; border-left-width: 6px; border-radius: 8px; padding: 16px; margin: 14px 0; }
    .P0 { border-left-color: #b42318; }
    .P1 { border-left-color: #d92d20; }
    .P2 { border-left-color: #dc6803; }
    .P3 { border-left-color: #667085; }
    a { color: #075985; }
  </style>
</head>
<body>
  <h1>Unified QA Report</h1>
  <p>Run ${escapeHtml(report.summary.runId)} - ${escapeHtml(report.summary.status)}</p>
  <section class="summary">
    <div class="metric"><span>Visited routes</span><strong>${report.summary.routesVisited}</strong></div>
    <div class="metric"><span>Queued routes</span><strong>${report.summary.routesQueued}</strong></div>
    <div class="metric"><span>Actions</span><strong>${report.summary.actionsAttempted}</strong></div>
    <div class="metric"><span>Findings</span><strong>${report.summary.findings}</strong></div>
    <div class="metric"><span>Started</span><strong>${escapeHtml(report.summary.startedAt)}</strong></div>
  </section>
  <h2>Findings</h2>
  ${findings || "<p>No findings recorded.</p>"}
  <h2>Routes</h2>
  <table><thead><tr><th>Status</th><th>Type</th><th>URL</th><th>Visits</th></tr></thead><tbody>${routes}</tbody></table>
  <h2>Actions</h2>
  <table><thead><tr><th>Status</th><th>Kind</th><th>Risk</th><th>Label</th><th>Reason</th></tr></thead><tbody>${actions}</tbody></table>
</body>
</html>`;
}

function buildReportShape(memory: SqliteMemory, runId: string) {
  return {
    summary: memory.getRunSummary(runId),
    routes: memory.listRoutes(runId),
    actions: memory.listActions(runId),
    findings: memory.listFindings(runId)
  };
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function relativeLink(runDir: string, filePath: string): string {
  return escapeHtml(path.relative(runDir, filePath));
}
