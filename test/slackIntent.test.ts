import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { parseConversationalQaText, parseQaText, verifySlackRequest } from "../src/cloud/slack.js";

const context = {
  defaultTenant: "demo",
  defaultRole: "admin",
  requestedBy: "U123",
  slackChannel: "C123"
};

describe("Slack QA intent parsing", () => {
  it("parses full runs", () => {
    const intent = parseQaText("full demo admin 25", context);
    assert.equal(intent.kind, "run");
    if (intent.kind !== "run") return;
    assert.equal(intent.request.type, "full");
    assert.equal(intent.request.tenant, "demo");
    assert.equal(intent.request.role, "admin");
    assert.equal(intent.request.budgetUsd, 25);
    assert.equal(intent.request.actionPolicy, "sandbox_mutation");
  });

  it("parses targeted screen runs with seed URLs", () => {
    const intent = parseQaText("screen https://app.unified-apps.com/cad/map", context);
    assert.equal(intent.kind, "run");
    if (intent.kind !== "run") return;
    assert.equal(intent.request.type, "screen");
    assert.deepEqual(intent.request.seedUrls, ["https://app.unified-apps.com/cad/map"]);
    assert.equal(intent.request.actionPolicy, "read_only");
  });

  it("routes conversational QA asks", () => {
    const intent = parseConversationalQaText("hey bot, test the CAD map screen", context);
    assert.equal(intent.kind, "run");
    if (intent.kind !== "run") return;
    assert.equal(intent.request.type, "screen");
    assert.match(intent.request.prompt ?? "", /CAD map/);
  });

  it("parses PR-linked runs with budget", () => {
    const intent = parseQaText("pr https://github.com/Unified-Solutions-EMS/CAD/pull/123 budget $10", context);
    assert.equal(intent.kind, "pr");
    if (intent.kind !== "pr") return;
    assert.equal(intent.request.prUrl, "https://github.com/Unified-Solutions-EMS/CAD/pull/123");
    assert.equal(intent.request.type, "recent_change");
    assert.equal(intent.request.budgetUsd, 10);
    assert.equal(intent.request.actionPolicy, "read_only");
  });

  it("verifies Slack request signatures", () => {
    const signingSecret = "secret";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "command=%2Fqa&text=full";
    const signature = `v0=${crypto.createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
    assert.equal(verifySlackRequest({ signingSecret, timestamp, signature, rawBody }), true);
    assert.equal(verifySlackRequest({ signingSecret, timestamp, signature: "v0=bad", rawBody }), false);
  });
});
