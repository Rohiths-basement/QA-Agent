# Unified QA Agent: Slack Operator One-Pager

## What It Is

The Unified QA Agent is a cloud-hosted browser QA worker controlled from Slack. It logs into the Unified app, explores screens and flows with Playwright, validates behavior against the Unified wiki knowledge base, captures screenshots/traces/network evidence, classifies bugs, and stores reports in GCP.

## What It Does

- Runs full end-to-end QA across discovered app routes.
- Runs targeted QA for a changed screen, module, or workflow.
- Maps natural-language Slack prompts to likely routes/modules.
- Uses OpenAI vector-store retrieval for wiki context.
- Uses OpenRouter models for QA oracle reasoning with a cost guard.
- Captures screenshots, DOM snapshots, Playwright traces, console errors, failed requests, actions, route coverage, and findings.
- Persists job state in Cloud SQL and artifacts in GCS.
- Applies safe-action policies: targeted runs are read-only by default, destructive actions are blocked or approval-gated.

## How It Works

```text
Slack prompt
  -> qa-api Cloud Run service
  -> intent router + impact analyzer
  -> qa-worker Cloud Run Job
  -> Playwright browser runtime
  -> wiki retrieval + OpenRouter oracle
  -> validator + coverage engine
  -> Cloud SQL job state + GCS artifacts
  -> Slack status/report update
```

## Slack Commands

Use these in Slack after the app is configured with the deployed endpoints:

```text
/qa full demo admin 15
/qa recent changed Crew Scheduling dashboard
/qa screen https://app.unified-apps.com/some/screen
/qa screen CAD map
/qa flow create and review a dispatch incident
/qa status <jobId>
/qa report <jobId>
/qa approve <jobId/actionId>
```

You can also mention or DM the bot conversationally:

```text
@QA Agent test the CAD map screen
@QA Agent QA the recent Crew Scheduling change
@QA Agent run an end-to-end smoke test
```

## Prompting Tips

- For fastest targeted QA, include a URL.
- For recent-change QA, name the module and what changed.
- For flow QA, describe the user journey and expected result.
- Use a budget number on full runs, for example `/qa full demo admin 15`.
- Use targeted runs first for new features; reserve full runs for release gates or baseline refreshes.

## Current GCP Endpoints

- Health: `https://qa-api-pp4qh2p7ja-uc.a.run.app/health`
- Slack slash command URL: `https://qa-api-pp4qh2p7ja-uc.a.run.app/slack/commands`
- Slack events URL: `https://qa-api-pp4qh2p7ja-uc.a.run.app/slack/events`
- Worker job: `qa-worker`
- Artifact bucket: `gs://qa-agent-artifacts-agents-rohith`

## Slack App Setup

In the Slack app configuration:

1. Set slash command `/qa` request URL to the slash command URL above.
2. Set Events API request URL to the events URL above.
3. Subscribe to app mentions and message events if conversational QA is desired.
4. Install/reinstall the app into the workspace.
5. Invite the bot to the QA channel.

The bot token and signing secret are stored in Secret Manager, not in git.
