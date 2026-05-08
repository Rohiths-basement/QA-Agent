import type { CandidateAction, PolicyDecision, ScreenState } from "../types.js";
import { SafeActionPolicy } from "../policy/safeActionPolicy.js";
import { inferCandidateActions } from "./actionInferer.js";

export interface PlanDecision {
  action?: CandidateAction;
  policyDecisions: PolicyDecision[];
  skippedReason?: string;
}

const KIND_PRIORITY: Record<string, number> = {
  navigate: 100,
  search: 90,
  filter: 85,
  sort: 80,
  open_detail: 75,
  create: 70,
  edit: 60,
  submit: 55,
  export: 45,
  cancel: 30,
  logout: 5
};

export class Planner {
  constructor(private readonly policy: SafeActionPolicy, private readonly runId: string) {}

  chooseNextAction(screen: ScreenState, alreadyAttempted: Set<string>): PlanDecision {
    const candidates = inferCandidateActions(screen, this.runId)
      .filter((action) => !alreadyAttempted.has(action.id))
      .sort((a, b) => (KIND_PRIORITY[b.kind] ?? 10) - (KIND_PRIORITY[a.kind] ?? 10));
    const policyDecisions = candidates.map((action) => this.policy.decide(action));
    const allowed = policyDecisions.find((decision) => decision.decision === "allow");
    if (allowed) return { action: allowed.action, policyDecisions };
    const approval = policyDecisions.find((decision) => decision.decision === "approval_required");
    if (approval) {
      return {
        policyDecisions,
        skippedReason: `Approval required before ${approval.action.label}: ${approval.reason}`
      };
    }
    return {
      policyDecisions,
      skippedReason: candidates.length ? "All candidate actions were blocked by policy." : "No candidate actions found."
    };
  }
}
