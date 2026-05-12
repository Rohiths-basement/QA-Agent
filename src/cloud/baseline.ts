import { readFile } from "node:fs/promises";
import type { BaselineComparison, Finding } from "../types.js";
import { shortHash } from "../utils/hash.js";

interface ReportShape {
  routes: Array<{ routeKey?: string; url: string; textHash?: string }>;
  findings: Finding[];
}

export async function compareReportFiles(input: {
  currentReportPath: string;
  baselineReportPath: string;
}): Promise<BaselineComparison> {
  const [current, baseline] = await Promise.all([
    readReport(input.currentReportPath),
    readReport(input.baselineReportPath)
  ]);
  return compareReports(current, baseline);
}

export function compareReports(current: ReportShape, baseline: ReportShape): BaselineComparison {
  const currentFindingMap = findingMap(current.findings);
  const baselineFindingMap = findingMap(baseline.findings);
  const currentRouteSet = new Set(current.routes.map(routeIdentity));
  const baselineRouteSet = new Set(baseline.routes.map(routeIdentity));
  const currentFingerprintMap = fingerprintMap(current.routes);
  const baselineFingerprintMap = fingerprintMap(baseline.routes);

  return {
    newFindings: current.findings.filter((finding) => !baselineFindingMap.has(findingSignature(finding))),
    knownFindings: current.findings.filter((finding) => baselineFindingMap.has(findingSignature(finding))),
    resolvedFindings: baseline.findings.filter((finding) => !currentFindingMap.has(findingSignature(finding))),
    routeCoverageDelta: {
      added: [...currentRouteSet].filter((route) => !baselineRouteSet.has(route)).sort(),
      removed: [...baselineRouteSet].filter((route) => !currentRouteSet.has(route)).sort(),
      unchanged: [...currentRouteSet].filter((route) => baselineRouteSet.has(route)).sort()
    },
    screenFingerprintDelta: {
      changed: [...currentFingerprintMap.entries()]
        .filter(([route, hash]) => baselineFingerprintMap.has(route) && baselineFingerprintMap.get(route) !== hash)
        .map(([route]) => route)
        .sort(),
      unchanged: [...currentFingerprintMap.entries()]
        .filter(([route, hash]) => baselineFingerprintMap.get(route) === hash)
        .map(([route]) => route)
        .sort()
    }
  };
}

function findingMap(findings: Finding[]): Set<string> {
  return new Set(findings.map(findingSignature));
}

function findingSignature(finding: Finding): string {
  return shortHash([
    finding.category,
    finding.severity,
    finding.route,
    normalize(finding.title),
    normalize(finding.expected),
    normalize(finding.actual)
  ].join("|"), 24);
}

function routeIdentity(route: { routeKey?: string; url: string }): string {
  return route.routeKey ?? route.url;
}

function fingerprintMap(routes: Array<{ routeKey?: string; url: string; textHash?: string }>): Map<string, string> {
  return new Map(routes.map((route) => [routeIdentity(route), route.textHash ?? "unknown"]));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

async function readReport(filePath: string): Promise<ReportShape> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<ReportShape>;
  return {
    routes: Array.isArray(parsed.routes) ? parsed.routes : [],
    findings: Array.isArray(parsed.findings) ? parsed.findings : []
  };
}
