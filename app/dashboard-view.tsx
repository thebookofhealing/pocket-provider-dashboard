"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import {
  formatCompactNumber,
  formatDecimal,
  formatInteger,
  formatPercent,
  formatRelativeRange,
  formatUsd,
  formatUpokt
} from "@/lib/format";
import type {
  SerializedDashboardData,
  SerializedNetworkDailyHistoryPoint,
  TimeWindow
} from "@/lib/types";

const WINDOWS: TimeWindow[] = ["24h", "7d", "30d"];
const WARMING_RETRY_MS = 5_000;

type DashboardViewProps = {
  initialWindow: TimeWindow;
  dataByWindow: Record<TimeWindow, SerializedDashboardData | null>;
  networkHistory: SerializedNetworkDailyHistoryPoint[];
};

type DashboardApiResponse = SerializedDashboardData | { status: "warming" | "ready" };

function toBigInt(value: string): bigint {
  return BigInt(value);
}

function toPoktNumber(value: string): number {
  return Number(toBigInt(value)) / 1_000_000;
}

function compareRevenueDesc<T extends { revenueUpokt: string }>(a: T, b: T): number {
  const aRevenue = BigInt(a.revenueUpokt);
  const bRevenue = BigInt(b.revenueUpokt);
  if (aRevenue === bRevenue) return 0;
  return bRevenue > aRevenue ? 1 : -1;
}

