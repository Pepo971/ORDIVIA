import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, cx, EmptyState, Field, Input, LinkButton, Notice, PageHeader, Select } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatEur, formatQty } from "@/lib/format";
import { getCategories, getFoodCost, getMenuItem, getPrepStations, getSupplierImpact } from "@/lib/menu-queries";
import { getProducts } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import { addRecipeLine, deleteMenuItem, removeRecipeLine, setItemPrice, updateMenuItem, updateRecipeLine } from "../actions";
import { ItemFields } from "../item-fields";
import { fmtPct, MenuNav } from "../menu-nav";

export const dynamic = "force-dynamic";

export default async function MenuItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ nuovo?: string; disattivata?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm("menu.manage");
  const item = await getMenuItem(id);
  if (!item) notFound();
  const supabase = await createClient();

  const [categories, stations, products, linesRes, lineCostsRes, costs, impact] = await Promise.all([
    getCategories(ctx.facility.id),
    getPrepStations(ctx.facility.id),
    getProducts(ctx.org.id),
    supabase.from("recipe_lines").select("id, product_id, qty, waste_pct, products(name, base_unit)").eq("menu_item_id", id),
    supabase.rpc("menu_recipe_costs", { p_item: id }),
    getFoodCost(ctx.facility.id),
    getSupplierImpact(ctx.facility.id).then((r) => r.filter((x) => x.menu_item_id === id)),
  ]);
  const lines = ((linesRes.data ?? []) as unknown as { id: string; product_id: string; qty: number; waste_pct: number; products: { name: string; base_unit: string } | null }[]).sort(
    (a, b) => (a.products?.name ?? "").localeCompare(b.products?.name ?? "", "it"),
  );
  const lineCost = new Map(((lineCostsRes.data ?? []) as { recipe_line_id: string; unit_cost: number | null; line_cost: number | null }[]).map((r) => [r.recipe_line_id, r]));
  const fc = costs.get(id);
  const totalImpact = impact.reduce((s, x) => s + x.impact_per_portion, 0);

  return (
    <div>
      <PageHeader
        title={item.name}
        subtitle={`${formatEur(item.price)} IVA ${item.vat_rate}% inclusa${item.active ? "" : " · non attiva"}`}
        action={<LinkButton href="/servizio/menu" variant="secondary">Tutto il menu</LinkButton>}
      />
      <MenuNav ctx={ctx} active="menu" />
      {sp.nuovo && <div className="mb-4"><Notice tone="ok">Voce creata. Ora inserisci gli ingredienti della ricetta.</Notice></div>}
      {sp.disattivata && <div className="mb-4"><Notice tone="warn">La voce è già usata in comande o etichette: è stata disattivata invece di essere eliminata.</Notice></div>}

      {fc && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label="Costo porzione" value={formatEur(fc.portion_cost)} hint={fc.missing_costs > 0 ? `${fc.missing_costs} ingredienti senza costo` : fc.ingredients === 0 ? "Nessuna ricetta" : undefined} tone={fc.missing_costs > 0 ? "warn" : undefined} />
          <Kpi label="Food cost" value={fmtPct(fc.food_cost_pct)} hint={`Obiettivo ${fmtPct(fc.target_food_cost_pct)}`} tone={fc.over_target ? "danger" : "ok"} />
          <Kpi label="Margine a porzione" value={formatEur(fc.margin)} hint={`Prezzo netto ${formatEur(fc.net_price)}`} />
          <Kpi
            label="Prezzo consigliato"
            value={fc.recommended_price == null ? "—" : formatEur(fc.recommended_price)}
            hint={fc.recommended_price != null ? `per ${fmtPct(fc.target_food_cost_pct)} di food cost` : "Serve una ricetta con costi"}
          />
        </div>
      )}

      {fc?.recommended_price != null && fc.over_target && (
        <Card className="mb-5 p-4">
          <ActionForm action={setItemPrice} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={item.id} />
            <p className="flex-1 text-sm text-ink">
              Il food cost è sopra l&apos;obiettivo. Per tornare al {fmtPct(fc.target_food_cost_pct)} il prezzo dovrebbe essere almeno <strong>{formatEur(fc.recommended_price)}</strong>.
            </p>
            <Input aria-label="Nuovo prezzo" name="price" type="number" min={0} step="0.01" inputMode="decimal" defaultValue={fc.recommended_price} className="w-28 text-right font-bold" />
            <SubmitButton variant="secondary">Applica prezzo</SubmitButton>
          </ActionForm>
        </Card>
      )}

      <Card className="mb-5 overflow-hidden">
        <CardHeader
          title="Ricetta (distinta base)"
          hint={`Quantità nell'unità del prodotto, per ${formatQty(item.yield_portions)} ${Number(item.yield_portions) === 1 ? "porzione" : "porzioni"}. Lo scarto aumenta la quantità da acquistare.`}
        />
        {lines.length === 0 ? (
          <EmptyState title="Nessun ingrediente" text="Aggiungi gli ingredienti dal catalogo prodotti: il costo arriva dal costo medio ponderato delle ricezioni." />
        ) : (
          <div className="divide-y divide-sand">
            {lines.map((l) => {
              const c = lineCost.get(l.id);
              return (
                <div key={l.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
                  <div>
                    <p className="flex flex-wrap items-center gap-2 font-bold text-night">
                      {l.products?.name}
                      {c?.unit_cost == null && <Badge tone="warn">Costo mancante</Badge>}
                    </p>
                    <p className="text-xs text-muted">
                      {c?.unit_cost != null ? `${formatEur(c.unit_cost)}/${l.products?.base_unit} · ${formatEur(c.line_cost)} a porzione` : "Registra una ricezione o un carico con costo per questo prodotto"}
                    </p>
                  </div>
                  <div className="flex items-start gap-2">
                    <ActionForm action={updateRecipeLine} className="flex items-center gap-2">
                      <input type="hidden" name="id" value={l.id} />
                      <input type="hidden" name="menu_item_id" value={item.id} />
                      <label className="flex items-center gap-1 text-xs text-muted">
                        <Input aria-label={`Quantità ${l.products?.name}`} name="qty" type="number" min={0} step="any" inputMode="decimal" defaultValue={Number(l.qty)} className="w-24 text-right font-bold" />
                        {l.products?.base_unit}
                      </label>
                      <label className="flex items-center gap-1 text-xs text-muted">
                        <Input aria-label={`Scarto ${l.products?.name}`} name="waste_pct" type="number" min={0} max={99} step="any" inputMode="decimal" defaultValue={Number(l.waste_pct)} className="w-16 text-right" />
                        % scarto
                      </label>
                      <SubmitButton variant="ghost" pendingText="…" className="px-2">Salva</SubmitButton>
                    </ActionForm>
                    <form action={removeRecipeLine}>
                      <input type="hidden" name="id" value={l.id} />
                      <input type="hidden" name="menu_item_id" value={item.id} />
                      <button aria-label={`Togli ${l.products?.name}`} className="h-11 w-11 rounded-xl text-xl text-muted hover:bg-danger-soft hover:text-danger">×</button>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="border-t border-sand bg-warm p-4">
          {products.length === 0 ? (
            <p className="text-sm text-muted">
              Il catalogo prodotti è vuoto. {can(ctx, "inventory.count", "suppliers.manage") ? <a className="font-bold underline" href="/scorte/prodotti">Aggiungi i prodotti</a> : "Chiedi a chi gestisce il magazzino di aggiungere i prodotti."}
            </p>
          ) : (
            <ActionForm action={addRecipeLine} resetOnSuccess>
              <input type="hidden" name="menu_item_id" value={item.id} />
              <div className="grid gap-3 sm:grid-cols-[1fr_7rem_6rem_auto] sm:items-end">
                <Field label="Ingrediente">
                  <Select name="product_id" required defaultValue="">
                    <option value="" disabled>Scegli un prodotto…</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} ({p.base_unit})</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Quantità">
                  <Input name="qty" type="number" min={0} step="any" inputMode="decimal" required placeholder="0,100" />
                </Field>
                <Field label="Scarto %">
                  <Input name="waste_pct" type="number" min={0} max={99} step="any" inputMode="decimal" placeholder="0" />
                </Field>
                <SubmitButton>Aggiungi</SubmitButton>
              </div>
            </ActionForm>
          )}
        </div>
      </Card>

      {impact.length > 0 && (
        <Card className="mb-5 overflow-hidden">
          <CardHeader title="Effetto aumenti fornitori" hint={`Impatto stimato: +${formatEur(totalImpact)} a porzione`} />
          <ul className="divide-y divide-sand">
            {impact.map((x) => (
              <li key={x.product_id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <div className="flex-1">
                  <p className="font-bold text-night">{x.product_name} <Badge tone="warn">+{fmtPct(x.increase_pct)}</Badge></p>
                  <p className="text-xs text-muted">{formatEur(x.old_unit_cost)} → {formatEur(x.new_unit_cost)}/{x.base_unit} · {x.source}</p>
                </div>
                <p className="font-extrabold text-danger">+{formatEur(x.impact_per_portion)}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-4 sm:p-5">
        <h2 className="mb-4 font-bold text-night">Dati della voce</h2>
        <ActionForm action={updateMenuItem}>
          <input type="hidden" name="id" value={item.id} />
          <ItemFields item={item} categories={categories} stations={stations} />
          <div className="mt-5 flex justify-end">
            <SubmitButton>Salva modifiche</SubmitButton>
          </div>
        </ActionForm>
        <form action={deleteMenuItem} className="mt-6 border-t border-sand pt-4">
          <input type="hidden" name="id" value={item.id} />
          <SubmitButton variant="danger" pendingText="Eliminazione…" confirm={`Eliminare «${item.name}» e la sua ricetta?`}>
            Elimina voce e ricetta
          </SubmitButton>
        </form>
      </Card>
    </div>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "danger" | "ok" | "warn" }) {
  return (
    <Card className="p-3.5">
      <p className="text-xs font-bold text-muted uppercase">{label}</p>
      <p className={cx("mt-1 text-xl font-extrabold", tone === "danger" ? "text-danger" : tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-night")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </Card>
  );
}
