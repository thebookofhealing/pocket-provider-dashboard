export type ProviderFreshnessInput = {
  rewardStatus: "live" | "stale" | "unavailable";
  valueSource: "live-derived" | "stale-derived" | "provider-lkg" | "static-cold-start";
};

export function getProviderFreshnessLabel(plans: readonly ProviderFreshnessInput[]): string {
  const liveCount = plans.filter((plan) => plan.rewardStatus === "live").length;
  const staleCount = plans.filter((plan) => plan.rewardStatus === "stale" || plan.valueSource === "provider-lkg" || plan.valueSource === "stale-derived").length;
  const unavailableCount = plans.filter((plan) => plan.rewardStatus === "unavailable").length;
  if (plans.length > 0 && liveCount === plans.length) return "Live rewards";
  if (liveCount > 0) return "Mixed provider freshness";
  if (staleCount > 0) return "Stale provider data";
  if (unavailableCount > 0) return "Provider rewards unavailable";
  return "Provider rewards unavailable";
}
