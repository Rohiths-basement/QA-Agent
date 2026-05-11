import OpenAI from "openai";
import type { FindingCategory, FindingSeverity, OracleJudgment, RetrievedChunk, ScreenState } from "../types.js";

export interface OracleClientOptions {
  model: string;
  vectorStoreId?: string;
}

interface OpenRouterUsageState {
  estimatedCostUsd: number;
}

const openRouterUsage: OpenRouterUsageState = { estimatedCostUsd: 0 };
type RetrievalMode = "local" | "openai_vector_store" | "local_plus_openai_vector_store" | "none";

export class OracleClient {
  constructor(private readonly options: OracleClientOptions) {}

  async judge(screen: ScreenState, chunks: RetrievedChunk[]): Promise<OracleJudgment> {
    const vectorChunks = await this.searchOpenAiVectorStore(screen).catch(() => []);
    const oracleChunks = mergeChunks(chunks, vectorChunks);
    const retrievalMode = retrievalModeFor(chunks.length, vectorChunks.length);

    if (!process.env.OPENROUTER_API_KEY) {
      return heuristicJudgment(oracleChunks, retrievalMode);
    }

    const selectedModel = selectOpenRouterModel(screen, oracleChunks, this.options.model);
    const prompt = buildOraclePrompt(screen, oracleChunks);
    const maxTokens = numberEnv("OPENROUTER_ORACLE_MAX_TOKENS", 1_200);
    const budgetUsd = numberEnv("OPENROUTER_MAX_RUN_COST_USD", 100);
    const preflightCostUsd = estimateCostUsd(selectedModel, estimateTokens(prompt), maxTokens);
    if (openRouterUsage.estimatedCostUsd + preflightCostUsd > budgetUsd) {
      return {
        ...heuristicJudgment(oracleChunks, retrievalMode),
        summary: "Heuristic oracle used because the configured OpenRouter budget guard would be exceeded.",
        modelProvider: "heuristic",
        model: selectedModel,
        usage: {
          promptTokens: estimateTokens(prompt),
          completionTokens: 0,
          estimatedCostUsd: 0,
          accumulatedCostUsd: openRouterUsage.estimatedCostUsd,
          budgetUsd
        }
      };
    }

    const response = await createOpenRouterChatCompletion(selectedModel, prompt, maxTokens);
    const text = response.text;
    const promptTokens = response.promptTokens ?? estimateTokens(prompt);
    const completionTokens = response.completionTokens ?? estimateTokens(text);
    const estimatedCostUsd = estimateCostUsd(selectedModel, promptTokens, completionTokens);
    openRouterUsage.estimatedCostUsd += estimatedCostUsd;

    return {
      ...parseOracleJson(text, oracleChunks, retrievalMode),
      modelProvider: "openrouter",
      model: selectedModel,
      retrievalMode,
      usage: {
        promptTokens,
        completionTokens,
        estimatedCostUsd,
        accumulatedCostUsd: openRouterUsage.estimatedCostUsd,
        budgetUsd
      }
    };
  }

  private async searchOpenAiVectorStore(screen: ScreenState): Promise<RetrievedChunk[]> {
    if (!process.env.OPENAI_API_KEY || !this.options.vectorStoreId) return [];
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const results = await client.vectorStores.search(this.options.vectorStoreId, {
      query: buildVectorSearchQuery(screen),
      max_num_results: numberEnv("OPENAI_VECTOR_SEARCH_MAX_RESULTS", 8),
      rewrite_query: true
    });
    const data = (results as unknown as { data?: OpenAiVectorSearchResult[] }).data ?? [];
    return data.map((result, index) => {
      const attributes = result.attributes ?? {};
      const title = typeof attributes.title === "string" && attributes.title ? attributes.title : result.filename;
      const url = typeof attributes.url === "string" && attributes.url ? attributes.url : `openai-vector-store:${result.file_id}`;
      return {
        articleId: typeof attributes.article_id === "string" && attributes.article_id ? attributes.article_id : result.file_id,
        title,
        url,
        text: result.content.map((content) => content.text).join("\n\n"),
        score: result.score || 1 / (index + 1),
        ...(typeof attributes.product === "string" && attributes.product ? { product: attributes.product } : {}),
        ...(typeof attributes.category === "string" && attributes.category ? { category: attributes.category } : {})
      };
    });
  }
}

function heuristicJudgment(chunks: RetrievedChunk[], retrievalMode: RetrievalMode): OracleJudgment {
  return {
    summary: chunks.length
      ? "Heuristic oracle used because OpenRouter model validation is not configured. Related wiki context was retrieved."
      : "No wiki context was available for this screen.",
    expectedBehaviors: chunks.flatMap((chunk) => extractExpectedLines(chunk.text)).slice(0, 10),
    mismatches: [],
    citations: chunks.map((chunk) => ({ title: chunk.title, url: chunk.url })),
    modelProvider: "heuristic",
    retrievalMode
  };
}

