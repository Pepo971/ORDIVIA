import { redirect } from "next/navigation";
import { can, getContext } from "@/lib/context";

export default async function OspitiIndex() {
  const ctx = await getContext();
  if (can(ctx, "reservations.manage")) redirect("/ospiti/prenotazioni");
  if (can(ctx, "crm.view", "crm.manage")) redirect("/ospiti/clienti");
  if (can(ctx, "portal.manage")) redirect("/ospiti/portale");
  redirect("/oggi?negato=1");
}
