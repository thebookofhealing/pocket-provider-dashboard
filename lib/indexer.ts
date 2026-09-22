import crypto from "node:crypto";

import WebSocket from "ws";

import {
  acquireIndexerLock,
  finishJobRun,
  getDashboardCache,
  getIndexedDailyAggregates,
  getIndexedProviderAggregates,
  getIndexedServiceAggregates,
  getIndexedServiceDailyAggregates,
  getIndexedHeightCoverage,
  getIndexerState,
  getGlobalRelayCoverage,
  getGlobalComputeUnitCoverage,
  getLatestIndexedFact,
  getDailyHeightCoverage,
  getEmptyHeightsWithoutMetadata,
  updateHeightTimestamp,
  completeVerifiedEmptyHeight,
  markIndexedHeightFailed,
  pruneIndexerData,
  pruneIndexedHeightCoverage,
  releaseIndexerLock,
  saveIndexedBlock,
  migrateV3ToV4,
  saveIndexedServices,
  saveIndexedSupplierDomains,
  setDashboardCache,
  setIndexerState,
  setMeta,
  startJobRun,
  upsertDailyRollup,
  type IndexedSettlementFact,
  type IndexedService,
  type IndexedSupplierDomain
} from "@/lib/db";
import type { TimeWindow } from "@/lib/types";
import { SESSION_SUPPLIER_SLOTS } from "@/lib/opportunities";
import {
  graphQLRepairFailedHeights,
} from "@/lib/graphql-backfill";
import {
  updateGraphQLWatermark
} from "@/lib/graphql";
import { DEFAULT_RPC_URLS } from "@/lib/rpc-status";

type RpcEvent = {
  type: string;
  attributes: Array<{ key: string; value: string; index?: boolean }>;
};

type RpcStatusResponse = {
  result?: {
    sync_info?: {
      latest_block_height?: string;
    };
  };
};

type RpcBlockResultsResponse = {
  result?: {
    finalize_block_events?: RpcEvent[];
    final_block_events?: RpcEvent[];
    txs_results?: Array<{ events?: RpcEvent[] }>;
  };
};

type RpcBlockResponse = {
  result?: {
    block?: {
      header?: {
        time?: string;
      };
    };
  };
};

type RestServicesResponse = {
  service?: Array<{
    id: string;
    name: string;
    compute_units_per_relay?: string | number | null;
    computeUnitsPerRelay?: string | number | null;
  }>;
  pagination?: { next_key?: string | null };
};

type RestSuppliersResponse = {
  supplier?: Array<{
    operator_address: string;
    services?: Array<{
      endpoints?: Array<{ url?: string | null }>;
    }>;
  }>;
  pagination?: { next_key?: string | null };
};

type RewardDistributionDetail = {
  op_reason: string;
  amount: string;
};

type SerializedDashboardCache = {
  window: TimeWindow;
  generatedAt: string;
  dataSource: "rpc";
  poktPriceUsd: number;
  latestHeight: number;
  indexerProcessedHeight?: number;
  indexerTargetHeight?: number;
  scannedHeights: number;
  scannedSettlementHeights: number;
  settlementEvents: number;
  earliestSettlementTime: string | null;
  latestSettlementTime: string | null;
  totalRelays: number;
  totalEstimatedRelays: number;
  totalEstimatedComputeUnits: number;
  relayCoverage: number;
  computeUnitCoverage?: number;
  totalRevenueUpokt: string;
  activeProviders: number;
  activeChains: number;
  suppliersPerSession: number;
  appsStakedByService: Record<string, number>;
  sessionObservedHeight: number;
  sessionFetchedAt: string;
  sessionStale: boolean;
  providers: Array<{
    providerKey: string;
    providerLabel: string;
    providerDomain: string;
    relays: number;
    revenueUpokt: string;
    chainCount: number;
    supplierCount: number;
    suppliers: [];
    chains: [];
  }>;
  services: Array<{
    serviceId: string;
    serviceName: string;
    relays: number;
    estimatedRelays?: number;
    computeUnits?: number;
    computeUnitsPerRelay?: number;
    supplierCount?: number;
    appsStaked?: number;
    revenueUpokt: string;
    providerCount: number;
  }>;
};

type IndexerOptions = {
  live?: boolean;
  once?: boolean;
  fromHeight?: number;
  toHeight?: number;
  maxBlocks?: number;
  backfillDays?: number;
};

