export function envString(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

export function requiredEnv(name: string): string {
  const value = envString(name);
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function envNumber(name: string, fallback: number): number {
  const value = envString(name);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function envBoolean(name: string, fallback = false): boolean {
  const value = envString(name);
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
