import { Badge, Card, CardHeader, cx, EmptyState, LinkButton, PageHeader, Tabs } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatQty } from "@/lib/format";
import { getProducts, getStock, getWarehouses } from "@/lib/queries";
import { MovementForm } from "./movement-form";

export const metadata = { title: "Scorte" };
export const dynamic = "force-dynamic";

export default async function ScortePage({ searchParams }: { searchParams: Promise<{ magazzino?: string }> }) {
  const ctx = await requirePerm("inventory.view");
  const sp = await searchParams;
  const [stock, warehouses, products] = await Promise.all([getStock(ctx), getWarehouses(ctx.facility.id), getProducts(ctx.org.id)]);
  const wh = warehouses.find((w) => w.id === sp.magazzino);
  const lines = wh ? stock.filter((s) => s.warehouse.id === wh.id) : stock;
  const below = lines.filter((l) => l.belowMin).length;
  const canMove = can(ctx, "inventory.move", "receiving.perform");

  return (
    <div>
      <PageHeader
        title="Scorte"
        subtitle={below > 0 ? `${below} ${below === 1 ? "prodotto è" : "prodotti sono"} sotto la scorta minima.` : "Giacenze calcolate da tutti i movimenti registrati."}
        action={
          <div className="flex flex-wrap gap-2">
            {can(ctx, "inventory.count") && <LinkButton href={`/scorte/inventario${wh ? `?magazzino=${wh.id}` : ""}`} variant="secondary">Inventario</LinkButton>}
            {can(ctx, "inventory.count", "suppliers.manage") && <LinkButton href="/scorte/prodotti" variant="secondary">Prodotti e minimi</LinkButton>}
            <LinkButton href="/scorte/movimenti" variant="ghost">Movimenti</LinkButton>
          </div>
        }
      />
      <Tabs
        active={wh?.id ?? "tutti"}
        items={[{ key: "tutti", label: "Tutti", href: "/scorte" }, ...warehouses.map((w) => ({ key: w.id, label: w.name, href: `/scorte?magazzino=${w.id}` }))]}
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <Card className="overflow-hidden">
          {lines.length === 0 ? (
            <EmptyState
              title="Nessuna giacenza"
              text="Le giacenze nascono dalle ricezioni merce, dai carichi manuali e dall’inventario. Imposta i prodotti e le scorte minime per ricevere avvisi."
              action={<LinkButton href="/scorte/prodotti">Imposta prodotti</LinkButton>}
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-warm text-left text-xs text-muted uppercase">
                <tr>
                  <th className="px-4 py-2">Prodotto</th>
                  {!wh && <th className="hidden px-2 py-2 md:table-cell">Magazzino</th>}
                  <th className="px-2 py-2 text-right">Giacenza</th>
                  <th className="hidden px-4 py-2 text-right sm:table-cell">Minimo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand">
                {lines.map((l) => (
                  <tr key={`${l.warehouse.id}-${l.product.id}`} className={cx(l.belowMin && "bg-warn-soft/40")}>
                    <td className="px-4 py-2.5">
                      <p className="font-bold text-night">{l.product.name}</p>
                      <p className="flex flex-wrap gap-1.5 text-xs text-muted">
                        {wh ? null : <span className="md:hidden">{l.warehouse.name}</span>}
                        {l.belowMin && <Badge tone="warn">Sotto scorta</Badge>}
                        {l.incoming > 0 && <Badge tone="teal">In arrivo {formatQty(l.incoming, l.product.base_unit)}</Badge>}
                      </p>
                    </td>
                    {!wh && <td className="hidden px-2 py-2.5 text-muted md:table-cell">{l.warehouse.name}</td>}
                    <td className={cx("px-2 py-2.5 text-right text-[0.95rem] font-extrabold", l.qty < 0 ? "text-danger" : "text-night")}>{formatQty(l.qty, l.product.base_unit)}</td>
                    <td className="hidden px-4 py-2.5 text-right text-muted sm:table-cell">{l.minQty ? formatQty(l.minQty) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {canMove && products.length > 0 && (
          <Card className="h-fit overflow-hidden">
            <CardHeader title="Registra movimento" hint="Scarichi, sprechi, trasferimenti e carichi senza ordine." />
            <div className="p-4">
              <MovementForm
                warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
                products={products.map((p) => ({ id: p.id, name: p.name, unit: p.base_unit }))}
                defaultWarehouse={wh?.id ?? warehouses[0]?.id}
                canLoad={can(ctx, "receiving.perform")}
                canMove={can(ctx, "inventory.move")}
              />
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
