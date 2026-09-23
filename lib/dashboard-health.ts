import { getIndexerHealth, getIndexerState, isDatabaseReadOnly } from "@/lib/db";
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
      serviceCount: typeof parsed.serviceCount === "number" ? parsed.serviceCount : 0,
      status: typeof parsed.status === "string" ? parsed.status : "unknown"
    };
  } catch {
    return { fetchedAt: null, stale: true, serviceCount: 0, status: "invalid" };
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
      staking: getStakingDiagnostics(),
      deployedSha: getDeployedSha()
    }
  };
}
