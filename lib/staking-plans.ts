import { derivePlanEconomics, isSourceFresh, normalizeSourceTimestamp } from "@/lib/staking-economics";

export const DEFAULT_POKT_PER_SUPPLIER = 59_500;
export const MINIMUM_DISPLAY_APR = 10;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const IGNITER_GRAPHQL_URL = "https://data.pocket.network/";
const POCKET_REST_URL = "https://sauron-api.infra.pocket.network";

export const IGNITER_REWARDS_QUERY = `query RewardsByDomains($domains: [String!]!, $startTs: Datetime!, $endTs: Datetime!) {
  rewards: getRewardsByDomainsAndTimeGroupByService(domains: $domains, startTs: $startTs, endTs: $endTs)
}`;
export const IGNITER_LATEST_BLOCK_QUERY = `query LatestBlock {
  blocks(orderBy: ID_DESC, first: 1) { nodes { id timestamp } }
}`;
export const IGNITER_ALLOCATION_QUERY = `query SupplierMintAllocation {
  allocation: param(id: "tokenomics-mint_allocation_percentages") { value }
}`;

export type RewardStatus = "live" | "stale" | "unavailable";
export type PlanValueSource = "live-derived" | "stale-derived" | "provider-lkg" | "static-cold-start";

export type PublicPlan = {
  id: string;
  provider: string;
  plan: string;
  apr: number;
  clientShare: number;
  displayedYield: number;
  termsVerifiedAt: string;
  website?: string;
  rewardStatus: RewardStatus;
  valueSource: PlanValueSource;
  sourceUpdatedAt: string | null;
  fetchedAt: string;
  diagnosticReason?: string;
};

export type StakingPlansSnapshot = {
  plans: PublicPlan[];
  fetchedAt: string;
  sourceUpdatedAt: string | null;
  minimumSupplierStake: number;
  stale: boolean;
  source: "igniter-indexer" | "last-known-good";
  allocationStatus: "live" | "stale" | "unavailable";
  minimumStakeStatus: "live" | "stale" | "unavailable";
};

type ProviderPlanMetadata = {
  id: string;
  provider: string;
  plan: string;
  clientShare: number;
  termsVerifiedAt: string;
  website?: string;
  domain: string;
  clientSharesByService?: Record<string, number>;
};
type IgniterRewardService = {
  gross_rewards?: string | number | null;
  staked_suppliers?: string | number | null;
};
type IgniterRewardPayload = { services?: IgniterRewardService[] };
type IgniterSource = {
  sourceUpdatedAt?: string | null;
  allocation?: { value?: string | null } | null;
};
type IgniterLatestBlock = { blocks?: { nodes?: Array<{ id?: string | number; timestamp?: string | number | null }> } };
type IgniterAllocation = { allocation?: { value?: string | null } | null };

class StakingRefreshError extends Error {
  constructor(readonly stage: "source" | "rewards" | "minimum-stake" | "derive", cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "StakingRefreshError";
  }
}

// Igniter's public UI does not expose an unauthenticated plan-status endpoint.
// Keep plan terms explicit, but source reward economics and the protocol minimum
// stake from the same public Pocket services used by Igniter.
const PLAN_METADATA: ProviderPlanMetadata[] = [
  { id: "kleomedes-public", provider: "Kleomedes", plan: "Public", clientShare: 49, termsVerifiedAt: "2026-09-22", domain: "kleomedes.cloud", website: "https://kleomedes.cloud" },
  { id: "kalorius-public", provider: "Kalorius.tech", plan: "public staking", clientShare: 20, termsVerifiedAt: "2026-09-22", domain: "kalorius.tech", website: "https://kalorius.tech/" },
  { id: "nodefleet-public", provider: "Nodefleet", plan: "Nodefleet-Public", clientShare: 75, termsVerifiedAt: "2026-09-22", domain: "nodefleet.net", website: "https://nodefleet.org/" },
  { id: "purroofgroup-public", provider: "purroofgroup", plan: "sv1-default", clientShare: 78, termsVerifiedAt: "2026-09-22", domain: "purroofgroup.com", website: "https://www.purroofgroup.com/" },
  { id: "easy2stake-public", provider: "Easy2stake", plan: "igniter-1-eu-a", clientShare: 50, termsVerifiedAt: "2026-09-22", domain: "easy2stake.com", website: "https://www.easy2stake.com/" }
];

function getPlanDomain(planId: string): string | null {
  return PLAN_METADATA.find((metadata) => metadata.id === planId)?.domain ?? null;
}

