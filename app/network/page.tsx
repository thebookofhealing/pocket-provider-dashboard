import Link from "next/link";

import { formatInteger } from "@/lib/format";
import { getIndexedHeightCoverage, getIndexerState } from "@/lib/db";
import { getDashboardHealth } from "@/lib/dashboard-health";

export const metadata = {
  title: "Network Status | Pocket Network Analytics",
  description: "Dashboard liveness, freshness, and data-source status for Pocket Network analytics."
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

function getStringState(key: string): string | null {
  return getIndexerState(key);
}

function getPriceState(): { value: number | null; updatedAt: string | null } {
  const raw = getIndexerState("pokt_price_usd");
  if (!raw) return { value: null, updatedAt: null };

  try {
    const parsed = JSON.parse(raw) as { value?: number; updatedAt?: string };
    return {
      value: typeof parsed.value === "number" && Number.isFinite(parsed.value) ? parsed.value : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
    };
  } catch {
    return { value: null, updatedAt: null };
  }
}

function formatIso(value: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "n/a";
  return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium" });
}

export default async function NetworkStatusPage() {
  const dashboardHealth = await getDashboardHealth();
  const health = dashboardHealth.indexer;
  const currentBlockHeight = health.currentBlockHeight;
  const seenHeight = health.seenHeight;
  const ingestedHeight = health.highestIngestedHeight;
  const wsConnected = getStringState("ws_connected") === "true";
  const activeRpc = getStringState("active_rpc");
  const priceState = getPriceState();
  const averageBlockSeconds = Number(process.env.POCKET_INDEXER_AVG_BLOCK_SECONDS ?? 60);
  const retentionDays = Number(process.env.POCKET_INDEXER_RETENTION_DAYS ?? 45);
  const estimatedRetentionBlocks = Math.max(1, Math.round((retentionDays * 24 * 60 * 60) / Math.max(averageBlockSeconds, 1)));
  const rangeEnd = seenHeight ?? ingestedHeight ?? health.contiguousHeight ?? 0;
  const rangeStart = Math.max(1, rangeEnd - estimatedRetentionBlocks + 1);
  const coverage = rangeEnd > 0 ? getIndexedHeightCoverage(rangeStart, rangeEnd) : [];
  const indexedCount = coverage.filter((row) => row.status === "indexed").length;
  const emptyCount = coverage.filter((row) => row.status === "empty").length;
  const coveredCount = indexedCount + emptyCount;
  const missingCount = health.missingHeights;
  const lagBlocks = health.lag;
  const indexerSynced = !health.stale;
  const newestScan = coverage.reduce<string | null>((latest, row) => {
    if (!latest) return row.scanned_at;
    return new Date(row.scanned_at).getTime() > new Date(latest).getTime() ? row.scanned_at : latest;
  }, null);

  return (
    <main className="page explorer-page">
      <section className="panel section explorer-hero network-hero">
        <div>
          <span className="eyebrow">Network Status</span>
          <h1>Dashboard Health Monitoring</h1>
          <p className="section-subtitle" style={{ fontSize: "1.1rem", maxWidth: "640px" }}>
            This page reports liveness of the data displayed on our dashboard.
          </p>
          <div className="window-tabs" style={{ marginTop: "24px" }}>
            <Link href="/" className="calculator-action" style={{ background: "var(--panel-strong)", border: "1px solid var(--border)", color: "var(--text)", boxShadow: "none" }}>
              Back to analytics
            </Link>
          </div>
        </div>

        <div className="explorer-summary-grid">
          <article className="explorer-summary-card panel-inset">
            <span className="hero-highlight-label">Status</span>
            <strong style={{ color: indexerSynced ? "var(--green)" : "var(--red)", whiteSpace: "nowrap" }}>
              {indexerSynced ? "Synced" : "Stale"}
            </strong>
          </article>
          <article className="explorer-summary-card panel-inset">
            <span className="hero-highlight-label">Lag</span>
            <strong className="network-lag-value" style={{ color: indexerSynced ? "var(--accent)" : "var(--orange)" }}>{lagBlocks == null ? "n/a" : `${formatInteger(lagBlocks)} blocks`}</strong>
          </article>
          <article className="explorer-summary-card panel-inset">
            <span className="hero-highlight-label">Retention</span>
            <strong style={{ whiteSpace: "nowrap" }}>{formatInteger(retentionDays)} days</strong>
          </article>
        </div>
      </section>

      <section className="kpi-grid kpi-grid-strong rewards-kpi-grid">
        <article className="panel kpi kpi-primary">
          <span className="kpi-label">Current Block Height</span>
          <span className="kpi-value">{currentBlockHeight == null ? "n/a" : formatInteger(currentBlockHeight)}</span>
          <span className="kpi-foot">Queried directly from the Pocket blockchain</span>
        </article>
        <article className="panel kpi">
          <span className="kpi-label">Latest Seen Height</span>
          <span className="kpi-value">{seenHeight == null ? "n/a" : formatInteger(seenHeight)}</span>
          <span className="kpi-foot">Highest chain height observed by the indexer</span>
        </article>
        <article className="panel kpi">
          <span className="kpi-label">Latest Ingested Height</span>
          <span className="kpi-value">{ingestedHeight == null ? "n/a" : formatInteger(ingestedHeight)}</span>
          <span className="kpi-foot">Highest height successfully processed</span>
        </article>
        <article className="panel kpi">
          <span className="kpi-label">Covered Heights</span>
          <span className="kpi-value" style={{ color: "var(--green)" }}>{formatInteger(coveredCount)}</span>
          <span className="kpi-foot">Indexed or confirmed empty</span>
        </article>
      </section>

      <section className="section-grid rewards-grid">
        <article className="panel section">
          <div className="section-title-row">
            <div>
              <h2 className="section-title">Dataset Breakdown</h2>
              <p className="section-subtitle">Height-level state for the current retention window.</p>
            </div>
          </div>
          <div className="network-coverage-grid network-coverage-grid-three">
            <div className="network-coverage-card density-low"><span>Indexed with events</span><strong>{formatInteger(indexedCount)}</strong></div>
            <div className="network-coverage-card"><span>Confirmed empty</span><strong>{formatInteger(emptyCount)}</strong></div>
            <div className="network-coverage-card density-medium"><span>Missing</span><strong>{formatInteger(missingCount)}</strong></div>
          </div>
        </article>

        <article className="panel section">
          <div className="section-title-row">
            <div>
              <h2 className="section-title">Runtime Notes</h2>
              <p className="section-subtitle">Our indexer powers this dashboard</p>
            </div>
            <span className="pill">Indexer</span>
          </div>
          <div className="insight-list">
            <div className="insight-row"><span className="muted">Request path</span><strong>SQLite snapshots only</strong></div>
            <div className="insight-row"><span className="muted">Live source</span><strong>CometBFT WebSocket + HTTP RPC</strong></div>
            <div className="insight-row"><span className="muted">Repair mode</span><strong>Autonomous retention-window repair</strong></div>
            <div className="insight-row"><span className="muted">Last coverage scan</span><strong>{formatIso(newestScan)}</strong></div>
          </div>
        </article>
      </section>

      <section className="panel section">
        <div className="section-title-row">
          <div>
            <h2 className="section-title">System Status</h2>
            <p className="section-subtitle">Live runtime state for the public indexer and snapshot pipeline.</p>
          </div>
          <span className="pill">Health</span>
        </div>

          <div className="insight-list">
            <div className="insight-row"><span className="muted">Data source</span><strong>{wsConnected ? "CometBFT WebSocket" : "HTTP/RPC fallback"}</strong></div>
            <div className="insight-row"><span className="muted">Active RPC</span><strong className="mono">{activeRpc ?? "n/a"}</strong></div>
            <div className="insight-row"><span className="muted">Dataset freshness</span><strong style={{ color: health.stale ? "var(--orange)" : "var(--green)" }}>{health.stale ? "Stale" : "Current"}</strong></div>
            <div className="insight-row"><span className="muted">Latest indexed block time</span><strong>{formatIso(health.freshnessTimestamp)}</strong></div>
            <div className="insight-row"><span className="muted">Last successful ingestion</span><strong>{formatIso(health.lastSuccessfulCommit)}</strong></div>
            <div className="insight-row"><span className="muted">POKT price</span><strong>{priceState.value == null ? "n/a" : `$${priceState.value.toFixed(4)}`}</strong></div>
            <div className="insight-row"><span className="muted">Price updated</span><strong>{formatIso(priceState.updatedAt)}</strong></div>
            <div className="insight-row"><span className="muted">Current block height</span><strong>{currentBlockHeight == null ? "n/a" : formatInteger(currentBlockHeight)}</strong></div>
            <div className="insight-row"><span className="muted">Height source</span><strong className="mono">{health.currentBlockRpc ?? "n/a"}</strong></div>
          </div>
      </section>
    </main>
  );
}
