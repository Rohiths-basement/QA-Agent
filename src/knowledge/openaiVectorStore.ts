import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import type { WikiManifest } from "../types.js";
import { ensureDir, readJson, writeJson } from "../utils/fs.js";
import { sha256 } from "../utils/hash.js";

export interface UploadVectorStoreOptions {
  manifestPath: string;
  vectorStoreName?: string;
  vectorStoreId?: string;
  batchSize?: number;
  consolidated?: boolean;
}

export interface UploadVectorStoreResult {
  vectorStoreId: string;
  uploadedFiles: number;
  mappingPath: string;
}

export async function uploadWikiToOpenAiVectorStore(options: UploadVectorStoreOptions): Promise<UploadVectorStoreResult> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required to upload a vector store.");
  const manifest = await readJson<WikiManifest>(options.manifestPath);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const api = client as unknown as OpenAiVectorStoreApi;
  const vectorStoreId = options.vectorStoreId ?? (await api.vectorStores.create({
    name: options.vectorStoreName ?? `Unified Wiki ${new Date().toISOString()}`,
    metadata: {
      source: "wiki.unified-apps.com",
      article_count: String(manifest.articleCount)
    }
  })).id;

  if (options.consolidated) {
    return uploadConsolidatedWikiBundle({ api, manifest, manifestPath: options.manifestPath, vectorStoreId });
  }

  const mapping: Array<{ articleId: string; fileId: string; vectorStoreFileId?: string; path: string; url: string }> = [];
  const batchSize = options.batchSize ?? 20;

  for (let index = 0; index < manifest.articles.length; index += batchSize) {
    const batch = manifest.articles.slice(index, index + batchSize);
    for (const article of batch) {
      if (!article.filePath) continue;
      const bytes = await readFile(article.filePath);
      const file = await toFile(bytes, path.basename(article.filePath), { type: "text/markdown" });
      const uploaded = await api.files.create({ file, purpose: "assistants" });
      const attributes = {
        article_id: article.id,
        url: article.url,
        title: article.title.slice(0, 512),
        product: article.product ?? "",
        category: article.category ?? "",
        content_hash: article.contentHash
      };
      const attached = api.vectorStores.files.createAndPoll
        ? await api.vectorStores.files.createAndPoll(vectorStoreId, { file_id: uploaded.id, attributes })
        : await api.vectorStores.files.create(vectorStoreId, { file_id: uploaded.id, attributes });
      mapping.push({
        articleId: article.id,
        fileId: uploaded.id,
        ...(attached?.id ? { vectorStoreFileId: attached.id } : {}),
        path: article.filePath,
        url: article.url
      });
    }
  }

  const mappingPath = path.join(path.dirname(options.manifestPath), "openai-vector-store.json");
  await writeJson(mappingPath, { vectorStoreId, uploadedAt: new Date().toISOString(), files: mapping });
  return { vectorStoreId, uploadedFiles: mapping.length, mappingPath };
}

async function uploadConsolidatedWikiBundle(input: {
  api: OpenAiVectorStoreApi;
  manifest: WikiManifest;
  manifestPath: string;
  vectorStoreId: string;
}): Promise<UploadVectorStoreResult> {
  const bundlePath = path.join(path.dirname(input.manifestPath), "openai-vector-store-bundle.md");
  await ensureDir(path.dirname(bundlePath));
  const sections: string[] = [];
  for (const article of input.manifest.articles) {
    if (!article.filePath) continue;
    const markdown = await readFile(article.filePath, "utf8").catch(() => "");
    if (!markdown) continue;
    sections.push([
      `# ${article.title}`,
      `URL: ${article.url}`,
      `Article ID: ${article.id}`,
      article.product ? `Product: ${article.product}` : undefined,
      article.category ? `Category: ${article.category}` : undefined,
      "",
      markdown
    ].filter((line) => line !== undefined).join("\n"));
  }
  const bundle = sections.join("\n\n---\n\n");
  await writeFile(bundlePath, bundle, "utf8");
  const file = await toFile(Buffer.from(bundle, "utf8"), path.basename(bundlePath), { type: "text/markdown" });
  const uploaded = await input.api.files.create({ file, purpose: "assistants" });
  const attributes = {
    source: "wiki.unified-apps.com",
    article_count: String(input.manifest.articleCount),
    content_hash: sha256(bundle)
  };
  const attached = input.api.vectorStores.files.createAndPoll
    ? await input.api.vectorStores.files.createAndPoll(input.vectorStoreId, { file_id: uploaded.id, attributes })
    : await input.api.vectorStores.files.create(input.vectorStoreId, { file_id: uploaded.id, attributes });

  const mappingPath = path.join(path.dirname(input.manifestPath), "openai-vector-store.json");
  await writeJson(mappingPath, {
    vectorStoreId: input.vectorStoreId,
    uploadMode: "consolidated",
    uploadedAt: new Date().toISOString(),
    files: [{
      articleId: "consolidated-wiki-bundle",
      fileId: uploaded.id,
      ...(attached?.id ? { vectorStoreFileId: attached.id } : {}),
      path: bundlePath,
      url: input.manifest.rootUrl
    }]
  });
  return { vectorStoreId: input.vectorStoreId, uploadedFiles: 1, mappingPath };
}

interface OpenAiVectorStoreApi {
  files: {
    create(input: { file: unknown; purpose: string }): Promise<{ id: string }>;
  };
  vectorStores: {
    create(input: {
      name: string;
      metadata?: Record<string, string>;
    }): Promise<{ id: string }>;
    files: {
      create(vectorStoreId: string, input: { file_id: string; attributes?: Record<string, string> }): Promise<{ id?: string }>;
      createAndPoll?: (vectorStoreId: string, input: { file_id: string; attributes?: Record<string, string> }) => Promise<{ id?: string }>;
    };
  };
}