function buildOraclePrompt(screen: ScreenState, chunks: RetrievedChunk[]): string {
  const localContext = chunks.map((chunk) => `# ${chunk.title}\nURL: ${chunk.url}\n${chunk.text.slice(0, 1_500)}`).join("\n\n");
  return [
    "You are a strict QA oracle for the Unified application.",
    "Compare the observed screen against the retrieved Unified wiki context.",
    "Return only valid JSON with keys: summary, expectedBehaviors, mismatches, citations.",
    "Mismatch objects must include category, severity, title, expected, actual, citationUrls.",
    "Allowed categories: functional_bug, workflow_mismatch, wiki_product_mismatch, copy_text_issue, layout_display_issue, accessibility_issue, validation_issue, broken_navigation, auth_permission_issue, console_runtime_error, network_api_failure, data_persistence_issue, flaky_timeout_issue.",
    "Allowed severities: P0, P1, P2, P3.",
    "",
    "Observed screen:",
    JSON.stringify({
      url: screen.url,
      title: screen.title,
      pageType: screen.pageType,
      breadcrumbs: screen.breadcrumbs,
      controls: screen.controls.map((control) => control.label).slice(0, 80),
      forms: screen.forms.map((form) => form.labels).slice(0, 20),
      tables: screen.tables,
      visibleText: screen.visibleText.slice(0, 4_000),
      consoleErrors: screen.consoleEvents.filter((event) => event.type === "error").slice(0, 10),
      networkFailures: screen.networkEvents.filter((event) => event.failureText || (event.status && event.status >= 400)).slice(0, 10)
    }),
    "",
    "Retrieved wiki context:",
    localContext || "No retrieved wiki context."
  ].join("\n");
}

function buildVectorSearchQuery(screen: ScreenState): string {
  return [
    screen.title,
    screen.url,
    screen.pageType,
    screen.breadcrumbs.join(" > "),
    screen.controls.map((control) => control.label).filter(Boolean).slice(0, 30).join(", "),
    screen.forms.flatMap((form) => form.labels).slice(0, 20).join(", "),
    screen.visibleText.slice(0, 1_500)
  ].filter(Boolean).join("\n");
}

async function createOpenRouterChatCompletion(model: string, prompt: string, maxTokens: number): Promise<OpenRouterCompletionResult> {
  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER ?? "https://github.com/Rohiths-basement/QA-Agent",
      "X-Title": process.env.OPENROUTER_APP_TITLE ?? "Unified QA Agent"
    }
  });
  const input = {
    model,
    messages: [
      {
        role: "system" as const,
        content: "You are a product QA oracle. Be precise, evidence-backed, and conservative. Emit JSON only."
      },
      {
        role: "user" as const,
        content: prompt
      }
    ],
    temperature: 0.1,
    max_tokens: maxTokens,
    response_format: { type: "json_object" as const }
  };

  try {
    const response = await client.chat.completions.create(input);
    return completionResult(response);
  } catch (error) {
    if (!String(error instanceof Error ? error.message : error).toLowerCase().includes("response_format")) throw error;
    const { response_format: _responseFormat, ...inputWithoutResponseFormat } = input;
    const response = await client.chat.completions.create(inputWithoutResponseFormat);
    return completionResult(response);
  }
}

function completionResult(response: OpenAI.Chat.Completions.ChatCompletion): OpenRouterCompletionResult {
  const text = response.choices[0]?.message?.content ?? "";
  return {
    text,
    ...(response.usage?.prompt_tokens !== undefined ? { promptTokens: response.usage.prompt_tokens } : {}),
    ...(response.usage?.completion_tokens !== undefined ? { completionTokens: response.usage.completion_tokens } : {})
  };
}

function parseOracleJson(text: string, chunks: RetrievedChunk[], retrievalMode: RetrievalMode): OracleJudgment {
  try {
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Partial<OracleJudgment>;
    return {
      summary: parsed.summary ?? "",
      expectedBehaviors: Array.isArray(parsed.expectedBehaviors) ? parsed.expectedBehaviors.map(stringifyExpectedBehavior).filter(Boolean) : [],
      mismatches: sanitizeMismatches(parsed.mismatches),
      citations: Array.isArray(parsed.citations) ? sanitizeCitations(parsed.citations) : chunks.map((chunk) => ({ title: chunk.title, url: chunk.url })),
      retrievalMode
    };
  } catch {
    return heuristicJudgment(chunks, retrievalMode);
  }
}

