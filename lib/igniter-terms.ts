import { getMeta, isDatabaseReadOnly, setMeta } from "@/lib/db";
import { normalizeIdentityToken, resolveStakingProviderIdentity, STAKING_PROVIDER_IDENTITIES } from "@/lib/staking-provider-identity";

/**
 * Authenticated Igniter terms are kept separate from the short reward
 * snapshot. The collector consumes a server-side structured response using a
 * pre-authenticated session cookie provisioned by the operator. The cookie is
 * only sent to the fixed Igniter origin and is never persisted or logged.
 */
export const IGNITER_TERMS_SCHEMA_VERSION = 1 as const;
export const IGNITER_TERMS_META_KEY = "staking_terms_v1";
export const IGNITER_TERMS_ATTEMPT_META_KEY = "staking_terms_last_attempt_at";
export const IGNITER_TERMS_REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000;
const IGNITER_TERMS_ORIGIN = "https://staking.pocket.network";

export type IgniterTermsSource = "igniter-authenticated";

export type IgniterAuthenticatedPlanTerms = {
  providerId: string;
  provider: string;
  plan: string;
  planIdentifier: string | null;
  clientShare: number;
  supplierCount: number | null;
  totalStakedPokt: number | null;
  services: string[];
  termsSource: IgniterTermsSource;
  termsFetchedAt: string;
  termsSourceUpdatedAt: string | null;
  mappingMethod: "plan-id" | "provider-plan-name";
};

export type IgniterTermsSnapshot = {
  schemaVersion: typeof IGNITER_TERMS_SCHEMA_VERSION;
  fetchedAt: string;
  sourceUpdatedAt: string | null;
  stale: boolean;
  plans: IgniterAuthenticatedPlanTerms[];
};

