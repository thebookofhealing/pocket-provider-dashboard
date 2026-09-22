export type TimeWindow = "24h" | "7d" | "30d" | "365d";

export type ProviderChainStats = {
  serviceId: string;
  serviceName: string;
  relays: number;
  computeUnits?: number;
  computeUnitsPerRelay?: number;
  revenueUpokt: bigint;
};

export type SupplierMember = {
  operatorAddress: string;
  ownerAddress: string;
  domain: string;
  relays?: number;
  revenueUpokt?: bigint;
  stakeUpokt?: bigint;
  chainCount?: number;
  serviceCount?: number;
  operatorRevSharePercent?: number;
  ownerRevSharePercent?: number;
  otherRevSharePercent?: number;
  detailAvailable?: boolean;
};

export type ProviderStats = {
  providerKey: string;
  providerLabel: string;
  providerDomain: string;
  relays: number;
  revenueUpokt: bigint;
  chainCount: number;
  supplierCount: number;
  suppliers: SupplierMember[];
  chains: ProviderChainStats[];
};

export type ServiceStats = {
  serviceId: string;
  serviceName: string;
  relays: number;
  estimatedRelays?: number;
  computeUnits?: number;
  computeUnitsPerRelay?: number;
  estimatedComputeUnits?: number;
  /** Suppliers observed in the selected historical reward window. */
  supplierCount?: number;
  /** Currently eligible on-chain suppliers, refreshed independently of rewards. */
  eligibleSupplierCount?: number;
  eligibleSupplierCountFetchedAt?: string;
  appsStaked?: number;
  revenueUpokt: bigint;
  providerCount: number;
};

export type DashboardData = {
  window: TimeWindow;
  generatedAt: string;
  dataSource: "poktscan" | "rpc";
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
  totalRevenueUpokt: bigint;
  activeProviders: number;
  activeChains: number;
  suppliersPerSession: number;
  appsStakedByService: Record<string, number>;
  /** Node's latest block height observed at session-snapshot time, NOT a pinned REST snapshot. */
  sessionObservedHeight: number;
  sessionFetchedAt: string;
  sessionStale: boolean;
  providers: ProviderStats[];
  services: ServiceStats[];
};

export type ProviderDailyHistoryPoint = {
  day: string;
  relays: number;
  revenueUpokt: bigint;
};

export type NetworkDailyHistoryPoint = {
  day: string;
  relays: number;
  estimatedRelays?: number;
  estimatedComputeUnits?: number;
  /** True when the day's relays include estimated values, not just sampled/indexed facts. */
  isEstimated?: boolean;
  relayCoverage?: number;
  revenueUpokt: bigint;
  workloadCompleteness?: "complete" | "partial" | "missing";
  rewardCompleteness?: "complete" | "partial" | "missing";
};

export type ServiceDailyHistoryPoint = NetworkDailyHistoryPoint;

export type SerializedProviderChainStats = Omit<ProviderChainStats, "revenueUpokt"> & {
  revenueUpokt: string;
};

export type SerializedSupplierMember = Omit<SupplierMember, "revenueUpokt" | "stakeUpokt"> & {
  revenueUpokt?: string;
  stakeUpokt?: string;
};

export type SerializedProviderStats = Omit<ProviderStats, "revenueUpokt" | "chains" | "suppliers"> & {
  revenueUpokt: string;
  suppliers: SerializedSupplierMember[];
  chains: SerializedProviderChainStats[];
};

export type SerializedServiceStats = Omit<ServiceStats, "revenueUpokt" | "estimatedComputeUnits"> & {
  revenueUpokt: string;
  estimatedComputeUnits?: number;
};

export type SerializedProviderDailyHistoryPoint = Omit<ProviderDailyHistoryPoint, "revenueUpokt"> & {
  revenueUpokt: string;
};

export type SerializedNetworkDailyHistoryPoint = Omit<NetworkDailyHistoryPoint, "revenueUpokt"> & {
  revenueUpokt: string;
};

export type SerializedServiceDailyHistoryPoint = SerializedNetworkDailyHistoryPoint;

export type SerializedDashboardData = Omit<DashboardData, "totalRevenueUpokt" | "providers" | "services"> & {
  totalRevenueUpokt: string;
  providers: SerializedProviderStats[];
  services: SerializedServiceStats[];
};

export type ServiceMap = Record<string, { name: string; computeUnitsPerRelay?: number }>;

export type SupplierDirectoryEntry = {
  operatorAddress: string;
  ownerAddress: string;
  providerKey: string;
  providerLabel: string;
  providerDomain: string;
  stakeUpokt?: bigint;
  serviceCount?: number;
  operatorRevSharePercent?: number;
  ownerRevSharePercent?: number;
  otherRevSharePercent?: number;
};

export type SupplierDirectory = Record<string, SupplierDirectoryEntry>;
