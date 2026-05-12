import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type { QaJob, RunRequest } from "../types.js";
import { ensureDir } from "../utils/fs.js";
import { nowIso } from "../utils/time.js";
import { envString } from "./env.js";

const { Pool } = pg;

export interface JobStore {
  init(): Promise<void>;
  createJob(job: QaJob): Promise<void>;
  updateJob(jobId: string, patch: Partial<Omit<QaJob, "jobId" | "request" | "createdAt">>): Promise<void>;
  getJob(jobId: string): Promise<QaJob | undefined>;
}

export function createJobStore(): JobStore {
  const databaseUrl = envString("DATABASE_URL");
  if (databaseUrl) return new PostgresJobStore(databaseUrl);
  return new FileJobStore(envString("QA_JOB_STORE_PATH", "/tmp/qa-jobs.json") ?? "/tmp/qa-jobs.json");
}

export function newQueuedJob(jobId: string, request: RunRequest): QaJob {
  const now = nowIso();
  return {
    jobId,
    status: "queued",
    request,
    createdAt: now,
    updatedAt: now
  };
}

class PostgresJobStore implements JobStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS qa_jobs (
        job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        request_json JSONB NOT NULL,
        cloud_run_execution_id TEXT,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        report_urls_json JSONB,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS qa_jobs_status_idx ON qa_jobs(status)");
  }

  async createJob(job: QaJob): Promise<void> {
    await this.pool.query(`
      INSERT INTO qa_jobs (
        job_id, status, request_json, cloud_run_execution_id, started_at, completed_at,
        report_urls_json, error, created_at, updated_at
      )
      VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8, $9, $10)
      ON CONFLICT(job_id) DO NOTHING
    `, [
      job.jobId,
      job.status,
      JSON.stringify(job.request),
      job.cloudRunExecutionId ?? null,
      job.startedAt ?? null,
      job.completedAt ?? null,
      JSON.stringify(job.reportUrls ?? []),
      job.error ?? null,
      job.createdAt,
      job.updatedAt
    ]);
  }

  async updateJob(jobId: string, patch: Partial<Omit<QaJob, "jobId" | "request" | "createdAt">>): Promise<void> {
    const existing = await this.getJob(jobId);
    if (!existing) return;
    const updated = { ...existing, ...patch, updatedAt: nowIso() };
    await this.pool.query(`
      UPDATE qa_jobs
      SET status = $2,
          cloud_run_execution_id = $3,
          started_at = $4,
          completed_at = $5,
          report_urls_json = $6::jsonb,
          error = $7,
          updated_at = $8
      WHERE job_id = $1
    `, [
      updated.jobId,
      updated.status,
      updated.cloudRunExecutionId ?? null,
      updated.startedAt ?? null,
      updated.completedAt ?? null,
      JSON.stringify(updated.reportUrls ?? []),
      updated.error ?? null,
      updated.updatedAt
    ]);
  }

  async getJob(jobId: string): Promise<QaJob | undefined> {
    const result = await this.pool.query("SELECT * FROM qa_jobs WHERE job_id = $1", [jobId]);
    const row = result.rows[0] as DbJobRow | undefined;
    return row ? mapDbJob(row) : undefined;
  }
}

class FileJobStore implements JobStore {
  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    await this.readAll();
  }

  async createJob(job: QaJob): Promise<void> {
    const jobs = await this.readAll();
    if (!jobs[job.jobId]) {
      jobs[job.jobId] = job;
      await this.writeAll(jobs);
    }
  }

  async updateJob(jobId: string, patch: Partial<Omit<QaJob, "jobId" | "request" | "createdAt">>): Promise<void> {
    const jobs = await this.readAll();
    const existing = jobs[jobId];
    if (!existing) return;
    jobs[jobId] = { ...existing, ...patch, updatedAt: nowIso() };
    await this.writeAll(jobs);
  }

  async getJob(jobId: string): Promise<QaJob | undefined> {
    return (await this.readAll())[jobId];
  }

  private async readAll(): Promise<Record<string, QaJob>> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, QaJob>;
    } catch {
      return {};
    }
  }

  private async writeAll(jobs: Record<string, QaJob>): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    await writeFile(this.filePath, JSON.stringify(jobs, null, 2), "utf8");
  }
}

interface DbJobRow {
  job_id: string;
  status: QaJob["status"];
  request_json: RunRequest;
  cloud_run_execution_id: string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  report_urls_json: string[] | null;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapDbJob(row: DbJobRow): QaJob {
  return {
    jobId: row.job_id,
    status: row.status,
    request: row.request_json,
    ...(row.cloud_run_execution_id ? { cloudRunExecutionId: row.cloud_run_execution_id } : {}),
    ...(row.started_at ? { startedAt: iso(row.started_at) } : {}),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
    ...(row.report_urls_json?.length ? { reportUrls: row.report_urls_json } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
