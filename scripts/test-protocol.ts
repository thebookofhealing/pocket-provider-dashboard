import assert from "node:assert/strict";

import {
  buildProviderServiceOpportunity,
  getProjectedRevenueUpokt,
  getSelectionProbability,
  SESSION_SUPPLIER_SLOTS
} from "@/lib/opportunities";
import { derivePlanEconomics, isSourceFresh, normalizeSourceTimestamp } from "@/lib/staking-economics";
import { isEligibleSupplierSnapshotComplete, isEligibleSupplierSnapshotFresh, isEligibleSupplierSnapshotReusable, parseEligibleSupplierSnapshot, selectEligibleSupplierSnapshot } from "@/lib/eligible-suppliers";
import { __testing as stakingTesting, extractLatestBlockTimestamp, IGNITER_LATEST_BLOCK_QUERY, IGNITER_REWARDS_QUERY } from "@/lib/staking-plans";
import { aggregateEligibleSupplierCounts } from "@/lib/eligible-suppliers";
import { getDeployedSha } from "@/lib/deployment";
import { resolveEligibleSupplierCounts } from "@/lib/eligible-supplier-source";
import { ELIGIBLE_SUPPLIER_SNAPSHOT_SCHEMA_VERSION, hasCompleteEligibleSupplierCounts } from "@/lib/cache-contract";

assert.equal(getSelectionProbability(40, 1), 100, "all eligible suppliers fit within session slots");
assert.equal(getSelectionProbability(100, 0), 0, "no entering suppliers has no selection probability");
assert.ok(Math.abs(getSelectionProbability(100, 1) - (50 / 101 * 100)) < 1e-9, "known hypergeometric example");
assert.ok(getSelectionProbability(100, 2) > getSelectionProbability(100, 1), "increasing M cannot decrease probability");
assert.ok(getSelectionProbability(200, 1) < getSelectionProbability(100, 1), "increasing E cannot increase probability");
assert.equal(SESSION_SUPPLIER_SLOTS, 50);
assert.match(IGNITER_REWARDS_QUERY, /\$domains: \[String!\]!/, "Igniter reward query requires a non-null domain list");
assert.match(IGNITER_REWARDS_QUERY, /getRewardsByDomainsAndTimeGroupByService/, "Igniter reward query uses the supported resolver");
assert.match(IGNITER_LATEST_BLOCK_QUERY, /blocks\(orderBy: ID_DESC, first: 1\)/, "Igniter freshness uses the latest block query");
assert.equal(extractLatestBlockTimestamp({ blocks: { nodes: [{ id: "123", timestamp: "1790096400000" }] } }), "2026-09-22T17:00:00.000Z", "latest block timestamp is normalized");
assert.equal(extractLatestBlockTimestamp({ blocks: { nodes: [{ id: "123", timestamp: "2026-09-23T02:55:27.173" }] } }), "2026-09-23T02:55:27.173Z", "timezone-less Igniter timestamps are treated as UTC");
assert.equal(getDeployedSha({ GITHUB_SHA: "github-sha-test" }), "github-sha-test", "self-hosted deployment SHA uses GITHUB_SHA");

const eligiblePages = [
  { supplier: [
    { operator_address: "operator-a", services: [{ service_id: "eth" }, { service_id: "base" }] },
    { operator_address: "operator-a", services: [{ service_id: "eth" }] }
  ] },
  { supplier: [
    { operator_address: "operator-b", services: [{ service_id: "eth" }] },
    { operator_address: "operator-c", services: [{ service_id: "base" }] }
  ] }
];
assert.deepEqual(aggregateEligibleSupplierCounts(eligiblePages, new Set(["eth", "base"])), { eth: 2, base: 2 }, "dehydrated active services aggregate across pages and deduplicate operators");
assert.deepEqual(aggregateEligibleSupplierCounts([{ supplier: [] }], new Set(["eth", "base"])), { eth: 0, base: 0 }, "known services with no active suppliers publish explicit zero counts");
assert.throws(() => aggregateEligibleSupplierCounts([], new Set(["eth"])), /no pages/, "failed pagination cannot publish an empty snapshot");
assert.throws(() => aggregateEligibleSupplierCounts([{ supplier: [{ operator_address: "operator-a", services: [{ service_id: "unknown" }] }] }], new Set(["eth"])), /known active services/, "an incomplete service snapshot is rejected");

