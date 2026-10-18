import { derivePlanEconomics, isSourceFresh, normalizeSourceTimestamp } from "@/lib/staking-economics";
import { getMeta, isDatabaseReadOnly, setMeta } from "@/lib/db";
import { normalizeProviderDomain, resolveStakingProviderIdentity, STAKING_PROVIDER_IDENTITIES } from "@/lib/staking-provider-identity";
export { getProviderFreshnessLabel } from "@/lib/staking-freshness";

export const DEFAULT_POKT_PER_SUPPLIER = 59_500;
export const MINIMUM_DISPLAY_APR = 10;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
export const STAKING_SNAPSHOT_SCHEMA_VERSION = 3;
export const STAKING_SNAPSHOT_META_KEY = "staking_snapshot_v3";
const LEGACY_STAKING_SNAPSHOT_META_KEY = "staking_snapshot_v2";
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
export type ObservedClientShareStatus = "uniform" | "variable" | "unavailable";
export type ObservedClientShareSource = "pocketdex-onchain" | "configured-fallback";

export type ObservedClientShare = {
  status: ObservedClientShareStatus;
  min: number | null;
  max: number | null;
  uniformValue: number | null;
  source: ObservedClientShareSource;
  observedAt: string | null;
  activeConfigCount?: number;
  ownerRevShareMatchCount?: number;
  byService?: Record<string, number[]>;
};

export type ObservedClientShareInput = {
  providerDomain: string;
  providerOverride?: string | null;
  providerName?: string | null;
  serviceId: string;
  supplierOwnerAddress: string | null;
  active: boolean;
  revShare: unknown;
};
export type ObservedClientShares = Record<string, ObservedClientShare>;

export type PublicPlan = {
  id: string;
  provider: string;
  plan: string;
  apr: number;
  aprMin?: number;
  aprMax?: number;
  clientShare: number;
  displayedYield: number;
  displayedYieldMin?: number;
  displayedYieldMax?: number;
  termsVerifiedAt: string;
  website?: string;
  /** Exact reward-domain alias selected after individual candidate probes. */
  rewardDomain?: string;
  rewardStatus: RewardStatus;
  valueSource: PlanValueSource;
  sourceUpdatedAt: string | null;
  fetchedAt: string;
  clientShareObservation: ObservedClientShare;
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
  identityId?: string;
  provider: string;
  plan: string;
  clientShare: number;
  termsVerifiedAt: string;
  website?: string;
  domain: string;
  rewardDomainCandidates?: string[];
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
type RewardEntry = { services: IgniterRewardService[]; error?: string; sourceDomain?: string };
export type RewardDomainProbe = { domain: string; services: IgniterRewardService[]; error?: string };

class StakingRefreshError extends Error {
  constructor(readonly stage: "source" | "rewards" | "minimum-stake" | "derive", cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "StakingRefreshError";
  }
}

// Igniter's public UI does not expose an unauthenticated plan-status endpoint.
// Keep plan terms explicit, but source reward economics and the protocol minimum
// stake from the same public Pocket services used by Igniter.
const PLAN_TERMS: Record<string, { plan: string; clientShare: number; termsVerifiedAt: string; website: string }> = {
  kleomedes: { plan: "Public", clientShare: 49, termsVerifiedAt: "2026-09-22", website: "https://kleomedes.cloud" },
  kalorius: { plan: "public staking", clientShare: 20, termsVerifiedAt: "2026-09-22", website: "https://kalorius.tech/" },
  nodefleet: { plan: "Nodefleet-Public", clientShare: 75, termsVerifiedAt: "2026-09-22", website: "https://nodefleet.org/" },
  purroofgroup: { plan: "sv1-default", clientShare: 78, termsVerifiedAt: "2026-09-22", website: "https://www.purroofgroup.com/" },
  easy2stake: { plan: "igniter-1-eu-a", clientShare: 50, termsVerifiedAt: "2026-09-22", website: "https://www.easy2stake.com/" }
};

const PLAN_METADATA: ProviderPlanMetadata[] = STAKING_PROVIDER_IDENTITIES.map((identity) => {
  const terms = PLAN_TERMS[identity.id];
  if (!terms) throw new Error(`Missing Staking terms for provider identity ${identity.id}`);
  return {
    id: `${identity.id}-public`,
    identityId: identity.id,
    provider: identity.provider,
    plan: terms.plan,
    clientShare: terms.clientShare,
    termsVerifiedAt: terms.termsVerifiedAt,
    domain: identity.domainAliases[0]!,
    rewardDomainCandidates: identity.rewardDomainCandidates,
    website: terms.website
  };
});

function configuredClientShareObservation(clientShare: number, observedAt: string | null): ObservedClientShare {
  return { status: "uniform", min: clientShare, max: clientShare, uniformValue: clientShare, source: "configured-fallback", observedAt, activeConfigCount: 0, ownerRevShareMatchCount: 0 };
}

function unavailableClientShareObservation(observedAt: string | null): ObservedClientShare {
  return { status: "unavailable", min: null, max: null, uniformValue: null, source: "pocketdex-onchain", observedAt, activeConfigCount: 0, ownerRevShareMatchCount: 0 };
}

function parseRevShareEntries(value: unknown): Array<{ address: string; percentage: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const address = typeof record.address === "string" ? record.address : "";
    const raw = record.revSharePercentage ?? record.rev_share_percentage ?? record.revShare ?? record.rev_share;
    const percentage = toNumber(raw);
    return address && percentage != null && percentage >= 0 && percentage <= 100 ? [{ address: address.toLowerCase(), percentage }] : [];
  });
}