const RPC_URLS = Array.from(
  new Set(
    (process.env.POCKET_RPC_URLS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .concat(process.env.POCKET_RPC_URL ? [process.env.POCKET_RPC_URL] : [])
      .concat(DEFAULT_RPC_URLS)
  )
);
const BACKFILL_RPC_URLS = Array.from(
  new Set(
    (process.env.POCKET_BACKFILL_RPC_URLS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .concat(RPC_URLS)
  )
);
const REST_URL = process.env.POCKET_REST_URL ?? "https://sauron-api.infra.pocket.network";
const HASH_SALT = process.env.POCKET_INDEXER_HASH_SALT ?? "pocket-dashboard-public-main";
const RETENTION_DAYS = Number(process.env.POCKET_INDEXER_RETENTION_DAYS ?? 45);
const CACHE_INTERVAL_MS = Number(process.env.POCKET_INDEXER_CACHE_INTERVAL_MS ?? 30_000);
const RPC_TIMEOUT_MS = Number(process.env.POCKET_INDEXER_RPC_TIMEOUT_MS ?? 8_000);
const RPC_RETRIES = Number(process.env.POCKET_INDEXER_RPC_RETRIES ?? 3);
const RPC_RETRY_DELAY_MS = Number(process.env.POCKET_INDEXER_RPC_RETRY_DELAY_MS ?? 500);
const WS_IDLE_TIMEOUT_MS = Number(process.env.POCKET_INDEXER_WS_IDLE_TIMEOUT_MS ?? 45_000);
const BACKFILL_CONCURRENCY = Number(process.env.POCKET_INDEXER_BACKFILL_CONCURRENCY ?? 8);
const BACKFILL_BATCH_SIZE = Number(process.env.POCKET_INDEXER_BACKFILL_BATCH_SIZE ?? 500);
const LIVE_CATCHUP_MAX_BLOCKS = Number(process.env.POCKET_INDEXER_LIVE_CATCHUP_MAX_BLOCKS ?? 1_000);
const BLOCK_RETRIES = Number(process.env.POCKET_INDEXER_BLOCK_RETRIES ?? 5);
const PRICE_TIMEOUT_MS = Number(process.env.POCKET_INDEXER_PRICE_TIMEOUT_MS ?? 20_000);
const PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=pocket-network&vs_currencies=usd";
const REPAIR_INTERVAL_MS = Number(process.env.POCKET_INDEXER_REPAIR_INTERVAL_MS ?? 60_000);
const REPAIR_BATCH_SIZE = Number(process.env.POCKET_INDEXER_REPAIR_BATCH_SIZE ?? 250);
const REPAIR_CONCURRENCY = Number(process.env.POCKET_INDEXER_REPAIR_CONCURRENCY ?? 4);
const REPAIR_FAILED_COOLDOWN_MS = Number(process.env.POCKET_INDEXER_REPAIR_FAILED_COOLDOWN_MS ?? 300_000);
const REPAIR_MAX_FAILED_RETRIES = Number(process.env.POCKET_INDEXER_REPAIR_MAX_FAILED_RETRIES ?? 10);
const MIGRATION_MAX_RETRIES = 3;
const MIGRATION_RETRY_DELAY_MS = 5000;
const WINDOWS: TimeWindow[] = ["24h", "7d", "30d"];
const SETTLEMENT_EVENT_TYPE = "pocket.tokenomics.EventClaimSettled";
const SECOND_LEVEL_SUFFIXES = new Set(["co.uk", "org.uk", "com.au", "net.au", "co.jp", "com.br"]);
const SUPPLIER_REWARD_REASONS = new Set([
  "TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION",
  "TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION"
]);

let lastCacheBuildAt = 0;
let cacheDirty = true;
let liveCatchupInFlight = false;
let lastSessionSyncAt = 0;
const SESSION_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const SESSION_FRESHNESS_MS = 60 * 60 * 1000;
const INDEXER_DATA_VERSION = 4;
const rpcStats = new Map<string, { successes: number; failures: number; timeouts: number; totalLatencyMs: number }>();

function logInfo(message: string, context?: Record<string, unknown>): void {
  console.info(`[pocket-dashboard:indexer] ${message}`, context ?? "");
}

function logWarn(message: string, context?: Record<string, unknown>): void {
  console.warn(`[pocket-dashboard:indexer] ${message}`, context ?? "");
}

function logError(message: string, error: unknown, context?: Record<string, unknown>): void {
  console.error(`[pocket-dashboard:indexer] ${message}`, {
    ...context,
    error: error instanceof Error ? error.stack ?? error.message : String(error)
        });
      }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const parts: string[] = [`${error.name}: ${error.message}`];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cause: unknown = (error as any).cause;
    while (cause instanceof Error) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const code = (cause as any).code as string | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syscall = (cause as any).syscall as string | undefined;
      const detail = code || syscall ? `[${[code, syscall].filter(Boolean).join("/")}]` : "";
      parts.push(`← ${cause.name}${detail ? ` ${detail}` : ""}: ${cause.message}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cause = (cause as any).cause;
    }
    return parts.join("\n");
  }
  return String(error);
}

function isTimeoutError(error: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError" || name === "TypeError") return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cause: unknown = (error instanceof Error) ? (error as any).cause : undefined;
  while (cause instanceof Error) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((cause as any).code === "ETIMEDOUT" || (cause as any).code === "ECONNRESET" || (cause as any).code === "ECONNREFUSED") return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cause = (cause as any).cause;
  }
  return false;
}

function recordRpcResult(rpcUrl: string, ok: boolean, latencyMs: number, error?: unknown): void {
  const stats = rpcStats.get(rpcUrl) ?? { successes: 0, failures: 0, timeouts: 0, totalLatencyMs: 0 };
  if (ok) {
    stats.successes += 1;
    stats.totalLatencyMs += latencyMs;
  } else {
    stats.failures += 1;
    if (isTimeoutError(error)) stats.timeouts += 1;
  }
  rpcStats.set(rpcUrl, stats);
}

function rpcHealthSnapshot(): Array<{ rpcUrl: string; successes: number; failures: number; timeouts: number; avgLatencyMs: number }> {
  return Array.from(rpcStats.entries()).map(([rpcUrl, stats]) => ({
    rpcUrl,
    successes: stats.successes,
    failures: stats.failures,
    timeouts: stats.timeouts,
    avgLatencyMs: stats.successes === 0 ? 0 : Math.round(stats.totalLatencyMs / stats.successes)
  }));
}

function rpcPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function wsUrlFromRpc(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = "/websocket";
  url.search = "";
  return url.toString();
}

async function fetchJson<T>(url: string, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      accept: "application/json",
      "user-agent": "pocket-dashboard/1.0"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return (await response.json()) as T;
}

async function fetchFromRpcPool<T>(path: string, seed = 0, rpcUrls = RPC_URLS): Promise<T> {
  const candidates = [...rpcUrls.slice(seed % rpcUrls.length), ...rpcUrls.slice(0, seed % rpcUrls.length)];
  let lastError: unknown;

  for (let attempt = 1; attempt <= RPC_RETRIES; attempt += 1) {
    for (const rpcUrl of candidates) {
      const startedAt = Date.now();
      try {
        const result = await fetchJson<T>(rpcPath(rpcUrl, path));
        recordRpcResult(rpcUrl, true, Date.now() - startedAt);
        return result;
      } catch (error) {
        lastError = error;
        recordRpcResult(rpcUrl, false, Date.now() - startedAt, error);
        logWarn("RPC request failed", {
          rpcUrl,
          path,
          attempt,
          maxAttempts: RPC_RETRIES,
          error: formatError(error)
        });
      }
    }

    if (attempt < RPC_RETRIES) {
      await sleep(RPC_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`All RPC requests failed for ${path}`);
}

async function getLatestHeight(): Promise<number> {
  const status = await fetchFromRpcPool<RpcStatusResponse>("/status");
  const height = Number(status.result?.sync_info?.latest_block_height ?? 0);
  if (!height) throw new Error("Unable to read latest block height");
  return height;
}

function normalizeAttributeValue(value: string | undefined): string {
  if (!value) return "";
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value) as string;
  }
  return value;
}

function parseInteger(value: string | undefined): number {
  return Number(normalizeAttributeValue(value));
}

function parseMaybeInteger(value: string | undefined): number | undefined {
  const normalized = normalizeAttributeValue(value);
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseUpokt(value: string): bigint {
  const normalized = normalizeAttributeValue(value);
  const match = normalized.match(/^(-?\d+)upokt$/);
  if (!match) throw new Error(`Unexpected coin value: ${value}`);
  return BigInt(match[1]);
}

function hashIdentity(value: string): string {
  return crypto.createHash("sha256").update(`${HASH_SALT}:${value}`).digest("hex").slice(0, 32);
}

export { hashIdentity };

function getHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isIpv4(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
}

function getRegistrableDomain(hostname: string): string {
  if (hostname === "localhost" || isIpv4(hostname)) return hostname;

  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2) return hostname;

  const suffix = labels.slice(-2).join(".");
  if (SECOND_LEVEL_SUFFIXES.has(suffix) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }

  return labels.slice(-2).join(".");
}

function getPrimaryEndpointDomain(endpointUrls: string[]): string | null {
  const domainFrequency = new Map<string, number>();
  for (const endpointUrl of endpointUrls) {
    const hostname = getHostname(endpointUrl);
    if (!hostname) continue;
    const domain = getRegistrableDomain(hostname);
    domainFrequency.set(domain, (domainFrequency.get(domain) ?? 0) + 1);
  }

  return Array.from(domainFrequency.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

function getTimeParts(blockTime: number): { day: string; hour: string } {
  const iso = new Date(blockTime).toISOString();
  return { day: iso.slice(0, 10), hour: iso.slice(0, 13) };
}

function extractEvents(response: RpcBlockResultsResponse): RpcEvent[] {
  return [
    ...(response.result?.finalize_block_events ?? []),
    ...(response.result?.final_block_events ?? []),
    ...(response.result?.txs_results ?? []).flatMap((result) => result.events ?? [])
  ];
}

function parseSettlementFact(event: RpcEvent, height: number, eventIndex: number, blockTime: number): IndexedSettlementFact | null {
  if (event.type !== SETTLEMENT_EVENT_TYPE) return null;

  const attributes = Object.fromEntries(event.attributes.map((attribute) => [attribute.key, attribute.value]));
  const serviceId = normalizeAttributeValue(attributes.service_id);
  const supplierOperatorAddress = normalizeAttributeValue(attributes.supplier_operator_address);
  const supplierOwnerAddress = normalizeAttributeValue(attributes.supplier_owner_address);
  const rewardDistribution = normalizeAttributeValue(attributes.reward_distribution_detailed);
  if (!serviceId || !supplierOperatorAddress || !rewardDistribution) return null;

  const rewardDetails = JSON.parse(rewardDistribution) as RewardDistributionDetail[];
  const supplierRevenueUpokt = rewardDetails.reduce((sum, detail) => {
    if (!SUPPLIER_REWARD_REASONS.has(detail.op_reason)) return sum;
    return sum + parseUpokt(detail.amount);
  }, 0n);
  const { day, hour } = getTimeParts(blockTime);

  return {
    height,
    eventIndex,
    blockTime,
    day,
    hour,
    serviceId,
    supplierHash: hashIdentity(supplierOperatorAddress),
    ownerHash: supplierOwnerAddress ? hashIdentity(supplierOwnerAddress) : null,
    relays: parseInteger(attributes.num_relays),
    estimatedRelays: parseMaybeInteger(attributes.num_estimated_relays),
    claimedComputeUnits: parseMaybeInteger(attributes.num_claimed_compute_units),
    estimatedComputeUnits: parseMaybeInteger(attributes.num_estimated_compute_units),
    revenueUpokt: supplierRevenueUpokt.toString()
  };
}

async function fetchBlockFacts(height: number, rpcUrls = RPC_URLS): Promise<IndexedSettlementFact[]> {
  const response = await fetchFromRpcPool<RpcBlockResultsResponse>(`/block_results?height=${height}`, height, rpcUrls);
  const settlementEvents = extractEvents(response).filter((event) => event.type === SETTLEMENT_EVENT_TYPE);
  if (settlementEvents.length === 0) {
    return [];
  }

  const block = await fetchFromRpcPool<RpcBlockResponse>(`/block?height=${height}`, height, rpcUrls);
  const blockTime = Date.parse(block.result?.block?.header?.time ?? "");
  if (!Number.isFinite(blockTime)) {
    throw new Error(`Unable to read block time for height ${height}`);
  }
  const facts: IndexedSettlementFact[] = [];
  let eventIndex = 0;

  for (const event of settlementEvents) {
    const fact = parseSettlementFact(event, height, eventIndex, blockTime);
    eventIndex += 1;
    if (fact) facts.push(fact);
  }

  return facts;
}

async function fetchBlockTimeMs(height: number, rpcUrls = RPC_URLS): Promise<number | null> {
  try {
    const block = await fetchFromRpcPool<RpcBlockResponse>(`/block?height=${height}`, height, rpcUrls);
    const ts = Date.parse(block.result?.block?.header?.time ?? "");
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

function parseMaybeNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function syncServices(): Promise<void> {
  const services: IndexedService[] = [];
  let nextKey = "";

  try {
    while (true) {
      const search = new URLSearchParams({ dehydrated: "true", "pagination.limit": "250" });
      if (nextKey) search.set("pagination.key", nextKey);
      const response = await fetchJson<RestServicesResponse>(`${REST_URL.replace(/\/$/, "")}/pokt-network/poktroll/service/service?${search.toString()}`);
      for (const service of response.service ?? []) {
        services.push({
          serviceId: service.id,
          serviceName: service.name || service.id,
          computeUnitsPerRelay: parseMaybeNumber(service.computeUnitsPerRelay ?? service.compute_units_per_relay)
        });
      }
      nextKey = response.pagination?.next_key ?? "";
      if (!nextKey) break;
    }

    saveIndexedServices(services);
    logInfo("Service dimension synced", { serviceCount: services.length });
  } catch (error) {
    logWarn("Service dimension sync failed; existing labels will be reused", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function syncSupplierDomains(): Promise<void> {
  const domains: IndexedSupplierDomain[] = [];
  const unknownDomainHash = hashIdentity("domain:unknown");
  let nextKey = "";

  try {
    while (true) {
      const search = new URLSearchParams({ dehydrated: "false", "pagination.limit": "250" });
      if (nextKey) search.set("pagination.key", nextKey);
      const response = await fetchJson<RestSuppliersResponse>(`${REST_URL.replace(/\/$/, "")}/pokt-network/poktroll/supplier/supplier?${search.toString()}`);

      for (const supplier of response.supplier ?? []) {
        if (!supplier.operator_address) continue;
        const endpointUrls = (supplier.services ?? []).flatMap((service) =>
          (service.endpoints ?? []).flatMap((endpoint) => (endpoint.url ? [endpoint.url] : []))
        );
        const domain = getPrimaryEndpointDomain(endpointUrls);
        domains.push({
          supplierHash: hashIdentity(supplier.operator_address),
          domainHash: domain ? hashIdentity(`domain:${domain}`) : unknownDomainHash,
          hasEndpoint: Boolean(domain)
        });
      }

      nextKey = response.pagination?.next_key ?? "";
      if (!nextKey) break;
    }

    saveIndexedSupplierDomains(domains);
    logInfo("Supplier domain dimension synced", {
      supplierCount: domains.length,
      domainCount: new Set(domains.map((entry) => entry.domainHash)).size,
      unknownSupplierCount: domains.filter((entry) => !entry.hasEndpoint).length
    });
  } catch (error) {
    logWarn("Supplier domain sync failed; existing domain dimension will be reused", { error: error instanceof Error ? error.message : String(error) });
  }
}

let sessionSyncedAppsStaked: Record<string, number> | null = null;
let sessionSyncedSlots: number | null = null;
let sessionSyncedHeight: number | null = null;
let sessionSuppliersFetchedAt: string | null = null;
let sessionAppsFetchedAt: string | null = null;

function getSessionAppsStaked(): Record<string, number> | null {
  return sessionSyncedAppsStaked;
}

function getSessionSlots(): number | null {
  return sessionSyncedSlots;
}

export function getLiveSessionSuppliersPerSession(): number {
  return sessionSyncedSlots ?? SESSION_SUPPLIER_SLOTS;
}

export function getLiveAppsStakedByService(): Record<string, number> {
  return sessionSyncedAppsStaked ?? {};
}

type RestApplicationsResponse = {
  applications?: Array<{
    service_configs?: Array<{ service_id?: string }>;
    unstake_session_end_height?: string | number;
    pending_transfer?: { session_end_height?: string | number };
  }>;
  pagination?: { next_key?: string; total?: string };
};

type RestSessionParamsResponse = {
  params?: { num_suppliers_per_session?: string | number };
};

async function syncSessionParameters(snapshotHeight: number): Promise<{ ok: boolean; slots?: number }> {
  try {
    const response = await fetchJson<RestSessionParamsResponse>(
      `${REST_URL.replace(/\/$/, "")}/pokt-network/poktroll/session/params`
    );
    const slots = parseMaybeNumber(response.params?.num_suppliers_per_session);
    if (slots != null && slots > 0) {
      return { ok: true, slots };
    }
    return { ok: false };
  } catch (error) {
    logWarn("Session params sync failed; reusing last-known value", { error: error instanceof Error ? error.message : String(error) });
    return { ok: false };
  }
}

async function syncApplications(snapshotHeight: number): Promise<{ ok: boolean; apps?: Record<string, number> }> {
  const appCounts: Record<string, number> = {};
  let nextKey = "";

  try {
    while (true) {
      const search = new URLSearchParams({ "pagination.limit": "250" });
      if (nextKey) search.set("pagination.key", nextKey);
      const response = await fetchJson<RestApplicationsResponse>(
        `${REST_URL.replace(/\/$/, "")}/pokt-network/poktroll/application/application?${search.toString()}`
      );
      for (const app of response.applications ?? []) {
        const serviceId = app.service_configs?.[0]?.service_id;
        if (!serviceId) continue;
        const unstakeEnd = parseMaybeNumber(app.unstake_session_end_height);
        if (unstakeEnd != null && unstakeEnd > 0 && snapshotHeight > unstakeEnd) continue;
        const transferEnd = parseMaybeNumber(app.pending_transfer?.session_end_height);
        if (transferEnd != null && transferEnd > 0 && snapshotHeight > transferEnd) continue;
        appCounts[serviceId] = (appCounts[serviceId] ?? 0) + 1;
      }
      nextKey = response.pagination?.next_key ?? "";
      if (!nextKey) break;
    }

    return { ok: true, apps: appCounts };
  } catch (error) {
    logWarn("Applications sync failed; reusing last-known values", { error: error instanceof Error ? error.message : String(error) });
    return { ok: false };
  }
}

async function syncSessionData(): Promise<boolean> {
  let snapshotHeight: number;
  try {
    snapshotHeight = await getLatestHeight();
  } catch (error) {
    logWarn("Session sync aborted; unable to determine current node height", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }

  const [paramsResult, appsResult] = await Promise.all([
    syncSessionParameters(snapshotHeight),
    syncApplications(snapshotHeight)
  ]);

  if (!paramsResult.ok || !appsResult.ok || paramsResult.slots == null || appsResult.apps == null) {
    logWarn("Session sync incomplete; keeping last-known snapshot", { paramsOk: paramsResult.ok, appsOk: appsResult.ok });
    return false;
  }

  const fetchedAt = new Date().toISOString();
  sessionSyncedSlots = paramsResult.slots;
  sessionSyncedAppsStaked = appsResult.apps;
  sessionSyncedHeight = snapshotHeight;
  sessionSuppliersFetchedAt = fetchedAt;
  sessionAppsFetchedAt = fetchedAt;
  setIndexerState("session_snapshot", JSON.stringify({
    suppliersPerSession: paramsResult.slots,
    appsStaked: appsResult.apps,
    observedHeight: snapshotHeight,
    fetchedAt
  }));
  logInfo("Session snapshot published", { suppliersPerSession: paramsResult.slots, totalApps: Object.values(appsResult.apps).reduce((sum, count) => sum + count, 0), serviceCount: Object.keys(appsResult.apps).length, observedHeight: snapshotHeight });
  return true;
}

function warmupSessionState(): void {
  try {
    const snapshotRaw = getIndexerState("session_snapshot");
    if (snapshotRaw) {
      const parsed = JSON.parse(snapshotRaw) as { suppliersPerSession?: number; appsStaked?: Record<string, number>; observedHeight?: number; fetchedAt?: string };
      if (Number.isFinite(parsed.suppliersPerSession) && parsed.suppliersPerSession != null && parsed.suppliersPerSession > 0) {
        sessionSyncedSlots = parsed.suppliersPerSession;
      }
      if (parsed.appsStaked && typeof parsed.appsStaked === "object") {
        sessionSyncedAppsStaked = parsed.appsStaked;
      }
      if (parsed.observedHeight != null) sessionSyncedHeight = parsed.observedHeight;
      if (parsed.fetchedAt) {
        sessionSuppliersFetchedAt = parsed.fetchedAt;
        sessionAppsFetchedAt = parsed.fetchedAt;
      }
    }
  } catch { /* keep null */ }

  if (sessionSyncedSlots == null) {
    try {
      const slotsRaw = getIndexerState("session_suppliers_per_session");
      if (slotsRaw) {
        const parsed = JSON.parse(slotsRaw) as { value: number; sourceHeight?: number; fetchedAt?: string };
        if (Number.isFinite(parsed.value) && parsed.value > 0) {
          sessionSyncedSlots = parsed.value;
          if (parsed.sourceHeight) sessionSyncedHeight = parsed.sourceHeight;
          if (parsed.fetchedAt) sessionSuppliersFetchedAt = parsed.fetchedAt;
        }
      }
    } catch { /* keep null */ }
  }

  if (sessionSyncedAppsStaked == null) {
    try {
      const appsRaw = getIndexerState("session_apps_staked");
      if (appsRaw) {
        const parsed = JSON.parse(appsRaw) as { value: Record<string, number>; sourceHeight?: number; fetchedAt?: string };
        if (parsed.value && typeof parsed.value === "object") {
          sessionSyncedAppsStaked = parsed.value;
          if (parsed.sourceHeight) sessionSyncedHeight = parsed.sourceHeight;
          if (parsed.fetchedAt) sessionAppsFetchedAt = parsed.fetchedAt;
        }
      }
    } catch { /* keep null */ }
  }
}

function windowMs(window: TimeWindow): number {
  switch (window) {
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
    case "365d":
      return 365 * 24 * 60 * 60 * 1000;
  }
}

function getStartOfTodayUtc(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function getCachedPrice(): number {
  const cached = getIndexerState("pokt_price_usd");
  if (!cached) return 0;
  try {
    const parsed = JSON.parse(cached) as { value: number; updatedAt: string };
    return Number.isFinite(parsed.value) ? parsed.value : 0;
  } catch {
    return 0;
  }
}

async function refreshPrice(): Promise<number> {
  const cached = getIndexerState("pokt_price_usd");
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { value: number; updatedAt: string };
      if (Date.now() - new Date(parsed.updatedAt).getTime() < 60 * 60 * 1000) return parsed.value;
    } catch {
      // Fall through to refresh.
    }
  }

  try {
    const data = await fetchJson<{ "pocket-network"?: { usd?: number } }>(PRICE_URL, PRICE_TIMEOUT_MS);
    const value = data["pocket-network"]?.usd;
    if (typeof value === "number" && Number.isFinite(value)) {
      setIndexerState("pokt_price_usd", JSON.stringify({ value, updatedAt: new Date().toISOString() }));
      return value;
    }
  } catch (error) {
    logWarn("Price refresh failed; using cached value", { error: error instanceof Error ? error.message : String(error) });
  }

  return getCachedPrice();
}

function buildCalendarDailyHistory(
  rows: Array<{ day: string; relays: number; estimated_relays?: number; estimated_compute_units?: number; relay_coverage?: number; revenue_upokt: string }>,
  migrationComplete: boolean
): Array<{ day: string; relays: number; estimatedRelays?: number; estimatedComputeUnits?: number; isEstimated?: boolean; relayCoverage?: number; revenueUpokt: string; workloadCompleteness: "complete" | "partial" | "missing"; rewardCompleteness: "complete" | "partial" | "missing" }> {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
  const rowByDay = new Map(rows.map((r) => [r.day, r]));

  const result: ReturnType<typeof buildCalendarDailyHistory> = [];
  for (let d = 0; d < 30; d += 1) {
    const day = new Date(today - (30 - d) * 86400000).toISOString().slice(0, 10);
    const row = rowByDay.get(day);
    const dayStartMs = today - (30 - d) * 86400000;
    const cov = getDailyHeightCoverage(dayStartMs, dayStartMs + 86400000);
    const statusFor = (covered: number): "complete" | "partial" | "missing" => {
      if (!cov || cov.expectedHeights === 0) return "missing";
      if (covered === cov.expectedHeights) return "complete";
      return covered > 0 ? "partial" : "missing";
    };
    if (!row) {
      const wc = statusFor(cov?.workloadCovered ?? 0);
      const rc = statusFor(cov?.rewardCovered ?? 0);
      result.push({ day, relays: 0, estimatedRelays: undefined, estimatedComputeUnits: undefined, isEstimated: undefined, relayCoverage: undefined, revenueUpokt: "0", workloadCompleteness: wc, rewardCompleteness: rc });
      continue;
    }

    const wc = statusFor(cov?.workloadCovered ?? 0);
    const rc = statusFor(cov?.rewardCovered ?? 0);

    const serialized = serializeDailyCache([row], migrationComplete)[0];
    result.push({ ...serialized, workloadCompleteness: wc, rewardCompleteness: rc });
  }

  return result;
}

function serializeDailyCache(rows: Array<{ day: string; relays: number; estimated_relays?: number; estimated_compute_units?: number; relay_coverage?: number; revenue_upokt: string }>, migrationComplete: boolean): Array<{ day: string; relays: number; estimatedRelays?: number; estimatedComputeUnits?: number; isEstimated?: boolean; relayCoverage?: number; revenueUpokt: string }> {
  return rows.map((row) => ({
    day: row.day,
    relays: row.relays,
    estimatedRelays: migrationComplete ? (row.estimated_relays ?? undefined) : undefined,
    estimatedComputeUnits: migrationComplete ? (row.estimated_compute_units ?? undefined) : undefined,
    isEstimated: migrationComplete && (row.estimated_relays ?? 0) > 0 && (row.estimated_relays ?? 0) !== row.relays ? true : undefined,
    relayCoverage: migrationComplete ? (row.relay_coverage ?? undefined) : undefined,
    revenueUpokt: row.revenue_upokt
  }));
}

function setProviderDataCache<T>(key: string, data: T): void {
  setMeta(key, JSON.stringify({ updatedAt: new Date().toISOString(), data }));
}

function cacheChanged(key: string, payloadJson: string): boolean {
  const existing = getDashboardCache(key);
  if (!existing) return true;
  return crypto.createHash("sha256").update(existing.payloadJson).digest("hex") !== crypto.createHash("sha256").update(payloadJson).digest("hex");
}

export async function rebuildIndexerCaches(): Promise<void> {
  const startedAt = Date.now();
  const jobId = startJobRun("indexer_cache_rebuild");

  try {
    const latestHeight = Number(getIndexerState("contiguous_processed_height") ?? 0);
    const latestSeenHeight = Number(getIndexerState("highest_seen_height") ?? latestHeight);
    const latestFact = getLatestIndexedFact();
    const poktPriceUsd = await refreshPrice();
    const liveSuppliersPerSession = sessionSyncedSlots ?? SESSION_SUPPLIER_SLOTS;
    const liveAppsStaked = sessionSyncedAppsStaked ?? {};
    const oldestFetchedAt = [sessionSuppliersFetchedAt, sessionAppsFetchedAt]
      .filter((value): value is string => value != null)
      .sort()[0] ?? "";
    const oldestFetchedAtMs = oldestFetchedAt ? new Date(oldestFetchedAt).getTime() : NaN;
    const sessionStale = sessionSyncedSlots == null
      || sessionSyncedAppsStaked == null
      || !Number.isFinite(oldestFetchedAtMs)
      || Date.now() - oldestFetchedAtMs > SESSION_FRESHNESS_MS;
    const migrationComplete = Number(getIndexerState("data_version") ?? "0") >= INDEXER_DATA_VERSION;

    for (const window of WINDOWS) {
      const since = window === "30d" ? getStartOfTodayUtc() - windowMs(window) : Date.now() - windowMs(window);
      const serviceRows = getIndexedServiceAggregates(since);
      const providerRows = getIndexedProviderAggregates(since);
      const totalRelays = serviceRows.reduce((sum, row) => sum + row.relays, 0);
      const totalEstimatedRelays = migrationComplete
        ? serviceRows.reduce((sum, row) => sum + (row.estimated_relays ?? row.relays), 0)
        : totalRelays;
      const totalEstimatedComputeUnits = migrationComplete
        ? serviceRows.reduce((sum, row) => sum + (row.estimated_compute_units ?? 0), 0)
        : 0;
      const relayCoverage = migrationComplete ? getGlobalRelayCoverage(since) : 0;
      const computeUnitCoverage = migrationComplete ? getGlobalComputeUnitCoverage(since) : 0;
      const totalRevenueUpokt = serviceRows.reduce((sum, row) => sum + BigInt(row.revenue_upokt), 0n);
      const earliestSettlementTime = serviceRows.length > 0 ? new Date(since).toISOString() : null;
      const latestSettlementTime = latestFact ? new Date(latestFact.block_time).toISOString() : null;
      const services = serviceRows.map((row) => ({
        serviceId: row.service_id,
        serviceName: row.service_name ?? row.service_id,
        relays: row.relays,
        estimatedRelays: migrationComplete ? (row.estimated_relays ?? row.relays) : row.relays,
        computeUnits: migrationComplete ? (row.estimated_compute_units ?? undefined) : undefined,
        computeUnitsPerRelay: migrationComplete ? (row.compute_units_per_relay ?? undefined) : undefined,
        supplierCount: row.supplier_count,
        appsStaked: liveAppsStaked[row.service_id] ?? undefined,
        revenueUpokt: row.revenue_upokt,
        providerCount: row.provider_count
      }));
      const providers = providerRows.map((row, index) => ({
        providerKey: `provider-group-${index + 1}`,
        providerLabel: `Provider group ${index + 1}`,
        providerDomain: "anonymous",
        relays: row.relays,
        revenueUpokt: row.revenue_upokt,
        chainCount: row.service_count,
        supplierCount: 1,
        suppliers: [] as [],
        chains: [] as []
      }));
      const payload: SerializedDashboardCache = {
        window,
        generatedAt: new Date().toISOString(),
        dataSource: "rpc",
        poktPriceUsd,
        latestHeight,
        indexerProcessedHeight: latestHeight,
        indexerTargetHeight: latestSeenHeight,
        scannedHeights: latestHeight,
        scannedSettlementHeights: latestHeight,
        settlementEvents: providerRows.length,
        earliestSettlementTime,
        latestSettlementTime,
        totalRelays,
        totalEstimatedRelays,
        totalEstimatedComputeUnits,
        relayCoverage,
        computeUnitCoverage,
        totalRevenueUpokt: totalRevenueUpokt.toString(),
        activeProviders: providerRows.length,
        activeChains: services.length,
        suppliersPerSession: liveSuppliersPerSession,
        appsStakedByService: liveAppsStaked,
        sessionObservedHeight: sessionSyncedHeight ?? 0,
        sessionFetchedAt: oldestFetchedAt,
        sessionStale,
        providers,
        services
      };
      const payloadJson = JSON.stringify(payload);
      if (cacheChanged(window, payloadJson)) {
        setDashboardCache(window, payloadJson);
      }
    }

    const dailySince = getStartOfTodayUtc() - 30 * 24 * 60 * 60 * 1000;
    const rawDailyRows = getIndexedDailyAggregates(dailySince);
    const dailyRows = buildCalendarDailyHistory(rawDailyRows, migrationComplete);
    setProviderDataCache("network_daily_history:30", dailyRows);
    for (const service of getIndexedServiceAggregates(dailySince).slice(0, 100)) {
      const rows = getIndexedServiceDailyAggregates(dailySince, service.service_id);
      setProviderDataCache(`service_daily_history:${service.service_id}:30`, buildCalendarDailyHistory(rows, migrationComplete));
    }

    if (migrationComplete) {
      const generatedAt = new Date().toISOString();
      for (const row of rawDailyRows) {
        upsertDailyRollup({ ...row, generated_at: generatedAt });
      }
    }

    setProviderDataCache("indexer_status", {
      lastProcessedHeight: latestHeight,
      latestSeenHeight,
      lagBlocks: Math.max(0, latestSeenHeight - latestHeight),
      lastBlockTime: latestFact ? new Date(latestFact.block_time).toISOString() : null,
      wsConnected: getIndexerState("ws_connected") === "true",
      activeRpc: getIndexerState("active_rpc")
    });
    lastCacheBuildAt = Date.now();
    cacheDirty = false;
    finishJobRun(jobId, "success", startedAt, { durationMs: Date.now() - startedAt });
  } catch (error) {
    finishJobRun(jobId, "failed", startedAt, { durationMs: Date.now() - startedAt }, error instanceof Error ? error.stack ?? error.message : String(error));
    throw error;
  }
}

async function maybeRebuildCaches(force = false): Promise<void> {
  if (Date.now() - lastSessionSyncAt > SESSION_SYNC_INTERVAL_MS) {
    const success = await syncSessionData();
    if (success) {
      lastSessionSyncAt = Date.now();
      cacheDirty = true;
    }
  }

  if (!force && (!cacheDirty || Date.now() - lastCacheBuildAt < CACHE_INTERVAL_MS)) return;

  await rebuildIndexerCaches();
}

async function fetchBlockFactsWithRetries(height: number, rpcUrls = RPC_URLS): Promise<IndexedSettlementFact[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= BLOCK_RETRIES; attempt += 1) {
    try {
      return await fetchBlockFacts(height, rpcUrls);
    } catch (error) {
      lastError = error;
      logWarn("Block fetch failed", {
        height,
        attempt,
        maxAttempts: BLOCK_RETRIES,
        error: formatError(error)
      });
      if (attempt < BLOCK_RETRIES) {
        await sleep(RPC_RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Unable to fetch block facts for height ${height}`);
}

async function processHeight(height: number, rpcUrls = RPC_URLS): Promise<boolean> {
  try {
    const facts = await fetchBlockFactsWithRetries(height, rpcUrls);
    const blockTime = facts.length > 0 ? facts[0].blockTime : (await fetchBlockTimeMs(height, rpcUrls));
    const timestamp = Number(blockTime);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      throw new Error(`Block ${height} returned results but no block timestamp`);
    }
    saveIndexedBlock(height, facts, timestamp, "rpc");
    if (facts.length > 0) cacheDirty = true;
    return true;
  } catch (error) {
    markIndexedHeightFailed(height, formatError(error));
    logError("Height processing failed", error, { height });
    return false;
  }
}

