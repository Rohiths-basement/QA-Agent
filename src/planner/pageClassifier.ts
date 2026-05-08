import type { PageType, ScreenState } from "../types.js";

export interface PageSignals {
  url: string;
  title: string;
  visibleText: string;
  controls: Array<{ label: string; tag: string; type?: string; href?: string }>;
  forms: unknown[];
  tables: unknown[];
}

export function classifyPage(signals: PageSignals): PageType {
  const text = `${signals.url} ${signals.title} ${signals.visibleText}`.toLowerCase();
  const labels = signals.controls.map((control) => control.label.toLowerCase()).join(" ");

  if (/login|sign in|forgot password|password/.test(text) && signals.controls.some((control) => control.type === "password")) return "auth";
  if (/error|not found|unauthorized|forbidden|something went wrong/.test(text)) return "error";
  if (/settings|configuration|preferences/.test(text)) return "settings";
  if (/report|analytics|dashboard report|export/.test(text) && signals.tables.length > 0) return "report";
  if (/wizard|step \d|next|previous/.test(text) && /next|previous/.test(labels)) return "wizard";
  if (signals.forms.length > 0 && /save|submit|create|update|cancel/.test(labels)) return "form";
  if (signals.tables.length > 0 || /search|filter|sort/.test(labels)) return "list";
  if (/dashboard|overview|home/.test(text) || countNavigationControls(signals) >= 6) return "dashboard";
  if (/no records|no data|empty|nothing here/.test(text)) return "empty";
  if (/edit|details|view/.test(labels)) return "detail";
  return "unknown";
}

export function classifyScreen(screen: ScreenState): PageType {
  return classifyPage(screen);
}

function countNavigationControls(signals: PageSignals): number {
  return signals.controls.filter((control) => control.href || control.tag === "a").length;
}
