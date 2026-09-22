export const DEFAULT_RPC_URLS = [
  "https://sauron-rpc.infra.pocket.network",
  "https://pocket-rpc.polkachu.com:443",
  "https://pocket.api.pocket.network:443",
  "https://pocket-rpc.kleomedes.network"
];

type RpcStatusResponse = {
  result?: {
    sync_info?: {
      latest_block_height?: string;
    };
  };
};

export type CurrentBlockHeight = {
  height: number;
  rpcUrl: string;
};

const RPC_STATUS_TIMEOUT_MS = 2_500;
const MAX_RPC_PROBES = 5;

function getRpcCandidates(): string[] {
  return Array.from(
    new Set(
      (process.env.POCKET_RPC_URLS ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .concat(process.env.POCKET_RPC_URL ? [process.env.POCKET_RPC_URL] : [])
        .concat(DEFAULT_RPC_URLS)
    )
  ).slice(0, MAX_RPC_PROBES);
}

function buildRpcUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

export async function getCurrentBlockHeight(): Promise<CurrentBlockHeight | null> {
  const results = await Promise.allSettled(
    getRpcCandidates().map(async (rpcUrl): Promise<CurrentBlockHeight> => {
      const response = await fetch(buildRpcUrl(rpcUrl, "/status"), {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(RPC_STATUS_TIMEOUT_MS)
      });

      if (!response.ok) throw new Error(`HTTP ${response.status} from ${rpcUrl}`);

      const data = (await response.json()) as RpcStatusResponse;
      const height = Number(data.result?.sync_info?.latest_block_height ?? 0);
      if (!Number.isSafeInteger(height) || height <= 0) {
        throw new Error(`Invalid block height from ${rpcUrl}`);
      }

      return { height, rpcUrl };
    })
  );

  const healthy = results
    .filter((result): result is PromiseFulfilledResult<CurrentBlockHeight> => result.status === "fulfilled")
    .map((result) => result.value)
    .sort((a, b) => b.height - a.height);

  return healthy[0] ?? null;
}
