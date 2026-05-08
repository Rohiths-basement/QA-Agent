import type { RetrievedChunk, ScreenState } from "../types.js";

export interface KnowledgeSearch {
  search(query: string, options?: { maxResults?: number; product?: string; category?: string }): Promise<RetrievedChunk[]>;
}

export function buildScreenQuery(screen: ScreenState): string {
  const controlLabels = screen.controls
    .map((control) => control.label)
    .filter(Boolean)
    .slice(0, 30)
    .join(" ");
  const tableHeaders = screen.tables.flatMap((table) => table.headers).slice(0, 30).join(" ");
  return [
    screen.title,
    screen.url,
    screen.pageType,
    screen.breadcrumbs.join(" "),
    controlLabels,
    tableHeaders,
    screen.visibleText.slice(0, 2_000)
  ].filter(Boolean).join("\n");
}
