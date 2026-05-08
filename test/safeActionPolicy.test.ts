import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateAction } from "../src/types.js";
import { SafeActionPolicy } from "../src/policy/safeActionPolicy.js";

test("allows safe navigation", () => {
  const policy = new SafeActionPolicy({ runId: "run1", approvalMode: "block" });
  const decision = policy.decide(action({ kind: "navigate", label: "Dashboard", risk: "safe" }));
  assert.equal(decision.decision, "allow");
});

test("requires approval for destructive actions", () => {
  const policy = new SafeActionPolicy({ runId: "run1", approvalMode: "block" });
  const decision = policy.decide(action({ kind: "delete", label: "Delete customer", risk: "destructive" }));
  assert.equal(decision.decision, "approval_required");
});

test("denies external notification actions", () => {
  const policy = new SafeActionPolicy({ runId: "run1", approvalMode: "block" });
  const decision = policy.decide(action({ kind: "click", label: "Send email invite", risk: "safe" }));
  assert.equal(decision.decision, "deny");
});

test("skips terminal logout during exploratory runs", () => {
  const policy = new SafeActionPolicy({ runId: "run1", approvalMode: "block" });
  const decision = policy.decide(action({ kind: "logout", label: "Log out", risk: "safe" }));
  assert.equal(decision.decision, "approval_required");
});

test("requires approval before generic submit mutations", () => {
  const policy = new SafeActionPolicy({ runId: "run1", approvalMode: "block" });
  const decision = policy.decide(action({ kind: "submit", label: "Save", risk: "mutation" }));
  assert.equal(decision.decision, "approval_required");
});

function action(overrides: Partial<CandidateAction>): CandidateAction {
  return {
    id: "a1",
    kind: "click",
    label: "Click",
    description: "Click",
    risk: "safe",
    expectedResult: "Works",
    cleanupRequired: false,
    approvalRequired: false,
    source: "deterministic",
    ...overrides
  };
}
