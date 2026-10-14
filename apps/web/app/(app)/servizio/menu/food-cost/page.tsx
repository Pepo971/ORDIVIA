import Link from "next/link";
import { rankByProfit } from "@ordivia/domain";
import { Badge, Card, CardHeader, cx, EmptyState, LinkButton, PageHeader, Tabs } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDate, formatEur } from "@/lib/format";
import { getCategories, getFoodCost, getMenuItems, getSupplierImpact } from "@/lib/menu-queries";
import { fmtPct, MenuNav } from "../menu-nav";

export const metadata = { title: "Food cost" };
export const dynamic = "force-dynamic";

type View = "tutte" | "sopra" | "costi" | "aumenti";

export default async function FoodCostPage({ searchParams }: { searchParams: Promise<{ vista?: string }> }) {
  const ctx = await requirePerm("menu.manage", "finance.view");
  const sp = await searchParams;
  const view: View = (["tutte", "sopra", "costi", "aumenti"] as const).find((v) => v === sp.vista) ?? "tutte";
  const editable = can(ctx, "menu.manage");

  const [items, categories, costs, impact] = await Promise.all([
    getMenuItems(ctx.facility.id),
    getCategories(ctx.facility.id),
    getFoodCost(ctx.facility.id),
    getSupplierImpact(ctx.facility.id, 90),
  ]);
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const rows = items
    .filter((i) => i.active)
    .map((i) => ({ item: i, fc: costs.get(i.id)! }))
    .filter((r) => r.fc);
  const withRecipe = rows.filter((r) => r.fc.ingredients > 0);
  const over = withRecipe.filter((r) => r.fc.over_target);
  const missing = rows.filter((r) => r.fc.missing_costs > 0 || r.fc.ingredients === 0);

  const ranked = rankByProfit(withRecipe.filter((r) => r.fc.missing_costs === 0).map((r) => ({ id: r.item.id, margin: r.fc.margin, foodCostPct: r.fc.food_cost_pct, r })));
  const top = ranked.slice(0, 5);
  const bottom = ranked.length > 5 ? ranked.slice(-5).reverse() : [];

  const fcValues = withRecipe.map((r) => r.fc.food_cost_pct).filter((v): v is number => v != null);
  const avgFc = fcValues.length ? Math.round((fcValues.reduce((s, v) => s + v, 0) / fcValues.length) * 10) / 10 : null;

  // Effetto aumenti raggruppato per voce
  const impactByItem = new Map<string, { total: number; lines: typeof impact }>();
  for (const x of impact) {
    const g = impactByItem.get(x.menu_item_id) ?? { total: 0, lines: [] };
    g.total += x.impact_per_portion;
    g.lines.push(x);
    impactByItem.set(x.menu_item_id, g);
  }
  const itemById = new Map(items.map((i) => [i.id, i]));
  const impactRows = [...impactByItem.entries()].map(([id, g]) => ({ item: itemById.get(id)!, fc: costs.get(id), ...g })).filter((r) => r.item).sort((a, b) => b.total - a.total);

  const list = view === "sopra" ? over : view === "costi" ? missing : rows;
  const sorted = [...list].sort((a, b) => (b.fc.food_cost_pct ?? -1) - (a.fc.food_cost_pct ?? -1));

  return (
    <div>
      <PageHeader
        title="Food cost"
        subtitle="Costo teorico dalle ricette e dal costo medio ponderato degli ingredienti. Prezzi di vendita al netto dell'IVA."
        action={editable ? <LinkButton href="/servizio/menu" variant="secondary">Menu e ricette</LinkButton> : undefined}
      />
      <MenuNav ctx={ctx} active="food-cost" />

      {rows.length === 0 ? (
        <Card>
          <EmptyState title="Nessuna voce attiva" text="Il food cost si calcola sulle voci del menu con una ricetta." action={editable ? <LinkButton href="/servizio/menu/nuova">Nuova voce</LinkButton> : undefined} />
        </Card>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Food cost medio" value={fmtPct(avgFc)} hint={`${withRecipe.length} voci con ricetta`} />
            <Stat label="Sopra obiettivo" value={String(over.length)} tone={over.length ? "danger" : "ok"} />
            <Stat label="Costi incompleti" value={String(missing.length)} hint="senza ricetta o costi" tone={missing.length ? "warn" : undefined} />
            <Stat label="Toccate da aumenti" value={String(impactRows.length)} hint="ultimi 90 giorni" tone={impactRows.length ? "warn" : undefined} />
          </div>

          <Tabs
            active={view}
            items={[
              { key: "tutte", label: "Tutte", href: "/servizio/menu/food-cost" },
              { key: "sopra", label: "Sopra obiettivo", href: "/servizio/menu/food-cost?vista=sopra", count: over.length },
              { key: "costi", label: "Costi mancanti", href: "/servizio/menu/food-cost?vista=costi", count: missing.length },
              { key: "aumenti", label: "Effetto aumenti", href: "/servizio/menu/food-cost?vista=aumenti", count: impactRows.length },
            ]}
          />

          {view === "aumenti" ? (
            <Card className="overflow-hidden">
              <CardHeader title="Effetto aumenti fornitori" hint="Ingredienti con ultimo costo superiore al costo medio, o listino aumentato negli ultimi 90 giorni." />
              {impactRows.length === 0 ? (
                <EmptyState title="Nessun aumento rilevato" text="Quando un fornitore alza il listino o una ricezione costa più della media, qui vedi quali piatti ne risentono." />
              ) : (
                <ul className="divide-y divide-sand">
                  {impactRows.map((r) => {
                    const newFc = r.fc && r.fc.net_price > 0 ? ((r.fc.portion_cost + r.total) / r.fc.net_price) * 100 : null;
                    return (
                      <li key={r.item.id} className="px-4 py-3">
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <ItemLink id={r.item.id} name={r.item.name} editable={editable} />
                            <p className="text-xs text-muted">
                              Food cost {fmtPct(r.fc?.food_cost_pct)} → <strong className={cx(newFc != null && r.fc && newFc > r.fc.target_food_cost_pct ? "text-danger" : "text-ink")}>{fmtPct(newFc == null ? null : Math.round(newFc * 10) / 10)}</strong> ai nuovi prezzi
                            </p>
                          </div>
                          <p className="text-right font-extrabold text-danger">+{formatEur(r.total)}<span className="block text-xs font-normal text-muted">a porzione</span></p>
                        </div>
                        <ul className="mt-2 space-y-1">
                          {r.lines.map((x) => (
                            <li key={x.product_id} className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                              <span className="font-bold text-ink">{x.product_name}</span>
                              <Badge tone="warn">+{fmtPct(x.increase_pct)}</Badge>
                              <span>{formatEur(x.old_unit_cost)} → {formatEur(x.new_unit_cost)}/{x.base_unit}</span>
                              <span>· {x.source} · {formatDate(x.observed_at, ctx.facility.timezone)}</span>
                            </li>
                          ))}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          ) : (
            <Card className="overflow-hidden">
              {sorted.length === 0 ? (
                <EmptyState title={view === "sopra" ? "Nessuna voce sopra obiettivo" : "Tutti i costi sono completi"} />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-warm text-left text-xs text-muted uppercase">
                      <tr>
                        <th className="px-4 py-2">Voce</th>
                        <th className="px-2 py-2 text-right">Prezzo</th>
                        <th className="px-2 py-2 text-right">Costo</th>
                        <th className="px-2 py-2 text-right">FC %</th>
                        <th className="hidden px-2 py-2 text-right sm:table-cell">Margine</th>
                        <th className="hidden px-4 py-2 text-right md:table-cell">Consigliato</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-sand">
                      {sorted.map(({ item, fc }) => (
                        <tr key={item.id} className={cx(fc.over_target && "bg-danger-soft/40")}>
                          <td className="px-4 py-2.5">
                            <ItemLink id={item.id} name={item.name} editable={editable} />
                            <p className="flex flex-wrap gap-1.5 text-xs text-muted">
                              {item.category_id && <span>{catName.get(item.category_id)}</span>}
                              {fc.ingredients === 0 && <Badge>Senza ricetta</Badge>}
                              {fc.missing_costs > 0 && <Badge tone="warn">{fc.missing_costs} senza costo</Badge>}
                            </p>
                          </td>
                          <td className="px-2 py-2.5 text-right">{formatEur(item.price)}</td>
                          <td className="px-2 py-2.5 text-right">{fc.ingredients > 0 ? formatEur(fc.portion_cost) : "—"}</td>
                          <td className={cx("px-2 py-2.5 text-right font-extrabold", fc.over_target ? "text-danger" : "text-night")}>
                            {fc.ingredients > 0 ? fmtPct(fc.food_cost_pct) : "—"}
                            <span className="block text-xs font-normal text-muted">obiettivo {fmtPct(fc.target_food_cost_pct)}</span>
                          </td>
                          <td className="hidden px-2 py-2.5 text-right sm:table-cell">{fc.ingredients > 0 ? formatEur(fc.margin) : "—"}</td>
                          <td className={cx("hidden px-4 py-2.5 text-right md:table-cell", fc.over_target && "font-bold text-danger")}>{fc.recommended_price != null ? formatEur(fc.recommended_price) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          {view === "tutte" && ranked.length > 0 && (
            <div className="mt-5 grid gap-5 md:grid-cols-2">
              <RankCard title="Più redditizie" hint="Margine di contribuzione a porzione" rows={top.map((x) => x.r)} editable={editable} />
              {bottom.length > 0 && <RankCard title="Meno redditizie" hint="Da rivedere: prezzo, porzione o ricetta" rows={bottom.map((x) => x.r)} editable={editable} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ItemLink({ id, name, editable }: { id: string; name: string; editable: boolean }) {
  return editable ? (
    <Link href={`/servizio/menu/${id}`} className="font-bold text-night underline-offset-4 hover:underline">{name}</Link>
  ) : (
    <span className="font-bold text-night">{name}</span>
  );
}

function RankCard({
  title,
  hint,
  rows,
  editable,
}: {
  title: string;
  hint: string;
  rows: { item: { id: string; name: string }; fc: { margin: number; food_cost_pct: number | null; over_target: boolean } }[];
  editable: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} hint={hint} />
      <ol className="divide-y divide-sand">
        {rows.map((r, i) => (
          <li key={r.item.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="w-5 text-muted">{i + 1}.</span>
            <span className="flex-1"><ItemLink id={r.item.id} name={r.item.name} editable={editable} /></span>
            <span className={cx("text-xs", r.fc.over_target ? "font-bold text-danger" : "text-muted")}>{fmtPct(r.fc.food_cost_pct)}</span>
            <span className="w-20 text-right font-extrabold text-night">{formatEur(r.fc.margin)}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "danger" | "ok" | "warn" }) {
  return (
    <Card className="p-3.5">
      <p className="text-xs font-bold text-muted uppercase">{label}</p>
      <p className={cx("mt-1 text-xl font-extrabold", tone === "danger" ? "text-danger" : tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-night")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </Card>
  );
}
