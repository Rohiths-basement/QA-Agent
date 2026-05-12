import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareReports } from "../src/cloud/baseline.js";
import type { Finding } from "../src/types.js";

describe("baseline comparator", () => {
  it("classifies new, known, and resolved findings", () => {
    const known = finding("f1", "Broken export", "/reports");
    const resolved = finding("f2", "Bad copy", "/settings");
    const newlyFound = finding("f3", "Map does not load", "/cad/map");

    const comparison = compareReports(
      {
        routes: [
          { routeKey: "reports", url: "https://app/reports", textHash: "same" },
          { routeKey: "cad", url: "https://app/cad/map", textHash: "new" }
        ],
        findings: [known, newlyFound]
      },
      {
        routes: [
          { routeKey: "reports", url: "https://app/reports", textHash: "same" },
          { routeKey: "settings", url: "https://app/settings", textHash: "old" }
        ],
        findings: [known, resolved]
      }
    );

    assert.deepEqual(comparison.knownFindings.map((item) => item.title), ["Broken export"]);
    assert.deepEqual(comparison.newFindings.map((item) => item.title), ["Map does not load"]);
    assert.deepEqual(comparison.resolvedFindings.map((item) => item.title), ["Bad copy"]);
    assert.deepEqual(comparison.routeCoverageDelta.added, ["cad"]);
    assert.deepEqual(comparison.routeCoverageDelta.removed, ["settings"]);
  });
});

function finding(id: string, title: string, route: string): Finding {
  return {
    id,
    runId: "run",
    severity: "P2",
    category: "functional_bug",
    title,
    route,
    tenant: "demo",
    role: "admin",
    steps: ["Observe screen"],
    expected: "Expected behavior",
    actual: "Actual behavior",
    consoleEvidence: [],
    networkEvidence: [],
    citationUrls: [],
    createdAt: "2026-05-12T00:00:00.000Z"
  };
}
