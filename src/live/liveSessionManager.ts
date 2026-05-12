import path from "node:path";
import type { BrowserSession, CandidateAction, SessionObservation, TenantCredentialProfile } from "../types.js";
import { loadCredentialProfile } from "../credentials/credentials.js";
import { BrowserRuntime } from "../runtime/browserRuntime.js";
import { uploadArtifacts } from "../cloud/artifacts.js";
import { envBoolean, envNumber, envString } from "../cloud/env.js";
import { createRunId, nowIso } from "../utils/time.js";

const DEFAULT_BASE_URL = "https://sso.unified-apps.com/login";
const DEFAULT_ARTIFACT_DIR = "/tmp/qa-live/runs";

export interface StartSessionInput {
  tenant?: string;
  role?: string;
  seedUrl?: string;
  slackChannel?: string;
  slackThreadTs?: string;
}

export interface LiveActionInput {
  label?: string;
  selectorHint?: string;
  href?: string;
  inputValue?: string;
  instruction?: string;
  allowMutation?: boolean;
}

interface ManagedSession {
  metadata: BrowserSession;
  runtime: BrowserRuntime;
  lastObservation?: SessionObservation;
}

export class LiveSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();

  async start(input: StartSessionInput = {}): Promise<BrowserSession> {
    this.expireOldSessions();
    const sessionId = `live_${createRunId()}`;
    const tenant = input.tenant ?? envString("UNIFIED_QA_TENANT", "demo") ?? "demo";
    const role = input.role ?? envString("UNIFIED_QA_ROLE", "admin") ?? "admin";
    const artifactDir = path.resolve(envString("QA_LIVE_ARTIFACT_DIR", DEFAULT_ARTIFACT_DIR) ?? DEFAULT_ARTIFACT_DIR);
    const runtime = new BrowserRuntime({
      runId: sessionId,
      baseUrl: envString("UNIFIED_QA_BASE_URL", DEFAULT_BASE_URL) ?? DEFAULT_BASE_URL,
      artifactDir,
      headless: !envBoolean("QA_LIVE_HEADED", false),
      useStagehand: envBoolean("QA_LIVE_ENABLE_STAGEHAND", false),
      tenant,
      role
    });
    const metadata: BrowserSession = {
      sessionId,
      runId: sessionId,
      tenant,
      role,
      status: "starting",
      ...(input.slackChannel ? { slackChannel: input.slackChannel } : {}),
      ...(input.slackThreadTs ? { slackThreadTs: input.slackThreadTs } : {}),
      createdAt: nowIso(),
      expiresAt: expiryIso()
    };
    this.sessions.set(sessionId, { metadata, runtime });

    try {
      const credentials = await this.credentialsFor(tenant, role);
      await runtime.init();
      await runtime.login(credentials);
      if (input.seedUrl) await runtime.goto(input.seedUrl);
      metadata.status = "ready";
      if (input.seedUrl) metadata.currentUrl = input.seedUrl;
      return metadata;
    } catch (error) {
      metadata.status = "failed";
      metadata.error = error instanceof Error ? error.message : String(error);
      await runtime.close().catch(() => undefined);
      return metadata;
    }
  }

  async get(sessionId: string): Promise<BrowserSession | undefined> {
    this.expireOldSessions();
    return this.sessions.get(sessionId)?.metadata;
  }

  async observe(sessionId: string): Promise<SessionObservation> {
    const session = this.requireSession(sessionId);
    const screen = await session.runtime.observe();
    session.metadata.currentUrl = screen.url;
    session.metadata.lastObservationAt = screen.capturedAt;
    const observation: SessionObservation = {
      sessionId,
      screen,
      summary: summarizeScreen(screen)
    };
    const urls = await uploadArtifacts({ runId: session.metadata.runId, artifactDir: path.resolve(envString("QA_LIVE_ARTIFACT_DIR", DEFAULT_ARTIFACT_DIR) ?? DEFAULT_ARTIFACT_DIR) }).catch(() => []);
    const screenshotUrl = urls.find((url) => screen.screenshotPath && url.endsWith(path.basename(screen.screenshotPath)));
    if (screenshotUrl) observation.screenshotUrl = screenshotUrl;
    session.lastObservation = observation;
    return observation;
  }

  async act(sessionId: string, input: LiveActionInput): Promise<SessionObservation> {
    const session = this.requireSession(sessionId);
    const action = this.actionFor(session, input);
    if (!input.allowMutation && action.risk !== "safe") {
      throw new Error(`Action blocked by live-session policy: ${action.label} is ${action.risk}. Ask for an approval-gated QA job instead.`);
    }
    const result = await session.runtime.execute(action);
    if (!result.success) throw new Error(result.error ?? `Could not execute ${action.label}`);
    return this.observe(sessionId);
  }

  async close(sessionId: string): Promise<BrowserSession | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.metadata.status = "closed";
    await session.runtime.close().catch(() => undefined);
    this.sessions.delete(sessionId);
    return session.metadata;
  }

  private actionFor(session: ManagedSession, input: LiveActionInput): CandidateAction {
    const visibleControls = session.lastObservation?.screen.controls.filter((control) => control.visible && !control.disabled) ?? [];
    const matched = input.selectorHint || input.href
      ? undefined
      : visibleControls.find((control) => input.label && control.label.toLowerCase().includes(input.label.toLowerCase()));
    const label = input.label ?? matched?.label ?? input.instruction ?? input.href ?? input.selectorHint ?? "Live action";
    const href = input.href ?? matched?.href;
    const selectorHint = input.selectorHint ?? matched?.selectorHint;
    const kind = href ? "navigate" : input.inputValue ? "fill" : "click";
    const risk = riskForLabel(label);
    return {
      id: `live-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      kind,
      label,
      description: input.instruction ?? `Live session action: ${label}`,
      risk,
      ...(selectorHint ? { selectorHint } : {}),
      ...(href ? { href } : {}),
      ...(input.inputValue ? { inputValue: input.inputValue } : {}),
      expectedResult: "The requested screen state changes without console/runtime errors.",
      cleanupRequired: risk !== "safe",
      approvalRequired: risk !== "safe",
      source: "planner"
    };
  }

  private requireSession(sessionId: string): ManagedSession {
    this.expireOldSessions();
    const session = this.sessions.get(sessionId);
    if (!session || session.metadata.status !== "ready") throw new Error(`Live browser session ${sessionId} is not ready.`);
    return session;
  }

  private expireOldSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (new Date(session.metadata.expiresAt).getTime() > now) continue;
      session.metadata.status = "expired";
      session.runtime.close().catch(() => undefined);
      this.sessions.delete(sessionId);
    }
  }

  private async credentialsFor(tenant: string, role: string): Promise<TenantCredentialProfile> {
    const credentialsFile = envString("QA_CREDENTIALS_FILE");
    return loadCredentialProfile({
      tenant,
      role,
      ...(credentialsFile ? { credentialsFile } : {})
    });
  }
}

export const liveSessionManager = new LiveSessionManager();

function summarizeScreen(screen: SessionObservation["screen"]): string {
  const buttons = screen.controls
    .filter((control) => control.visible && !control.disabled && ["button", "a"].includes(control.tag))
    .map((control) => control.label)
    .filter(Boolean)
    .slice(0, 12);
  const inputs = screen.forms.flatMap((form) => form.inputs.map((input) => input.label || input.name || input.type || input.tag)).filter(Boolean).slice(0, 10);
  const tables = screen.tables.map((table) => `${table.headers.slice(0, 4).join(", ") || "table"} (${table.rowCount} rows)`).slice(0, 5);
  return [
    `URL: ${screen.url}`,
    `Title: ${screen.title || "(untitled)"}`,
    `Page type: ${screen.pageType}`,
    buttons.length ? `Buttons/links: ${buttons.join(", ")}` : undefined,
    inputs.length ? `Inputs: ${inputs.join(", ")}` : undefined,
    tables.length ? `Tables: ${tables.join("; ")}` : undefined,
    screen.consoleEvents.length ? `Console warnings/errors: ${screen.consoleEvents.length}` : undefined,
    screen.networkEvents.length ? `Failed/error network events: ${screen.networkEvents.length}` : undefined
  ].filter(Boolean).join("\n");
}

function riskForLabel(label: string): CandidateAction["risk"] {
  if (/\b(delete|remove|destroy|deactivate|disable|void|refund|cancel subscription|billing|invite|send|notify)\b/i.test(label)) return "destructive";
  if (/\b(save|create|submit|update|edit|import|upload)\b/i.test(label)) return "mutation";
  return "safe";
}

function expiryIso(): string {
  const ttlMinutes = envNumber("QA_LIVE_SESSION_TTL_MINUTES", 45);
  return new Date(Date.now() + ttlMinutes * 60_000).toISOString();
}
