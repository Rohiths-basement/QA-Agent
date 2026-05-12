import { Storage } from "@google-cloud/storage";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { envString } from "./env.js";

export async function uploadArtifacts(input: {
  runId: string;
  artifactDir: string;
}): Promise<string[]> {
  const bucketName = envString("QA_GCS_BUCKET");
  if (!bucketName) return [];
  const storage = new Storage();
  const bucket = storage.bucket(bucketName);
  const runDir = path.join(input.artifactDir, input.runId);
  const files = await listFiles(runDir);
  const uploaded: string[] = [];
  for (const filePath of files) {
    const destination = `runs/${input.runId}/${path.relative(runDir, filePath).replaceAll(path.sep, "/")}`;
    await bucket.upload(filePath, {
      destination,
      metadata: {
        cacheControl: "no-store"
      }
    });
    uploaded.push(`gs://${bucketName}/${destination}`);
  }
  return uploaded;
}

async function listFiles(root: string): Promise<string[]> {
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath);
    if (entry.isFile()) return [fullPath];
    return [];
  }));
  return files.flat();
}
