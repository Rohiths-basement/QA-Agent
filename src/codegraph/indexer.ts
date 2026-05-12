import OpenAI from "openai";
import { GitHubAppClient } from "../github/githubApp.js";
import { envNumber, envString } from "../cloud/env.js";
import { CodeGraphStore } from "./codeGraphStore.js";

const DEFAULT_ORG = "Unified-Solutions-EMS";
const MAX_FILE_BYTES = 140_000;
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml",
  ".py", ".rb", ".go", ".java", ".kt", ".cs", ".php", ".css", ".scss", ".html",
  ".sql", ".graphql", ".gql", ".sh", ".toml"
]);

export interface CodeIndexResult {
  org: string;
  repos: number;
  files: number;
  chunks: number;
}

export async function indexUnifiedCodebase(input: {
  org?: string;
  limitRepos?: number;
  embed?: boolean;
} = {}): Promise<CodeIndexResult> {
  const org = input.org ?? envString("CODEGRAPH_ORG", DEFAULT_ORG) ?? DEFAULT_ORG;
  const github = new GitHubAppClient();
  const store = new CodeGraphStore();
  await store.init();
  const repos = await listRepos(github, org);
  const selectedRepos = repos.slice(0, input.limitRepos ?? envNumber("CODEGRAPH_MAX_REPOS", 100));
  let files = 0;
  let chunks = 0;

  for (const repo of selectedRepos) {
    await store.upsertRepo({
      owner: org,
      repo: repo.name,
      defaultBranch: repo.default_branch,
      visibility: repo.private ? "PRIVATE" : "PUBLIC",
      ...(repo.updated_at ? { updatedAt: repo.updated_at } : {})
    });
    const tree = await github.request<GitTreeResponse>(`/repos/${org}/${repo.name}/git/trees/${repo.default_branch}?recursive=1`);
    const blobs = tree.tree.filter((item) => item.type === "blob" && item.path && item.sha && shouldIndexPath(item.path, item.size));
    for (const blob of blobs) {
      const text = await fetchTextBlob(github, org, repo.name, blob.sha);
      if (!text) continue;
      files += 1;
      const chunkTexts = chunkText(text);
      for (const chunkTextValue of chunkTexts) {
        const embedding = input.embed === false ? undefined : await embedChunk(chunkTextValue).catch(() => undefined);
        await store.upsertChunk({
          repo: repo.name,
          path: blob.path,
          sha: blob.sha,
          language: languageForPath(blob.path),
          text: chunkTextValue,
          symbols: extractSymbols(chunkTextValue),
          routes: extractRoutes(chunkTextValue),
          modules: extractModules(repo.name, blob.path, chunkTextValue),
          ...(embedding ? { embedding } : {})
        });
        chunks += 1;
      }
    }
  }

  return { org, repos: selectedRepos.length, files, chunks };
}

async function listRepos(github: GitHubAppClient, org: string): Promise<GitRepo[]> {
  const repos: GitRepo[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await github.request<GitRepo[]>(`/orgs/${org}/repos?type=all&per_page=100&page=${page}`);
    repos.push(...batch.filter((repo) => !repo.archived));
    if (batch.length < 100) break;
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchTextBlob(github: GitHubAppClient, org: string, repo: string, sha: string): Promise<string | undefined> {
  const blob = await github.request<GitBlobResponse>(`/repos/${org}/${repo}/git/blobs/${sha}`);
  if (blob.encoding !== "base64") return undefined;
  const text = Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf8");
  if (text.includes("\u0000")) return undefined;
  return text;
}

async function embedChunk(text: string): Promise<number[] | undefined> {
  if (!process.env.OPENAI_API_KEY) return undefined;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.embeddings.create({
    model: envString("CODEGRAPH_EMBEDDING_MODEL", "text-embedding-3-small") ?? "text-embedding-3-small",
    input: text.slice(0, 7_500)
  });
  return response.data[0]?.embedding;
}

function shouldIndexPath(filePath: string, size?: number): boolean {
  if (size && size > MAX_FILE_BYTES) return false;
  if (/(\bnode_modules\b|\bdist\b|\bbuild\b|\bcoverage\b|\bvendor\b|\.png$|\.jpg$|\.jpeg$|\.gif$|\.pdf$|\.zip$)/i.test(filePath)) return false;
  const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";
  return TEXT_EXTENSIONS.has(ext) || /(^|\/)(Dockerfile|Makefile|Procfile)$/i.test(filePath);
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  const max = 5_500;
  for (let index = 0; index < text.length; index += max) {
    const chunk = text.slice(index, index + max).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks.slice(0, 20);
}

function languageForPath(filePath: string): string {
  const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase() : "text";
  return ext || "text";
}

function extractSymbols(text: string): string[] {
  const matches = Array.from(text.matchAll(/\b(?:function|class|interface|type|const|let|var|def)\s+([A-Za-z_][A-Za-z0-9_]*)/g), (match) => match[1] ?? "");
  return unique(matches.filter(Boolean)).slice(0, 50);
}

function extractRoutes(text: string): string[] {
  const matches = Array.from(text.matchAll(/["'`]((?:\/[A-Za-z0-9:_-]+){1,8})["'`]/g), (match) => match[1] ?? "");
  return unique(matches.filter((route) => !route.includes("//"))).slice(0, 50);
}

function extractModules(repo: string, filePath: string, text: string): string[] {
  const source = `${repo} ${filePath} ${text.slice(0, 500)}`.toLowerCase();
  const modules = [
    ["CAD", /\bcad\b|dispatch|incident|map/],
    ["Crew Scheduling", /crew|schedule|shift|roster/],
    ["CloudPCR", /cloudpcr|\bpcr\b|patient|chart/],
    ["Reports", /report|analytics|dashboard/],
    ["Fleet", /fleet|truck|vehicle/],
    ["Billing", /billing|invoice|subscription/],
    ["SSO", /\bsso\b|auth|login|tenant/]
  ].filter(([, pattern]) => (pattern as RegExp).test(source)).map(([module]) => module as string);
  return unique(modules);
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

interface GitRepo {
  name: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
  updated_at?: string;
}

interface GitTreeResponse {
  tree: Array<{
    path: string;
    type: string;
    sha: string;
    size?: number;
  }>;
}

interface GitBlobResponse {
  content: string;
  encoding: string;
}
