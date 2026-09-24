import { isEligibleSupplierSnapshotComplete, isEligibleSupplierSnapshotReusable, type EligibleSupplierSnapshot } from "@/lib/eligible-suppliers";

export type EligibleSupplierCountsSnapshot = EligibleSupplierSnapshot & {
  stale: boolean;
  source: "rest" | "poktscan-graphql" | "persisted-lkg";
};

export type EligibleSupplierSourceFetcher = {
  rest: () => Promise<EligibleSupplierCountsSnapshot>;
  graphql: () => Promise<EligibleSupplierCountsSnapshot>;
};

/**
 * Resolve eligible counts without mixing freshness windows: fresh local data
 * wins, then a complete REST/GraphQL refresh, then a complete stale LKG.
 */
export async function resolveEligibleSupplierCounts(
  knownServiceIds: ReadonlySet<string>,
  cached: EligibleSupplierCountsSnapshot | null,
  persisted: EligibleSupplierSnapshot | null,
  fetchers: EligibleSupplierSourceFetcher,
  now = Date.now()
): Promise<EligibleSupplierCountsSnapshot> {
  if (cached && isEligibleSupplierSnapshotReusable(cached, knownServiceIds, now)) return cached;
  if (persisted && isEligibleSupplierSnapshotReusable(persisted, knownServiceIds, now)) {
    return { ...persisted, stale: false, source: "persisted-lkg" };
  }

  let restError: unknown;
  try {
    return await fetchers.rest();
  } catch (error) {
    restError = error;
  }

  try {
    return await fetchers.graphql();
  } catch {
    if (cached && isEligibleSupplierSnapshotComplete(cached, knownServiceIds)) {
      return { ...cached, stale: true, source: "persisted-lkg" };
    }
    if (persisted && isEligibleSupplierSnapshotComplete(persisted, knownServiceIds)) {
      return { ...persisted, stale: true, source: "persisted-lkg" };
    }
    throw restError;
  }
}
