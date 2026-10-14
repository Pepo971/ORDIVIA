import { notFound } from "next/navigation";
import { BEACH_PERIODS, balanceDue, todayIn } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, Field, Input, LinkButton, Notice, PageHeader, Select, Textarea } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDate, formatDateTime, formatEur } from "@/lib/format";
import { BOOKING_COLUMNS, BOOKING_STATUS, getBeachPoints, normBooking, pointName } from "@/lib/beach-queries";
import { createClient } from "@/lib/supabase/server";
import { addPayment, cancelBooking, checkIn, checkOut, moveBooking, setPrice, updateCustomer } from "../../actions";

export const dynamic = "force-dynamic";

const METHOD: Record<string, string> = { contanti: "Contanti", carta: "Carta", bonifico: "Bonifico", altro: "Altro" };

export default async function BookingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ nuova?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm("beach.operate", "beach.manage");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data } = await supabase.from("beach_bookings").select(BOOKING_COLUMNS).eq("id", id).eq("facility_id", ctx.facility.id).maybeSingle();
  if (!data) notFound();
  const b = normBooking(data);
  const manage = can(ctx, "beach.manage");
  const tz = ctx.facility.timezone;
  const today = todayIn(tz);

  const [points, { data: moves }, paymentsRes, { data: overlapping }] = await Promise.all([
    getBeachPoints(ctx.facility.id, true),
    supabase.from("beach_moves").select("id, from_point_id, to_point_id, note, moved_at").eq("booking_id", id).order("moved_at"),
    manage ? supabase.from("beach_payments").select("id, amount, method, created_at").eq("booking_id", id).order("created_at") : Promise.resolve({ data: null }),
    supabase
      .from("beach_bookings")
      .select("service_point_id, period")
      .eq("facility_id", ctx.facility.id)
      .in("status", ["prenotata", "presente"])
      .lte("start_date", b.end_date)
      .gte("end_date", b.start_date)
      .neq("id", b.id),
  ]);
  const byId = new Map(points.map((p) => [p.id, p]));
  const point = byId.get(b.service_point_id);
  const activeB = b.status === "prenotata" || b.status === "presente";
  const due = balanceDue(b.price, b.paid_amount);
  const presentToday = b.status === "presente" && b.last_checkin_on === today;
  const inRange = b.start_date <= today && today <= b.end_date;
  // Postazioni libere per l'intero periodo (stessa regola del vincolo nel database)
  const mySlot = BEACH_PERIODS[b.period].slot;
  const busy = new Set(
    (overlapping ?? [])
      .filter((o) => {
        const s = BEACH_PERIODS[o.period as keyof typeof BEACH_PERIODS].slot;
        return s === "intera" || mySlot === "intera" || s === mySlot;
      })
      .map((o) => o.service_point_id as string),
  );
  const freePoints = points.filter((p) => p.active && p.id !== b.service_point_id && !busy.has(p.id));
  const canCancel = activeB && (manage || (b.paid_amount === 0 && !BEACH_PERIODS[b.period].flat));

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={b.customer_name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={BOOKING_STATUS[b.status].tone}>{presentToday ? "Presente oggi" : BOOKING_STATUS[b.status].label}</Badge>
            {point ? pointName(point) : "—"} · {BEACH_PERIODS[b.period].label}
          </span>
        }
        action={<LinkButton href={`/servizio/spiaggia?data=${inRange ? today : b.start_date}&p=${b.service_point_id}`} variant="secondary">Vedi sulla mappa</LinkButton>}
      />
      {sp.nuova && <div className="mb-4"><Notice tone="ok">Prenotazione registrata.</Notice></div>}

      <div className="grid gap-5 md:grid-cols-2">
        <Card>
          <CardHeader title="Periodo e prezzo" />
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-4 py-3 text-sm">
            <dt className="text-muted">Date</dt>
            <dd className="font-bold text-night">{b.start_date === b.end_date ? formatDate(b.start_date, tz) : `${formatDate(b.start_date, tz)} → ${formatDate(b.end_date, tz)}`}</dd>
            <dt className="text-muted">Postazione</dt>
            <dd className="font-bold text-night">{point ? `${pointName(point)}${point.zone ? `, settore ${point.zone}` : ""}${point.row_label ? `, fila ${point.row_label}` : ""}` : "—"}</dd>
            <dt className="text-muted">Lettini</dt>
            <dd className="font-bold text-night">{b.lettini}</dd>
            <dt className="text-muted">Prezzo</dt>
            <dd className="font-bold text-night">
              {formatEur(b.price)}
              {b.list_price != null && b.list_price !== b.price && <span className="ml-2 text-xs font-semibold text-muted">listino {formatEur(b.list_price)}</span>}
            </dd>
            {b.price_override_reason && (
              <>
                <dt className="text-muted">Motivo</dt>
                <dd className="text-night">{b.price_override_reason}</dd>
              </>
            )}
            <dt className="text-muted">Incassato</dt>
            <dd className="font-bold text-night">{formatEur(b.paid_amount)}</dd>
            <dt className="text-muted">Saldo</dt>
            <dd className={due > 0 ? "font-extrabold text-danger" : "font-extrabold text-ok"}>{due > 0 ? formatEur(due) : "Pagato"}</dd>
            {b.checked_in_at && (
              <>
                <dt className="text-muted">Ultimo ingresso</dt>
                <dd className="text-night">{formatDateTime(b.checked_in_at, tz)}</dd>
              </>
            )}
            {b.cancel_reason && (
              <>
                <dt className="text-muted">Annullata</dt>
                <dd className="text-night">{b.cancel_reason}</dd>
              </>
            )}
          </dl>
          {activeB && inRange && (
            <div className="border-t border-sand p-4">
              {presentToday ? (
                <ActionForm action={checkOut}>
                  <input type="hidden" name="booking_id" value={b.id} />
                  <SubmitButton full pendingText="…">Check-out</SubmitButton>
                </ActionForm>
              ) : (
                <ActionForm action={checkIn}>
                  <input type="hidden" name="booking_id" value={b.id} />
                  <SubmitButton full className="bg-ok hover:bg-ok/90" pendingText="…">Check-in</SubmitButton>
                </ActionForm>
              )}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Cliente" hint="Dati visibili solo al personale della spiaggia" />
          <ActionForm action={updateCustomer} className="space-y-3 p-4">
            <input type="hidden" name="booking_id" value={b.id} />
            <Field label="Nome">
              <Input name="customer_name" defaultValue={b.customer_name} required maxLength={120} />
            </Field>
            <Field label="Telefono">
              <Input name="customer_phone" type="tel" defaultValue={b.customer_phone ?? ""} maxLength={40} />
            </Field>
            <Field label="Email">
              <Input name="customer_email" type="email" defaultValue={b.customer_email ?? ""} maxLength={160} />
            </Field>
            <Field label="Note">
              <Textarea name="notes" defaultValue={b.notes ?? ""} maxLength={1000} />
            </Field>
            <SubmitButton variant="secondary">Salva cliente</SubmitButton>
          </ActionForm>
        </Card>

        {activeB && due > 0 && (
          <Card>
            <CardHeader title="Registra incasso" />
            <ActionForm action={addPayment} className="grid grid-cols-2 gap-3 p-4" resetOnSuccess>
              <input type="hidden" name="booking_id" value={b.id} />
              <Field label="Importo €">
                <Input name="amount" type="number" min={0.01} max={due} step="0.01" defaultValue={due} inputMode="decimal" required />
              </Field>
              <Field label="Metodo">
                <Select name="method" defaultValue="contanti">
                  {Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              <div className="col-span-2">
                <SubmitButton full>Incassa</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        )}

        {activeB && (
          <Card>
            <CardHeader title="Cambia postazione" hint="Vale per tutto il periodo. Lo spostamento viene registrato." />
            {freePoints.length === 0 ? (
              <p className="p-4 text-sm text-muted">Nessuna postazione libera per tutto il periodo.</p>
            ) : (
              <ActionForm action={moveBooking} className="space-y-3 p-4">
                <input type="hidden" name="booking_id" value={b.id} />
                <Select name="to_point" required defaultValue="" aria-label="Nuova postazione">
                  <option value="" disabled>Scegli…</option>
                  {freePoints.map((p) => (
                    <option key={p.id} value={p.id}>
                      {pointName(p)}{p.zone ? ` — settore ${p.zone}` : ""}{p.row_label ? `, fila ${p.row_label}` : ""}
                    </option>
                  ))}
                </Select>
                <Input name="note" placeholder="Motivo (facoltativo)" maxLength={300} />
                <SubmitButton variant="secondary" full>Sposta</SubmitButton>
              </ActionForm>
            )}
          </Card>
        )}

        {manage && activeB && (
          <Card>
            <CardHeader title="Modifica prezzo" hint="Serve un motivo; resta in registro." />
            <ActionForm action={setPrice} className="space-y-3 p-4">
              <input type="hidden" name="booking_id" value={b.id} />
              <Field label="Nuovo prezzo €">
                <Input name="price" type="number" min={0} step="0.01" defaultValue={b.price} inputMode="decimal" required />
              </Field>
              <Field label="Motivo">
                <Input name="reason" required maxLength={300} placeholder="Es. cliente abituale, sconto 10%" />
              </Field>
              <SubmitButton variant="secondary">Aggiorna prezzo</SubmitButton>
            </ActionForm>
          </Card>
        )}

        {manage && b.paid_amount > 0 && (
          <Card>
            <CardHeader title="Rimborso" />
            <ActionForm action={addPayment} className="grid grid-cols-2 gap-3 p-4" resetOnSuccess>
              <input type="hidden" name="booking_id" value={b.id} />
              <input type="hidden" name="refund" value="1" />
              <Field label="Importo €">
                <Input name="amount" type="number" min={0.01} max={b.paid_amount} step="0.01" inputMode="decimal" required />
              </Field>
              <Field label="Metodo">
                <Select name="method" defaultValue="contanti">
                  {Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              <div className="col-span-2">
                <SubmitButton variant="danger" full confirm="Registrare il rimborso?">Registra rimborso</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        )}

        {canCancel && (
          <Card>
            <CardHeader title="Annulla prenotazione" hint={manage ? undefined : "Puoi annullare solo prenotazioni giornaliere non pagate."} />
            <ActionForm action={cancelBooking} className="space-y-3 p-4">
              <input type="hidden" name="booking_id" value={b.id} />
              <Input name="reason" placeholder="Motivo (facoltativo)" maxLength={300} />
              <SubmitButton variant="danger" confirm="Annullare la prenotazione? La postazione torna libera.">Annulla prenotazione</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>

      {((moves ?? []).length > 0 || (paymentsRes.data ?? []).length > 0) && (
        <Card className="mt-5">
          <CardHeader title="Storico" />
          <ul className="divide-y divide-sand text-sm">
            {(moves ?? []).map((m) => (
              <li key={m.id} className="px-4 py-2.5">
                <span className="font-bold text-night">Cambio postazione</span> {byId.get(m.from_point_id)?.label ?? "?"} → {byId.get(m.to_point_id)?.label ?? "?"}
                <span className="text-muted"> · {formatDateTime(m.moved_at, tz)}{m.note ? ` · ${m.note}` : ""}</span>
              </li>
            ))}
            {(paymentsRes.data ?? []).map((p) => (
              <li key={p.id} className="px-4 py-2.5">
                <span className="font-bold text-night">{Number(p.amount) < 0 ? "Rimborso" : "Incasso"} {formatEur(Math.abs(Number(p.amount)))}</span>
                <span className="text-muted"> · {METHOD[p.method] ?? p.method} · {formatDateTime(p.created_at, tz)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