type HeightFetchResult = {
  height: number;
  facts?: IndexedSettlementFact[];
  blockTime?: number;
  error?: string;
};

async function fetchHeightResult(height: number, rpcUrls = BACKFILL_RPC_URLS): Promise<HeightFetchResult> {
  try {
    const facts = await fetchBlockFactsWithRetries(height, rpcUrls);
    const blockTime = facts[0]?.blockTime ?? await fetchBlockTimeMs(height, rpcUrls);
    if (!Number.isFinite(blockTime)) {
      throw new Error(`Block ${height} returned results but no block timestamp`);
    }
    return { height, facts, blockTime };
  } catch (error) {
    return { height, error: formatError(error) };
  }
}

function getRepairCandidateHeights(fromHeight: number, toHeight: number, limit: number): { missing: number[]; failed: number[]; partial: number[] } {
  const coverage = getIndexedHeightCoverage(fromHeight, toHeight);
  const byHeight = new Map(coverage.map((row) => [row.height, row]));
  const missing: number[] = [];
  const failed: number[] = [];
  const partial: number[] = [];
  const now = Date.now();

  for (let height = toHeight; height >= fromHeight && missing.length + failed.length + partial.length < limit; height -= 1) {
    const row = byHeight.get(height);
    if (!row) {
      missing.push(height);
      continue;
    }
    if (row.status === "partial" || row.reward_complete === 0) {
      partial.push(height);
    } else if (row.status === "failed") {
      const lastTriedAt = new Date(row.scanned_at).getTime();
      const cooldownElapsed = !Number.isFinite(lastTriedAt) || now - lastTriedAt >= REPAIR_FAILED_COOLDOWN_MS;
      if (row.failure_count < REPAIR_MAX_FAILED_RETRIES && cooldownElapsed) {
        failed.push(height);
      }
    }
  }

  return { missing, failed, partial };
}