function stringifyExpectedBehavior(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value ?? "");
  const raw = value as Record<string, unknown>;
  return String(raw.behavior ?? raw.expected ?? raw.description ?? raw.summary ?? JSON.stringify(raw));
}

function sanitizeMismatches(mismatches: unknown): OracleJudgment["mismatches"] {
  if (!Array.isArray(mismatches)) return [];
  return mismatches.map((mismatch) => {
    const raw = mismatch as Record<string, unknown>;
    return {
      category: isFindingCategory(raw.category) ? raw.category : "functional_bug",
      severity: isFindingSeverity(raw.severity) ? raw.severity : "P2",
      title: String(raw.title ?? "Oracle mismatch"),
      expected: String(raw.expected ?? ""),
      actual: String(raw.actual ?? ""),
      citationUrls: Array.isArray(raw.citationUrls) ? raw.citationUrls.map(String) : []
    };
  });
}

function sanitizeCitations(citations: unknown[]): OracleJudgment["citations"] {
  return citations.map((citation) => {
    const raw = citation as Record<string, unknown>;
    return {
      title: String(raw.title ?? raw.url ?? "Citation"),
      url: String(raw.url ?? "")
    };
  }).filter((citation) => citation.url);
}

function isFindingCategory(value: unknown): value is FindingCategory {
  return typeof value === "string" && [
    "functional_bug",
    "workflow_mismatch",
    "wiki_product_mismatch",
    "copy_text_issue",
    "layout_display_issue",
    "accessibility_issue",
    "validation_issue",
    "broken_navigation",
    "auth_permission_issue",
    "console_runtime_error",
    "network_api_failure",
    "data_persistence_issue",
    "flaky_timeout_issue"
  ].includes(value);
}

function isFindingSeverity(value: unknown): value is FindingSeverity {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

function extractExpectedLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^[-*#\d. ]+/, "").trim())
    .filter((line) => /^(click|select|enter|open|create|edit|view|search|filter|the user|users can|you can)/i.test(line))
    .slice(0, 8);
}

function mergeChunks(localChunks: RetrievedChunk[], vectorChunks: RetrievedChunk[]): RetrievedChunk[] {
  const seen = new Set<string>();
  const merged: RetrievedChunk[] = [];
  for (const chunk of [...vectorChunks, ...localChunks]) {
    const key = `${chunk.url}:${chunk.text.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(chunk);
  }
  return merged.slice(0, 12);
}

function retrievalModeFor(localCount: number, vectorCount: number): RetrievalMode {
  if (localCount && vectorCount) return "local_plus_openai_vector_store";
  if (vectorCount) return "openai_vector_store";
  if (localCount) return "local";
  return "none";
}

function selectOpenRouterModel(screen: ScreenState, chunks: RetrievedChunk[], fallbackModel: string): string {
  const routing = process.env.OPENROUTER_ORACLE_ROUTING ?? "auto";
  const lightModel = process.env.OPENROUTER_ORACLE_LIGHT_MODEL ?? fallbackModel;
  const heavyModel = process.env.OPENROUTER_ORACLE_HEAVY_MODEL ?? "openai/gpt-5.5";
  if (routing === "light") return lightModel;
  if (routing === "heavy") return heavyModel;
  if (routing && routing !== "auto") return routing;

  const complexScreen =
    screen.forms.length > 0 ||
    screen.tables.some((table) => table.rowCount > 5) ||
    screen.consoleEvents.some((event) => event.type === "error") ||
    screen.networkEvents.some((event) => event.failureText || (event.status && event.status >= 500)) ||
    screen.visibleText.length > 2_500;
  return complexScreen ? heavyModel : lightModel;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const heavy = model.includes("gpt-5.5");
  const inputPerMillion = numberEnv(
    heavy ? "OPENROUTER_HEAVY_INPUT_USD_PER_MILLION" : "OPENROUTER_LIGHT_INPUT_USD_PER_MILLION",
    heavy ? 5 : 1.25
  );
  const outputPerMillion = numberEnv(
    heavy ? "OPENROUTER_HEAVY_OUTPUT_USD_PER_MILLION" : "OPENROUTER_LIGHT_OUTPUT_USD_PER_MILLION",
    heavy ? 30 : 10
  );
  return (promptTokens / 1_000_000) * inputPerMillion + (completionTokens / 1_000_000) * outputPerMillion;
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

interface OpenAiVectorSearchResult {
  attributes: Record<string, string | number | boolean> | null;
  content: Array<{ text: string; type: "text" }>;
  file_id: string;
  filename: string;
  score: number;
}

interface OpenRouterCompletionResult {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
}
