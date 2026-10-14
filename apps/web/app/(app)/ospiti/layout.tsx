import { SectionTabs } from "@/components/section-tabs";
import { can, getContext } from "@/lib/context";

export default async function OspitiLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getContext();
  const tabs = [
    can(ctx, "reservations.manage") && { href: "/ospiti/prenotazioni", label: "Prenotazioni" },
    can(ctx, "crm.view", "crm.manage", "reservations.manage") && { href: "/ospiti/clienti", label: "Clienti" },
    can(ctx, "reservations.manage", "rooms.operate", "rooms.manage", "pos.operate", "beach.operate") && { href: "/ospiti/richieste", label: "Richieste" },
    can(ctx, "portal.manage") && { href: "/ospiti/portale", label: "Portale QR" },
  ].filter(Boolean) as { href: string; label: string }[];
  return (
    <div>
      <SectionTabs items={tabs} />
      {children}
    </div>
  );
}