async function processRepairHeights(heights: number[], concurrency: number, source: string): Promise<{ repaired: number; failed: number; events: number }> {
  if (heights.length === 0) return { repaired: 0, failed: 0, events: 0 };
  const results = await mapConcurrent(heights, concurrency, (height) => fetchHeightResult(height, BACKFILL_RPC_URLS));
  let repaired = 0;
  let failed = 0;
  let events = 0;

  for (const result of results.sort((a, b) => b.height - a.height)) {
    if (result.facts) {
      saveIndexedBlock(result.height, result.facts, result.blockTime, "rpc");
      repaired += 1;
      events += result.facts.length;
      cacheDirty = true;
    } else {
      markIndexedHeightFailed(result.height, result.error ?? "Unknown block fetch error");
      failed += 1;
    }
  }

  logInfo("Repair batch completed", {
    source,
    heights: heights.length,
    repaired,
    failed,
    events,
    rpcHealth: rpcHealthSnapshot()
  });

  return { repaired, failed, events };
}

async function runRepairLoop(): Promise<void> {
  let graphQLCycleCounter = 0;
  const GRAPHQL_REPAIR_INTERVAL = 1;
  while (true) {
    const startedAt = Date.now();
    graphQLCycleCounter += 1;
    try {
      const latestHeight = await getLatestHeight();
      const retentionStartHeight = estimateBackfillStart(latestHeight, RETENTION_DAYS);
      const { missing, failed, partial } = getRepairCandidateHeights(retentionStartHeight, latestHeight, REPAIR_BATCH_SIZE);
      const candidateHeights = [...new Set([...partial, ...missing, ...failed])].sort((a, b) => b - a).slice(0, REPAIR_BATCH_SIZE);

      if (candidateHeights.length > 0) {
        const result = await processRepairHeights(candidateHeights, REPAIR_CONCURRENCY, "repair-loop");
        await maybeRebuildCaches();
        pruneIndexerData(RETENTION_DAYS);
        pruneIndexedHeightCoverage(retentionStartHeight);
        logInfo("Repair loop summary", {
          latestHeight,
          retentionStartHeight,
          missingHeights: missing.length,
          partialRewardHeights: partial.length,
          retryableFailedHeights: failed.length,
          repairedHeights: result.repaired,
          stillFailedHeights: result.failed,
          durationMs: Date.now() - startedAt
        });
      } else {
        logInfo("Repair loop found no gaps", {
          latestHeight,
          retentionStartHeight,
          durationMs: Date.now() - startedAt
        });
      }
    } catch (error) {
      logError("Repair loop failed", error);
    }

    if (graphQLCycleCounter % GRAPHQL_REPAIR_INTERVAL === 0) {
      try {
        await updateGraphQLWatermark();
        const gqlResult = await graphQLRepairFailedHeights();
        if (gqlResult.repaired > 0 || gqlResult.failed > 0 || gqlResult.metadataRepaired > 0) {
          logInfo("GraphQL repair summary", gqlResult);
          if (gqlResult.repaired > 0 || gqlResult.metadataRepaired > 0) {
            cacheDirty = true;
            await maybeRebuildCaches(true);
          }
        }
      } catch (error) {
        logError("GraphQL repair cycle failed", error);
      }
    }

    await sleep(REPAIR_INTERVAL_MS);
  }
}

