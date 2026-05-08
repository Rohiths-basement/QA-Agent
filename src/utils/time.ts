export function nowIso(): string {
  return new Date().toISOString();
}

export function createRunId(prefix = "qa"): string {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}_${random}`;
}
