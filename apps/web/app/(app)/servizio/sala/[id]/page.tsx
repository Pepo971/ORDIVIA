import { notFound } from "next/navigation";
import { compareLabels, destinationLabel } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Badge, Card, CardHeader, Field, Input, LinkButton, PageHeader, Select, cx } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatEur, formatTime } from "@/lib/format";
import { LINE_STATUS_LABEL, getMenu, getOpenOrders, getOrder, getOrderLines, getServicePoints, getSubmissions, isConfirmed } from "@/lib/pos-queries";
import { acceptPortalSubmission, cancelOrder, moveOrder, rejectPortalSubmission, serveLines, updateOrder } from "../actions";
import { OrderPad } from "./order-pad";

export const metadata = { title: "Comanda" };
export const dynamic = "force-dynamic";

export default async function ComandaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePerm("pos.operate");
  const order = await getOrder(id);
  if (!order) notFound();
  const tz = ctx.facility.timezone;
  const [allLines, menu, points, open, submissions] = await Promise.all([
    getOrderLines([id]),
    order.status === "aperta" ? getMenu(ctx.facility.id) : Promise.resolve({ categories: [], items: [] }),
    order.status === "aperta" ? getServicePoints(ctx.facility.id) : Promise.resolve([]),
    order.status === "aperta" ? getOpenOrders(ctx.facility.id) : Promise.resolve([]),
    getSubmissions(id),
  ]);
  const pendingLines = allLines.filter((l) => l.status === "da_confermare");
  const lines = allLines.filter((l) => l.status !== "da_confermare");
  const pendingSubs = submissions.filter((s) => s.status === "da_confermare" && pendingLines.some((l) => l.portal_submission_id === s.id));
  const subById = new Map(submissions.map((s) => [s.id, s]));
  const busy = new Set(open.map((o) => o.service_point_id).filter(Boolean));
  const free = points.filter((p) => !busy.has(p.id)).sort((a, b) => a.kind.localeCompare(b.kind) || compareLabels(a.label, b.label));
  const ready = lines.filter((l) => l.status === "pronta");
  const courses = [...new Set(lines.map((l) => l.course))].sort((a, b) => a - b);
  const isOpen = order.status === "aperta";
  const activeLines = lines.filter(isConfirmed);

  return (
    <div>
      <LiveRefresh tables={["pos_order_lines", "pos_orders", "menu_items", "portal_submissions"]} facilityId={ctx.facility.id} />
      <PageHeader
        title={order.destination_label}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            #{order.number} · aperta {formatTime(order.opened_at, tz)}
            {order.covers > 0 && <> · {order.covers} coperti</>}
            {order.source === "portale" && <Badge tone="teal">Online</Badge>}
            {!isOpen && <Badge tone={order.status === "chiusa" ? "ok" : "danger"}>{order.status === "chiusa" ? "Chiusa" : "Annullata"}</Badge>}
          </span>
        }
        action={
          <div className="flex gap-2">
            <LinkButton href="/servizio/sala" variant="secondary">Sala</LinkButton>
            {isOpen && activeLines.length > 0 && can(ctx, "pos.operate") && <LinkButton href={`/servizio/cassa/${order.id}`}>Conto {formatEur(order.total)}</LinkButton>}
          </div>
        }
      />

      {pendingSubs.map((sub) => {
        const sl = pendingLines.filter((l) => l.portal_submission_id === sub.id);
        return (
          <Card key={sub.id} className="mb-4 overflow-hidden border-2 border-teal">
            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-sand bg-teal-soft px-4 py-3">
              <div>
                <p className="font-bold text-night">
                  <Badge tone="teal">online · da confermare</Badge> <span className="ml-1">{formatTime(sub.created_at, tz)}</span>
                </p>
                <p className="mt-1 text-sm text-ink">
                  {sub.guest_name ?? "Ospite"}
                  {sub.lang === "en" && " · in inglese"}
                </p>
              </div>
              <p className="text-lg font-bold text-night">{formatEur(sub.total)}</p>
            </div>
            {(sub.notes || sub.allergies) && (
              <div className="space-y-1 px-4 pt-3 text-sm">
                {sub.notes && <p className="text-ink">Note: «{sub.notes}»</p>}
                {sub.allergies && <p className="rounded bg-danger px-2 py-1 font-bold text-white">⚠ ALLERGIE: {sub.allergies}</p>}
              </div>
            )}
            <ul className="divide-y divide-sand px-4 py-1">
              {sl.map((l) => (
                <li key={l.id} className="flex items-start gap-3 py-2">
                  <span className="w-7 text-right font-bold text-night">{l.qty}×</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-night">{l.name}</p>
                    {l.notes && <p className="text-sm text-muted">«{l.notes}»</p>}
                  </div>
                  <span className="text-sm text-muted">{formatEur(l.unit_price * l.qty)}</span>
                </li>
              ))}
            </ul>
            {isOpen && (
              <div className="grid gap-3 border-t border-sand p-3 sm:grid-cols-2">
                <ActionForm action={acceptPortalSubmission}>
                  <input type="hidden" name="submission_id" value={sub.id} />
                  <input type="hidden" name="order_id" value={order.id} />
                  <SubmitButton full pendingText="…" className="min-h-14 text-lg">Accetta e invia</SubmitButton>
                </ActionForm>
                <ActionForm action={rejectPortalSubmission}>
                  <input type="hidden" name="submission_id" value={sub.id} />
                  <input type="hidden" name="order_id" value={order.id} />
                  <div className="flex gap-2">
                    <Input name="reason" required minLength={3} maxLength={300} placeholder="Motivo del rifiuto" aria-label="Motivo del rifiuto" />
                    <SubmitButton variant="danger" pendingText="…" className="min-h-12">Rifiuta</SubmitButton>
                  </div>
                </ActionForm>
              </div>
            )}
          </Card>
        );
      })}

      {ready.length > 0 && (
        <ActionForm action={serveLines} className="mb-4">
          <Card className="border-ok bg-ok-soft p-4">
            <p className="mb-2 font-bold text-ok">Pronti al pass: {ready.map((l) => `${l.qty}× ${l.name}`).join(", ")}</p>
            {ready.map((l) => (
              <input key={l.id} type="hidden" name="line_id" value={l.id} />
            ))}
            <SubmitButton full pendingText="…" className="min-h-12">Segna serviti</SubmitButton>
          </Card>
        </ActionForm>
      )}

      {lines.length > 0 && (
        <Card className="mb-4 overflow-hidden">
          <CardHeader title="Inviato" hint={`${activeLines.reduce((s, l) => s + l.qty, 0)} piatti · ${formatEur(order.total)}`} />
          {courses.map((c) => (
            <div key={c}>
              <p className="bg-warm px-4 py-1.5 text-xs font-bold tracking-wide text-muted uppercase">Uscita {c}</p>
              <ul className="divide-y divide-sand">
                {lines
                  .filter((l) => l.course === c)
                  .map((l) => {
                    const st = LINE_STATUS_LABEL[l.status]!;
                    return (
                      <li key={l.id} className={cx("flex items-start gap-3 px-4 py-2.5", l.status === "annullata" && "opacity-60")}>
                        <span className="w-7 text-right font-bold text-night">{l.qty}×</span>
                        <div className="min-w-0 flex-1">
                          <p className={cx("font-bold text-night", l.status === "annullata" && "line-through")}>
                            {l.name}
                            {l.source === "portale" && (
                              <span className="ml-1.5 align-middle"><Badge tone="teal">online{l.portal_submission_id && subById.get(l.portal_submission_id)?.guest_name ? ` · ${subById.get(l.portal_submission_id)!.guest_name}` : ""}</Badge></span>
                            )}
                          </p>
                          {(l.without.length > 0 || l.notes) && (
                            <p className="text-sm text-muted">
                              {l.without.length > 0 && `senza ${l.without.join(", ")}`}
                              {l.without.length > 0 && l.notes && " · "}
                              {l.notes}
                            </p>
                          )}
                          {l.allergy && <p className="text-sm font-bold text-danger">ALLERGIA{l.allergy_note ? `: ${l.allergy_note}` : ""}</p>}
                          {l.void_reason && <p className="text-xs text-danger">Annullata: {l.void_reason}</p>}
                        </div>
                        <div className="text-right">
                          <Badge tone={st.tone}>{st.label}</Badge>
                          <p className="mt-0.5 text-xs text-muted">{formatTime(l.sent_at, tz)}</p>
                        </div>
                      </li>
                    );
                  })}
              </ul>
            </div>
          ))}
        </Card>
      )}

      {isOpen && (
        <>
          <h2 className="mb-2 font-display text-xl font-semibold text-night">Aggiungi</h2>
          <OrderPad orderId={order.id} categories={menu.categories} items={menu.items} />

          <details className="mt-6 rounded-[var(--radius-card)] border border-sand-deep bg-white">
            <summary className="min-h-12 cursor-pointer px-4 py-3 font-bold text-night">Coperti, note, cambio tavolo</summary>
            <div className="space-y-5 border-t border-sand p-4">
              <ActionForm action={updateOrder}>
                <input type="hidden" name="order_id" value={order.id} />
                <div className="grid grid-cols-[6rem_1fr] gap-3">
                  <Field label="Coperti">
                    <Input name="covers" type="number" inputMode="numeric" min={0} max={500} defaultValue={order.covers} />
                  </Field>
                  <Field label="Nota della comanda">
                    <Input name="note" defaultValue={order.note ?? ""} maxLength={500} />
                  </Field>
                </div>
                <div className="mt-3"><SubmitButton variant="secondary">Salva</SubmitButton></div>
              </ActionForm>
              {free.length > 0 && (
                <ActionForm action={moveOrder}>
                  <input type="hidden" name="order_id" value={order.id} />
                  <Field label="Sposta su">
                    <Select name="service_point_id" defaultValue="">
                      <option value="" disabled>Scegli…</option>
                      {free.map((p) => (
                        <option key={p.id} value={p.id}>
                          {destinationLabel(p.kind, p.label)}{p.zone ? ` · ${p.zone}` : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="mt-3"><SubmitButton variant="secondary">Sposta</SubmitButton></div>
                </ActionForm>
              )}
              {((activeLines.length === 0 && pendingLines.length === 0) || can(ctx, "pos.supervise")) && order.paid === 0 && (
                <ActionForm action={cancelOrder}>
                  <input type="hidden" name="order_id" value={order.id} />
                  {(activeLines.length > 0 || pendingLines.length > 0) && (
                    <Field label="Motivo dell'annullamento" hint="Obbligatorio: resta nel registro operazioni.">
                      <Input name="reason" required minLength={3} maxLength={300} />
                    </Field>
                  )}
                  <div className="mt-3">
                    <SubmitButton variant="danger" confirm="Annullare la comanda?">Annulla comanda</SubmitButton>
                  </div>
                </ActionForm>
              )}
            </div>
          </details>
        </>
      )}
    </div>
  );
}
