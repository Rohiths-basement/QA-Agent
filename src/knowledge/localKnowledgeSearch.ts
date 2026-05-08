import { readFile } from "node:fs/promises";
import type { ArticleRecord, RetrievedChunk } from "../types.js";
import type { KnowledgeSearch } from "./knowledgeSearch.js";

export class LocalKnowledgeSearch implements KnowledgeSearch {
  constructor(private readonly articles: ArticleRecord[]) {}

  static async fromJsonl(jsonlPath: string): Promise<LocalKnowledgeSearch> {
    const body = await readFile(jsonlPath, "utf8");
    const articles = body
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ArticleRecord);
    return new LocalKnowledgeSearch(articles);
  }

  async search(query: string, options: { maxResults?: number; product?: string; category?: string } = {}): Promise<RetrievedChunk[]> {
    const queryTokens = tokenize(query);
    const scored = this.articles
      .filter((article) => !options.product || article.product === options.product)
      .filter((article) => !options.category || article.category === options.category)
      .map((article) => scoreArticle(article, queryTokens))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, options.maxResults ?? 8);

    return scored.map(({ article, score }) => ({
      articleId: article.id,
      title: article.title,
      url: article.url,
      text: article.markdown.slice(0, 4_000),
      score,
      ...(article.product ? { product: article.product } : {}),
      ...(article.category ? { category: article.category } : {})
    }));
  }
}

function scoreArticle(article: ArticleRecord, queryTokens: string[]): { article: ArticleRecord; score: number } {
  const haystack = tokenize(`${article.title} ${article.product ?? ""} ${article.category ?? ""} ${article.headings.join(" ")} ${article.bodyText}`);
  const haystackSet = new Set(haystack);
  let score = 0;
  for (const token of queryTokens) {
    if (haystackSet.has(token)) score += token.length > 5 ? 2 : 1;
  }
  if (queryTokens.some((token) => article.title.toLowerCase().includes(token))) score += 5;
  if (article.workflowSteps.length) score += 1;
  return { article, score };
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .slice(0, 600);
}
