import assert from "node:assert/strict";
import test from "node:test";
import { classifyPage } from "../src/planner/pageClassifier.js";
import { inferCandidateActions } from "../src/planner/actionInferer.js";

test("classifies auth pages", () => {
  assert.equal(classifyPage({
    url: "https://sso.unified-apps.com/login",
    title: "Login",
    visibleText: "Sign in with email and password",
    controls: [{ tag: "input", type: "password", label: "Password" }],
    forms: [{}],
    tables: []
  }), "auth");
});

test("classifies list pages from tables and search controls", () => {
  assert.equal(classifyPage({
    url: "https://app.example.com/customers",
    title: "Customers",
    visibleText: "Customers Search Filter",
    controls: [{ tag: "input", type: "search", label: "Search" }],
    forms: [],
    tables: [{}]
  }), "list");
});

test("classifies forms", () => {
  assert.equal(classifyPage({
    url: "https://app.example.com/customers/new",
    title: "New Customer",
    visibleText: "Create customer",
    controls: [{ tag: "button", label: "Save" }],
    forms: [{}],
    tables: []
  }), "form");
});

test("does not classify Additional Information as an add/create action", () => {
  const actions = inferCandidateActions({
    runId: "run1",
    url: "https://cloudpcr.unified-apps.com/epcr/create",
    routeKey: "route1",
    title: "Create ePCR",
    pageType: "form",
    visibleText: "Additional Information",
    textHash: "hash",
    controls: [{
      tag: "button",
      label: "Additional Information",
      type: "button",
      disabled: false,
      visible: true,
      selectorHint: "button"
    }],
    forms: [],
    tables: [],
    breadcrumbs: [],
    consoleEvents: [],
    networkEvents: [],
    capturedAt: "2026-05-08T00:00:00.000Z"
  }, "run1");
  assert.equal(actions[0]?.kind, "click");
});
