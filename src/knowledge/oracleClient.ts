import OpenAI from "openai";
import type { OracleJudgment, RetrievedChunk, ScreenState } from "../types.js";

export interface OracleClientOptions {
  model: string;
  vectorStoreId?: string;
}

export class OracleClient {
  constructor(private readonly options: OracleClientOptions) {}

  async judge(screen: ScreenState, chunks: RetrievedChunk[]): Promise<OracleJudgment> {
    if (!process.env.OPENAI_API_KEY || !this.options.vectorStoreId) {
      return heuristicJudgment(chunks);
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = buildOraclePrompt(screen, chunks);
    const response = await (client as unknown as OpenAiResponsesApi).responses.create({
      model: this.options.model,
      input: prompt,
      tools: [
        {
          type: "file_search",
          vector_store_ids: [this.options.vectorStoreId],
          max_num_results: 8
        }
      ],
      include: ["file_search_call.results"]
    });

    const text = response.output_text ?? extractOutputText(response);
    return parseOracleJson(text, chunks);
  }
}

function heuristicJudgment(chunks: RetrievedChunk[]): OracleJudgment {
  return {
    summary: chunks.length
      ? "Heuristic oracle used because OpenAI file search is not configured. Related wiki context was retrieved locally."
      : "No wiki context was available for this screen.",
    expectedBehaviors: chunks.flatMap((chunk) => extractExpectedLines(chunk.text)).slice(0, 10),
    mismatches: [],
    citations: chunks.map((chunk) => ({ title: chunk.title, url: chunk.url }))
  };
}

function buildOraclePrompt(screen: ScreenState, chunks: RetrievedChunk[]): string {
  const localContext = chunks.map((chunk) => `# ${chunk.title}\nURL: ${chunk.url}\n${chunk.text.slice(0, 1_500)}`).join("\n\n");
  return [
    "You are a strict QA oracle for the Unified application.",
    "Compare the observed screen against the Unified wiki context.",
    "Return only JSON with keys: summary, expectedBehaviors, mismatches, citations.",
    "Mismatch objects must include category, severity, title, expected, actual, citationUrls.",
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
    "Locally retrieved wiki context:",
    localContext
  ].join("\n");
}

function parseOracleJson(text: string, chunks: RetrievedChunk[]): OracleJudgment {
  try {
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as OracleJudgment;
    return {
      summary: parsed.summary ?? "",
      expectedBehaviors: Array.isArray(parsed.expectedBehaviors) ? parsed.expectedBehaviors : [],
      mismatches: Array.isArray(parsed.mismatches) ? parsed.mismatches : [],
      citations: Array.isArray(parsed.citations) ? parsed.citations : chunks.map((chunk) => ({ title: chunk.title, url: chunk.url }))
    };
  } catch {
    return heuristicJudgment(chunks);
  }
}

function extractExpectedLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^[-*#\d. ]+/, "").trim())
    .filter((line) => /^(click|select|enter|open|create|edit|view|search|filter|the user|users can|you can)/i.test(line))
    .slice(0, 8);
}

function extractOutputText(response: unknown): string {
  const output = (response as { output?: Array<{ content?: Array<{ text?: string }> }> }).output ?? [];
  return output.flatMap((item) => item.content ?? []).map((content) => content.text ?? "").join("\n");
}

interface OpenAiResponsesApi {
  responses: {
    create(input: unknown): Promise<{
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    }>;
  };
}