const LAST_KNOWN_GOOD = [
  { ...PLAN_METADATA[0], apr: 65.3, displayedYield: 107.32 },
  { ...PLAN_METADATA[1], apr: 40.7, displayedYield: 66.95 },
  { ...PLAN_METADATA[2], apr: 28.4, displayedYield: 46.64 },
  { ...PLAN_METADATA[3], apr: 18.8, displayedYield: 30.92 },
  { ...PLAN_METADATA[4], apr: 13.5, displayedYield: 22.19 }
].map(({ domain: _domain, ...plan }) => ({
  ...plan,
  rewardStatus: "unavailable" as const,
  valueSource: "static-cold-start" as const,
  sourceUpdatedAt: null,
  fetchedAt: "",
  diagnosticReason: "no live-derived provider economics available"
}));

let lastSuccessfulSnapshot: StakingPlansSnapshot | null = null;
let lastServedSnapshot: StakingPlansSnapshot | null = null;
let lastProviderPlans = new Map<string, PublicPlan>();
let lastAllocationValue: string | null = null;
let lastMinimumStake: number | null = null;
type GraphQLResponse<T> = { data?: T; errors?: Array<{ message: string }> };

export function extractLatestBlockTimestamp(source: IgniterLatestBlock): string | null {
  const timestamp = source.blocks?.nodes?.[0]?.timestamp;
  if (timestamp == null) return null;
  // Igniter returns a timezone-less ISO timestamp, but it represents UTC.
  // Appending Z avoids interpreting it as the server's local timezone.
  const normalizedInput = typeof timestamp === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(timestamp)
    ? `${timestamp}Z`
    : String(timestamp);
  return normalizeSourceTimestamp(normalizedInput);
}

export function getStakingDiagnostics(): {
  fetchedAt: string | null;
  sourceUpdatedAt: string | null;
  stale: boolean;
  source: StakingPlansSnapshot["source"] | null;
  staticFallbackActive: boolean;
  allocationStatus: "live" | "stale" | "unavailable" | null;
  minimumStakeStatus: "live" | "stale" | "unavailable" | null;
  providers: Array<{
    id: string;
    provider: string;
    domain: string | null;
    status: RewardStatus;
    valueSource: PlanValueSource;
    sourceUpdatedAt: string | null;
    fetchedAt: string;
    reason: string | null;
  }>;
} {
  const snapshot = lastServedSnapshot;
  return {
    fetchedAt: snapshot?.fetchedAt ?? null,
    sourceUpdatedAt: snapshot?.sourceUpdatedAt ?? null,
    stale: snapshot?.stale ?? true,
    source: snapshot?.source ?? null,
    staticFallbackActive: snapshot?.plans.every((plan) => plan.valueSource === "static-cold-start") ?? true,
    allocationStatus: snapshot?.allocationStatus ?? null,
    minimumStakeStatus: snapshot?.minimumStakeStatus ?? null,
    providers: (snapshot?.plans ?? []).map((plan) => ({
      id: plan.id,
      provider: plan.provider,
      domain: getPlanDomain(plan.id),
      status: plan.rewardStatus,
      valueSource: plan.valueSource,
      sourceUpdatedAt: plan.sourceUpdatedAt,
      fetchedAt: plan.fetchedAt,
      reason: plan.diagnosticReason ?? null
    }))
  };
}

function isStakingSnapshotCacheFresh(snapshot: StakingPlansSnapshot, now: number): boolean {
  const fetchedAt = new Date(snapshot.fetchedAt).getTime();
  return !snapshot.stale && Number.isFinite(fetchedAt) && fetchedAt <= now && now - fetchedAt < REFRESH_INTERVAL_MS &&
    isSourceFresh(snapshot.sourceUpdatedAt, now, REFRESH_INTERVAL_MS);
}

async function fetchGraphQL<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(IGNITER_GRAPHQL_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }), cache: "no-store", signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Pocket GraphQL returned ${response.status}`);
  const body = await response.json() as GraphQLResponse<T>;
  if (body.errors?.length || !body.data) throw new Error(body.errors?.[0]?.message ?? "Pocket GraphQL returned no data");
  return body.data;
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function getUniformClientShare(metadata: ProviderPlanMetadata): number | null {
  const configuredShares = metadata.clientSharesByService
    ? Object.values(metadata.clientSharesByService)
    : [metadata.clientShare];
  if (configuredShares.length === 0 || configuredShares.some((share) => !Number.isFinite(share) || share < 0 || share > 100)) return null;
  const minimum = Math.min(...configuredShares);
  const maximum = Math.max(...configuredShares);
  return maximum - minimum <= 0.05 ? configuredShares[0] : null;
}

async function fetchMinimumSupplierStake(): Promise<number> {
  const response = await fetch(`${POCKET_REST_URL}/pokt-network/poktroll/supplier/params`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Pocket supplier params returned ${response.status}`);
  const body = await response.json() as { params?: { min_stake?: { amount?: string | number } } };
  const upokt = toNumber(body.params?.min_stake?.amount);
  if (upokt == null || upokt <= 0) throw new Error("Pocket supplier minimum stake is unavailable");
  return upokt / 1_000_000;
}

