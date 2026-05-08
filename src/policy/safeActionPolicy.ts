import type { ActionRisk, CandidateAction, PolicyDecision } from "../types.js";

export interface SafeActionPolicyOptions {
  runId: string;
  approvalMode: "block" | "allow_destructive";
}

const TENANT_WIDE_PATTERNS = [
  /billing/i,
  /subscription/i,
  /plan/i,
  /domain/i,
  /tenant/i,
  /company settings/i,
  /organization settings/i
];

const EXTERNAL_PATTERNS = [
  /invite/i,
  /email/i,
  /send/i,
  /notify/i,
  /sms/i,
  /webhook/i
];

const DESTRUCTIVE_PATTERNS = [
  /delete/i,
  /remove/i,
  /archive/i,
  /deactivate/i,
  /reset/i,
  /purge/i,
  /void/i,
  /cancel subscription/i
];

const MUTATION_PATTERNS = [
  /save/i,
  /submit/i,
  /create/i,
  /add/i,
  /edit/i,
  /update/i,
  /import/i,
  /upload/i,
  /approve/i,
  /reject/i
];

export class SafeActionPolicy {
  constructor(private readonly options: SafeActionPolicyOptions) {}

  decide(action: CandidateAction): PolicyDecision {
    const risk = classifyActionRisk(action);
    const normalizedAction = { ...action, risk };

    if (action.kind === "logout") {
      return {
        decision: "approval_required",
        reason: "Logout is a terminal action and is skipped during exploratory coverage runs.",
        action: normalizedAction
      };
    }

    if (risk === "external") {
      return {
        decision: "deny",
        reason: "External notification or invitation actions are blocked by default.",
        action: normalizedAction
      };
    }

    if (risk === "tenant_wide") {
      return {
        decision: this.options.approvalMode === "allow_destructive" ? "approval_required" : "deny",
        reason: "Tenant-wide settings, billing, or subscription actions require explicit approval.",
        action: normalizedAction
      };
    }

    if (risk === "destructive") {
      if (isRunCleanup(action, this.options.runId)) {
        return {
          decision: "allow",
          reason: "Cleanup is allowed for records created by this QA run.",
          action: normalizedAction
        };
      }
      return {
        decision: "approval_required",
        reason: "Destructive actions require an approval gate unless they clean up this run's own records.",
        action: normalizedAction
      };
    }

    if (risk === "mutation" && ["submit", "edit", "import"].includes(action.kind)) {
      return {
        decision: "approval_required",
        reason: "Submit/edit/import actions can change existing data and require an approval gate until record ownership is known.",
        action: normalizedAction
      };
    }

    if (risk === "mutation" && !mentionsRunTag(action, this.options.runId)) {
      return {
        decision: "allow",
        reason: "Sandbox mutation is allowed, but generated data must include the QA run tag before submission.",
        action: normalizedAction
      };
    }

    return {
      decision: "allow",
      reason: "Action is within the safe exploration policy.",
      action: normalizedAction
    };
  }
}

export function classifyActionRisk(action: CandidateAction): ActionRisk {
  const text = `${action.kind} ${action.label} ${action.description}`.trim();
  if (EXTERNAL_PATTERNS.some((pattern) => pattern.test(text))) return "external";
  if (TENANT_WIDE_PATTERNS.some((pattern) => pattern.test(text))) return "tenant_wide";
  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(text)) || action.kind === "delete") return "destructive";
  if (MUTATION_PATTERNS.some((pattern) => pattern.test(text)) || ["create", "edit", "submit", "import"].includes(action.kind)) {
    return "mutation";
  }
  return action.risk;
}

function mentionsRunTag(action: CandidateAction, runId: string): boolean {
  const tag = `qa_${runId}`;
  return `${action.label} ${action.description} ${action.inputValue ?? ""}`.includes(tag);
}

function isRunCleanup(action: CandidateAction, runId: string): boolean {
  return action.description.includes(`qa_${runId}`) && /cleanup|created by this run/i.test(action.description);
}
