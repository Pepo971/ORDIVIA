import { Tabs } from "@/components/ui";
import { can, type AppContext } from "@/lib/context";

export type MenuSection = "menu" | "food-cost" | "centri" | "haccp" | "temperature" | "etichette";

/** Navigazione interna del modulo Menu e HACCP: ognuno vede solo le schede del proprio lavoro. */
export function MenuNav({ ctx, active }: { ctx: AppContext; active: MenuSection }) {
  const items = [
    can(ctx, "menu.manage") && { key: "menu", label: "Menu e ricette", href: "/servizio/menu" },
    can(ctx, "menu.manage", "finance.view") && { key: "food-cost", label: "Food cost", href: "/servizio/menu/food-cost" },
    can(ctx, "menu.manage") && { key: "centri", label: "Centri di produzione", href: "/servizio/menu/centri" },
    can(ctx, "haccp.record", "menu.manage", "pos.kitchen") && { key: "haccp", label: "HACCP", href: "/servizio/menu/haccp" },
    can(ctx, "haccp.record", "menu.manage", "pos.kitchen") && { key: "temperature", label: "Temperature", href: "/servizio/menu/haccp/temperature" },
    can(ctx, "haccp.record", "menu.manage", "pos.kitchen") && { key: "etichette", label: "Etichette e lotti", href: "/servizio/menu/haccp/etichette" },
  ].filter(Boolean) as { key: string; label: string; href: string }[];
  if (items.length <= 1) return null;
  return <Tabs items={items} active={active} />;
}

export const PREP_KIND_LABEL: Record<string, string> = {
  cucina: "Cucina",
  pizzeria: "Pizzeria",
  bar: "Bar",
  dessert: "Pasticceria / dessert",
  griglia: "Griglia",
  altro: "Altro",
};

export const EQUIPMENT_KIND_LABEL: Record<string, string> = {
  frigorifero: "Frigorifero",
  congelatore: "Congelatore",
  abbattitore: "Abbattitore",
  cella: "Cella frigorifera",
  vetrina: "Vetrina refrigerata",
  altro: "Altro",
};

/** Limiti di default per tipo di attrezzatura (°C). */
export const EQUIPMENT_DEFAULTS: Record<string, [number, number]> = {
  frigorifero: [0, 4],
  congelatore: [-22, -18],
  abbattitore: [-40, 3],
  cella: [0, 4],
  vetrina: [0, 6],
  altro: [0, 8],
};

export const fmtPct = (v: number | null | undefined) => (v == null ? "—" : `${new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 }).format(v)}%`);
export const fmtTemp = (v: number) => `${new Intl.NumberFormat("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v)} °C`;
