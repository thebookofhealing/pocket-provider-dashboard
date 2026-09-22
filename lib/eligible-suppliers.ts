export const ELIGIBLE_SUPPLIER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type EligibleSupplierSnapshot = {
  counts: Record<string, number>;
  fetchedAt: string;
};

export function isEligibleSupplierSnapshotFresh(snapshot: EligibleSupplierSnapshot | null | undefined, now = Date.now()): boolean {
  if (!snapshot) return false;
  const fetchedAt = new Date(snapshot.fetchedAt).getTime();
  return Number.isFinite(fetchedAt) && fetchedAt <= now && now - fetchedAt <= ELIGIBLE_SUPPLIER_MAX_AGE_MS;
}

export function selectEligibleSupplierSnapshot(
  fresh: EligibleSupplierSnapshot | null,
  refreshed: EligibleSupplierSnapshot | null,
  now = Date.now()
): { snapshot: EligibleSupplierSnapshot | null; stale: boolean } {
  if (refreshed) return { snapshot: refreshed, stale: false };
  if (fresh && isEligibleSupplierSnapshotFresh(fresh, now)) return { snapshot: fresh, stale: false };
  return { snapshot: fresh, stale: Boolean(fresh) };
}
