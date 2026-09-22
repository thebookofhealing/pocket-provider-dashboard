import RevenueCalculator from "@/app/revenue-calculator";
import { getDashboardDataSafe } from "@/lib/pocket";

export const metadata = {
  title: "Provider Rewards Calculator | Pocket Network Analytics",
  description: "Model potential provider rewards across active Pocket Network services."
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

type CalculatorService = {
  serviceId: string;
  serviceName: string;
  relays: number;
  revenueUpokt: string;
  providerCount: number;
  supplierCount?: number;
  eligibleSupplierCount?: number;
  appsStaked?: number;
};

export default async function RewardsPage() {
  const result = getDashboardDataSafe("30d");
  const data = result.data;

  if (!data) {
    return (
      <main className="page">
        <section className="panel section explorer-empty">
          <h1 className="section-title">Provider Rewards Calculator is warming up.</h1>
          <p className="section-subtitle">The 30d reward snapshot is still being prepared. Refresh shortly to use the calculator.</p>
        </section>
      </main>
    );
  }

  const calculatorServices: CalculatorService[] = data.services.map((service) => ({
    serviceId: service.serviceId,
    serviceName: service.serviceName,
    relays: service.relays,
    revenueUpokt: service.revenueUpokt.toString(),
    providerCount: service.providerCount,
    supplierCount: service.supplierCount,
    eligibleSupplierCount: service.eligibleSupplierCount,
    appsStaked: service.appsStaked,
  }));

  return (
    <main className="page explorer-page">
      <section className="page-heading" style={{ padding: '32px var(--page-padding, 24px) 0' }}>
        <h1>Provider Rewards Calculator</h1>
        <p>
          Leverage historical data to model potential rewards for deploying services on Pocket Network
        </p>
      </section>

      <RevenueCalculator
        services={calculatorServices}
        suppliersPerSession={data.suppliersPerSession}
        sessionFetchedAt={data.sessionFetchedAt}
        sessionStale={data.sessionStale}
      />
    </main>
  );
}