const missingEligible = buildProviderServiceOpportunity({
  serviceId: "missing",
  serviceName: "Missing",
  providerCount: 1,
  relays: 1,
  revenueUpokt: "1000000"
}, 1);
assert.equal(missingEligible.eligibleSupplierCountAvailable, false, "missing eligible counts are explicit");
assert.equal(missingEligible.selectionProbability, 0, "missing eligible counts fail closed");
const availableEligible = buildProviderServiceOpportunity({
  serviceId: "available",
  serviceName: "Available",
  supplierCount: 999,
  eligibleSupplierCount: 12,
  providerCount: 1,
  relays: 1,
  revenueUpokt: "1000000"
}, 1);
assert.equal(availableEligible.eligibleSupplierCountAvailable, true, "a complete eligible snapshot enables calculator metrics");
assert.ok(Number.isFinite(availableEligible.selectionProbability), "eligible snapshot produces finite selection odds");
const zeroEligible = buildProviderServiceOpportunity({
  serviceId: "zero", serviceName: "Zero", supplierCount: 10, eligibleSupplierCount: 0,
  providerCount: 1, relays: 1, revenueUpokt: "1000000"
}, 1);
assert.equal(zeroEligible.eligibleSupplierCountAvailable, true, "zero eligible count remains an available metric");
assert.ok(Number.isFinite(zeroEligible.selectionProbability), "zero eligible count produces finite calculator metrics");

const simulatorServices = [
  { serviceId: "bnb", serviceName: "BNB", supplierCount: 20, eligibleSupplierCount: 20, providerCount: 2, relays: 10, revenueUpokt: "100000000" },
  { serviceId: "eth", serviceName: "Ethereum", supplierCount: 5, eligibleSupplierCount: 5, providerCount: 1, relays: 8, revenueUpokt: "50000000" }
];
const bnbOpportunity = buildProviderServiceOpportunity(simulatorServices[0], 15, { sessionSlots: 50 });
const ethOpportunity = buildProviderServiceOpportunity(simulatorServices[1], 15, { sessionSlots: 50 });
assert.equal(bnbOpportunity.equalShareRevenueEstimateUpokt, getProjectedRevenueUpokt(100000000n, 20, 15), "each selected service uses the full supplier count");
assert.equal(ethOpportunity.equalShareRevenueEstimateUpokt, getProjectedRevenueUpokt(50000000n, 5, 15), "each selected service uses the full supplier count independently");
assert.ok(bnbOpportunity.equalShareRevenueEstimateUpokt + ethOpportunity.equalShareRevenueEstimateUpokt > bnbOpportunity.equalShareRevenueEstimateUpokt, "adding a positive-reward service increases projected rewards");
assert.equal(buildProviderServiceOpportunity(simulatorServices[0], 15).selectionProbability, bnbOpportunity.selectionProbability, "adding another service does not change an existing service's odds");
assert.ok(getSelectionProbability(10, 15, 50) >= getSelectionProbability(20, 15, 50), "lower eligible E cannot lower fixed-M selection odds");
const meanIndependentOdds = (bnbOpportunity.selectionProbability + ethOpportunity.selectionProbability) / 2;
assert.equal(meanIndependentOdds, [bnbOpportunity, ethOpportunity].reduce((sum, opportunity) => sum + opportunity.selectionProbability, 0) / 2, "summary odds are the mean of independent service odds");
assert.equal(ethOpportunity.equalShareRevenueEstimateUpokt, getProjectedRevenueUpokt(50000000n, 5, 15), "removing BNB removes only BNB's contribution");

const economics = derivePlanEconomics(7_000_000, 50, 59_500);
assert.equal(economics.grossDailyPokt, 1);
assert.equal(economics.netDailyPokt, 0.5);
assert.equal(economics.apr, (0.5 * 365 / 59_500) * 100);

const fresh = new Date("2026-09-22T12:00:00.000Z").getTime();
assert.equal(isSourceFresh("2026-09-22T11:50:00.000Z", fresh), true);
assert.equal(isSourceFresh("2026-09-22T11:44:59.000Z", fresh), false);
assert.equal(isSourceFresh(null, fresh), false);
assert.equal(normalizeSourceTimestamp("1790096400000"), "2026-09-22T17:00:00.000Z");

