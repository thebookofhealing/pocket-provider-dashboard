export const DEFAULT_INDEXER_STALE_AFTER_MS = 15 * 60 * 1000;

type IndexerFreshnessInput = {
  latestIndexedBlockTime: number | null;
  lastSuccessfulCommit: string | null;
  nowMs?: number;
  staleAfterMs?: number;
};

export type IndexerFreshness = {
  stale: boolean;
  freshnessAgeMs: number | null;
  freshnessTimestamp: string | null;
  staleAfterMs: number;
};

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function getIndexerFreshness({
  latestIndexedBlockTime,
  lastSuccessfulCommit,
  nowMs = Date.now(),
  staleAfterMs = DEFAULT_INDEXER_STALE_AFTER_MS,
}: IndexerFreshnessInput): IndexerFreshness {
  const threshold = Number.isFinite(staleAfterMs) && staleAfterMs > 0
    ? staleAfterMs
    : DEFAULT_INDEXER_STALE_AFTER_MS;
  const indexedBlockTimestamp = Number.isFinite(latestIndexedBlockTime) && latestIndexedBlockTime != null && latestIndexedBlockTime > 0
    ? latestIndexedBlockTime
    : null;
  // Dataset freshness is based on chain time. The ingestion heartbeat is only
  // a fallback for a new database that has not persisted block metadata yet;
  // an active historical backfill must not make stale chain data look current.
  const freshestTimestamp = indexedBlockTimestamp ?? parseTimestamp(lastSuccessfulCommit);
  const freshnessAgeMs = freshestTimestamp == null ? null : Math.max(0, nowMs - freshestTimestamp);

  return {
    stale: freshnessAgeMs == null || freshnessAgeMs > threshold,
    freshnessAgeMs,
    freshnessTimestamp: freshestTimestamp == null ? null : new Date(freshestTimestamp).toISOString(),
    staleAfterMs: threshold,
  };
}
