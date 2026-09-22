import StakingDashboard from "@/app/staking/staking-dashboard";
import { getStakingPlans } from "@/lib/staking-plans";

export const metadata = {
  title: "Supplier Staking | Pocket Network Analytics",
  description: "Compare public Pocket Network supplier staking plans and project six-month reward outcomes."
};

export default async function StakingPage() {
  const plans = await getStakingPlans();
  return <StakingDashboard plans={plans.plans} fetchedAt={plans.fetchedAt} stale={plans.stale} source={plans.source} />;
}
