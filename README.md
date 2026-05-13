# Unified Production QA Agent

An automated QA agent for Unified applications. It logs into the app, discovers routes and workflows, captures evidence, validates screens against the Unified wiki, classifies bugs, and resumes from persisted coverage state after interruptions.

The production loop is:

```text
observe page -> classify page -> retrieve wiki context -> infer actions -> choose safe action -> execute -> validate -> record evidence -> update coverage -> repeat
```

The agent can run in two modes:

- **Fallback mode:** Playwright-only runtime, local keyword retrieval over `data/wiki/articles.jsonl`, screenshots, traces, console/network capture, reports, route graph memory, and safety policies. No `OPENAI_API_KEY` is required.
- **AI mode:** everything in fallback mode plus OpenAI vector-store search for wiki retrieval, OpenRouter model-backed oracle validation, and optional Stagehand AI browser observation/actions routed through OpenRouter.

## Data Flow

```mermaid
flowchart TD
  Operator["Operator / CI"] --> CLI["CLI commands"]
  Env[".env.local / .qa/credentials.json"] --> Config["Config loader"]
  CLI --> Config

  Wiki["Unified wiki"] --> Crawler["Wiki crawler"]
  Crawler --> WikiJsonl["data/wiki/articles.jsonl"]
  Crawler --> WikiManifest["data/wiki/manifest.json"]
  WikiJsonl --> LocalKB["Local keyword KB"]
  WikiManifest --> UploadKB["upload-kb command"]
  UploadKB --> OpenAIVS["OpenAI vector store"]

  Config --> Agent["QA orchestrator"]
  Agent --> Runtime["Browser runtime"]
  Runtime --> Playwright["Playwright substrate"]
  Runtime -. optional .-> Stagehand["Stagehand page.observe / page.act"]
  Playwright --> UnifiedApp["Unified app"]
  Stagehand --> UnifiedApp

  UnifiedApp --> Observation["URL, DOM, text, controls, forms, tables, screenshot, console, network"]
  Observation --> Classifier["Page classifier"]
  Observation --> QueryBuilder["Screen query builder"]
  QueryBuilder --> LocalKB
  QueryBuilder --> Oracle["Oracle client"]
  LocalKB --> Oracle
  OpenAIVS -. vector search .-> Oracle
  OpenRouterModel["OpenRouter model"] -. Chat Completions .-> Oracle

  Oracle --> Validator["Validator"]
  Classifier --> Planner["Planner"]
  Validator --> Findings["Bug findings"]
  Findings --> Memory["SQLite app-state memory"]
  Observation --> Evidence["Screenshots, DOM snapshots, traces"]
  Evidence --> Artifacts["artifacts/runs/<runId>"]
  Planner --> Policy["Safe-action policy"]
  Policy --> Runtime
  Memory --> Coverage["Coverage graph"]
  Coverage --> Planner
  Memory --> Reporter["JSON + HTML reports"]
  Artifacts --> Reporter
```

## Architecture

```mermaid
flowchart LR
  subgraph Inputs["Inputs"]
    EnvFile[".env.local"]
    CredProfiles[".qa/credentials.json"]
    WikiDocs["Unified wiki pages"]
  end

  subgraph Knowledge["Knowledge Layer"]
    WikiCrawler["WikiCrawler"]
    LocalSearch["LocalKnowledgeSearch"]
    VectorUpload["OpenAIVectorStoreUploader"]
    OracleClient["OracleClient"]
  end

  subgraph Brain["Agent Brain"]
    Planner["Planner"]
    ActionInferer["ActionInferer"]
    PageClassifier["PageClassifier"]
    Validator["Validator"]
    CoverageEngine["CoverageEngine"]
    SafePolicy["SafeActionPolicy"]
  end

  subgraph Runtime["Runtime Layer"]
    BrowserRuntime["BrowserRuntime"]
    PlaywrightRuntime["Playwright"]
    StagehandRuntime["Stagehand optional AI layer"]
  end

  subgraph State["State And Evidence"]
    SQLite["SQLite memory"]
    AuthState["Playwright auth state"]
    StagehandProfile["Stagehand user data"]
    Artifacts["Screenshots, traces, DOM, reports"]
  end

  subgraph External["External Services"]
    UnifiedApp["Unified app"]
    OpenAI["OpenAI vector store"]
    OpenRouter["OpenRouter models"]
    Browserbase["Browserbase optional future runtime"]
  end

  EnvFile --> BrowserRuntime
  CredProfiles --> BrowserRuntime
  WikiDocs --> WikiCrawler
  WikiCrawler --> LocalSearch
  WikiCrawler --> VectorUpload
  VectorUpload --> OpenAI
  LocalSearch --> OracleClient
  OracleClient --> OpenAI
  OracleClient --> OpenRouter
  Planner --> SafePolicy
  SafePolicy --> BrowserRuntime
  BrowserRuntime --> PlaywrightRuntime
  BrowserRuntime -. when --stagehand .-> StagehandRuntime
  PlaywrightRuntime --> UnifiedApp
  StagehandRuntime --> UnifiedApp
  BrowserRuntime --> PageClassifier
  PageClassifier --> ActionInferer
  ActionInferer --> Planner
  OracleClient --> Validator
  Validator --> SQLite
  CoverageEngine --> SQLite
  SQLite --> CoverageEngine
  BrowserRuntime --> Artifacts
  BrowserRuntime --> AuthState
  StagehandRuntime --> StagehandProfile
  BrowserRuntime -. later .-> Browserbase
```