/** Aggregates active PocketDex supplier configs by provider domain. */
export function deriveObservedClientShares(inputs: ObservedClientShareInput[], observedAt: string | null): ObservedClientShares {
  const byProvider = new Map<string, Map<string, number[]>>();
  const providerCounts = new Map<string, { activeConfigCount: number; ownerRevShareMatchCount: number }>();
  for (const input of inputs) {
    if (!input.active || !input.providerDomain || !input.supplierOwnerAddress) continue;
    const identity = resolveStakingProviderIdentity({
      providerOverride: input.providerOverride,
      providerName: input.providerName,
      domain: input.providerDomain
    });
    // Unknown domains are retained under their normalized exact domain for
    // diagnostics and fixture compatibility, but never guessed into a known
    // provider identity.
    const providerKey = identity?.id ?? normalizeProviderDomain(input.providerDomain) ?? input.providerDomain;
    const counts = providerCounts.get(providerKey) ?? { activeConfigCount: 0, ownerRevShareMatchCount: 0 };
    counts.activeConfigCount += 1;
    providerCounts.set(providerKey, counts);
    const services = byProvider.get(providerKey) ?? new Map<string, number[]>();
    byProvider.set(providerKey, services);
    const owner = input.supplierOwnerAddress.toLowerCase();
    const ownerShare = parseRevShareEntries(input.revShare).find((entry) => entry.address === owner)?.percentage;
    if (ownerShare == null) continue;
    counts.ownerRevShareMatchCount += 1;
    const values = services.get(input.serviceId) ?? [];
    values.push(ownerShare);
    services.set(input.serviceId, values);
  }

  return Object.fromEntries(Array.from(byProvider.entries()).map(([domain, services]) => {
    const byService = Object.fromEntries(Array.from(services.entries()).map(([serviceId, values]) => [serviceId, values]));
    const allValues = Object.values(byService).flat();
    const min = allValues.length > 0 ? Math.min(...allValues) : null;
    const max = allValues.length > 0 ? Math.max(...allValues) : null;
    const uniform = min != null && max != null && max - min <= 0.05;
    return [domain, {
      status: allValues.length === 0 ? "unavailable" : uniform ? "uniform" : "variable",
      min,
      max,
      uniformValue: uniform ? allValues[0] ?? null : null,
      source: "pocketdex-onchain",
      observedAt,
      activeConfigCount: providerCounts.get(domain)?.activeConfigCount ?? 0,
      ownerRevShareMatchCount: providerCounts.get(domain)?.ownerRevShareMatchCount ?? 0,
      byService
    } satisfies ObservedClientShare];
  }));
}

function observationForPlan(metadata: ProviderPlanMetadata, observedShares: ObservedClientShares | undefined, previous?: ObservedClientShare): ObservedClientShare {
  if (observedShares !== undefined) {
    return observedShares[metadata.identityId ?? metadata.domain] ?? observedShares[metadata.domain] ?? unavailableClientShareObservation(null);
  }
  return previous ?? configuredClientShareObservation(metadata.clientShare, null);
}

function getPlanDomain(planId: string): string | null {
  return PLAN_METADATA.find((metadata) => metadata.id === planId)?.domain ?? null;
}