export function buildLivePlans(
  source: IgniterSource,
  rewardsByDomain: Map<string, IgniterRewardService[]>,
  minimumStake: number,
  now = new Date(),
  metadata = PLAN_METADATA
): StakingPlansSnapshot {
  const sourceUpdatedAt = normalizeSourceTimestamp(source.sourceUpdatedAt);
  const allocationValue = source.allocation?.value;
  if (!allocationValue) throw new Error("Pocket GraphQL supplier allocation is unavailable");
  let supplierAllocation: number;
  try {
    supplierAllocation = toNumber((JSON.parse(allocationValue) as { supplier?: unknown }).supplier) ?? NaN;
  } catch {
    supplierAllocation = NaN;
  }
  if (!Number.isFinite(supplierAllocation) || supplierAllocation < 0 || supplierAllocation > 1) {
    throw new Error("Pocket GraphQL supplier allocation is invalid");
  }

  const plans = metadata.map((planMetadata): PublicPlan | null => {
    const services = rewardsByDomain.get(planMetadata.domain);
    if (!services || services.length === 0) return null;
    let grossSevenDayPerSupplierUpokt = 0;
    for (const service of services) {
      const gross = toNumber(service.gross_rewards);
      const suppliers = toNumber(service.staked_suppliers);
      if (gross == null || suppliers == null || suppliers <= 0) return null;
      // This mirrors Igniter's address-group workflow: supplier allocation is
      // applied to gross rewards before dividing by the service's live
      // supplier count, then the UI divides the seven-day total by seven.
      grossSevenDayPerSupplierUpokt += Math.floor(gross * supplierAllocation) / suppliers;
    }
    const clientShare = getUniformClientShare(planMetadata);
    if (clientShare == null) return null;
    const economics = derivePlanEconomics(grossSevenDayPerSupplierUpokt, clientShare, minimumStake);
    return {
      ...planMetadata,
      clientShare,
      displayedYield: economics.netDailyPokt,
      apr: economics.apr,
      rewardStatus: isSourceFresh(sourceUpdatedAt, now.getTime(), REFRESH_INTERVAL_MS) ? "live" : "stale",
      valueSource: isSourceFresh(sourceUpdatedAt, now.getTime(), REFRESH_INTERVAL_MS) ? "live-derived" : "stale-derived",
      sourceUpdatedAt,
      fetchedAt: now.toISOString()
    };
  }).filter((plan): plan is PublicPlan => plan !== null)
    .filter((plan) => plan.apr > MINIMUM_DISPLAY_APR)
    .sort((a, b) => b.apr - a.apr || a.provider.localeCompare(b.provider));
  if (plans.length === 0) throw new Error("Pocket GraphQL returned no configured public provider plans");

  const sourceFresh = isSourceFresh(sourceUpdatedAt, now.getTime(), REFRESH_INTERVAL_MS);
  return { plans, fetchedAt: now.toISOString(), sourceUpdatedAt, minimumSupplierStake: minimumStake, stale: !sourceFresh, source: "igniter-indexer", allocationStatus: sourceFresh ? "live" : "stale", minimumStakeStatus: sourceFresh ? "live" : "stale" };
}

function parseSupplierAllocation(value: string | null | undefined): number | null {
  if (!value) return null;
  try {
    const allocation = toNumber((JSON.parse(value) as { supplier?: unknown }).supplier);
    return allocation != null && allocation >= 0 && allocation <= 1 ? allocation : null;
  } catch {
    return null;
  }
}

function unavailablePlan(metadata: ProviderPlanMetadata, now: Date, sourceUpdatedAt: string | null, reason: string): PublicPlan {
  return {
    ...metadata,
    apr: 0,
    displayedYield: 0,
    rewardStatus: "unavailable",
    valueSource: "static-cold-start",
    sourceUpdatedAt,
    fetchedAt: now.toISOString(),
    diagnosticReason: reason
  };
}