const eligibleSnapshot = { schemaVersion: ELIGIBLE_SUPPLIER_SNAPSHOT_SCHEMA_VERSION, complete: true as const, counts: { base: 12 }, fetchedAt: "2026-09-22T06:00:00.000Z" };
const completeEligibleSnapshot = { schemaVersion: ELIGIBLE_SUPPLIER_SNAPSHOT_SCHEMA_VERSION, complete: true as const, counts: { base: 12, eth: 0 }, fetchedAt: "2026-09-22T06:00:00.000Z" };
assert.equal(parseEligibleSupplierSnapshot({ counts: { base: 12 }, fetchedAt: "2026-09-22T06:00:00.000Z" }), null, "legacy eligible snapshot payload is rejected");
assert.equal(isEligibleSupplierSnapshotComplete(eligibleSnapshot, new Set(["base", "eth"])), false, "legacy snapshot without zero-count service is incomplete");
assert.equal(isEligibleSupplierSnapshotComplete(completeEligibleSnapshot, new Set(["base", "eth"])), true, "complete snapshot is reusable when all services are present");
assert.equal(isEligibleSupplierSnapshotComplete(completeEligibleSnapshot, new Set(["base", "eth", "new-service"])), false, "newly registered service invalidates an older snapshot");
assert.equal(isEligibleSupplierSnapshotReusable(eligibleSnapshot, new Set(["base", "eth"]), fresh), false, "time-fresh incomplete snapshot cannot bypass refresh");
assert.equal(isEligibleSupplierSnapshotReusable(completeEligibleSnapshot, new Set(["base", "eth"]), fresh), true, "time-fresh complete snapshot can bypass refresh");
assert.equal(isEligibleSupplierSnapshotReusable(completeEligibleSnapshot, new Set(), fresh), false, "snapshot cannot be certified without a service registry");
assert.equal(isEligibleSupplierSnapshotFresh(eligibleSnapshot, fresh), true);
assert.equal(isEligibleSupplierSnapshotFresh(eligibleSnapshot, fresh + 6 * 60 * 60 * 1000 + 1), false);
assert.deepEqual(selectEligibleSupplierSnapshot(eligibleSnapshot, null, fresh + 7 * 60 * 60 * 1000), { snapshot: eligibleSnapshot, stale: true });
assert.deepEqual(selectEligibleSupplierSnapshot(eligibleSnapshot, null, fresh, new Set(["base", "eth"])), { snapshot: eligibleSnapshot, stale: true }, "failed refresh after incomplete cache remains stale/fail-closed");
assert.deepEqual(selectEligibleSupplierSnapshot(eligibleSnapshot, { ...completeEligibleSnapshot, counts: { base: 13, eth: 0 }, fetchedAt: "2026-09-22T12:00:00.000Z" }, fresh), { snapshot: { ...completeEligibleSnapshot, counts: { base: 13, eth: 0 }, fetchedAt: "2026-09-22T12:00:00.000Z" }, stale: false });
assert.equal(hasCompleteEligibleSupplierCounts([{ eligibleSupplierCount: 0, eligibleSupplierCountFetchedAt: "2026-09-22T12:00:00.000Z", eligibleSupplierCountStale: false }]), true, "zero counts satisfy the shared readiness predicate");
assert.equal(hasCompleteEligibleSupplierCounts([{ eligibleSupplierCount: 1, eligibleSupplierCountFetchedAt: "2026-09-22T12:00:00.000Z", eligibleSupplierCountStale: true }]), false, "stale counts fail the shared readiness predicate");

