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

export type PublicPlan = {
  id: string;
  provider: string;
  plan: string;
  apr: number;
  clientShare: number;
  displayedYield: number;
  termsVerifiedAt: string;
  website?: string;
};

export type StakingPlansSnapshot = {
  plans: PublicPlan[];
  fetchedAt: string;
  sourceUpdatedAt: string | null;
  minimumSupplierStake: number;
  stale: boolean;
  source: "igniter-indexer" | "last-known-good";
};

type ProviderPlanMetadata = Omit<PublicPlan, "apr" | "displayedYield"> & {
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
  { id: "nodefleet-public", provider: "Nodefleet", plan: "Nodefleet-Public", clientShare: 75, termsVerifiedAt: "2026-09-22", domain: "nodefleet.org", website: "https://nodefleet.org/" },
  { id: "purroofgroup-public", provider: "purroofgroup", plan: "sv1-default", clientShare: 78, termsVerifiedAt: "2026-09-22", domain: "purroofgroup.com", website: "https://www.purroofgroup.com/" },
  { id: "easy2stake-public", provider: "Easy2stake", plan: "igniter-1-eu-a", clientShare: 50, termsVerifiedAt: "2026-09-22", domain: "easy2stake.com", website: "https://www.easy2stake.com/" }
];

const LAST_KNOWN_GOOD: PublicPlan[] = [
  { ...PLAN_METADATA[0], apr: 65.3, displayedYield: 107.32 },
  { ...PLAN_METADATA[1], apr: 40.7, displayedYield: 66.95 },
  { ...PLAN_METADATA[2], apr: 28.4, displayedYield: 46.64 },
  { ...PLAN_METADATA[3], apr: 18.8, displayedYield: 30.92 },
  { ...PLAN_METADATA[4], apr: 13.5, displayedYield: 22.19 }
].map(({ domain: _domain, ...plan }) => plan);

let lastSuccessfulSnapshot: StakingPlansSnapshot | null = null;
let lastServedSnapshot: StakingPlansSnapshot | null = null;
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
} {
  const snapshot = lastServedSnapshot;
  return {
    fetchedAt: snapshot?.fetchedAt ?? null,
    sourceUpdatedAt: snapshot?.sourceUpdatedAt ?? null,
    stale: snapshot?.stale ?? true,
    source: snapshot?.source ?? null,
    staticFallbackActive: snapshot?.source === "last-known-good" && snapshot.sourceUpdatedAt == null
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
  if (!isSourceFresh(sourceUpdatedAt, now.getTime(), REFRESH_INTERVAL_MS)) throw new Error("Pocket GraphQL reward source is stale");
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

  const plans = metadata.map((planMetadata) => {
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
    return { ...planMetadata, clientShare, displayedYield: economics.netDailyPokt, apr: economics.apr };
  }).filter((plan): plan is ProviderPlanMetadata & { displayedYield: number; apr: number } => plan !== null)
    .filter((plan) => plan.apr > MINIMUM_DISPLAY_APR)
    .sort((a, b) => b.apr - a.apr || a.provider.localeCompare(b.provider))
    .map(({ domain: _domain, ...plan }) => plan);
  if (plans.length === 0) throw new Error("Pocket GraphQL returned no configured public provider plans");

  return { plans, fetchedAt: now.toISOString(), sourceUpdatedAt, minimumSupplierStake: minimumStake, stale: false, source: "igniter-indexer" };
}

async function fetchLivePlans(): Promise<StakingPlansSnapshot> {
  const now = new Date();
  let sourceUpdatedAt: string | null;
  let allocation: IgniterAllocation["allocation"];
  try {
    const [latestBlock, allocationResponse] = await Promise.all([
      fetchGraphQL<IgniterLatestBlock>(IGNITER_LATEST_BLOCK_QUERY),
      fetchGraphQL<IgniterAllocation>(IGNITER_ALLOCATION_QUERY)
    ]);
    sourceUpdatedAt = extractLatestBlockTimestamp(latestBlock);
    allocation = allocationResponse.allocation;
  } catch (error) {
    throw new StakingRefreshError("source", error);
  }
  if (!sourceUpdatedAt) throw new Error("Pocket GraphQL latest block timestamp is unavailable");
  const latestBlock = new Date(sourceUpdatedAt);
  const endTs = new Date(Date.UTC(latestBlock.getUTCFullYear(), latestBlock.getUTCMonth(), latestBlock.getUTCDate(), 23, 59, 59, 999));
  const startTs = new Date(Date.UTC(latestBlock.getUTCFullYear(), latestBlock.getUTCMonth(), latestBlock.getUTCDate() - 6, 0, 0, 0, 0));
  let rewardEntries: Array<readonly [string, IgniterRewardService[]]>;
  try {
    rewardEntries = await Promise.all(PLAN_METADATA.map(async (metadata) => {
      const data = await fetchGraphQL<{ rewards?: IgniterRewardPayload }>(IGNITER_REWARDS_QUERY, {
        domains: [metadata.domain], startTs: startTs.toISOString(), endTs: endTs.toISOString()
      });
      return [metadata.domain, data.rewards?.services ?? []] as const;
    }));
  } catch (error) {
    throw new StakingRefreshError("rewards", error);
  }
  let minimumStake: number;
  try {
    minimumStake = await fetchMinimumSupplierStake();
  } catch (error) {
    throw new StakingRefreshError("minimum-stake", error);
  }
  try {
    return buildLivePlans({ sourceUpdatedAt, allocation }, new Map(rewardEntries), minimumStake, now);
  } catch (error) {
    throw new StakingRefreshError("derive", error);
  }
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
      lastServedSnapshot = { ...lastSuccessfulSnapshot, stale: true, source: "last-known-good" };
      return lastServedSnapshot;
    }
    lastServedSnapshot = { plans: LAST_KNOWN_GOOD, fetchedAt: new Date().toISOString(), sourceUpdatedAt: null, minimumSupplierStake: DEFAULT_POKT_PER_SUPPLIER, stale: true, source: "last-known-good" };
    return lastServedSnapshot;
  }
}

export const getStakingPlans = () => loadStakingPlans();
export const __testing = {
  fetchLivePlans,
  loadStakingPlans,
  buildLivePlans,
  resetLastSuccessfulSnapshot: () => { lastSuccessfulSnapshot = null; lastServedSnapshot = null; }
};