function deriveProviderPlan(
  metadata: ProviderPlanMetadata,
  services: IgniterRewardService[],
  supplierAllocation: number,
  minimumStake: number,
  now: Date,
  sourceUpdatedAt: string,
  sourceFresh: boolean
): PublicPlan | null {
  let grossSevenDayPerSupplierUpokt = 0;
  for (const service of services) {
    const gross = toNumber(service.gross_rewards);
    const suppliers = toNumber(service.staked_suppliers);
    if (gross == null || suppliers == null || suppliers <= 0) return null;
    grossSevenDayPerSupplierUpokt += Math.floor(gross * supplierAllocation) / suppliers;
  }
  const clientShare = getUniformClientShare(metadata);
  if (clientShare == null) return null;
  const economics = derivePlanEconomics(grossSevenDayPerSupplierUpokt, clientShare, minimumStake);
  return {
    ...metadata,
    clientShare,
    displayedYield: economics.netDailyPokt,
    apr: economics.apr,
    rewardStatus: sourceFresh ? "live" : "stale",
    valueSource: sourceFresh ? "live-derived" : "stale-derived",
    sourceUpdatedAt,
    fetchedAt: now.toISOString()
  };
}

function buildPartialPlans(
  sourceUpdatedAt: string | null,
  allocationValue: string | null,
  minimumStake: number | null,
  allocationStatus: "live" | "stale" | "unavailable",
  minimumStakeStatus: "live" | "stale" | "unavailable",
  rewardEntries: Map<string, { services: IgniterRewardService[]; error?: string }>,
  now: Date
): StakingPlansSnapshot {
  const sourceFresh = isSourceFresh(sourceUpdatedAt, now.getTime(), REFRESH_INTERVAL_MS);
  const supplierAllocation = parseSupplierAllocation(allocationValue);
  const plans = PLAN_METADATA.map((metadata): PublicPlan => {
    const entry = rewardEntries.get(metadata.domain);
    const reason = entry?.error ?? (!entry || entry.services.length === 0 ? "provider reward query returned no usable services" : null);
    const livePlan = supplierAllocation != null && minimumStake != null && Boolean(sourceUpdatedAt) && !reason
      ? deriveProviderPlan(metadata, entry?.services ?? [], supplierAllocation, minimumStake, now, sourceUpdatedAt as string, sourceFresh)
      : null;
    if (livePlan) {
      lastProviderPlans.set(metadata.id, livePlan);
      return livePlan;
    }
    const previous = lastProviderPlans.get(metadata.id);
    if (previous) {
      return {
        ...previous,
        rewardStatus: "stale" as const,
        valueSource: "provider-lkg" as const,
        fetchedAt: now.toISOString(),
        diagnosticReason: reason ?? (sourceUpdatedAt ? "upstream source is stale" : "latest source timestamp unavailable")
      };
    }
    return unavailablePlan(metadata, now, sourceUpdatedAt, reason ?? "global staking input unavailable");
  }).filter((plan): plan is PublicPlan => plan != null)
    .sort((a, b) => b.apr - a.apr || a.provider.localeCompare(b.provider));

  const liveDerivedCount = plans.filter((plan) => plan.valueSource === "live-derived").length;
  const anyDerivedCount = plans.filter((plan) => plan.valueSource !== "static-cold-start").length;
  const stale = plans.some((plan) => plan.rewardStatus !== "live") || allocationStatus !== "live" || minimumStakeStatus !== "live" || !sourceFresh;
  return {
    plans,
    fetchedAt: now.toISOString(),
    sourceUpdatedAt,
    minimumSupplierStake: minimumStake ?? lastMinimumStake ?? DEFAULT_POKT_PER_SUPPLIER,
    stale,
    source: liveDerivedCount > 0 || anyDerivedCount > 0 ? "igniter-indexer" : "last-known-good",
    allocationStatus,
    minimumStakeStatus
  };
}

