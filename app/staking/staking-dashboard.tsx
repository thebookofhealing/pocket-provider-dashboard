"use client";

import { useMemo, useState } from "react";

import { formatCompactNumber, formatDecimal, formatUsd } from "@/lib/format";

type Props = {
  networkRewards30d: number;
  activeDomains: number;
  poktPriceUsd: number;
  generatedAt: string | null;
};

const MONTHS = 12;

function clampNumber(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export default function StakingDashboard({ networkRewards30d, activeDomains, poktPriceUsd, generatedAt }: Props) {
  const [stake, setStake] = useState(15_000);
  const [monthlyRate, setMonthlyRate] = useState(0.75);
  const [commission, setCommission] = useState(5);
  const [compound, setCompound] = useState(true);

  const projection = useMemo(() => {
    const netRate = (monthlyRate / 100) * (1 - commission / 100);
    const points = Array.from({ length: MONTHS + 1 }, (_, month) => {
      const balance = compound ? stake * Math.pow(1 + netRate, month) : stake * (1 + netRate * month);
      return { month, balance, rewards: balance - stake };
    });
    return { points, rewards: points.at(-1)?.rewards ?? 0, netRate };
  }, [commission, compound, monthlyRate, stake]);

  const annualYield = compound
    ? (Math.pow(1 + projection.netRate, 12) - 1) * 100
    : projection.netRate * 12 * 100;
  const maxBalance = projection.points.at(-1)?.balance || stake;
  const observedRewardPerDomain = activeDomains > 0 ? networkRewards30d / activeDomains : 0;

  return (
    <main className="page staking-page">
      <section className="panel section staking-hero">
        <div>
          <span className="eyebrow">Supplier Economics</span>
          <h1>Plan your POKT stake.</h1>
          <p className="section-subtitle">
            Explore reward scenarios with transparent assumptions. Adjust stake, monthly return, commission, and compounding to understand potential outcomes.
          </p>
        </div>
        <div className="staking-hero-stat panel-inset">
          <span className="hero-highlight-label">Observed network rewards</span>
          <strong>{networkRewards30d > 0 ? `${formatCompactNumber(networkRewards30d)} POKT` : "Warming up"}</strong>
          <span className="muted">Last 30 days · finalized settlements</span>
        </div>
      </section>

      <section className="staking-overview" aria-label="Staking overview">
        <article className="panel kpi kpi-primary">
          <span className="kpi-label">Projected 12m rewards</span>
          <span className="kpi-value">{formatCompactNumber(projection.rewards)} POKT</span>
          <span className="kpi-foot">{formatUsd(projection.rewards * poktPriceUsd)} at the current snapshot price</span>
        </article>
        <article className="panel kpi">
          <span className="kpi-label">Modeled net yield</span>
          <span className="kpi-value">{formatDecimal(annualYield, 2)}%</span>
          <span className="kpi-foot">After {formatDecimal(commission, 1)}% commission</span>
        </article>
        <article className="panel kpi">
          <span className="kpi-label">30d reward / domain</span>
          <span className="kpi-value">{observedRewardPerDomain ? `${formatCompactNumber(observedRewardPerDomain)} POKT` : "—"}</span>
          <span className="kpi-foot">Aggregate benchmark, not a yield estimate</span>
        </article>
      </section>

      <section className="staking-workspace">
        <article className="panel section staking-controls">
          <div>
            <span className="eyebrow eyebrow-ghost">Your scenario</span>
            <h2 className="section-title">Reward calculator</h2>
            <p className="section-subtitle">These inputs are hypothetical and do not predict protocol rewards.</p>
          </div>

          <label className="staking-field">
            <span><b>POKT staked</b><output>{formatCompactNumber(stake)} POKT</output></span>
            <input type="range" min="1000" max="100000" step="1000" value={stake} onChange={(event) => setStake(clampNumber(Number(event.target.value), 1_000, 100_000))} />
          </label>
          <label className="staking-field">
            <span><b>Monthly gross return</b><output>{formatDecimal(monthlyRate, 2)}%</output></span>
            <input type="range" min="0" max="3" step="0.05" value={monthlyRate} onChange={(event) => setMonthlyRate(clampNumber(Number(event.target.value), 0, 3))} />
          </label>
          <label className="staking-field">
            <span><b>Operator commission</b><output>{formatDecimal(commission, 1)}%</output></span>
            <input type="range" min="0" max="25" step="0.5" value={commission} onChange={(event) => setCommission(clampNumber(Number(event.target.value), 0, 25))} />
          </label>
          <label className="staking-toggle">
            <input type="checkbox" checked={compound} onChange={(event) => setCompound(event.target.checked)} />
            <span aria-hidden="true" />
            Reinvest monthly rewards
          </label>
        </article>

        <article className="panel section staking-projection">
          <div className="section-title-row">
            <div>
              <span className="eyebrow eyebrow-ghost">Projection</span>
              <h2 className="section-title">12-month balance</h2>
            </div>
            <span className="pill">{compound ? "Compounding" : "Simple return"}</span>
          </div>
          <div className="staking-chart" aria-label="Projected balance over 12 months">
            {projection.points.map((point) => {
              const growthRange = Math.max(1, maxBalance - stake);
              const height = 18 + ((point.balance - stake) / growthRange) * 82;
              return (
                <div className="staking-bar-column" key={point.month} title={`Month ${point.month}: ${formatDecimal(point.balance, 0)} POKT`}>
                  <div className="staking-bar" style={{ height: `${height}%` }} />
                  <span>{point.month === 0 ? "Now" : point.month}</span>
                </div>
              );
            })}
          </div>
          <div className="staking-result-row panel-inset">
            <div><span>Ending balance</span><strong>{formatDecimal(stake + projection.rewards, 0)} POKT</strong></div>
            <div><span>Rewards earned</span><strong className="staking-accent">+{formatDecimal(projection.rewards, 0)} POKT</strong></div>
          </div>
        </article>
      </section>

      <section className="panel section staking-notes">
        <div><span className="staking-note-icon">01</span><h3>Stake is not the only variable</h3><p>Supplier rewards depend on service demand, session selection, uptime, pricing parameters, and protocol economics.</p></div>
        <div><span className="staking-note-icon">02</span><h3>Returns are user-modeled</h3><p>The calculator never derives APY from the aggregate domain benchmark. Enter a return assumption appropriate for your own scenario.</p></div>
        <div><span className="staking-note-icon">03</span><h3>Verify before committing</h3><p>Review current protocol rules, lock-up behavior, operating costs, and provider terms before staking.</p></div>
      </section>

      <p className="footer-note staking-disclaimer">
        Educational modeling only — not financial advice or a promise of returns.{generatedAt ? ` Network snapshot generated ${new Date(generatedAt).toLocaleString()}.` : " Live network data is warming up."}
      </p>
    </main>
  );
}
