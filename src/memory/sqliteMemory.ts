import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ActionRisk, Finding, PageType, RouteStatus } from "../types.js";
import { nowIso } from "../utils/time.js";

export interface RouteRow {
  runId: string;
  routeKey: string;
  url: string;
  pageType: PageType;
  status: RouteStatus;
  textHash: string;
  visitCount: number;
  firstSeen: string;
  lastSeen: string;
}

export interface ActionRow {
  id: string;
  runId: string;
  routeKey: string;
  kind: string;
  label: string;
  risk: ActionRisk;
  status: "queued" | "executed" | "blocked" | "failed" | "skipped";
  reason: string;
  createdAt: string;
  completedAt?: string;
}

export interface CreateRunInput {
  runId: string;
  baseUrl: string;
  tenant: string;
  role: string;
  metadata?: Record<string, unknown>;
}

export class SqliteMemory {
  private readonly db: DatabaseSync;

  constructor(readonly dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  createRun(input: CreateRunInput): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO runs (id, status, base_url, tenant, role, started_at, metadata_json)
      VALUES (?, 'running', ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.baseUrl,
      input.tenant,
      input.role,
      nowIso(),
      JSON.stringify(input.metadata ?? {})
    );
  }

  markRunStatus(runId: string, status: "running" | "completed" | "failed" | "incomplete"): void {
    const completedAt = status === "running" ? null : nowIso();
    this.db.prepare("UPDATE runs SET status = ?, completed_at = ? WHERE id = ?").run(status, completedAt, runId);
  }

  setLastRoute(runId: string, routeKey: string): void {
    this.db.prepare("UPDATE runs SET last_route = ? WHERE id = ?").run(routeKey, runId);
  }

  upsertRoute(input: {
    runId: string;
    routeKey: string;
    url: string;
    pageType: PageType;
    status: RouteStatus;
    textHash: string;
  }): void {
    const seenAt = nowIso();
    this.db.prepare(`
      INSERT INTO routes (run_id, route_key, url, page_type, status, text_hash, first_seen, last_seen, visit_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, route_key) DO UPDATE SET
        url = excluded.url,
        page_type = excluded.page_type,
        status = excluded.status,
        text_hash = excluded.text_hash,
        last_seen = excluded.last_seen,
        visit_count = routes.visit_count + CASE WHEN excluded.status IN ('visited', 'validated') THEN 1 ELSE 0 END
    `).run(
      input.runId,
      input.routeKey,
      input.url,
      input.pageType,
      input.status,
      input.textHash,
      seenAt,
      seenAt,
      input.status === "visited" || input.status === "validated" ? 1 : 0
    );
  }

  queueRoute(runId: string, routeKey: string, url: string, pageType: PageType, textHash: string): void {
    const existing = this.getRoute(runId, routeKey);
    if (existing && existing.status !== "discovered" && existing.status !== "queued") return;
    this.upsertRoute({ runId, routeKey, url, pageType, status: "queued", textHash });
  }

  markRoute(runId: string, routeKey: string, status: RouteStatus): void {
    this.db.prepare("UPDATE routes SET status = ?, last_seen = ? WHERE run_id = ? AND route_key = ?")
      .run(status, nowIso(), runId, routeKey);
  }

  getRoute(runId: string, routeKey: string): RouteRow | undefined {
    const row = this.db.prepare("SELECT * FROM routes WHERE run_id = ? AND route_key = ?").get(runId, routeKey);
    return row ? mapRouteRow(row as unknown as DbRouteRow) : undefined;
  }

  nextQueuedRoute(runId: string): RouteRow | undefined {
    const row = this.db.prepare(`
      SELECT * FROM routes
      WHERE run_id = ? AND status IN ('queued', 'discovered')
      ORDER BY first_seen ASC
      LIMIT 1
    `).get(runId);
    return row ? mapRouteRow(row as unknown as DbRouteRow) : undefined;
  }

  listRoutes(runId: string): RouteRow[] {
    return this.db.prepare("SELECT * FROM routes WHERE run_id = ? ORDER BY first_seen ASC")
      .all(runId)
      .map((row) => mapRouteRow(row as unknown as DbRouteRow));
  }

  recordTransition(input: {
    id: string;
    runId: string;
    fromRoute: string;
    toRoute: string;
    actionId: string;
    label: string;
  }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO transitions (id, run_id, from_route, to_route, action_id, label, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.runId, input.fromRoute, input.toRoute, input.actionId, input.label, nowIso());
  }

