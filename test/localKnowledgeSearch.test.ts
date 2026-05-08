import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ArticleRecord } from "../src/types.js";
import { LocalKnowledgeSearch } from "../src/knowledge/localKnowledgeSearch.js";

test("retrieves related wiki records", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-kb-"));
  const jsonl = path.join(dir, "articles.jsonl");
  const records: ArticleRecord[] = [
    record("orders", "Orders", "Create and filter orders from the Orders screen."),
    record("inventory", "Inventory", "Adjust stock and view inventory reports.")
  ];
  await writeFile(jsonl, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  const search = await LocalKnowledgeSearch.fromJsonl(jsonl);
  const results = await search.search("How do I filter orders?", { maxResults: 1 });
  assert.equal(results[0]?.articleId, "orders");
});

function record(id: string, title: string, text: string): ArticleRecord {
  return {
    id,
    url: `https://wiki.example.com/${id}`,
    title,
    headings: [title],
    bodyText: text,
    markdown: text,
    workflowSteps: [],
    terminology: [title],
    contentHash: id,
    crawledAt: "2026-05-08T00:00:00.000Z"
  };
}
