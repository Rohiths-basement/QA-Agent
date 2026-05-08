import path from "node:path";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import type { ArticleRecord, WikiManifest } from "../types.js";
import { appendJsonl, ensureDir, safeFileName, writeJson } from "../utils/fs.js";
import { sha256, shortHash } from "../utils/hash.js";
import { nowIso } from "../utils/time.js";

export interface CrawlWikiOptions {
  rootUrl: string;
  outDir: string;
  limit?: number;
  maxDepth?: number;
}

interface QueueItem {
  url: string;
  depth: number;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced"
});

export async function crawlWiki(options: CrawlWikiOptions): Promise<WikiManifest> {
  const root = new URL(options.rootUrl);
  const limit = options.limit ?? 1_000;
  const maxDepth = options.maxDepth ?? 8;
  const outDir = path.resolve(options.outDir);
  const markdownDir = path.join(outDir, "articles");
  const jsonlPath = path.join(outDir, "articles.jsonl");
  const seen = new Set<string>();
  const queue: QueueItem[] = [{ url: root.toString(), depth: 0 }];
  const articles: ArticleRecord[] = [];

  await ensureDir(markdownDir);

  while (queue.length > 0 && seen.size < limit) {
    const item = queue.shift();
    if (!item || item.depth > maxDepth || seen.has(item.url)) continue;
    seen.add(item.url);

    const html = await fetchHtml(item.url);
    if (!html) continue;

    const $ = cheerio.load(html);
    const links = discoverInternalLinks($, item.url, root.origin);
    for (const link of links) {
      if (!seen.has(link) && queue.length + seen.size < limit) queue.push({ url: link, depth: item.depth + 1 });
    }

    const article = extractArticle($, item.url);
    if (!article) continue;

    const fileName = `${safeFileName(article.title)}-${article.id}.md`;
    const filePath = path.join(markdownDir, fileName);
    const record: ArticleRecord = { ...article, filePath };
    await writeArticleMarkdown(filePath, record);
    articles.push(record);
  }

  articles.sort((a, b) => a.url.localeCompare(b.url));
  await appendJsonl(jsonlPath, articles);

  const manifestArticles = articles.map((article) => ({
    id: article.id,
    url: article.url,
    title: article.title,
    ...(article.product ? { product: article.product } : {}),
    ...(article.category ? { category: article.category } : {}),
    contentHash: article.contentHash,
    ...(article.filePath ? { filePath: article.filePath } : {})
  }));

  const manifest: WikiManifest = {
    rootUrl: root.toString(),
    crawledAt: nowIso(),
    articleCount: articles.length,
    jsonlPath,
    markdownDir,
    articles: manifestArticles
  };
  await writeJson(path.join(outDir, "manifest.json"), manifest);
  return manifest;
}

async function fetchHtml(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "UnifiedQAAgent/0.1 (+https://wiki.unified-apps.com/)"
      }
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("text/html")) return undefined;
    return await response.text();
  } catch {
    return undefined;
  }
}

function discoverInternalLinks($: cheerio.CheerioAPI, currentUrl: string, origin: string): string[] {
  const links = new Set<string>();
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    try {
      const next = new URL(href, currentUrl);
      next.hash = "";
      if (next.origin !== origin) return;
      if (/\.(png|jpg|jpeg|gif|svg|webp|pdf|zip|mp4|mov)$/i.test(next.pathname)) return;
      links.add(next.toString());
    } catch {
      // Ignore malformed links.
    }
  });
  return Array.from(links);
}

