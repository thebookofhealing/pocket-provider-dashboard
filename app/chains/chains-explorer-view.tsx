"use client";

import Link from "next/link";
import { useMemo, useState, useEffect } from "react";

import { formatCompactNumber, formatCompactUpokt, formatDecimal, formatInteger, formatUsd, formatUpokt } from "@/lib/format";
import { buildAllocatedServiceOpportunity, DEFAULT_NEW_PROVIDER_SUPPLIERS, SESSION_SUPPLIER_SLOTS } from "@/lib/opportunities";
import type { SerializedDashboardData, SerializedServiceStats } from "@/lib/types";

type SortKey = "service" | "revenue" | "relays" | "computeUnits" | "providers" | "suppliers" | "appsStaked" | "revenuePerProvider" | "opportunity";
type SortDirection = "asc" | "desc";

type SortColumn = {
  key: SortKey;
  label: string;
  align?: "right";
  defaultDirection?: SortDirection;
  tooltip?: string;
};

const SORT_COLUMNS: SortColumn[] = [
  { key: "service", label: "Service Identity", defaultDirection: "asc" },
  { key: "revenue", label: "Revenue (30d)", align: "right" },
  { key: "relays", label: "Final Relays", align: "right" },
  { key: "providers", label: "Domains", align: "right" },
  { key: "suppliers", label: "Suppliers", align: "right" },
  { key: "appsStaked", label: "Apps", align: "right", tooltip: "Applications staked for this service (live snapshot). Auxiliary metric — does not affect the demand signal ranking." },
  { key: "revenuePerProvider", label: "Avg Domain Reward", align: "right" },
  {
    key: "opportunity",
    label: "Demand Signal (experimental)",
    align: "right",
    tooltip: "Combines revenue yield, supplier competition, and modeled application-session opportunities. Applications increase session selection breadth but do not guarantee workload or revenue. The higher the score, the more potential for providers to profit from participating in this network."
  }
];

type ChainsExplorerViewProps = {
  data: SerializedDashboardData | null;
};

function toPoktNumber(value: string): number {
  return Number(BigInt(value)) / 1_000_000;
}

function revenuePerProvider(service: SerializedServiceStats): number {
  return toPoktNumber(service.revenueUpokt) / Math.max(service.providerCount, 1);
}

function onboardingOpportunityScore(service: SerializedServiceStats, suppliersPerSession: number): number {
  return buildAllocatedServiceOpportunity(service, DEFAULT_NEW_PROVIDER_SUPPLIERS, DEFAULT_NEW_PROVIDER_SUPPLIERS, { sessionSlots: suppliersPerSession, appsStaked: service.appsStaked }).opportunityScore;
}

function getSortValue(service: SerializedServiceStats, sort: SortKey, suppliersPerSession: number): string | number | bigint {
  switch (sort) {
    case "service":
      return service.serviceName;
    case "revenue":
      return BigInt(service.revenueUpokt);
    case "relays":
      return service.relays;
    case "computeUnits":
      return service.computeUnits ?? 0;
    case "providers":
      return service.providerCount;
    case "suppliers":
      return service.supplierCount ?? 0;
    case "appsStaked":
      return service.appsStaked ?? 0;
    case "revenuePerProvider":
      return revenuePerProvider(service);
    case "opportunity":
      return onboardingOpportunityScore(service, suppliersPerSession);
  }
}

function compareSortValue(a: string | number | bigint, b: string | number | bigint, direction: SortDirection): number {
  const multiplier = direction === "asc" ? 1 : -1;

  if (typeof a === "string" && typeof b === "string") {
    return a.localeCompare(b) * multiplier;
  }

  if (typeof a === "bigint" || typeof b === "bigint") {
    const aBig = typeof a === "bigint" ? a : BigInt(Math.trunc(Number(a)));
    const bBig = typeof b === "bigint" ? b : BigInt(Math.trunc(Number(b)));
    if (aBig === bBig) return 0;
    return (aBig > bBig ? 1 : -1) * multiplier;
  }

  return (Number(a) - Number(b)) * multiplier;
}

function getSortDirectionLabel(direction: SortDirection): string {
  return direction === "asc" ? "ascending" : "descending";
}

