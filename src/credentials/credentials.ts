import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TenantCredentialProfile } from "../types.js";

interface CredentialsFile {
  profiles: TenantCredentialProfile[];
}

export async function loadCredentialProfile(input: {
  tenant: string;
  role: string;
  credentialsFile?: string;
}): Promise<TenantCredentialProfile> {
  const fromFile = await loadFromFile(input.credentialsFile, input.tenant, input.role);
  if (fromFile) return fromFile;

  const envProfile = loadFromEnv(input.tenant, input.role);
  if (envProfile) return envProfile;

  throw new Error(
    `No QA credentials found for tenant "${input.tenant}" role "${input.role}". ` +
      "Set UNIFIED_QA_EMAIL/UNIFIED_QA_PASSWORD or provide .qa/credentials.json."
  );
}

async function loadFromFile(
  credentialsFile: string | undefined,
  tenant: string,
  role: string
): Promise<TenantCredentialProfile | undefined> {
  const filePath = path.resolve(credentialsFile ?? ".qa/credentials.json");
  if (!existsSync(filePath)) return undefined;
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as CredentialsFile;
  return parsed.profiles.find((profile) => profile.tenant === tenant && profile.role === role);
}

function loadFromEnv(tenant: string, role: string): TenantCredentialProfile | undefined {
  const scopedPrefix = `UNIFIED_QA_${tenant}_${role}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const scopedEmail = process.env[`${scopedPrefix}_EMAIL`];
  const scopedPassword = process.env[`${scopedPrefix}_PASSWORD`];
  const email = scopedEmail ?? process.env.UNIFIED_QA_EMAIL;
  const password = scopedPassword ?? process.env.UNIFIED_QA_PASSWORD;
  if (!email || !password) return undefined;
  return { tenant, role, email, password };
}
