export const ELIGIBLE_SUPPLIER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type EligibleSupplierSnapshot = {
  counts: Record<string, number>;
  fetchedAt: string;
};

export type EligibleSupplierPage = {
  supplier?: Array<{
    operator_address?: string;
    services?: Array<{ service_id?: string }>;
  }>;
};

export function isEligibleSupplierSnapshotComplete(
  snapshot: EligibleSupplierSnapshot,
  knownServiceIds: ReadonlySet<string>
): boolean {
  return knownServiceIds.size > 0 && Array.from(knownServiceIds).every((serviceId) =>
    Object.prototype.hasOwnProperty.call(snapshot.counts, serviceId)
  );
}

export function isEligibleSupplierSnapshotReusable(
  snapshot: EligibleSupplierSnapshot,
  knownServiceIds: ReadonlySet<string>,
  now = Date.now()
): boolean {
  return isEligibleSupplierSnapshotFresh(snapshot, now) && isEligibleSupplierSnapshotComplete(snapshot, knownServiceIds);
}

/** Aggregates current active supplier services only after every page is available. */
export function aggregateEligibleSupplierCounts(
  pages: ReadonlyArray<EligibleSupplierPage>,
  knownServiceIds?: ReadonlySet<string>
): Record<string, number> {
  if (pages.length === 0) throw new Error("eligible supplier refresh returned no pages");
  const operatorsByService = new Map<string, Set<string>>();
  for (const page of pages) {
    for (const supplier of page.supplier ?? []) {
      if (!supplier.operator_address) continue;
      for (const service of supplier.services ?? []) {
        if (!service.service_id) continue;
        const operators = operatorsByService.get(service.service_id) ?? new Set<string>();
        operators.add(supplier.operator_address);
        operatorsByService.set(service.service_id, operators);
      }
    }
  }
  const observedServiceIds = Array.from(operatorsByService.keys());
  if (knownServiceIds && knownServiceIds.size > 0 && observedServiceIds.length > 0 && !observedServiceIds.some((serviceId) => knownServiceIds.has(serviceId))) {
    throw new Error("eligible supplier refresh returned no known active services");
  }
  if (knownServiceIds && knownServiceIds.size > 0) {
    // A complete pagination pass is authoritative even when a known service
    // currently has no active suppliers. Publish that service as zero rather
    // than making the calculator treat it as missing data.
    const counts = Object.fromEntries(Array.from(knownServiceIds).map((serviceId) => [serviceId, 0]));
    for (const [serviceId, operators] of operatorsByService) {
      if (knownServiceIds.has(serviceId)) counts[serviceId] = operators.size;
    }
    return counts;
  }
  const counts = Object.fromEntries(Array.from(operatorsByService.entries()).map(([serviceId, operators]) => [serviceId, operators.size]));
  if (Object.keys(counts).length === 0) throw new Error("eligible supplier refresh returned no active service counts");
  return counts;
}

export function isEligibleSupplierSnapshotFresh(snapshot: EligibleSupplierSnapshot | null | undefined, now = Date.now()): boolean {
  if (!snapshot) return false;
  const fetchedAt = new Date(snapshot.fetchedAt).getTime();
  return Number.isFinite(fetchedAt) && fetchedAt <= now && now - fetchedAt <= ELIGIBLE_SUPPLIER_MAX_AGE_MS;
}

export function selectEligibleSupplierSnapshot(
  fresh: EligibleSupplierSnapshot | null,
  refreshed: EligibleSupplierSnapshot | null,
  now = Date.now(),
  knownServiceIds?: ReadonlySet<string>
): { snapshot: EligibleSupplierSnapshot | null; stale: boolean } {
  if (refreshed) return { snapshot: refreshed, stale: false };
  if (fresh && (knownServiceIds ? isEligibleSupplierSnapshotReusable(fresh, knownServiceIds, now) : isEligibleSupplierSnapshotFresh(fresh, now))) {
    return { snapshot: fresh, stale: false };
  }
  return { snapshot: fresh, stale: Boolean(fresh) };
}