async function processRange(fromHeight: number, toHeight: number, maxBlocks?: number): Promise<void> {
  const targetHeight = maxBlocks ? Math.min(toHeight, fromHeight + maxBlocks - 1) : toHeight;
  for (let height = fromHeight; height <= targetHeight; height += 1) {
    await processHeight(height);
    if (height % 25 === 0 || height === targetHeight) {
      setIndexerState("highest_seen_height", String(toHeight));
      await maybeRebuildCaches();
      logInfo("Indexed block range progress", { height, targetHeight });
    }
  }
}

async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await worker(items[current]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return hours === 0 ? `${remainingMinutes}m ${remainingSeconds}s` : `${hours}h ${remainingMinutes}m`;
}

async function processBackfillRange(fromHeight: number, toHeight: number, maxBlocks?: number): Promise<void> {
  const targetHeight = toHeight;
  const minimumHeight = maxBlocks ? Math.max(fromHeight, toHeight - maxBlocks + 1) : fromHeight;
  const totalBlocks = Math.max(0, targetHeight - minimumHeight + 1);
  const startedAt = Date.now();
  let processedBlocks = 0;
  let indexedEvents = 0;

  logInfo("Starting concurrent backfill range", {
    fromHeight,
    minimumHeight,
    targetHeight,
    totalBlocks,
    concurrency: BACKFILL_CONCURRENCY,
    batchSize: BACKFILL_BATCH_SIZE,
    rpcTimeoutMs: RPC_TIMEOUT_MS,
    rpcRetries: RPC_RETRIES,
    rpcRetryDelayMs: RPC_RETRY_DELAY_MS,
    blockRetries: BLOCK_RETRIES
  });

  for (let batchEnd = targetHeight; batchEnd >= minimumHeight; batchEnd -= BACKFILL_BATCH_SIZE) {
    const batchStart = Math.max(minimumHeight, batchEnd - BACKFILL_BATCH_SIZE + 1);
    const heights = Array.from({ length: batchEnd - batchStart + 1 }, (_, index) => batchEnd - index);
    const batchResults = await mapConcurrent(heights, BACKFILL_CONCURRENCY, (height) => fetchHeightResult(height, BACKFILL_RPC_URLS));
    let failedBlocks = 0;

    for (const result of batchResults.sort((a, b) => b.height - a.height)) {
      if (result.facts) {
        saveIndexedBlock(result.height, result.facts, result.blockTime, "rpc");
        indexedEvents += result.facts.length;
        cacheDirty = true;
      } else {
        markIndexedHeightFailed(result.height, result.error ?? "Unknown block fetch error");
        failedBlocks += 1;
      }
    }

    processedBlocks += heights.length;
    setIndexerState("highest_seen_height", String(toHeight));
    const elapsedMs = Date.now() - startedAt;
    const blocksPerMinute = elapsedMs === 0 ? 0 : Math.round((processedBlocks / elapsedMs) * 60_000);
    const remainingBlocks = Math.max(0, totalBlocks - processedBlocks);
    const etaMs = blocksPerMinute === 0 ? 0 : (remainingBlocks / blocksPerMinute) * 60_000;

    logInfo("Concurrent backfill progress", {
      height: batchStart,
      targetHeight,
      minimumHeight,
      processedBlocks,
      totalBlocks,
      indexedEvents,
      failedBlocks,
      blocksPerMinute,
      eta: formatDuration(etaMs),
      rpcHealth: rpcHealthSnapshot()
    });
  }
}

