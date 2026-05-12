import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyBudgetProfile, budgetProfileFor, parseBudgetUsd } from "../src/budget/budgetPolicy.js";

describe("budget policy", () => {
  it("parses budget hints from natural language", () => {
    assert.equal(parseBudgetUsd("test CAD map with a $5 budget"), 5);
    assert.equal(parseBudgetUsd("budget of $10 please"), 10);
    assert.equal(parseBudgetUsd("use 25 usd"), 25);
  });

  it("chooses cheaper bounded settings for micro budgets", () => {
    const profile = budgetProfileFor({ budgetUsd: 5, runType: "screen" });
    assert.equal(profile.tier, "micro");
    assert.equal(profile.allowStagehand, false);
    assert.equal(profile.allowHeavyModel, false);
    assert.equal(profile.maxSteps, 12);
  });

  it("allows deeper discovery for release budgets", () => {
    const profile = budgetProfileFor({ budgetUsd: 150, runType: "full" });
    assert.equal(profile.tier, "release");
    assert.equal(profile.allowStagehand, true);
    assert.equal(profile.allowHeavyModel, true);
    assert.equal(profile.maxSteps, 1200);
  });

  it("applies budget profile defaults onto run requests", () => {
    const request = applyBudgetProfile({
      type: "flow",
      tenant: "demo",
      role: "admin",
      prompt: "test scheduling budget $10",
      actionPolicy: "read_only"
    });
    assert.equal(request.budgetUsd, 10);
    assert.equal(request.budgetProfile?.tier, "standard");
    assert.equal(request.maxDepth, 2);
  });
});
