import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  CandidateAction,
  ConsoleEvent,
  ControlDescriptor,
  FormDescriptor,
  NetworkEvent,
  ScreenState,
  TableDescriptor,
  TenantCredentialProfile
} from "../types.js";
import { classifyPage } from "../planner/pageClassifier.js";
import { ensureDir } from "../utils/fs.js";
import { sha256, shortHash } from "../utils/hash.js";
import { routeKeyForUrl } from "../utils/route.js";
import { nowIso } from "../utils/time.js";

export interface BrowserRuntimeOptions {
  runId: string;
  baseUrl: string;
  artifactDir: string;
  headless: boolean;
  useStagehand: boolean;
  tenant: string;
  role: string;
}

export interface ExecuteResult {
  success: boolean;
  beforeUrl: string;
  afterUrl: string;
  tracePath?: string;
  error?: string;
}

export class BrowserRuntime {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private stagehand?: StagehandLike;
  private traceActive = false;
  private readonly consoleEvents: ConsoleEvent[] = [];
  private readonly networkEvents: NetworkEvent[] = [];

  constructor(private readonly options: BrowserRuntimeOptions) {}

  async init(): Promise<void> {
    await ensureDir(this.runArtifactDir());
    if (this.options.useStagehand) {
      const initialized = await this.initStagehand();
      if (initialized) return;
    }

    this.browser = await chromium.launch({ headless: this.options.headless });
    const storageState = this.authStatePathIfExists();
    this.context = await this.browser.newContext({
      viewport: { width: 1440, height: 1000 },
      ...(storageState ? { storageState } : {})
    });
    this.page = await this.context.newPage();
    this.attachEventCapture(this.page);
    await this.startTracing();
  }

  async close(): Promise<void> {
    if (this.context && this.traceActive) {
      const tracePath = path.join(this.runArtifactDir(), "trace-final.zip");
      try {
        await this.context.tracing.stop({ path: tracePath });
      } catch {
        // Tracing may already be stopped after a failed browser session.
      }
      this.traceActive = false;
    }
    await this.stagehand?.close?.();
    await this.browser?.close();
  }

  async login(credentials: TenantCredentialProfile): Promise<void> {
    const page = this.requirePage();
    await page.goto(this.options.baseUrl, { waitUntil: "domcontentloaded" });

    const emailField = await firstUsableLocator(page, [
      () => page.getByLabel(/email|username/i),
      () => page.getByPlaceholder(/email|username/i),
      () => page.locator("input[type='email']"),
      () => page.locator("input[name*='email' i]"),
      () => page.locator("input[type='text']").first()
    ]);
    const passwordField = await firstUsableLocator(page, [
      () => page.getByLabel(/password/i),
      () => page.getByPlaceholder(/password/i),
      () => page.locator("input[type='password']")
    ]);

    if (!emailField || !passwordField) {
      const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
      const currentUrl = page.url();
      if (!/login|sign-in|signin/i.test(new URL(currentUrl).pathname) || !/sign in|email address|password/i.test(body)) {
        await ensureDir(path.dirname(this.authStatePath()));
        await this.context?.storageState({ path: this.authStatePath() });
        return;
      }
      throw new Error(`Could not find email/password fields on login page. URL: ${currentUrl}. Text: ${body.slice(0, 300)}`);
    }
    await emailField.fill(credentials.email);
    await passwordField.fill(credentials.password);

    const submit = await firstUsableLocator(page, [
      () => page.getByRole("button", { name: /sign in|log in|login|continue/i }),
      () => page.locator("button[type='submit']"),
      () => page.locator("input[type='submit']")
    ]);
    if (!submit) throw new Error("Could not find login submit button.");
    await Promise.allSettled([
      page.waitForLoadState("networkidle", { timeout: 20_000 }),
      submit.click()
    ]);

    await page.waitForTimeout(1_000);
    const currentUrl = page.url();
    if (/login|sign-in|signin/i.test(new URL(currentUrl).pathname)) {
      const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
      if (/invalid|incorrect|error|required/i.test(body)) throw new Error(`Login appears to have failed: ${body.slice(0, 300)}`);
    }

    await ensureDir(path.dirname(this.authStatePath()));
    await this.context?.storageState({ path: this.authStatePath() });
  }

  async goto(url: string): Promise<void> {
    const page = this.requirePage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  }

