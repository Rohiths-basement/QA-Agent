import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGitHubPrUrl } from "../src/github/githubApp.js";

describe("GitHub PR parsing", () => {
  it("parses GitHub pull request URLs", () => {
    const parsed = parseGitHubPrUrl("https://github.com/Unified-Solutions-EMS/CAD/pull/123");
    assert.equal(parsed.owner, "Unified-Solutions-EMS");
    assert.equal(parsed.repo, "CAD");
    assert.equal(parsed.number, 123);
  });

  it("rejects non-PR URLs", () => {
    assert.throws(() => parseGitHubPrUrl("https://github.com/Unified-Solutions-EMS/CAD/issues/123"), /Not a GitHub pull request URL/);
  });
});