async function fetchLivePlans(): Promise<StakingPlansSnapshot> {
  const now = new Date();
  const [latestResult, allocationResult, minimumStakeResult] = await Promise.allSettled([
    fetchGraphQL<IgniterLatestBlock>(IGNITER_LATEST_BLOCK_QUERY),
    fetchGraphQL<IgniterAllocation>(IGNITER_ALLOCATION_QUERY),
    fetchMinimumSupplierStake()
  ]);
  const latestBlock = latestResult.status === "fulfilled" ? extractLatestBlockTimestamp(latestResult.value) : null;
  const sourceUpdatedAt = latestBlock ?? lastSuccessfulSnapshot?.sourceUpdatedAt ?? null;
  const allocationValue = allocationResult.status === "fulfilled" ? allocationResult.value.allocation?.value ?? null : lastAllocationValue;
  const minimumStake = minimumStakeResult.status === "fulfilled" ? minimumStakeResult.value : lastMinimumStake;
  const allocationStatus = allocationResult.status === "fulfilled" ? "live" : lastAllocationValue ? "stale" : "unavailable";
  const minimumStakeStatus = minimumStakeResult.status === "fulfilled" ? "live" : lastMinimumStake != null ? "stale" : "unavailable";
  if (allocationResult.status === "fulfilled" && allocationValue) lastAllocationValue = allocationValue;
  if (minimumStakeResult.status === "fulfilled") lastMinimumStake = minimumStakeResult.value;

  const anchor = sourceUpdatedAt ? new Date(sourceUpdatedAt) : now;
  const endTs = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate(), 23, 59, 59, 999));
  const startTs = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() - 6, 0, 0, 0, 0));
  const rewardResults: Array<readonly [string, { services: IgniterRewardService[]; error?: string }]> = [];
  const settledRewards = await Promise.allSettled(PLAN_METADATA.map((metadata) => fetchGraphQL<{ rewards?: IgniterRewardPayload }>(IGNITER_REWARDS_QUERY, {
    domains: [metadata.domain], startTs: startTs.toISOString(), endTs: endTs.toISOString()
  })));
  settledRewards.forEach((result, index) => {
    const metadata = PLAN_METADATA[index];
    if (result.status === "fulfilled") {
      rewardResults.push([metadata.domain, { services: result.value.rewards?.services ?? [] }]);
    } else {
      rewardResults.push([metadata.domain, { services: [], error: result.reason instanceof Error ? result.reason.message : String(result.reason) }]);
    }
  });
  return buildPartialPlans(sourceUpdatedAt, allocationValue, minimumStake, allocationStatus, minimumStakeStatus, new Map(rewardResults), now);
}

async function loadStakingPlans(fetcher: () => Promise<StakingPlansSnapshot> = fetchLivePlans, now = Date.now()): Promise<StakingPlansSnapshot> {
  if (lastSuccessfulSnapshot && isStakingSnapshotCacheFresh(lastSuccessfulSnapshot, now)) {
    lastServedSnapshot = lastSuccessfulSnapshot;
    return lastSuccessfulSnapshot;
  }
  try {
    lastSuccessfulSnapshot = await fetcher();
    lastServedSnapshot = lastSuccessfulSnapshot;
    return lastSuccessfulSnapshot;
  } catch (error) {
    const refreshError = error instanceof StakingRefreshError ? error : null;
    console.warn("[pocket-dashboard:staking] live refresh failed", {
      stage: refreshError?.stage ?? "unknown",
      error: error instanceof Error ? error.message : String(error),
      fallback: lastSuccessfulSnapshot ? "last-known-good" : "static-last-known-good",
      sourceUpdatedAt: lastSuccessfulSnapshot?.sourceUpdatedAt ?? null,
      fetchedAt: lastSuccessfulSnapshot?.fetchedAt ?? null
    });
    if (lastSuccessfulSnapshot) {
      lastServedSnapshot = {
        ...lastSuccessfulSnapshot,
        plans: lastSuccessfulSnapshot.plans.map((plan) => plan.valueSource === "static-cold-start" ? plan : {
          ...plan,
          rewardStatus: "stale" as const,
          valueSource: "provider-lkg" as const,
          fetchedAt: new Date().toISOString(),
          diagnosticReason: "live refresh failed; serving provider last-known-good"
        }),
        stale: true,
        source: "last-known-good",
        allocationStatus: lastSuccessfulSnapshot.allocationStatus === "live" ? "stale" : lastSuccessfulSnapshot.allocationStatus,
        minimumStakeStatus: lastSuccessfulSnapshot.minimumStakeStatus === "live" ? "stale" : lastSuccessfulSnapshot.minimumStakeStatus
      };
      return lastServedSnapshot;
    }
    lastServedSnapshot = {
      plans: LAST_KNOWN_GOOD,
      fetchedAt: new Date().toISOString(),
      sourceUpdatedAt: null,
      minimumSupplierStake: DEFAULT_POKT_PER_SUPPLIER,
      stale: true,
      source: "last-known-good",
      allocationStatus: "unavailable",
      minimumStakeStatus: "unavailable"
    };
    return lastServedSnapshot;
  }
}

export const getStakingPlans = () => loadStakingPlans();
export const __testing = {
  fetchLivePlans,
  loadStakingPlans,
  buildLivePlans,
  resetLastSuccessfulSnapshot: () => {
    lastSuccessfulSnapshot = null;
    lastServedSnapshot = null;
    lastProviderPlans = new Map();
    lastAllocationValue = null;
    lastMinimumStake = null;
  }
};
