import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkArticle, routeModuleHints } from "../src/cloud/knowledgeRegistry.js";
import type { ArticleRecord } from "../src/types.js";

describe("knowledge registry", () => {
  it("chunks articles by markdown headings", () => {
    const chunks = chunkArticle(article({
      markdown: "# CAD Map\nIntro\n\n## Workflow\n1. Open map\n2. Select incident"
    }));
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks.map((chunk) => chunk.heading), ["CAD Map", "Workflow"]);
    assert.ok(chunks.every((chunk) => chunk.contentHash.length > 0));
  });

  it("builds route-like module hints", () => {
    const hints = routeModuleHints({
      articles: [article({ product: "Crew Scheduling", id: "crew-1" })],
      chunks: [],
      changedArticleIds: []
    });
    assert.deepEqual(hints["/crew-scheduling"], ["crew-1"]);
  });
});

function article(overrides: Partial<ArticleRecord>): ArticleRecord {
  return {
    id: "cad-1",
    url: "https://wiki.unified-apps.com/cad",
    title: "CAD Map",
    headings: [],
    bodyText: "CAD map body",
    markdown: "CAD map body",
    workflowSteps: [],
    terminology: [],
    contentHash: "hash",
    crawledAt: "2026-05-12T00:00:00.000Z",
    ...overrides
  };
}
