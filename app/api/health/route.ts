import { getIndexerHealth, isDatabaseReadOnly } from "@/lib/db";
import { DEFAULT_INDEXER_STALE_AFTER_MS, getIndexerFreshness } from "@/lib/indexer-freshness";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = getIndexerHealth();
  const readOnly = isDatabaseReadOnly();

  const contiguousHeight = health.processedHeight ?? 0;
  const seenHeight = health.targetHeight ?? 0;
  const lag = Math.max(0, seenHeight - contiguousHeight);
  const freshness = getIndexerFreshness({
    latestIndexedBlockTime: health.latestIndexedBlockTime,
    lastSuccessfulCommit: health.lastSuccessfulCommit,
    staleAfterMs: Number(process.env.POCKET_INDEXER_STALE_AFTER_MS ?? DEFAULT_INDEXER_STALE_AFTER_MS),
  });

  const degraded =
    freshness.stale ||
    health.failedHeights > 0 ||
    health.missingHeights > 0 ||
    health.emptyNullTimestamps > 0 ||
    (health.partialWorkloadHeights ?? 0) > 0 ||
    (health.partialRewardHeights ?? 0) > 0;

  return Response.json({
    status: freshness.stale ? "stale" : readOnly ? "ready" : "writing",
    dataVersion: health.dataVersion,
    degraded,
    indexer: {
      isLocked: health.isLocked,
      contiguousHeight,
      highestIngestedHeight: health.ingestedHeight,
      seenHeight,
      lag,
      lagReliable: !freshness.stale,
      stale: freshness.stale,
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
      lastBackup: health.lastBackup,
    },
  });
}
