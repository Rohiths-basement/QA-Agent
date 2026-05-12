import http from "node:http";
import { URL } from "node:url";
import { envNumber, envString } from "../cloud/env.js";
import { nowIso } from "../utils/time.js";
import { liveSessionManager, type LiveActionInput, type StartSessionInput } from "./liveSessionManager.js";

export async function startLiveApi(): Promise<void> {
  const port = envNumber("PORT", 8080);
  const server = http.createServer((req, res) => {
    handleLiveRequest(req, res).catch((error) => {
      console.error(error);
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`qa-live listening on :${port}`);
}

export async function handleLiveRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, service: "qa-live", checkedAt: nowIso() });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/sessions") {
    const body = await readJson<StartSessionInput>(req);
    sendJson(res, 200, await liveSessionManager.start(body));
    return;
  }

  const match = /^\/sessions\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const sessionId = decodeURIComponent(match[1] ?? "");
  const action = match[2];

  if (req.method === "GET" && !action) {
    const session = await liveSessionManager.get(sessionId);
    if (!session) sendJson(res, 404, { error: "Session not found" });
    else sendJson(res, 200, session);
    return;
  }
  if (req.method === "POST" && action === "observe") {
    sendJson(res, 200, await liveSessionManager.observe(sessionId));
    return;
  }
  if (req.method === "POST" && action === "act") {
    const body = await readJson<LiveActionInput>(req);
    sendJson(res, 200, await liveSessionManager.act(sessionId, body));
    return;
  }
  if (req.method === "DELETE" && !action) {
    const session = await liveSessionManager.close(sessionId);
    if (!session) sendJson(res, 404, { error: "Session not found" });
    else sendJson(res, 200, session);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const raw = await readRawBody(req);
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

async function readRawBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function authorized(req: http.IncomingMessage): boolean {
  const token = envString("QA_INTERNAL_TOKEN");
  if (!token) return true;
  const header = req.headers.authorization;
  return header === `Bearer ${token}`;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
