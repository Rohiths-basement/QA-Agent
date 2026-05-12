#!/usr/bin/env bash
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
ZONE="${ZONE:-us-central1-a}"
VM_NAME="${VM_NAME:-qa-hermes-gateway}"
SERVICE_NAME="${SERVICE_NAME:-qa-api}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-2}"

if [[ -z "${PROJECT}" ]]; then
  echo "PROJECT is required. Set PROJECT or run gcloud config set project <id>." >&2
  exit 1
fi

QA_API_URL="${QA_API_URL:-$(gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" --project "${PROJECT}" --format='value(status.url)' 2>/dev/null || true)}"
if [[ -z "${QA_API_URL}" ]]; then
  echo "Could not resolve QA_API_URL. Deploy qa-api first or set QA_API_URL=https://..." >&2
  exit 1
fi

for secret in qa-slack-bot-token qa-slack-app-token qa-openrouter-api-key qa-internal-token; do
  if ! gcloud secrets describe "${secret}" --project "${PROJECT}" >/dev/null 2>&1; then
    echo "Missing Secret Manager secret ${secret}. Run scripts/deploy-gcp.sh after adding the needed value to .env.local." >&2
    exit 1
  fi
done

gcloud services enable compute.googleapis.com secretmanager.googleapis.com --project "${PROJECT}"
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-${PROJECT_NUMBER}-compute@developer.gserviceaccount.com}"

gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/secretmanager.secretAccessor" \
  --condition=None >/dev/null

startup_script="$(mktemp)"
cat > "${startup_script}" <<'STARTUP'
#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="$(curl -fsH 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/project/project-id)"
QA_API_URL="__QA_API_URL__"
SLACK_HOME_CHANNEL="__SLACK_HOME_CHANNEL__"

secret() {
  gcloud secrets versions access latest --secret="$1" --project="${PROJECT_ID}" 2>/dev/null || true
}

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y curl git jq ca-certificates

if ! id hermes >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash hermes
fi

install -d -o hermes -g hermes /home/hermes/.hermes

sudo -u hermes bash -lc 'if ! command -v hermes >/dev/null 2>&1; then curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash; fi'

cat > /home/hermes/.hermes/config.yaml <<CONFIG
mcp_servers:
  unified_qa:
    url: "${QA_API_URL}/mcp"
    headers:
      Authorization: "Bearer $(secret qa-internal-token)"
    tools:
      include:
        - budget_plan_run
        - qa_run_full
        - qa_run_targeted
        - qa_analyze_pr
        - qa_run_pr
        - qa_get_status
        - qa_get_report
        - live_start_session
        - live_observe_screen
        - live_act_on_screen
        - live_close_session
        - kg_search_code
      prompts: false
      resources: false
CONFIG
chown hermes:hermes /home/hermes/.hermes/config.yaml
chmod 600 /home/hermes/.hermes/config.yaml

cat > /etc/hermes-qa.env <<ENV
HERMES_HOME=/home/hermes/.hermes
OPENROUTER_API_KEY=$(secret qa-openrouter-api-key)
SLACK_BOT_TOKEN=$(secret qa-slack-bot-token)
SLACK_APP_TOKEN=$(secret qa-slack-app-token)
SLACK_HOME_CHANNEL=${SLACK_HOME_CHANNEL}
SLACK_DEFAULT_CHANNEL=${SLACK_HOME_CHANNEL}
QA_API_URL=${QA_API_URL}
ENV
chmod 600 /etc/hermes-qa.env

cat > /etc/systemd/system/hermes-qa-gateway.service <<SERVICE
[Unit]
Description=Hermes QA Slack Gateway
After=network-online.target
Wants=network-online.target

[Service]
User=hermes
WorkingDirectory=/home/hermes
EnvironmentFile=/etc/hermes-qa.env
ExecStart=/home/hermes/.local/bin/hermes gateway
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now hermes-qa-gateway.service
STARTUP

sed -i.bak "s#__QA_API_URL__#${QA_API_URL}#g" "${startup_script}"
sed -i.bak "s#__SLACK_HOME_CHANNEL__#${SLACK_DEFAULT_CHANNEL:-C0B35S99GLV}#g" "${startup_script}"

if gcloud compute instances describe "${VM_NAME}" --zone "${ZONE}" --project "${PROJECT}" >/dev/null 2>&1; then
  gcloud compute instances add-metadata "${VM_NAME}" \
    --zone "${ZONE}" \
    --project "${PROJECT}" \
    --metadata-from-file startup-script="${startup_script}"
  gcloud compute instances reset "${VM_NAME}" --zone "${ZONE}" --project "${PROJECT}" --quiet
else
  gcloud compute instances create "${VM_NAME}" \
    --project "${PROJECT}" \
    --zone "${ZONE}" \
    --machine-type="${MACHINE_TYPE}" \
    --service-account="${SERVICE_ACCOUNT}" \
    --scopes=https://www.googleapis.com/auth/cloud-platform \
    --boot-disk-size=30GB \
    --image-family=debian-12 \
    --image-project=debian-cloud \
    --metadata-from-file startup-script="${startup_script}"
fi

rm -f "${startup_script}" "${startup_script}.bak"

echo "Hermes gateway VM: ${VM_NAME} (${ZONE})"
echo "QA MCP endpoint configured: ${QA_API_URL}/mcp"
echo "Logs: gcloud compute ssh ${VM_NAME} --zone ${ZONE} --project ${PROJECT} --command 'sudo journalctl -u hermes-qa-gateway -f'"
