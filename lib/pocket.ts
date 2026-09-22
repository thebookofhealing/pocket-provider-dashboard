import { cache } from "react";

import { finishJobRun, getCachedSettlementBlocks, getDashboardCache, getMeta, isDatabaseReadOnly, saveSettlementBlock, setDashboardCache, setMeta, startJobRun } from "@/lib/db";
import { getDevelopmentDashboardData, getDevelopmentNetworkDailyHistory, getDevelopmentServiceDailyHistory, isDevelopmentDummyDataEnabled } from "@/lib/dev-fixtures";
import { SESSION_SUPPLIER_SLOTS } from "@/lib/opportunities";
import { PROVIDER_DOMAIN_LABEL_OVERRIDES, SUPPLIER_PROVIDER_OVERRIDES } from "@/lib/provider-overrides";
import { DEFAULT_RPC_URLS } from "@/lib/rpc-status";
import type {
  DashboardData,
  NetworkDailyHistoryPoint,
  ProviderDailyHistoryPoint,
  ProviderStats,
  ServiceDailyHistoryPoint,
  ServiceMap,
  ServiceStats,
  SupplierDirectory,
  SupplierDirectoryEntry,
  SupplierMember,
  TimeWindow
} from "@/lib/types";

type RpcEvent = {
  type: string;
  attributes: Array<{
    key: string;
    value: string;
    index: boolean;
  }>;
};

type StatusResponse = {
  result?: {
    sync_info?: {
      latest_block_height?: string;
    };
  };
};

type BlockSearchResponse = {
  result?: {
    blocks?: Array<{
      block?: {
        header?: {
          height?: string;
          time?: string;
        };
      };
    }>;
  };
};

type CoinGeckoPriceResponse = {
  "pocket-network"?: {
    usd?: number;
  };
};

