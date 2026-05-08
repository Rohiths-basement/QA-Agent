import type { ActionKind, ActionRisk, CandidateAction, ControlDescriptor, ScreenState } from "../types.js";
import { shortHash } from "../utils/hash.js";
import { scopedUnifiedUrl } from "../utils/route.js";

export function inferCandidateActions(screen: ScreenState, runId: string): CandidateAction[] {
  const actions = new Map<string, CandidateAction>();

  for (const control of screen.controls) {
    if (!control.visible || control.disabled || !control.label) continue;
    if (control.href && !scopedUnifiedUrl(screen.url, control.href)) continue;
    const kind = inferActionKind(control, screen);
    if (kind === "noop") continue;
    const risk = inferRisk(kind, control.label);
    const action = buildAction(screen, control, kind, risk, runId);
    actions.set(action.id, action);
  }

  for (const table of screen.tables) {
    if (table.rowCount > 0) {
      const action = plannerAction(screen, "open_detail", `Open first row in ${table.headers[0] ?? "table"}`, "safe");
      actions.set(action.id, action);
    }
  }

  if (screen.pageType === "list" && !Array.from(actions.values()).some((action) => action.kind === "search")) {
    const action = plannerAction(screen, "search", `Search for qa_${runId}`, "safe");
    actions.set(action.id, action);
  }

  return Array.from(actions.values());
}

function buildAction(
  screen: ScreenState,
  control: ControlDescriptor,
  kind: ActionKind,
  risk: ActionRisk,
  runId: string
): CandidateAction {
  const label = control.label.trim();
  const cleanupRequired = risk === "mutation";
  const description = describeAction(kind, label, runId);
  const href = control.href ? scopedUnifiedUrl(screen.url, control.href) : undefined;
  return {
    id: shortHash(`${screen.routeKey}:${kind}:${label}:${control.selectorHint ?? control.href ?? ""}`, 20),
    kind,
    label,
    description,
    risk,
    ...(control.selectorHint ? { selectorHint: control.selectorHint } : {}),
    ...(href ? { href } : {}),
    ...(kind === "search" || kind === "fill" ? { inputValue: `qa_${runId}` } : {}),
    expectedResult: expectedResultFor(kind, label),
    cleanupRequired,
    approvalRequired: risk === "destructive" || risk === "tenant_wide" || risk === "external",
    source: "deterministic"
  };
}

function plannerAction(screen: ScreenState, kind: ActionKind, label: string, risk: ActionRisk): CandidateAction {
  return {
    id: shortHash(`${screen.routeKey}:${kind}:${label}`, 20),
    kind,
    label,
    description: label,
    risk,
    expectedResult: expectedResultFor(kind, label),
    cleanupRequired: risk === "mutation",
    approvalRequired: risk !== "safe" && risk !== "mutation",
    source: "planner"
  };
}

function inferActionKind(control: ControlDescriptor, screen: ScreenState): ActionKind {
  const label = control.label.toLowerCase();
  const tag = control.tag.toLowerCase();
  if (control.href) return "navigate";
  if (/log out|logout|sign out/.test(label)) return "logout";
  if (/delete|remove|archive/.test(label)) return "delete";
  if (/export|download/.test(label)) return "export";
  if (/import|upload/.test(label)) return "import";
  if (/cancel|back|close/.test(label)) return "cancel";
  if (/\bsearch\b/.test(label) || control.type === "search") return "search";
  if (/\bfilter\b/.test(label)) return "filter";
  if (/\bsort\b/.test(label)) return "sort";
  if (/\b(add|new|create)\b/.test(label)) return "create";
  if (/\b(edit|update)\b/.test(label)) return "edit";
  if (/\b(save|submit|continue|next)\b/.test(label)) return "submit";
  if (control.type === "submit" && /\b(sign in|log in|login|save|submit|create|update|continue|next)\b/.test(label)) return "submit";
  if (["input", "textarea", "select"].includes(tag)) return screen.pageType === "list" ? "search" : "fill";
  if (tag === "button" || control.role === "button") return "click";
  return "noop";
}

function inferRisk(kind: ActionKind, label: string): ActionRisk {
  const text = `${kind} ${label}`;
  if (/invite|send|email|notify|sms|webhook/i.test(text)) return "external";
  if (/billing|subscription|tenant|organization|company settings|domain/i.test(text)) return "tenant_wide";
  if (/delete|remove|archive|deactivate|reset|purge/i.test(text)) return "destructive";
  if (["create", "edit", "submit", "import", "fill"].includes(kind) || /save|add|update|upload/i.test(text)) return "mutation";
  return "safe";
}

function describeAction(kind: ActionKind, label: string, runId: string): string {
  if (["create", "edit", "submit", "fill", "search"].includes(kind)) {
    return `${kind} via "${label}" using sandbox marker qa_${runId}`;
  }
  return `${kind} via "${label}"`;
}

function expectedResultFor(kind: ActionKind, label: string): string {
  switch (kind) {
    case "navigate":
      return `Navigation target for "${label}" loads without errors.`;
    case "search":
      return "Search/filter updates the visible list or shows a valid empty state.";
    case "create":
    case "edit":
    case "submit":
      return "Form validates input and shows a clear success, validation, or next-step state.";
    case "delete":
      return "Destructive action is gated or limited to QA-created records.";
    default:
      return `Action "${label}" completes without console, network, or visual failures.`;
  }
}
