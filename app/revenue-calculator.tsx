"use client";

import { useMemo, useState, useDeferredValue } from "react";

import { formatCompactNumber, formatDecimal, formatInteger, formatUpokt } from "@/lib/format";
import { hasCompleteEligibleSupplierCounts } from "@/lib/cache-contract";
import {
  buildProviderServiceOpportunity,
  DEFAULT_NEW_PROVIDER_SUPPLIERS,
  SESSION_SUPPLIER_SLOTS
} from "@/lib/opportunities";

type CalculatorService = {
  serviceId: string;
  serviceName: string;
  relays: number;
  revenueUpokt: string;
  providerCount: number;
  supplierCount?: number;
  eligibleSupplierCount?: number;
  eligibleSupplierCountFetchedAt?: string;
  eligibleSupplierCountStale?: boolean;
  appsStaked?: number;
};

type RevenueCalculatorProps = {
  services: CalculatorService[];
  suppliersPerSession?: number;
  sessionFetchedAt?: string;
  sessionStale?: boolean;
};

const MAX_SUPPLIER_COUNT = 9_999;
const FREE_SUPPLIER_BUDGET = DEFAULT_NEW_PROVIDER_SUPPLIERS;
const DEFAULT_SELECTED_CHAIN_COUNT = 5;
const MIN_MONTHLY_RELAYS = 5_000_000;

function clampSupplierCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_SUPPLIER_COUNT, Math.trunc(value)));
}