function estimateBackfillStart(latestHeight: number, days: number): number {
  const averageBlockSeconds = Number(process.env.POCKET_INDEXER_AVG_BLOCK_SECONDS ?? 60);
  return Math.max(1, latestHeight - Math.ceil((days * 24 * 60 * 60) / averageBlockSeconds));
}

function backfillEmptyHeightMetadata(): void {
  try {
    let total = 0;
    while (true) {
      const rows = getEmptyHeightsWithoutMetadata(5000);
      if (rows.length === 0) break;
      for (const row of rows) {
        const day = new Date(row.blockTime).toISOString().slice(0, 10);
        completeVerifiedEmptyHeight(row.height, row.blockTime, day);
      }
      total += rows.length;
    }
    logInfo("Empty height metadata backfill complete", { count: total });
  } catch (error) {
    logError("Empty height metadata backfill failed", error);
    throw error;
  }
}

async function runDataMigration(): Promise<void> {
  const storedVersion = Number(getIndexerState("data_version") ?? "0");
  if (storedVersion >= INDEXER_DATA_VERSION) return;

  if (storedVersion === 3) {
    // v4 is an additive data-model migration. It must finish moving GraphQL
    // observations out of canonical facts before the version can advance.
    const result = migrateV3ToV4();
    setIndexerState("data_version", String(INDEXER_DATA_VERSION));
    await rebuildIndexerCaches();
    logInfo("Data migration complete", { fromVersion: storedVersion, version: INDEXER_DATA_VERSION, ...result });
    return;
  }

  const contiguousVal = getIndexerState("contiguous_processed_height");
  const legacyVal = getIndexerState("last_processed_height");
  const latestHeight = Number(contiguousVal ?? legacyVal ?? 0);
  const latestSeenHeight = Number(getIndexerState("highest_seen_height") ?? getIndexerState("latest_seen_height") ?? latestHeight);
  const retentionStartHeight = estimateBackfillStart(latestSeenHeight, RETENTION_DAYS);

  const coverage = getIndexedHeightCoverage(retentionStartHeight, latestSeenHeight);
  const indexedHeights = coverage
    .filter((row) => row.status === "indexed")
    .map((row) => row.height)
    .sort((a, b) => b - a);

  if (indexedHeights.length === 0) {
    logWarn("Data migration found no indexed heights to reprocess; cannot advance version", { fromVersion: storedVersion, toVersion: INDEXER_DATA_VERSION });
    return;
  }

  logInfo("Running data migration", { fromVersion: storedVersion, toVersion: INDEXER_DATA_VERSION, heightCount: indexedHeights.length });

  let totalFailed = 0;
  for (let i = 0; i < indexedHeights.length; i += REPAIR_BATCH_SIZE) {
    const batch = indexedHeights.slice(i, i + REPAIR_BATCH_SIZE);
    let lastResult: { repaired: number; failed: number; events: number } = { repaired: 0, failed: batch.length, events: 0 };
    for (let attempt = 0; attempt < MIGRATION_MAX_RETRIES; attempt += 1) {
      if (attempt > 0) {
        const delay = MIGRATION_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        logWarn("Retrying failed migration batch", { attempt: attempt + 1, batchSize: batch.length, delay });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      lastResult = await processRepairHeights(batch, REPAIR_CONCURRENCY, "data-migration");
      if (lastResult.failed === 0) break;
      logWarn("Migration batch had failures", { attempt: attempt + 1, failed: lastResult.failed, batchSize: batch.length });
    }
    totalFailed += lastResult.failed;
  }

  if (totalFailed > 0) {
    logWarn("Data migration incomplete; not advancing version", { version: INDEXER_DATA_VERSION, totalFailed });
    return;
  }

  logInfo("Backfilling block_time/day for empty indexed heights");
  backfillEmptyHeightMetadata();

  // Seed contiguous — scan upward from retention start and stop at the
  // first missing or failed height. The contiguous value is the last
  // verified height before that gap.
  const currentContiguous = Number(getIndexerState("contiguous_processed_height") ?? 0);
  if (currentContiguous === 0) {
    const legacy = Number(legacyVal ?? 0);
    if (legacy > 0) {
      let contiguous = 0;
      for (let h = retentionStartHeight; h <= legacy; h += 1) {
        const coverage = getIndexedHeightCoverage(h, h);
        const row = coverage[0];
        if (row && (row.status === "indexed" || row.status === "empty")) {
          contiguous = h;
        } else {
          break;
        }
      }
      setIndexerState("contiguous_processed_height", String(contiguous));
      logInfo("Seeded contiguous checkpoint from legacy", { legacy, retentionStartHeight, contiguous });
    }
  }

  // Also seed highest_seen and highest_ingested if still at 0
  const currentSeen = Number(getIndexerState("highest_seen_height") ?? 0);
  if (currentSeen === 0 && legacyVal) {
    setIndexerState("highest_seen_height", legacyVal);
  }
  const currentIngested = Number(getIndexerState("highest_ingested_height") ?? 0);
  if (currentIngested === 0 && legacyVal) {
    setIndexerState("highest_ingested_height", legacyVal);
  }

  // Older migrations first reconstitute canonical RPC facts, then apply the
  // same v4 staging/complete-flag transition before publishing the version.
  migrateV3ToV4();
  setIndexerState("data_version", String(INDEXER_DATA_VERSION));
  await rebuildIndexerCaches();
  logInfo("Data migration complete", { version: INDEXER_DATA_VERSION, reprocessedHeights: indexedHeights.length });
}

async function runCatchup(options: IndexerOptions): Promise<void> {
  const latestHeight = options.toHeight ?? await getLatestHeight();
  const checkpoint = Number(getIndexerState("contiguous_processed_height") ?? 0);
  const configuredStart = Number(process.env.POCKET_INDEXER_START_HEIGHT ?? 0);
  const isImplicitLiveCatchup = Boolean(options.live && !options.backfillDays && !options.fromHeight && !options.toHeight);
  let fromHeight = options.fromHeight
    ?? (options.backfillDays ? estimateBackfillStart(latestHeight, options.backfillDays) : undefined)
    ?? (configuredStart > 0 ? configuredStart : undefined)
    ?? (checkpoint > 0 ? checkpoint + 1 : latestHeight);

  if (isImplicitLiveCatchup && latestHeight - fromHeight + 1 > LIVE_CATCHUP_MAX_BLOCKS) {
    logWarn("Skipping stale live checkpoint catchup", {
      checkpoint,
      requestedFromHeight: fromHeight,
      latestHeight,
      lagBlocks: latestHeight - checkpoint,
      liveCatchupMaxBlocks: LIVE_CATCHUP_MAX_BLOCKS
    });
    fromHeight = latestHeight;
  }

  setIndexerState("highest_seen_height", String(latestHeight));
  if (fromHeight <= latestHeight) {
    if (options.live && !options.backfillDays && !options.fromHeight && !options.toHeight) {
      await processRange(fromHeight, latestHeight, options.maxBlocks);
    } else {
      await processBackfillRange(fromHeight, latestHeight, options.maxBlocks);
    }
  }
  await maybeRebuildCaches(true);
}

async function runLiveCatchup(maxBlocks = LIVE_CATCHUP_MAX_BLOCKS): Promise<void> {
  if (liveCatchupInFlight) {
    logInfo("Skipping live catchup because one is already running");
    return;
  }

  liveCatchupInFlight = true;
  try {
    const latestHeight = await getLatestHeight();
    const checkpoint = Number(getIndexerState("contiguous_processed_height") ?? 0);
    let fromHeight = checkpoint > 0 ? checkpoint + 1 : latestHeight;

    setIndexerState("highest_seen_height", String(latestHeight));
    if (latestHeight - fromHeight + 1 > LIVE_CATCHUP_MAX_BLOCKS) {
      logWarn("Skipping stale live catchup", {
        checkpoint,
        requestedFromHeight: fromHeight,
        latestHeight,
        lagBlocks: latestHeight - checkpoint,
        liveCatchupMaxBlocks: LIVE_CATCHUP_MAX_BLOCKS
      });
      fromHeight = latestHeight;
    }

    if (fromHeight <= latestHeight) {
      await processRange(fromHeight, latestHeight, maxBlocks);
    }
    await maybeRebuildCaches();
  } finally {
    liveCatchupInFlight = false;
  }
}

async function runLiveStartupTasks(): Promise<void> {
  try {
    await syncServices();
  } catch (error) {
    logError("Service sync failed during live startup", error);
  }

  try {
    await syncSupplierDomains();
  } catch (error) {
    logError("Supplier domain sync failed during live startup", error);
  }

  try {
    await syncSessionData();
  } catch (error) {
    logError("Session data sync failed during live startup", error);
  }

  try {
    await runLiveCatchup(500);
    pruneIndexerData(RETENTION_DAYS);
  } catch (error) {
    logError("Initial live catchup failed", error);
  }
}

function subscribeToNewBlocks(ws: WebSocket): void {
  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    method: "subscribe",
    id: "pocket-dashboard-new-blocks",
    params: { query: "tm.event='NewBlock'" }
  }));
}