type PoktscanMetadataResponse = {
  data?: {
    status?: {
      lastProcessedHeight?: number | null;
      targetHeight?: number | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
};

type PoktscanDomainRewardsResponse = {
  data?: {
    status?: {
      lastProcessedHeight?: number | null;
      targetHeight?: number | null;
    } | null;
    rewards?: {
      groupedAggregates?: Array<{
        keys?: string[] | null;
        sum?: {
          grossRewards?: string | number | null;
          relays?: string | number | null;
        } | null;
      }> | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
};

type PoktscanProviderDailyHistoryResponse = {
  data?: {
    rewards?: {
      groupedAggregates?: Array<{
        keys?: string[] | null;
        sum?: {
          grossRewards?: string | number | null;
          relays?: string | number | null;
        } | null;
      }> | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
};

type PoktscanNetworkDailyHistoryResponse = PoktscanProviderDailyHistoryResponse;

type PoktscanServiceDailyHistoryResponse = PoktscanProviderDailyHistoryResponse;

type PoktscanClaimSettledAggregatesResponse = {
  data?: {
    status?: {
      lastProcessedHeight?: number | null;
      targetHeight?: number | null;
    } | null;
    claims?: {
      groupedAggregates?: Array<{
        keys?: string[] | null;
        sum?: {
          claimedAmount?: string | number | null;
          numRelays?: string | number | null;
        } | null;
      }> | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
};

type PoktscanSuppliersResponse = {
  data?: {
    suppliers?: {
      nodes?: Array<{
        id: string;
        ownerId: string;
        operatorId: string;
        serviceConfigs?: {
          nodes?: Array<{
            domains?: string[] | null;
            endpoints?: Array<{ url?: string | null }> | null;
          }> | null;
        } | null;
      } | null> | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
};

type PoktscanSupplierNode = {
  id: string;
  ownerId: string;
  operatorId: string;
  serviceConfigs?: {
    nodes?: Array<{
      domains?: string[] | null;
      endpoints?: Array<{ url?: string | null }> | null;
    } | null> | null;
  } | null;
};

type SupplierRevShare = {
  address?: string;
  rev_share_percentage?: string | number | null;
};

type ProviderAggregateRow = {
  providerKey: string;
  providerLabel: string;
  providerDomain: string;
  supplierOperatorAddress?: string;
  supplierOwnerAddress?: string;
  serviceId: string;
  serviceName: string;
  computeUnitsPerRelay?: number;
  relays: number;
  revenueUpokt: bigint;
};

type ServicesResponse = {
  service?: Array<{
    id: string;
    name: string;
    compute_units_per_relay?: string | number | null;
    computeUnitsPerRelay?: string | number | null;
  }>;
  pagination?: {
    next_key?: string | null;
  };
};

type SuppliersResponse = {
  supplier?: Array<{
    owner_address: string;
    operator_address: string;
    stake?: {
      amount?: string | number | null;
    };
    services?: Array<{
      service_id?: string;
      endpoints?: Array<{
        url: string;
      }>;
      rev_share?: SupplierRevShare[];
    }>;
  }>;
  pagination?: {
    next_key?: string | null;
  };
};

type RewardDistributionDetail = {
  recipient_address: string;
  op_reason: string;
  amount: string;
};

type SettlementEvent = {
  blockHeight: number;
  blockTime: string;
  serviceId: string;
  serviceName: string;
  computeUnitsPerRelay?: number;
  supplierOperatorAddress: string;
  supplierOwnerAddress: string;
  numRelays: number;
  supplierRevenueUpokt: bigint;
};

const DEFAULT_RPC_URL = process.env.POCKET_RPC_URL ?? DEFAULT_RPC_URLS[0];
const DEFAULT_REST_URL = process.env.POCKET_REST_URL ?? "https://sauron-api.infra.pocket.network";
const DEFAULT_POKTSCAN_URL = process.env.POKTSCAN_API_URL ?? "https://data.pocket.network/";
const LEGACY_RPC_FALLBACK_ENABLED = process.env.POCKET_LEGACY_RPC_FALLBACK_ENABLED === "true";
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

const SERVICES_PATH = "/pokt-network/poktroll/service/service";
const SUPPLIERS_PATH = "/pokt-network/poktroll/supplier/supplier";
const CACHE_TTL_MS = 60 * 60 * 1000;
const UI_MEMORY_CACHE_TTL_MS = Number(process.env.POCKET_UI_MEMORY_CACHE_MS ?? 30_000);
const SUPPLIER_DIRECTORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const BLOCK_RESULTS_TIMEOUT_MS = 8_000;
const PRICE_TIMEOUT_MS = Number(process.env.POCKET_PRICE_TIMEOUT_MS ?? 20_000);
const PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=pocket-network&vs_currencies=usd";
const POKTSCAN_TIMEOUT_MS = 15_000;
const POKTSCAN_MAX_ATTEMPTS = 4;
const POKTSCAN_MAX_CONCURRENCY = 2;
const SETTLEMENT_EVENT_TYPE = "pocket.tokenomics.EventClaimSettled";
const SETTLEMENT_MODE_QUERY = "pocket.tokenomics.EventClaimSettled.mode='EndBlock'";
const SUPPLIER_REWARD_REASONS = new Set([
  "TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION",
  "TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION"
]);
const SECOND_LEVEL_SUFFIXES = new Set(["co.uk", "org.uk", "com.au", "net.au", "co.jp", "com.br"]);

const SAMPLE_BLOCKS_PER_WINDOW: Record<TimeWindow, number> = {
  "24h": 36,
  "7d": 72,
  "30d": 144,
  "365d": 144
};
const PROVIDER_HISTORY_DAYS = 30;
const BLOCK_SEARCH_TIMEOUT_MS = 2_500;

const dashboardCache = new Map<TimeWindow, { expiresAt: number; data: DashboardData }>();
const dashboardRefreshes = new Map<TimeWindow, Promise<DashboardData>>();
let priceCache: { value: number; expiresAt: number } | null = null;
let activePoktscanRequests = 0;
const poktscanQueue: Array<() => void> = [];

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
    const causeMessage = cause ? `\nCause: ${getErrorMessage(cause)}` : "";
    return `${error.stack ?? error.message}${causeMessage}`;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logDataInfo(message: string, context?: Record<string, unknown>): void {
  console.info(`[pocket-dashboard:data] ${message}`, context ?? "");
}

function logDataWarning(message: string, context?: Record<string, unknown>): void {
  console.warn(`[pocket-dashboard:data] ${message}`, context ?? "");
}

function logDataError(message: string, error: unknown, context?: Record<string, unknown>): void {
  console.error(`[pocket-dashboard:data] ${message}`, {
    ...context,
    error: getErrorMessage(error)
  });
}

function getGraphqlOperationName(query: string): string {
  return query.match(/\b(?:query|mutation)\s+([A-Za-z0-9_]+)/)?.[1] ?? "anonymous";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquirePoktscanSlot(): Promise<{ release: () => void; queuedMs: number }> {
  const queuedAt = Date.now();

  if (activePoktscanRequests < POKTSCAN_MAX_CONCURRENCY) {
    activePoktscanRequests += 1;
    return {
      release: releasePoktscanSlot,
      queuedMs: Date.now() - queuedAt
    };
  }

  await new Promise<void>((resolve) => poktscanQueue.push(resolve));
  activePoktscanRequests += 1;

  return {
    release: releasePoktscanSlot,
    queuedMs: Date.now() - queuedAt
  };
}

function releasePoktscanSlot(): void {
  activePoktscanRequests = Math.max(0, activePoktscanRequests - 1);
  poktscanQueue.shift()?.();
}

function getPoktscanBackoffMs(attempt: number): number {
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(5_000, 500 * 2 ** (attempt - 1)) + jitter;
}

function isRetryablePoktscanStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function markRetryableError(error: Error, retryable: boolean): Error & { retryable?: boolean } {
  return Object.assign(error, { retryable });
}

function isMarkedNonRetryable(error: unknown): boolean {
  return error instanceof Error && "retryable" in error && (error as Error & { retryable?: boolean }).retryable === false;
}

type SerializedDashboardCache = Omit<DashboardData, "totalRevenueUpokt" | "providers" | "services"> & {
  totalRevenueUpokt: string;
  providers: Array<Omit<ProviderStats, "revenueUpokt" | "chains" | "suppliers"> & {
    revenueUpokt: string;
    suppliers: Array<Omit<SupplierMember, "revenueUpokt" | "stakeUpokt"> & { revenueUpokt?: string; stakeUpokt?: string }>;
    chains: Array<{ serviceId: string; serviceName: string; relays: number; revenueUpokt: string }>;
  }>;
  services: Array<Omit<ServiceStats, "revenueUpokt"> & { revenueUpokt: string }>;
};

type ServiceSupplierCounts = Record<string, number>;

type PoktscanClaimAggregate = {
  keys?: string[] | null;
  sum?: {
    claimedAmount?: string | number | null;
    numRelays?: string | number | null;
  } | null;
};

type PoktscanClaimAggregateCacheEntry = PoktscanClaimAggregate;

type ProviderDailyHistoryCacheEntry = Omit<ProviderDailyHistoryPoint, "revenueUpokt"> & {
  revenueUpokt: string;
};

type SupplierMemberCacheEntry = Omit<SupplierMember, "revenueUpokt" | "stakeUpokt"> & {
  revenueUpokt?: string;
  stakeUpokt?: string;
};

type SupplierDirectoryCacheEntry = Omit<SupplierDirectoryEntry, "stakeUpokt"> & {
  stakeUpokt?: string;
};

type SupplierDirectoryCachePayload = {
  updatedAt: string;
  data: Record<string, SupplierDirectoryCacheEntry>;
};

type ProviderDataCache<T> = {
  updatedAt: string;
  data: T;
};

type NetworkDailyHistoryCacheEntry = Omit<NetworkDailyHistoryPoint, "revenueUpokt"> & {
  revenueUpokt: string;
};

function buildRpcUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function getRpcCandidates(seed = 0): string[] {
  if (RPC_URLS.length <= 1) {
    return RPC_URLS;
  }

  const normalizedSeed = Math.abs(seed) % RPC_URLS.length;
  return [...RPC_URLS.slice(normalizedSeed), ...RPC_URLS.slice(0, normalizedSeed)];
}

async function fetchFromRpc<T>(rpcUrl: string, path: string, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<T> {
  const response = await fetch(buildRpcUrl(rpcUrl, path), {
    headers: {
      accept: "application/json"
    },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${rpcUrl}${path}: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

async function fetchJsonFromRpcPool<T>(path: string, options?: { seed?: number; timeoutMs?: number; parallel?: boolean }): Promise<T> {
  const candidates = getRpcCandidates(options?.seed ?? 0);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

  if (options?.parallel !== false) {
    try {
      return await Promise.any(candidates.map((rpcUrl) => fetchFromRpc<T>(rpcUrl, path, timeoutMs)));
    } catch {
      // Fall through to sequential retry so we can surface the last meaningful error.
    }
  }

  let lastError: unknown;
  for (const rpcUrl of candidates) {
    try {
      return await fetchFromRpc<T>(rpcUrl, path, timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`All RPC requests failed for path ${path}`);
}

async function fetchJson<T>(url: string, timeoutMs?: number): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "pocket-dashboard/1.0"
    },
    cache: "no-store",
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

async function fetchPoktscan<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const operationName = getGraphqlOperationName(query);
  let lastError: unknown;

  logDataInfo("Starting Poktscan GraphQL request", {
    operationName,
    url: DEFAULT_POKTSCAN_URL,
    variables
  });

  for (let attempt = 1; attempt <= POKTSCAN_MAX_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    const { release, queuedMs } = await acquirePoktscanSlot();

    try {
      const response = await fetch(DEFAULT_POKTSCAN_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        cache: "no-store",
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(POKTSCAN_TIMEOUT_MS)
      });

      if (!response.ok) {
        let body = "";
        try {
          body = (await response.text()).slice(0, 1000);
        } catch (error) {
          body = `Unable to read response body: ${getErrorMessage(error)}`;
        }

        const retryable = isRetryablePoktscanStatus(response.status);
        const error = markRetryableError(new Error(`Request failed for ${DEFAULT_POKTSCAN_URL}: ${response.status} ${response.statusText}`), retryable);
        lastError = error;
        logDataError("Poktscan HTTP request failed", error, {
          operationName,
          url: DEFAULT_POKTSCAN_URL,
          status: response.status,
          statusText: response.statusText,
          durationMs: Date.now() - startedAt,
          queuedMs,
          attempt,
          maxAttempts: POKTSCAN_MAX_ATTEMPTS,
          variables,
          body
        });

        if (!retryable || attempt === POKTSCAN_MAX_ATTEMPTS) {
          throw error;
        }

        await sleep(getPoktscanBackoffMs(attempt));
        continue;
      }

      let payload: { errors?: Array<{ message: string }> } & T;
      try {
        payload = (await response.json()) as { errors?: Array<{ message: string }> } & T;
      } catch (error) {
        logDataError("Poktscan JSON parsing failed", error, {
          operationName,
          url: DEFAULT_POKTSCAN_URL,
          status: response.status,
          durationMs: Date.now() - startedAt,
          queuedMs,
          attempt,
          maxAttempts: POKTSCAN_MAX_ATTEMPTS,
          variables
        });
        throw error;
      }

      if (payload.errors?.length) {
        const error = markRetryableError(new Error(payload.errors.map((entry) => entry.message).join("; ")), false);
        logDataError("Poktscan GraphQL errors returned", error, {
          operationName,
          url: DEFAULT_POKTSCAN_URL,
          status: response.status,
          durationMs: Date.now() - startedAt,
          queuedMs,
          attempt,
          maxAttempts: POKTSCAN_MAX_ATTEMPTS,
          variables,
          errors: payload.errors
        });
        throw error;
      }

      logDataInfo("Poktscan request completed", {
        operationName,
        status: response.status,
        durationMs: Date.now() - startedAt,
        queuedMs,
        attempt,
        variables
      });

      return payload;
    } catch (error) {
      lastError = error;
      logDataError("Poktscan network request failed", error, {
        operationName,
        url: DEFAULT_POKTSCAN_URL,
        durationMs: Date.now() - startedAt,
        queuedMs,
        attempt,
        maxAttempts: POKTSCAN_MAX_ATTEMPTS,
        variables
      });

      if (isMarkedNonRetryable(error) || attempt === POKTSCAN_MAX_ATTEMPTS) {
        throw error;
      }

      await sleep(getPoktscanBackoffMs(attempt));
    } finally {
      release();
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Poktscan request failed");
}

const getPoktscanClaimAggregates = cache(async (window: TimeWindow): Promise<PoktscanClaimAggregate[]> => {
  const cacheKey = getPoktscanClaimAggregatesCacheKey(window);
  const cached = getProviderDataCache<PoktscanClaimAggregateCacheEntry[]>(cacheKey);
  if (cached) {
    logDataInfo("Poktscan claim aggregates served from persistent cache", { window, aggregateCount: cached.length });
    return cached;
  }

  const start = getWindowStart(window);
  const response = await fetchPoktscan<PoktscanClaimSettledAggregatesResponse>(
    `query PoktscanClaimsBySupplier($start: Datetime!) {
      claims: eventClaimSettleds(
        filter: {
          block: {
            timestamp: {
              greaterThanOrEqualTo: $start
            }
          }
        }
      ) {
        groupedAggregates(groupBy: [SUPPLIER_ID, SERVICE_ID]) {
          keys
          sum {
            claimedAmount
            numRelays
          }
        }
      }
    }`,
    {
      start: start.toISOString()
    }
  );

  const aggregates = response.data?.claims?.groupedAggregates ?? [];
  setProviderDataCache(cacheKey, aggregates);
  return aggregates;
});

async function getPoktPriceUsd(): Promise<number> {
  if (priceCache && priceCache.expiresAt > Date.now()) {
    return priceCache.value;
  }

  const cachedMeta = getMeta("pokt_price_usd");
  if (cachedMeta) {
    try {
      const parsed = JSON.parse(cachedMeta) as { value: number; updatedAt: string };
      if (Date.now() - new Date(parsed.updatedAt).getTime() < CACHE_TTL_MS) {
        priceCache = { value: parsed.value, expiresAt: Date.now() + CACHE_TTL_MS };
        return parsed.value;
      }
    } catch {
      // Ignore invalid cached price payload.
    }
  }

  try {
    const response = await fetchJson<CoinGeckoPriceResponse>(PRICE_URL, PRICE_TIMEOUT_MS);
    const value = response["pocket-network"]?.usd ?? 0;

    priceCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    setMeta("pokt_price_usd", JSON.stringify({ value, updatedAt: new Date().toISOString() }));
    return value;
  } catch {
    if (cachedMeta) {
      try {
        const parsed = JSON.parse(cachedMeta) as { value: number };
        return parsed.value;
      } catch {
        return 0;
      }
    }

    return 0;
  }
}

async function extractFinalizeBlockEventsFromRpc(rpcUrl: string, path: string): Promise<RpcEvent[]> {
  const response = await fetch(buildRpcUrl(rpcUrl, path), {
    headers: {
      accept: "application/json"
    },
    cache: "no-store",
    signal: AbortSignal.timeout(BLOCK_RESULTS_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${rpcUrl}${path}: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error(`Readable stream missing for ${rpcUrl}${path}`);
  }

  const marker = '"finalize_block_events":';
  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  let buffer = "";
  let started = false;
  let arrayStarted = false;
  let captured = "";
  let depth = 0;
  let inString = false;
  let escaped = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    if (!started) {
      const markerIndex = buffer.indexOf(marker);
      if (markerIndex === -1) {
        buffer = buffer.slice(Math.max(0, buffer.length - marker.length));
        continue;
      }

      started = true;
      buffer = buffer.slice(markerIndex + marker.length);
    }

    for (let index = 0; index < buffer.length; index += 1) {
      const char = buffer[index];

      if (!arrayStarted) {
        if (char === "[") {
          arrayStarted = true;
          depth = 1;
          captured = "[";
        }
        continue;
      }

      captured += char;

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === "[") depth += 1;
      if (char === "]") depth -= 1;

      if (depth === 0) {
        return JSON.parse(captured) as RpcEvent[];
      }
    }

    buffer = arrayStarted ? "" : buffer;
  }

  throw new Error(`Unable to extract finalize_block_events from ${rpcUrl}${path}`);
}

async function extractFinalizeBlockEventsFromRpcPool(path: string, seed: number): Promise<RpcEvent[]> {
  const candidates = getRpcCandidates(seed);
  let lastError: unknown;

  for (const rpcUrl of candidates) {
    try {
      return await extractFinalizeBlockEventsFromRpc(rpcUrl, path);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`All RPC block_results requests failed for path ${path}`);
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

function normalizeAttributeValue(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return JSON.parse(value) as string;
  }

  return value;
}

function parseUpokt(value: string): bigint {
  const normalized = normalizeAttributeValue(value);
  const match = normalized.match(/^(-?\d+)upokt$/);

  if (!match) {
    throw new Error(`Unexpected coin value: ${value}`);
  }

  return BigInt(match[1]);
}

function parseInteger(value: string): number {
  return Number(normalizeAttributeValue(value));
}

function buildAttributeMap(event: RpcEvent): Record<string, string> {
  return Object.fromEntries(event.attributes.map((attribute) => [attribute.key, attribute.value]));
}

function toTitleCase(input: string): string {
  return input
    .split(/[-.]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getProviderLabel(providerKey: string): string {
  return PROVIDER_DOMAIN_LABEL_OVERRIDES[providerKey] ?? toTitleCase(providerKey.split(".")[0] ?? providerKey);
}

function getHostname(url: string): string | null {
  const normalized = url.includes("://") ? url : `https://${url}`;

  try {
    return new URL(normalized).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

function isIpv4(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function getRegistrableDomain(hostname: string): string {
  if (hostname === "localhost" || isIpv4(hostname)) {
    return hostname;
  }

  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2) {
    return hostname;
  }

  const suffix = labels.slice(-2).join(".");
  if (SECOND_LEVEL_SUFFIXES.has(suffix) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }

  return labels.slice(-2).join(".");
}

function deriveProviderIdentity(operatorAddress: string, ownerAddress: string, endpointUrls: string[]): SupplierDirectoryEntry {
  const override = SUPPLIER_PROVIDER_OVERRIDES[operatorAddress];
  if (override) {
    return {
      operatorAddress,
      ownerAddress,
      providerKey: override.providerKey,
      providerLabel: override.providerLabel ?? PROVIDER_DOMAIN_LABEL_OVERRIDES[override.providerKey] ?? override.providerKey,
      providerDomain: override.providerDomain ?? override.providerKey
    };
  }

  const domainFrequency = new Map<string, number>();
  for (const endpointUrl of endpointUrls) {
    const hostname = getHostname(endpointUrl);
    if (!hostname) continue;
    const domain = getRegistrableDomain(hostname);
    domainFrequency.set(domain, (domainFrequency.get(domain) ?? 0) + 1);
  }

  const topDomain = Array.from(domainFrequency.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (topDomain) {
    return {
      operatorAddress,
      ownerAddress,
      providerKey: topDomain,
      providerLabel: getProviderLabel(topDomain),
      providerDomain: topDomain
    };
  }

  return {
    operatorAddress,
    ownerAddress,
    providerKey: `owner:${ownerAddress}`,
    providerLabel: `Owner ${ownerAddress.slice(0, 8)}`,
    providerDomain: ownerAddress
  };
}

function getWindowStart(window: TimeWindow): Date {
  const now = Date.now();

  switch (window) {
    case "24h":
      return new Date(now - 24 * 60 * 60 * 1000);
    case "7d":
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
    case "30d":
      return new Date(now - 30 * 24 * 60 * 60 * 1000);
    case "365d":
      return new Date(now - 365 * 24 * 60 * 60 * 1000);
  }
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function parseNumeric(value: string | number | null | undefined): number {
  if (value == null) return 0;
  return Number(value);
}

function parseOptionalPositiveNumber(value: string | number | null | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNumericBigInt(value: string | number | null | undefined): bigint {
  if (value == null) return 0n;
  if (typeof value === "number") {
    return BigInt(Math.trunc(value));
  }

  const normalized = value.includes(".") ? value.split(".")[0] ?? "0" : value;
  return BigInt(normalized || "0");
}

function summarizeRevShare(entries: SupplierRevShare[] | undefined, ownerAddress: string, operatorAddress: string): {
  operatorRevSharePercent?: number;
  ownerRevSharePercent?: number;
  otherRevSharePercent?: number;
} {
  if (!entries || entries.length === 0) {
    return {};
  }

  let operatorRevSharePercent = 0;
  let ownerRevSharePercent = 0;
  let otherRevSharePercent = 0;

  for (const entry of entries) {
    if (!entry?.address) continue;
    const share = parseNumeric(entry.rev_share_percentage);
    if (!Number.isFinite(share) || share <= 0) continue;

    if (entry.address === operatorAddress) {
      operatorRevSharePercent += share;
      continue;
    }

    if (entry.address === ownerAddress) {
      ownerRevSharePercent += share;
      continue;
    }

    otherRevSharePercent += share;
  }

  return {
    operatorRevSharePercent: operatorRevSharePercent > 0 ? operatorRevSharePercent : undefined,
    ownerRevSharePercent: ownerRevSharePercent > 0 ? ownerRevSharePercent : undefined,
    otherRevSharePercent: otherRevSharePercent > 0 ? otherRevSharePercent : undefined
  };
}

function serializeDashboardData(data: DashboardData): SerializedDashboardCache {
  return {
    ...data,
    totalRevenueUpokt: data.totalRevenueUpokt.toString(),
    providers: data.providers.map((provider) => ({
      ...provider,
      revenueUpokt: provider.revenueUpokt.toString(),
      suppliers: provider.suppliers.map((supplier) => ({
        ...supplier,
        revenueUpokt: supplier.revenueUpokt?.toString(),
        stakeUpokt: supplier.stakeUpokt?.toString()
      })),
      chains: provider.chains.map((chain) => ({
        ...chain,
        revenueUpokt: chain.revenueUpokt.toString()
      }))
    })),
    services: data.services.map((service) => ({
      ...service,
      revenueUpokt: service.revenueUpokt.toString()
    }))
  };
}

function getSettlementHeightsCacheKey(window: TimeWindow): string {
  return `settlement_heights:${window}`;
}

function getCachedSettlementHeights(window: TimeWindow): Array<{ height: number; time: string }> {
  const cached = getMeta(getSettlementHeightsCacheKey(window));
  if (!cached) {
    return [];
  }

  try {
    const parsed = JSON.parse(cached) as Array<{ height: number; time: string }>;
    return parsed.filter((entry) => Number.isFinite(entry.height) && typeof entry.time === "string");
  } catch {
    return [];
  }
}

function setCachedSettlementHeights(window: TimeWindow, blocks: Array<{ height: number; time: string }>): void {
  setMeta(getSettlementHeightsCacheKey(window), JSON.stringify(blocks));
}

function deserializeDashboardData(data: SerializedDashboardCache): DashboardData {
  return {
    ...data,
    totalRevenueUpokt: BigInt(data.totalRevenueUpokt),
    providers: data.providers.map((provider) => ({
      ...provider,
      revenueUpokt: BigInt(provider.revenueUpokt),
      suppliers: provider.suppliers.map((supplier) => ({
        ...supplier,
        revenueUpokt: supplier.revenueUpokt ? BigInt(supplier.revenueUpokt) : undefined,
        stakeUpokt: supplier.stakeUpokt ? BigInt(supplier.stakeUpokt) : undefined
      })),
      chains: provider.chains.map((chain) => ({
        ...chain,
        revenueUpokt: BigInt(chain.revenueUpokt)
      }))
    })),
    services: data.services.map((service) => ({
      ...service,
      revenueUpokt: BigInt(service.revenueUpokt)
    }))
  };
}

function getProviderDataCache<T>(key: string): T | null {
  const cached = getMeta(key);
  if (!cached) {
    return null;
  }

  try {
    const parsed = JSON.parse(cached) as ProviderDataCache<T>;
    if (Date.now() - new Date(parsed.updatedAt).getTime() > CACHE_TTL_MS) {
      return null;
    }

    return parsed.data;
  } catch {
    return null;
  }
}

function getProviderDataSnapshot<T>(key: string): T | null {
  const cached = getMeta(key);
  if (!cached) {
    return null;
  }

  try {
    return (JSON.parse(cached) as ProviderDataCache<T>).data;
  } catch {
    return null;
  }
}

function setProviderDataCache<T>(key: string, data: T): void {
  setMeta(key, JSON.stringify({ updatedAt: new Date().toISOString(), data } satisfies ProviderDataCache<T>));
}

function getProviderDailyHistoryCacheKey(providerKey: string, days: number): string {
  return `provider_daily_history:${providerKey}:${days}`;
}

function getProviderSupplierBreakdownCacheKey(providerKey: string, window: TimeWindow): string {
  return `provider_supplier_breakdown:${providerKey}:${window}`;
}

function getNetworkDailyHistoryCacheKey(days: number): string {
  return `network_daily_history:${days}`;
}

function getPoktscanClaimAggregatesCacheKey(window: TimeWindow): string {
  return `poktscan_claim_aggregates:${window}`;
}

function getServiceDailyHistoryCacheKey(serviceId: string, days: number): string {
  return `service_daily_history:${serviceId}:${days}`;
}

function serializeProviderDailyHistory(points: ProviderDailyHistoryPoint[]): ProviderDailyHistoryCacheEntry[] {
  return points.map((point) => ({
    ...point,
    revenueUpokt: point.revenueUpokt.toString()
  }));
}

function deserializeProviderDailyHistory(points: ProviderDailyHistoryCacheEntry[]): ProviderDailyHistoryPoint[] {
  return points.map((point) => ({
    ...point,
    revenueUpokt: BigInt(point.revenueUpokt)
  }));
}

function serializeSupplierMembers(suppliers: SupplierMember[]): SupplierMemberCacheEntry[] {
  return suppliers.map((supplier) => ({
    ...supplier,
    revenueUpokt: supplier.revenueUpokt?.toString(),
    stakeUpokt: supplier.stakeUpokt?.toString()
  }));
}

function deserializeSupplierMembers(suppliers: SupplierMemberCacheEntry[]): SupplierMember[] {
  return suppliers.map((supplier) => ({
    ...supplier,
    revenueUpokt: supplier.revenueUpokt ? BigInt(supplier.revenueUpokt) : undefined,
    stakeUpokt: supplier.stakeUpokt ? BigInt(supplier.stakeUpokt) : undefined
  }));
}

function serializeNetworkDailyHistory(points: NetworkDailyHistoryPoint[]): NetworkDailyHistoryCacheEntry[] {
  return points.map((point) => ({
    ...point,
    revenueUpokt: point.revenueUpokt.toString()
  }));
}

function deserializeNetworkDailyHistory(points: NetworkDailyHistoryCacheEntry[]): NetworkDailyHistoryPoint[] {
  return points.map((point) => ({
    ...point,
    revenueUpokt: BigInt(point.revenueUpokt)
  }));
}

function getNetworkDailyHistorySnapshot(days = PROVIDER_HISTORY_DAYS): NetworkDailyHistoryPoint[] {
  const cached = getProviderDataSnapshot<NetworkDailyHistoryCacheEntry[]>(getNetworkDailyHistoryCacheKey(days));
  return cached ? deserializeNetworkDailyHistory(cached) : [];
}

function getProviderDailyHistorySnapshot(providerKey: string, days = PROVIDER_HISTORY_DAYS): ProviderDailyHistoryPoint[] {
  const cached = getProviderDataSnapshot<ProviderDailyHistoryCacheEntry[]>(getProviderDailyHistoryCacheKey(providerKey, days));
  return cached ? deserializeProviderDailyHistory(cached) : [];
}

function getProviderSupplierBreakdownSnapshot(providerKey: string, window: TimeWindow): SupplierMember[] {
  const cached = getProviderDataSnapshot<SupplierMemberCacheEntry[]>(getProviderSupplierBreakdownCacheKey(providerKey, window));
  return cached ? deserializeSupplierMembers(cached) : [];
}

function getServiceDailyHistorySnapshot(serviceId: string, days = PROVIDER_HISTORY_DAYS): ServiceDailyHistoryPoint[] {
  const cached = getProviderDataSnapshot<NetworkDailyHistoryCacheEntry[]>(getServiceDailyHistoryCacheKey(serviceId, days));
  return cached ? deserializeNetworkDailyHistory(cached) : [];
}

function serializeSupplierDirectory(directory: SupplierDirectory): Record<string, SupplierDirectoryCacheEntry> {
  return Object.fromEntries(
    Object.entries(directory).map(([operatorAddress, supplier]) => [
      operatorAddress,
      {
        ...supplier,
        stakeUpokt: supplier.stakeUpokt?.toString()
      }
    ])
  );
}

function deserializeSupplierDirectory(directory: Record<string, SupplierDirectoryCacheEntry>): SupplierDirectory {
  return Object.fromEntries(
    Object.entries(directory).map(([operatorAddress, supplier]) => [
      operatorAddress,
      {
        ...supplier,
        stakeUpokt: supplier.stakeUpokt ? BigInt(supplier.stakeUpokt) : undefined
      }
    ])
  );
}

function getCachedPoktscanSupplierDirectory(): SupplierDirectory | null {
  const cached = getMeta("poktscan_supplier_directory");
  if (!cached) {
    return null;
  }

  try {
    const parsed = JSON.parse(cached) as SupplierDirectoryCachePayload;
    if (Date.now() - new Date(parsed.updatedAt).getTime() > SUPPLIER_DIRECTORY_CACHE_TTL_MS) {
      return null;
    }

    return deserializeSupplierDirectory(parsed.data);
  } catch (error) {
    logDataError("Unable to read cached Poktscan supplier directory", error);
    return null;
  }
}

function setCachedPoktscanSupplierDirectory(directory: SupplierDirectory): void {
  setMeta("poktscan_supplier_directory", JSON.stringify({
    updatedAt: new Date().toISOString(),
    data: serializeSupplierDirectory(directory)
  } satisfies SupplierDirectoryCachePayload));
}

function hasServiceSupplierCounts(data: DashboardData | null | undefined): data is DashboardData {
  if (!data) return false;
  return data.services.every((service) => typeof service.supplierCount === "number");
}

function hydrateDashboardCache(window: TimeWindow): DashboardData | null {
  const persisted = getDashboardCache(window);
  if (!persisted) {
    return null;
  }

  try {
    const data = deserializeDashboardData(JSON.parse(persisted.payloadJson) as SerializedDashboardCache);
    if (!hasServiceSupplierCounts(data)) {
      return null;
    }
    dashboardCache.set(window, {
      data,
      expiresAt: Date.now() + UI_MEMORY_CACHE_TTL_MS
    });
    return data;
  } catch {
    return null;
  }
}

function persistDashboard(window: TimeWindow, data: DashboardData): DashboardData {
  dashboardCache.set(window, {
    expiresAt: Date.now() + UI_MEMORY_CACHE_TTL_MS,
    data
  });
  setDashboardCache(window, JSON.stringify(serializeDashboardData(data)));
  return data;
}

function getCachedDashboardSnapshot(window: TimeWindow): DashboardData | null {
  const cached = dashboardCache.get(window);
  if (cached && cached.expiresAt > Date.now() && hasServiceSupplierCounts(cached.data)) {
    return cached.data;
  }

  return hydrateDashboardCache(window);
}

async function getStatus(): Promise<{ latestHeight: number }> {
  const data = await fetchJsonFromRpcPool<StatusResponse>("/status", { parallel: true, timeoutMs: DEFAULT_RPC_TIMEOUT_MS });
  const latestHeight = Number(data.result?.sync_info?.latest_block_height ?? 0);

  if (!latestHeight) {
    throw new Error("Unable to read latest block height from Pocket RPC status");
  }

  return { latestHeight };
}

const getServiceMap = cache(async (): Promise<ServiceMap> => {
  const services: ServiceMap = {};
  let nextKey = "";

  while (true) {
    const search = new URLSearchParams({
      dehydrated: "true",
      "pagination.limit": "250"
    });

    if (nextKey) {
      search.set("pagination.key", nextKey);
    }

    const response = await fetchJson<ServicesResponse>(`${DEFAULT_REST_URL}${SERVICES_PATH}?${search.toString()}`);

    for (const service of response.service ?? []) {
      services[service.id] = {
        name: service.name || service.id,
        computeUnitsPerRelay: parseOptionalPositiveNumber(service.compute_units_per_relay ?? service.computeUnitsPerRelay)
      };
    }

    nextKey = response.pagination?.next_key ?? "";
    if (!nextKey) break;
  }

  return services;
});

const getSupplierDirectory = cache(async (): Promise<SupplierDirectory> => {
  const directory: SupplierDirectory = {};
  let nextKey = "";

  while (true) {
    const search = new URLSearchParams({
      dehydrated: "false",
      "pagination.limit": "200"
    });

    if (nextKey) {
      search.set("pagination.key", nextKey);
    }

    const response = await fetchJson<SuppliersResponse>(`${DEFAULT_REST_URL}${SUPPLIERS_PATH}?${search.toString()}`);

    for (const supplier of response.supplier ?? []) {
      const endpointUrls = (supplier.services ?? []).flatMap((service) => (service.endpoints ?? []).map((endpoint) => endpoint.url));
      const activeServices = supplier.services ?? [];
      const serviceCount = new Set(
        activeServices
          .map((service) => service.service_id)
          .filter((serviceId): serviceId is string => Boolean(serviceId))
      ).size;
      const revShareSummaries = activeServices.map((service) => summarizeRevShare(service.rev_share, supplier.owner_address, supplier.operator_address));
      const revShareCount = revShareSummaries.length || 1;
      const baseIdentity = deriveProviderIdentity(
        supplier.operator_address,
        supplier.owner_address,
        endpointUrls
      );

      directory[supplier.operator_address] = {
        ...baseIdentity,
        stakeUpokt: parseNumericBigInt(supplier.stake?.amount),
        serviceCount,
        operatorRevSharePercent: revShareSummaries.reduce((sum, summary) => sum + (summary.operatorRevSharePercent ?? 0), 0) / revShareCount,
        ownerRevSharePercent: revShareSummaries.reduce((sum, summary) => sum + (summary.ownerRevSharePercent ?? 0), 0) / revShareCount,
        otherRevSharePercent: revShareSummaries.reduce((sum, summary) => sum + (summary.otherRevSharePercent ?? 0), 0) / revShareCount
      };
    }

    nextKey = response.pagination?.next_key ?? "";
    if (!nextKey) break;
  }

  return directory;
});

const SERVICE_SUPPLIER_COUNTS_TTL_MS = 6 * 60 * 60 * 1000;
let serviceSupplierCountsCache: { value: ServiceSupplierCounts; fetchedAt: string } | null = null;

const getServiceSupplierCounts = async (): Promise<ServiceSupplierCounts> => {
  if (serviceSupplierCountsCache && Date.now() - new Date(serviceSupplierCountsCache.fetchedAt).getTime() < SERVICE_SUPPLIER_COUNTS_TTL_MS) {
    return serviceSupplierCountsCache.value;
  }
  const counts: ServiceSupplierCounts = {};
  let nextKey = "";

  while (true) {
    const search = new URLSearchParams({
      dehydrated: "false",
      "pagination.limit": "200"
    });

    if (nextKey) {
      search.set("pagination.key", nextKey);
    }

    const response = await fetchJson<SuppliersResponse>(`${DEFAULT_REST_URL}${SUPPLIERS_PATH}?${search.toString()}`);

    for (const supplier of response.supplier ?? []) {
      const activeServiceIds = new Set(
        (supplier.services ?? [])
          .map((service) => service.service_id)
          .filter((serviceId): serviceId is string => Boolean(serviceId))
      );

      for (const serviceId of activeServiceIds) {
        counts[serviceId] = (counts[serviceId] ?? 0) + 1;
      }
    }

    nextKey = response.pagination?.next_key ?? "";
    if (!nextKey) break;
  }

  serviceSupplierCountsCache = { value: counts, fetchedAt: new Date().toISOString() };
  return counts;
};

const getPoktscanSupplierDirectory = cache(async (): Promise<SupplierDirectory> => {
  const cached = getCachedPoktscanSupplierDirectory();
  if (cached) {
    logDataInfo("Poktscan supplier directory served from persistent cache", { supplierCount: Object.keys(cached).length });
    return cached;
  }

  const directory: SupplierDirectory = {};
  const restDirectory = await getSupplierDirectory();
  let offset = 0;
  logDataInfo("Starting Poktscan supplier directory load", { restSupplierCount: Object.keys(restDirectory).length });

  while (true) {
    const response = await fetchPoktscan<PoktscanSuppliersResponse>(
      `query PoktscanSuppliers($offset: Int!) {
        suppliers(first: 200, offset: $offset) {
          nodes {
            id
            ownerId
            operatorId
            serviceConfigs(first: 100) {
              nodes {
                domains
                endpoints
              }
            }
          }
        }
      }`,
      { offset }
    );

    const nodes = response.data?.suppliers?.nodes ?? [];
    logDataInfo("Poktscan supplier directory page received", {
      offset,
      nodeCount: nodes.length
    });
    if (nodes.length === 0) {
      break;
    }

    for (const supplier of nodes) {
      if (!supplier) continue;

      const restEntry = restDirectory[supplier.operatorId];

      const domains = (supplier.serviceConfigs?.nodes ?? []).flatMap((config) => config?.domains ?? []);
      const endpointUrls = (supplier.serviceConfigs?.nodes ?? []).flatMap((config) =>
        (config?.endpoints ?? []).flatMap((endpoint) => (endpoint?.url ? [endpoint.url] : []))
      );
      const uniqueDomains = Array.from(
        new Set(domains.filter((domain): domain is string => Boolean(domain)).map((domain) => domain.toLowerCase()))
      );

      if (uniqueDomains.length > 0) {
        const providerKey = uniqueDomains[0];
        directory[supplier.operatorId] = {
          operatorAddress: supplier.operatorId,
          ownerAddress: supplier.ownerId,
          providerKey,
          providerLabel: getProviderLabel(providerKey),
          providerDomain: providerKey,
          stakeUpokt: restEntry?.stakeUpokt,
          serviceCount: restEntry?.serviceCount,
          operatorRevSharePercent: restEntry?.operatorRevSharePercent,
          ownerRevSharePercent: restEntry?.ownerRevSharePercent,
          otherRevSharePercent: restEntry?.otherRevSharePercent
        };
        continue;
      }

      directory[supplier.operatorId] = {
        ...deriveProviderIdentity(supplier.operatorId, supplier.ownerId, endpointUrls),
        stakeUpokt: restEntry?.stakeUpokt,
        serviceCount: restEntry?.serviceCount,
        operatorRevSharePercent: restEntry?.operatorRevSharePercent,
        ownerRevSharePercent: restEntry?.ownerRevSharePercent,
        otherRevSharePercent: restEntry?.otherRevSharePercent
      };
    }

    offset += nodes.length;
  }

  for (const [operatorAddress, supplier] of Object.entries(restDirectory)) {
    if (!directory[operatorAddress]) {
      directory[operatorAddress] = supplier;
    }
  }

  logDataInfo("Poktscan supplier directory load completed", { supplierCount: Object.keys(directory).length });
  setCachedPoktscanSupplierDirectory(directory);
  return directory;
});

async function getFinalizeEvents(height: number): Promise<RpcEvent[]> {
  return extractFinalizeBlockEventsFromRpcPool(`/block_results?height=${height}`, height);
}

async function getRecentSettlementBlocks(window: TimeWindow, limit: number): Promise<Array<{ height: number; time: string }>> {
  const blocks: Array<{ height: number; time: string }> = [];
  let page = 1;

  try {
    while (blocks.length < limit) {
      const search = new URLSearchParams({
        query: `"${SETTLEMENT_MODE_QUERY}"`,
        page: String(page),
        per_page: "50",
        order_by: '"desc"'
      });

      const response = await fetchJsonFromRpcPool<BlockSearchResponse>(`/block_search?${search.toString()}`, {
        seed: page,
        timeoutMs: BLOCK_SEARCH_TIMEOUT_MS,
        parallel: true
      });
      const pageBlocks = response.result?.blocks ?? [];

      if (pageBlocks.length === 0) {
        break;
      }

      for (const entry of pageBlocks) {
        const height = Number(entry.block?.header?.height ?? 0);
        const time = entry.block?.header?.time ?? "";
        if (!height || !time) continue;
        blocks.push({ height, time });
        if (blocks.length >= limit) break;
      }

      page += 1;
    }

    if (blocks.length > 0) {
      setCachedSettlementHeights(window, blocks);
    }

    return blocks;
  } catch {
    const cachedBlocks = getCachedSettlementHeights(window);
    if (cachedBlocks.length > 0) {
      return cachedBlocks.slice(0, limit);
    }

    throw new Error(`Unable to load settlement blocks for ${window}`);
  }
}

function parseSettlementEvent(event: RpcEvent, blockHeight: number, blockTime: string, serviceMap: ServiceMap): SettlementEvent {
  const attributes = buildAttributeMap(event);
  const serviceId = normalizeAttributeValue(attributes.service_id);
  const rewardDetails = JSON.parse(attributes.reward_distribution_detailed) as RewardDistributionDetail[];
  const supplierRevenueUpokt = rewardDetails.reduce((sum, detail) => {
    if (!SUPPLIER_REWARD_REASONS.has(detail.op_reason)) return sum;
    return sum + parseUpokt(detail.amount);
  }, 0n);

  return {
    blockHeight,
    blockTime,
    serviceId,
    serviceName: serviceMap[serviceId]?.name ?? serviceId,
    computeUnitsPerRelay: serviceMap[serviceId]?.computeUnitsPerRelay,
    supplierOperatorAddress: normalizeAttributeValue(attributes.supplier_operator_address),
    supplierOwnerAddress: normalizeAttributeValue(attributes.supplier_owner_address),
    numRelays: parseInteger(attributes.num_relays),
    supplierRevenueUpokt
  };
}

function buildDashboardFromProviderRows(
  window: TimeWindow,
  latestHeight: number,
  rows: ProviderAggregateRow[],
  serviceSupplierCounts: ServiceSupplierCounts,
  supplierDirectory: SupplierDirectory,
  poktPriceUsd: number,
  options?: {
    dataSource?: "poktscan" | "rpc";
    indexerProcessedHeight?: number;
    indexerTargetHeight?: number;
    earliestSettlementTime?: string | null;
    latestSettlementTime?: string | null;
    suppliersPerSession?: number;
    appsStakedByService?: Record<string, number>;
    sessionObservedHeight?: number;
    sessionFetchedAt?: string;
    sessionStale?: boolean;
  }
): DashboardData {
  const providerMap = new Map<string, ProviderStats>();
  const serviceMap = new Map<string, ServiceStats>();
  const historicalSupplierSets = new Map<string, Set<string>>();
  const supplierChainMap = new Map<string, Set<string>>();
  let totalRelays = 0;
  let totalRevenueUpokt = 0n;

  for (const row of rows) {
    totalRelays += row.relays;
    totalRevenueUpokt += row.revenueUpokt;

    const provider = providerMap.get(row.providerKey) ?? {
      providerKey: row.providerKey,
      providerLabel: row.providerLabel,
      providerDomain: row.providerDomain,
      relays: 0,
      revenueUpokt: 0n,
      chainCount: 0,
      supplierCount: 0,
      suppliers: [],
      chains: []
    };

    provider.relays += row.relays;
    provider.revenueUpokt += row.revenueUpokt;

    if (row.supplierOperatorAddress && row.supplierOwnerAddress) {
      const historicalSuppliers = historicalSupplierSets.get(row.serviceId) ?? new Set<string>();
      historicalSuppliers.add(row.supplierOperatorAddress);
      historicalSupplierSets.set(row.serviceId, historicalSuppliers);
      const supplier = provider.suppliers.find((entry) => entry.operatorAddress === row.supplierOperatorAddress) ?? {
        operatorAddress: row.supplierOperatorAddress,
        ownerAddress: row.supplierOwnerAddress,
        domain: row.providerDomain,
        relays: 0,
        revenueUpokt: 0n,
        stakeUpokt: supplierDirectory[row.supplierOperatorAddress]?.stakeUpokt,
        chainCount: 0,
        serviceCount: supplierDirectory[row.supplierOperatorAddress]?.serviceCount,
        operatorRevSharePercent: supplierDirectory[row.supplierOperatorAddress]?.operatorRevSharePercent,
        ownerRevSharePercent: supplierDirectory[row.supplierOperatorAddress]?.ownerRevSharePercent,
        otherRevSharePercent: supplierDirectory[row.supplierOperatorAddress]?.otherRevSharePercent,
        detailAvailable: true
      };

      if (!provider.suppliers.includes(supplier)) {
        provider.suppliers.push(supplier);
        provider.supplierCount = provider.suppliers.length;
      }

      supplier.relays = (supplier.relays ?? 0) + row.relays;
      supplier.revenueUpokt = (supplier.revenueUpokt ?? 0n) + row.revenueUpokt;
      supplier.detailAvailable = true;

      const supplierKey = `${provider.providerKey}:${row.supplierOperatorAddress}`;
      const chains = supplierChainMap.get(supplierKey) ?? new Set<string>();
      chains.add(row.serviceId);
      supplierChainMap.set(supplierKey, chains);
    }

    let chain = provider.chains.find((entry) => entry.serviceId === row.serviceId);
    if (!chain) {
      chain = {
        serviceId: row.serviceId,
        serviceName: row.serviceName,
        relays: 0,
        computeUnitsPerRelay: row.computeUnitsPerRelay,
        computeUnits: 0,
        revenueUpokt: 0n
      };
      provider.chains.push(chain);
    }

    chain.relays += row.relays;
    chain.computeUnitsPerRelay = chain.computeUnitsPerRelay ?? row.computeUnitsPerRelay;
    if (row.computeUnitsPerRelay) {
      chain.computeUnits = (chain.computeUnits ?? 0) + row.relays * row.computeUnitsPerRelay;
    }
    chain.revenueUpokt += row.revenueUpokt;
    provider.chainCount = provider.chains.length;
    providerMap.set(row.providerKey, provider);

    const service = serviceMap.get(row.serviceId) ?? {
      serviceId: row.serviceId,
      serviceName: row.serviceName,
      relays: 0,
      computeUnitsPerRelay: row.computeUnitsPerRelay,
      computeUnits: 0,
      revenueUpokt: 0n,
      providerCount: 0
    };

    service.relays += row.relays;
    service.computeUnitsPerRelay = service.computeUnitsPerRelay ?? row.computeUnitsPerRelay;
    if (row.computeUnitsPerRelay) {
      service.computeUnits = (service.computeUnits ?? 0) + row.relays * row.computeUnitsPerRelay;
    }
    service.revenueUpokt += row.revenueUpokt;
    serviceMap.set(row.serviceId, service);
  }

  for (const supplier of Object.values(supplierDirectory)) {
    const provider = providerMap.get(supplier.providerKey);
    if (!provider) continue;

    if (provider.suppliers.some((entry) => entry.operatorAddress === supplier.operatorAddress)) {
      continue;
    }

    provider.suppliers.push({
      operatorAddress: supplier.operatorAddress,
      ownerAddress: supplier.ownerAddress,
      domain: supplier.providerDomain,
      stakeUpokt: supplier.stakeUpokt,
      serviceCount: supplier.serviceCount,
      operatorRevSharePercent: supplier.operatorRevSharePercent,
      ownerRevSharePercent: supplier.ownerRevSharePercent,
      otherRevSharePercent: supplier.otherRevSharePercent,
      detailAvailable: false
    });
    provider.supplierCount = provider.suppliers.length;
  }

  const providers = Array.from(providerMap.values())
    .map((provider) => ({
      ...provider,
      supplierCount: provider.suppliers.length,
      suppliers: provider.suppliers
        .map((supplier) => ({
          ...supplier,
          chainCount: supplier.detailAvailable ? supplierChainMap.get(`${provider.providerKey}:${supplier.operatorAddress}`)?.size ?? 0 : supplier.chainCount
        }))
        .sort((a, b) => (b.revenueUpokt ?? 0n) === (a.revenueUpokt ?? 0n) ? a.operatorAddress.localeCompare(b.operatorAddress) : (b.revenueUpokt ?? 0n) > (a.revenueUpokt ?? 0n) ? 1 : -1),
      chains: provider.chains.sort((a, b) =>
        b.revenueUpokt === a.revenueUpokt ? b.relays - a.relays : b.revenueUpokt > a.revenueUpokt ? 1 : -1
      )
    }))
    .sort((a, b) => (b.revenueUpokt === a.revenueUpokt ? b.relays - a.relays : b.revenueUpokt > a.revenueUpokt ? 1 : -1));

  for (const service of serviceMap.values()) {
    service.providerCount = providers.filter((provider) => provider.chains.some((chain) => chain.serviceId === service.serviceId)).length;
    service.supplierCount = historicalSupplierSets.get(service.serviceId)?.size ?? 0;
    service.eligibleSupplierCount = serviceSupplierCounts[service.serviceId] ?? 0;
    service.eligibleSupplierCountFetchedAt = serviceSupplierCountsCache?.fetchedAt;
  }

  const services = Array.from(serviceMap.values()).sort((a, b) =>
    b.revenueUpokt === a.revenueUpokt ? b.relays - a.relays : b.revenueUpokt > a.revenueUpokt ? 1 : -1
  );

  return {
    window,
    generatedAt: new Date().toISOString(),
    dataSource: options?.dataSource ?? "rpc",
    poktPriceUsd,
    latestHeight,
    indexerProcessedHeight: options?.indexerProcessedHeight,
    indexerTargetHeight: options?.indexerTargetHeight,
    scannedHeights: 0,
    scannedSettlementHeights: 0,
    settlementEvents: 0,
    earliestSettlementTime: options?.earliestSettlementTime ?? null,
    latestSettlementTime: options?.latestSettlementTime ?? null,
    totalRelays,
    totalEstimatedRelays: totalRelays,
    totalEstimatedComputeUnits: 0,
    relayCoverage: 0,
    computeUnitCoverage: 0,
    totalRevenueUpokt,
    activeProviders: providers.filter((provider) => provider.relays > 0).length,
    activeChains: services.length,
    suppliersPerSession: options?.suppliersPerSession ?? SESSION_SUPPLIER_SLOTS,
    appsStakedByService: options?.appsStakedByService ?? {},
    sessionObservedHeight: options?.sessionObservedHeight ?? 0,
    sessionFetchedAt: options?.sessionFetchedAt ?? "",
    sessionStale: options?.sessionStale ?? true,
    providers,
    services
  };
}

function buildDashboard(
  window: TimeWindow,
  latestHeight: number,
  settlements: SettlementEvent[],
  serviceSupplierCounts: ServiceSupplierCounts,
  supplierDirectory: SupplierDirectory,
  poktPriceUsd: number,
  sessionData?: {
    suppliersPerSession?: number;
    appsStakedByService?: Record<string, number>;
    sessionObservedHeight?: number;
    sessionFetchedAt?: string;
    sessionStale?: boolean;
  }
): DashboardData {
  const providerMap = new Map<string, ProviderStats>();
  const serviceMap = new Map<string, ServiceStats>();
  const historicalSupplierSets = new Map<string, Set<string>>();
  const supplierChainMap = new Map<string, Set<string>>();
  let totalRelays = 0;
  let totalRevenueUpokt = 0n;

  for (const settlement of settlements) {
    const historicalSuppliers = historicalSupplierSets.get(settlement.serviceId) ?? new Set<string>();
    historicalSuppliers.add(settlement.supplierOperatorAddress);
    historicalSupplierSets.set(settlement.serviceId, historicalSuppliers);
    totalRelays += settlement.numRelays;
    totalRevenueUpokt += settlement.supplierRevenueUpokt;

    const supplierInfo = supplierDirectory[settlement.supplierOperatorAddress] ?? {
      operatorAddress: settlement.supplierOperatorAddress,
      ownerAddress: settlement.supplierOwnerAddress,
      providerKey: `owner:${settlement.supplierOwnerAddress}`,
      providerLabel: `Owner ${settlement.supplierOwnerAddress.slice(0, 8)}`,
      providerDomain: settlement.supplierOwnerAddress
    };

    const provider = providerMap.get(supplierInfo.providerKey) ?? {
      providerKey: supplierInfo.providerKey,
      providerLabel: supplierInfo.providerLabel,
      providerDomain: supplierInfo.providerDomain,
      relays: 0,
      revenueUpokt: 0n,
      chainCount: 0,
      supplierCount: 0,
      suppliers: [],
      chains: []
    };

    provider.relays += settlement.numRelays;
    provider.revenueUpokt += settlement.supplierRevenueUpokt;

    if (!provider.suppliers.some((supplier) => supplier.operatorAddress === settlement.supplierOperatorAddress)) {
      provider.suppliers.push({
        operatorAddress: settlement.supplierOperatorAddress,
        ownerAddress: settlement.supplierOwnerAddress,
        domain: supplierInfo.providerDomain,
        relays: 0,
        revenueUpokt: 0n,
        stakeUpokt: supplierInfo.stakeUpokt,
        chainCount: 0,
        serviceCount: supplierInfo.serviceCount,
        operatorRevSharePercent: supplierInfo.operatorRevSharePercent,
        ownerRevSharePercent: supplierInfo.ownerRevSharePercent,
        otherRevSharePercent: supplierInfo.otherRevSharePercent,
        detailAvailable: true
      });
      provider.supplierCount = provider.suppliers.length;
    }

    const supplier = provider.suppliers.find((entry) => entry.operatorAddress === settlement.supplierOperatorAddress);
    if (supplier) {
      supplier.relays = (supplier.relays ?? 0) + settlement.numRelays;
      supplier.revenueUpokt = (supplier.revenueUpokt ?? 0n) + settlement.supplierRevenueUpokt;
      supplier.detailAvailable = true;

      const supplierKey = `${supplierInfo.providerKey}:${settlement.supplierOperatorAddress}`;
      const chains = supplierChainMap.get(supplierKey) ?? new Set<string>();
      chains.add(settlement.serviceId);
      supplierChainMap.set(supplierKey, chains);
    }

    let chain = provider.chains.find((entry) => entry.serviceId === settlement.serviceId);
    if (!chain) {
      chain = {
        serviceId: settlement.serviceId,
        serviceName: settlement.serviceName,
        relays: 0,
        computeUnitsPerRelay: settlement.computeUnitsPerRelay,
        computeUnits: 0,
        revenueUpokt: 0n
      };
      provider.chains.push(chain);
    }

    chain.relays += settlement.numRelays;
    chain.computeUnitsPerRelay = chain.computeUnitsPerRelay ?? settlement.computeUnitsPerRelay;
    if (settlement.computeUnitsPerRelay) {
      chain.computeUnits = (chain.computeUnits ?? 0) + settlement.numRelays * settlement.computeUnitsPerRelay;
    }
    chain.revenueUpokt += settlement.supplierRevenueUpokt;
    provider.chainCount = provider.chains.length;
    providerMap.set(supplierInfo.providerKey, provider);

    const service = serviceMap.get(settlement.serviceId) ?? {
      serviceId: settlement.serviceId,
      serviceName: settlement.serviceName,
      relays: 0,
      computeUnitsPerRelay: settlement.computeUnitsPerRelay,
      computeUnits: 0,
      revenueUpokt: 0n,
      providerCount: 0
    };

    service.relays += settlement.numRelays;
    service.computeUnitsPerRelay = service.computeUnitsPerRelay ?? settlement.computeUnitsPerRelay;
    if (settlement.computeUnitsPerRelay) {
      service.computeUnits = (service.computeUnits ?? 0) + settlement.numRelays * settlement.computeUnitsPerRelay;
    }
    service.revenueUpokt += settlement.supplierRevenueUpokt;
    serviceMap.set(settlement.serviceId, service);
  }

  const providers = Array.from(providerMap.values())
    .map((provider) => ({
      ...provider,
      supplierCount: provider.suppliers.length,
      suppliers: provider.suppliers
        .map((supplier) => ({
          ...supplier,
          chainCount: supplierChainMap.get(`${provider.providerKey}:${supplier.operatorAddress}`)?.size ?? 0
        }))
        .sort((a, b) => (b.revenueUpokt ?? 0n) === (a.revenueUpokt ?? 0n) ? a.operatorAddress.localeCompare(b.operatorAddress) : (b.revenueUpokt ?? 0n) > (a.revenueUpokt ?? 0n) ? 1 : -1),
      chains: provider.chains.sort((a, b) =>
        b.revenueUpokt === a.revenueUpokt ? b.relays - a.relays : b.revenueUpokt > a.revenueUpokt ? 1 : -1
      )
    }))
    .sort((a, b) => (b.revenueUpokt === a.revenueUpokt ? b.relays - a.relays : b.revenueUpokt > a.revenueUpokt ? 1 : -1));

  for (const service of serviceMap.values()) {
    service.providerCount = providers.filter((provider) => provider.chains.some((chain) => chain.serviceId === service.serviceId)).length;
    service.supplierCount = historicalSupplierSets.get(service.serviceId)?.size ?? 0;
    service.eligibleSupplierCount = serviceSupplierCounts[service.serviceId] ?? 0;
    service.eligibleSupplierCountFetchedAt = serviceSupplierCountsCache?.fetchedAt;
  }

  const services = Array.from(serviceMap.values()).sort((a, b) =>
    b.revenueUpokt === a.revenueUpokt ? b.relays - a.relays : b.revenueUpokt > a.revenueUpokt ? 1 : -1
  );
  const settlementTimes = settlements.map((settlement) => settlement.blockTime).sort();

  return {
    window,
    generatedAt: new Date().toISOString(),
    dataSource: "rpc",
    poktPriceUsd,
    latestHeight,
    scannedHeights: 0,
    scannedSettlementHeights: 0,
    settlementEvents: settlements.length,
    earliestSettlementTime: settlementTimes[0] ?? null,
    latestSettlementTime: settlementTimes.at(-1) ?? null,
    totalRelays,
    totalEstimatedRelays: totalRelays,
    totalEstimatedComputeUnits: 0,
    relayCoverage: 0,
    computeUnitCoverage: 0,
    totalRevenueUpokt,
    activeProviders: providers.filter((provider) => provider.relays > 0).length,
    activeChains: services.length,
    suppliersPerSession: sessionData?.suppliersPerSession ?? SESSION_SUPPLIER_SLOTS,
    appsStakedByService: sessionData?.appsStakedByService ?? {},
    sessionObservedHeight: sessionData?.sessionObservedHeight ?? 0,
    sessionFetchedAt: sessionData?.sessionFetchedAt ?? "",
    sessionStale: sessionData?.sessionStale ?? true,
    providers,
    services
  };
}

async function loadDashboardFromPoktscan(window: TimeWindow): Promise<DashboardData> {
  logDataInfo("Starting Poktscan dashboard load", { window });

  if (window === "24h") {
    const start = getWindowStart(window);
    const end = new Date();
    const [serviceMap, serviceSupplierCounts, supplierDirectory, poktPriceUsd, claimsResponse] = await Promise.all([
      getServiceMap(),
      getServiceSupplierCounts(),
      getPoktscanSupplierDirectory(),
      getPoktPriceUsd(),
      fetchPoktscan<PoktscanClaimSettledAggregatesResponse>(
        `query Poktscan24hClaims($start: Datetime!) {
          status: _metadata {
            lastProcessedHeight
            targetHeight
          }
          claims: eventClaimSettleds(
            filter: {
              block: {
                timestamp: {
                  greaterThanOrEqualTo: $start
                }
              }
            }
          ) {
            groupedAggregates(groupBy: [SUPPLIER_ID, SERVICE_ID]) {
              keys
              sum {
                claimedAmount
                numRelays
              }
            }
          }
        }`,
        {
          start: start.toISOString()
        }
      )
    ]);

    const rows: ProviderAggregateRow[] = [];
    for (const aggregate of claimsResponse.data?.claims?.groupedAggregates ?? []) {
      const supplierId = aggregate.keys?.[0];
      const serviceId = aggregate.keys?.[1];
      if (!supplierId || !serviceId) continue;

      const supplier = supplierDirectory[supplierId] ?? {
        operatorAddress: supplierId,
        ownerAddress: supplierId,
        providerKey: `owner:${supplierId}`,
        providerLabel: `Owner ${supplierId.slice(0, 8)}`,
        providerDomain: supplierId
      };

      rows.push({
        providerKey: supplier.providerKey,
        providerLabel: supplier.providerLabel,
        providerDomain: supplier.providerDomain,
        supplierOperatorAddress: supplier.operatorAddress,
        supplierOwnerAddress: supplier.ownerAddress,
        serviceId,
        serviceName: serviceMap[serviceId]?.name ?? serviceId,
        computeUnitsPerRelay: serviceMap[serviceId]?.computeUnitsPerRelay,
        relays: parseNumeric(aggregate.sum?.numRelays),
        revenueUpokt: parseNumericBigInt(aggregate.sum?.claimedAmount)
      });
    }

    logDataInfo("Poktscan 24h dashboard aggregates received", {
      window,
      aggregateCount: claimsResponse.data?.claims?.groupedAggregates?.length ?? 0,
      rowCount: rows.length,
      indexerProcessedHeight: claimsResponse.data?.status?.lastProcessedHeight ?? null,
      indexerTargetHeight: claimsResponse.data?.status?.targetHeight ?? null
    });

    const latestHeight = claimsResponse.data?.status?.targetHeight ?? claimsResponse.data?.status?.lastProcessedHeight ?? 0;
    return buildDashboardFromProviderRows(window, latestHeight, rows, serviceSupplierCounts, supplierDirectory, poktPriceUsd, {
      dataSource: "poktscan",
      indexerProcessedHeight: claimsResponse.data?.status?.lastProcessedHeight ?? undefined,
      indexerTargetHeight: claimsResponse.data?.status?.targetHeight ?? undefined,
      earliestSettlementTime: start.toISOString(),
      latestSettlementTime: end.toISOString()
    });
  }

  const start = getWindowStart(window);
  const end = new Date();
  const [serviceMap, serviceSupplierCounts, supplierDirectory, poktPriceUsd, rewardsResponse] = await Promise.all([
    getServiceMap(),
    getServiceSupplierCounts(),
    getPoktscanSupplierDirectory(),
    getPoktPriceUsd(),
    fetchPoktscan<PoktscanDomainRewardsResponse>(
      `query PoktscanDomainRewards($start: Date!, $end: Date!) {
        status: _metadata {
          lastProcessedHeight
          targetHeight
        }
        rewards: domainServiceDailyRewards(
          filter: {
            day: {
              greaterThanOrEqualTo: $start
              lessThanOrEqualTo: $end
            }
          }
        ) {
          groupedAggregates(groupBy: [DOMAIN, SERVICE_ID]) {
            keys
            sum {
              grossRewards
              relays
            }
          }
        }
      }`,
      {
        start: toIsoDate(start),
        end: toIsoDate(end)
      }
    )
  ]);

  const rows: ProviderAggregateRow[] = [];
  for (const aggregate of rewardsResponse.data?.rewards?.groupedAggregates ?? []) {
    const providerDomain = aggregate.keys?.[0];
    const serviceId = aggregate.keys?.[1];
    if (!providerDomain || !serviceId) continue;

    rows.push({
      providerKey: providerDomain,
      providerLabel: getProviderLabel(providerDomain),
      providerDomain,
      serviceId,
      serviceName: serviceMap[serviceId]?.name ?? serviceId,
      computeUnitsPerRelay: serviceMap[serviceId]?.computeUnitsPerRelay,
      relays: parseNumeric(aggregate.sum?.relays),
      revenueUpokt: parseNumericBigInt(aggregate.sum?.grossRewards)
    });
  }

  logDataInfo("Poktscan domain rewards dashboard aggregates received", {
    window,
    aggregateCount: rewardsResponse.data?.rewards?.groupedAggregates?.length ?? 0,
    rowCount: rows.length,
    indexerProcessedHeight: rewardsResponse.data?.status?.lastProcessedHeight ?? null,
    indexerTargetHeight: rewardsResponse.data?.status?.targetHeight ?? null
  });

  const latestHeight = rewardsResponse.data?.status?.targetHeight ?? rewardsResponse.data?.status?.lastProcessedHeight ?? 0;
  return buildDashboardFromProviderRows(window, latestHeight, rows, serviceSupplierCounts, supplierDirectory, poktPriceUsd, {
    dataSource: "poktscan",
    indexerProcessedHeight: rewardsResponse.data?.status?.lastProcessedHeight ?? undefined,
    indexerTargetHeight: rewardsResponse.data?.status?.targetHeight ?? undefined,
    earliestSettlementTime: start.toISOString(),
    latestSettlementTime: end.toISOString()
  });
}

async function loadDashboardFromRpc(window: TimeWindow): Promise<DashboardData> {
  logDataInfo("Starting RPC dashboard fallback load", { window });

  const [{ latestHeight }, serviceMap, serviceSupplierCounts, supplierDirectory, poktPriceUsd] = await Promise.all([
    getStatus(),
    getServiceMap(),
    getServiceSupplierCounts(),
    getSupplierDirectory(),
    getPoktPriceUsd()
  ]);

  const settlementBlocks = await getRecentSettlementBlocks(window, SAMPLE_BLOCKS_PER_WINDOW[window]);
  logDataInfo("RPC settlement blocks loaded", {
    window,
    requestedBlocks: SAMPLE_BLOCKS_PER_WINDOW[window],
    settlementBlockCount: settlementBlocks.length,
    latestHeight
  });
  const cachedBlocks = getCachedSettlementBlocks(settlementBlocks.map((block) => block.height));
  const missingSettlementBlocks = settlementBlocks.filter((block) => !cachedBlocks.has(block.height));

  const settlements: SettlementEvent[] = [];
  let scannedSettlementHeights = settlementBlocks.length;
  let scannedHeights = missingSettlementBlocks.length;

  for (const block of settlementBlocks) {
    const cachedBlock = cachedBlocks.get(block.height);
    if (!cachedBlock) continue;

    const events = JSON.parse(cachedBlock.events_json) as RpcEvent[];
    for (const event of events) {
      if (event.type !== SETTLEMENT_EVENT_TYPE) continue;
      settlements.push(parseSettlementEvent(event, block.height, cachedBlock.block_time, serviceMap));
    }
  }

  for (let start = 0; start < missingSettlementBlocks.length; start += 20) {
    const batch = missingSettlementBlocks.slice(start, start + 20);
    const batchResults = await mapConcurrent(batch, 6, async (height) => {
      try {
        const events = await getFinalizeEvents(height.height);
        return { height: height.height, blockTime: height.time, events, skipped: false };
      } catch {
        return { height: height.height, blockTime: height.time, events: [], skipped: true };
      }
    });

    for (const result of batchResults) {
      if (result.skipped) {
        continue;
      }

      saveSettlementBlock(result.height, result.blockTime, JSON.stringify(result.events));

      for (const event of result.events) {
        if (event.type !== SETTLEMENT_EVENT_TYPE) continue;
        settlements.push(parseSettlementEvent(event, result.height, result.blockTime, serviceMap));
      }
    }
  }

  logDataInfo("RPC settlement events loaded", {
    window,
    scannedHeights,
    scannedSettlementHeights,
    settlementEvents: settlements.length
  });

  const dashboard = buildDashboard(window, latestHeight, settlements, serviceSupplierCounts, supplierDirectory, poktPriceUsd);
  const finalized: DashboardData = {
    ...dashboard,
    scannedHeights,
    scannedSettlementHeights
  };

  return persistDashboard(window, finalized);
}

async function refreshDashboard(window: TimeWindow): Promise<DashboardData> {
  const inFlight = dashboardRefreshes.get(window);
  if (inFlight) {
    logDataInfo("Reusing in-flight dashboard refresh", { window });
    return inFlight;
  }

  const refreshPromise = (async () => {
    const stale = getCachedDashboardSnapshot(window);
    logDataInfo("Starting dashboard refresh", {
      window,
      hasStaleSnapshot: Boolean(stale),
      dataSource: stale?.dataSource ?? null,
      latestHeight: stale?.latestHeight ?? null
    });

    try {
      const dashboard = await loadDashboardFromPoktscan(window);
      logDataInfo("Dashboard refresh completed from Poktscan", {
        window,
        latestHeight: dashboard.latestHeight,
        activeProviders: dashboard.activeProviders,
        activeChains: dashboard.activeChains,
        totalRelays: dashboard.totalRelays,
        settlementEvents: dashboard.settlementEvents
      });
      return persistDashboard(window, dashboard);
    } catch (poktscanError) {
      if (!LEGACY_RPC_FALLBACK_ENABLED) {
        logDataError("Poktscan dashboard refresh failed; legacy RPC fallback is disabled", poktscanError, { window });
        if (stale) {
          logDataWarning("Serving stale dashboard snapshot after Poktscan refresh failure", {
            window,
            dataSource: stale.dataSource,
            latestHeight: stale.latestHeight,
            indexerProcessedHeight: stale.indexerProcessedHeight ?? null,
            indexerTargetHeight: stale.indexerTargetHeight ?? null
          });
          return stale;
        }

        throw new Error("Unable to refresh dashboard: Poktscan failed and legacy RPC fallback is disabled");
      }

      logDataError("Poktscan dashboard refresh failed; trying RPC fallback", poktscanError, { window });
      try {
        const dashboard = await loadDashboardFromRpc(window);
        logDataInfo("Dashboard refresh completed from RPC fallback", {
          window,
          latestHeight: dashboard.latestHeight,
          activeProviders: dashboard.activeProviders,
          activeChains: dashboard.activeChains,
          totalRelays: dashboard.totalRelays,
          settlementEvents: dashboard.settlementEvents
        });
        return dashboard;
      } catch (rpcError) {
        logDataError("RPC dashboard fallback failed", rpcError, { window });
        if (stale) {
          logDataWarning("Serving stale dashboard snapshot after refresh failures", {
            window,
            dataSource: stale.dataSource,
            latestHeight: stale.latestHeight,
            indexerProcessedHeight: stale.indexerProcessedHeight ?? null,
            indexerTargetHeight: stale.indexerTargetHeight ?? null
          });
          return stale;
        }

        throw new Error(`Unable to refresh dashboard for ${window}: Poktscan and RPC fallback failed`);
      }
    }
  })();

  dashboardRefreshes.set(window, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    dashboardRefreshes.delete(window);
  }
}

async function loadDashboard(window: TimeWindow): Promise<DashboardData> {
  const cached = dashboardCache.get(window) ?? (() => {
    const hydrated = hydrateDashboardCache(window);
    return hydrated ? dashboardCache.get(window) : undefined;
  })();

  if (hasServiceSupplierCounts(cached?.data)) {
    if (cached.expiresAt <= Date.now()) {
      void refreshDashboard(window);
    }

    return cached.data;
  }

  return refreshDashboard(window);
}

export async function getDashboardData(window: TimeWindow): Promise<DashboardData> {
  return loadDashboard(window);
}

export function getNetworkDailyHistoryLocal(days = PROVIDER_HISTORY_DAYS): NetworkDailyHistoryPoint[] {
  const snapshot = getNetworkDailyHistorySnapshot(days);
  if (snapshot.length > 0 || !isDevelopmentDummyDataEnabled()) {
    return snapshot;
  }

  return getDevelopmentNetworkDailyHistory(days);
}

export function getProviderDailyHistoryLocal(providerKey: string, days = PROVIDER_HISTORY_DAYS): ProviderDailyHistoryPoint[] {
  return getProviderDailyHistorySnapshot(providerKey, days);
}

export function getProviderSupplierBreakdownLocal(providerKey: string, window: TimeWindow): SupplierMember[] {
  return getProviderSupplierBreakdownSnapshot(providerKey, window);
}

export function getServiceDailyHistoryLocal(serviceId: string, days = PROVIDER_HISTORY_DAYS): ServiceDailyHistoryPoint[] {
  const snapshot = getServiceDailyHistorySnapshot(serviceId, days);
  if (snapshot.length > 0 || !isDevelopmentDummyDataEnabled()) {
    return snapshot;
  }

  return getDevelopmentServiceDailyHistory(serviceId, days);
}

export const getProviderDailyHistory = cache(async (providerKey: string, days = PROVIDER_HISTORY_DAYS): Promise<ProviderDailyHistoryPoint[]> => {
  if (!providerKey || providerKey.startsWith("owner:")) {
    logDataWarning("Skipping provider daily history for unsupported provider key", { providerKey, days });
    return [];
  }

  const cacheKey = getProviderDailyHistoryCacheKey(providerKey, days);
  const cached = getProviderDataCache<ProviderDailyHistoryCacheEntry[]>(cacheKey);
  if (cached) {
    logDataInfo("Provider daily history served from cache", {
      providerKey,
      days,
      pointCount: cached.length
    });
    return deserializeProviderDailyHistory(cached);
  }

  const end = new Date();
  const start = addDays(end, -(days - 1));
  logDataInfo("Loading provider daily history from Poktscan", {
    providerKey,
    days,
    start: toIsoDate(start),
    end: toIsoDate(end)
  });

  try {
    const response = await fetchPoktscan<PoktscanProviderDailyHistoryResponse>(
      `query ProviderDailyHistory($start: Date!, $end: Date!, $domain: String!) {
        rewards: domainServiceDailyRewards(
          filter: {
            day: {
              greaterThanOrEqualTo: $start
              lessThanOrEqualTo: $end
            }
            domain: {
              equalTo: $domain
            }
          }
        ) {
          groupedAggregates(groupBy: [DAY, DOMAIN]) {
            keys
            sum {
              grossRewards
              relays
            }
          }
        }
      }`,
      {
        start: toIsoDate(start),
        end: toIsoDate(end),
        domain: providerKey
      }
    );

    const byDay = new Map<string, ProviderDailyHistoryPoint>();
    for (const aggregate of response.data?.rewards?.groupedAggregates ?? []) {
      const day = aggregate.keys?.[0];
      if (!day) continue;
      byDay.set(day, {
        day,
        relays: parseNumeric(aggregate.sum?.relays),
        revenueUpokt: parseNumericBigInt(aggregate.sum?.grossRewards)
      });
    }

    logDataInfo("Provider daily history aggregates received", {
      providerKey,
      days,
      aggregateCount: response.data?.rewards?.groupedAggregates?.length ?? 0,
      nonZeroDays: Array.from(byDay.values()).filter((point) => point.relays > 0 || point.revenueUpokt > 0n).length
    });

    const series: ProviderDailyHistoryPoint[] = [];
    for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) {
      const day = toIsoDate(cursor);
      series.push(
        byDay.get(day) ?? {
          day,
          relays: 0,
          revenueUpokt: 0n
        }
      );
    }

    setProviderDataCache(cacheKey, serializeProviderDailyHistory(series));
    return series;
  } catch (error) {
    logDataError("Unable to load provider daily history", error, { providerKey, days });
    return [];
  }
});

export const getProviderSupplierBreakdown = cache(async (providerKey: string, window: TimeWindow): Promise<SupplierMember[]> => {
  if (!providerKey) {
    logDataWarning("Skipping provider supplier breakdown for empty provider key", { providerKey, window });
    return [];
  }

  const cacheKey = getProviderSupplierBreakdownCacheKey(providerKey, window);
  const cached = getProviderDataCache<SupplierMemberCacheEntry[]>(cacheKey);
  if (cached) {
    logDataInfo("Provider supplier breakdown served from cache", {
      providerKey,
      window,
      supplierCount: cached.length
    });
    return deserializeSupplierMembers(cached);
  }

  try {
    logDataInfo("Loading provider supplier breakdown", { providerKey, window });
    const [serviceMap, supplierDirectory, aggregates] = await Promise.all([
      getServiceMap(),
      getPoktscanSupplierDirectory(),
      getPoktscanClaimAggregates(window)
    ]);

    const supplierMap = new Map<string, SupplierMember>();
    const supplierChainMap = new Map<string, Set<string>>();

    for (const aggregate of aggregates) {
      const supplierId = aggregate.keys?.[0];
      const serviceId = aggregate.keys?.[1];
      if (!supplierId || !serviceId) continue;

      const supplierInfo = supplierDirectory[supplierId];
      if (!supplierInfo || supplierInfo.providerKey !== providerKey) {
        continue;
      }

      const supplier = supplierMap.get(supplierId) ?? {
        operatorAddress: supplierInfo.operatorAddress,
        ownerAddress: supplierInfo.ownerAddress,
        domain: supplierInfo.providerDomain,
        relays: 0,
        revenueUpokt: 0n,
        stakeUpokt: supplierInfo.stakeUpokt,
        chainCount: 0,
        serviceCount: supplierInfo.serviceCount,
        operatorRevSharePercent: supplierInfo.operatorRevSharePercent,
        ownerRevSharePercent: supplierInfo.ownerRevSharePercent,
        otherRevSharePercent: supplierInfo.otherRevSharePercent,
        detailAvailable: true
      };

      supplier.relays = (supplier.relays ?? 0) + parseNumeric(aggregate.sum?.numRelays);
      supplier.revenueUpokt = (supplier.revenueUpokt ?? 0n) + parseNumericBigInt(aggregate.sum?.claimedAmount);
      supplier.detailAvailable = true;
      supplierMap.set(supplierId, supplier);

      const chains = supplierChainMap.get(supplierId) ?? new Set<string>();
      chains.add(serviceMap[serviceId]?.name ?? serviceId);
      supplierChainMap.set(supplierId, chains);
    }

    const suppliers = Array.from(supplierMap.values())
      .map((supplier) => ({
        ...supplier,
        chainCount: supplierChainMap.get(supplier.operatorAddress)?.size ?? 0
      }))
      .sort((a, b) => (b.revenueUpokt ?? 0n) === (a.revenueUpokt ?? 0n)
        ? a.operatorAddress.localeCompare(b.operatorAddress)
        : (b.revenueUpokt ?? 0n) > (a.revenueUpokt ?? 0n) ? 1 : -1);

    setProviderDataCache(cacheKey, serializeSupplierMembers(suppliers));
    logDataInfo("Provider supplier breakdown loaded", {
      providerKey,
      window,
      aggregateCount: aggregates.length,
      supplierCount: suppliers.length
    });
    return suppliers;
  } catch (error) {
    logDataError("Unable to load provider supplier breakdown", error, { providerKey, window });
    return [];
  }
});

export const getNetworkDailyHistory = cache(async (days = PROVIDER_HISTORY_DAYS): Promise<NetworkDailyHistoryPoint[]> => {
  const end = new Date();
  const start = addDays(end, -(days - 1));

  try {
    const response = await fetchPoktscan<PoktscanNetworkDailyHistoryResponse>(
      `query NetworkDailyHistory($start: Date!, $end: Date!) {
        rewards: domainServiceDailyRewards(
          filter: {
            day: {
              greaterThanOrEqualTo: $start
              lessThanOrEqualTo: $end
            }
          }
        ) {
          groupedAggregates(groupBy: [DAY]) {
            keys
            sum {
              grossRewards
              relays
            }
          }
        }
      }`,
      {
        start: toIsoDate(start),
        end: toIsoDate(end)
      }
    );

    const byDay = new Map<string, NetworkDailyHistoryPoint>();
    for (const aggregate of response.data?.rewards?.groupedAggregates ?? []) {
      const day = aggregate.keys?.[0];
      if (!day) continue;
      byDay.set(day, {
        day,
        relays: parseNumeric(aggregate.sum?.relays),
        revenueUpokt: parseNumericBigInt(aggregate.sum?.grossRewards)
      });
    }

    const series: NetworkDailyHistoryPoint[] = [];
    for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) {
      const day = toIsoDate(cursor);
      series.push(
        byDay.get(day) ?? {
          day,
          relays: 0,
          revenueUpokt: 0n
        }
      );
    }

    setProviderDataCache(getNetworkDailyHistoryCacheKey(days), serializeNetworkDailyHistory(series));
    return series;
  } catch (error) {
    logDataError("Unable to load network daily history", error, { days });
    return [];
  }
});

export const getServiceDailyHistory = cache(async (serviceId: string, days = PROVIDER_HISTORY_DAYS): Promise<ServiceDailyHistoryPoint[]> => {
  if (!serviceId) {
    return [];
  }

  const end = new Date();
  const start = addDays(end, -(days - 1));

  try {
    const response = await fetchPoktscan<PoktscanServiceDailyHistoryResponse>(
      `query ServiceDailyHistory($start: Date!, $end: Date!, $serviceId: String!) {
        rewards: domainServiceDailyRewards(
          filter: {
            day: {
              greaterThanOrEqualTo: $start
              lessThanOrEqualTo: $end
            }
            serviceId: {
              equalTo: $serviceId
            }
          }
        ) {
          groupedAggregates(groupBy: [DAY, SERVICE_ID]) {
            keys
            sum {
              grossRewards
              relays
            }
          }
        }
      }`,
      {
        start: toIsoDate(start),
        end: toIsoDate(end),
        serviceId
      }
    );

    const byDay = new Map<string, ServiceDailyHistoryPoint>();
    for (const aggregate of response.data?.rewards?.groupedAggregates ?? []) {
      const day = aggregate.keys?.[0];
      if (!day) continue;
      byDay.set(day, {
        day,
        relays: parseNumeric(aggregate.sum?.relays),
        revenueUpokt: parseNumericBigInt(aggregate.sum?.grossRewards)
      });
    }

    const series: ServiceDailyHistoryPoint[] = [];
    for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) {
      const day = toIsoDate(cursor);
      series.push(
        byDay.get(day) ?? {
          day,
          relays: 0,
          revenueUpokt: 0n
        }
      );
    }

    setProviderDataCache(getServiceDailyHistoryCacheKey(serviceId, days), serializeNetworkDailyHistory(series));
    return series;
  } catch (error) {
    logDataError("Unable to load service daily history", error, { serviceId, days });
    return [];
  }
});

export function getDashboardSnapshot(window: TimeWindow): DashboardData | null {
  return getCachedDashboardSnapshot(window) ?? (isDevelopmentDummyDataEnabled() ? getDevelopmentDashboardData(window) : null);
}

export function getDashboardDataSafe(window: TimeWindow): { data: DashboardData | null; status: "ready" | "warming" } {
  const snapshot = getCachedDashboardSnapshot(window);

  if (snapshot) {
    return { data: snapshot, status: "ready" };
  }

  if (isDevelopmentDummyDataEnabled()) {
    return { data: getDevelopmentDashboardData(window), status: "ready" };
  }

  logDataWarning("Dashboard snapshot missing; waiting for ingestion worker", { window });
  return { data: null, status: "warming" };
}

export function primeDashboardRefresh(window: TimeWindow): void {
  logDataInfo("Skipping request-path dashboard refresh; ingestion worker owns data updates", { window });
}

export const warmDashboardData = cache(async (window: TimeWindow): Promise<DashboardData> => loadDashboard(window));

export async function runDataIngestion(): Promise<void> {
  const startedAt = Date.now();
  const jobId = startJobRun("data_ingestion", { windows: ["30d", "7d", "24h"] });

  try {
    logDataInfo("Starting data ingestion worker run");

    const windows: TimeWindow[] = ["30d", "7d", "24h", "365d"];
    const dashboards: Partial<Record<TimeWindow, DashboardData>> = {};
    for (const window of windows) {
      dashboards[window] = await refreshDashboard(window);
    }

    await getNetworkDailyHistory();

    const providers = Array.from(
      new Map(
        windows
          .flatMap((window) => dashboards[window]?.providers ?? [])
          .map((provider) => [provider.providerKey, provider])
      ).values()
    );
    const services = Array.from(
      new Map(
        windows
          .flatMap((window) => dashboards[window]?.services ?? [])
          .map((service) => [service.serviceId, service])
      ).values()
    );

    for (const provider of providers) {
      await getProviderDailyHistory(provider.providerDomain);
      for (const window of windows) {
        await getProviderSupplierBreakdown(provider.providerKey, window);
      }
    }

    for (const service of services) {
      await getServiceDailyHistory(service.serviceId);
    }

    const metadata = {
      windows,
      providerCount: providers.length,
      serviceCount: services.length,
      durationMs: Date.now() - startedAt
    };
    finishJobRun(jobId, "success", startedAt, metadata);
    logDataInfo("Data ingestion worker run completed", metadata);
  } catch (error) {
    const message = getErrorMessage(error);
    finishJobRun(jobId, "failed", startedAt, { durationMs: Date.now() - startedAt }, message);
    logDataError("Data ingestion worker run failed", error);
    throw error;
  }
}
