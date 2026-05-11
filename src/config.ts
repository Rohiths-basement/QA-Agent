import dotenv from "dotenv";
import path from "node:path";
import type { AgentConfig } from "./types.js";
import { createRunId } from "./utils/time.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env", override: false });

export interface CliOptions {
  [key: string]: string | boolean | undefined;
}

export function readAgentConfig(options: CliOptions): AgentConfig {
  const resumeRunId = stringOption(options.resume);
  const runId = resumeRunId ?? stringOption(options["run-id"]) ?? createRunId();
  const artifactDir = path.resolve(stringOption(options["artifact-dir"]) ?? process.env.QA_ARTIFACT_DIR ?? "artifacts/runs");
  const storagePath = path.resolve(stringOption(options["storage-path"]) ?? process.env.QA_STORAGE_PATH ?? ".qa/qa-agent.sqlite");

  return {
    baseUrl: requiredString(options["base-url"] ?? process.env.UNIFIED_QA_BASE_URL, "Missing --base-url or UNIFIED_QA_BASE_URL"),
    wikiUrl: stringOption(options["wiki-url"]) ?? process.env.UNIFIED_QA_WIKI_URL ?? "https://wiki.unified-apps.com/",
    runId,
    ...(resumeRunId ? { resumeRunId } : {}),
    tenant: stringOption(options.tenant) ?? process.env.UNIFIED_QA_TENANT ?? "demo",
    role: stringOption(options.role) ?? process.env.UNIFIED_QA_ROLE ?? "admin",
    maxSteps: numberOption(options["max-steps"] ?? process.env.QA_SAFETY_STEP_LIMIT, 1000),
    headless: !booleanOption(options.headed),
    useStagehand: booleanOption(options.stagehand),
    approvalMode: booleanOption(options["allow-destructive"]) ? "allow_destructive" : "block",
    ...optional("vectorStoreId", stringOption(options["vector-store-id"]) ?? process.env.OPENAI_VECTOR_STORE_ID),
    ...optional("wikiJsonlPath", stringOption(options["wiki-jsonl"]) ?? process.env.QA_WIKI_JSONL ?? "data/wiki/articles.jsonl"),
    model: stringOption(options.model) ?? process.env.QA_ORACLE_MODEL ?? process.env.OPENROUTER_ORACLE_LIGHT_MODEL ?? "openai/gpt-5.1-chat",
    storagePath,
    artifactDir,
    ...optional("credentialsFile", stringOption(options["credentials-file"]) ?? process.env.QA_CREDENTIALS_FILE)
  };
}

export function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function booleanOption(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === "yes";
}

export function numberOption(value: unknown, fallback: number): number {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requiredString(value: unknown, message: string): string {
  const result = stringOption(value);
  if (!result) throw new Error(message);
  return result;
}

function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value ? { [key]: value } as Record<K, string> : {};
}
