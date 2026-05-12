import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeImpact, seedUrlsForImpact } from "../src/cloud/impactAnalyzer.js";

describe("impact analyzer", () => {
  it("maps recent-change prompts to targeted modules and routes", async () => {
    const plan = await analyzeImpact({
      type: "recent_change",
      tenant: "demo",
      role: "admin",
      prompt: "changed Crew Scheduling dashboard",
      actionPolicy: "read_only"
    });
    assert.equal(plan.runScope, "targeted");
    assert.ok(plan.modules.includes("Crew Scheduling"));
    assert.ok(plan.routes.some((route) => route.includes("schedule")));
    assert.ok(plan.confidence > 0.5);
  });

  it("extracts explicit URLs with high confidence", async () => {
    const plan = await analyzeImpact({
      type: "screen",
      tenant: "demo",
      role: "admin",
      prompt: "please test https://app.unified-apps.com/cad/map",
      actionPolicy: "read_only"
    });
    assert.equal(plan.runScope, "targeted");
    assert.equal(plan.confidence, 0.9);
    assert.ok(seedUrlsForImpact(plan, "https://sso.unified-apps.com/login").includes("https://app.unified-apps.com/cad/map"));
  });

  it("asks for clarification when a targeted request has no target", async () => {
    const plan = await analyzeImpact({
      type: "screen",
      tenant: "demo",
      role: "admin",
      actionPolicy: "read_only"
    });
    assert.equal(plan.runScope, "clarify");
    assert.ok(plan.missingInfo.length > 0);
  });
});
