import assert from "node:assert/strict";

import {
  buildProviderServiceOpportunity,
  getSelectionProbability,
  SESSION_SUPPLIER_SLOTS
} from "@/lib/opportunities";
import { derivePlanEconomics, isSourceFresh, normalizeSourceTimestamp } from "@/lib/staking-economics";
import { isEligibleSupplierSnapshotFresh, selectEligibleSupplierSnapshot } from "@/lib/eligible-suppliers";

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

console.log("protocol, eligible-count fail-closed, economics, and freshness tests passed");
