import { getDashboardHealth } from "@/lib/dashboard-health";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getDashboardHealth());
}
