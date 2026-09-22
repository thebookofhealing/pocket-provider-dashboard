import TimeseriesPanel from "@/app/timeseries-panel";
import RevenueCalculator from "@/app/revenue-calculator";
import { formatCompactUpokt, formatCompactUsd, formatDecimal, formatInteger, formatPercent } from "@/lib/format";
import { getDashboardDataSafe, getNetworkDailyHistoryLocal } from "@/lib/pocket";

export const metadata = {
  title: "Rewards Calculator | Pocket Network Analytics",
  description: "Pocket Network reward trends and provider growth calculator."
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

function toPoktNumber(value: bigint): number {
  return Number(value) / 1_000_000;
}

function getShare(part: bigint, total: bigint): number {
  if (total === 0n) return 0;
  return Number((part * 10_000n) / total) / 100;
}

function movingAverage(values: number[], windowSize: number): number[] {
  return values.map((_, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const slice = values.slice(start, index + 1);
    return slice.reduce((sum, value) => sum + value, 0) / slice.length;
  });
}

function compareRevenueDesc<T extends { revenueUpokt: bigint }>(a: T, b: T): number {
  if (a.revenueUpokt === b.revenueUpokt) return 0;
  return b.revenueUpokt > a.revenueUpokt ? 1 : -1;
}

type CalculatorService = {
  serviceId: string;
  serviceName: string;
  relays: number;
  revenueUpokt: string;
  providerCount: number;
  supplierCount?: number;
  appsStaked?: number;
};

export default async function RewardsPage() {
  const result = getDashboardDataSafe("30d");
  const data = result.data;
  const history = getNetworkDailyHistoryLocal();

  if (!data) {
    return (
      <main className="page">
        <section className="panel section explorer-empty">
          <span className="eyebrow">Rewards</span>
          <h1 className="section-title">Rewards view is warming up.</h1>
          <p className="section-subtitle">The 30d reward snapshot is still being prepared. Refresh shortly to inspect public reward flow.</p>
        </section>
      </main>
    );
  }

  const servicesByRevenue = [...data.services].sort(compareRevenueDesc);
  const providersByRevenue = [...data.providers].sort(compareRevenueDesc);
  const topService = servicesByRevenue[0];
  const averageReward = data.activeProviders === 0 ? 0 : toPoktNumber(data.totalRevenueUpokt) / data.activeProviders;
  const top5ProviderRewards = providersByRevenue.slice(0, 5).reduce((sum, provider) => sum + provider.revenueUpokt, 0n);
  const rewardHistoryValues = history.map((point) => toPoktNumber(point.revenueUpokt));
  const rewardHistoryAverage = movingAverage(rewardHistoryValues, 7);
  const rewardHistoryPoints = history.map((point, index) => ({
    label: point.day,
    value: rewardHistoryValues[index] ?? 0,
    secondaryValue: rewardHistoryAverage[index] ?? 0,
  }));

  const calculatorServices: CalculatorService[] = data.services.map((service) => ({
    serviceId: service.serviceId,
    serviceName: service.serviceName,
    relays: service.relays,
    revenueUpokt: service.revenueUpokt.toString(),
    providerCount: service.providerCount,
    supplierCount: service.supplierCount,
    appsStaked: service.appsStaked,
  }));

  return (
    <main className="page explorer-page">
      <section className="page-heading" style={{ padding: '32px var(--page-padding, 24px) 0' }}>
        <span className="eyebrow">Rewards Calculator</span>
        <h1>Network Rewards Overview & Calculator</h1>
        <p>
          Review finalized network rewards and model a provider deployment across active Pocket Network services.
        </p>
      </section>

      <TimeseriesPanel
        title="Reward Flow"
        subtitle="Daily settled rewards with a 7-day moving average."
        eyebrow="Trend"
        points={rewardHistoryPoints}
        valueLabel="rewards"
        formatValue={(value) => `${formatDecimal(value, 1)} POKT`}
        emptyText="Daily history is currently unavailable."
        theme="revenue"
      />

      <section className="kpi-grid kpi-grid-strong rewards-kpi-grid">
        <article className="panel kpi kpi-primary">
          <span className="kpi-label">Avg. Domain Earnings</span>
          <span className="kpi-value">{formatDecimal(averageReward, 1)} POKT</span>
          <span className="kpi-foot">Across {formatInteger(data.activeProviders)} domains</span>
        </article>
        <article className="panel kpi">
          <span className="kpi-label">Unique Providers</span>
          <span className="kpi-value">{formatInteger(data.activeProviders)}</span>
          <span className="kpi-foot" title="Privacy-safe provider cohorts inferred from observed domains, owners, and suppliers. This is not a named operator ranking.">With rewards in the 30d window</span>
        </article>
        <article className="panel kpi">
          <span className="kpi-label">Top 5 Concentration</span>
          <span className="kpi-value" style={{ color: 'var(--accent)' }}>{formatPercent(getShare(top5ProviderRewards, data.totalRevenueUpokt), 1)}</span>
          <span className="kpi-foot">Share of top 5 entities</span>
        </article>
        <article className="panel kpi">
          <span className="kpi-label">Top Service Share</span>
          <span className="kpi-value" style={{ color: 'var(--yellow-primary)' }}>{topService ? formatPercent(getShare(topService.revenueUpokt, data.totalRevenueUpokt), 1) : "n/a"}</span>
          <span className="kpi-foot">{topService?.serviceName ?? "No activity"}</span>
        </article>
      </section>

      <RevenueCalculator
        poktPriceUsd={data.poktPriceUsd}
        services={calculatorServices}
        suppliersPerSession={data.suppliersPerSession}
        sessionObservedHeight={data.sessionObservedHeight}
        sessionFetchedAt={data.sessionFetchedAt}
        sessionStale={data.sessionStale}
      />
    </main>
  );
}
