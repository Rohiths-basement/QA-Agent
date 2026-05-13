# Unified Hermes QA Agent One-Pager

## What It Is

The Unified Hermes QA Agent is an always-on Slack QA teammate. Hermes handles the conversational Slack experience, while this repo exposes the production QA tools Hermes can call: PR impact analysis, targeted/full QA runs, live browser observation/actions, code graph search, budget planning, job status, and report lookup.

## What It Does

- Answers Slack questions conversationally instead of only supporting slash commands.
- Starts interactive browser sessions so you can ask: “what is on the screen?” or “click Search and tell me what changed.”
- Runs full, targeted, screen, flow, and PR-linked QA jobs on GCP.
- Reads PR links, maps changed files to modules/routes, and runs only impacted QA scope when confidence is high.
- Uses the Unified wiki as product context, OpenAI vector stores for wiki retrieval, and Cloud SQL + pgvector for code graph search.
- Applies budget-aware model selection: small budgets use deterministic Playwright and the light OpenRouter model; larger budgets permit Stagehand discovery and heavy-model reasoning.
- Stores findings, routes, screenshots, traces, reports, and job state in Cloud SQL/GCS.

## How It Works

```text
Slack DM / mention
  -> Hermes gateway on GCE via Slack Socket Mode
  -> Hermes reasoning + memory
  -> QA MCP tools exposed by qa-api Cloud Run
  -> qa-worker Cloud Run Job for long QA runs
  -> qa-live Cloud Run service for interactive browser sessions
  -> Cloud SQL / GCS / OpenAI vector store / OpenRouter
  -> Hermes replies in Slack with status, observations, and report links
```

## How To Prompt It In Slack

Examples:

```text
@QA Agent test the CAD map screen with a $5 budget.
@QA Agent here is the PR: https://github.com/Unified-Solutions-EMS/CAD/pull/123. Figure out the impact and QA it.
@QA Agent start a browser session and tell me what buttons are on the current screen.
@QA Agent click the Search button and summarize what changed.
@QA Agent run full QA for demo admin with a $25 budget.
@QA Agent what is the status of QA job 20260513-abc123?
```

If a request is ambiguous, Hermes should ask one clarifying question. If an action is destructive or tenant-wide, the QA tools block it or require approval.

## Operator Commands

```bash
npm run deploy:gcp
scripts/deploy-hermes-gce.sh
gcloud run jobs execute qa-code-indexer --region us-central1
```

The Slack app must have a bot token, signing secret, and app-level `xapp-...` token stored in Secret Manager before the Hermes gateway can connect.
Private GitHub access uses the local client SSH key in V1. The deploy script stores it in Secret Manager as `qa-github-ssh-private-key-base64`, and Cloud Run receives it as `GITHUB_SSH_PRIVATE_KEY_BASE64`.
