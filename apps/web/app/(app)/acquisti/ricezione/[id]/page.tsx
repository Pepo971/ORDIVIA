import { notFound, redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Field, Input, LinkButton, PageHeader, Select, Textarea } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatEur, formatQty } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { saveReceipt } from "../../actions";

export const metadata = { title: "Ricezione merce" };
export const dynamic = "force-dynamic";

const ISSUES = [
  ["", "Tutto ok"],
  ["mancante", "Mancante / meno del previsto"],
  ["danneggiato", "Danneggiato"],
  ["errato", "Prodotto errato"],
  ["in_eccesso", "In eccesso"],
] as const;

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePerm("receiving.perform");
  const supabase = await createClient();
  const { data: rc } = await supabase
    .from("receipts")
    .select("id, status, order_id, doc_type, doc_number, doc_date, note, suppliers(name), warehouses(name), purchase_orders(number)")
    .eq("id", id)
    .maybeSingle();
  if (!rc) notFound();
  if (rc.status !== "bozza") redirect(rc.order_id ? `/acquisti/ordini/${rc.order_id}` : "/scorte");

  const { data: linesData } = await supabase
    .from("receipt_lines")
    .select("id, product_id, pack_qty, qty_packs, unit_price, lot, expires_on, issue, order_line_id, products(name, base_unit), purchase_order_lines(qty_packs, qty_received_base, pack_qty, unit_price, pack_label)")
    .eq("receipt_id", id)
    .order("id");
  const lines = (linesData ?? []) as unknown as {
    id: string; pack_qty: number; qty_packs: number; unit_price: number | null; lot: string | null; expires_on: string | null; issue: string | null;
    products: { name: string; base_unit: string } | null;
    purchase_order_lines: { qty_packs: number; qty_received_base: number; pack_qty: number; unit_price: number; pack_label: string } | null;
  }[];
  const supplier = (rc.suppliers as unknown as { name: string } | null)?.name ?? "";
  const wh = (rc.warehouses as unknown as { name: string } | null)?.name ?? "";
  const number = (rc.purchase_orders as unknown as { number: string } | null)?.number;

  return (
    <div>
      <PageHeader
        title={`Ricezione · ${supplier}`}
        subtitle={`${number ? `Ordine ${number} · ` : ""}scarico in ${wh}. Controlla colli e quantità prima di confermare.`}
        action={rc.order_id ? <LinkButton href={`/acquisti/ordini/${rc.order_id}`} variant="secondary">Torna all’ordine</LinkButton> : undefined}
      />
      <ActionForm action={saveReceipt}>
        <input type="hidden" name="receipt_id" value={rc.id} />
        <Card className="mb-4 p-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Documento">
              <Select name="doc_type" defaultValue={rc.doc_type}>
                <option value="ddt">DDT</option>
                <option value="fattura">Fattura accompagnatoria</option>
                <option value="nessuno">Nessun documento</option>
              </Select>
            </Field>
            <Field label="Numero">
              <Input name="doc_number" defaultValue={rc.doc_number ?? ""} placeholder="Es. 1245/A" />
            </Field>
            <Field label="Data documento">
              <Input name="doc_date" type="date" defaultValue={rc.doc_date ?? ""} />
            </Field>
          </div>
        </Card>

        <Card className="mb-4 overflow-hidden">
          <CardHeader title="Spunta merce" hint="Quantità in confezioni. Il prezzo del documento, se diverso, aggiorna costi e storico prezzi." />
          <div className="divide-y divide-sand">
            {lines.map((l) => {
              const ol = l.purchase_order_lines;
              const expected = ol ? Math.max(Number(ol.qty_packs) - Number(ol.qty_received_base) / Number(ol.pack_qty), 0) : null;
              return (
                <fieldset key={l.id} className="px-4 py-4">
                  <input type="hidden" name="line_id" value={l.id} />
                  <legend className="sr-only">{l.products?.name}</legend>
                  <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-bold text-night">{l.products?.name}</p>
                    <p className="text-sm text-muted">
                      {ol?.pack_label} {expected != null && `· attese ${formatQty(expected)} conf. (${formatQty(expected * Number(l.pack_qty), l.products?.base_unit)})`}
                      {ol && ` · ordinato a ${formatEur(ol.unit_price)}`}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                    <Field label="Ricevute (conf.)">
                      <Input name="qty_packs" type="number" min={0} step="any" inputMode="decimal" defaultValue={Number(l.qty_packs)} className="font-bold" required />
                    </Field>
                    <Field label="Prezzo doc. (€/conf.)">
                      <Input name="unit_price" type="number" min={0} step="0.0001" inputMode="decimal" defaultValue={l.unit_price ?? ""} />
                    </Field>
                    <Field label="Lotto">
                      <Input name="lot" defaultValue={l.lot ?? ""} />
                    </Field>
                    <Field label="Scadenza">
                      <Input name="expires_on" type="date" defaultValue={l.expires_on ?? ""} />
                    </Field>
                    <Field label="Esito">
                      <Select name="issue" defaultValue={l.issue ?? ""}>
                        {ISSUES.map(([v, label]) => (
                          <option key={v} value={v}>{label}</option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                </fieldset>
              );
            })}
          </div>
        </Card>
        <Card className="mb-4 p-4">
          <Field label="Note sulla consegna">
            <Textarea name="note" defaultValue={rc.note ?? ""} placeholder="Es. corriere in ritardo, 1 cassa bagnata" />
          </Field>
        </Card>
        <div className="flex flex-wrap justify-end gap-2">
          <SubmitButton variant="secondary" name="intent" value="save">Salva spunta</SubmitButton>
          <SubmitButton name="intent" value="confirm" pendingText="Registrazione…" confirm="Confermi la ricezione? Le giacenze verranno aggiornate e l’operazione non è modificabile.">
            Conferma e carica a magazzino
          </SubmitButton>
        </div>
      </ActionForm>
    </div>
  );
}