type ExpectedPlan = { providerId: string; provider: string; plan: string };
type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstValue(record: RecordLike, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function percentage(value: unknown): number | null {
  const parsed = number(value);
  if (parsed == null || parsed < 0) return null;
  const normalized = parsed <= 1 ? parsed * 100 : parsed;
  return normalized <= 100 ? normalized : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function expectedPlans(): ExpectedPlan[] {
  return STAKING_PROVIDER_IDENTITIES.map((identity) => ({
    providerId: identity.id,
    provider: identity.provider,
    plan: ({
      kleomedes: "Public",
      kalorius: "public staking",
      nodefleet: "Nodefleet-Public",
      purroofgroup: "sv1-default",
      easy2stake: "igniter-1-eu-a"
    } as Record<string, string>)[identity.id] ?? "Public"
  }));
}

function unwrapProviders(raw: unknown): RecordLike[] {
  const root = asRecord(raw);
  const data = asRecord(root?.data) ?? root;
  const providers = data ? firstValue(data, ["providers", "providerPlans", "plans"]) : undefined;
  if (Array.isArray(providers)) return providers.map(asRecord).filter((value): value is RecordLike => value !== null);
  if (providers && typeof providers === "object") return Object.values(providers as RecordLike).map(asRecord).filter((value): value is RecordLike => value !== null);
  return [];
}

function publicPlans(provider: RecordLike): RecordLike[] {
  const raw = firstValue(provider, ["addressGroups", "publicPlans", "plans"]);
  return asArray(raw).map(asRecord).filter((group): group is RecordLike => {
    if (!group) return false;
    if (group.private === true || group.isPrivate === true || group.visibility === "private") return false;
    return group.private === false || group.public === true || group.isPublic === true || group.visibility === "public";
  });
}

function choosePlan(provider: RecordLike, expected: ExpectedPlan): RecordLike {
  const candidates = publicPlans(provider);
  if (candidates.length === 0) throw new Error(`${expected.providerId}: no explicit public Igniter plan in response`);
  const exact = candidates.filter((candidate) => {
    const name = text(firstValue(candidate, ["name", "planName", "displayName", "label"]));
    return name != null && normalizeIdentityToken(name) === normalizeIdentityToken(expected.plan);
  });
  if (exact.length === 1) return exact[0]!;
  if (candidates.length === 1) return candidates[0]!;
  throw new Error(`${expected.providerId}: public Igniter plan is ambiguous`);
}

function servicesForPlan(plan: RecordLike): string[] {
  const services = firstValue(plan, ["services", "serviceIds"]);
  const direct = asArray(services).flatMap((service) => {
    if (typeof service === "string") return [service];
    const record = asRecord(service);
    const id = record ? text(firstValue(record, ["serviceId", "service_id", "id", "name"])) : null;
    return id ? [id] : [];
  });
  if (direct.length > 0) return [...new Set(direct)].sort();
  return asArray(plan.addressGroupServices).flatMap((service) => {
    const record = asRecord(service);
    if (!record) return [];
    const nested = asRecord(record.service);
    const id = text(firstValue(record, ["serviceId", "service_id"])) ?? (nested ? text(firstValue(nested, ["serviceId", "service_id", "id", "name"])) : null);
    return id ? [id] : [];
  }).filter((id, index, all) => all.indexOf(id) === index).sort();
}

function deriveUniformClientShare(plan: RecordLike): number | null {
  const shares = asArray(plan.addressGroupServices).flatMap((service) => {
    const record = asRecord(service);
    if (!record) return [];
    const providerShare = asArray(record.revShare).reduce<number>((sum, entry) => {
      const rev = asRecord(entry);
      return sum + (percentage(firstValue(rev ?? {}, ["share", "percentage", "revSharePercentage", "rev_share_percentage"])) ?? 0);
    }, 0);
    const supplierShare = record.addSupplierShare === true ? (percentage(firstValue(record, ["supplierShare", "supplier_share"])) ?? 0) : 0;
    const delegatorFee = percentage(firstValue(record, ["delegatorFee", "delegator_fee"])) ?? 0;
    return [Math.max(0, 100 - providerShare - supplierShare - delegatorFee)];
  });
  if (shares.length === 0) return null;
  const min = Math.min(...shares);
  const max = Math.max(...shares);
  return max - min <= 0.05 ? shares[0]! : null;
}

function extractClientShare(plan: RecordLike): number | null {
  const explicit = percentage(firstValue(plan, ["clientShare", "client_share", "clientSharePercentage", "client_share_percentage", "commission", "commissionPercent", "commission_percentage"]));
  return explicit ?? deriveUniformClientShare(plan);
}

function extractSupplierCount(provider: RecordLike, plan: RecordLike): number | null {
  const stats = asRecord(firstValue(provider, ["supplierStats", "supplier_stats", "stats"]));
  return number(firstValue(plan, ["supplierCount", "suppliersCount", "rewardsSuppliersCount", "supplier_count"])) ?? number(firstValue(stats ?? {}, ["suppliers_count", "supplierCount", "suppliers"]));
}

function extractTotalStaked(provider: RecordLike, plan: RecordLike): number | null {
  const stats = asRecord(firstValue(provider, ["supplierStats", "supplier_stats", "stats"]));
  const pokt = firstValue(plan, ["totalStakedPokt", "total_staked_pokt"]);
  if (pokt !== undefined) return number(pokt);
  const raw = number(firstValue(plan, ["totalStaked", "total_staked"])) ?? number(firstValue(stats ?? {}, ["total_staked_tokens", "totalStaked"]));
  return raw == null ? null : raw / 1_000_000;
}

function providerIdentity(provider: RecordLike) {
  const providerOverride = text(firstValue(provider, ["identity", "providerId", "provider_id"]));
  const explicit = providerOverride ? resolveStakingProviderIdentity({ providerOverride }) : null;
  return explicit ?? resolveStakingProviderIdentity({
    providerName: text(firstValue(provider, ["name", "provider", "label"])),
    domain: text(firstValue(provider, ["url", "domain", "website"]))
  });
}

export function normalizeIgniterTermsPayload(raw: unknown, now = new Date(), expected = expectedPlans()): IgniterTermsSnapshot {
  const providers = unwrapProviders(raw);
  const normalized = new Map<string, IgniterAuthenticatedPlanTerms>();
  const root = asRecord(raw);
  const sourceUpdatedAt = timestamp(firstValue(root ?? {}, ["sourceUpdatedAt", "source_updated_at", "updatedAt", "updated_at"]));
  for (const expectedPlan of expected) {
    const provider = providers.find((candidate) => providerIdentity(candidate)?.id === expectedPlan.providerId);
    if (!provider) throw new Error(`${expectedPlan.providerId}: provider missing from authenticated Igniter response`);
    const plan = choosePlan(provider, expectedPlan);
    const clientShare = extractClientShare(plan);
    if (clientShare == null) throw new Error(`${expectedPlan.providerId}: public plan client share is unavailable`);
    const planName = text(firstValue(plan, ["name", "planName", "displayName", "label"])) ?? expectedPlan.plan;
    const planIdentifier = identifier(firstValue(plan, ["id", "planId", "plan_id", "addressGroupId", "address_group_id"]));
    const identity = providerIdentity(provider)!;
    normalized.set(expectedPlan.providerId, {
      providerId: expectedPlan.providerId,
      provider: identity.provider,
      plan: planName,
      planIdentifier,
      clientShare,
      supplierCount: extractSupplierCount(provider, plan),
      totalStakedPokt: extractTotalStaked(provider, plan),
      services: servicesForPlan(plan),
      termsSource: "igniter-authenticated",
      termsFetchedAt: now.toISOString(),
      termsSourceUpdatedAt: sourceUpdatedAt,
      mappingMethod: planIdentifier ? "plan-id" : "provider-plan-name"
    });
  }
  if (normalized.size !== expected.length) throw new Error("authenticated Igniter response is incomplete");
  return { schemaVersion: IGNITER_TERMS_SCHEMA_VERSION, fetchedAt: now.toISOString(), sourceUpdatedAt, stale: false, plans: expected.map(({ providerId }) => normalized.get(providerId)!) };
}

function parseSnapshot(raw: string | null): IgniterTermsSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<IgniterTermsSnapshot>;
    if (parsed.schemaVersion !== IGNITER_TERMS_SCHEMA_VERSION || !Array.isArray(parsed.plans)) return null;
    const expected = new Set(expectedPlans().map((plan) => plan.providerId));
    if (parsed.plans.length !== expected.size || new Set(parsed.plans.map((plan) => plan.providerId)).size !== expected.size || parsed.plans.some((plan) => !expected.has(plan.providerId) || plan.termsSource !== "igniter-authenticated" || !Number.isFinite(plan.clientShare))) return null;
    return { ...parsed, schemaVersion: IGNITER_TERMS_SCHEMA_VERSION, fetchedAt: String(parsed.fetchedAt), sourceUpdatedAt: parsed.sourceUpdatedAt ?? null, stale: parsed.stale === true, plans: parsed.plans } as IgniterTermsSnapshot;
  } catch {
    return null;
  }
}

