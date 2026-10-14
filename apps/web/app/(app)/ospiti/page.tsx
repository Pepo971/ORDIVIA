import { redirect } from "next/navigation";
import { can, getContext } from "@/lib/context";

export default async function OspitiIndex() {
  const ctx = await getContext();
  if (can(ctx, "reservations.manage")) redirect("/ospiti/prenotazioni");
  if (can(ctx, "crm.view", "crm.manage")) redirect("/ospiti/clienti");
  if (can(ctx, "portal.manage")) redirect("/ospiti/portale");
  if (can(ctx, "rooms.operate", "rooms.manage", "pos.operate", "beach.operate", "maintenance.manage")) redirect("/ospiti/richieste");
  redirect("/oggi?negato=1");
}
