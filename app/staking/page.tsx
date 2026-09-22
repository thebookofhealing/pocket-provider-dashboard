import StakingDashboard from "@/app/staking/staking-dashboard";
import { getStakingPlans } from "@/lib/staking-plans";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Supplier Staking | Pocket Network Analytics",
  description: "Compare public Pocket Network supplier staking plans and project six-month reward outcomes."
};

export default async function StakingPage() {
  const plans = await getStakingPlans();
  return <StakingDashboard {...plans} />;
}