const LAST_KNOWN_GOOD = [
  { ...PLAN_METADATA[0], apr: 65.3, displayedYield: 107.32 },
  { ...PLAN_METADATA[1], apr: 40.7, displayedYield: 66.95 },
  { ...PLAN_METADATA[2], apr: 28.4, displayedYield: 46.64 },
  { ...PLAN_METADATA[3], apr: 18.8, displayedYield: 30.92 },
  { ...PLAN_METADATA[4], apr: 13.5, displayedYield: 22.19 }
].map(({ domain: _domain, identityId: _identityId, rewardDomainCandidates: _rewardDomainCandidates, ...plan }) => ({
  ...plan,
  clientShareObservation: configuredClientShareObservation(plan.clientShare, "2026-09-22T00:00:00.000Z"),
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

type PersistedStakingSnapshot = {
  schemaVersion: typeof STAKING_SNAPSHOT_SCHEMA_VERSION;
  snapshot: StakingPlansSnapshot;
};

function cloneSnapshot(snapshot: StakingPlansSnapshot): StakingPlansSnapshot {
  return {
    ...snapshot,
    plans: snapshot.plans.map((plan) => ({
      ...plan,
      clientShareObservation: {
        ...plan.clientShareObservation,
        byService: plan.clientShareObservation.byService ? Object.fromEntries(Object.entries(plan.clientShareObservation.byService).map(([service, values]) => [service, [...values]])) : undefined
      }
    }))
  };
}

function rememberSnapshot(snapshot: StakingPlansSnapshot): StakingPlansSnapshot {
  const remembered = cloneSnapshot(snapshot);
  lastServedSnapshot = remembered;
  lastSuccessfulSnapshot = remembered;
  lastProviderPlans = new Map(remembered.plans.filter((plan) => plan.rewardStatus !== "unavailable").map((plan) => [plan.id, { ...plan }]));
  lastMinimumStake = remembered.minimumSupplierStake > 0 ? remembered.minimumSupplierStake : lastMinimumStake;
  return remembered;
}

function staticUnavailableSnapshot(now = new Date()): StakingPlansSnapshot {
  const fetchedAt = now.toISOString();
  return {
    plans: LAST_KNOWN_GOOD.map((plan) => ({ ...plan, fetchedAt })),
    fetchedAt,
    sourceUpdatedAt: null,
    minimumSupplierStake: DEFAULT_POKT_PER_SUPPLIER,
    stale: true,
    source: "last-known-good",
    allocationStatus: "unavailable",
    minimumStakeStatus: "unavailable"
  };
}

function isPublicPlan(value: unknown): value is PublicPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<PublicPlan>;
  return typeof plan.id === "string" && typeof plan.provider === "string" && typeof plan.plan === "string" &&
    typeof plan.apr === "number" && typeof plan.clientShare === "number" && typeof plan.displayedYield === "number" &&
    typeof plan.termsVerifiedAt === "string" && typeof plan.fetchedAt === "string" &&
    (plan.rewardStatus === "live" || plan.rewardStatus === "stale" || plan.rewardStatus === "unavailable") &&
    (plan.valueSource === "live-derived" || plan.valueSource === "stale-derived" || plan.valueSource === "provider-lkg" || plan.valueSource === "static-cold-start");
}

function parseClientShareObservation(value: unknown, fallbackShare: number, fallbackObservedAt: string): ObservedClientShare {
  if (!value || typeof value !== "object") return configuredClientShareObservation(fallbackShare, fallbackObservedAt);
  const observation = value as Partial<ObservedClientShare>;
  const validStatus = observation.status === "uniform" || observation.status === "variable" || observation.status === "unavailable";
  const validSource = observation.source === "pocketdex-onchain" || observation.source === "configured-fallback";
  if (!validStatus || !validSource || (observation.observedAt !== null && typeof observation.observedAt !== "string")) {
    return configuredClientShareObservation(fallbackShare, fallbackObservedAt);
  }
  return {
    status: observation.status as ObservedClientShareStatus,
    min: typeof observation.min === "number" ? observation.min : null,
    max: typeof observation.max === "number" ? observation.max : null,
    uniformValue: typeof observation.uniformValue === "number" ? observation.uniformValue : null,
    source: observation.source as ObservedClientShareSource,
    observedAt: observation.observedAt ?? null,
    activeConfigCount: typeof observation.activeConfigCount === "number" ? observation.activeConfigCount : 0,
    ownerRevShareMatchCount: typeof observation.ownerRevShareMatchCount === "number" ? observation.ownerRevShareMatchCount : 0,
    byService: observation.byService
  };
}

function normalizeSnapshotPlans(snapshot: StakingPlansSnapshot): StakingPlansSnapshot {
  return {
    ...snapshot,
    plans: snapshot.plans.map((plan) => ({
      ...plan,
      clientShareObservation: parseClientShareObservation(plan.clientShareObservation, plan.clientShare, plan.termsVerifiedAt)
    }))
  };
}

function isStakingSnapshotShape(snapshot: Partial<StakingPlansSnapshot>): snapshot is StakingPlansSnapshot {
  return Array.isArray(snapshot.plans) && snapshot.plans.every(isPublicPlan) && typeof snapshot.fetchedAt === "string" &&
    (snapshot.source === "igniter-indexer" || snapshot.source === "last-known-good") &&
    (snapshot.allocationStatus === "live" || snapshot.allocationStatus === "stale" || snapshot.allocationStatus === "unavailable") &&
    (snapshot.minimumStakeStatus === "live" || snapshot.minimumStakeStatus === "stale" || snapshot.minimumStakeStatus === "unavailable") &&
    typeof snapshot.minimumSupplierStake === "number";
}

function parseLegacyStakingSnapshot(raw: string | null): StakingPlansSnapshot | null {
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as { schemaVersion?: number; snapshot?: Partial<StakingPlansSnapshot> };
    if (record.schemaVersion !== 2 || !record.snapshot || !isStakingSnapshotShape(record.snapshot)) return null;
    return cloneSnapshot(normalizeSnapshotPlans(record.snapshot));
  } catch {
    return null;
  }
}

export function parsePersistedStakingSnapshot(raw: string | null): StakingPlansSnapshot | null {
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as Partial<PersistedStakingSnapshot>;
    if (record.schemaVersion !== STAKING_SNAPSHOT_SCHEMA_VERSION || !record.snapshot || typeof record.snapshot !== "object") return null;
    const snapshot = record.snapshot as Partial<StakingPlansSnapshot>;
    if (!isStakingSnapshotShape(snapshot)) return null;
    return cloneSnapshot(normalizeSnapshotPlans(snapshot as StakingPlansSnapshot));
  } catch {
    return null;
  }
}

