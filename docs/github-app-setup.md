# GitHub App Setup For PR Impact QA

The production PR workflow should use a GitHub App installed on `Unified-Solutions-EMS`. The app gives the QA agent scoped, revocable access to private repositories without relying on a personal access token.

## Create The App

1. Go to GitHub **Settings** -> **Developer settings** -> **GitHub Apps** -> **New GitHub App**.
2. Name it `Unified QA Agent`.
3. Set **Homepage URL** to the QA repo or internal docs page.
4. Webhooks can stay disabled for v1 because PR-link Slack workflow is the first release.
5. Repository permissions:
   - **Contents**: Read-only
   - **Metadata**: Read-only
   - **Pull requests**: Read-only
6. Account permissions can stay unset.
7. Create the app.
8. Generate a private key and download the `.pem`.
9. Install the app on `Unified-Solutions-EMS`, selecting all 18 relevant repos or the full org.
10. Copy:
    - App ID
    - Installation ID from the installation URL
    - Private key file path

## Store In Secret Manager

From this repo:

```bash
export GITHUB_APP_ID=<app-id>
export GITHUB_APP_INSTALLATION_ID=<installation-id>
export GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem
npm run deploy:gcp
```

The deploy script stores:

```text
qa-github-app-id
qa-github-app-installation-id
qa-github-app-private-key-base64
```

## Temporary Dev Fallback

Before the GitHub App is installed, you can use a short-lived token with repo read access:

```bash
export GITHUB_TOKEN=<temporary-token>
npm run deploy:gcp
```

The deploy script stores it as `qa-github-token`. This is only for dev/testing; remove it after the GitHub App is working.

## Run The Code Graph Indexer

```bash
gcloud run jobs execute qa-code-indexer --region us-central1
```

The indexer reads the 18 visible repos, stores chunks in Cloud SQL Postgres, and adds embeddings when `OPENAI_API_KEY` is configured.
