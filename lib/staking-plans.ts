import { derivePlanEconomics, isSourceFresh, normalizeSourceTimestamp } from "@/lib/staking-economics";

export const DEFAULT_POKT_PER_SUPPLIER = 59_500;
export const MINIMUM_DISPLAY_APR = 10;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const IGNITER_GRAPHQL_URL = "https://data.pocket.network/";
const POCKET_REST_URL = "https://sauron-api.infra.pocket.network";

export type PublicPlan = {
  id: string;
  provider: string;
  plan: string;
  apr: number;
  clientShare: number;
  displayedYield: number;
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

type ProviderPlanMetadata = Omit<PublicPlan, "apr" | "displayedYield"> & { domain: string };
type IgniterRewardService = {
  gross_rewards?: string | number | null;
  staked_suppliers?: string | number | null;
};
type IgniterRewardPayload = { services?: IgniterRewardService[] };
type IgniterSource = {
  status?: { lastProcessedTimestamp?: string | null };
  allocation?: { value?: string | null } | null;
};

// Igniter's public UI does not expose an unauthenticated plan-status endpoint.
// Keep plan terms explicit, but source reward economics and the protocol minimum
// stake from the same public Pocket services used by Igniter.
const PLAN_METADATA: ProviderPlanMetadata[] = [
  { id: "kleomedes-public", provider: "Kleomedes", plan: "Public", clientShare: 49, domain: "kleomedes.cloud", website: "https://kleomedes.cloud" },
  { id: "kalorius-public", provider: "Kalorius.tech", plan: "public staking", clientShare: 20, domain: "kalorius.tech", website: "https://kalorius.tech/" },
  { id: "nodefleet-public", provider: "Nodefleet", plan: "Nodefleet-Public", clientShare: 75, domain: "nodefleet.org", website: "https://nodefleet.org/" },
  { id: "purroofgroup-public", provider: "purroofgroup", plan: "sv1-default", clientShare: 78, domain: "purroofgroup.com", website: "https://www.purroofgroup.com/" },
  { id: "easy2stake-public", provider: "Easy2stake", plan: "igniter-1-eu-a", clientShare: 50, domain: "easy2stake.com", website: "https://www.easy2stake.com/" }
];

const LAST_KNOWN_GOOD: PublicPlan[] = [
  { ...PLAN_METADATA[0], apr: 65.3, displayedYield: 107.32 },
  { ...PLAN_METADATA[1], apr: 40.7, displayedYield: 66.95 },
  { ...PLAN_METADATA[2], apr: 28.4, displayedYield: 46.64 },
  { ...PLAN_METADATA[3], apr: 18.8, displayedYield: 30.92 },
  { ...PLAN_METADATA[4], apr: 13.5, displayedYield: 22.19 }
].map(({ domain: _domain, ...plan }) => plan);

let lastSuccessfulSnapshot: StakingPlansSnapshot | null = null;
type GraphQLResponse<T> = { data?: T; errors?: Array<{ message: string }> };

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
  const sourceUpdatedAt = normalizeSourceTimestamp(source.status?.lastProcessedTimestamp);
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
    const economics = derivePlanEconomics(grossSevenDayPerSupplierUpokt, planMetadata.clientShare, minimumStake);
    return { ...planMetadata, displayedYield: economics.netDailyPokt, apr: economics.apr };
  }).filter((plan): plan is ProviderPlanMetadata & { displayedYield: number; apr: number } => plan !== null)
    .filter((plan) => plan.apr > MINIMUM_DISPLAY_APR)
    .sort((a, b) => b.apr - a.apr || a.provider.localeCompare(b.provider))
    .map(({ domain: _domain, ...plan }) => plan);
  if (plans.length === 0) throw new Error("Pocket GraphQL returned no configured public provider plans");

  return { plans, fetchedAt: now.toISOString(), sourceUpdatedAt, minimumSupplierStake: minimumStake, stale: false, source: "igniter-indexer" };
}

async function fetchLivePlans(): Promise<StakingPlansSnapshot> {
  const now = new Date();
  const sourceQuery = `query {
    status: _metadata { lastProcessedTimestamp }
    allocation: param(id: "tokenomics-mint_allocation_percentages") { value }
  }`;
  const source = await fetchGraphQL<IgniterSource>(sourceQuery);
  const sourceUpdatedAt = normalizeSourceTimestamp(source.status?.lastProcessedTimestamp);
  if (!sourceUpdatedAt) throw new Error("Pocket GraphQL latest block timestamp is unavailable");
  const latestBlock = new Date(sourceUpdatedAt);
  const endTs = new Date(Date.UTC(latestBlock.getUTCFullYear(), latestBlock.getUTCMonth(), latestBlock.getUTCDate(), 23, 59, 59, 999));
  const startTs = new Date(Date.UTC(latestBlock.getUTCFullYear(), latestBlock.getUTCMonth(), latestBlock.getUTCDate() - 6, 0, 0, 0, 0));
  const rewardsQuery = `query($domains: [String!], $startTs: Datetime!, $endTs: Datetime!) {
    rewards: getRewardsByDomainsAndTimeGroupByService(domains: $domains, startTs: $startTs, endTs: $endTs)
  }`;
  const rewardEntries = await Promise.all(PLAN_METADATA.map(async (metadata) => {
    const data = await fetchGraphQL<{ rewards?: IgniterRewardPayload }>(rewardsQuery, {
      domains: [metadata.domain], startTs: startTs.toISOString(), endTs: endTs.toISOString()
    });
    return [metadata.domain, data.rewards?.services ?? []] as const;
  }));
  const minimumStake = await fetchMinimumSupplierStake();
  return buildLivePlans(source, new Map(rewardEntries), minimumStake, now);
}

async function loadStakingPlans(fetcher: () => Promise<StakingPlansSnapshot> = fetchLivePlans): Promise<StakingPlansSnapshot> {
  const now = Date.now();
  if (lastSuccessfulSnapshot && now - new Date(lastSuccessfulSnapshot.fetchedAt).getTime() < REFRESH_INTERVAL_MS) return lastSuccessfulSnapshot;
  try {
    lastSuccessfulSnapshot = await fetcher();
    return lastSuccessfulSnapshot;
  } catch {
    if (lastSuccessfulSnapshot) return { ...lastSuccessfulSnapshot, stale: true, source: "last-known-good" };
    return { plans: LAST_KNOWN_GOOD, fetchedAt: new Date().toISOString(), sourceUpdatedAt: null, minimumSupplierStake: DEFAULT_POKT_PER_SUPPLIER, stale: true, source: "last-known-good" };
  }
}

export const getStakingPlans = () => loadStakingPlans();
export const __testing = {
  fetchLivePlans,
  loadStakingPlans,
  buildLivePlans,
  resetLastSuccessfulSnapshot: () => { lastSuccessfulSnapshot = null; }
};
