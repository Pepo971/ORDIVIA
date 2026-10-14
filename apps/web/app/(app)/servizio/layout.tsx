import { SectionTabs } from "@/components/section-tabs";
import { can, getContext } from "@/lib/context";

/** Sottosezioni del Servizio: ognuno vede solo le schede del proprio lavoro. */
export default async function ServizioLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getContext();
  const tabs = [
    can(ctx, "pos.operate") && { href: "/servizio/sala", label: "Sala e comande" },
    can(ctx, "pos.kitchen") && { href: "/servizio/cucina", label: "Cucina e bar" },
    can(ctx, "pos.kitchen", "pos.supervise") && { href: "/servizio/pass", label: "Pass" },
    can(ctx, "pos.operate", "pos.supervise") && { href: "/servizio/cassa", label: "Cassa" },
    can(ctx, "beach.operate", "beach.manage") && { href: "/servizio/spiaggia", label: "Spiaggia" },
    can(ctx, "menu.manage") && { href: "/servizio/menu", label: "Menu e ricette" },
  ].filter(Boolean) as { href: string; label: string }[];
  return (
    <div>
      <SectionTabs items={tabs} />
      {children}
    </div>
  );
}