## Why OpenAI And OpenRouter Are Used

`OPENAI_API_KEY` is used only for knowledge retrieval:

- **Vector-store upload:** `upload-kb` creates or updates an OpenAI vector store from crawled wiki records.
- **Vector-store search:** `run` queries that vector store for relevant wiki chunks per screen.

`OPENROUTER_API_KEY` is used for reasoning/model work:

- **Model-backed oracle:** the oracle sends local + OpenAI-vector retrieved wiki context to OpenRouter Chat Completions and asks for structured QA judgments.
- **Stagehand AI browser layer:** when `--stagehand` is enabled, Stagehand can route model calls through OpenRouter's OpenAI-compatible API.
- **Budget control:** `OPENROUTER_MAX_RUN_COST_USD` caps estimated oracle spend for a run.

Without `OPENAI_API_KEY`, the agent still runs with local keyword retrieval. Without `OPENROUTER_API_KEY`, the agent still runs with heuristic oracle validation.

## Repository Layout

```text
src/cli.ts                         CLI entrypoint
src/orchestrator/qaAgent.ts         main observe/retrieve/execute/validate loop
src/runtime/browserRuntime.ts       Playwright + Stagehand runtime
src/wiki/crawler.ts                 wiki crawl and normalization
src/knowledge/*                     local search, OpenAI vector upload, oracle client
src/planner/*                       page classification, action inference, planning
src/policy/safeActionPolicy.ts      approval gates and mutation rules
src/coverage/coverageEngine.ts      visited/unvisited route graph
src/memory/sqliteMemory.ts          resumable app-state memory
src/validator/validator.ts          bug detection and severity classification
src/report/reporter.ts              JSON/HTML report generation
src/cloud/*                         Cloud Run API, worker, Slack, impact, baselines
src/hermes/mcp.ts                   MCP tools consumed by Hermes
src/live/*                          interactive browser session API
src/github/*                        GitHub App client and PR impact analyzer
src/codegraph/*                     Cloud SQL/pgvector code graph indexer/search
src/budget/budgetPolicy.ts          budget-aware model/scope policy
scripts/deploy-gcp.sh               GCP deployment script
scripts/deploy-hermes-gce.sh        GCE Hermes gateway deployment script
test/*.test.ts                      unit coverage for core behavior
```

## Cloud Architecture

The cloud version keeps the same QA engine and wraps it with a Slack/GCP control plane:

```mermaid
flowchart TD
  Slack["Slack slash command / mention / DM"] --> Api["qa-api Cloud Run service"]
  Api --> Intent["Intent router"]
  Intent --> Impact["Impact analyzer"]
  Impact --> JobStore["Cloud SQL Postgres qa_jobs"]
  Api --> Launcher["Cloud Run Jobs API"]
  Launcher --> Worker["qa-worker Cloud Run Job"]
  Worker --> Engine["runQaAgent(request)"]
  Engine --> Playwright["Playwright Chromium"]
  Engine -. optional .-> Stagehand["Stagehand observe/act"]
  Engine --> Unified["Unified app"]
  Engine --> OpenAI["OpenAI vector store retrieval"]
  Engine --> OpenRouter["OpenRouter oracle model"]
  Engine --> SQLite["Per-run SQLite memory"]
  Engine --> Artifacts["screenshots / traces / DOM / reports"]
  Artifacts --> GCS["GCS artifact bucket"]
  Worker --> JobStore
  Worker --> SlackDigest["Slack completion digest"]
```