function readPersistedStakingSnapshot(): StakingPlansSnapshot | null {
  try {
    const current = parsePersistedStakingSnapshot(getMeta(STAKING_SNAPSHOT_META_KEY));
    if (current) return current;
    return parseLegacyStakingSnapshot(getMeta(LEGACY_STAKING_SNAPSHOT_META_KEY));
  } catch {
    return null;
  }
}

function persistStakingSnapshot(snapshot: StakingPlansSnapshot): void {
  if (isDatabaseReadOnly()) return;
  const record: PersistedStakingSnapshot = { schemaVersion: STAKING_SNAPSHOT_SCHEMA_VERSION, snapshot: cloneSnapshot(snapshot) };
  setMeta(STAKING_SNAPSHOT_META_KEY, JSON.stringify(record));
}

/**
 * Materializes the durable v3 representation from a legacy v2 snapshot without
 * contacting any upstream source. This runs synchronously during indexer
 * startup so deployment readiness does not depend on live refresh latency.
 */
export function ensureStakingSnapshotV3(): "existing" | "migrated" | "absent" {
  if (parsePersistedStakingSnapshot(getMeta(STAKING_SNAPSHOT_META_KEY))) return "existing";
  const legacy = parseLegacyStakingSnapshot(getMeta(LEGACY_STAKING_SNAPSHOT_META_KEY));
  if (!legacy) return "absent";
  persistStakingSnapshot(legacy);
  return "migrated";
}

function markSnapshotStale(snapshot: StakingPlansSnapshot, reason: string): StakingPlansSnapshot {
  return {
    ...cloneSnapshot(snapshot),
    stale: true,
    source: "last-known-good",
    allocationStatus: snapshot.allocationStatus === "live" ? "stale" : snapshot.allocationStatus,
    minimumStakeStatus: snapshot.minimumStakeStatus === "live" ? "stale" : snapshot.minimumStakeStatus,
    plans: snapshot.plans.map((plan) => plan.rewardStatus === "unavailable" ? { ...plan } : {
      ...plan,
      rewardStatus: "stale",
      valueSource: plan.valueSource === "static-cold-start" ? "static-cold-start" : "provider-lkg",
      diagnosticReason: reason
    })
  };
}