  async observe(): Promise<ScreenState> {
    const page = this.requirePage();
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await ensureDir(path.join(this.runArtifactDir(), "screenshots"));
    await ensureDir(path.join(this.runArtifactDir(), "dom"));

    const url = page.url();
    const title = await page.title().catch(() => "");
    const visibleText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
    const textHash = sha256(visibleText);
    const controls = await extractControls(page);
    const forms = await extractForms(page);
    const tables = await extractTables(page);
    const breadcrumbs = await extractBreadcrumbs(page);
    const pageType = classifyPage({ url, title, visibleText, controls, forms, tables });
    const routeKey = routeKeyForUrl(url);
    const basename = `${Date.now()}-${shortHash(`${url}:${textHash}`, 10)}`;
    const screenshotPath = path.join(this.runArtifactDir(), "screenshots", `${basename}.png`);
    const domSnapshotPath = path.join(this.runArtifactDir(), "dom", `${basename}.html`);

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    const dom = await page.content().catch(() => "");
    await writeFile(domSnapshotPath, dom, "utf8");

    const accessibilitySnapshot = await captureAccessibility(page);
    const consoleEvents = this.consoleEvents.splice(0);
    const networkEvents = this.networkEvents.splice(0);

    return {
      runId: this.options.runId,
      url,
      routeKey,
      title,
      pageType,
      visibleText,
      textHash,
      controls,
      forms,
      tables,
      breadcrumbs,
      ...(accessibilitySnapshot ? { accessibilitySnapshot } : {}),
      screenshotPath,
      domSnapshotPath,
      consoleEvents,
      networkEvents,
      capturedAt: nowIso()
    };
  }

  async stagehandObserve(instruction: string): Promise<unknown[]> {
    if (!this.stagehand) return [];
    const page = this.requirePage() as StagehandPageLike;
    if (!page.observe) return [];
    try {
      const result = await withTimeout(page.observe.call(page, instruction), 25_000, `Timed out during Stagehand observe: ${instruction}`);
      return Array.isArray(result) ? result : result ? [result] : [];
    } catch (error) {
      return [{
        type: "stagehand_observe_error",
        message: error instanceof Error ? error.message : String(error)
      }];
    }
  }

