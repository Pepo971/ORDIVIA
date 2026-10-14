import { redirect } from "next/navigation";
import { can, getContext } from "@/lib/context";

export default async function LavoroIndex({ searchParams }: { searchParams: Promise<{ vista?: string }> }) {
  const ctx = await getContext();
  const sp = await searchParams;
  if (can(ctx, "tasks.perform", "tasks.manage")) redirect(`/lavoro/attivita${sp.vista ? `?vista=${encodeURIComponent(sp.vista)}` : ""}`);
  redirect("/lavoro/turni");
}
