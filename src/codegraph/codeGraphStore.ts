import pg from "pg";
import type { CodeSearchResult } from "../types.js";
import { envString } from "../cloud/env.js";
import { shortHash } from "../utils/hash.js";

const { Pool } = pg;

export interface CodeChunkInput {
  repo: string;
  path: string;
  sha: string;
  language: string;
  text: string;
  symbols: string[];
  routes: string[];
  modules: string[];
  embedding?: number[];
}

export class CodeGraphStore {
  private readonly pool?: pg.Pool;
  private embeddingEnabled = false;

  constructor(databaseUrl = envString("DATABASE_URL")) {
    if (databaseUrl) this.pool = new Pool({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    if (!this.pool) return;
    await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector").then(() => {
      this.embeddingEnabled = true;
    }).catch(() => {
      this.embeddingEnabled = false;
    });
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS code_repos (
        repo TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        default_branch TEXT,
        visibility TEXT,
        updated_at TIMESTAMPTZ,
        indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS code_chunks (
        chunk_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        path TEXT NOT NULL,
        sha TEXT NOT NULL,
        language TEXT NOT NULL,
        text TEXT NOT NULL,
        symbols TEXT[] NOT NULL DEFAULT '{}',
        routes TEXT[] NOT NULL DEFAULT '{}',
        modules TEXT[] NOT NULL DEFAULT '{}',
        metadata_json JSONB NOT NULL DEFAULT '{}',
        search TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('simple', coalesce(repo, '')), 'A') ||
          setweight(to_tsvector('simple', coalesce(path, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(text, '')), 'B')
        ) STORED,
        indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    if (this.embeddingEnabled) {
      await this.pool.query("ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536)");
    }
    await this.pool.query("CREATE INDEX IF NOT EXISTS code_chunks_repo_idx ON code_chunks(repo)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS code_chunks_search_idx ON code_chunks USING GIN(search)");
  }

  async upsertRepo(input: {
    owner: string;
    repo: string;
    defaultBranch?: string;
    visibility?: string;
    updatedAt?: string;
  }): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(`
      INSERT INTO code_repos (repo, owner, default_branch, visibility, updated_at, indexed_at)
      VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT(repo) DO UPDATE SET
        owner = excluded.owner,
        default_branch = excluded.default_branch,
        visibility = excluded.visibility,
        updated_at = excluded.updated_at,
        indexed_at = now()
    `, [input.repo, input.owner, input.defaultBranch ?? null, input.visibility ?? null, input.updatedAt ?? null]);
  }

  async upsertChunk(input: CodeChunkInput): Promise<string> {
    if (!this.pool) return chunkId(input);
    const id = chunkId(input);
    await this.pool.query(`
      INSERT INTO code_chunks (chunk_id, repo, path, sha, language, text, symbols, routes, modules, metadata_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT(chunk_id) DO UPDATE SET
        sha = excluded.sha,
        language = excluded.language,
        text = excluded.text,
        symbols = excluded.symbols,
        routes = excluded.routes,
        modules = excluded.modules,
        metadata_json = excluded.metadata_json,
        indexed_at = now()
    `, [
      id,
      input.repo,
      input.path,
      input.sha,
      input.language,
      input.text,
      input.symbols,
      input.routes,
      input.modules,
      JSON.stringify({ textLength: input.text.length })
    ]);
    if (this.embeddingEnabled && input.embedding?.length) {
      await this.pool.query("UPDATE code_chunks SET embedding = $2 WHERE chunk_id = $1", [id, vectorLiteral(input.embedding)]);
    }
    return id;
  }

  async search(query: string, limit = 8): Promise<CodeSearchResult[]> {
    if (!this.pool) return [];
    const result = await this.pool.query(`
      SELECT repo, path, chunk_id, text, symbols, routes, modules,
        ts_rank(search, plainto_tsquery('english', $1)) AS score,
        metadata_json
      FROM code_chunks
      WHERE search @@ plainto_tsquery('english', $1)
         OR path ILIKE '%' || $1 || '%'
         OR repo ILIKE '%' || $1 || '%'
      ORDER BY score DESC, indexed_at DESC
      LIMIT $2
    `, [query, limit]);
    return result.rows.map((row) => ({
      repo: row.repo as string,
      path: row.path as string,
      chunkId: row.chunk_id as string,
      text: row.text as string,
      score: Number(row.score ?? 0),
      symbols: row.symbols as string[],
      routes: row.routes as string[],
      modules: row.modules as string[],
      metadata: row.metadata_json as Record<string, unknown>
    }));
  }
}

function chunkId(input: Pick<CodeChunkInput, "repo" | "path" | "sha" | "text">): string {
  return shortHash(`${input.repo}:${input.path}:${input.sha}:${input.text.slice(0, 80)}`, 24);
}

function vectorLiteral(values: number[]): string {
  return `[${values.map((value) => Number.isFinite(value) ? value.toFixed(8) : "0").join(",")}]`;
}
