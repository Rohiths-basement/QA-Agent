# Slack And Hermes Setup

## Slack App-Level Token

Hermes uses Slack Socket Mode, so it needs an app-level token in addition to the bot token and signing secret.

1. Open [Slack API Apps](https://api.slack.com/apps).
2. Select the QA bot app.
3. Go to **Basic Information**.
4. Under **App-Level Tokens**, click **Generate Token and Scopes**.
5. Name it `qa-hermes-socket`.
6. Add the scope `connections:write`.
7. Generate the token and copy the `xapp-...` value.
8. Add it locally as `SLACK_APP_TOKEN=...` in `.env.local`.
9. Run `npm run deploy:gcp` so the token is stored in Secret Manager as `qa-slack-app-token`.

## Slack OAuth Scopes

In **OAuth & Permissions**, the bot should have at least:

```text
app_mentions:read
chat:write
commands
channels:history
channels:read
groups:history
groups:read
im:history
im:read
im:write
mpim:history
mpim:read
users:read
```

After changing scopes, click **Reinstall to Workspace**. Slack does not grant newly added scopes until reinstall.

## Slack Events And Socket Mode

1. Enable **Socket Mode** in the Slack app.
2. Enable **Event Subscriptions**.
3. Subscribe to bot events:
   - `app_mention`
   - `message.im`
   - optionally `message.channels`, `message.groups`, and `message.mpim` for channel conversation.
4. Invite the bot into the QA channel with `/invite @<bot-name>`.

Socket Mode is outbound from Hermes to Slack, so the Hermes GCE VM does not need a public inbound Slack webhook.

## GCP Deployment

After `npm run deploy:gcp` completes, run:

```bash
scripts/deploy-hermes-gce.sh
```

That VM installer:

- Installs Hermes Agent.
- Starts a `hermes-qa-gateway` systemd service.
- Loads Slack/OpenRouter/internal QA tokens from Secret Manager.
- Adds this repo's MCP endpoint to Hermes:

```yaml
mcp_servers:
  unified_qa:
    url: "https://<qa-api-url>/mcp"
    headers:
      Authorization: "Bearer <QA_INTERNAL_TOKEN>"
```

## Health Checks

```bash
curl https://<qa-api-url>/health
curl https://<qa-live-url>/health
gcloud compute ssh qa-hermes-gateway --zone us-central1-a --command 'sudo journalctl -u hermes-qa-gateway -n 100'
```

If Hermes does not respond in Slack, check that the app-level token starts with `xapp-`, has `connections:write`, the bot was reinstalled after adding scopes, and the bot was invited to the channel.