  async execute(action: CandidateAction): Promise<ExecuteResult> {
    const page = this.requirePage();
    const beforeUrl = page.url();
    const tracePath = await this.startTraceChunk(action);
    try {
      await withTimeout(this.executeInner(action), 25_000, `Timed out executing ${action.kind}: ${action.label}`);
      await this.stopTraceChunk(tracePath);
      return { success: true, beforeUrl, afterUrl: page.url(), ...(tracePath ? { tracePath } : {}) };
    } catch (error) {
      await this.stopTraceChunk(tracePath);
      return {
        success: false,
        beforeUrl,
        afterUrl: page.url(),
        ...(tracePath ? { tracePath } : {}),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async executeInner(action: CandidateAction): Promise<void> {
    const page = this.requirePage();
    if (action.href) {
      await page.goto(action.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
    } else if (action.kind === "search" || action.kind === "fill") {
      await this.fillActionTarget(action);
    } else if (action.selectorHint) {
      await page.locator(action.selectorHint).first().click({ timeout: 8_000 });
    } else if ((page as StagehandPageLike).act) {
      await withTimeout(
        (page as StagehandPageLike).act?.(action.description) ?? Promise.resolve(),
        25_000,
        `Timed out during Stagehand act: ${action.label}`
      );
    } else if (action.kind === "open_detail") {
      await page.locator("table tbody tr, [role='row']").nth(1).click({ timeout: 8_000 });
    } else {
      throw new Error("No executable target found.");
    }

    if (["create", "edit", "fill"].includes(action.kind)) {
      await this.fillSandboxData();
    }

    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(350);
  }

  private async fillActionTarget(action: CandidateAction): Promise<void> {
    const page = this.requirePage();
    const value = action.inputValue ?? `qa_${this.options.runId}`;
    const locator = action.selectorHint
      ? page.locator(action.selectorHint).first()
      : page.locator("input[type='search'], input[placeholder*='search' i], input[type='text'], textarea").first();
    await locator.fill(value, { timeout: 10_000 });
    if (action.kind === "search") await locator.press("Enter").catch(() => undefined);
  }

  private async fillSandboxData(): Promise<void> {
    const page = this.requirePage();
    const marker = `qa_${this.options.runId}`;
    const fields = page.locator("input:not([type='hidden']):not([type='password']):not([type='checkbox']):not([type='radio']), textarea");
    const count = Math.min(await fields.count().catch(() => 0), 8);
    for (let index = 0; index < count; index += 1) {
      const field = fields.nth(index);
      const value = await field.inputValue().catch(() => "");
      const type = await field.getAttribute("type").catch(() => "text");
      if (value || type === "email") continue;
      await field.fill(`${marker}_${index + 1}`, { timeout: 2_000 }).catch(() => undefined);
    }
  }

  private async initStagehand(): Promise<boolean> {
    try {
      const { Stagehand } = await import("@browserbasehq/stagehand");
      const StagehandCtor = Stagehand as unknown as new (params: Record<string, unknown>) => StagehandLike;
      const env = stagehandEnv();
      const userDataDir = path.resolve(".qa", "stagehand-user-data", `${this.options.tenant}-${this.options.role}`);
      await ensureDir(userDataDir);
      const stagehand = new StagehandCtor({
        env,
        ...(env === "BROWSERBASE" && process.env.BROWSERBASE_API_KEY ? { apiKey: process.env.BROWSERBASE_API_KEY } : {}),
        ...(env === "BROWSERBASE" && process.env.BROWSERBASE_PROJECT_ID ? { projectId: process.env.BROWSERBASE_PROJECT_ID } : {}),
        modelName: stagehandModelName(),
        ...optionalStagehandModelClientOptions(),
        verbose: 1,
        domSettleTimeoutMs: 10_000,
        enableCaching: true,
        localBrowserLaunchOptions: {
          headless: this.options.headless,
          viewport: { width: 1440, height: 1000 },
          userDataDir,
          preserveUserDataDir: true
        }
      });
      await stagehand.init();
      this.stagehand = stagehand;
      this.context = stagehand.context as unknown as BrowserContext;
      this.page = stagehand.page as unknown as Page;
      this.attachEventCapture(this.page);
      await this.startTracing();
      return true;
    } catch (error) {
      console.warn(`Stagehand initialization failed; falling back to Playwright only: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private attachEventCapture(page: Page): void {
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        this.consoleEvents.push({ type: message.type(), text: message.text() });
      }
    });
    page.on("requestfailed", (request) => {
      this.networkEvents.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        failureText: request.failure()?.errorText ?? "request failed"
      });
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        this.networkEvents.push({
          url: response.url(),
          method: response.request().method(),
          status: response.status(),
          resourceType: response.request().resourceType()
        });
      }
    });
  }

  private async startTracing(): Promise<void> {
    if (!this.context || this.traceActive) return;
    await this.context.tracing.start({ screenshots: true, snapshots: true, sources: false }).catch(() => undefined);
    this.traceActive = true;
  }

  private async startTraceChunk(action: CandidateAction): Promise<string | undefined> {
    if (!this.context || !this.traceActive) return undefined;
    await ensureDir(path.join(this.runArtifactDir(), "traces"));
    const tracePath = path.join(this.runArtifactDir(), "traces", `${Date.now()}-${action.id}.zip`);
    await this.context.tracing.startChunk({ title: `${action.kind}: ${action.label}` }).catch(() => undefined);
    return tracePath;
  }

  private async stopTraceChunk(tracePath: string | undefined): Promise<void> {
    if (!this.context || !tracePath) return;
    await this.context.tracing.stopChunk({ path: tracePath }).catch(() => undefined);
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("Browser runtime is not initialized.");
    return this.page;
  }

  private runArtifactDir(): string {
    return path.join(this.options.artifactDir, this.options.runId);
  }

  private authStatePath(): string {
    return path.resolve(".qa", "auth", `${this.options.tenant}-${this.options.role}.json`);
  }

  private authStatePathIfExists(): string | undefined {
    const authStatePath = this.authStatePath();
    return existsSync(authStatePath) ? authStatePath : undefined;
  }
}

async function firstUsableLocator(page: Page, factories: Array<() => ReturnType<Page["locator"]>>): Promise<ReturnType<Page["locator"]> | undefined> {
  for (const factory of factories) {
    const locator = factory().first();
    if (await locator.count().catch(() => 0)) return locator;
  }
  return undefined;
}

async function extractControls(page: Page): Promise<ControlDescriptor[]> {
  const raw = await page.$$eval("a, button, input, textarea, select, [role='button'], [role='link'], [role='menuitem']", (elements) => {
    const normalizeInPage = (value: string): string => value.replace(/\s+/g, " ").trim();
    const cssEscapeInPage = (value: string): string => {
      const escapeFn = (globalThis as unknown as { CSS?: { escape?: (input: string) => string } }).CSS?.escape;
      return escapeFn ? escapeFn(value) : value.replace(/["\\#.:,[\]>+~*]/g, "\\$&");
    };
    const cssAttrInPage = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const isVisibleInPage = (element: HTMLElement): boolean => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const selectorFor = (element: Element): string => {
      const html = element as HTMLElement;
      if (html.id) return `#${cssEscapeInPage(html.id)}`;
      const aria = html.getAttribute("aria-label");
      if (aria) return `${html.tagName.toLowerCase()}[aria-label="${cssAttrInPage(aria)}"]`;
      const name = html.getAttribute("name");
      if (name) return `${html.tagName.toLowerCase()}[name="${cssAttrInPage(name)}"]`;
      const text = normalizeInPage((html.innerText || html.getAttribute("value") || "").slice(0, 80));
      if (text && html.tagName.toLowerCase() === "button") return `button:has-text("${cssAttrInPage(text)}")`;
      return html.tagName.toLowerCase();
    };
    return elements.map((element) => {
      const html = element as HTMLElement;
      const input = element as HTMLInputElement;
      const label = normalizeInPage(
        html.getAttribute("aria-label") ||
          html.getAttribute("title") ||
          html.innerText ||
          input.placeholder ||
          input.value ||
          html.getAttribute("name") ||
          html.getAttribute("href") ||
          ""
      );
      return {
        tag: html.tagName.toLowerCase(),
        role: html.getAttribute("role") || undefined,
        type: input.type || undefined,
        label,
        name: html.getAttribute("name") || undefined,
        href: html instanceof HTMLAnchorElement ? html.href : undefined,
        selectorHint: selectorFor(element),
        disabled: Boolean((input as { disabled?: boolean }).disabled || html.getAttribute("aria-disabled") === "true"),
        visible: isVisibleInPage(html)
      };
    }).filter((control) => control.label || control.href);
  });
  return raw.map(cleanControl);
}

async function extractForms(page: Page): Promise<FormDescriptor[]> {
  const raw = await page.$$eval("form", (forms) => forms.map((form, index) => {
    const normalizeInPage = (value: string): string => value.replace(/\s+/g, " ").trim();
    const cssEscapeInPage = (value: string): string => {
      const escapeFn = (globalThis as unknown as { CSS?: { escape?: (input: string) => string } }).CSS?.escape;
      return escapeFn ? escapeFn(value) : value.replace(/["\\#.:,[\]>+~*]/g, "\\$&");
    };
    const cssAttrInPage = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const isVisibleInPage = (element: HTMLElement): boolean => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const labels = Array.from(form.querySelectorAll("label")).map((label) => normalizeInPage(label.textContent || "")).filter(Boolean);
    const inputs = Array.from(form.querySelectorAll("input, textarea, select")).map((input) => {
      const html = input as HTMLInputElement;
      return {
        tag: html.tagName.toLowerCase(),
        type: html.type || undefined,
        label: normalizeInPage(html.getAttribute("aria-label") || html.placeholder || html.name || ""),
        name: html.name || undefined,
        selectorHint: html.id ? `#${cssEscapeInPage(html.id)}` : html.name ? `${html.tagName.toLowerCase()}[name="${cssAttrInPage(html.name)}"]` : undefined,
        disabled: html.disabled,
        visible: isVisibleInPage(html)
      };
    });
    const buttons = Array.from(form.querySelectorAll("button, input[type='submit']")).map((button) => {
      const html = button as HTMLInputElement;
      return {
        tag: html.tagName.toLowerCase(),
        type: html.type || undefined,
        label: normalizeInPage(html.innerText || html.value || html.getAttribute("aria-label") || ""),
        selectorHint: html.id ? `#${cssEscapeInPage(html.id)}` : undefined,
        disabled: html.disabled,
        visible: isVisibleInPage(html)
      };
    });
    return {
      selectorHint: form.id ? `#${cssEscapeInPage(form.id)}` : `form:nth-of-type(${index + 1})`,
      labels,
      inputs,
      buttons
    };
  }));
  return raw.map((form) => ({
    selectorHint: form.selectorHint,
    labels: form.labels,
    inputs: form.inputs.map(cleanControl),
    buttons: form.buttons.map(cleanControl)
  }));
}

async function extractTables(page: Page): Promise<TableDescriptor[]> {
  return page.$$eval("table, [role='table'], [role='grid']", (tables) => tables.map((table, index) => {
    const normalizeInPage = (value: string): string => value.replace(/\s+/g, " ").trim();
    const cssEscapeInPage = (value: string): string => {
      const escapeFn = (globalThis as unknown as { CSS?: { escape?: (input: string) => string } }).CSS?.escape;
      return escapeFn ? escapeFn(value) : value.replace(/["\\#.:,[\]>+~*]/g, "\\$&");
    };
    const headers = Array.from(table.querySelectorAll("th, [role='columnheader']")).map((header) => normalizeInPage(header.textContent || "")).filter(Boolean);
    const rowCount = table.querySelectorAll("tbody tr, [role='row']").length;
    return {
      selectorHint: table.id ? `#${cssEscapeInPage(table.id)}` : `${table.tagName.toLowerCase()}:nth-of-type(${index + 1})`,
      headers,
      rowCount
    };
  }));
}

async function extractBreadcrumbs(page: Page): Promise<string[]> {
  return page.$$eval("[aria-label*='breadcrumb' i] a, .breadcrumb a, nav[aria-label*='breadcrumb' i] a", (items) =>
    items.map((item) => (item.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean)
  ).catch(() => []);
}

async function captureAccessibility(page: Page): Promise<unknown | undefined> {
  const body = page.locator("body");
  const ariaSnapshot = (body as unknown as { ariaSnapshot?: () => Promise<unknown> }).ariaSnapshot;
  if (ariaSnapshot) return ariaSnapshot.call(body).catch(() => undefined);
  const accessibility = (page as unknown as { accessibility?: { snapshot: () => Promise<unknown> } }).accessibility;
  return accessibility?.snapshot().catch(() => undefined);
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isVisible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
}

function cssEscape(value: string): string {
  const escapeFn = (globalThis as unknown as { CSS?: { escape?: (input: string) => string } }).CSS?.escape;
  return escapeFn ? escapeFn(value) : value.replace(/["\\#.:,[\]>+~*]/g, "\\$&");
}

function cssAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cleanControl(control: RawControl): ControlDescriptor {
  return {
    tag: control.tag,
    label: control.label,
    disabled: control.disabled,
    visible: control.visible,
    ...(control.role ? { role: control.role } : {}),
    ...(control.type ? { type: control.type } : {}),
    ...(control.name ? { name: control.name } : {}),
    ...(control.href ? { href: control.href } : {}),
    ...(control.selectorHint ? { selectorHint: control.selectorHint } : {})
  };
}

interface RawControl {
  tag: string;
  role?: string | undefined;
  type?: string | undefined;
  label: string;
  name?: string | undefined;
  href?: string | undefined;
  selectorHint?: string | undefined;
  disabled: boolean;
  visible: boolean;
}

interface StagehandLike {
  init(): Promise<unknown>;
  close?(): Promise<void>;
  page: unknown;
  context: unknown;
}

interface StagehandPageLike extends Page {
  observe?(instructionOrOptions?: unknown): Promise<unknown>;
  act?(instructionOrOptions: unknown): Promise<unknown>;
}

function stagehandEnv(): "LOCAL" | "BROWSERBASE" {
  return process.env.STAGEHAND_ENV === "BROWSERBASE" ? "BROWSERBASE" : "LOCAL";
}

function stagehandModelName(): string {
  if (process.env.STAGEHAND_MODEL_NAME) return process.env.STAGEHAND_MODEL_NAME;
  if (process.env.STAGEHAND_MODEL) return process.env.STAGEHAND_MODEL;
  return process.env.OPENROUTER_API_KEY ? "openai/openai/gpt-5.1-chat" : "openai/gpt-4.1-mini";
}

function optionalStagehandModelClientOptions(): Record<string, unknown> {
  if (process.env.OPENROUTER_API_KEY) {
    return {
      modelClientOptions: {
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"
      }
    };
  }
  if (process.env.OPENAI_API_KEY) return { modelClientOptions: { apiKey: process.env.OPENAI_API_KEY } };
  return {};
}
