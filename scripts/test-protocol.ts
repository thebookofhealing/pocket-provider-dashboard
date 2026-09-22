import assert from "node:assert/strict";

import {
  buildProviderServiceOpportunity,
  getSelectionProbability,
  SESSION_SUPPLIER_SLOTS
} from "@/lib/opportunities";
import { derivePlanEconomics, isSourceFresh, normalizeSourceTimestamp } from "@/lib/staking-economics";
import { isEligibleSupplierSnapshotFresh, selectEligibleSupplierSnapshot } from "@/lib/eligible-suppliers";
import { __testing as stakingTesting } from "@/lib/staking-plans";

assert.equal(getSelectionProbability(40, 1), 100, "all eligible suppliers fit within session slots");
assert.equal(getSelectionProbability(100, 0), 0, "no entering suppliers has no selection probability");
assert.ok(Math.abs(getSelectionProbability(100, 1) - (50 / 101 * 100)) < 1e-9, "known hypergeometric example");
assert.ok(getSelectionProbability(100, 2) > getSelectionProbability(100, 1), "increasing M cannot decrease probability");
assert.ok(getSelectionProbability(200, 1) < getSelectionProbability(100, 1), "increasing E cannot increase probability");
assert.equal(SESSION_SUPPLIER_SLOTS, 50);

const missingEligible = buildProviderServiceOpportunity({
  serviceId: "missing",
  serviceName: "Missing",
  providerCount: 1,
  relays: 1,
  revenueUpokt: "1000000"
}, 1);
assert.equal(missingEligible.eligibleSupplierCountAvailable, false, "missing eligible counts are explicit");
assert.equal(missingEligible.selectionProbability, 0, "missing eligible counts fail closed");

const economics = derivePlanEconomics(7_000_000, 50, 59_500);
assert.equal(economics.grossDailyPokt, 1);
assert.equal(economics.netDailyPokt, 0.5);
assert.equal(economics.apr, (0.5 * 365 / 59_500) * 100);

const fresh = new Date("2026-09-22T12:00:00.000Z").getTime();
assert.equal(isSourceFresh("2026-09-22T11:50:00.000Z", fresh), true);
assert.equal(isSourceFresh("2026-09-22T11:44:59.000Z", fresh), false);
assert.equal(isSourceFresh(null, fresh), false);
assert.equal(normalizeSourceTimestamp("1790096400000"), "2026-09-22T17:00:00.000Z");

const eligibleSnapshot = { counts: { base: 12 }, fetchedAt: "2026-09-22T06:00:00.000Z" };
assert.equal(isEligibleSupplierSnapshotFresh(eligibleSnapshot, fresh), true);
assert.equal(isEligibleSupplierSnapshotFresh(eligibleSnapshot, fresh + 6 * 60 * 60 * 1000 + 1), false);
assert.deepEqual(selectEligibleSupplierSnapshot(eligibleSnapshot, null, fresh + 7 * 60 * 60 * 1000), { snapshot: eligibleSnapshot, stale: true });
assert.deepEqual(selectEligibleSupplierSnapshot(eligibleSnapshot, { counts: { base: 13 }, fetchedAt: "2026-09-22T12:00:00.000Z" }, fresh), { snapshot: { counts: { base: 13 }, fetchedAt: "2026-09-22T12:00:00.000Z" }, stale: false });

const snapshotSource = {
  status: { lastProcessedTimestamp: "2026-09-22T11:55:00.000Z" },
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
  domain: "fixture.example", website: "https://fixture.example"
}, {
  id: "fixture-two", provider: "Fixture Two", plan: "Public", clientShare: 60,
  domain: "fixture-two.example", website: "https://fixture-two.example"
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

assert.throws(() => stakingTesting.buildLivePlans(
  { ...snapshotSource, status: { lastProcessedTimestamp: "2026-09-22T11:00:00.000Z" } },
  rewardFixture,
  59_500,
  new Date("2026-09-22T12:00:00.000Z"),
  fixtureMetadata
), /stale/, "stale source cannot be marked live");

(async () => {
  stakingTesting.resetLastSuccessfulSnapshot();
  const firstSnapshot = { ...liveSnapshot, fetchedAt: "2026-09-22T11:00:00.000Z" };
  assert.equal((await stakingTesting.loadStakingPlans(async () => firstSnapshot)).source, "igniter-indexer");
  const fallbackSnapshot = await stakingTesting.loadStakingPlans(async () => { throw new Error("source unavailable"); });
  assert.equal(fallbackSnapshot.source, "last-known-good", "source failure uses last-known-good data");
  assert.equal(fallbackSnapshot.stale, true, "source failure is surfaced as stale");
  stakingTesting.resetLastSuccessfulSnapshot();
  const staticFallback = await stakingTesting.loadStakingPlans(async () => { throw new Error("initial source unavailable"); });
  assert.equal(staticFallback.source, "last-known-good", "static fallback is identified as last-known-good");
  assert.equal(staticFallback.stale, true, "static fallback is never live");
  console.log("protocol, eligible-count fail-closed, economics, and freshness tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