export default function RevenueCalculator({ services, suppliersPerSession, sessionFetchedAt, sessionStale }: RevenueCalculatorProps) {
  const liveSuppliersPerSession = suppliersPerSession ?? SESSION_SUPPLIER_SLOTS;
  const eligibleServices = useMemo(
    () => [...services]
      .filter((service) => service.relays > MIN_MONTHLY_RELAYS)
      .sort((a, b) => {
        const rewardOrder = BigInt(b.revenueUpokt) > BigInt(a.revenueUpokt) ? 1 : BigInt(b.revenueUpokt) < BigInt(a.revenueUpokt) ? -1 : 0;
        return rewardOrder || b.relays - a.relays || a.serviceName.localeCompare(b.serviceName);
      }),
    [services]
  );
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    eligibleServices.slice(0, DEFAULT_SELECTED_CHAIN_COUNT).map((service) => service.serviceId)
  );
  const [supplierInput, setSupplierInput] = useState(String(FREE_SUPPLIER_BUDGET));
  const deferredSupplierInput = useDeferredValue(supplierInput);
  const supplierCount = Math.max(0, Math.min(MAX_SUPPLIER_COUNT, Math.trunc(Number(deferredSupplierInput) || 0)));

  const selectedServices = useMemo(() => {
    const selected = new Set(selectedIds);
    return eligibleServices.filter((service) => selected.has(service.serviceId));
  }, [eligibleServices, selectedIds]);
  const eligibleCountsReady = hasCompleteEligibleSupplierCounts(selectedServices);

  const selectedRevenueUpokt = selectedServices.reduce((sum, service) => sum + BigInt(service.revenueUpokt), 0n);
  const selectedRelays = selectedServices.reduce((sum, service) => sum + service.relays, 0);
  const serviceOpportunities = selectedServices.map((service) =>
    buildProviderServiceOpportunity(service, supplierCount, { sessionSlots: liveSuppliersPerSession, appsStaked: service.appsStaked })
  );
  const projectedEntryUpokt = serviceOpportunities.reduce((sum, service) => sum + service.equalShareRevenueEstimateUpokt, 0n);
  const selectedChainCount = selectedServices.length;
  const entryPerSupplierUpokt = supplierCount === 0 ? 0n : projectedEntryUpokt / BigInt(supplierCount);
  const averageSelectionProbability = serviceOpportunities.length === 0
    ? 0
    : serviceOpportunities.reduce((sum, service) => sum + service.selectionProbability, 0) / serviceOpportunities.length;

  function toggleService(serviceId: string) {
    setSelectedIds((current) =>
      current.includes(serviceId) ? current.filter((entry) => entry !== serviceId) : [...current, serviceId]
    );
  }

  function resetTopChains() {
    setSelectedIds(eligibleServices.slice(0, DEFAULT_SELECTED_CHAIN_COUNT).map((service) => service.serviceId));
  }

  return (
    <section id="calculator" className="panel section calculator-section themed section-theme-revenue" style={{ position: 'relative', overflow: 'hidden' }}>
      <div style={{ 
        position: 'absolute', 
        bottom: '-10%', 
        left: '-5%', 
        width: '30%', 
        height: '40%', 
        background: 'radial-gradient(circle, rgba(245, 200, 66, 0.03) 0%, transparent 70%)',
        pointerEvents: 'none'
      }} />

      <div className="section-title-row calculator-title-row">
        <div>
          <h2 className="section-title">Growth Simulator</h2>
          <p className="section-subtitle">
            Use this calculator to model your potential revenue and determine your best expansion opportunities.
          </p>
        </div>
      </div>

      <div className="calculator-layout">
        <div className="calculator-summary">
          <div className="calculator-assumption panel-inset" style={{ borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
            <div className="calculator-assumption-heading">
              <span className="hero-highlight-label">Calculator</span>
              {eligibleCountsReady && <span className="pill supplier-counts-synced" role="status">Supplier Counts Synced</span>}
            </div>
            <div>
              <p style={{ fontSize: '0.9rem' }}>
                Pocket Network Foundation provides <strong>15 free suppliers</strong> to bootstrap new providers. Our model assumes each session selects <strong>{liveSuppliersPerSession} suppliers</strong> per session.
                {!eligibleCountsReady && (
                  <em className="muted" style={{ display: 'block', marginTop: '8px' }}>
                    Current eligible supplier counts are unavailable or stale; selection odds and projected rewards are unavailable until the indexer refreshes them.
                  </em>
                )}
                {sessionStale && (
                  <em className="muted" style={{ display: 'block', marginTop: '8px' }}>
                    Session parameters are stale; last-known snapshot{sessionFetchedAt ? ` from ${sessionFetchedAt}` : ""} is in use.
                  </em>
                )}
              </p>
            </div>

            <label className="calculator-input-group">
              <span className="hero-highlight-label">Your Supplier Count</span>
              <input
                type="number"
                min={0}
                max={MAX_SUPPLIER_COUNT}
                step={1}
                value={supplierInput}
                onChange={(e) => setSupplierInput(e.target.value)}
                onBlur={() => { const n = clampSupplierCount(Number(supplierInput)); setSupplierInput(String(n)); }}
              />
            </label>
          </div>

          <div className="calculator-kpis">
            <article className="calculator-kpi-card">
              <span className="kpi-label">Total rewards across selected chains</span>
              <strong className="calculator-kpi-value accent-number">{formatUpokt(selectedRevenueUpokt, 1)}</strong>
            </article>

            <article className="calculator-kpi-card calculator-kpi-card-accent" style={{ background: 'linear-gradient(135deg, rgba(0, 194, 255, 0.05) 0%, transparent 100%)', borderColor: 'var(--cyan-accent)' }}>
              <span className="kpi-label" style={{ color: 'var(--cyan-accent)' }}>Projected Monthly Rewards</span>
              <strong className="calculator-kpi-value accent-number" style={{ color: 'var(--cyan-accent)', textShadow: '0 0 20px rgba(0, 194, 255, 0.2)' }}>
                {eligibleCountsReady ? formatUpokt(projectedEntryUpokt, 1) : "Unavailable"}
              </strong>
            </article>
          </div>

          <div className="calculator-meta-grid">
            <div className="calculator-meta-card">
              <span className="hero-highlight-label">Coverage Footprint</span>
              <strong className="accent-number">{formatInteger(selectedChainCount)} chains</strong>
            </div>

            <div className="calculator-meta-card">
              <span className="hero-highlight-label">Average Selection Odds</span>
              <strong className="accent-number" style={{ color: 'var(--accent)' }}>{eligibleCountsReady ? `${formatDecimal(averageSelectionProbability, 0)}%` : "Unavailable"}</strong>
              <p>Average per-chain session selection probability.</p>
            </div>

            <div className="calculator-meta-card">
              <span className="hero-highlight-label">Relay Demand</span>
              <strong className="accent-number">{formatCompactNumber(selectedRelays)}</strong>
              <p>Total relays across selected chains.</p>
            </div>

            <div className="calculator-meta-card">
              <span className="hero-highlight-label">Projected revenue per supplier</span>
              <strong className="accent-number" style={{ color: 'var(--green)' }}>{eligibleCountsReady ? formatUpokt(entryPerSupplierUpokt, 1) : "Unavailable"}</strong>
              <p>Projected revenue per active supplier.</p>
            </div>

          </div>
        </div>

        <div className="calculator-checklist rewards-calculator-checklist panel-inset" style={{ borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
          <div className="section-title-row compact-gap">
            <div>
              <h3 className="section-title" style={{ fontSize: '1.2rem' }}>Service Selection</h3>
              <p className="section-subtitle" style={{ fontSize: '0.85rem' }}>Chains to include in your model.</p>
            </div>
          </div>
          
          <div className="calculator-actions" style={{ marginBottom: '20px' }}>
            <button type="button" className="btn btn-secondary" onClick={resetTopChains} style={{ fontSize: '12px' }}>
              Reset Default
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setSelectedIds(eligibleServices.map((service) => service.serviceId))} style={{ fontSize: '12px' }}>
              Select All
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setSelectedIds([])} style={{ fontSize: '12px' }}>
              Clear
            </button>
          </div>

          <div className="calculator-list">
            {eligibleServices.map((service) => {
              const checked = selectedIds.includes(service.serviceId);

              return (
                <label key={service.serviceId} className={`calculator-item${checked ? " is-checked" : ""}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleService(service.serviceId)}
                  />
                  <div className="calculator-item-copy">
                    <div className="calculator-item-head">
                      <strong style={{ color: checked ? 'var(--text)' : 'var(--muted)' }}>{service.serviceName}</strong>
                      <span className="mono" style={{ fontSize: '0.7rem' }}>{service.serviceId}</span>
                    </div>
                    <div className="calculator-item-meta">
                      <span style={{ color: 'var(--accent)' }}>{formatUpokt(BigInt(service.revenueUpokt), 1)}</span>
                      <span>{formatInteger(service.providerCount)} providers</span>
                      <span>{service.eligibleSupplierCount == null ? "Eligible count unavailable" : `${formatInteger(service.eligibleSupplierCount)} eligible suppliers`}</span>
                      <span>{formatCompactNumber(service.relays)} relays</span>
                      {checked && eligibleCountsReady && (
                        <span>{formatDecimal(serviceOpportunities.find((opportunity) => opportunity.serviceId === service.serviceId)?.selectionProbability ?? 0, 0)}% selection odds</span>
                      )}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      </div>

      <section className="panel section staking-notes rewards-calculator-disclaimers">
        <div className="staking-notes-header">
          <span className="eyebrow eyebrow-ghost">Calculator guidance</span>
          <h2 className="section-title">Calculator Disclaimers</h2>
        </div>
        <div className="staking-notes-grid">
          <div><span className="staking-note-icon">01</span><h3>Rewards are not promised</h3><p>Projections are based on historical data and are not a guarantee of future rewards.</p></div>
          <div><span className="staking-note-icon">02</span><h3>Quality of Service</h3><p>Your traffic while in a session depends heavily on your quality of service, low QoS results in lower revenue.</p></div>
          <div><span className="staking-note-icon">03</span><h3>Demand Signal</h3><p>Choosing chains with a lower ratio of suppliers and providers to relays can optimize your revenue.</p></div>
        </div>
      </section>
    </section>
  );
}
