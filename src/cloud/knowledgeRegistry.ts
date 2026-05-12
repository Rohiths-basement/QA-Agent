import { readFile } from "node:fs/promises";
import type { ArticleRecord } from "../types.js";
import { sha256, shortHash } from "../utils/hash.js";

export interface KnowledgeChunk {
  id: string;
  articleId: string;
  url: string;
  title: string;
  heading?: string;
  product?: string;
  category?: string;
  text: string;
  contentHash: string;
}

export interface KnowledgeRegistry {
  articles: ArticleRecord[];
  chunks: KnowledgeChunk[];
  changedArticleIds: string[];
}

export async function buildKnowledgeRegistry(input: {
  jsonlPath: string;
  previousHashes?: Record<string, string>;
}): Promise<KnowledgeRegistry> {
  const articles = await readArticlesJsonl(input.jsonlPath);
  const chunks = articles.flatMap(chunkArticle);
  const changedArticleIds = articles
    .filter((article) => input.previousHashes?.[article.id] !== article.contentHash)
    .map((article) => article.id);
  return { articles, chunks, changedArticleIds };
}

export function chunkArticle(article: ArticleRecord): KnowledgeChunk[] {
  const sections = splitMarkdownSections(article.markdown || article.bodyText);
  if (!sections.length) {
    return [chunk(article, undefined, article.bodyText)];
  }
  return sections.map((section) => chunk(article, section.heading, section.text));
}

export function routeModuleHints(registry: KnowledgeRegistry): Record<string, string[]> {
  const hints: Record<string, Set<string>> = {};
  for (const article of registry.articles) {
    const candidates = [article.product, article.category, article.title].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      const routeLike = `/${candidate.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
      hints[routeLike] ??= new Set();
      hints[routeLike].add(article.id);
    }
  }
  return Object.fromEntries(Object.entries(hints).map(([route, ids]) => [route, [...ids].sort()]));
}

async function readArticlesJsonl(jsonlPath: string): Promise<ArticleRecord[]> {
  const body = await readFile(jsonlPath, "utf8");
  return body.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ArticleRecord);
}

function chunk(article: ArticleRecord, heading: string | undefined, text: string): KnowledgeChunk {
  const id = shortHash(`${article.id}:${heading ?? "body"}:${sha256(text)}`, 24);
  return {
    id,
    articleId: article.id,
    url: article.url,
    title: article.title,
    ...(heading ? { heading } : {}),
    ...(article.product ? { product: article.product } : {}),
    ...(article.category ? { category: article.category } : {}),
    text: text.trim(),
    contentHash: sha256(text)
  };
}

function splitMarkdownSections(markdown: string): Array<{ heading?: string; text: string }> {
  const lines = markdown.split(/\r?\n/);
  const sections: Array<{ heading?: string; text: string[] }> = [];
  let current: { heading?: string; text: string[] } = { text: [] };

  for (const line of lines) {
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (headingMatch) {
      if (current.text.join("\n").trim()) sections.push(current);
      current = { heading: headingMatch[2]?.trim() ?? "Untitled", text: [line] };
    } else {
      current.text.push(line);
    }
  }
  if (current.text.join("\n").trim()) sections.push(current);

  return sections.map((section) => ({
    ...(section.heading ? { heading: section.heading } : {}),
    text: section.text.join("\n").trim()
  })).filter((section) => section.text);
}