function extractHeightFromWsMessage(data: unknown): number | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as { result?: { data?: { value?: { block?: { header?: { height?: string } } } } } };
    const height = Number(parsed.result?.data?.value?.block?.header?.height ?? 0);
    return height > 0 ? height : null;
  } catch {
    return null;
  }
}

async function runLive(): Promise<void> {
  let rpcIndex = 0;

  while (true) {
    const rpcUrl = RPC_URLS[rpcIndex % RPC_URLS.length];
    const websocketUrl = wsUrlFromRpc(rpcUrl);
    setIndexerState("active_rpc", rpcUrl);
    setIndexerState("ws_connected", "false");
    logInfo("Connecting indexer websocket", { websocketUrl });

    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(websocketUrl);
        let lastMessageAt = Date.now();
        const idleTimer = globalThis.setInterval(() => {
          if (Date.now() - lastMessageAt > WS_IDLE_TIMEOUT_MS) {
            ws.close();
            reject(new Error("WebSocket idle timeout"));
          }
        }, 5_000);

        ws.addEventListener("open", () => {
          setIndexerState("ws_connected", "true");
          subscribeToNewBlocks(ws);
        });
        ws.addEventListener("message", (event) => {
          lastMessageAt = Date.now();
          const height = extractHeightFromWsMessage(event.data);
          if (!height) return;

          void (async () => {
            const checkpoint = Number(getIndexerState("contiguous_processed_height") ?? 0);
            setIndexerState("highest_seen_height", String(height));
            if (height > checkpoint) {
              const fromHeight = checkpoint > 0 ? checkpoint + 1 : height;
              const gapBlocks = height - fromHeight;
              if (gapBlocks > 0) {
                logWarn("Processing live tip before websocket checkpoint gap", {
                  checkpoint,
                  requestedFromHeight: fromHeight,
                  latestHeight: height,
                  gapBlocks,
                  liveCatchupMaxBlocks: LIVE_CATCHUP_MAX_BLOCKS
                });
                void runLiveCatchup(500).catch((error) => logError("Websocket gap catchup failed", error));
              }
              await processRange(height, height);
            }
          })().catch((error) => logError("Live block processing failed", error, { height }));
        });
        ws.addEventListener("close", () => {
          globalThis.clearInterval(idleTimer);
          setIndexerState("ws_connected", "false");
          resolve();
        });
        ws.addEventListener("error", (event) => {
          globalThis.clearInterval(idleTimer);
          setIndexerState("ws_connected", "false");
          reject(new Error(`WebSocket error: ${event.type}`));
        });
      });
    } catch (error) {
      logWarn("WebSocket connection failed", { rpcUrl, error: error instanceof Error ? error.message : String(error) });
    }

    rpcIndex += 1;
    await sleep(Math.min(30_000, 1_000 * rpcIndex));
    void runLiveCatchup(500).catch((error) => logError("Reconnect live catchup failed", error));
  }
}

