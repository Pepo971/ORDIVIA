import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, Field, Input, LinkButton, Notice, PageHeader, Select, Textarea } from "@/components/ui";
import { can, getContext } from "@/lib/context";
import { formatDate, formatDateTime, formatEur, formatQty } from "@/lib/format";
import { PO_STATUS } from "@/lib/labels";
import { getWarehouses } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import { deleteDraftOrder, saveOrderDraft, startReceipt, transitionOrder } from "../../actions";
import { CopyButton } from "./copy-button";

export const dynamic = "force-dynamic";

interface Line {
  id: string;
  product_id: string;
  pack_label: string;
  pack_qty: number;
  qty_packs: number;
  unit_price: number;
  qty_received_base: number;
  products: { name: string; base_unit: string } | null;
}

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ricevuto?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getContext();
  const supabase = await createClient();
  const tz = ctx.facility.timezone;

  const { data: po } = await supabase
    .from("purchase_orders")
    .select("id, number, status, expected_delivery, note, created_at, approved_at, sent_at, delivery_warehouse_id, supplier_id, facility_id, suppliers(name, email, phone, order_channel, contact_name, min_order_amount)")
    .eq("id", id)
    .maybeSingle();
  if (!po) notFound();
  const supplier = po.suppliers as unknown as { name: string; email: string | null; phone: string | null; order_channel: string; contact_name: string | null; min_order_amount: number };

  const [{ data: linesData }, warehouses, { data: listino }, { data: receipts }] = await Promise.all([
    supabase.from("purchase_order_lines").select("id, product_id, pack_label, pack_qty, qty_packs, unit_price, qty_received_base, products(name, base_unit)").eq("order_id", id).order("id"),
    getWarehouses(ctx.facility.id),
    po.status === "bozza"
      ? supabase.from("supplier_products").select("id, pack_label, price, products(name)").eq("supplier_id", po.supplier_id)
      : Promise.resolve({ data: [] }),
    supabase.from("receipts").select("id, status, doc_type, doc_number, confirmed_at, created_at").eq("order_id", id).order("created_at"),
  ]);
  const lines = (linesData ?? []) as unknown as Line[];
  const total = lines.reduce((s, l) => s + Number(l.qty_packs) * Number(l.unit_price), 0);
  const st = PO_STATUS[po.status]!;
  const isApprover = can(ctx, "purchasing.approve");
  const canSend = can(ctx, "purchasing.send");
  const canReceive = can(ctx, "receiving.perform");
  const draftReceipt = (receipts ?? []).find((r) => r.status === "bozza");

  const message = [
    `Buongiorno${supplier.contact_name ? ` ${supplier.contact_name}` : ""},`,
    `vi inviamo l’ordine ${po.number} per ${ctx.facility.name}${po.expected_delivery ? `, con consegna ${formatDate(po.expected_delivery, tz)}` : ""}:`,
    "",
    ...lines.map((l) => `• ${Number(l.qty_packs)} × ${l.pack_label} — ${l.products?.name}`),
    ...(po.note ? ["", `Note: ${po.note}`] : []),
    "",
    "Grazie, vi chiediamo conferma.",
    ctx.fullName,
  ].join("\n");
  const phone = supplier.phone?.replace(/[^\d+]/g, "").replace(/^\+/, "");
  const waPhone = phone && !phone.startsWith("39") && phone.length <= 10 ? `39${phone}` : phone;

  return (
    <div>
      <PageHeader
        title={supplier.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {po.number} <Badge tone={st.tone}>{st.label}</Badge>
            {po.sent_at && <span>· inviato {formatDateTime(po.sent_at, tz)}</span>}
          </span>
        }
        action={<LinkButton href="/acquisti?tab=ordini" variant="secondary">Tutti gli ordini</LinkButton>}
      />
      {sp.ricevuto && <div className="mb-4"><Notice tone="ok">Ricezione confermata: giacenze e costi aggiornati.</Notice></div>}

      {po.status === "bozza" && isApprover ? (
        <ActionForm action={saveOrderDraft}>
          <input type="hidden" name="order_id" value={po.id} />
          <Card className="mb-4 overflow-hidden">
            <CardHeader title="Righe" hint="Metti 0 per togliere una riga." />
            <div className="divide-y divide-sand">
              {lines.map((l) => (
                <div key={l.id} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-bold text-night">{l.products?.name}</p>
                    <p className="text-sm text-muted">{l.pack_label} · {formatEur(l.unit_price)} / conf.</p>
                  </div>
                  <label className="flex items-center gap-2">
                    <input type="hidden" name="line_id" value={l.id} />
                    <span className="sr-only">Confezioni</span>
                    <Input name="line_packs" type="number" min={0} step="any" inputMode="decimal" defaultValue={Number(l.qty_packs)} className="w-24 text-right font-bold" />
                  </label>
                </div>
              ))}
              {lines.length === 0 && <p className="px-4 py-4 text-sm text-muted">Nessuna riga: aggiungi un prodotto dal listino.</p>}
              <div className="grid gap-3 bg-warm px-4 py-3 sm:grid-cols-[1fr_auto]">
                <Field label="Aggiungi dal listino">
                  <Select name="add_offer_id" defaultValue="">
                    <option value="">—</option>
                    {((listino ?? []) as unknown as { id: string; pack_label: string; price: number; products: { name: string } | null }[]).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.products?.name} · {o.pack_label} · {formatEur(o.price)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Confezioni">
                  <Input name="add_packs" type="number" min={0} step="any" inputMode="decimal" className="w-24" />
                </Field>
              </div>
            </div>
          </Card>
          <Card className="mb-4 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Consegna prevista">
                <Input name="expected_delivery" type="date" defaultValue={po.expected_delivery ?? ""} />
              </Field>
              <Field label="Scarico in">
                <Select name="warehouse_id" defaultValue={po.delivery_warehouse_id ?? ""}>
                  <option value="">Da decidere alla consegna</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </Select>
              </Field>
              <div className="sm:col-span-2">
                <Field label="Note per il fornitore">
                  <Textarea name="note" defaultValue={po.note ?? ""} maxLength={1000} />
                </Field>
              </div>
            </div>
          </Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">
              Totale stimato <strong className="text-night">{formatEur(total)}</strong> IVA esclusa
              {supplier.min_order_amount > 0 && total < supplier.min_order_amount && (
                <span className="ml-2 font-bold text-warn">sotto il minimo d’ordine ({formatEur(supplier.min_order_amount)})</span>
              )}
            </p>
            <div className="flex gap-2">
              <SubmitButton variant="secondary">Salva bozza</SubmitButton>
            </div>
          </div>
        </ActionForm>
      ) : (
        <Card className="mb-4 overflow-hidden">
          <CardHeader title="Righe" hint={po.expected_delivery ? `Consegna prevista ${formatDate(po.expected_delivery, tz)}` : undefined} />
          <table className="w-full text-sm">
            <thead className="bg-warm text-left text-xs text-muted uppercase">
              <tr>
                <th className="px-4 py-2">Prodotto</th>
                <th className="px-2 py-2 text-right">Ordinato</th>
                <th className="px-2 py-2 text-right">Ricevuto</th>
                <th className="hidden px-4 py-2 text-right sm:table-cell">Importo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-sand">
              {lines.map((l) => {
                const ordered = Number(l.qty_packs) * Number(l.pack_qty);
                const received = Number(l.qty_received_base);
                const short = ["parziale", "ricevuto"].includes(po.status) && received < ordered;
                return (
                  <tr key={l.id}>
                    <td className="px-4 py-2.5">
                      <p className="font-bold text-night">{l.products?.name}</p>
                      <p className="text-xs text-muted">{Number(l.qty_packs)} × {l.pack_label}</p>
                    </td>
                    <td className="px-2 py-2.5 text-right">{formatQty(ordered, l.products?.base_unit)}</td>
                    <td className={`px-2 py-2.5 text-right font-bold ${short ? "text-warn" : "text-night"}`}>{formatQty(received, l.products?.base_unit)}</td>
                    <td className="hidden px-4 py-2.5 text-right sm:table-cell">{formatEur(Number(l.qty_packs) * Number(l.unit_price))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="border-t border-sand px-4 py-3 text-right text-sm">
            Totale <strong className="text-night">{formatEur(total)}</strong> IVA esclusa
          </p>
        </Card>
      )}

      {/* Azioni per stato */}
      {po.status === "bozza" && isApprover && (
        <Card className="mt-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">Salva le modifiche, poi approva: un ordine approvato non è più modificabile.</p>
            <div className="flex gap-2">
              <form action={deleteDraftOrder}>
                <input type="hidden" name="order_id" value={po.id} />
                <button className="min-h-11 rounded-xl px-3 text-sm font-bold text-danger hover:bg-danger-soft">Elimina bozza</button>
              </form>
              <ActionForm action={transitionOrder}>
                <input type="hidden" name="order_id" value={po.id} />
                <input type="hidden" name="to" value="approvato" />
                <SubmitButton pendingText="Approvazione…">Approva ordine</SubmitButton>
              </ActionForm>
            </div>
          </div>
        </Card>
      )}

      {po.status === "approvato" && (
        <Card className="mt-4 overflow-hidden">
          <CardHeader title="Invia al fornitore" hint={`Canale preferito: ${supplier.order_channel}`} />
          <div className="p-4">
            <pre className="max-h-64 overflow-auto rounded-xl bg-warm p-3 text-sm whitespace-pre-wrap text-ink">{message}</pre>
            <div className="mt-3 flex flex-wrap gap-2">
              {supplier.email && (
                <a
                  className="inline-flex min-h-11 items-center rounded-xl border border-sand-deep bg-white px-4 text-sm font-bold text-night hover:border-night-3"
                  href={`mailto:${supplier.email}?subject=${encodeURIComponent(`Ordine ${po.number} — ${ctx.facility.name}`)}&body=${encodeURIComponent(message)}`}
                >
                  Apri email
                </a>
              )}
              {waPhone && (
                <a
                  className="inline-flex min-h-11 items-center rounded-xl border border-sand-deep bg-white px-4 text-sm font-bold text-night hover:border-night-3"
                  href={`https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Apri WhatsApp
                </a>
              )}
              <CopyButton text={message} />
            </div>
            <p className="mt-3 text-xs text-muted">Dopo averlo inviato, segnalo qui: l’ordine passa tra le consegne attese del magazzino.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {canSend && (
                <ActionForm action={transitionOrder}>
                  <input type="hidden" name="order_id" value={po.id} />
                  <input type="hidden" name="to" value="inviato" />
                  <SubmitButton pendingText="Aggiornamento…">Segna come inviato</SubmitButton>
                </ActionForm>
              )}
              {isApprover && (
                <ActionForm action={transitionOrder}>
                  <input type="hidden" name="order_id" value={po.id} />
                  <input type="hidden" name="to" value="bozza" />
                  <SubmitButton variant="ghost" pendingText="…">Riporta in bozza</SubmitButton>
                </ActionForm>
              )}
            </div>
          </div>
        </Card>
      )}

      {(po.status === "inviato" || po.status === "parziale") && canReceive && (
        <Card className="mt-4 p-4">
          <h2 className="font-bold text-night">{draftReceipt ? "Ricezione in corso" : "La merce è arrivata?"}</h2>
          <p className="mt-1 text-sm text-muted">Spunta righe e quantità, fotografa o annota il DDT, segnala differenze. Il magazzino si aggiorna solo alla conferma.</p>
          {draftReceipt ? (
            <LinkButton href={`/acquisti/ricezione/${draftReceipt.id}`} className="mt-3">Continua la spunta</LinkButton>
          ) : (
            <ActionForm action={startReceipt} className="mt-3 flex flex-wrap items-end gap-3">
              <input type="hidden" name="order_id" value={po.id} />
              <Field label="Scarico in">
                <Select name="warehouse_id" defaultValue={po.delivery_warehouse_id ?? warehouses[0]?.id}>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </Select>
              </Field>
              <SubmitButton pendingText="Apertura…">Inizia la ricezione</SubmitButton>
            </ActionForm>
          )}
        </Card>
      )}

      {po.status === "inviato" && isApprover && (
        <ActionForm action={transitionOrder} className="mt-4">
          <input type="hidden" name="order_id" value={po.id} />
          <input type="hidden" name="to" value="annullato" />
          <SubmitButton variant="danger" confirm="Annullare questo ordine? Il fornitore va avvisato a parte." pendingText="Annullamento…">
            Annulla ordine
          </SubmitButton>
        </ActionForm>
      )}

      {(receipts ?? []).length > 0 && (
        <Card className="mt-4 overflow-hidden">
          <CardHeader title="Ricezioni" />
          {(receipts ?? []).map((r) => (
            <div key={r.id} className="flex items-center justify-between border-b border-sand px-4 py-3 text-sm last:border-b-0">
              <span>
                {r.doc_type.toUpperCase()} {r.doc_number ?? "senza numero"} · {formatDateTime(r.confirmed_at ?? r.created_at, tz)}
              </span>
              <Badge tone={r.status === "confermata" ? "ok" : "warn"}>{r.status === "confermata" ? "Confermata" : "In spunta"}</Badge>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