function buildNetworkTrendPaths(points: Array<{ revenue: number; rewardCompleteness?: string }>, maxRevenue: number): string[] {
  if (points.length === 0 || maxRevenue === 0) return [];

  const segments: Array<Array<{ revenue: number }>> = [];
  let current: Array<{ revenue: number }> = [];
  for (const point of points) {
    if (point.rewardCompleteness === "partial" || point.rewardCompleteness === "missing") {
      if (current.length > 0) { segments.push(current); current = []; }
    } else {
      current.push(point);
    }
  }
  if (current.length > 0) segments.push(current);

  if (segments.length === 0) return [];

  // Each segment maps its own x-coordinates within the full width
  const total = points.length;
  return segments.map((segment) => {
    return segment.map((point, index) => {
      const globalIndex = points.indexOf(point);
      const x = total === 1 ? 50 : (globalIndex / (total - 1)) * 100;
      const y = 100 - (Math.max(0, point.revenue) / maxRevenue) * 100;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(" ");
  });
}

function NetworkTrendPanel({ history }: { history: SerializedNetworkDailyHistoryPoint[] }) {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const candidatePoints = history
    .filter((point) => point.day < todayUtc)
    .slice(-30);
  const daysWithCU = candidatePoints.filter((p) => (p.estimatedComputeUnits ?? 0) > 0).length;
  const allDaysHaveCU = daysWithCU === candidatePoints.length && candidatePoints.length > 0;
  const useCU = allDaysHaveCU;
  const trendPoints = candidatePoints.map((point) => ({
    day: point.day,
    revenue: toPoktNumber(point.revenueUpokt),
    cuLoad: useCU ? point.estimatedComputeUnits! : point.relays,
    workloadCompleteness: point.workloadCompleteness ?? "complete",
    rewardCompleteness: point.rewardCompleteness ?? "complete"
  }));
  const rewardCompleteOnly = trendPoints.filter((p) => p.rewardCompleteness === "complete");
  const workloadCompleteOnly = trendPoints.filter((p) => p.workloadCompleteness === "complete");
  const maxRevenue = Math.max(...(rewardCompleteOnly.length > 0 ? rewardCompleteOnly : trendPoints).map((point) => point.revenue), 0);
  const maxCULoad = Math.max(...trendPoints.map((point) => point.cuLoad), 0);
  const latestRewardPoint = rewardCompleteOnly.at(-1);
  const latestWorkloadPoint = workloadCompleteOnly.at(-1);
  const totalRevenue = rewardCompleteOnly.reduce((sum, point) => sum + point.revenue, 0);
  const totalRewardDays = rewardCompleteOnly.length;
  const totalCULoad = workloadCompleteOnly.reduce((sum, point) => sum + point.cuLoad, 0);
  const totalWorkloadDays = workloadCompleteOnly.length;
  const linePaths = buildNetworkTrendPaths(trendPoints, maxRevenue);
  const hasHistory = trendPoints.length > 0;
  const completeRewardDays = rewardCompleteOnly.length;
  const completeWorkloadDays = workloadCompleteOnly.length;

  return (
    <section className="panel section network-trend-panel themed section-theme-demand" style={{ position: 'relative' }}>
      <div className="section-title-row">
        <div>
          <span className="eyebrow eyebrow-ghost">Market</span>
          <h2 className="section-title">Network Trend</h2>
          <p className="section-subtitle">Daily rewards and finalized compute unit demand over the last 30 days.</p>
        </div>
        <span className="pill" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text)' }}>Last 30 Completed UTC Days</span>
      </div>

      {completeRewardDays < 30 || completeWorkloadDays < 30 ? (
        <p className="footer-note">
          Historical repair in progress. {completeRewardDays}/30 reward days and {completeWorkloadDays}/30 workload days are fully verified.
        </p>
      ) : null}

      {hasHistory ? (
        <>
          <div className="network-trend-metrics">
            <div className="panel-inset">
              <span className="hero-highlight-label">Latest Rewards</span>
              <strong style={{ color: 'var(--yellow-primary)' }}>{latestRewardPoint ? `${formatDecimal(latestRewardPoint.revenue, 1)} POKT` : "n/a"}</strong>
            </div>
            <div className="panel-inset">
              <span className="hero-highlight-label">{useCU ? "Latest CU" : "Latest Relays"}</span>
              <strong style={{ color: 'var(--green)' }}>{latestWorkloadPoint ? formatCompactNumber(latestWorkloadPoint.cuLoad) : "n/a"}</strong>
            </div>
            <div className="panel-inset">
              <span className="hero-highlight-label">{totalRewardDays === 30 ? "Window Rewards" : "Known Rewards"}</span>
              <strong>{formatDecimal(totalRevenue, 1)} POKT</strong>
              {totalRewardDays < 30 && <span className="muted" style={{ fontSize: '0.75rem' }}>({totalRewardDays}/30 complete)</span>}
            </div>
            <div className="panel-inset">
              <span className="hero-highlight-label">{totalWorkloadDays === 30 ? (useCU ? "Window CU" : "Window Relays") : (useCU ? "Known CU" : "Known Relays")}</span>
              <strong>{formatCompactNumber(totalCULoad)}</strong>
              {totalWorkloadDays < 30 && <span className="muted" style={{ fontSize: '0.75rem' }}>({totalWorkloadDays}/30 complete)</span>}
            </div>
          </div>

          <div className="network-trend-chart" aria-label="Network revenue and workload trend chart" style={{ gridTemplateColumns: `repeat(${trendPoints.length}, 1fr)` }}>
            <div className="network-trend-gridlines" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
            <svg className="network-trend-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {linePaths.map((d, i) => <path key={i} d={d} />)}
            </svg>
            {trendPoints.map((point) => {
              const isMissing = point.workloadCompleteness === "missing";
              const isPartial = point.workloadCompleteness === "partial";
              const barValue = isMissing ? 0 : point.cuLoad;
              const height = isMissing ? 2 : (maxCULoad === 0 ? 2 : Math.max(4, Math.round((barValue / maxCULoad) * 100)));
              const isActive = point === latestWorkloadPoint;
              const loadUnit = useCU ? "CU" : "relays";

              return (
                <div key={point.day} className="network-trend-bar-group" title={`${point.day}: ${isMissing ? "no data" : `${formatCompactNumber(point.cuLoad)} ${loadUnit}, ${formatDecimal(point.revenue, 1)} POKT`}`}>
                  <div
                    className="network-trend-bar"
                    style={{
                      height: `${height}%`,
                      background: isMissing ? 'var(--muted)' : isPartial ? 'linear-gradient(180deg, rgba(255,255,255,0.15), rgba(255,255,255,0.05))' : undefined,
                      boxShadow: isActive ? '0 0 20px rgba(25, 195, 125, 0.25)' : undefined
                    }}
                  />
                  <span>{point.day.slice(5)}</span>
                </div>
              );
            })}
          </div>

          <p className="footer-note network-trend-legend">
            <span>
              <span className="network-trend-legend-bar" />
              Daily {useCU ? "compute units" : "relays"}
            </span>
            <span>
              <span className="network-trend-legend-line" />
              Daily rewards, independently scaled
            </span>
          </p>
        </>
      ) : trendPoints.length === 0 ? (
        <p className="footer-note">Network history is currently unavailable.</p>
      ) : null}
    </section>
  );
}

export default function DashboardView({ initialWindow, dataByWindow, networkHistory }: DashboardViewProps) {
  const [datasets, setDatasets] = useState<Record<TimeWindow, SerializedDashboardData | null>>(dataByWindow);
  const [window, setWindow] = useState<TimeWindow>(initialWindow);
  const [isPending, startTransition] = useTransition();
  const data = useMemo(() => datasets[window] ?? datasets[initialWindow], [datasets, initialWindow, window]);

  function loadWindow(entry: TimeWindow, activate = false) {
    if (datasets[entry]) {
      if (activate) {
        setWindow(entry);
      }
      return;
    }

    void fetch(`/api/dashboard?window=${entry}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok && response.status !== 202) {
          return null;
        }

        return (await response.json()) as DashboardApiResponse;
      })
      .then((payload) => {
        if (!payload || "status" in payload) {
          return;
        }

        startTransition(() => {
          setDatasets((current) => ({ ...current, [entry]: payload }));
          if (activate) {
            setWindow(entry);
          }
        });
      })
      .catch(() => {
        // Leave the current view in place if this background request fails.
      });
  }

  useEffect(() => {
    const missingWindows = WINDOWS.filter((entry) => !datasets[entry]);
    if (missingWindows.length === 0) {
      return;
    }

    loadWindow(missingWindows[0], false);

    const retryId = globalThis.setInterval(() => {
      loadWindow(missingWindows[0], false);
    }, WARMING_RETRY_MS);

    return () => globalThis.clearInterval(retryId);
  }, [datasets]);

  if (!data) {
    return (
      <main className="page">
        <section className="hero hero-stack">
          <div className="panel hero-showcase">
            <div className="hero-main">
              <div className="hero-copy hero-copy-strong">
                <span className="eyebrow">Pocket Network</span>
                <h1>Pocket Network Public Analytics.</h1>
                <p>
                  Public service demand, relay, and reward analytics built from indexed Pocket settlement events.
                  No named provider rankings, provider pages, or operator-level playbooks are exposed.
                </p>

                <div className="window-tabs" aria-label="time windows">
                  {WINDOWS.map((entry) => {
                    const active = entry === window;
                    return (
                      <button
                        key={entry}
                        type="button"
                        className={`window-tab${active ? " active" : ""}`}
                        onClick={() => loadWindow(entry, true)}
                      >
                        {entry}
                      </button>
                    );
                  })}
                </div>
              </div>

              <aside className="hero-side panel panel-inset">
                <div className="section-title-row compact-gap">
                  <h2 className="section-title">Status</h2>
                  <span className="pill">Calibrating market data</span>
                </div>
                <div className="insight-list">
                  <div className="insight-row">
                    <span className="muted">Initial dataset</span>
                    <strong>Refreshing in background</strong>
                  </div>
                  <div className="insight-row">
                    <span className="muted">Experience mode</span>
                    <strong>Instant shell, no blocking</strong>
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </section>
      </main>
    );
  }

  const servicesByRevenue = [...data.services].sort(compareRevenueDesc);
  const topService = servicesByRevenue[0];
  const cuCoverageComplete = (data.computeUnitCoverage ?? 0) >= 1;
  const indexerLag =
    data.indexerTargetHeight != null && data.indexerProcessedHeight != null
      ? Math.max(0, data.indexerTargetHeight - data.indexerProcessedHeight)
      : null;
  return (
    <main className="page">
      <section className="hero hero-stack dashboard-hero">
        <div className="panel hero-showcase dashboard-hero-showcase">
          <div className="dashboard-hero-orb" />

          <div className="hero-main dashboard-hero-main">
            <div className="hero-copy hero-copy-strong dashboard-hero-copy">
              <span className="eyebrow">Network Analytics</span>
              <h1>Serve Relays, Earn POKT.</h1>
              <p>
                On-chain data for providers to identify opportunities on Pocket Network.
              </p>

              <div className="window-tabs" aria-label="time windows">
                {WINDOWS.map((entry) => {
                  const active = entry === window;
                  return (
                    <button
                      key={entry}
                      type="button"
                      className={`window-tab${active ? " active" : ""}`}
                      onClick={() => loadWindow(entry, true)}
                    >
                      {entry === "24h" ? "24 hours" : entry === "7d" ? "Weekly" : entry === "30d" ? "Monthly" : "Yearly"}
                    </button>
                  );
                })}
              </div>

              <div className="hero-highlight-grid dashboard-primary-metrics">
                <div className="hero-highlight metric-glow-revenue">
                  <span className="hero-highlight-label">Reward Pool</span>
                  <strong className="accent-number">{formatUpokt(toBigInt(data.totalRevenueUpokt), 1)}</strong>
                  <p>Total rewards distributed in the selected period.</p>
                </div>
                <div className="hero-highlight metric-glow-demand">
                  <span className="hero-highlight-label">Estimated USD Value</span>
                  <strong className="accent-number">{formatUsd(toPoktNumber(data.totalRevenueUpokt) * data.poktPriceUsd, 1)}</strong>
                  <p>POKT rewards valued at the latest available market price.</p>
                </div>
              </div>
            </div>

            <aside className="hero-side panel-inset network-pulse-card">
              <div className="section-title-row compact-gap">
                <div>
                  <span className="eyebrow eyebrow-ghost">Live On-chain Data</span>
                  <h2 className="section-title">Network Information</h2>
                  <p className="muted">Integrate your RPC nodes with Pocket Network to maximize your revenues.</p>
                </div>
                <span className="pill">{indexerLag == null || indexerLag <= 10 ? "Synced" : "Catching up"}</span>
              </div>
              <div className="network-pulse-grid">
                <div>
                  <span title="Privacy-safe provider cohorts inferred from observed domains, owners, and suppliers. This is not a named operator ranking.">Unique Providers</span>
                  <strong>{formatInteger(data.activeProviders)}</strong>
                </div>
                <div>
                  <span>Chains with Activity</span>
                  <strong>{formatInteger(data.activeChains)}</strong>
                </div>
                <div>
                  <span>Relays</span>
                  <strong>{formatCompactNumber(data.totalRelays)}</strong>
                </div>
                <div>
                  <span>{cuCoverageComplete ? "Compute Units" : "Known Compute Units"}</span>
                  <strong>{formatCompactNumber(data.totalEstimatedComputeUnits)}</strong>
                  {!cuCoverageComplete && <span className="muted" style={{ fontSize: '0.7rem' }}>Partial coverage</span>}
                </div>
              </div>
              <div className="network-pulse-footer">
                <span>Height <strong>{formatInteger(data.latestHeight)}</strong></span>
                {indexerLag != null && <span>Lag <strong>{formatInteger(indexerLag)} blocks</strong></span>}
              </div>
            </aside>
          </div>

          <div className="hero-support-grid" style={{ gridTemplateColumns: "1fr", marginTop: "32px" }}>
            <article className="panel narrative-card dashboard-insight-card">
              <span className="eyebrow eyebrow-ghost">Highlights</span>
              <h2>Pocket Network Highlights.</h2>
              <ul className="narrative-points">
                <li>
                  <strong>{topService ? topService.serviceName : "n/a"}</strong> is the top reward chain in this period.
                </li>
                <li>
                  {data.totalEstimatedComputeUnits > 0 && cuCoverageComplete ? (
                    <><strong>{formatDecimal((() => { const r = toPoktNumber(data.totalRevenueUpokt); return data.totalEstimatedComputeUnits > 0 ? (r / data.totalEstimatedComputeUnits) * 1_000_000_000 : 0; })(), 2)} POKT</strong> (${formatUsd((() => { const r = toPoktNumber(data.totalRevenueUpokt); return data.totalEstimatedComputeUnits > 0 ? (r / data.totalEstimatedComputeUnits) * 1_000_000_000 : 0; })() * data.poktPriceUsd, 2)}) earned per 1B estimated compute units.
                    </>
                  ) : (
                    <>POKT per 1B CU: n/a. Compute-unit coverage is incomplete.</>
                  )}
                </li>
                <li>
                  <strong>{formatDecimal(data.totalRelays > 0 ? (toPoktNumber(data.totalRevenueUpokt) / data.totalRelays) * 1_000_000 : 0, 2)} POKT</strong> (${formatUsd((data.totalRelays > 0 ? (toPoktNumber(data.totalRevenueUpokt) / data.totalRelays) * 1_000_000 : 0) * data.poktPriceUsd, 2)}) earned per 1M finalized relays.
                </li>
              </ul>
            </article>
          </div>
        </div>

      </section>

      <NetworkTrendPanel history={networkHistory} />
    </main>
  );
}
