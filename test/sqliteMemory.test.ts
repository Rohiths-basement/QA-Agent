import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteMemory } from "../src/memory/sqliteMemory.js";

test("stores queued and visited routes for resumable runs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-db-"));
  const memory = new SqliteMemory(path.join(dir, "qa.sqlite"));
  try {
    memory.createRun({ runId: "run1", baseUrl: "https://example.com/login", tenant: "demo", role: "admin" });
    memory.queueRoute("run1", "route1", "https://example.com/a", "unknown", "hash");
    assert.equal(memory.nextQueuedRoute("run1")?.url, "https://example.com/a");
    memory.markRoute("run1", "route1", "validated");
    assert.equal(memory.nextQueuedRoute("run1"), undefined);
    assert.equal(memory.getRunSummary("run1").routesVisited, 1);
  } finally {
    memory.close();
  }
});