Cloud components:

- `qa-api`: Cloud Run HTTP service for Slack slash commands, events, status, report lookup, and approvals.
- `qa-worker`: Cloud Run Job for long browser runs. The API launches it asynchronously with a serialized `RunRequest`.
- `qa-live`: warm Cloud Run service for conversational browser sessions: start, observe, act, close.
- `qa-code-indexer`: Cloud Run Job that indexes the Unified GitHub org into Cloud SQL Postgres + pgvector.
- `qa-hermes-gateway`: GCE VM running Hermes Agent over Slack Socket Mode and connected to `qa-api` through MCP.
- Cloud SQL Postgres: durable job status and report URL registry.
- Cloud SQL + pgvector code graph: repository chunks, extracted symbols, route hints, module hints, and optional OpenAI embeddings.
- GCS: report, screenshot, trace, and DOM artifacts.
- Secret Manager: Slack secrets, Unified credentials, GitHub App credentials, OpenAI key, OpenRouter key, vector store id, database URL, and internal MCP/live token.
- Cloud Logging/Monitoring: runtime logs, Cloud Build logs, and worker failure traces.

## Hermes Conversational Layer

Hermes is the always-on Slack brain. This repo exposes the QA system to Hermes through an HTTP MCP server at:

```text
<qa-api-url>/mcp
```

Hermes receives Slack DMs/mentions through Socket Mode, reasons over the user’s request, and calls QA tools such as:

```text
budget_plan_run
qa_run_full
qa_run_targeted
qa_analyze_pr
qa_run_pr
qa_get_status
qa_get_report
live_start_session
live_observe_screen
live_act_on_screen
live_close_session
kg_search_code
```

This supports interactive prompts like:

```text
@QA Agent test this PR with a $10 budget: https://github.com/Unified-Solutions-EMS/CAD/pull/123
@QA Agent start a browser session and tell me what buttons are visible.
@QA Agent click Search and summarize what changed.
@QA Agent QA the Crew Scheduling dashboard but keep it read-only.
```

MCP and live-browser endpoints are protected by `QA_INTERNAL_TOKEN`/`QA_MCP_TOKEN`; Slack slash/events still use Slack request signing.

## PR Impact And Code Graph

The current V1 production path uses the client SSH key for private repository access. Locally, set:

```text
GITHUB_AUTH_MODE=ssh
GITHUB_SSH_PRIVATE_KEY_PATH=~/.ssh/id_ed25519_client
GITHUB_SSH_HOST=github.com
GITHUB_SSH_ORG=Unified-Solutions-EMS
```

`scripts/deploy-gcp.sh` base64-encodes that key into Secret Manager as:

```text
qa-github-ssh-private-key-base64
```

The Cloud Run code indexer and PR analyzer receive it as `GITHUB_SSH_PRIVATE_KEY_BASE64`. GitHub App credentials are still supported as a future/alternate path (`qa-github-app-id`, `qa-github-app-installation-id`, `qa-github-app-private-key-base64`), and `GITHUB_TOKEN` remains a temporary dev fallback.

The code graph indexer scans all currently visible repos in `Unified-Solutions-EMS` by default (`CODEGRAPH_MAX_REPOS=18`), chunks text files, extracts symbols/routes/modules, stores records in Cloud SQL Postgres, and adds `pgvector` embeddings when `OPENAI_API_KEY` is available.

Run locally:

```bash
npm run kg:index
tsx src/cli.ts analyze-pr https://github.com/Unified-Solutions-EMS/CAD/pull/123 --budget 10
```

Run in GCP:

```bash
gcloud run jobs execute qa-code-indexer --region us-central1
```

For a PR Slack prompt, Hermes calls `qa_analyze_pr` or `qa_run_pr`; the analyzer reads changed files, searches the code graph, maps likely modules/routes, applies the budget profile, and queues only the impacted QA scope.

