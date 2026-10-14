import { notFound } from "next/navigation";
import { billTotals } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Badge, Card, CardHeader, Field, Input, LinkButton, Notice, PageHeader, Select, cx } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatEur, formatTime } from "@/lib/format";
import { PAYMENT_METHOD_LABEL, getOpenCashSession, getOrder, getOrderLines, isConfirmed } from "@/lib/pos-queries";
import { createClient } from "@/lib/supabase/server";
import { closeOrder, linkCustomer, markFiscalized, setDiscount, voidLine } from "../actions";
import { PaymentPanel } from "./payment-panel";

export const metadata = { title: "Conto" };
export const dynamic = "force-dynamic";

export default async function ContoPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ chiusa?: string; cliente?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm("pos.operate", "pos.supervise");
  const order = await getOrder(id);
  if (!order) notFound();
  const tz = ctx.facility.timezone;
  const supabase = await createClient();
  const canCustomers = can(ctx, "crm.view", "crm.manage", "reservations.manage", "rooms.manage", "beach.operate", "beach.manage");
  const q = (sp.cliente ?? "").trim().slice(0, 60);
  // Caratteri speciali dei filtri PostgREST tolti dalla ricerca.
  const qSafe = q.replace(/[%,()*\\"]/g, " ").trim();
  const [allLines, paysRes, session, customerRes, matchesRes] = await Promise.all([
    getOrderLines([id]),
    supabase.from("pos_payments").select("id, method, amount, tendered, change_given, split_label, fiscal_status, created_at").eq("order_id", id).order("created_at"),
    getOpenCashSession(ctx.facility.id),
    canCustomers && order.customer_id
      ? supabase.from("customers").select("id, full_name, phone, email").eq("id", order.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    canCustomers && qSafe.length >= 2
      ? supabase
          .from("customers")
          .select("id, full_name, phone, email")
          .eq("org_id", ctx.org.id)
          .is("anonymized_at", null)
          .or(`full_name.ilike.%${qSafe}%,phone.ilike.%${qSafe}%,email.ilike.%${qSafe}%`)
          .order("full_name")
          .limit(8)
      : Promise.resolve({ data: [] }),
  ]);
  const customer = customerRes.data as { id: string; full_name: string; phone: string | null; email: string | null } | null;
  const matches = (matchesRes.data ?? []) as { id: string; full_name: string; phone: string | null; email: string | null }[];
  const pendingLines = allLines.filter((l) => l.status === "da_confermare");
  const lines = allLines.filter((l) => l.status !== "da_confermare");
  const payments = (paysRes.data ?? []).map((p) => ({ ...p, amount: Number(p.amount), change_given: Number(p.change_given) }));
  const active = lines.filter(isConfirmed);
  const totals = billTotals(
    active.map((l) => ({ unitPrice: l.unit_price, qty: l.qty, vatRate: l.vat_rate })),
    order.discount_kind ? { kind: order.discount_kind as "percentuale" | "importo", value: order.discount_value ?? 0 } : null,
  );
  const remaining = Math.max(0, Math.round((order.total - order.paid) * 100) / 100);
  const isOpen = order.status === "aperta";
  const supervisor = can(ctx, "pos.supervise");
  const operator = can(ctx, "pos.operate");
  const toFiscal = payments.filter((p) => p.fiscal_status === "da_fiscalizzare");

  return (
    <div>
      <LiveRefresh tables={["pos_orders", "pos_order_lines", "pos_payments", "portal_submissions"]} facilityId={ctx.facility.id} />
      <PageHeader
        title={`Conto · ${order.destination_label}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            #{order.number} · aperta {formatTime(order.opened_at, tz)}
            {order.source === "portale" && <Badge tone="teal">Online</Badge>}
            {order.covers > 0 && <> · {order.covers} coperti</>}
            {order.status === "chiusa" && <Badge tone="ok">Chiusa {formatTime(order.closed_at, tz)}</Badge>}
            {order.status === "annullata" && <Badge tone="danger">Annullata</Badge>}
          </span>
        }
        action={
          <div className="flex gap-2">
            {isOpen && operator && <LinkButton href={`/servizio/sala/${order.id}`} variant="secondary">Comanda</LinkButton>}
            <LinkButton href="/servizio/cassa" variant="secondary">Cassa</LinkButton>
          </div>
        }
      />
      {sp.chiusa && <div className="mb-4"><Notice tone="ok">Conto chiuso. Ingredienti scaricati dal magazzino secondo le ricette.</Notice></div>}
      {isOpen && pendingLines.length > 0 && (
        <div className="mb-4">
          <Notice tone="night">
            {pendingLines.length === 1 ? "1 riga online da confermare" : `${pendingLines.length} righe online da confermare`} (
            {formatEur(pendingLines.reduce((s, l) => s + l.unit_price * l.qty, 0))}, non ancora nel conto). Accettale o rifiutale dalla{" "}
            <a href={`/servizio/sala/${order.id}`} className="underline">comanda</a> prima di chiudere.
          </Notice>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div>
          <Card className="mb-4 overflow-hidden">
            <CardHeader title="Conto" hint="Prezzi IVA inclusa" />
            <ul className="divide-y divide-sand">
              {lines.map((l) => (
                <li key={l.id} className={cx("px-4 py-2.5", l.status === "annullata" && "opacity-60")}>
                  <div className="flex items-start gap-3">
                    <span className="w-7 text-right font-bold text-night">{l.qty}×</span>
                    <div className="min-w-0 flex-1">
                      <p className={cx("font-bold text-night", l.status === "annullata" && "line-through")}>{l.name}</p>
                      <p className="text-xs text-muted">
                        {formatEur(l.unit_price)} · IVA {Number(l.vat_rate)}%
                        {l.paid_payment_id && " · pagato a parte"}
                        {l.void_reason && <span className="text-danger"> · annullata: {l.void_reason}</span>}
                      </p>
                    </div>
                    <span className={cx("font-bold text-night", l.status === "annullata" && "line-through")}>{formatEur(l.unit_price * l.qty)}</span>
                  </div>
                  {isOpen && supervisor && l.status !== "annullata" && !l.paid_payment_id && (
                    <details className="mt-1 ml-10">
                      <summary className="min-h-9 cursor-pointer text-sm font-bold text-danger">Annulla riga</summary>
                      <ActionForm action={voidLine} className="mt-2 flex gap-2">
                        <input type="hidden" name="line_id" value={l.id} />
                        <input type="hidden" name="order_id" value={order.id} />
                        <Input name="reason" placeholder="Motivo (obbligatorio)" required minLength={3} maxLength={300} aria-label="Motivo dell'annullamento" />
                        <SubmitButton variant="danger" pendingText="…">Annulla</SubmitButton>
                      </ActionForm>
                    </details>
                  )}
                </li>
              ))}
              {lines.length === 0 && <li className="px-4 py-4 text-sm text-muted">Nessun piatto in questa comanda.</li>}
            </ul>
            <dl className="space-y-1 border-t border-sand bg-warm px-4 py-3 text-sm">
              <div className="flex justify-between"><dt>Subtotale</dt><dd>{formatEur(order.subtotal)}</dd></div>
              {order.discount_amount > 0 && (
                <div className="flex justify-between text-teal-deep">
                  <dt>Sconto {order.discount_kind === "percentuale" ? `${order.discount_value}%` : ""} · {order.discount_reason}</dt>
                  <dd>−{formatEur(order.discount_amount)}</dd>
                </div>
              )}
              <div className="flex justify-between text-lg font-bold text-night"><dt>Totale</dt><dd>{formatEur(order.total)}</dd></div>
              {totals.vat.map((v) => (
                <div key={v.rate} className="flex justify-between text-xs text-muted">
                  <dt>di cui IVA {v.rate}% su imponibile {formatEur(v.net)}</dt>
                  <dd>{formatEur(v.vat)}</dd>
                </div>
              ))}
              {order.paid > 0 && <div className="flex justify-between font-bold text-ok"><dt>Pagato</dt><dd>{formatEur(order.paid)}</dd></div>}
              {isOpen && <div className="flex justify-between text-base font-bold text-night"><dt>Da pagare</dt><dd>{formatEur(remaining)}</dd></div>}
            </dl>
          </Card>

          {isOpen && supervisor && (
            <Card className="mb-4">
              <CardHeader title="Sconto" hint="Resta nel registro operazioni con il tuo nome e il motivo." />
              <ActionForm action={setDiscount} className="p-4">
                <input type="hidden" name="order_id" value={order.id} />
                <div className="grid grid-cols-[1fr_7rem] gap-3">
                  <Field label="Tipo">
                    <Select name="kind" defaultValue={order.discount_kind ?? "percentuale"}>
                      <option value="percentuale">Percentuale (%)</option>
                      <option value="importo">Importo (€)</option>
                      <option value="nessuno">Nessuno sconto</option>
                    </Select>
                  </Field>
                  <Field label="Valore">
                    <Input name="value" inputMode="decimal" defaultValue={order.discount_value ?? ""} />
                  </Field>
                </div>
                <div className="mt-3">
                  <Field label="Motivo">
                    <Input name="reason" defaultValue={order.discount_reason ?? ""} placeholder="es. cliente abituale, attesa lunga" maxLength={300} />
                  </Field>
                </div>
                <div className="mt-3"><SubmitButton variant="secondary">Applica</SubmitButton></div>
              </ActionForm>
            </Card>
          )}
        </div>

        <div>
          <div className="mb-4">
            <Notice tone="warn">
              Ordivia non emette documenti fiscali. <strong>Emetti lo scontrino dal registratore telematico</strong> per ogni incasso.
            </Notice>
          </div>
          {isOpen && operator && remaining > 0 && (
            <Card className="mb-4 p-4">
              <PaymentPanel
                orderId={order.id}
                subtotal={order.subtotal}
                total={order.total}
                remaining={remaining}
                cashAllowed={!!session}
                lines={active.filter((l) => !l.paid_payment_id).map((l) => ({ id: l.id, name: l.name, qty: l.qty, gross: l.unit_price * l.qty }))}
              />
              {!session && <p className="mt-2 text-xs text-muted">Contanti disattivati: nessun turno di cassa aperto.</p>}
            </Card>
          )}
          {isOpen && operator && active.length > 0 && remaining === 0 && pendingLines.length > 0 && (
            <Card className="mb-4 p-4">
              <p className="font-bold text-night">Conto saldato, ma ci sono righe online da confermare: la chiusura è bloccata.</p>
            </Card>
          )}
          {isOpen && operator && active.length > 0 && remaining === 0 && pendingLines.length === 0 && (
            <Card className="mb-4 border-ok p-4">
              <p className="mb-3 font-bold text-ok">Conto saldato.</p>
              <ActionForm action={closeOrder}>
                <input type="hidden" name="order_id" value={order.id} />
                <SubmitButton full pendingText="Chiusura…" className="min-h-14 text-lg">Chiudi conto e libera il tavolo</SubmitButton>
              </ActionForm>
            </Card>
          )}

          {canCustomers && order.status !== "annullata" && (operator || supervisor) && (
            <Card className="mb-4">
              <CardHeader title="Cliente" hint="Collega il conto alla scheda cliente: la spesa compare nel CRM." />
              <div className="p-4">
                {customer ? (
                  <ActionForm action={linkCustomer} className="flex items-center justify-between gap-3">
                    <input type="hidden" name="order_id" value={order.id} />
                    <input type="hidden" name="customer_id" value="" />
                    <div className="min-w-0">
                      <p className="font-bold text-night">{customer.full_name}</p>
                      <p className="truncate text-xs text-muted">{[customer.phone, customer.email].filter(Boolean).join(" · ")}</p>
                    </div>
                    <SubmitButton variant="ghost" pendingText="…">Scollega</SubmitButton>
                  </ActionForm>
                ) : (
                  <>
                    <form method="get" className="flex gap-2">
                      <Input name="cliente" defaultValue={q} placeholder="Nome, telefono o email" aria-label="Cerca cliente" minLength={2} maxLength={60} />
                      <button type="submit" className="min-h-11 rounded-xl border border-sand-deep px-4 text-sm font-bold text-night">Cerca</button>
                    </form>
                    {q.length >= 2 && (
                      <ul className="mt-3 divide-y divide-sand rounded-xl border border-sand-deep">
                        {matches.length === 0 && <li className="px-3 py-3 text-sm text-muted">Nessun cliente trovato.</li>}
                        {matches.map((c) => (
                          <li key={c.id}>
                            <ActionForm action={linkCustomer} className="flex items-center justify-between gap-3 px-3 py-2">
                              <input type="hidden" name="order_id" value={order.id} />
                              <input type="hidden" name="customer_id" value={c.id} />
                              <div className="min-w-0">
                                <p className="font-bold text-night">{c.full_name}</p>
                                <p className="truncate text-xs text-muted">{[c.phone, c.email].filter(Boolean).join(" · ")}</p>
                              </div>
                              <SubmitButton variant="secondary" pendingText="…">Collega</SubmitButton>
                            </ActionForm>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </Card>
          )}

          <Card className="overflow-hidden">
            <CardHeader title="Pagamenti" hint={toFiscal.length > 0 ? `${toFiscal.length} da fiscalizzare` : undefined} />
            {payments.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted">Nessun pagamento.</p>
            ) : (
              <ul className="divide-y divide-sand">
                {payments.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-night">{PAYMENT_METHOD_LABEL[p.method]}{p.split_label ? ` · ${p.split_label}` : ""}</p>
                      <p className="text-xs text-muted">
                        {formatTime(p.created_at, tz)}
                        {p.change_given > 0 && ` · ricevuti ${formatEur(p.tendered)}, resto ${formatEur(p.change_given)}`}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-night">{formatEur(p.amount)}</p>
                      {p.fiscal_status === "da_fiscalizzare" ? <Badge tone="warn">Scontrino da emettere</Badge> : <Badge tone="ok">Scontrino emesso</Badge>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {toFiscal.length > 0 && operator && (
              <ActionForm action={markFiscalized} className="border-t border-sand p-3">
                <input type="hidden" name="order_id" value={order.id} />
                <SubmitButton variant="secondary" full pendingText="…">Ho emesso lo scontrino dal registratore</SubmitButton>
              </ActionForm>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
