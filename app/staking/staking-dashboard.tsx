"use client";

import { useMemo, useState } from "react";
import type { PublicPlan, StakingPlansSnapshot } from "@/lib/staking-plans";

const POKT_PER_SUPPLIER = 59_500;
const PROJECTION_MONTHS = 6;

type Scenario = "migrate" | "new";

function clampWholeNumber(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.round(Math.min(maximum, Math.max(minimum, value)));
}

function formatPokt(value: number, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function planLabel(plan: PublicPlan): string {
  return `${plan.provider} — ${plan.apr.toFixed(1)}% APR`;
}

function projectedRewards(stakedPokt: number, apr: number, month: number): number {
  return stakedPokt * (apr / 100) * (month / 12);
}

function formatFetchedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown time" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

type StakingDashboardProps = StakingPlansSnapshot;

export default function StakingDashboard({ plans: publicPlans, fetchedAt, stale, source }: StakingDashboardProps) {
  const PUBLIC_PLANS = publicPlans;
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [supplierCount, setSupplierCount] = useState(1);
  const [currentPlanId, setCurrentPlanId] = useState(publicPlans.at(-1)?.id ?? "");
  const [targetPlanId, setTargetPlanId] = useState(publicPlans[0]?.id ?? "");

  const currentPlan = PUBLIC_PLANS.find((plan) => plan.id === currentPlanId) ?? PUBLIC_PLANS.at(-1)!;
  const targetPlan = PUBLIC_PLANS.find((plan) => plan.id === targetPlanId) ?? PUBLIC_PLANS[0];
  if (!currentPlan || !targetPlan) {
    return <main className="page staking-page"><section className="panel section explorer-empty"><h1 className="section-title">Staking plans are temporarily unavailable.</h1><p className="section-subtitle">Igniter did not return a usable public plan feed. Please try again shortly.</p></section></main>;
  }
  const stakedPokt = supplierCount * POKT_PER_SUPPLIER;

  const projection = useMemo(() => {
    const points = Array.from({ length: PROJECTION_MONTHS }, (_, index) => {
      const month = index + 1;
      return {
        month,
        current: scenario === "migrate" ? projectedRewards(stakedPokt, currentPlan.apr, month) : 0,
        target: projectedRewards(stakedPokt, targetPlan.apr, month),
      };
    });
    const last = points.at(-1)!;
    return {
      points,
      currentRewards: last.current,
      targetRewards: last.target,
      difference: last.target - last.current,
    };
  }, [currentPlan.apr, scenario, stakedPokt, targetPlan.apr]);

  const aprDelta = scenario === "migrate" ? targetPlan.apr - currentPlan.apr : targetPlan.apr;
  const monthlyDifference = projection.difference / PROJECTION_MONTHS;
  const projectedRewardMaximum = Math.max(1, ...projection.points.flatMap((point) => [point.current, point.target]));
  const chartAxisMaximum = Math.max(10_000, Math.ceil(projectedRewardMaximum / 10_000) * 10_000);
  const isPositive = projection.difference >= 0;
  const hasScenario = scenario !== null;
  const monthLabels = useMemo(() => {
    const currentMonth = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", { month: "short" });

    return Array.from({ length: PROJECTION_MONTHS }, (_, index) => {
      const month = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + index + 1, 1);
      return formatter.format(month);
    });
  }, []);

  return (
    <main className="page staking-page">
      <section className="panel section staking-hero">
        <div>
          <span className="eyebrow">Supplier staking</span>
          <h1>Put your POKT to work</h1>
          <p className="section-subtitle">
            Compare provider staking plans and learn where to maximize your staking rewards
          </p>
        </div>
        <aside className="hero-side panel panel-inset staking-hero-stat">
          <div className="insight-list">
            <div className="insight-row staking-minimum-row">
              <span className="staking-tooltip-wrap">
                <button className="muted staking-tooltip-trigger" type="button" aria-describedby="minimum-stake-tooltip">
                  Minimum supplier stake
                  <svg className="staking-tooltip-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 10.75v5" />
                    <path d="M12 7.75h.01" />
                  </svg>
                </button>
                <span className="staking-tooltip" id="minimum-stake-tooltip" role="tooltip">
                  If you hold less than 59,500 POKT, stake with a{" "}
                  <a
                    href="https://wallet.keplr.app/chains/pocket-network?modal=staking&chain=pocket&validator_address=poktvaloper16e5nljedgjfaajcjg9p4a2x4tc78daq9yr56mq&step_id=3&action_id=stake"
                    target="_blank"
                    rel="noreferrer"
                  >
                    validator
                  </a>{" "}
                  on Keplr wallet instead.
                </span>
              </span>
              <strong>59,500 POKT</strong>
            </div>
          </div>
        </aside>
      </section>

      <section className="panel section staking-plan-board">
        <div className="section-title-row">
          <div>
            <span className="eyebrow eyebrow-ghost">Public plan leaderboard</span>
            <h2 className="section-title">Public provider plans</h2>
            <p className="section-subtitle">
              Ranked highest to lowest based on current trailing 7-day APR. <span className={stale ? "staking-feed-status stale" : "staking-feed-status"}>{stale ? "Last known good" : "Live"} · refreshed {formatFetchedAt(fetchedAt)}</span>
            </p>
          </div>
        </div>

        <div className="staking-plan-table" role="table" aria-label="Public provider plans">
          <div className="staking-plan-row header" role="row">
            <span role="columnheader">Rank</span><span role="columnheader">Provider</span><span role="columnheader">Net daily POKT yield per supplier</span><span role="columnheader">Client share</span><span role="columnheader">POKT Staking APR</span>
          </div>
          {PUBLIC_PLANS.map((plan, index) => (
            <div className={`staking-plan-row ${plan.id === targetPlanId ? "selected" : ""}`} role="row" key={plan.id}>
              <span className="staking-rank" role="cell">{String(index + 1).padStart(2, "0")}</span>
              <span className="staking-provider" role="cell">
                {plan.website ? (
                  <a href={plan.website} target="_blank" rel="noreferrer" aria-label={`${plan.provider} website (opens in a new tab)`}>
                    <b>{plan.provider}</b>
                  </a>
                ) : <b>{plan.provider}</b>}
              </span>
              <span role="cell">{plan.displayedYield.toFixed(2)} <small>POKT/supplier</small></span>
              <span role="cell">{plan.clientShare.toFixed(1)}%</span>
              <strong role="cell">{plan.apr.toFixed(1)}%</strong>
            </div>
          ))}
        </div>
      </section>

      <section className={`staking-scenario-tabs ${hasScenario ? "" : "awaiting-selection"}`} aria-label="Choose a staking scenario">
        <button aria-pressed={scenario === "new"} className={scenario === "new" ? "active" : ""} onClick={() => setScenario("new")} type="button">
          <span className="staking-choice-marker" aria-hidden="true" />
          <b>Stake POKT from your wallet</b>
          <small>Projects your rewards for a new supplier allocation</small>
        </button>
        <button aria-pressed={scenario === "migrate"} className={scenario === "migrate" ? "active" : ""} onClick={() => setScenario("migrate")} type="button">
          <span className="staking-choice-marker" aria-hidden="true" />
          <b>Move existing suppliers</b>
          <small>Compare the opportunity cost of your current supplier allocation</small>
        </button>
      </section>

      <section className={`staking-workspace ${hasScenario ? "" : "locked"}`} aria-disabled={!hasScenario}>
        {!hasScenario && <span className="staking-workflow-lock" aria-hidden="true"><i /></span>}
        <article className="panel section staking-controls">
          <div>
            <span className="eyebrow eyebrow-ghost">{scenario === "migrate" ? "Migration scenario" : scenario === "new" ? "New stake scenario" : "Staking calculator"}</span>
            <h2 className="section-title">{scenario === "migrate" ? "Compare provider plans" : scenario === "new" ? "Model a new allocation" : "Model your supplier rewards with various provider plans"}</h2>
            {scenario && (
              <p className="section-subtitle">
                {scenario === "migrate"
                  ? "Choose where your suppliers are today and where you are considering moving them."
                  : "Choose your desired public provider plan and number of suppliers."}
              </p>
            )}
          </div>

          {scenario !== "new" && (
            <label className="staking-input-group">
              <span>Currently staked with</span>
              <select disabled={!hasScenario} value={currentPlanId} onChange={(event) => setCurrentPlanId(event.target.value)}>
                {PUBLIC_PLANS.map((plan) => <option key={plan.id} value={plan.id}>{planLabel(plan)}</option>)}
              </select>
            </label>
          )}

          <label className="staking-input-group">
            <span>{scenario === "migrate" ? "Move suppliers to" : scenario === "new" ? "Public plan" : "Provider plan"}</span>
            <select disabled={!hasScenario} value={targetPlanId} onChange={(event) => setTargetPlanId(event.target.value)}>
              {PUBLIC_PLANS.map((plan) => <option key={plan.id} value={plan.id}>{planLabel(plan)}</option>)}
            </select>
          </label>

          <div className="staking-input-group staking-supplier-input">
            <label className="staking-input-label" htmlFor="supplier-count">Number of suppliers</label>
            <input
              className="staking-supplier-slider"
              aria-label="Number of suppliers slider"
              aria-describedby="supplier-slider-scale"
              min="1"
              max="100"
              step="1"
              type="range"
              value={supplierCount}
              disabled={!hasScenario}
              onChange={(event) => setSupplierCount(Number(event.target.value))}
            />
            <span className="staking-slider-scale" id="supplier-slider-scale" aria-hidden="true"><span>1</span><span>100</span></span>
            <input
              id="supplier-count"
              min="1"
              max="100"
              step="1"
              type="number"
              value={supplierCount}
              disabled={!hasScenario}
              onChange={(event) => setSupplierCount(clampWholeNumber(Number(event.target.value), 1, 100))}
            />
          </div>

          <div className="staking-lookback" aria-label="APR lookback: trailing 7 days">
            <div>
              <span>APR lookback</span>
              <strong>Trailing 7 days · {source === "igniter" ? "live feed" : "last known good"}</strong>
            </div>
            <span className={`staking-verified-badge ${stale ? "stale" : ""}`}>{stale ? "Stale" : "Fresh"}</span>
          </div>

          <div className="staking-method-note">
            <span aria-hidden="true">i</span>
            <p><b>How APR is calculated</b> Net POKT earned per supplier per day × 365 ÷ minimum supplier stake. This is a backward-looking 7 day average and does not guarantee future performance. We will add 14 and 30 day trailing APR in the future.</p>
          </div>
        </article>

        <article className="panel section staking-projection">
          <div className="section-title-row">
            <div>
              <span className="eyebrow eyebrow-ghost">Potential rewards</span>
              <h2 className="section-title">Your Projected Rewards Over 6 Months</h2>
            </div>
          </div>

          <div className={`staking-opportunity ${isPositive ? "positive" : "negative"}`}>
            <span>{scenario === "migrate" ? "Projected difference" : "Projected rewards"}</span>
            <strong>{hasScenario ? `${projection.difference >= 0 ? "+" : "−"}${formatPokt(Math.abs(projection.difference))} POKT` : "— POKT"}</strong>
            <p>
              {!hasScenario
                ? "Six-month simple return"
                : scenario === "migrate"
                ? `${Math.abs(aprDelta).toFixed(1)} percentage points ${aprDelta >= 0 ? "higher" : "lower"} than ${currentPlan.provider}.`
                : `Based on ${targetPlan.apr.toFixed(1)}% APR for ${supplierCount.toLocaleString()} supplier${supplierCount === 1 ? "" : "s"}.`}
            </p>
          </div>

          {scenario === "migrate" && (
            <div className="staking-chart-legend" aria-hidden="true">
              <span><i className="current" /> Stay with {currentPlan.provider}</span>
              <span><i className="target" /> Move to {targetPlan.provider}</span>
            </div>
          )}

          <div className="staking-chart-shell" aria-label="Six-month cumulative reward projection">
            <div className="staking-chart-content">
              <div className="staking-comparison-chart">
                {[0, 25, 50, 75, 100].map((percentage) => <i className="staking-chart-gridline" key={percentage} style={{ bottom: `${percentage}%` }} />)}
                {projection.points.map((point) => (
                  <div className="staking-month-column" key={point.month}>
                    {scenario === "migrate" && (
                      <span
                        className="staking-comparison-bar current"
                        style={{ height: `${Math.max(3, (point.current / chartAxisMaximum) * 100)}%` }}
                        title={`${currentPlan.provider}, month ${point.month}: ${formatPokt(point.current)} POKT`}
                      />
                    )}
                    <span
                      className="staking-comparison-bar target"
                      style={{ height: `${Math.max(3, (point.target / chartAxisMaximum) * 100)}%` }}
                      title={`${targetPlan.provider}, month ${point.month}: ${formatPokt(point.target)} POKT`}
                    />
                  </div>
                ))}
              </div>
              <div className="staking-chart-month-labels" aria-hidden="true">
                {monthLabels.map((month) => <span key={month}>{month}</span>)}
              </div>
            </div>
            <div className="staking-chart-y-axis" aria-hidden="true">
              {[100, 75, 50, 25, 0].map((percentage) => (
                <span key={percentage}>
                  {percentage === 100 ? `${formatPokt(chartAxisMaximum)} POKT` : percentage === 50 ? `${formatPokt(chartAxisMaximum / 2)} POKT` : ""}
                </span>
              ))}
            </div>
          </div>

          <div className="staking-result-grid panel-inset">
            <div><span>POKT Staked</span><strong>{hasScenario ? formatPokt(stakedPokt) : "—"}</strong></div>
            <div><span>{scenario === "migrate" ? "Monthly Reward Difference" : "Monthly POKT Rewards"}</span><strong className={hasScenario ? (monthlyDifference >= 0 ? "staking-accent" : "staking-loss") : ""}>{hasScenario ? `${monthlyDifference >= 0 ? "+" : "−"}${formatPokt(Math.abs(monthlyDifference))}` : "—"}</strong></div>
            <div><span>Projected Plan APR</span><strong>{hasScenario ? `${targetPlan.apr.toFixed(1)}%` : "—"}</strong></div>
          </div>
        </article>
      </section>

      <section className="panel section staking-how-it-works">
        <div>
          <span className="eyebrow eyebrow-ghost">Getting started</span>
          <h2 className="section-title">How does staking work?</h2>
        </div>

        <ol className="staking-steps">
          <li>Use your Keplr or Soothe wallet to access Igniter via <a href="https://staking.pocket.network" target="_blank" rel="noreferrer">staking.pocket.network</a>.</li>
          <li>Once your wallet is connected, click on <b>Providers</b> to view your staking options.</li>
          <li>Select your desired provider, click <b>Stake</b> and follow the prompts to set up your supplier.</li>
        </ol>

        <div className="staking-facts">
          <h3>Facts about staking</h3>
          <div className="staking-fact-grid">
            <p><b>Staking is non-custodial:</b> Your tokens stay in your wallet, and only you control them.</p>
            <p><b>Unstaking Period:</b> Tokens automatically become liquid in your wallet after 21 days.</p>
            <p><b>Automatic rewards:</b> Rewards flow directly to the wallet you staked from—no claiming required.</p>
            <p><b>Track rewards:</b> View your staking rewards in Igniter’s <b>Overview</b> tab.</p>
          </div>
        </div>
      </section>

      <section className="panel section staking-notes">
        <div><span className="staking-note-icon">01</span><h3>APR is not a promise</h3><p>Provider performance, service mix, session selection, uptime, protocol economics, and commission can all change your rewards.</p></div>
        <div><span className="staking-note-icon">02</span><h3>Historical Rewards</h3><p>Seven-day APR can change quickly, so keep an eye on your providers performance.</p></div>
        <div><span className="staking-note-icon">03</span><h3>Verify before migrating</h3><p>Be aware of the 21-day unstaking period, fees, and variability in rewards prior to staking or moving your suppliers.</p></div>
      </section>

      <p className="footer-note staking-disclaimer">
        Educational modeling only — not financial advice or a promise of returns. Projections use simple interest and exclude fees, downtime, compounding, and APR changes.
      </p>
    </main>
  );
}
