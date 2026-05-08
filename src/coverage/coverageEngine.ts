import type { CandidateAction, PageType, ScreenState } from "../types.js";
import { SqliteMemory } from "../memory/sqliteMemory.js";
import { shortHash } from "../utils/hash.js";
import { routeKeyForUrl } from "../utils/route.js";

export class CoverageEngine {
  constructor(private readonly memory: SqliteMemory, private readonly runId: string) {}

  recordObservation(screen: ScreenState): void {
    this.memory.upsertRoute({
      runId: this.runId,
      routeKey: screen.routeKey,
      url: screen.url,
      pageType: screen.pageType,
      status: "visited",
      textHash: screen.textHash
    });
    this.memory.setLastRoute(this.runId, screen.routeKey);
  }

  markValidated(screen: ScreenState): void {
    this.memory.markRoute(this.runId, screen.routeKey, "validated");
  }

  queueDiscoveredUrl(url: string, pageType: PageType = "unknown", textHash = "unknown"): string {
    const routeKey = routeKeyForUrl(url);
    this.memory.queueRoute(this.runId, routeKey, url, pageType, textHash);
    return routeKey;
  }

  markRouteFailed(routeKey: string): void {
    this.memory.markRoute(this.runId, routeKey, "failed");
  }

  recordTransition(fromRoute: string, toRoute: string, action: CandidateAction): void {
    this.memory.recordTransition({
      id: shortHash(`${this.runId}:${fromRoute}:${toRoute}:${action.id}`, 24),
      runId: this.runId,
      fromRoute,
      toRoute,
      actionId: action.id,
      label: action.label
    });
  }

  nextQueuedUrl(): string | undefined {
    return this.memory.nextQueuedRoute(this.runId)?.url;
  }

  hasVisited(routeKey: string): boolean {
    const route = this.memory.getRoute(this.runId, routeKey);
    return Boolean(route && ["visited", "validated", "failed", "blocked", "skipped"].includes(route.status));
  }

  isExhausted(): boolean {
    return !this.memory.nextQueuedRoute(this.runId);
  }
}
