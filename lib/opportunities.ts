type OpportunityService = {
  serviceId: string;
  serviceName: string;
  supplierCount?: number;
  providerCount: number;
  relays: number;
  computeUnits?: number;
  revenueUpokt: string | bigint;
};

export const SESSION_SUPPLIER_SLOTS = 50;
export const DEFAULT_NEW_PROVIDER_SUPPLIERS = 15;

export type ProviderServiceOpportunity = {
  serviceId: string;
  serviceName: string;
  supplierCount: number;
  providerCount: number;
  relays: number;
  computeUnits?: number;
  opportunityScore: number;
  expectedSharePercent: number;
  selectionProbability: number;
  equalShareRevenueEstimateUpokt: bigint;
  equalShareRevenuePerSupplierUpokt: bigint;
  modelledSessionProbability?: number;
  modelledAnyApplicationProbability?: number;
  expectedAssignments?: number;
  expectedSessionsRepresented?: number;
  appsStaked?: number;
};

function toBigInt(value: string | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function toPoktNumber(value: bigint): number {
  return Number(value) / 1_000_000;
}

export function getProjectedRevenueUpokt(revenueUpokt: bigint, existingSupplierCount: number, enteringSupplierCount: number): bigint {
  if (revenueUpokt <= 0n || enteringSupplierCount <= 0) return 0n;
  const totalSuppliers = existingSupplierCount + enteringSupplierCount;
  if (totalSuppliers <= 0) return 0n;
  return (revenueUpokt * BigInt(enteringSupplierCount)) / BigInt(totalSuppliers);
}

export function getMarginalRevenueGainUpokt(revenueUpokt: bigint, existingSupplierCount: number, allocatedSupplierCount: number): bigint {
  const current = getProjectedRevenueUpokt(revenueUpokt, existingSupplierCount, allocatedSupplierCount);
  const next = getProjectedRevenueUpokt(revenueUpokt, existingSupplierCount, allocatedSupplierCount + 1);
  return next - current;
}

export function getSelectionProbability(existingSupplierCount: number, enteringSupplierCount: number, sessionSlots = SESSION_SUPPLIER_SLOTS): number {
  if (enteringSupplierCount <= 0) return 0;
  const E = Math.max(0, Math.round(existingSupplierCount));
  const M = Math.max(0, Math.round(enteringSupplierCount));
  const T = E + M;
  if (T <= 0) return 0;
  const slots = Math.round(sessionSlots);
  if (slots <= 0) return 0;
  const K = Math.min(slots, T);

  const combination = (n: number, k: number): number => {
    if (k < 0 || k > n) return 0;
    if (k === 0 || k === n) return 1;
    let result = 1;
    for (let i = 0; i < k; i += 1) {
      result *= (n - i) / (i + 1);
    }
    return result;
  };

  const factT = combination(T, K);
  if (factT <= 0) return 100;

  const factE = K > E ? 0 : combination(E, K);
  const pSession = Math.max(0, Math.min(100, (1 - factE / factT) * 100));

  return pSession;
}

export function getModelledAnyApplicationProbability(
  pSession: number,
  appsStaked: number
): number {
  if (appsStaked <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - Math.pow(1 - pSession / 100, appsStaked)) * 100));
}

export function getExpectedAssignments(
  appsStaked: number,
  sessionSlots: number,
  enteringSupplierCount: number,
  totalSuppliers: number
): number {
  if (appsStaked <= 0 || enteringSupplierCount <= 0 || totalSuppliers <= 0) return 0;
  const slots = Math.round(sessionSlots);
  if (slots <= 0) return 0;
  const K = Math.min(slots, Math.round(totalSuppliers));
  return appsStaked * K * enteringSupplierCount / totalSuppliers;
}

export function getExpectedSessionsRepresented(
  appsStaked: number,
  pSession: number
): number {
  if (appsStaked <= 0) return 0;
  return appsStaked * (pSession / 100);
}

