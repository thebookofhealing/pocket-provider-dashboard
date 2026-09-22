import { unstable_cache } from "next/cache";

export const POKT_PER_SUPPLIER = 59_500;
export const MINIMUM_DISPLAY_APR = 10;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

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
  stale: boolean;
  source: "igniter" | "last-known-good";
};

type RawPlan = Record<string, unknown>;

// This is only a last-known-good safety net. It is never presented as live and
// is replaced by the configured Igniter feed whenever that feed is available.
const LAST_KNOWN_GOOD: PublicPlan[] = [
  { id: "kleomedes-public", provider: "Kleomedes", plan: "Public", apr: 65.3, clientShare: 49, displayedYield: 107.32, website: "https://kleomedes.cloud" },
  { id: "kalorius-public", provider: "Kalorius.tech", plan: "public staking", apr: 40.7, clientShare: 20, displayedYield: 66.95, website: "https://kalorius.tech/" },
  { id: "nodefleet-public", provider: "Nodefleet", plan: "Nodefleet-Public", apr: 28.4, clientShare: 75, displayedYield: 46.64, website: "https://nodefleet.org/" },
  { id: "purroofgroup-public", provider: "purroofgroup", plan: "sv1-default", apr: 18.8, clientShare: 78, displayedYield: 30.92, website: "https://www.purroofgroup.com/" },
  { id: "easy2stake-public", provider: "Easy2stake", plan: "igniter-1-eu-a", apr: 13.5, clientShare: 50, displayedYield: 22.19, website: "https://www.easy2stake.com/" }
];

let lastSuccessfulSnapshot: StakingPlansSnapshot | null = null;

function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePlan(raw: RawPlan, index: number): PublicPlan | null {
  const provider = String(raw.provider ?? raw.providerName ?? raw.name ?? "").trim();
  if (!provider) return null;
  const plan = String(raw.plan ?? raw.planName ?? raw.addressGroup ?? "Public").trim() || "Public";
  const serviceRows = Array.isArray(raw.addressGroupServices) ? raw.addressGroupServices.filter((row): row is RawPlan => Boolean(row && typeof row === "object")) : [];
  const derivedClientShare = serviceRows.length > 0
    ? serviceRows.reduce((sum, service) => {
      const providerShare = Array.isArray(service.revShare) ? service.revShare.reduce((inner, share) => inner + (number((share as RawPlan).share) ?? 0), 0) : 0;
      const supplierShare = service.addSupplierShare ? (number(service.supplierShare) ?? 0) : 0;
      return sum + Math.max(0, 100 - providerShare - supplierShare - (number(raw.delegatorFee) ?? 0));
    }, 0) / serviceRows.length
    : null;
  const clientShare = number(raw.clientShare ?? raw.client_share ?? raw.delegatorShare) ?? derivedClientShare;
  const rewardRows = Array.isArray(raw.grossRewardsPerService) ? raw.grossRewardsPerService.filter((row): row is RawPlan => Boolean(row && typeof row === "object")) : [];
  const grossDailyFromRows = rewardRows.length > 0
    ? rewardRows.reduce<number | null>((sum, row) => {
      const amount = number(row.amount);
      const suppliers = number(row.staked_suppliers ?? raw.rewardsSuppliersCount);
      if (amount == null || !suppliers || suppliers <= 0) return null;
      return sum == null ? null : sum + amount / suppliers;
    }, 0)
    : null;
  const grossDaily = number(raw.grossRewardsPerSupplierPerDay ?? raw.grossDailyPokt ?? raw.grossYieldPerSupplier ?? raw.grossRewardsPerSupplier7d)
    ?? (grossDailyFromRows == null ? null : grossDailyFromRows / 1_000_000 / 7);
  const netDaily = number(raw.netDailyPokt ?? raw.netPoktPerSupplierPerDay ?? raw.displayedYield ?? raw.yield);
  const aprValue = number(raw.apr ?? raw.apy);
  const effectiveClientShare = clientShare == null ? 100 : Math.max(0, Math.min(100, clientShare));
  const computedNetDaily = netDaily ?? (grossDaily == null ? null : grossDaily * effectiveClientShare / 100);
  const computedApr = aprValue ?? (computedNetDaily == null ? null : computedNetDaily * 365 / POKT_PER_SUPPLIER * 100);
  if (computedNetDaily == null || computedApr == null) return null;

  return {
    id: String(raw.id ?? raw.identity ?? `${provider.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${index}`),
    provider,
    plan,
    apr: computedApr,
    clientShare: effectiveClientShare,
    displayedYield: computedNetDaily,
    website: typeof raw.website === "string" ? raw.website : typeof raw.url === "string" ? raw.url : undefined
  };
}

function extractPlans(payload: unknown): PublicPlan[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as { plans?: unknown; providers?: unknown; data?: unknown }).plans
        ?? (payload as { providers?: unknown }).providers
        ?? (payload as { data?: unknown }).data)
      : [];
  if (!Array.isArray(rows)) return [];
  const expanded = rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const candidate = row as RawPlan;
    const groups = Array.isArray(candidate.addressGroups) ? candidate.addressGroups : [];
    if (groups.length === 0) return [candidate];
    return groups
      .filter((group): group is RawPlan => Boolean(group && typeof group === "object"))
      .map((group) => ({ ...candidate, ...group, provider: candidate.provider ?? candidate.name, providerName: candidate.providerName ?? candidate.name }));
  });
  return expanded
    .map((row, index) => normalizePlan(row, index))
    .filter((plan): plan is PublicPlan => plan !== null)
    .filter((plan) => plan.apr > MINIMUM_DISPLAY_APR)
    .sort((a, b) => b.apr - a.apr || a.provider.localeCompare(b.provider));
}

async function loadStakingPlans(): Promise<StakingPlansSnapshot> {
  const now = Date.now();
  if (lastSuccessfulSnapshot && now - new Date(lastSuccessfulSnapshot.fetchedAt).getTime() < REFRESH_INTERVAL_MS) {
    return lastSuccessfulSnapshot;
  }

  const endpoint = process.env.IGNITER_PUBLIC_PLANS_URL;
  if (endpoint) {
    try {
      const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Igniter plans feed returned ${response.status}`);
      const plans = extractPlans(await response.json());
      if (plans.length > 0) {
        lastSuccessfulSnapshot = { plans, fetchedAt: new Date().toISOString(), stale: false, source: "igniter" };
        return lastSuccessfulSnapshot;
      }
    } catch {
      // Keep serving the last-known-good result below. The UI marks it stale.
    }
  }

  if (lastSuccessfulSnapshot) {
    return { ...lastSuccessfulSnapshot, stale: true, source: "last-known-good" };
  }

  return {
    plans: LAST_KNOWN_GOOD.filter((plan) => plan.apr > MINIMUM_DISPLAY_APR).sort((a, b) => b.apr - a.apr),
    fetchedAt: new Date().toISOString(),
    stale: true,
    source: "last-known-good"
  };
}

export const getStakingPlans = unstable_cache(loadStakingPlans, ["staking-plans"], {
  revalidate: 15 * 60,
  tags: ["staking-plans"]
});
