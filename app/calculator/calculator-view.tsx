"use client";

import RevenueCalculator from "@/app/revenue-calculator";
import type { SerializedDashboardData } from "@/lib/types";

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

export default function CalculatorView({ data }: { data: SerializedDashboardData }) {
  const services: CalculatorService[] = data.services.map((s) => ({
    serviceId: s.serviceId,
    serviceName: s.serviceName,
    relays: s.relays,
    revenueUpokt: s.revenueUpokt,
    providerCount: s.providerCount,
    supplierCount: s.supplierCount,
    eligibleSupplierCount: s.eligibleSupplierCount,
    appsStaked: s.appsStaked,
  }));

  return (
    <main className="page">
      <RevenueCalculator
        services={services}
        suppliersPerSession={data.suppliersPerSession}
        sessionFetchedAt={data.sessionFetchedAt}
        sessionStale={data.sessionStale}
      />
    </main>
  );
}
