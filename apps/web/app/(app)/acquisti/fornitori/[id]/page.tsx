import { notFound } from "next/navigation";
import { priceChange, unitCost } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, EmptyState, Field, Input, LinkButton, Notice, PageHeader, Select } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDate, formatEur } from "@/lib/format";
import { UNITS } from "@/lib/labels";
import { getProducts, type Supplier } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import { addOffer, removeOffer, updateOfferPrice, updateSupplier } from "../../actions";
import { SupplierFields } from "../supplier-fields";

export const dynamic = "force-dynamic";

export default async function SupplierPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ nuovo?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm("suppliers.manage", "purchasing.approve");
  const supabase = await createClient();
  const { data: s } = await supabase.from("suppliers").select("*").eq("id", id).maybeSingle();
  if (!s) notFound();
  const editable = can(ctx, "suppliers.manage");

  const [{ data: offersData }, products, { data: history }] = await Promise.all([
    supabase.from("supplier_products").select("id, product_id, supplier_code, pack_label, pack_qty, price, vat_rate, preferred, updated_at, products(name, base_unit)").eq("supplier_id", id),
    getProducts(ctx.org.id),
    supabase.from("supplier_price_history").select("supplier_product_id, price, source, observed_at").eq("org_id", ctx.org.id).order("observed_at", { ascending: false }).limit(1000),
  ]);
  const offers = ((offersData ?? []) as unknown as {
    id: string; product_id: string; supplier_code: string | null; pack_label: string; pack_qty: number; price: number; vat_rate: number; preferred: boolean; updated_at: string;
    products: { name: string; base_unit: string } | null;
  }[]).sort((a, b) => (a.products?.name ?? "").localeCompare(b.products?.name ?? "", "it"));

  const histBy = new Map<string, { price: number; observed_at: string; source: string }[]>();
  for (const h of history ?? []) {
    const arr = histBy.get(h.supplier_product_id) ?? [];
    arr.push({ price: Number(h.price), observed_at: h.observed_at, source: h.source });
    histBy.set(h.supplier_product_id, arr);
  }

  return (
    <div>
      <PageHeader title={s.name} subtitle={s.active ? "Fornitore attivo" : "Fornitore non attivo: escluso dal riordino"} action={<LinkButton href="/acquisti/fornitori" variant="secondary">Tutti i fornitori</LinkButton>} />
      {sp.nuovo && <div className="mb-4"><Notice tone="ok">Fornitore creato. Ora aggiungi i prodotti che ti fornisce.</Notice></div>}

      <Card className="mb-5 overflow-hidden">
        <CardHeader title="Listino" hint="Prezzi IVA esclusa per confezione. Ogni variazione viene storicizzata." />
        {offers.length === 0 ? (
          <EmptyState title="Listino vuoto" text="Aggiungi i prodotti qui sotto." />
        ) : (
          <div className="divide-y divide-sand">
            {offers.map((o) => {
              const h = histBy.get(o.id) ?? [];
              const prev = h.find((x) => x.price !== Number(o.price));
              const ch = prev ? priceChange(prev.price, Number(o.price)) : null;
              return (
                <div key={o.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-bold text-night">
                      {o.products?.name}
                      {o.preferred && <Badge tone="teal">Preferito</Badge>}
                      {ch && ch.direction !== "invariato" && (
                        <Badge tone={ch.direction === "aumento" ? (ch.anomalous ? "danger" : "warn") : "ok"}>
                          {ch.direction === "aumento" ? "+" : ""}
                          {ch.pct}% dal {formatDate(prev!.observed_at)}
                        </Badge>
                      )}
                    </p>
                    <p className="text-sm text-muted">
                      {o.pack_label} = {Number(o.pack_qty)} {o.products?.base_unit} · {formatEur(unitCost(Number(o.price), Number(o.pack_qty)))}/{o.products?.base_unit}
                      {o.supplier_code && ` · cod. ${o.supplier_code}`}
                    </p>
                  </div>
                  {editable ? (
                    <div className="flex items-start gap-2">
                      <ActionForm action={updateOfferPrice} className="flex items-center gap-2">
                        <input type="hidden" name="id" value={o.id} />
                        <label className="sr-only" htmlFor={`p-${o.id}`}>Prezzo</label>
                        <Input id={`p-${o.id}`} name="price" type="number" min={0} step="0.0001" inputMode="decimal" defaultValue={Number(o.price)} className="w-28 text-right font-bold" />
                        <SubmitButton variant="secondary" pendingText="…">Aggiorna</SubmitButton>
                      </ActionForm>
                      <form action={removeOffer}>
                        <input type="hidden" name="id" value={o.id} />
                        <button aria-label={`Togli ${o.products?.name} dal listino`} className="h-11 w-11 rounded-xl text-xl text-muted hover:bg-danger-soft hover:text-danger">×</button>
                      </form>
                    </div>
                  ) : (
                    <p className="font-bold text-night">{formatEur(o.price)}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {editable && (
          <div className="border-t border-sand bg-warm p-4">
            <h3 className="mb-3 font-bold text-night">Aggiungi al listino</h3>
            <ActionForm action={addOffer} resetOnSuccess>
              <input type="hidden" name="supplier_id" value={s.id} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Prodotto" hint="Oppure creane uno nuovo qui accanto">
                  <Select name="product_id" defaultValue="__new">
                    <option value="__new">+ Nuovo prodotto</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} ({p.base_unit})</option>
                    ))}
                  </Select>
                </Field>
                <div className="grid grid-cols-[1fr_6rem] gap-2">
                  <Field label="Nome nuovo prodotto">
                    <Input name="new_product_name" placeholder="Es. Acqua naturale 50 cl" />
                  </Field>
                  <Field label="Unità">
                    <Select name="new_product_unit" defaultValue="pz">
                      {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </Select>
                  </Field>
                </div>
                <Field label="Confezione" hint="Come la vende il fornitore">
                  <Input name="pack_label" placeholder="Es. fardello 24 bottiglie" required />
                </Field>
                <Field label="Unità per confezione" hint="Nell’unità del prodotto (pz, kg, l…)">
                  <Input name="pack_qty" type="number" min={0} step="any" inputMode="decimal" defaultValue={1} required />
                </Field>
                <Field label="Prezzo per confezione (€)">
                  <Input name="price" type="number" min={0} step="0.0001" inputMode="decimal" required />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="IVA %">
                    <Input name="vat_rate" type="number" min={0} max={30} defaultValue={22} />
                  </Field>
                  <Field label="Codice fornitore">
                    <Input name="supplier_code" />
                  </Field>
                </div>
                <label className="flex items-center gap-2 text-sm font-bold text-night">
                  <input type="checkbox" name="preferred" className="h-5 w-5 min-h-0 accent-teal" /> Fornitore preferito per questo prodotto
                </label>
              </div>
              <div className="mt-4 flex justify-end">
                <SubmitButton>Aggiungi</SubmitButton>
              </div>
            </ActionForm>
          </div>
        )}
      </Card>

      {editable && (
        <Card className="p-4 sm:p-5">
          <h2 className="mb-4 font-bold text-night">Dati del fornitore</h2>
          <ActionForm action={updateSupplier}>
            <input type="hidden" name="id" value={s.id} />
            <SupplierFields s={s as Supplier} />
            <label className="mt-4 flex items-center gap-2 text-sm font-bold text-night">
              <input type="checkbox" name="active" defaultChecked={s.active} className="h-5 w-5 min-h-0 accent-teal" /> Fornitore attivo
            </label>
            <div className="mt-5 flex justify-end">
              <SubmitButton>Salva modifiche</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