function extractArticle($: cheerio.CheerioAPI, url: string): ArticleRecord | undefined {
  const title = normalizeWhitespace($("h1").first().text() || $("title").first().text());
  const main = $("main").first().length ? $("main").first().clone() : $("article").first().length ? $("article").first().clone() : $("body").clone();
  main.find("script, style, nav, header, footer, aside, svg, noscript").remove();
  const bodyText = normalizeWhitespace(main.text());
  if (!title || bodyText.length < 250) return undefined;

  const markdown = normalizeMarkdown(turndown.turndown(main.html() ?? bodyText));
  if (markdown.length < 150) return undefined;

  const headings = main.find("h1, h2, h3")
    .map((_, element) => normalizeWhitespace($(element).text()))
    .get()
    .filter(Boolean);
  const workflowSteps = extractWorkflowSteps($, main);
  const terminology = extractTerminology(title, headings, bodyText);
  const { product, category } = inferProductAndCategory($, url);
  const updatedAt = inferUpdatedAt($, bodyText);

  const base: ArticleRecord = {
    id: shortHash(url, 16),
    url,
    title,
    headings,
    bodyText,
    markdown,
    workflowSteps,
    terminology,
    contentHash: sha256(markdown),
    crawledAt: nowIso()
  };

  return {
    ...base,
    ...(product ? { product } : {}),
    ...(category ? { category } : {}),
    ...(updatedAt ? { updatedAt } : {})
  };
}

function extractWorkflowSteps($: cheerio.CheerioAPI, main: cheerio.Cheerio<any>): string[] {
  const steps = new Set<string>();
  main.find("ol li, ul li").each((_, element) => {
    const text = normalizeWhitespace($(element).text());
    if (text.length >= 8 && text.length <= 220 && /^(click|select|enter|open|go to|navigate|choose|create|edit|save|submit|view|filter|search|download|upload)\b/i.test(text)) {
      steps.add(text);
    }
  });
  return Array.from(steps).slice(0, 40);
}

function extractTerminology(title: string, headings: string[], bodyText: string): string[] {
  const candidates = new Set<string>([title, ...headings].filter(Boolean));
  const phrases = bodyText.match(/\b[A-Z][A-Za-z0-9&/ -]{2,40}\b/g) ?? [];
  for (const phrase of phrases) {
    const normalized = normalizeWhitespace(phrase);
    if (normalized.length >= 3 && normalized.length <= 42 && !/^(The|This|That|When|Where|Users|Click|Select)$/.test(normalized)) {
      candidates.add(normalized);
    }
    if (candidates.size >= 80) break;
  }
  return Array.from(candidates).slice(0, 80);
}

function inferProductAndCategory($: cheerio.CheerioAPI, url: string): { product?: string; category?: string } {
  const parsed = new URL(url);
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  const breadcrumbs = $('[aria-label*="breadcrumb" i] a, .breadcrumb a, nav a')
    .map((_, element) => normalizeWhitespace($(element).text()))
    .get()
    .filter(Boolean);
  const product = breadcrumbs[0] ?? pathParts[0];
  const category = breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 1] : pathParts.length > 1 ? pathParts[pathParts.length - 2] : undefined;
  return {
    ...(product ? { product } : {}),
    ...(category && category !== product ? { category } : {})
  };
}

function inferUpdatedAt($: cheerio.CheerioAPI, bodyText: string): string | undefined {
  const timeDate = $("time[datetime]").first().attr("datetime");
  if (timeDate) return timeDate;
  const match = bodyText.match(/updated\s+(?:on\s+)?([A-Z][a-z]+ \d{1,2}, \d{4})/i);
  return match?.[1];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

async function writeArticleMarkdown(filePath: string, article: ArticleRecord): Promise<void> {
  const frontmatter = [
    "---",
    `id: ${article.id}`,
    `url: ${article.url}`,
    `title: ${JSON.stringify(article.title)}`,
    article.product ? `product: ${JSON.stringify(article.product)}` : undefined,
    article.category ? `category: ${JSON.stringify(article.category)}` : undefined,
    `contentHash: ${article.contentHash}`,
    `crawledAt: ${article.crawledAt}`,
    article.updatedAt ? `updatedAt: ${JSON.stringify(article.updatedAt)}` : undefined,
    "---"
  ].filter(Boolean).join("\n");
  await ensureDir(path.dirname(filePath));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, `${frontmatter}\n\n${article.markdown}\n`, "utf8");
}