export async function runIndexer(options: IndexerOptions = {}): Promise<void> {
  const startedAt = Date.now();

  if (!acquireIndexerLock()) {
    logInfo("Indexer is already running on this database; refusing to start.");
    return;
  }

  const jobId = startJobRun("indexer_start", options as Record<string, unknown>);
  const liveFirst = Boolean(options.live && !options.once && !options.backfillDays && !options.fromHeight && !options.toHeight);

  process.on("exit", releaseIndexerLock);
  process.on("SIGINT", () => { releaseIndexerLock(); process.exit(0); });
  process.on("SIGTERM", () => { releaseIndexerLock(); process.exit(0); });

  warmupSessionState();

  try {
    logInfo("Starting Pocket indexer", options as Record<string, unknown>);
    await runDataMigration();

    if (liveFirst) {
      void runLiveStartupTasks().catch((error) => logError("Live startup background tasks failed", error));
      finishJobRun(jobId, "success", startedAt, { durationMs: Date.now() - startedAt, liveFirst: true });
      await Promise.all([runLive(), runRepairLoop()]);
      return;
    }

    await syncServices();
    await syncSupplierDomains();
    await syncSessionData();
    await runCatchup(options);
    pruneIndexerData(RETENTION_DAYS);
    finishJobRun(jobId, "success", startedAt, { durationMs: Date.now() - startedAt });

    if (options.once || !options.live) {
      return;
    }

    await Promise.all([runLive(), runRepairLoop()]);
  } catch (error) {
    finishJobRun(jobId, "failed", startedAt, { durationMs: Date.now() - startedAt }, error instanceof Error ? error.stack ?? error.message : String(error));
    throw error;
  } finally {
    releaseIndexerLock();
  }
}
