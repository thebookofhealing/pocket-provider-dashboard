export const LIVE_ECONOMICS_MAX_AGE_MS = 15 * 60 * 1000;

export type PlanEconomics = {
  grossDailyPokt: number;
  netDailyPokt: number;
  apr: number;
};

export function derivePlanEconomics(grossSevenDayUpoktPerSupplier: number, clientShare: number, minimumSupplierStakePokt: number): PlanEconomics {
  if (!Number.isFinite(grossSevenDayUpoktPerSupplier) || grossSevenDayUpoktPerSupplier < 0) throw new Error("gross reward input must be non-negative");
  if (!Number.isFinite(clientShare) || clientShare < 0 || clientShare > 100) throw new Error("client share must be between 0 and 100");
  if (!Number.isFinite(minimumSupplierStakePokt) || minimumSupplierStakePokt <= 0) throw new Error("minimum supplier stake must be positive");
  const grossDailyPokt = grossSevenDayUpoktPerSupplier / 1_000_000 / 7;
  const netDailyPokt = grossDailyPokt * clientShare / 100;
  return { grossDailyPokt, netDailyPokt, apr: netDailyPokt * 365 / minimumSupplierStakePokt * 100 };
}

export function isSourceFresh(sourceUpdatedAt: string | null | undefined, now = Date.now(), maxAgeMs = LIVE_ECONOMICS_MAX_AGE_MS): boolean {
  if (!sourceUpdatedAt) return false;
  const numericTimestamp = Number(sourceUpdatedAt);
  const sourceTime = Number.isFinite(numericTimestamp) && numericTimestamp > 100_000_000_000
    ? numericTimestamp
    : new Date(sourceUpdatedAt).getTime();
  return Number.isFinite(sourceTime) && sourceTime <= now && now - sourceTime <= maxAgeMs;
}

export function normalizeSourceTimestamp(sourceUpdatedAt: string | null | undefined): string | null {
  if (!sourceUpdatedAt) return null;
  const numericTimestamp = Number(sourceUpdatedAt);
  const time = Number.isFinite(numericTimestamp) && numericTimestamp > 100_000_000_000
    ? numericTimestamp
    : new Date(sourceUpdatedAt).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
