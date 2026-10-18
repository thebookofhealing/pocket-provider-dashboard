export const ELIGIBLE_SUPPLIER_SNAPSHOT_SCHEMA_VERSION = 2 as const;
export const DASHBOARD_CACHE_SCHEMA_VERSION = 2 as const;

export type EligibleCountRecord = {
  eligibleSupplierCount?: number;
  eligibleSupplierCountFetchedAt?: string;
  eligibleSupplierCountStale?: boolean;
};

export type DashboardCacheContract = {
  dashboardSchemaVersion?: number;
  eligibleSupplierSnapshotSchemaVersion?: number;
  eligibleSupplierSnapshotComplete?: boolean;
  eligibleSupplierSnapshotFetchedAt?: string;
  eligibleSupplierSnapshotStale?: boolean;
  eligibleSupplierSnapshotSource?: string;
  services: readonly EligibleCountRecord[];
};

/** Dashboard pages can render structurally complete counts even while they are stale. */
export function hasStructurallyCompleteEligibleSupplierCounts(records: readonly EligibleCountRecord[]): boolean {
  return records.length > 0 && records.every((record) =>
    typeof record.eligibleSupplierCount === "number" &&
    Number.isFinite(record.eligibleSupplierCount) &&
    typeof record.eligibleSupplierCountFetchedAt === "string" &&
    record.eligibleSupplierCountFetchedAt.length > 0 &&
    typeof record.eligibleSupplierCountStale === "boolean"
  );
}

/** Calculator projections require counts that are both complete and fresh. */
export function hasCompleteEligibleSupplierCounts(records: readonly EligibleCountRecord[]): boolean {
  return hasStructurallyCompleteEligibleSupplierCounts(records) && records.every((record) => record.eligibleSupplierCountStale === false);
}

/** A dashboard can be served when its data shape is complete; freshness is a separate calculator concern. */
export function hasStructurallyServableDashboard(data: DashboardCacheContract): boolean {
  return data.dashboardSchemaVersion === DASHBOARD_CACHE_SCHEMA_VERSION &&
    data.eligibleSupplierSnapshotSchemaVersion === ELIGIBLE_SUPPLIER_SNAPSHOT_SCHEMA_VERSION &&
    data.eligibleSupplierSnapshotComplete === true &&
    typeof data.eligibleSupplierSnapshotFetchedAt === "string" &&
    data.eligibleSupplierSnapshotFetchedAt.length > 0 &&
    typeof data.eligibleSupplierSnapshotStale === "boolean" &&
    typeof data.eligibleSupplierSnapshotSource === "string" &&
    data.eligibleSupplierSnapshotSource.length > 0 &&
    Array.isArray(data.services) &&
    data.services.length > 0 &&
    hasStructurallyCompleteEligibleSupplierCounts(data.services);
}