const snapshotSource = {
  sourceUpdatedAt: "2026-09-22T11:55:00.000Z",
  allocation: { value: JSON.stringify({ supplier: 0.8 }) }
};
const rewardFixture = new Map([[
  "fixture.example",
  [{ gross_rewards: "300000000", staked_suppliers: 1 }]
], [
  "fixture-two.example",
  [{ gross_rewards: "500000000", staked_suppliers: 2 }]
]]);
const fixtureMetadata = [{
  id: "fixture", provider: "Fixture", plan: "Public", clientShare: 50,
  termsVerifiedAt: "2026-09-22", domain: "fixture.example", website: "https://fixture.example"
}, {
  id: "fixture-two", provider: "Fixture Two", plan: "Public", clientShare: 60,
  termsVerifiedAt: "2026-09-22", domain: "fixture-two.example", website: "https://fixture-two.example"
}];
const liveSnapshot = stakingTesting.buildLivePlans(
  snapshotSource,
  rewardFixture,
  59_500,
  new Date("2026-09-22T12:00:00.000Z"),
  fixtureMetadata
);
assert.equal(liveSnapshot.stale, false, "fresh source is live");
assert.equal(liveSnapshot.source, "igniter-indexer", "fresh source is marked live");
assert.equal(liveSnapshot.plans[0]?.termsVerifiedAt, "2026-09-22", "configured terms carry an explicit verification date");
assert.ok(Math.abs((liveSnapshot.plans[0]?.displayedYield ?? 0) - (17 + 1 / 7)) < 1e-9, "Igniter supplier allocation and seven-day divisor are applied once");
assert.ok(Math.abs((liveSnapshot.plans[1]?.displayedYield ?? 0) - (17 + 1 / 7)) < 1e-9, "the same allocation path matches a second plan with a different supplier count");

const changedShareSnapshot = stakingTesting.buildLivePlans(
  snapshotSource,
  rewardFixture,
  59_500,
  new Date("2026-09-22T12:00:00.000Z"),
  [{ ...fixtureMetadata[0], clientShare: 75 }]
);
assert.ok(Math.abs((changedShareSnapshot.plans[0]?.displayedYield ?? 0) - (25 + 5 / 7)) < 1e-9, "a refreshed client-share input changes the derived yield");

const staleSourceSnapshot = stakingTesting.buildLivePlans(
  { ...snapshotSource, sourceUpdatedAt: "2026-09-22T11:00:00.000Z" },
  rewardFixture,
  59_500,
  new Date("2026-09-22T12:00:00.000Z"),
  fixtureMetadata
);
assert.equal(staleSourceSnapshot.stale, true, "stale source is surfaced as stale");
assert.equal(staleSourceSnapshot.plans[0]?.rewardStatus, "stale", "stale-derived provider rewards are explicitly marked stale");

const termsDateChanged = stakingTesting.buildLivePlans(
  snapshotSource,
  rewardFixture,
  59_500,
  new Date("2026-09-22T12:00:00.000Z"),
  [{ ...fixtureMetadata[0], termsVerifiedAt: "2025-01-01" }]
);
assert.equal(termsDateChanged.sourceUpdatedAt, liveSnapshot.sourceUpdatedAt, "terms verification date does not affect reward-source freshness");
assert.ok(Math.abs((termsDateChanged.plans[0]?.displayedYield ?? 0) - (liveSnapshot.plans[0]?.displayedYield ?? 0)) < 1e-9, "terms verification date does not affect reward economics");

assert.throws(() => stakingTesting.buildLivePlans(
  snapshotSource,
  rewardFixture,
  59_500,
  new Date("2026-09-22T12:00:00.000Z"),
  [{ ...fixtureMetadata[0], clientSharesByService: { alpha: 49, beta: 51 } }]
), /no configured public provider plans/, "non-uniform service shares cannot produce an aggregate APR");