export function buildProviderServiceOpportunity(
  service: OpportunityService,
  providerSupplierCount: number,
  options?: { sessionSlots?: number; appsStaked?: number }
): ProviderServiceOpportunity {
  const supplierCount = Math.max(service.supplierCount ?? 0, 0);
  const projectedRevenueUpokt = getProjectedRevenueUpokt(toBigInt(service.revenueUpokt), supplierCount, providerSupplierCount);
  const projectedRevenuePerSupplierUpokt = providerSupplierCount > 0
    ? projectedRevenueUpokt / BigInt(providerSupplierCount)
    : 0n;
  const totalSuppliers = supplierCount + Math.max(providerSupplierCount, 0);
  const expectedSharePercent = totalSuppliers === 0 ? 0 : (providerSupplierCount / totalSuppliers) * 100;
  const sessionSlots = options?.sessionSlots ?? SESSION_SUPPLIER_SLOTS;
  const selectionProbability = getSelectionProbability(supplierCount, providerSupplierCount, sessionSlots);
  const projectedRevenuePerSupplierPokt = toPoktNumber(projectedRevenuePerSupplierUpokt);

  let appComponent = 0;
  if (options?.appsStaked != null && options.appsStaked > 0) {
    const expectedAssignments = getExpectedAssignments(options.appsStaked, sessionSlots, providerSupplierCount, totalSuppliers);
    const maxAssignments = providerSupplierCount * sessionSlots;
    if (maxAssignments > 0 && expectedAssignments > 0) {
      const normalized = expectedAssignments / maxAssignments;
      appComponent = Math.log2(1 + normalized) * 0.15;
    }
  }

  const opportunityScore = projectedRevenuePerSupplierPokt * (0.55 + (selectionProbability / 100) * 0.30 + appComponent);

  const result: ProviderServiceOpportunity = {
    serviceId: service.serviceId,
    serviceName: service.serviceName,
    supplierCount,
    providerCount: service.providerCount,
    relays: service.relays,
    computeUnits: service.computeUnits,
    opportunityScore,
    expectedSharePercent,
    selectionProbability,
    equalShareRevenueEstimateUpokt: projectedRevenueUpokt,
    equalShareRevenuePerSupplierUpokt: projectedRevenuePerSupplierUpokt
  };

  if (options?.appsStaked != null && options.appsStaked > 0) {
    result.appsStaked = options.appsStaked;
    result.modelledSessionProbability = selectionProbability;
    result.modelledAnyApplicationProbability = getModelledAnyApplicationProbability(selectionProbability, options.appsStaked);
    result.expectedAssignments = getExpectedAssignments(options.appsStaked, sessionSlots, providerSupplierCount, totalSuppliers);
    result.expectedSessionsRepresented = getExpectedSessionsRepresented(options.appsStaked, selectionProbability);
  }

  return result;
}

export function allocateSuppliersByMarginalReturn(
  services: OpportunityService[],
  supplierCount: number
): Map<string, number> {
  const allocation = new Map<string, number>();
  if (supplierCount <= 0 || services.length === 0) {
    return allocation;
  }

  const serviceById = new Map(services.map((s) => [s.serviceId, s]));

  type HeapEntry = { serviceId: string; order: number; gain: bigint; allocated: number };
  const heap: HeapEntry[] = [];

  services.forEach((service, order) => {
    allocation.set(service.serviceId, 0);
    const gain = getMarginalRevenueGainUpokt(toBigInt(service.revenueUpokt), Math.max(service.supplierCount ?? 0, 0), 0);
    heap.push({ serviceId: service.serviceId, order, gain, allocated: 0 });
  });

  function higherPriority(a: HeapEntry, b: HeapEntry): boolean {
    return a.gain > b.gain || (a.gain === b.gain && a.order < b.order);
  }

  function heapifyDown(index: number): void {
    const size = heap.length;
    let largest = index;
    while (true) {
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      if (left < size && higherPriority(heap[left], heap[largest])) largest = left;
      if (right < size && higherPriority(heap[right], heap[largest])) largest = right;
      if (largest === index) break;
      [heap[index], heap[largest]] = [heap[largest], heap[index]];
      index = largest;
    }
  }

  function heapifyUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!higherPriority(heap[index], heap[parent])) break;
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
  }

  for (let i = Math.floor(heap.length / 2) - 1; i >= 0; i--) heapifyDown(i);

  let remaining = supplierCount;
  while (remaining > 0 && heap.length > 0) {
    const top = heap[0];
    top.allocated += 1;
    allocation.set(top.serviceId, top.allocated);
    remaining--;

    const service = serviceById.get(top.serviceId);
    if (!service) break;

    top.gain = getMarginalRevenueGainUpokt(toBigInt(service.revenueUpokt), Math.max(service.supplierCount ?? 0, 0), top.allocated);

    // Always allocate, even at zero gain. Never drop a candidate — this
    // guarantees allocatedTotal === supplierCount. Tie-break by serviceId.
    if (top.gain <= 0n) {
      heapifyDown(0);
    } else {
      heapifyDown(0);
    }
  }

  return allocation;
}

