import StakingDashboard from "@/app/staking/staking-dashboard";
import { getDashboardDataSafe } from "@/lib/pocket";

export const metadata = {
  title: "Staking | Pocket Network Analytics",
  description: "Explore Pocket supplier staking scenarios and model reward outcomes."
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function StakingPage() {
  const data = getDashboardDataSafe("30d").data;
  const rewards30d = data ? Number(data.totalRevenueUpokt) / 1_000_000 : 0;

  return (
    <StakingDashboard
      networkRewards30d={rewards30d}
      activeDomains={data?.activeProviders ?? 0}
      poktPriceUsd={data?.poktPriceUsd ?? 0}
      generatedAt={data?.generatedAt ?? null}
    />
  );
}