  recordAction(input: {
    id: string;
    runId: string;
    routeKey: string;
    kind: string;
    label: string;
    risk: ActionRisk;
    status: ActionRow["status"];
    reason?: string;
  }): void {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO actions (id, run_id, route_key, kind, label, risk, status, reason, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        reason = excluded.reason,
        completed_at = excluded.completed_at
    `).run(
      input.id,
      input.runId,
      input.routeKey,
      input.kind,
      input.label,
      input.risk,
      input.status,
      input.reason ?? "",
      now,
      input.status === "queued" ? null : now
    );
  }

  listActions(runId: string): ActionRow[] {
    return this.db.prepare("SELECT * FROM actions WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId)
      .map((row) => mapActionRow(row as unknown as DbActionRow));
  }

  recordEvidence(input: {
    id: string;
    runId: string;
    routeKey: string;
    type: string;
    path?: string;
    data?: unknown;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO evidence (id, run_id, route_key, type, path, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.runId,
      input.routeKey,
      input.type,
      input.path ?? null,
      JSON.stringify(input.data ?? null),
      nowIso()
    );
  }

  recordFinding(finding: Finding): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO findings (
        id, run_id, severity, category, title, route, tenant, role,
        steps_json, expected, actual, screenshot_path, trace_path,
        console_json, network_json, citations_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      finding.id,
      finding.runId,
      finding.severity,
      finding.category,
      finding.title,
      finding.route,
      finding.tenant,
      finding.role,
      JSON.stringify(finding.steps),
      finding.expected,
      finding.actual,
      finding.screenshotPath ?? null,
      finding.tracePath ?? null,
      JSON.stringify(finding.consoleEvidence),
      JSON.stringify(finding.networkEvidence),
      JSON.stringify(finding.citationUrls),
      finding.createdAt
    );
  }

  listFindings(runId: string): Finding[] {
    return this.db.prepare("SELECT * FROM findings WHERE run_id = ? ORDER BY severity ASC, created_at ASC")
      .all(runId)
      .map((row) => mapFindingRow(row as unknown as DbFindingRow));
  }

  recordCreatedRecord(input: {
    id: string;
    runId: string;
    routeKey: string;
    label: string;
    cleanupAction: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO created_records (id, run_id, route_key, label, cleanup_action, cleaned_up, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(input.id, input.runId, input.routeKey, input.label, input.cleanupAction, nowIso());
  }

  getRunSummary(runId: string): {
    runId: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    routesVisited: number;
    routesQueued: number;
    actionsAttempted: number;
    findings: number;
  } {
    const run = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as DbRunRow | undefined;
    if (!run) throw new Error(`Run not found: ${runId}`);
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('visited', 'validated') THEN 1 ELSE 0 END) AS routes_visited,
        SUM(CASE WHEN status IN ('queued', 'discovered') THEN 1 ELSE 0 END) AS routes_queued
      FROM routes WHERE run_id = ?
    `).get(runId) as { routes_visited: number | null; routes_queued: number | null };
    const actions = this.db.prepare("SELECT COUNT(*) AS count FROM actions WHERE run_id = ? AND status != 'queued'")
      .get(runId) as { count: number };
    const findings = this.db.prepare("SELECT COUNT(*) AS count FROM findings WHERE run_id = ?")
      .get(runId) as { count: number };
    const summary = {
      runId,
      status: run.status,
      startedAt: run.started_at,
      routesVisited: counts.routes_visited ?? 0,
      routesQueued: counts.routes_queued ?? 0,
      actionsAttempted: actions.count,
      findings: findings.count
    };
    return run.completed_at ? { ...summary, completedAt: run.completed_at } : summary;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        base_url TEXT NOT NULL,
        tenant TEXT NOT NULL,
        role TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        last_route TEXT,
        metadata_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS routes (
        run_id TEXT NOT NULL,
        route_key TEXT NOT NULL,
        url TEXT NOT NULL,
        page_type TEXT NOT NULL,
        status TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, route_key),
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS transitions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        from_route TEXT NOT NULL,
        to_route TEXT NOT NULL,
        action_id TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        route_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        route_key TEXT NOT NULL,
        type TEXT NOT NULL,
        path TEXT,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        route TEXT NOT NULL,
        tenant TEXT NOT NULL,
        role TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        expected TEXT NOT NULL,
        actual TEXT NOT NULL,
        screenshot_path TEXT,
        trace_path TEXT,
        console_json TEXT NOT NULL,
        network_json TEXT NOT NULL,
        citations_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS created_records (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        route_key TEXT NOT NULL,
        label TEXT NOT NULL,
        cleanup_action TEXT NOT NULL,
        cleaned_up INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );
    `);
  }
}

interface DbRunRow {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
}

interface DbRouteRow {
  run_id: string;
  route_key: string;
  url: string;
  page_type: PageType;
  status: RouteStatus;
  text_hash: string;
  visit_count: number;
  first_seen: string;
  last_seen: string;
}

interface DbActionRow {
  id: string;
  run_id: string;
  route_key: string;
  kind: string;
  label: string;
  risk: ActionRisk;
  status: ActionRow["status"];
  reason: string;
  created_at: string;
  completed_at: string | null;
}

interface DbFindingRow {
  id: string;
  run_id: string;
  severity: Finding["severity"];
  category: Finding["category"];
  title: string;
  route: string;
  tenant: string;
  role: string;
  steps_json: string;
  expected: string;
  actual: string;
  screenshot_path: string | null;
  trace_path: string | null;
  console_json: string;
  network_json: string;
  citations_json: string;
  created_at: string;
}

function mapRouteRow(row: DbRouteRow): RouteRow {
  return {
    runId: row.run_id,
    routeKey: row.route_key,
    url: row.url,
    pageType: row.page_type,
    status: row.status,
    textHash: row.text_hash,
    visitCount: row.visit_count,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen
  };
}

function mapActionRow(row: DbActionRow): ActionRow {
  const base = {
    id: row.id,
    runId: row.run_id,
    routeKey: row.route_key,
    kind: row.kind,
    label: row.label,
    risk: row.risk,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at
  };
  return row.completed_at ? { ...base, completedAt: row.completed_at } : base;
}

function mapFindingRow(row: DbFindingRow): Finding {
  const base = {
    id: row.id,
    runId: row.run_id,
    severity: row.severity,
    category: row.category,
    title: row.title,
    route: row.route,
    tenant: row.tenant,
    role: row.role,
    steps: JSON.parse(row.steps_json) as string[],
    expected: row.expected,
    actual: row.actual,
    consoleEvidence: JSON.parse(row.console_json) as Finding["consoleEvidence"],
    networkEvidence: JSON.parse(row.network_json) as Finding["networkEvidence"],
    citationUrls: JSON.parse(row.citations_json) as string[],
    createdAt: row.created_at
  };
  return {
    ...base,
    ...(row.screenshot_path ? { screenshotPath: row.screenshot_path } : {}),
    ...(row.trace_path ? { tracePath: row.trace_path } : {})
  };
}