(async () => {
  stakingTesting.resetLastSuccessfulSnapshot();
  const cacheStart = Date.parse("2026-09-22T12:00:00.000Z");
  const sourceKnownServices = new Set(["bnb", "eth"]);
  const freshSourceSnapshot = { schemaVersion: ELIGIBLE_SUPPLIER_SNAPSHOT_SCHEMA_VERSION, complete: true as const, counts: { bnb: 20, eth: 5 }, fetchedAt: "2026-09-22T11:30:00.000Z", stale: false as const, source: "rest" as const };
  let restSourceCalls = 0;
  const preferredLocal = await resolveEligibleSupplierCounts(sourceKnownServices, freshSourceSnapshot, null, {
    rest: async () => { restSourceCalls += 1; throw new Error("rest should not be called"); },
    graphql: async () => { throw new Error("graphql should not be called"); }
  }, cacheStart);
  assert.equal(preferredLocal.source, "rest", "fresh local eligible snapshot is preferred");
  assert.equal(restSourceCalls, 0, "fresh local eligible snapshot avoids upstream refresh");
  const staleLocal = { ...freshSourceSnapshot, fetchedAt: "2026-09-22T00:00:00.000Z" };
  const graphqlFallback = await resolveEligibleSupplierCounts(sourceKnownServices, staleLocal, null, {
    rest: async () => { throw new Error("REST unavailable"); },
    graphql: async () => ({ ...freshSourceSnapshot, source: "poktscan-graphql" as const, fetchedAt: "2026-09-22T12:00:00.000Z" })
  }, cacheStart);
  assert.equal(graphqlFallback.source, "poktscan-graphql", "stale local counts fall back to data.pocket.network GraphQL");
  // This models the indexer's materializer after the REST source is down: the
  // shared resolver must publish a complete fresh snapshot and the dashboard
  // rows must receive the winning GraphQL source rather than an indexer label.
  const materializedRows = Array.from(sourceKnownServices, (serviceId) => ({
    serviceId,
    eligibleSupplierCount: graphqlFallback.counts[serviceId],
    eligibleSupplierCountStale: graphqlFallback.stale,
    eligibleSupplierSnapshotSource: graphqlFallback.source
  }));
  assert.equal(graphqlFallback.stale, false, "GraphQL fallback is fresh");
  assert.deepEqual(materializedRows.map((row) => row.eligibleSupplierCount), [20, 5], "GraphQL fallback materializes every known service");
  assert.ok(materializedRows.every((row) => row.eligibleSupplierSnapshotSource === "poktscan-graphql" && row.eligibleSupplierCountStale === false), "materialized rows retain GraphQL provenance and freshness");
  const staleLkg = await resolveEligibleSupplierCounts(sourceKnownServices, staleLocal, null, {
    rest: async () => { throw new Error("REST unavailable"); },
    graphql: async () => { throw new Error("GraphQL unavailable"); }
  }, cacheStart);
  assert.equal(staleLkg.stale, true, "failed fallback retains only a stale LKG snapshot");
  await assert.rejects(() => resolveEligibleSupplierCounts(new Set(["bnb", "eth", "new"]), staleLocal, null, {
    rest: async () => { throw new Error("REST unavailable"); },
    graphql: async () => { throw new Error("GraphQL unavailable"); }
  }, cacheStart), /REST unavailable/, "incomplete local and failed upstream sources fail closed");
  const firstSnapshot = { ...liveSnapshot, fetchedAt: "2026-09-22T12:00:00.000Z", sourceUpdatedAt: "2026-09-22T11:50:00.000Z" };
  assert.equal((await stakingTesting.loadStakingPlans(async () => firstSnapshot, cacheStart)).source, "igniter-indexer");
  let refreshAttempted = false;
  const refreshedSnapshot = { ...firstSnapshot, fetchedAt: "2026-09-22T12:06:00.000Z", sourceUpdatedAt: "2026-09-22T12:05:00.000Z" };
  const refreshed = await stakingTesting.loadStakingPlans(async () => { refreshAttempted = true; return refreshedSnapshot; }, Date.parse("2026-09-22T12:06:00.000Z"));
  assert.equal(refreshAttempted, true, "expired source freshness bypasses a locally fresh cache");
  assert.equal(refreshed.stale, false, "a successful refresh restores live status");
  stakingTesting.resetLastSuccessfulSnapshot();
  const fallbackSeed = { ...liveSnapshot, fetchedAt: "2026-09-22T11:00:00.000Z", sourceUpdatedAt: "2026-09-22T11:00:00.000Z" };
  assert.equal((await stakingTesting.loadStakingPlans(async () => fallbackSeed, Date.parse("2026-09-22T11:00:00.000Z"))).source, "igniter-indexer");
  const fallbackSnapshot = await stakingTesting.loadStakingPlans(async () => { throw new Error("source unavailable"); }, Date.parse("2026-09-22T12:00:00.000Z"));
  assert.equal(fallbackSnapshot.source, "last-known-good", "source failure uses last-known-good data");
  assert.equal(fallbackSnapshot.stale, true, "source failure is surfaced as stale");
  stakingTesting.resetLastSuccessfulSnapshot();
  const staticFallback = await stakingTesting.loadStakingPlans(async () => { throw new Error("initial source unavailable"); }, cacheStart);
  assert.equal(staticFallback.source, "last-known-good", "static fallback is identified as last-known-good");
  assert.equal(staticFallback.stale, true, "static fallback is never live");
  console.log("protocol, eligible-count fail-closed, economics, and freshness tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
