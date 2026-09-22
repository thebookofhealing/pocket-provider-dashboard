import { unstable_cache } from "next/cache";
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
type RewardRow = { domain?: string | null; day?: string | null; grossRewards?: string | number | null; suppliersCount?: number | null };

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

function isoDate(date: Date): string { return date.toISOString().slice(0, 10); }

async function fetchMinimumSupplierStake(): Promise<number> {
  const response = await fetch(`${POCKET_REST_URL}/pokt-network/poktroll/supplier/params`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Pocket supplier params returned ${response.status}`);
  const body = await response.json() as { params?: { min_stake?: { amount?: string | number } } };
  const upokt = toNumber(body.params?.min_stake?.amount);
  if (upokt == null || upokt <= 0) throw new Error("Pocket supplier minimum stake is unavailable");
  return upokt / 1_000_000;
}

async function fetchLivePlans(): Promise<StakingPlansSnapshot> {
  const now = new Date();
  const start = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  const query = `query($start: Date!, $end: Date!) {
    status: _metadata { lastProcessedTimestamp }
    rewards: domainServiceDailyRewards(filter: { day: { greaterThanOrEqualTo: $start, lessThanOrEqualTo: $end } }, first: 5000) {
      nodes { domain day grossRewards suppliersCount }
    }
  }`;
  const [rewardData, minimumStake] = await Promise.all([
    fetchGraphQL<{ status?: { lastProcessedTimestamp?: string | null }; rewards?: { nodes?: RewardRow[] } }>(query, { start: isoDate(start), end: isoDate(now) }),
    fetchMinimumSupplierStake()
  ]);
  const rows = rewardData.rewards?.nodes ?? [];
  if (rows.length === 0) throw new Error("Pocket GraphQL returned no seven-day provider rewards");

  const rewardsByDomain = new Map<string, number>();
  for (const row of rows) {
    const domain = row.domain?.toLowerCase().trim();
    const gross = toNumber(row.grossRewards);
    const suppliers = toNumber(row.suppliersCount);
    if (!domain || gross == null || suppliers == null || suppliers <= 0) continue;
    rewardsByDomain.set(domain, (rewardsByDomain.get(domain) ?? 0) + gross / suppliers);
  }
  const sourceUpdatedAt = normalizeSourceTimestamp(rewardData.status?.lastProcessedTimestamp);
  if (!isSourceFresh(sourceUpdatedAt, now.getTime(), REFRESH_INTERVAL_MS)) throw new Error("Pocket GraphQL reward source is stale");

  const plans = PLAN_METADATA.map((metadata) => {
    const grossSevenDayPerSupplierUpokt = rewardsByDomain.get(metadata.domain);
    if (grossSevenDayPerSupplierUpokt == null) return null;
    const economics = derivePlanEconomics(grossSevenDayPerSupplierUpokt, metadata.clientShare, minimumStake);
    return { ...metadata, displayedYield: economics.netDailyPokt, apr: economics.apr };
  }).filter((plan): plan is ProviderPlanMetadata & { displayedYield: number; apr: number } => plan !== null)
    .filter((plan) => plan.apr > MINIMUM_DISPLAY_APR)
    .sort((a, b) => b.apr - a.apr || a.provider.localeCompare(b.provider))
    .map(({ domain: _domain, ...plan }) => plan);
  if (plans.length === 0) throw new Error("Pocket GraphQL returned no configured public provider plans");

  return { plans, fetchedAt: now.toISOString(), sourceUpdatedAt, minimumSupplierStake: minimumStake, stale: false, source: "igniter-indexer" };
}

async function loadStakingPlans(): Promise<StakingPlansSnapshot> {
  const now = Date.now();
  if (lastSuccessfulSnapshot && now - new Date(lastSuccessfulSnapshot.fetchedAt).getTime() < REFRESH_INTERVAL_MS) return lastSuccessfulSnapshot;
  try {
    lastSuccessfulSnapshot = await fetchLivePlans();
    return lastSuccessfulSnapshot;
  } catch {
    if (lastSuccessfulSnapshot) return { ...lastSuccessfulSnapshot, stale: true, source: "last-known-good" };
    return { plans: LAST_KNOWN_GOOD, fetchedAt: new Date().toISOString(), sourceUpdatedAt: null, minimumSupplierStake: DEFAULT_POKT_PER_SUPPLIER, stale: true, source: "last-known-good" };
  }
}

export const getStakingPlans = unstable_cache(loadStakingPlans, ["staking-plans"], { revalidate: 15 * 60, tags: ["staking-plans"] });
export const __testing = { fetchLivePlans, loadStakingPlans };
