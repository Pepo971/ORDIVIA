import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, EmptyState, Field, Input, LinkButton, PageHeader, Select, Tabs } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { UNITS } from "@/lib/labels";
import { getProducts, getWarehouses } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import { createProduct, saveStockSettings } from "../actions";

export const metadata = { title: "Prodotti e scorte minime" };
export const dynamic = "force-dynamic";

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ magazzino?: string }> }) {
  const ctx = await requirePerm("inventory.count", "suppliers.manage");
  const sp = await searchParams;
  const supabase = await createClient();
  const [products, warehouses] = await Promise.all([getProducts(ctx.org.id), getWarehouses(ctx.facility.id)]);
  const wh = warehouses.find((w) => w.id === sp.magazzino) ?? warehouses[0];
  const { data: settings } = wh ? await supabase.from("stock_settings").select("product_id, min_qty, par_qty").eq("warehouse_id", wh.id) : { data: [] };
  const sMap = new Map((settings ?? []).map((s) => [s.product_id, s]));

  return (
    <div>
      <PageHeader
        title="Prodotti e scorte minime"
        subtitle="Sotto il minimo Ordivia propone il riordino; il livello di riordino è la quantità a cui tornare."
        action={<LinkButton href="/scorte" variant="secondary">Scorte</LinkButton>}
      />
      <Card className="mb-5 overflow-hidden">
        <CardHeader title="Nuovo prodotto" />
        <ActionForm action={createProduct} resetOnSuccess className="p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_6rem_7rem_7rem]">
            <Field label="Nome">
              <Input name="name" placeholder="Es. Limoni" required />
            </Field>
            <Field label="Unità">
              <Select name="base_unit" defaultValue="pz">
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </Select>
            </Field>
            <Field label="Minimo">
              <Input name="min_qty" type="number" min={0} step="any" inputMode="decimal" />
            </Field>
            <Field label="Riordina a">
              <Input name="par_qty" type="number" min={0} step="any" inputMode="decimal" />
            </Field>
          </div>
          {wh && <input type="hidden" name="warehouse_id" value={wh.id} />}
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-muted">{wh ? `Minimo e riordino valgono per ${wh.name}.` : ""}</p>
            <SubmitButton>Aggiungi prodotto</SubmitButton>
          </div>
        </ActionForm>
      </Card>

      {warehouses.length > 0 && (
        <Tabs active={wh?.id ?? ""} items={warehouses.map((w) => ({ key: w.id, label: w.name, href: `/scorte/prodotti?magazzino=${w.id}` }))} />
      )}
      <Card className="overflow-hidden">
        {products.length === 0 || !wh ? (
          <EmptyState title="Nessun prodotto" text="Aggiungi i prodotti che finiscono più spesso, o importali dal listino di un fornitore." />
        ) : (
          <ActionForm action={saveStockSettings}>
            <input type="hidden" name="warehouse_id" value={wh.id} />
            <div className="grid grid-cols-[1fr_6rem_6rem] gap-2 border-b border-sand bg-warm px-4 py-2 text-xs font-bold text-muted uppercase">
              <span>Prodotto</span>
              <span className="text-right">Minimo</span>
              <span className="text-right">Riordina a</span>
            </div>
            <div className="divide-y divide-sand">
              {products.map((p) => {
                const s = sMap.get(p.id);
                return (
                  <div key={p.id} className="grid grid-cols-[1fr_6rem_6rem] items-center gap-2 px-4 py-2">
                    <input type="hidden" name="product_id" value={p.id} />
                    <span className="font-bold text-night">
                      {p.name} <span className="font-normal text-muted">({p.base_unit})</span>
                    </span>
                    <Input aria-label={`Minimo ${p.name}`} name="min_qty" type="number" min={0} step="any" inputMode="decimal" defaultValue={s ? Number(s.min_qty) : ""} className="text-right" />
                    <Input aria-label={`Riordina a ${p.name}`} name="par_qty" type="number" min={0} step="any" inputMode="decimal" defaultValue={s ? Number(s.par_qty) : ""} className="text-right" />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-end bg-warm px-4 py-3">
              <SubmitButton>Salva scorte di {wh.name}</SubmitButton>
            </div>
          </ActionForm>
        )}
      </Card>
    </div>
  );
}
