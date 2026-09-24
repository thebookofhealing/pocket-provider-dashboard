import { getDashboardCache, getIndexerHealth, getIndexerState, isDatabaseReadOnly } from "@/lib/db";
import { DEFAULT_INDEXER_STALE_AFTER_MS, getIndexerFreshness } from "@/lib/indexer-freshness";
import { getCurrentBlockHeight } from "@/lib/rpc-status";
import { getStakingDiagnostics } from "@/lib/staking-plans";
import { getDeployedSha } from "@/lib/deployment";

export const INDEXER_SYNC_LAG_THRESHOLD = 15;

function readEligibleSupplierDiagnostics(): Record<string, unknown> {
  const raw = getIndexerState("eligible_supplier_diagnostics");
  if (!raw) return { fetchedAt: null, stale: true, serviceCount: 0, status: "unknown" };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : null,
      stale: parsed.stale === true,
      schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : null,
      complete: parsed.complete === true,
      serviceRegistrySource: typeof parsed.serviceRegistrySource === "string" ? parsed.serviceRegistrySource : "unknown",
      knownServiceCount: typeof parsed.knownServiceCount === "number" ? parsed.knownServiceCount : 0,
      countedServiceCount: typeof parsed.countedServiceCount === "number" ? parsed.countedServiceCount : 0,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
      serviceCount: typeof parsed.serviceCount === "number" ? parsed.serviceCount : 0,
      status: typeof parsed.status === "string" ? parsed.status : "unknown"
    };
  } catch {
    return { fetchedAt: null, stale: true, serviceCount: 0, status: "invalid" };
  }
}

function readDashboardMaterializationDiagnostics(): Record<string, unknown> {
  const cached = getDashboardCache("30d");
  if (!cached) return { schemaVersion: null, generatedAt: null, serviceCount: 0, eligibleCount: 0, staleCount: 0, top5: [] };
  try {
    const parsed = JSON.parse(cached.payloadJson) as Record<string, unknown>;
    const services = Array.isArray(parsed.services) ? parsed.services.filter((service): service is Record<string, unknown> => Boolean(service && typeof service === "object")) : [];
    const eligible = services.filter((service) => typeof service.eligibleSupplierCount === "number" && Number.isFinite(service.eligibleSupplierCount));
    const stale = services.filter((service) => service.eligibleSupplierCountStale === true);
    return {
      schemaVersion: typeof parsed.dashboardSchemaVersion === "number" ? parsed.dashboardSchemaVersion : null,
      eligibleSnapshotSchemaVersion: typeof parsed.eligibleSupplierSnapshotSchemaVersion === "number" ? parsed.eligibleSupplierSnapshotSchemaVersion : null,
      eligibleSnapshotComplete: parsed.eligibleSupplierSnapshotComplete === true,
      eligibleSnapshotFetchedAt: typeof parsed.eligibleSupplierSnapshotFetchedAt === "string" ? parsed.eligibleSupplierSnapshotFetchedAt : null,
      eligibleSnapshotStale: parsed.eligibleSupplierSnapshotStale === true,
      eligibleSnapshotSource: typeof parsed.eligibleSupplierSnapshotSource === "string" ? parsed.eligibleSupplierSnapshotSource : null,
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : null,
      serviceCount: services.length,
      eligibleCount: eligible.length,
      staleCount: stale.length,
      top5: services.slice(0, 5).map((service) => ({ serviceId: service.serviceId ?? null, eligibleSupplierCount: service.eligibleSupplierCount ?? null, eligibleSupplierCountStale: service.eligibleSupplierCountStale ?? null }))
    };
  } catch {
    return { schemaVersion: null, generatedAt: null, serviceCount: 0, eligibleCount: 0, staleCount: 0, top5: [], error: "invalid dashboard cache" };
  }
}

export async function getDashboardHealth() {
  const health = getIndexerHealth();
  const readOnly = isDatabaseReadOnly();
  const currentBlock = await getCurrentBlockHeight();
  const freshness = getIndexerFreshness({
    latestIndexedBlockTime: health.latestIndexedBlockTime,
    lastSuccessfulCommit: health.lastSuccessfulCommit,
    staleAfterMs: Number(process.env.POCKET_INDEXER_STALE_AFTER_MS ?? DEFAULT_INDEXER_STALE_AFTER_MS)
  });

  const contiguousHeight = health.processedHeight ?? 0;
  const seenHeight = health.targetHeight ?? 0;
  const lag = currentBlock ? Math.max(0, currentBlock.height - contiguousHeight) : null;
  const lagReliable = currentBlock != null && !freshness.stale;
  const stale = freshness.stale || !lagReliable || lag == null || lag >= INDEXER_SYNC_LAG_THRESHOLD;
  const degraded =
    stale ||
    health.failedHeights > 0 ||
    health.missingHeights > 0 ||
    health.emptyNullTimestamps > 0 ||
    (health.partialWorkloadHeights ?? 0) > 0 ||
    (health.partialRewardHeights ?? 0) > 0;

  return {
    status: stale ? "stale" : readOnly ? "ready" : "writing",
    dataVersion: health.dataVersion,
    degraded,
    indexer: {
      isLocked: health.isLocked,
      currentBlockHeight: currentBlock?.height ?? null,
      currentBlockRpc: currentBlock?.rpcUrl ?? null,
      contiguousHeight,
      highestIngestedHeight: health.ingestedHeight,
      seenHeight,
      lag,
      lagReliable,
      stale,
      freshnessAgeMs: freshness.freshnessAgeMs,
      freshnessTimestamp: freshness.freshnessTimestamp,
      staleAfterMs: freshness.staleAfterMs,
      latestIndexedBlockTime: health.latestIndexedBlockTime == null
        ? null
        : new Date(health.latestIndexedBlockTime).toISOString(),
      lastIndexedAt: health.lastIndexedAt,
      gaps: health.gaps,
      failedHeights: health.failedHeights,
      missingHeights: health.missingHeights,
      emptyNullTimestamps: health.emptyNullTimestamps,
      partialWorkloadHeights: health.partialWorkloadHeights,
      partialRewardHeights: health.partialRewardHeights,
      lastSuccessfulCommit: health.lastSuccessfulCommit,
      lastBackup: health.lastBackup
    },
    diagnostics: {
      eligibleSuppliers: readEligibleSupplierDiagnostics(),
      dashboard: readDashboardMaterializationDiagnostics(),
      staking: getStakingDiagnostics(),
      deployedSha: getDeployedSha()
    }
  };
}