## Budget Layer

Every Slack/Hermes run can include a budget:

```text
with a $5 budget
budget 10
/qa full demo admin 25
```

Budget tiers:

```text
micro    <= $5    deterministic Playwright, shallow target, light model only
standard <= $25   bounded targeted coverage, selective oracle calls, light model
deep     <= $100  broader coverage, Stagehand allowed, heavy model allowed for ambiguity
release  >  $100  widest coverage, heavy model selected, aggressive validation
```

The estimate is intentionally conservative. It primarily controls model selection, max steps, max depth, oracle frequency, and whether Stagehand is allowed.

Slack commands:

```text
/qa full [tenant] [role] [budget]
/qa recent <natural-language change description>
/qa screen <url-or-description>
/qa flow <flow description>
/qa status <jobId>
/qa report <jobId>
/qa approve <jobId/actionId>
```

Targeted Slack runs default to `read_only`. Full/baseline runs allow only sandbox mutation behavior through the existing safety policy. Destructive, tenant-wide, invite, billing, and external notification actions remain approval-gated or blocked.

## GCP Deployment

Prerequisites:

- `gcloud` is authenticated and has a selected project.
- Billing is enabled on the project.
- Docker/Cloud Build is available through GCP.
- Optional but recommended: add Slack app secrets to `.env.local` before deploy.

Deploy:

```bash
npm run build
npm test
npm run deploy:gcp
scripts/deploy-hermes-gce.sh
```

The deploy script will:

1. Enable required GCP APIs.
2. Create an Artifact Registry repo.
3. Create a GCS artifact bucket.
4. Create or reuse a small Cloud SQL Postgres instance by default.
5. Copy local secrets from `.env.local` into Secret Manager.
6. Build the container with Cloud Build.
7. Deploy `qa-worker` as a Cloud Run Job.
8. Deploy `qa-code-indexer` as a Cloud Run Job.
9. Deploy `qa-live` as a warm single-instance Cloud Run service.
10. Deploy `qa-api` as a public Cloud Run service for Slack ingress and MCP.

The Hermes script will:

1. Create or update the `qa-hermes-gateway` GCE VM.
2. Install Hermes Agent with the official installer.
3. Load Slack/OpenRouter/internal QA secrets from Secret Manager.
4. Configure Hermes to call `<qa-api-url>/mcp`.
5. Start a `hermes-qa-gateway` systemd service.

Useful deployment overrides:

```bash
PROJECT=agents-rohith REGION=us-central1 npm run deploy:gcp
CREATE_CLOUD_SQL=0 DATABASE_URL=... npm run deploy:gcp
QA_FULL_RUN_MAX_STEPS=500 QA_TARGETED_RUN_MAX_STEPS=60 npm run deploy:gcp
```

After deployment, configure Slack:

- Slash command request URL: `<qa-api-url>/slack/commands`
- Events request URL: `<qa-api-url>/slack/events`
- Hermes MCP URL: `<qa-api-url>/mcp`
- Required Slack secrets in Secret Manager: `qa-slack-signing-secret`, `qa-slack-bot-token`, `qa-slack-app-token`

Without Slack secrets, `/health` works and the service is deployed, but Slack endpoints return a clear configuration error.

See [docs/slack-hermes-setup.md](docs/slack-hermes-setup.md) for the app-level token, scopes, Socket Mode, and troubleshooting steps. See [docs/github-app-setup.md](docs/github-app-setup.md) for GitHub App setup. See [docs/hermes-qa-agent-one-pager.md](docs/hermes-qa-agent-one-pager.md) for a short operator guide.

## Cloud Environment Variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `GCP_PROJECT` / `CLOUD_RUN_PROJECT` | Cloud | Project used by `qa-api` to launch `qa-worker`. |
| `GCP_REGION` / `CLOUD_RUN_REGION` | Cloud | Cloud Run region. Defaults to `us-central1`. |
| `QA_WORKER_JOB_NAME` | Cloud | Cloud Run Job name. Defaults to `qa-worker`. |
| `QA_GCS_BUCKET` | Cloud | Bucket where worker artifacts are uploaded. |
| `DATABASE_URL` | Cloud recommended | Postgres URL for job state. The deploy script stores this in Secret Manager. |
| `SLACK_SIGNING_SECRET` | Slack | Verifies slash command and Events API requests. |
| `SLACK_BOT_TOKEN` | Slack | Posts async job updates and report links to Slack threads. |