export function prepareStakingSnapshotForServing(snapshot: StakingPlansSnapshot, now = Date.now()): StakingPlansSnapshot {
  const fetchedAt = new Date(snapshot.fetchedAt).getTime();
  const fresh = !snapshot.stale && Number.isFinite(fetchedAt) && fetchedAt <= now && now - fetchedAt < REFRESH_INTERVAL_MS &&
    isSourceFresh(snapshot.sourceUpdatedAt, now, REFRESH_INTERVAL_MS);
  return fresh ? cloneSnapshot(snapshot) : markSnapshotStale(snapshot, "persisted staking snapshot is outside the 15-minute freshness window");
}

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
  snapshotSchemaVersion: number | null;
  persisted: boolean;
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
    rewardDomain: string | null;
    status: RewardStatus;
    valueSource: PlanValueSource;
    sourceUpdatedAt: string | null;
    fetchedAt: string;
    clientShareStatus: ObservedClientShareStatus;
    clientShareSource: ObservedClientShareSource;
    clientShareObservedAt: string | null;
    activeConfigCount: number;
    ownerRevShareMatchCount: number;
    reason: string | null;
  }>;
} {
  const persisted = readPersistedStakingSnapshot();
  const currentPersisted = parsePersistedStakingSnapshot(getMeta(STAKING_SNAPSHOT_META_KEY));
  const snapshot = lastServedSnapshot ?? (persisted ? prepareStakingSnapshotForServing(persisted) : null);
  return {
    snapshotSchemaVersion: currentPersisted ? STAKING_SNAPSHOT_SCHEMA_VERSION : persisted ? 2 : null,
    persisted: Boolean(persisted),
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
      rewardDomain: plan.rewardDomain ?? getPlanDomain(plan.id),
      status: plan.rewardStatus,
      valueSource: plan.valueSource,
      sourceUpdatedAt: plan.sourceUpdatedAt,
      fetchedAt: plan.fetchedAt,
      clientShareStatus: plan.clientShareObservation.status,
      clientShareSource: plan.clientShareObservation.source,
      clientShareObservedAt: plan.clientShareObservation.observedAt,
      activeConfigCount: plan.clientShareObservation.activeConfigCount ?? 0,
      ownerRevShareMatchCount: plan.clientShareObservation.ownerRevShareMatchCount ?? 0,
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

type DerivedPlanEconomics = {
  clientShare: number;
  economics: ReturnType<typeof derivePlanEconomics>;
  range?: { min: ReturnType<typeof derivePlanEconomics>; max: ReturnType<typeof derivePlanEconomics> };
};

function deriveClientShareEconomics(
  grossSevenDayPerSupplierUpokt: number,
  metadata: ProviderPlanMetadata,
  observation: ObservedClientShare,
  minimumStake: number
): DerivedPlanEconomics | null {
  if (observation.source === "pocketdex-onchain" && observation.status === "uniform" && observation.uniformValue != null) {
    return { clientShare: observation.uniformValue, economics: derivePlanEconomics(grossSevenDayPerSupplierUpokt, observation.uniformValue, minimumStake) };
  }
  if (observation.source === "pocketdex-onchain" && observation.status === "variable" && observation.min != null && observation.max != null) {
    // Reward responses currently lack stable service IDs, so use the observed
    // provider-wide min/max as an explicit envelope rather than averaging shares.
    const min = derivePlanEconomics(grossSevenDayPerSupplierUpokt, observation.min, minimumStake);
    const max = derivePlanEconomics(grossSevenDayPerSupplierUpokt, observation.max, minimumStake);
    // The scalar fields are the conservative lower-bound anchor whenever the
    // persisted plan also carries an observed range.
    return { clientShare: observation.min, economics: min, range: { min, max } };
  }
  const configuredShare = getUniformClientShare(metadata);
  return configuredShare == null ? null : { clientShare: configuredShare, economics: derivePlanEconomics(grossSevenDayPerSupplierUpokt, configuredShare, minimumStake) };
}

/** Select exactly one verified reward-domain result; aliases are never summed. */
export function chooseRewardDomainProbe(probes: RewardDomainProbe[]): RewardEntry {
  const usable = probes.find((probe) => probe.services.some((service) => {
    const gross = toNumber(service.gross_rewards);
    const suppliers = toNumber(service.staked_suppliers);
    return gross != null && gross >= 0 && suppliers != null && suppliers > 0;
  }));
  if (usable) return { services: usable.services, sourceDomain: usable.domain };
  const errors = probes.filter((probe) => probe.error).map((probe) => `${probe.domain}: ${probe.error}`);
  return { services: [], error: errors.join("; ") || "provider reward query returned no usable services" };
}

function aggregateGrossSevenDayPerSupplier(
  services: IgniterRewardService[],
  supplierAllocation: number
): { grossSevenDayPerSupplierUpokt: number; invalidServiceCount: number } | null {
  let grossSevenDayPerSupplierUpokt = 0;
  let usableServiceCount = 0;
  let invalidServiceCount = 0;
  for (const service of services) {
    const gross = toNumber(service.gross_rewards);
    const suppliers = toNumber(service.staked_suppliers);
    if (gross == null || gross < 0 || suppliers == null || suppliers <= 0) {
      invalidServiceCount += 1;
      continue;
    }
    // This mirrors Igniter's address-group workflow: supplier allocation is
    // applied to gross rewards before dividing by the service's live supplier
    // count, then the UI divides the seven-day total by seven.
    grossSevenDayPerSupplierUpokt += Math.floor(gross * supplierAllocation) / suppliers;
    usableServiceCount += 1;
  }
  return usableServiceCount > 0 ? { grossSevenDayPerSupplierUpokt, invalidServiceCount } : null;
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
  metadata = PLAN_METADATA,
  observedShares?: ObservedClientShares
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
    const services = rewardsByDomain.get(planMetadata.identityId ?? planMetadata.domain) ?? rewardsByDomain.get(planMetadata.domain);
    if (!services || services.length === 0) return null;
    const aggregate = aggregateGrossSevenDayPerSupplier(services, supplierAllocation);
    if (!aggregate) return null;
    const { grossSevenDayPerSupplierUpokt, invalidServiceCount } = aggregate;
    const observation = observationForPlan(planMetadata, observedShares);
    const derived = deriveClientShareEconomics(grossSevenDayPerSupplierUpokt, planMetadata, observation, minimumStake);
    if (!derived) return null;
    return {
      ...planMetadata,
      rewardDomain: planMetadata.domain,
      clientShare: derived.clientShare,
      displayedYield: derived.economics.netDailyPokt,
      ...(derived.range ? { displayedYieldMin: derived.range.min.netDailyPokt, displayedYieldMax: derived.range.max.netDailyPokt, aprMin: derived.range.min.apr, aprMax: derived.range.max.apr } : {}),
      apr: derived.economics.apr,
      rewardStatus: isSourceFresh(sourceUpdatedAt, now.getTime(), REFRESH_INTERVAL_MS) ? "live" : "stale",
      valueSource: isSourceFresh(sourceUpdatedAt, now.getTime(), REFRESH_INTERVAL_MS) ? "live-derived" : "stale-derived",
      sourceUpdatedAt,
      fetchedAt: now.toISOString(),
      clientShareObservation: observation,
      ...(invalidServiceCount > 0 ? { diagnosticReason: `ignored ${invalidServiceCount} invalid reward service row${invalidServiceCount === 1 ? "" : "s"}` } : {})
    };
  }).filter((plan): plan is PublicPlan => plan !== null)
    .filter((plan) => plan.apr > MINIMUM_DISPLAY_APR)
    .sort((a, b) => (b.aprMin ?? b.apr) - (a.aprMin ?? a.apr) || a.provider.localeCompare(b.provider));
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
    rewardDomain: metadata.domain,
    apr: 0,
    displayedYield: 0,
    rewardStatus: "unavailable",
    valueSource: "static-cold-start",
    sourceUpdatedAt,
    fetchedAt: now.toISOString(),
    clientShareObservation: configuredClientShareObservation(metadata.clientShare, null),
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
  sourceFresh: boolean,
  observedShares?: ObservedClientShares,
  previousObservation?: ObservedClientShare
): PublicPlan | null {
  const aggregate = aggregateGrossSevenDayPerSupplier(services, supplierAllocation);
  if (!aggregate) return null;
  const { grossSevenDayPerSupplierUpokt, invalidServiceCount } = aggregate;
  const observation = observationForPlan(metadata, observedShares, previousObservation);
  const derived = deriveClientShareEconomics(grossSevenDayPerSupplierUpokt, metadata, observation, minimumStake);
  if (!derived) return null;
  return {
    ...metadata,
    rewardDomain: metadata.domain,
    clientShare: derived.clientShare,
    displayedYield: derived.economics.netDailyPokt,
    ...(derived.range ? { displayedYieldMin: derived.range.min.netDailyPokt, displayedYieldMax: derived.range.max.netDailyPokt, aprMin: derived.range.min.apr, aprMax: derived.range.max.apr } : {}),
    apr: derived.economics.apr,
    rewardStatus: sourceFresh ? "live" : "stale",
    valueSource: sourceFresh ? "live-derived" : "stale-derived",
    sourceUpdatedAt,
    fetchedAt: now.toISOString(),
    clientShareObservation: observation,
    ...(invalidServiceCount > 0 ? { diagnosticReason: `ignored ${invalidServiceCount} invalid reward service row${invalidServiceCount === 1 ? "" : "s"}` } : {})
  };
}

