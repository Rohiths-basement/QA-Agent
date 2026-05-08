import assert from "node:assert/strict";
import test from "node:test";
import { routeKeyForUrl, scopedUnifiedUrl } from "../src/utils/route.js";

test("route keys ignore page text hash and volatile numeric ids", () => {
  assert.equal(
    routeKeyForUrl("https://app.unified-apps.com/customers/123?tab=details"),
    routeKeyForUrl("https://app.unified-apps.com/customers/456?tab=details")
  );
});

test("scoped url allows Unified subdomains and rejects unrelated hosts", () => {
  assert.equal(
    scopedUnifiedUrl("https://sso.unified-apps.com/dashboard", "https://crewscheduling-staging.unified-apps.com/dashboard"),
    "https://crewscheduling-staging.unified-apps.com/dashboard"
  );
  assert.equal(scopedUnifiedUrl("https://sso.unified-apps.com/dashboard", "https://example.com/"), undefined);
  assert.equal(scopedUnifiedUrl("https://sso.unified-apps.com/dashboard", "https://wiki.unified-apps.com/"), undefined);
  assert.equal(scopedUnifiedUrl("https://about.google/products", "/company-info/"), undefined);
});
