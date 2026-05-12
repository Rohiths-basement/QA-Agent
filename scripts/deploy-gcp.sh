#!/usr/bin/env bash
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-qa-agent}"
SERVICE_NAME="${SERVICE_NAME:-qa-api}"
JOB_NAME="${JOB_NAME:-qa-worker}"
BUCKET="${BUCKET:-qa-agent-artifacts-${PROJECT}}"
SQL_INSTANCE="${SQL_INSTANCE:-qa-agent-postgres}"
SQL_DATABASE="${SQL_DATABASE:-qa_agent}"
SQL_USER="${SQL_USER:-qa_agent}"
CREATE_CLOUD_SQL="${CREATE_CLOUD_SQL:-1}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d%H%M%S)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/qa-agent:${IMAGE_TAG}"

if [[ -z "${PROJECT}" ]]; then
  echo "PROJECT is required. Set PROJECT or run gcloud config set project <id>." >&2
  exit 1
fi

echo "Deploying QA Agent to project=${PROJECT} region=${REGION}"

load_env_file() {
  local file="$1"
  while IFS='=' read -r key value || [[ -n "${key}" ]]; do
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    if [[ -z "${key}" || "${key}" == \#* ]]; then
      continue
    fi
    if [[ ! "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      continue
    fi
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    value="${value%$'\r'}"
    if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "${key}=${value}"
  done < "${file}"
}

if [[ -f ".env.local" ]]; then
  load_env_file ".env.local"
fi

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  --project "${PROJECT}"

if ! gcloud artifacts repositories describe "${REPO}" --location "${REGION}" --project "${PROJECT}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="QA Agent container images" \
    --project "${PROJECT}"
fi

if ! gcloud storage buckets describe "gs://${BUCKET}" --project "${PROJECT}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" \
    --project "${PROJECT}" \
    --location="${REGION}" \
    --uniform-bucket-level-access
fi

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT:-${PROJECT_NUMBER}-compute@developer.gserviceaccount.com}"

put_secret() {
  local name="$1"
  local value="$2"
  if [[ -z "${value}" ]]; then
    return
  fi
  local tmp
  tmp="$(mktemp)"
  printf "%s" "${value}" > "${tmp}"
  if ! gcloud secrets describe "${name}" --project "${PROJECT}" >/dev/null 2>&1; then
    gcloud secrets create "${name}" --replication-policy=automatic --data-file="${tmp}" --project "${PROJECT}"
  else
    gcloud secrets versions add "${name}" --data-file="${tmp}" --project "${PROJECT}" >/dev/null
  fi
  rm -f "${tmp}"
}

secret_arg=""
append_secret() {
  local env_name="$1"
  local secret_name="$2"
  if gcloud secrets describe "${secret_name}" --project "${PROJECT}" >/dev/null 2>&1; then
    if [[ -z "${secret_arg}" ]]; then
      secret_arg="${env_name}=${secret_name}:latest"
    else
      secret_arg="${secret_arg},${env_name}=${secret_name}:latest"
    fi
  fi
}

put_secret "qa-openai-api-key" "${OPENAI_API_KEY:-}"
put_secret "qa-openrouter-api-key" "${OPENROUTER_API_KEY:-}"
put_secret "qa-unified-email" "${UNIFIED_QA_EMAIL:-}"
put_secret "qa-unified-password" "${UNIFIED_QA_PASSWORD:-}"
put_secret "qa-openai-vector-store-id" "${OPENAI_VECTOR_STORE_ID:-}"
put_secret "qa-slack-signing-secret" "${SLACK_SIGNING_SECRET:-}"
put_secret "qa-slack-bot-token" "${SLACK_BOT_TOKEN:-}"

if [[ "${CREATE_CLOUD_SQL}" == "1" ]]; then
  if ! gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT}" >/dev/null 2>&1; then
    gcloud sql instances create "${SQL_INSTANCE}" \
      --database-version=POSTGRES_16 \
      --edition=enterprise \
      --tier=db-f1-micro \
      --region="${REGION}" \
      --storage-size=10GB \
      --project "${PROJECT}"
  fi
  if ! gcloud sql databases describe "${SQL_DATABASE}" --instance="${SQL_INSTANCE}" --project "${PROJECT}" >/dev/null 2>&1; then
    gcloud sql databases create "${SQL_DATABASE}" --instance="${SQL_INSTANCE}" --project "${PROJECT}"
  fi
  SQL_PASSWORD="${SQL_PASSWORD:-$(openssl rand -hex 16)}"
  if ! gcloud sql users list --instance="${SQL_INSTANCE}" --project "${PROJECT}" --format='value(name)' | grep -qx "${SQL_USER}"; then
    gcloud sql users create "${SQL_USER}" --instance="${SQL_INSTANCE}" --password="${SQL_PASSWORD}" --project "${PROJECT}"
  else
    gcloud sql users set-password "${SQL_USER}" --instance="${SQL_INSTANCE}" --password="${SQL_PASSWORD}" --project "${PROJECT}"
  fi
  DATABASE_URL="postgresql://${SQL_USER}:${SQL_PASSWORD}@/${SQL_DATABASE}?host=/cloudsql/${PROJECT}:${REGION}:${SQL_INSTANCE}"
  put_secret "qa-database-url" "${DATABASE_URL}"
fi

append_secret "OPENAI_API_KEY" "qa-openai-api-key"
append_secret "OPENROUTER_API_KEY" "qa-openrouter-api-key"
append_secret "UNIFIED_QA_EMAIL" "qa-unified-email"
append_secret "UNIFIED_QA_PASSWORD" "qa-unified-password"
append_secret "OPENAI_VECTOR_STORE_ID" "qa-openai-vector-store-id"
append_secret "SLACK_SIGNING_SECRET" "qa-slack-signing-secret"
append_secret "SLACK_BOT_TOKEN" "qa-slack-bot-token"
append_secret "DATABASE_URL" "qa-database-url"

for role in roles/run.developer roles/storage.objectAdmin roles/secretmanager.secretAccessor roles/cloudsql.client; do
  gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
    --role="${role}" \
    --condition=None >/dev/null
done

gcloud builds submit --tag "${IMAGE}" --project "${PROJECT}"

common_env="GCP_PROJECT=${PROJECT},CLOUD_RUN_PROJECT=${PROJECT},GCP_REGION=${REGION},CLOUD_RUN_REGION=${REGION},QA_WORKER_JOB_NAME=${JOB_NAME},QA_GCS_BUCKET=${BUCKET},UNIFIED_QA_BASE_URL=${UNIFIED_QA_BASE_URL:-https://sso.unified-apps.com/login},UNIFIED_QA_WIKI_URL=${UNIFIED_QA_WIKI_URL:-https://wiki.unified-apps.com/},UNIFIED_QA_TENANT=${UNIFIED_QA_TENANT:-demo},UNIFIED_QA_ROLE=${UNIFIED_QA_ROLE:-admin},QA_FULL_RUN_MAX_STEPS=${QA_FULL_RUN_MAX_STEPS:-1000},QA_TARGETED_RUN_MAX_STEPS=${QA_TARGETED_RUN_MAX_STEPS:-80},QA_ENABLE_STAGEHAND=${QA_ENABLE_STAGEHAND:-false},QA_WIKI_JSONL=${QA_WIKI_JSONL:-data/wiki/articles.jsonl},QA_ORACLE_MODEL=${QA_ORACLE_MODEL:-${OPENROUTER_ORACLE_LIGHT_MODEL:-openai/gpt-5.1-chat}},OPENAI_VECTOR_SEARCH_MAX_RESULTS=${OPENAI_VECTOR_SEARCH_MAX_RESULTS:-8},OPENROUTER_BASE_URL=${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1},OPENROUTER_HTTP_REFERER=${OPENROUTER_HTTP_REFERER:-https://github.com/Rohiths-basement/QA-Agent},OPENROUTER_APP_TITLE=${OPENROUTER_APP_TITLE:-Unified QA Agent},OPENROUTER_ORACLE_ROUTING=${OPENROUTER_ORACLE_ROUTING:-auto},OPENROUTER_ORACLE_LIGHT_MODEL=${OPENROUTER_ORACLE_LIGHT_MODEL:-openai/gpt-5.1-chat},OPENROUTER_ORACLE_HEAVY_MODEL=${OPENROUTER_ORACLE_HEAVY_MODEL:-openai/gpt-5.5},OPENROUTER_ORACLE_MAX_TOKENS=${OPENROUTER_ORACLE_MAX_TOKENS:-1200},OPENROUTER_MAX_RUN_COST_USD=${OPENROUTER_MAX_RUN_COST_USD:-100},OPENROUTER_LIGHT_INPUT_USD_PER_MILLION=${OPENROUTER_LIGHT_INPUT_USD_PER_MILLION:-1.25},OPENROUTER_LIGHT_OUTPUT_USD_PER_MILLION=${OPENROUTER_LIGHT_OUTPUT_USD_PER_MILLION:-10},OPENROUTER_HEAVY_INPUT_USD_PER_MILLION=${OPENROUTER_HEAVY_INPUT_USD_PER_MILLION:-10},OPENROUTER_HEAVY_OUTPUT_USD_PER_MILLION=${OPENROUTER_HEAVY_OUTPUT_USD_PER_MILLION:-30},SLACK_DEFAULT_CHANNEL=${SLACK_DEFAULT_CHANNEL:-}"
job_cloudsql_arg=()
service_cloudsql_arg=()
if [[ "${CREATE_CLOUD_SQL}" == "1" ]]; then
  job_cloudsql_arg=(--set-cloudsql-instances="${PROJECT}:${REGION}:${SQL_INSTANCE}")
  service_cloudsql_arg=(--add-cloudsql-instances="${PROJECT}:${REGION}:${SQL_INSTANCE}")
fi
secret_args=()
if [[ -n "${secret_arg}" ]]; then
  secret_args=(--set-secrets="${secret_arg}")
fi

if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" --project "${PROJECT}" >/dev/null 2>&1; then
  gcloud run jobs update "${JOB_NAME}" \
    --image="${IMAGE}" \
    --command=node \
    --args=dist/src/cli.js,worker \
    --region="${REGION}" \
    --project="${PROJECT}" \
    --service-account="${RUNTIME_SERVICE_ACCOUNT}" \
    --set-env-vars="${common_env}" \
    "${secret_args[@]}" \
    "${job_cloudsql_arg[@]}" \
    --memory=4Gi \
    --cpu=2 \
    --task-timeout=3600s
else
  gcloud run jobs create "${JOB_NAME}" \
    --image="${IMAGE}" \
    --command=node \
    --args=dist/src/cli.js,worker \
    --region="${REGION}" \
    --project="${PROJECT}" \
    --service-account="${RUNTIME_SERVICE_ACCOUNT}" \
    --set-env-vars="${common_env}" \
    "${secret_args[@]}" \
    "${job_cloudsql_arg[@]}" \
    --memory=4Gi \
    --cpu=2 \
    --task-timeout=3600s
fi

gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --project="${PROJECT}" \
  --service-account="${RUNTIME_SERVICE_ACCOUNT}" \
  --allow-unauthenticated \
  --set-env-vars="${common_env}" \
  "${secret_args[@]}" \
  "${service_cloudsql_arg[@]}" \
  --memory=1Gi \
  --cpu=1 \
  --timeout=300s

service_url="$(gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" --project "${PROJECT}" --format='value(status.url)')"
echo "QA API deployed: ${service_url}"
echo "Slack slash command endpoint: ${service_url}/slack/commands"
echo "Slack events endpoint: ${service_url}/slack/events"
echo "Worker job: ${JOB_NAME}"
echo "Artifact bucket: gs://${BUCKET}"
