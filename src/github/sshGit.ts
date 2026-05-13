import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { envString } from "../cloud/env.js";
import { sha256 } from "../utils/hash.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_UNIFIED_REPOS = [
  "Sales-leads-agent",
  "Drug-Tracking",
  "Crew-Scheduling",
  "sso",
  "cloudpcr",
  "account",
  "billing",
  "CheckSheets",
  "Truck-Checks",
  "HR",
  "Fleet-Management",
  "Fire",
  "reporting",
  "sso-client",
  "CAD",
  "Transport-Portal",
  "wiki",
  "intercom-widget"
];

export interface SshRepo {
  name: string;
  defaultBranch?: string;
  updatedAt?: string;
  localPath: string;
}

export interface SshPullDiff {
  title: string;
  filesChanged: string[];
  patchText: string;
}

export function sshGitConfigured(): boolean {
  const configuredHost = envString("GITHUB_SSH_HOST");
  return Boolean(
    envString("GITHUB_SSH_PRIVATE_KEY_BASE64") ||
      envString("GITHUB_SSH_PRIVATE_KEY") ||
      keyPathFromEnvOrDefault({ requireExists: true }) ||
      (envString("GITHUB_AUTH_MODE") === "ssh" && configuredHost && configuredHost !== "github.com")
  );
}

export async function withSshGit<T>(callback: (context: SshGitContext) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "qa-git-"));
  try {
    const keyPath = await materializeSshKey(tempDir);
    const host = envString("GITHUB_SSH_HOST", keyPath ? "github.com" : "github-client") ?? (keyPath ? "github.com" : "github-client");
    const org = envString("GITHUB_SSH_ORG", "Unified-Solutions-EMS") ?? "Unified-Solutions-EMS";
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...(keyPath ? { GIT_SSH_COMMAND: `ssh -i ${shellQuote(keyPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` } : {})
    };
    return await callback({
      tempDir,
      ...(keyPath ? { keyPath } : {}),
      host,
      org,
      env
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function cloneRepo(context: SshGitContext, repo: string): Promise<SshRepo> {
  const localPath = path.join(context.tempDir, repo);
  await execGit(["clone", "--depth", "1", repoSshUrl(context, repo), localPath], { env: context.env });
  const defaultBranch = await execGit(["-C", localPath, "branch", "--show-current"], { env: context.env }).catch(() => "");
  const updatedAt = await execGit(["-C", localPath, "log", "-1", "--format=%cI"], { env: context.env }).catch(() => undefined);
  return {
    name: repo,
    localPath,
    ...(defaultBranch.trim() ? { defaultBranch: defaultBranch.trim() } : {}),
    ...(updatedAt?.trim() ? { updatedAt: updatedAt.trim() } : {})
  };
}

export async function listRepoFiles(repoPath: string): Promise<string[]> {
  const output = await execGit(["-C", repoPath, "ls-files"]);
  return output.split("\n").map((item) => item.trim()).filter(Boolean);
}

export async function readRepoFile(repoPath: string, filePath: string): Promise<{ text: string; sha: string } | undefined> {
  const fullPath = path.join(repoPath, filePath);
  if (!existsSync(fullPath)) return undefined;
  const buffer = await readFile(fullPath);
  if (buffer.includes(0)) return undefined;
  const text = buffer.toString("utf8");
  return { text, sha: sha256(text) };
}

export async function pullRequestDiffViaSsh(input: {
  owner: string;
  repo: string;
  number: number;
}): Promise<SshPullDiff | undefined> {
  if (!sshGitConfigured()) return undefined;
  return withSshGit(async (context) => {
    const cloned = await cloneRepo({ ...context, org: input.owner }, input.repo);
    const branchName = `qa-pr-${input.number}`;
    await execGit(["-C", cloned.localPath, "fetch", "origin", `pull/${input.number}/head:${branchName}`, "--depth", "1"], { env: context.env });
    const filesChanged = (await execGit(["-C", cloned.localPath, "diff", "--name-only", "HEAD", branchName], { env: context.env }))
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    const patchText = await execGit(["-C", cloned.localPath, "diff", "--unified=20", "HEAD", branchName], {
      env: context.env,
      maxBuffer: 8 * 1024 * 1024
    }).catch(() => "");
    return {
      title: `PR #${input.number}`,
      filesChanged,
      patchText: patchText.slice(0, 40_000)
    };
  });
}

async function materializeSshKey(tempDir: string): Promise<string | undefined> {
  const direct = envString("GITHUB_SSH_PRIVATE_KEY");
  const encoded = envString("GITHUB_SSH_PRIVATE_KEY_BASE64");
  const configuredPath = keyPathFromEnvOrDefault({ requireExists: false });
  let key: string | undefined;
  if (direct) key = direct.replace(/\\n/g, "\n");
  else if (encoded) key = Buffer.from(encoded, "base64").toString("utf8");
  else if (configuredPath && existsSync(configuredPath)) key = await readFile(configuredPath, "utf8");
  if (!key) return undefined;
  const keyPath = path.join(tempDir, "github-client-key");
  await writeFile(keyPath, key, { mode: 0o600 });
  return keyPath;
}

function keyPathFromEnvOrDefault(options: { requireExists?: boolean } = {}): string | undefined {
  const configured = envString("GITHUB_SSH_PRIVATE_KEY_PATH");
  if (configured) {
    const resolved = resolveHome(configured);
    return !options.requireExists || existsSync(resolved) ? resolved : undefined;
  }
  const defaultPath = path.join(os.homedir(), ".ssh", "id_ed25519_client");
  return existsSync(defaultPath) ? defaultPath : undefined;
}

function repoSshUrl(context: SshGitContext, repo: string): string {
  return `git@${context.host}:${context.org}/${repo}.git`;
}

async function execGit(args: string[], options: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    env: options.env,
    maxBuffer: options.maxBuffer ?? 1024 * 1024
  });
  return stdout;
}

function resolveHome(value: string): string {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface SshGitContext {
  tempDir: string;
  keyPath?: string;
  host: string;
  org: string;
  env: NodeJS.ProcessEnv;
}