export function buildAllocatedServiceOpportunity(
  service: OpportunityService,
  enteringSupplierCount: number,
  allocatedSupplierCount: number,
  options?: { sessionSlots?: number; appsStaked?: number }
): ProviderServiceOpportunity {
  const opportunity = buildProviderServiceOpportunity(service, enteringSupplierCount, options);
  const projectedRevenueUpokt = getProjectedRevenueUpokt(
    toBigInt(service.revenueUpokt),
    Math.max(service.supplierCount ?? 0, 0),
    allocatedSupplierCount
  );
  const projectedRevenuePerSupplierUpokt = allocatedSupplierCount > 0
    ? projectedRevenueUpokt / BigInt(allocatedSupplierCount)
    : 0n;
  const projectedRevenuePerSupplierPokt = toPoktNumber(projectedRevenuePerSupplierUpokt);
  const sessionSlots = options?.sessionSlots ?? SESSION_SUPPLIER_SLOTS;
  const selectionProbability = getSelectionProbability(Math.max(service.supplierCount ?? 0, 0), allocatedSupplierCount, sessionSlots);
  const totalSuppliers = Math.max(service.supplierCount ?? 0, 0) + allocatedSupplierCount;

  let appComponent = 0;
  if (options?.appsStaked != null && options.appsStaked > 0) {
    const expectedAssignments = getExpectedAssignments(options.appsStaked, sessionSlots, allocatedSupplierCount, totalSuppliers);
    const maxAssignments = allocatedSupplierCount * sessionSlots;
    if (maxAssignments > 0) {
      appComponent = Math.min(expectedAssignments / (maxAssignments * 0.5), 1) * 0.15;
    }
  }

  const result: ProviderServiceOpportunity = {
    ...opportunity,
    selectionProbability,
    equalShareRevenueEstimateUpokt: projectedRevenueUpokt,
    equalShareRevenuePerSupplierUpokt: projectedRevenuePerSupplierUpokt,
    expectedSharePercent: (Math.max(service.supplierCount ?? 0, 0) + allocatedSupplierCount) === 0
      ? 0
      : (allocatedSupplierCount / (Math.max(service.supplierCount ?? 0, 0) + allocatedSupplierCount)) * 100,
    opportunityScore: projectedRevenuePerSupplierPokt * (0.55 + (selectionProbability / 100) * 0.30 + appComponent)
  };

  if (options?.appsStaked != null && options.appsStaked > 0) {
    result.appsStaked = options.appsStaked;
    result.modelledSessionProbability = selectionProbability;
    result.modelledAnyApplicationProbability = getModelledAnyApplicationProbability(selectionProbability, options.appsStaked);
    result.expectedAssignments = getExpectedAssignments(
      options.appsStaked,
      sessionSlots,
      allocatedSupplierCount,
      Math.max(service.supplierCount ?? 0, 0) + allocatedSupplierCount
    );
    result.expectedSessionsRepresented = getExpectedSessionsRepresented(options.appsStaked, selectionProbability);
  }

  return result;
}
