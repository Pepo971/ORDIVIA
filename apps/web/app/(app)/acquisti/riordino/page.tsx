import Link from "next/link";
import { reorderSuggestion } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, cx, EmptyState, Field, Input, LinkButton, PageHeader, Select } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatDate, formatEur, formatQty, formatTime, relativeFromNow } from "@/lib/format";
import { bestOfferByProduct, getOffers, getProducts, getStock, getSuppliers, getWarehouses, supplierWindow } from "@/lib/queries";
import { createOrderFromReorder } from "../actions";

export const metadata = { title: "Riordino" };
export const dynamic = "force-dynamic";

export default async function RiordinoPage({ searchParams }: { searchParams: Promise<{ fornitore?: string }> }) {
  const ctx = await requirePerm("purchasing.approve");
  const sp = await searchParams;
  const tz = ctx.facility.timezone;
  const now = new Date();
  const [stock, suppliers, offers, products, warehouses] = await Promise.all([
    getStock(ctx),
    getSuppliers(ctx.org.id),
    getOffers(ctx.org.id),
    getProducts(ctx.org.id),
    getWarehouses(ctx.facility.id),
  ]);
  const active = suppliers.filter((s) => s.active);
  const best = bestOfferByProduct(offers, new Set(active.map((s) => s.id)));
  const pName = new Map(products.map((p) => [p.id, p]));

  // Fabbisogno per prodotto (somma su tutti i magazzini della struttura)
  const need = new Map<string, { qty: number; onHand: number; min: number }>();
  for (const l of stock) {
    const cur = need.get(l.product.id) ?? { qty: 0, onHand: 0, min: 0 };
    cur.onHand += l.qty;
    cur.min += l.minQty;
    if (l.belowMin) cur.qty += l.suggestedBase;
    need.set(l.product.id, cur);
  }

  const groups = active
    .map((s) => {
      const listino = offers.filter((o) => o.supplier_id === s.id);
      const lines = listino.map((o) => {
        const n = need.get(o.product_id);
        const isBest = best.get(o.product_id)?.id === o.id;
        const packs = isBest && n && n.qty > 0 ? reorderSuggestion({ onHand: 0, minQty: 1, parQty: n.qty, packQty: o.pack_qty }).packs : 0;
        return { offer: o, product: pName.get(o.product_id), packs, onHand: n?.onHand ?? null, min: n?.min ?? 0 };
      });
      const suggested = lines.filter((l) => l.packs > 0);
      return { supplier: s, window: supplierWindow(s, tz, now), lines, suggested };
    })
    .filter((g) => g.lines.length > 0)
    .sort((a, b) => b.suggested.length - a.suggested.length || (a.window?.orderBy.getTime() ?? Infinity) - (b.window?.orderBy.getTime() ?? Infinity));

  const selected = sp.fornitore ? groups.find((g) => g.supplier.id === sp.fornitore) : undefined;
  const defaultWh = warehouses.find((w) => /centrale/i.test(w.name))?.id ?? warehouses[0]?.id;

  if (!selected) {
    return (
      <div>
        <PageHeader title="Riordino" subtitle="Cosa ordinare, a chi, entro quando. Calcolato su scorte minime, merce in arrivo e giorni di consegna." />
        {groups.length === 0 ? (
          <Card>
            <EmptyState
              title="Nessun fornitore con listino"
              text="Aggiungi un fornitore e i suoi prodotti con prezzi e confezioni: il riordino userà queste informazioni."
              action={<LinkButton href="/acquisti/fornitori/nuovo">Aggiungi fornitore</LinkButton>}
            />
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {groups.map((g) => (
              <Link key={g.supplier.id} href={`/acquisti/riordino?fornitore=${g.supplier.id}`} className="rounded-[var(--radius-card)] border border-sand-deep bg-white p-4 hover:border-teal">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-bold text-night">{g.supplier.name}</p>
                  {g.suggested.length > 0 ? <Badge tone="warn">{g.suggested.length} da riordinare</Badge> : <Badge>In ordine</Badge>}
                </div>
                {g.window ? (
                  <p className="mt-2 text-sm text-muted">
                    Ordina entro <strong className="text-night">{formatDate(g.window.orderBy, tz)} {formatTime(g.window.orderBy, tz)}</strong> ({relativeFromNow(g.window.orderBy, now)}) per la consegna di{" "}
                    {formatDate(g.window.deliveryDate, tz)}
                  </p>
                ) : (
                  <p className="mt-2 text-sm text-muted">Giorni di consegna non impostati</p>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  const total = selected.lines.reduce((s, l) => s + l.packs * l.offer.price, 0);
  return (
    <div>
      <PageHeader
        title={`Ordine a ${selected.supplier.name}`}
        subtitle={
          selected.window
            ? `Da inviare entro ${formatDate(selected.window.orderBy, tz)} alle ${formatTime(selected.window.orderBy, tz)} per la consegna di ${formatDate(selected.window.deliveryDate, tz)}.`
            : "Fornitore senza giorni di consegna: imposta la data a mano."
        }
        action={<LinkButton href="/acquisti/riordino" variant="secondary">Tutti i fornitori</LinkButton>}
      />
      <ActionForm action={createOrderFromReorder}>
        <input type="hidden" name="supplier_id" value={selected.supplier.id} />
        <Card className="mb-4 overflow-hidden">
          <CardHeader title="Righe d’ordine" hint="Le quantità proposte riportano le scorte al livello di riordino. Correggi liberamente." />
          <div className="divide-y divide-sand">
            {selected.lines.map((l) => (
              <div key={l.offer.id} className={cx("grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3", l.packs > 0 && "bg-warn-soft/40")}>
                <div className="min-w-0">
                  <p className="font-bold text-night">{l.product?.name}</p>
                  <p className="text-sm text-muted">
                    {l.offer.pack_label} · {formatEur(l.offer.price)}
                    {l.onHand != null && ` · giacenza ${formatQty(l.onHand, l.product?.base_unit)}${l.min ? ` (min ${formatQty(l.min)})` : ""}`}
                  </p>
                </div>
                <label className="flex items-center gap-2">
                  <input type="hidden" name="offer_id" value={l.offer.id} />
                  <span className="sr-only">Confezioni di {l.product?.name}</span>
                  <Input name="packs" type="number" inputMode="decimal" min={0} step="any" defaultValue={l.packs || ""} placeholder="0" className="w-24 text-right font-bold" />
                  <span className="w-8 text-xs text-muted">conf.</span>
                </label>
              </div>
            ))}
          </div>
        </Card>
        <Card className="mb-4 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Consegna prevista">
              <Input name="expected_delivery" type="date" defaultValue={selected.window?.deliveryDate} />
            </Field>
            <Field label="Scarico in">
              <Select name="warehouse_id" defaultValue={defaultWh}>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            Stima con le quantità proposte: <strong className="text-night">{formatEur(total)}</strong>
            {selected.supplier.min_order_amount > 0 && ` · minimo d’ordine ${formatEur(selected.supplier.min_order_amount)}`}
          </p>
          <SubmitButton pendingText="Creazione bozza…">Crea bozza d’ordine</SubmitButton>
        </div>
      </ActionForm>
    </div>
  );
}