function buildPartialPlans(
  sourceUpdatedAt: string | null,
  allocationValue: string | null,
  minimumStake: number | null,
  allocationStatus: "live" | "stale" | "unavailable",
  minimumStakeStatus: "live" | "stale" | "unavailable",
  rewardEntries: Map<string, RewardEntry>,
  now: Date,
  metadata = PLAN_METADATA,
  observedShares?: ObservedClientShares
): StakingPlansSnapshot {
  const sourceFresh = isSourceFresh(sourceUpdatedAt, now.getTime(), REFRESH_INTERVAL_MS);
  const supplierAllocation = parseSupplierAllocation(allocationValue);
  const plans = metadata.map((planMetadata): PublicPlan => {
    const entry = rewardEntries.get(planMetadata.identityId ?? planMetadata.domain) ?? rewardEntries.get(planMetadata.domain);
    const reason = entry?.error ?? (!entry || entry.services.length === 0 ? "provider reward query returned no usable services" : null);
    const livePlan = supplierAllocation != null && minimumStake != null && Boolean(sourceUpdatedAt) && !reason
      ? deriveProviderPlan(planMetadata, entry?.services ?? [], supplierAllocation, minimumStake, now, sourceUpdatedAt as string, sourceFresh, observedShares, lastProviderPlans.get(planMetadata.id)?.clientShareObservation)
      : null;
    if (livePlan) {
      const sourcedPlan = { ...livePlan, rewardDomain: entry?.sourceDomain ?? planMetadata.domain };
      lastProviderPlans.set(planMetadata.id, sourcedPlan);
      return sourcedPlan;
    }
    const previous = lastProviderPlans.get(planMetadata.id);
    if (previous) {
      return {
        ...previous,
        rewardStatus: "stale" as const,
        valueSource: "provider-lkg" as const,
        diagnosticReason: reason ?? (sourceUpdatedAt ? "upstream source is stale" : "latest source timestamp unavailable")
      };
    }
    const unavailable = unavailablePlan(planMetadata, now, sourceUpdatedAt, reason ?? "global staking input unavailable");
    if (observedShares !== undefined) unavailable.clientShareObservation = observedShares[planMetadata.identityId ?? planMetadata.domain] ?? observedShares[planMetadata.domain] ?? unavailableClientShareObservation(null);
    return unavailable;
  }).filter((plan): plan is PublicPlan => plan != null)
    .sort((a, b) => (b.aprMin ?? b.apr) - (a.aprMin ?? a.apr) || a.provider.localeCompare(b.provider));

  const liveDerivedCount = plans.filter((plan) => plan.valueSource === "live-derived").length;
  const anyDerivedCount = plans.filter((plan) => plan.valueSource !== "static-cold-start").length;
  // A provider-level outage is represented on that provider's row only. The
  // snapshot remains globally fresh when its shared inputs and source anchor
  // are fresh, so healthy live rows are not rewritten as stale on read.
  const stale = allocationStatus !== "live" || minimumStakeStatus !== "live" || !sourceFresh;
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

async function fetchLivePlans(observedShares?: ObservedClientShares): Promise<StakingPlansSnapshot> {
  // Interim source hierarchy: the local SQLite index currently stores settlement
  // facts and supplier/domain dimensions, but it does not materialize the
  // provider address-group service configuration plus the historical
  // per-service staked-supplier counts that Igniter uses for this exact
  // seven-day calculation. Recomputing APR locally would therefore change the
  // semantics. Keep the bounded GraphQL refresh as the background source of
  // record, with the durable snapshot as the fail-closed fallback; #29 tracks
  // authoritative live plan-term ingestion separately.
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
  const rewardResults: Array<readonly [string, RewardEntry]> = [];
  const settledRewards = await Promise.all(PLAN_METADATA.map(async (metadata): Promise<RewardEntry> => {
    const candidates = metadata.rewardDomainCandidates ?? [metadata.domain];
    const probes = await Promise.allSettled(candidates.map((domain) => fetchGraphQL<{ rewards?: IgniterRewardPayload }>(IGNITER_REWARDS_QUERY, {
      domains: [domain], startTs: startTs.toISOString(), endTs: endTs.toISOString()
    })));
    const resolvedProbes: RewardDomainProbe[] = [];
    for (let index = 0; index < probes.length; index += 1) {
      const probe = probes[index];
      const domain = candidates[index];
      if (probe.status === "fulfilled") {
        resolvedProbes.push({ domain, services: probe.value.rewards?.services ?? [] });
      } else {
        resolvedProbes.push({ domain, services: [], error: probe.reason instanceof Error ? probe.reason.message : String(probe.reason) });
      }
    }
    return chooseRewardDomainProbe(resolvedProbes);
  }));
  settledRewards.forEach((entry, index) => {
    const metadata = PLAN_METADATA[index];
    rewardResults.push([metadata.identityId ?? metadata.domain, entry]);
  });
  return buildPartialPlans(sourceUpdatedAt, allocationValue, minimumStake, allocationStatus, minimumStakeStatus, new Map(rewardResults), now, PLAN_METADATA, observedShares);
}

async function loadStakingPlans(fetcher: () => Promise<StakingPlansSnapshot> = fetchLivePlans, now = Date.now()): Promise<StakingPlansSnapshot> {
  if (lastSuccessfulSnapshot && isStakingSnapshotCacheFresh(lastSuccessfulSnapshot, now)) {
    lastServedSnapshot = lastSuccessfulSnapshot;
    return lastSuccessfulSnapshot;
  }
  try {
    return rememberSnapshot(await fetcher());
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

/**
 * Refreshes the durable Staking snapshot. This is intentionally only called by
 * the indexer/background process; the web request path uses getStakingPlans()
 * below and never invokes an upstream fetch.
 */
export async function refreshStakingSnapshot(observedShares?: ObservedClientShares): Promise<StakingPlansSnapshot> {
  const persisted = readPersistedStakingSnapshot();
  if (persisted) rememberSnapshot(persisted);

  try {
    const refreshed = await fetchLivePlans(observedShares);
    const previous = persisted ?? lastSuccessfulSnapshot;
    const durable = refreshed.plans.some((plan) => plan.rewardStatus !== "unavailable")
      ? refreshed
      : previous
        ? markSnapshotStale(previous, "refresh returned no usable provider economics; retaining persisted values")
        : refreshed;
    persistStakingSnapshot(durable);
    rememberSnapshot(durable);
    return durable;
  } catch (error) {
    const fallback = persisted ?? lastSuccessfulSnapshot ?? staticUnavailableSnapshot();
    const stale = markSnapshotStale(fallback, `staking refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    persistStakingSnapshot(stale);
    rememberSnapshot(stale);
    return stale;
  }
}

/** Read-only request-path accessor. It performs a local SQLite metadata read only. */
export function getStakingPlans(): StakingPlansSnapshot {
  const persisted = readPersistedStakingSnapshot();
  const snapshot = persisted ? prepareStakingSnapshotForServing(persisted) : staticUnavailableSnapshot();
  rememberSnapshot(snapshot);
  return snapshot;
}

export const __testing = {
  fetchLivePlans,
  loadStakingPlans,
  parsePersistedStakingSnapshot,
  prepareStakingSnapshotForServing,
  staticUnavailableSnapshot,
  persistStakingSnapshot,
  ensureStakingSnapshotV3,
  refreshStakingSnapshot,
  buildPartialPlans,
  buildLivePlans,
  chooseRewardDomainProbe,
  resolveStakingProviderIdentity,
  resetLastSuccessfulSnapshot: () => {
    lastSuccessfulSnapshot = null;
    lastServedSnapshot = null;
    lastProviderPlans = new Map();
    lastAllocationValue = null;
    lastMinimumStake = null;
  }
};
