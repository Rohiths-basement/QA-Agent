import type { RunRequest } from "../types.js";
import { envString, requiredEnv } from "./env.js";

export interface JobLauncher {
  launch(input: { jobId: string; request: RunRequest }): Promise<{ executionId?: string }>;
}

export function createJobLauncher(): JobLauncher {
  return new CloudRunJobLauncher();
}

class CloudRunJobLauncher implements JobLauncher {
  async launch(input: { jobId: string; request: RunRequest }): Promise<{ executionId?: string }> {
    const project = envString("GCP_PROJECT") ?? envString("GOOGLE_CLOUD_PROJECT") ?? requiredEnv("CLOUD_RUN_PROJECT");
    const region = envString("GCP_REGION") ?? envString("CLOUD_RUN_REGION", "us-central1");
    const jobName = envString("QA_WORKER_JOB_NAME", "qa-worker");
    const token = await getAccessToken();
    const url = `https://run.googleapis.com/v2/projects/${project}/locations/${region}/jobs/${jobName}:run`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        overrides: {
          containerOverrides: [{
            env: [
              { name: "QA_JOB_ID", value: input.jobId },
              { name: "RUN_REQUEST_JSON", value: JSON.stringify(input.request) }
            ]
          }]
        }
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Cloud Run Job launch failed (${response.status}): ${body}`);
    }
    const json = await response.json().catch(() => ({})) as { name?: string };
    return json.name ? { executionId: json.name } : {};
  }
}

async function getAccessToken(): Promise<string> {
  const explicit = envString("GCLOUD_ACCESS_TOKEN");
  if (explicit) return explicit;
  const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "Metadata-Flavor": "Google" }
  });
  if (!response.ok) throw new Error(`Could not fetch metadata access token: ${response.statusText}`);
  const json = await response.json() as { access_token?: string };
  if (!json.access_token) throw new Error("Metadata token response did not include access_token.");
  return json.access_token;
}
