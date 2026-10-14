import { redirect } from "next/navigation";
import { can, getContext } from "@/lib/context";

export default async function ServizioIndex() {
  const ctx = await getContext();
  if (can(ctx, "pos.operate")) redirect("/servizio/sala");
  if (can(ctx, "pos.kitchen")) redirect("/servizio/cucina");
  if (can(ctx, "beach.operate", "beach.manage")) redirect("/servizio/spiaggia");
  if (can(ctx, "pos.supervise")) redirect("/servizio/cassa");
  if (can(ctx, "menu.manage")) redirect("/servizio/menu");
  if (can(ctx, "haccp.record")) redirect("/servizio/menu/haccp");
  redirect("/oggi?negato=1");
}