## Setup

Use Node 24 or newer.

```bash
npm install
npx playwright install chromium
npm run build
```

Create `.env.local` for local secrets. This file is ignored by git.

```bash
cp .env.example .env.local
```

Minimum local credentials:

```bash
UNIFIED_QA_BASE_URL=https://sso.unified-apps.com/login
UNIFIED_QA_WIKI_URL=https://wiki.unified-apps.com/
UNIFIED_QA_EMAIL=<qa-login-email>
UNIFIED_QA_PASSWORD=<qa-login-password>
UNIFIED_QA_TENANT=demo
UNIFIED_QA_ROLE=admin
```

## Environment Variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `UNIFIED_QA_BASE_URL` | Yes | none | Login/start URL for the app under test. |
| `UNIFIED_QA_WIKI_URL` | No | `https://wiki.unified-apps.com/` | Root URL for wiki ingestion. |
| `UNIFIED_QA_EMAIL` | Yes, unless using `QA_CREDENTIALS_FILE` | none | Login email for the selected tenant/profile. |
| `UNIFIED_QA_PASSWORD` | Yes, unless using `QA_CREDENTIALS_FILE` | none | Login password for the selected tenant/profile. |
| `UNIFIED_QA_TENANT` | No | `demo` | Tenant label used for credentials, storage state, and reports. |
| `UNIFIED_QA_ROLE` | No | `admin` | Role label used for credentials, storage state, and reports. |
| `QA_CREDENTIALS_FILE` | No | `.qa/credentials.json` | Optional multi-profile credential file. |
| `QA_WIKI_JSONL` | No | `data/wiki/articles.jsonl` | Local wiki records used by fallback keyword search. |
| `QA_STORAGE_PATH` | No | `.qa/qa-agent.sqlite` | SQLite memory path. |
| `QA_ARTIFACT_DIR` | No | `artifacts/runs` | Screenshots, traces, DOM snapshots, and reports. |
| `QA_SAFETY_STEP_LIMIT` | No | `1000` | Safety ceiling for one run. |
| `OPENAI_API_KEY` | Vector mode only | none | Enables OpenAI vector store upload and vector-store search. Not used for model reasoning. |
| `OPENAI_VECTOR_STORE_ID` | Vector mode only | none | Vector store containing uploaded wiki records. |
| `OPENAI_VECTOR_SEARCH_MAX_RESULTS` | No | `8` | Max vector-search chunks per screen. |
| `OPENROUTER_API_KEY` | Model mode only | none | Enables OpenRouter model-backed oracle validation and optional Stagehand model calls. |
| `OPENROUTER_BASE_URL` | No | `https://openrouter.ai/api/v1` | OpenRouter OpenAI-compatible API base URL. |
| `OPENROUTER_ORACLE_ROUTING` | No | `auto` | `auto`, `light`, `heavy`, or an explicit OpenRouter model id. |
| `OPENROUTER_ORACLE_LIGHT_MODEL` | No | `openai/gpt-5.1-chat` | Lower-cost oracle model for routine screens. |
| `OPENROUTER_ORACLE_HEAVY_MODEL` | No | `openai/gpt-5.5` | Heavier oracle model for complex screens. |
| `OPENROUTER_ORACLE_MAX_TOKENS` | No | `1200` | Max oracle completion tokens per call. |
| `OPENROUTER_MAX_RUN_COST_USD` | No | `100` | Estimated model-spend guard for one process. |
| `QA_ORACLE_MODEL` | No | `openai/gpt-5.1-chat` | Fallback oracle model id when routing selects light/manual mode. |
| `STAGEHAND_ENV` | No | `LOCAL` | `LOCAL` or `BROWSERBASE`. |
| `STAGEHAND_MODEL_NAME` | No | `openai/openai/gpt-5.1-chat` with OpenRouter | Model used by Stagehand observe/act calls. The doubled provider prefix lets Stagehand send `openai/gpt-5.1-chat` to OpenRouter. |
| `BROWSERBASE_API_KEY` | Browserbase mode only | none | Browserbase API key for hosted browser sessions. |
| `BROWSERBASE_PROJECT_ID` | Browserbase mode only | none | Browserbase project ID. |