export default function ChainsExplorerView({ data }: ChainsExplorerViewProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("revenue");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  function updateSort(nextSort: SortKey, nextDirection?: SortDirection) {
    if (nextDirection) {
      setSort(nextSort);
      setSortDirection(nextDirection);
      return;
    }

    if (nextSort === sort) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }

    const column = SORT_COLUMNS.find((entry) => entry.key === nextSort);
    setSort(nextSort);
    setSortDirection(column?.defaultDirection ?? "desc");
  }

  const services = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (data?.services ?? [])
      .filter((service) => {
        if (!normalizedQuery) return true;
        return [service.serviceName, service.serviceId].some((value) => value.toLowerCase().includes(normalizedQuery));
      })
      .sort((a, b) => compareSortValue(getSortValue(a, sort, data?.suppliersPerSession ?? SESSION_SUPPLIER_SLOTS), getSortValue(b, sort, data?.suppliersPerSession ?? SESSION_SUPPLIER_SLOTS), sortDirection) || a.serviceName.localeCompare(b.serviceName));
  }, [data?.services, query, sort, sortDirection]);

  const eligibleServices = useMemo(() =>
    services.filter((s) => BigInt(s.revenueUpokt) > 0n || s.relays > 0 || (s.computeUnits ?? 0) > 0),
    [services]
  );

  const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
  const [pageSize, setPageSize] = useState<number>(10);
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(eligibleServices.length / pageSize));
  const visibleServices = eligibleServices.slice((page - 1) * pageSize, page * pageSize);

  function handlePageSizeChange(newSize: number) {
    setPageSize(newSize);
    setPage(1);
  }

  useEffect(() => { setPage(1); }, [query, sort, sortDirection, eligibleServices.length]);

  if (!data) {
    return (
      <main className="page">
        <section className="panel section explorer-empty">
          <span className="eyebrow">Chains</span>
          <h1 className="section-title">Chain explorer is warming up.</h1>
          <p className="section-subtitle">The 30d dashboard snapshot is still being prepared. Refresh shortly to inspect services.</p>
        </section>
      </main>
    );
  }

  const cuCoverageComplete = (data.computeUnitCoverage ?? 0) >= 1;

  return (
    <main className="page explorer-page">
      <section className="panel section explorer-hero" style={{ overflow: 'hidden', position: 'relative' }}>
        <div style={{ 
          position: 'absolute', 
          top: '-10%', 
          right: '-5%', 
          width: '30%', 
          height: '120%', 
          background: 'radial-gradient(circle, rgba(0, 194, 255, 0.05) 0%, transparent 70%)',
          pointerEvents: 'none'
        }} />

        <div>
          <span className="eyebrow">Chains</span>
          <h1>Chain Explorer.</h1>
          <p className="section-subtitle" style={{ fontSize: '1.1rem', maxWidth: '600px' }}>
            Search, sort, and open service-level chain details from a dedicated explorer.
            {data.sessionStale && <em className="muted"> Session parameters are stale; opportunity scores use last-known values{data.sessionFetchedAt ? ` from ${data.sessionFetchedAt}` : ""}.</em>}
          </p>
        </div>
        
        <div className="explorer-summary-grid explorer-summary-grid-four">
          <article className="explorer-summary-card panel-inset" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
            <span className="hero-highlight-label">Active Chains</span>
            <strong style={{ color: 'var(--text)' }}>{formatInteger(data.activeChains)}</strong>
          </article>
          <article className="explorer-summary-card panel-inset" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
            <span className="hero-highlight-label">Reward Pool</span>
            <strong style={{ color: 'var(--accent)' }}>{formatCompactUpokt(BigInt(data.totalRevenueUpokt), 1)}</strong>
          </article>
          <article className="explorer-summary-card panel-inset" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
            <span className="hero-highlight-label">Relays</span>
            <strong style={{ color: 'var(--green)' }}>{formatCompactNumber(data.totalRelays)}</strong>
          </article>
          <article className="explorer-summary-card panel-inset" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
            <span className="hero-highlight-label">{cuCoverageComplete ? "Compute Units" : "Known Compute Units"}</span>
            <strong style={{ color: 'var(--green)' }}>{formatCompactNumber(data.totalEstimatedComputeUnits)}</strong>
            {!cuCoverageComplete && <span className="muted" style={{ fontSize: '0.7rem' }}>Partial</span>}
          </article>
        </div>
      </section>

      <section className="panel section">
        <div className="section-title-row">
          <div>
            <h2 className="section-title">Chains</h2>
            <p className="section-subtitle">Clickable and filterable list of services in the current 30d snapshot.</p>
          </div>
          <span className="pill">Explorer</span>
        </div>

        <div className="explorer-toolbar">
          <div className="explorer-search">
            <span className="hero-highlight-label">Filter Chains</span>
            <div style={{ position: 'relative' }}>
              <input 
                value={query} 
                onChange={(event) => setQuery(event.target.value)} 
                placeholder="Service name or identity..." 
                style={{ paddingLeft: '40px' }}
              />
              <svg 
                style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', opacity: 0.5 }}
                width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>
          </div>
          
          <div className="explorer-select">
            <span className="hero-highlight-label">Sort Objective</span>
            <select value={sort} onChange={(event) => updateSort(event.target.value as SortKey, SORT_COLUMNS.find((entry) => entry.key === event.target.value)?.defaultDirection ?? "desc")}>
              <option value="service">Service Identity</option>
              <option value="opportunity">Demand Signal (experimental)</option>
              <option value="revenue">Total Revenue</option>
              <option value="relays">Relay Volume</option>
              <option value="providers">Domain Density</option>
              <option value="revenuePerProvider">Avg Domain Reward</option>
              <option value="computeUnits">Compute Units</option>
              <option value="suppliers">Supplier Count</option>
              <option value="appsStaked">App Count</option>
            </select>
          </div>
        </div>

        <div className="explorer-table-wrap">
          <table className="mini-table explorer-table">
            <thead>
              <tr>
                {SORT_COLUMNS.map((column) => {
                  const active = column.key === sort;
                  const ariaSort = active ? (sortDirection === "asc" ? "ascending" : "descending") : "none";

                  return (
                    <th key={column.key} className={column.align} aria-sort={ariaSort}>
                      <button
                        type="button"
                        className={`table-sort-button${active ? " active" : ""}`}
                        onClick={() => updateSort(column.key)}
                        aria-label={`Sort by ${column.label} ${active ? `currently ${getSortDirectionLabel(sortDirection)}` : ""}`}
                      >
                        <span>{column.label}</span>
                        {column.tooltip && (
                          <span className="info-tooltip" onClick={(event) => event.stopPropagation()}>
                            <span
                              className="info-tooltip-trigger"
                              tabIndex={0}
                              aria-label={column.tooltip}
                            >
                              ?
                            </span>
                            <span className="info-tooltip-content" role="tooltip">{column.tooltip}</span>
                          </span>
                        )}
                        <span className="sort-indicator" aria-hidden="true">{active ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visibleServices.map((service) => {
                const opportunity = buildAllocatedServiceOpportunity(service, DEFAULT_NEW_PROVIDER_SUPPLIERS, DEFAULT_NEW_PROVIDER_SUPPLIERS, { sessionSlots: data.suppliersPerSession, appsStaked: service.appsStaked });

                return (
                <tr key={service.serviceId}>
                  <td>
                    <Link href={`/chains/${encodeURIComponent(service.serviceId)}`} className="explorer-primary-link">
                      {service.serviceName}
                    </Link>
                    <div className="muted mono" style={{ fontSize: '0.75rem', marginTop: '4px' }}>{service.serviceId}</div>
                  </td>
                  <td className="right">
                    <strong className="accent-number" style={{ fontSize: '1.05rem' }}>{formatUpokt(BigInt(service.revenueUpokt), 1)}</strong>
                    <div className="muted" style={{ fontSize: '0.8rem' }}>{formatUsd(toPoktNumber(service.revenueUpokt) * data.poktPriceUsd, 0)}</div>
                  </td>
                  <td className="right">{formatInteger(service.relays)}</td>
                  <td className="right">{formatInteger(service.providerCount)}</td>
                  <td className="right">{formatInteger(service.supplierCount ?? 0)}</td>
                  <td className="right">{formatInteger(service.appsStaked ?? 0)}</td>
                  <td className="right" style={{ color: 'var(--green)', fontWeight: 600 }}>{formatDecimal(revenuePerProvider(service), 1)} POKT</td>
                  <td className="right">
                    <span className={`pill ${opportunity.opportunityScore >= 7 ? 'density-low' : opportunity.opportunityScore >= 4 ? 'density-medium' : 'density-high'}`} style={{ fontSize: '0.7rem' }}>
                      {formatDecimal(opportunity.opportunityScore, 1)} score
                    </span>
                    {service.appsStaked != null && service.appsStaked > 0 && (
                      <div className="muted" style={{ fontSize: '0.7rem', marginTop: '4px' }}>
                        {formatDecimal(opportunity.expectedAssignments ?? 0, 1)} exp. / {formatDecimal(opportunity.expectedSessionsRepresented ?? 0, 1)} sessions
                      </div>
                    )}
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        </div>

        <div className="explorer-pagination">
          <span className="muted">Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, eligibleServices.length)} of {formatInteger(eligibleServices.length)} chains</span>
          <div className="explorer-pagination-controls">
            <span className="muted" style={{ marginRight: '12px' }}>Rows per page:</span>
            {PAGE_SIZE_OPTIONS.map((size) => (
              <button key={size} type="button" className={`pill ${pageSize === size ? 'active' : ''}`} onClick={() => handlePageSizeChange(size)}>
                {size}
              </button>
            ))}
            <button type="button" className="pill" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
            <span className="muted" style={{ margin: '0 8px' }}>Page {page} of {pageCount}</span>
            <button type="button" className="pill" disabled={page >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>Next</button>
          </div>
        </div>
      </section>
    </main>
  );
}
