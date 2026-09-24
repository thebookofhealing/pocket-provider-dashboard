export const ELIGIBLE_SUPPLIER_SNAPSHOT_SCHEMA_VERSION = 2 as const;
export const DASHBOARD_CACHE_SCHEMA_VERSION = 2 as const;

export type EligibleCountRecord = {
  eligibleSupplierCount?: number;
  eligibleSupplierCountFetchedAt?: string;
  eligibleSupplierCountStale?: boolean;
};

/** The single readiness predicate shared by the dashboard cache and calculator UI. */
export function hasCompleteEligibleSupplierCounts(records: readonly EligibleCountRecord[]): boolean {
  return records.length > 0 && records.every((record) =>
    typeof record.eligibleSupplierCount === "number" &&
    Number.isFinite(record.eligibleSupplierCount) &&
    typeof record.eligibleSupplierCountFetchedAt === "string" &&
    record.eligibleSupplierCountFetchedAt.length > 0 &&
    record.eligibleSupplierCountStale === false
  );
}