## Multi-Tenant Credentials

For a single account, `.env.local` is enough. For multiple tenants or roles, use `.qa/credentials.json`:

```json
{
  "profiles": [
    {
      "tenant": "demo",
      "role": "admin",
      "email": "admin@example.com",
      "password": "set-locally"
    },
    {
      "tenant": "demo",
      "role": "viewer",
      "email": "viewer@example.com",
      "password": "set-locally"
    }
  ]
}
```

`tenant` and `role` are local profile labels. They let the agent choose credentials, isolate auth state, and report which permission profile found a bug. If you only have one email/password, keep `tenant=demo` and `role=admin`.

Auth state is stored outside git:

- Playwright-only state: `.qa/auth/<tenant>-<role>.json`
- Stagehand local browser profile: `.qa/stagehand-user-data/<tenant>-<role>/`

## Wiki Ingestion

Crawl the Unified wiki into markdown, JSONL, and a manifest:

```bash
npm run qa:ingest
```

Useful options:

```bash
npx tsx src/cli.ts ingest-wiki --url https://wiki.unified-apps.com/ --out data/wiki
npx tsx src/cli.ts ingest-wiki --limit 50 --max-depth 4
```

The crawler stores normalized records with URL, title, headings, body, extracted workflow-like lines, and content hashes. The local JSONL file powers fallback retrieval.

## OpenAI Vector Store

After crawling the wiki, upload it to OpenAI:

```bash
OPENAI_API_KEY=sk-... npx tsx src/cli.ts upload-kb \
  --manifest data/wiki/manifest.json \
  --vector-store-name unified-wiki
```

For large wikis, use the consolidated upload mode. This uploads one searchable markdown bundle instead of hundreds of individual files:

```bash
npx tsx src/cli.ts upload-kb \
  --manifest data/wiki/manifest.json \
  --vector-store-name unified-wiki \
  --consolidated
```

The command prints a vector store id like `vs_...`. Add it to `.env.local`:

```bash
OPENAI_VECTOR_STORE_ID=vs_...
```

You can update an existing vector store:

```bash
npx tsx src/cli.ts upload-kb \
  --manifest data/wiki/manifest.json \
  --vector-store-id "$OPENAI_VECTOR_STORE_ID"
```

## Running The Agent

Fallback mode, no OpenAI key:

```bash
npm run qa:run
```

Run with a visible browser:

```bash
npm run qa:run -- --headed
```

Run with OpenAI vector retrieval and OpenRouter model-backed oracle:

```bash
npm run qa:run -- --vector-store-id "$OPENAI_VECTOR_STORE_ID"
```

Run with OpenAI vector retrieval, OpenRouter oracle, and Stagehand routed through OpenRouter:

```bash
npm run qa:run -- --stagehand --vector-store-id "$OPENAI_VECTOR_STORE_ID"
```

Resume a run:

```bash
npx tsx src/cli.ts run --resume <runId>
```

Generate a report again from persisted evidence:

```bash
npm run qa:report -- --run-id <runId>
```

Build output can also be run directly:

```bash
npm run build
node dist/src/cli.js run --base-url https://sso.unified-apps.com/login
```

## Agent Behavior

Each loop does the following:

1. Captures the current URL, route key, visible text, controls, forms, tables, breadcrumbs, screenshot, DOM snapshot, console messages, and network failures.
2. Classifies the page as auth, dashboard, list/table, detail, form, settings, modal, wizard, report, error, empty, or unknown.
3. Retrieves relevant local wiki chunks and, when configured, asks OpenAI vector-store search for additional evidence.
4. Infers candidate actions such as navigation, search, filter, open detail, create sandbox record, edit sandbox record, export, cancel/back, and logout.
5. Applies safe-action policy before execution.
6. Executes through Playwright locators first. Stagehand `page.act()` is used only as a bounded fallback when `--stagehand` is enabled.
7. Validates transitions, visible success/error text, persistence hints, console/runtime errors, failed requests, dead-end states, and wiki/product mismatches using OpenRouter when configured.
8. Records evidence and updates the coverage graph.