function persist(snapshot: IgniterTermsSnapshot): void {
  if (!isDatabaseReadOnly()) setMeta(IGNITER_TERMS_META_KEY, JSON.stringify(snapshot));
}

function markStale(snapshot: IgniterTermsSnapshot): IgniterTermsSnapshot {
  return { ...snapshot, stale: true };
}

export function readIgniterTermsSnapshot(): IgniterTermsSnapshot | null {
  const snapshot = parseSnapshot(getMeta(IGNITER_TERMS_META_KEY));
  if (!snapshot) return null;
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < IGNITER_TERMS_REFRESH_INTERVAL_MS && !snapshot.stale ? snapshot : markStale(snapshot);
}

export function isIgniterTermsRefreshDue(now = Date.now(), snapshot = readIgniterTermsSnapshot()): boolean {
  if (snapshot && !snapshot.stale) {
    const fetchedAt = Date.parse(snapshot.fetchedAt);
    if (Number.isFinite(fetchedAt) && now - fetchedAt < IGNITER_TERMS_REFRESH_INTERVAL_MS) return false;
  }
  const lastAttempt = Date.parse(getMeta(IGNITER_TERMS_ATTEMPT_META_KEY) ?? "");
  return !Number.isFinite(lastAttempt) || now - lastAttempt >= IGNITER_TERMS_REFRESH_INTERVAL_MS;
}

export type AuthenticatedTermsRefreshResult = { snapshot: IgniterTermsSnapshot | null; attempted: boolean; skipped: boolean };

export async function refreshIgniterTermsSnapshot(fetcher?: () => Promise<unknown>, now = new Date()): Promise<AuthenticatedTermsRefreshResult> {
  const existing = readIgniterTermsSnapshot();
  if (!isIgniterTermsRefreshDue(now.getTime(), existing)) return { snapshot: existing, attempted: false, skipped: true };
  const sessionCookie = process.env.IGNITER_TERMS_SESSION_COOKIE?.trim();
  if (!fetcher && !sessionCookie) return { snapshot: existing, attempted: false, skipped: true };
  if (!isDatabaseReadOnly()) setMeta(IGNITER_TERMS_ATTEMPT_META_KEY, now.toISOString());
  try {
    const payload = fetcher ? await fetcher() : await fetchIgniterTermsEndpoint(sessionCookie!);
    const fresh = normalizeIgniterTermsPayload(payload, now);
    persist(fresh);
    return { snapshot: fresh, attempted: true, skipped: false };
  } catch (error) {
    const stale = existing ? markStale(existing) : null;
    if (stale) persist(stale);
    const reason = error instanceof Error ? error.message : String(error);
    console.warn("[pocket-dashboard:staking] authenticated Igniter terms refresh failed", { reason: reason.replace(/cookie|token|signature|authorization/gi, "redacted") });
    return { snapshot: stale, attempted: true, skipped: false };
  }
}

async function fetchIgniterTermsEndpoint(sessionCookie: string): Promise<unknown> {
  const configuredPath = process.env.IGNITER_TERMS_ENDPOINT_PATH?.trim() || "/api/terms/public-plans";
  if (!configuredPath.startsWith("/") || configuredPath.startsWith("//")) throw new Error("authenticated Igniter terms endpoint path must be relative");
  const endpoint = new URL(configuredPath, IGNITER_TERMS_ORIGIN);
  const response = await fetch(endpoint, {
    headers: { Accept: "application/json", Cookie: sessionCookie },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`authenticated Igniter terms endpoint returned HTTP ${response.status}`);
  return response.json();
}

export const __testing = {
  expectedPlans,
  parseSnapshot,
  markStale,
  normalizeIgniterTermsPayload,
  isIgniterTermsRefreshDue,
  refreshIgniterTermsSnapshot,
  fetchIgniterTermsEndpoint
};
