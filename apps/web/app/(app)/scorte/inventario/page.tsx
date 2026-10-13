import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, EmptyState, Input, LinkButton, PageHeader, Tabs } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { getProducts, getWarehouses } from "@/lib/queries";
import { applyCount } from "../actions";

export const metadata = { title: "Inventario" };
export const dynamic = "force-dynamic";

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ magazzino?: string }> }) {
  const ctx = await requirePerm("inventory.count");
  const sp = await searchParams;
  const [products, warehouses] = await Promise.all([getProducts(ctx.org.id), getWarehouses(ctx.facility.id)]);
  const wh = warehouses.find((w) => w.id === sp.magazzino) ?? warehouses[0];

  return (
    <div>
      <PageHeader
        title="Inventario"
        subtitle="Conta alla cieca: inserisci solo ciò che vedi sugli scaffali. Ordivia calcola le differenze e registra le rettifiche."
        action={<LinkButton href="/scorte" variant="secondary">Scorte</LinkButton>}
      />
      <Tabs active={wh?.id ?? ""} items={warehouses.map((w) => ({ key: w.id, label: w.name, href: `/scorte/inventario?magazzino=${w.id}` }))} />
      <Card className="overflow-hidden">
        {!wh || products.length === 0 ? (
          <EmptyState title="Niente da contare" text="Crea prima i prodotti." action={<LinkButton href="/scorte/prodotti">Prodotti</LinkButton>} />
        ) : (
          <ActionForm action={applyCount}>
            <CardHeader title={`Conta · ${wh.name}`} hint="Lascia vuoti i prodotti che non hai contato: non verranno toccati." />
            <input type="hidden" name="warehouse_id" value={wh.id} />
            <div className="divide-y divide-sand">
              {products.map((p) => (
                <label key={p.id} className="grid grid-cols-[1fr_8rem] items-center gap-3 px-4 py-2">
                  <input type="hidden" name="product_id" value={p.id} />
                  <span className="font-bold text-night">{p.name}</span>
                  <span className="relative">
                    <Input name="counted" type="number" min={0} step="any" inputMode="decimal" className="pr-10 text-right font-bold" aria-label={`Quantità contata ${p.name}`} />
                    <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted">{p.base_unit}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="flex justify-end bg-warm px-4 py-3">
              <SubmitButton pendingText="Calcolo differenze…" confirm="Registrare la conta? Le differenze diventano rettifiche di magazzino.">
                Registra conta
              </SubmitButton>
            </div>
          </ActionForm>
        )}
      </Card>
    </div>
  );
}