Completion means the route/action frontier is exhausted, or every remaining item is blocked/skipped with evidence.

## Safety Policy

Default behavior is conservative:

- Navigation, search, filtering, opening details, cancel/back, and read-only exploration are allowed.
- Sandbox mutations are allowed only for records tagged with `qa_<runId>`.
- Generic submit/edit/import actions require approval unless the agent can prove the target belongs to the same run.
- Destructive actions require approval unless cleaning up a record created by the same run.
- Logout is skipped during exploratory runs so the agent does not prematurely end coverage.
- Invites, external notifications, billing/subscription changes, and tenant-wide settings are denied or approval-gated.

Use `--allow-destructive` only in a prepared sandbox tenant.

## Bug Classification

Findings are grouped into:

- Functional bug
- Workflow mismatch
- Wiki/product mismatch
- Copy/text issue
- Layout/display issue
- Accessibility issue
- Validation issue
- Broken navigation
- Auth/permission issue
- Console/runtime error
- Network/API failure
- Data persistence issue
- Flaky/timeout issue

Severity rules:

- `P0`: blocks login, tenant access, or critical workflows.
- `P1`: breaks core create/edit/view/reporting flows or risks data loss.
- `P2`: incorrect behavior, misleading copy, broken secondary flows, or visible UI defects.
- `P3`: polish, consistency, minor copy, or low-risk accessibility issues.

Each finding includes route, tenant/profile, steps, expected result, actual result, screenshot, trace path, console/network evidence, and wiki citations when available.

## Artifacts And Memory

Run evidence is written to:

```text
artifacts/runs/<runId>/
```

Typical contents:

- `screenshots/*.png`
- `traces/*.zip`
- `dom/*.html`
- `report.json`
- `report.html`

SQLite memory defaults to:

```text
.qa/qa-agent.sqlite
```

It stores routes, transitions, observations, attempted actions, blocked/skipped actions, findings, evidence, created records, and run status. This is what makes runs resumable.

## CI

The included GitHub Actions workflow installs dependencies, installs Playwright Chromium, builds, and runs tests. To run live QA in CI, add repository secrets for the Unified profile and, optionally, OpenAI/OpenRouter:

- `UNIFIED_QA_EMAIL`
- `UNIFIED_QA_PASSWORD`
- `OPENAI_API_KEY`
- `OPENAI_VECTOR_STORE_ID`
- `OPENROUTER_API_KEY`

Keep live QA jobs pointed at a sandbox tenant.

## Development Checks

```bash
npm run build
npm test
```

The current test suite covers local KB retrieval, page classification, route key stability, scoped URL filtering, safe-action policy decisions, SQLite route memory, Slack command parsing/signature verification, impact planning, baseline comparison, and knowledge registry chunking.

## Troubleshooting

`Run incomplete because max steps stopped first`
: Increase `QA_SAFETY_STEP_LIMIT`, pass `--max-steps`, or resume the run. The limit is a safety guard, not a coverage target.

`Stagehand initialization failed; falling back to Playwright only`
: Check `OPENROUTER_API_KEY`, `STAGEHAND_MODEL_NAME`, `OPENROUTER_BASE_URL`, and `STAGEHAND_ENV`. Fallback mode still runs.

`No wiki context was available`
: Run `npm run qa:ingest` and confirm `data/wiki/articles.jsonl` exists, or set `QA_WIKI_JSONL`.

`Oracle is heuristic only`
: Set `OPENROUTER_API_KEY` for model-backed validation. Set `OPENAI_API_KEY` and `OPENAI_VECTOR_STORE_ID` for vector-store retrieval.

`Login keeps looping`
: Remove stale auth state under `.qa/auth/` or `.qa/stagehand-user-data/`, then rerun.

`A run escaped to unrelated links`
: The runtime scopes discovered links to Unified-owned app domains and excludes the wiki domain during app QA. Check `src/utils/route.ts` if a new Unified app domain needs to be allowed.

## Notes On Stagehand

The top-level orchestrator remains our own planner/validator/coverage engine. Stagehand is deliberately limited to:

- `page.observe()` for unfamiliar screens.
- `page.act()` only for the selected action when deterministic Playwright locators are not available.

This keeps the QA product deterministic, resumable, and reportable while still allowing AI browser help where it has the most value.
