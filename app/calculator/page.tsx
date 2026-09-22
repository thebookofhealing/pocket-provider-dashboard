import { permanentRedirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function CalculatorPage() {
  permanentRedirect("/rewards#calculator");
}
