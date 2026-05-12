import crypto from "node:crypto";
import { envString } from "../cloud/env.js";

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

export interface GitHubPrRef extends GitHubRepoRef {
  number: number;
  url: string;
}

export function parseGitHubPrUrl(url: string): GitHubPrRef {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parsed.hostname !== "github.com" || parts.length < 4 || parts[2] !== "pull") {
    throw new Error(`Not a GitHub pull request URL: ${url}`);
  }
  const number = Number(parts[3]);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`Invalid pull request number in URL: ${url}`);
  return { owner: parts[0] ?? "", repo: parts[1] ?? "", number, url };
}

export class GitHubAppClient {
  private installationToken?: { token: string; expiresAt: number };

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = envString("GITHUB_TOKEN") ?? await this.getInstallationToken();
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${token}`,
        ...(options.headers ?? {})
      }
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GitHub API ${path} failed (${response.status}): ${body}`);
    }
    return await response.json() as T;
  }

  async getInstallationToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.installationToken && this.installationToken.expiresAt - now > 120) return this.installationToken.token;

    const installationId = required("GITHUB_APP_INSTALLATION_ID");
    const jwt = createAppJwt();
    const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${jwt}`
      }
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GitHub installation token request failed (${response.status}): ${body}`);
    }
    const json = await response.json() as { token: string; expires_at: string };
    this.installationToken = {
      token: json.token,
      expiresAt: Math.floor(new Date(json.expires_at).getTime() / 1000)
    };
    return json.token;
  }
}

export function githubConfigured(): boolean {
  return Boolean(envString("GITHUB_TOKEN") || (envString("GITHUB_APP_ID") && envString("GITHUB_APP_INSTALLATION_ID") && privateKey()));
}

function createAppJwt(): string {
  const appId = required("GITHUB_APP_ID");
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey(), "base64url");
  return `${header}.${payload}.${signature}`;
}

function privateKey(): string {
  const direct = envString("GITHUB_APP_PRIVATE_KEY");
  if (direct) return direct.replace(/\\n/g, "\n");
  const encoded = envString("GITHUB_APP_PRIVATE_KEY_BASE64");
  if (encoded) return Buffer.from(encoded, "base64").toString("utf8");
  return "";
}

function required(name: string): string {
  const value = envString(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
