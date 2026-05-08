import { shortHash } from "./hash.js";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const HEX_RE = /\b[0-9a-f]{16,}\b/gi;
const NUMERIC_ID_RE = /\/\d+(?=\/|$)/g;

export function normalizeRoute(url: string): string {
  const parsed = new URL(url);
  const normalizedPath = parsed.pathname
    .replace(UUID_RE, ":uuid")
    .replace(HEX_RE, ":hex")
    .replace(NUMERIC_ID_RE, "/:id")
    .replace(/\/+$/, "") || "/";
  const queryKeys = Array.from(parsed.searchParams.keys()).sort();
  const queryPart = queryKeys.length ? `?${queryKeys.map((key) => `${key}=:value`).join("&")}` : "";
  return `${parsed.origin}${normalizedPath}${queryPart}`;
}

export function routeKeyForUrl(url: string): string {
  return shortHash(normalizeRoute(url), 16);
}

export function routeFingerprint(url: string, textHash: string): string {
  return shortHash(`${normalizeRoute(url)}:${textHash}`, 16);
}

export function scopedUnifiedUrl(baseUrl: string, href: string): string | undefined {
  try {
    const next = new URL(href, baseUrl);
    if (!isUnifiedQaAppHost(next.hostname)) return undefined;
    next.hash = "";
    return next.toString();
  } catch {
    return undefined;
  }
}

export function isUnifiedQaAppHost(hostname: string): boolean {
  return hostname !== "wiki.unified-apps.com" &&
    (hostname === "unified-apps.com" || hostname.endsWith(".unified-apps.com"));
}
