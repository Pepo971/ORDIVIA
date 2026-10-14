import Link from "next/link";
import {
  BEACH_PERIODS,
  POINT_STATE_LABEL,
  balanceDue,
  quotePrice,
  todayIn,
  type BeachPeriod,
  type PointState,
} from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Badge, Card, EmptyState, Field, Input, LinkButton, Notice, PageHeader, Select, cx } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatEur, formatTime } from "@/lib/format";
import { BOOKING_STATUS, beachDate, getBeachDay, getRates, pointName, type BeachBooking, type BeachPoint } from "@/lib/beach-queries";
import { checkIn, checkOut, createBooking, markNoShow, moveBooking, setOutOfService } from "./actions";
import { BeachMap, BeachTabs, DateNav, Legend, STATE_STYLE } from "./beach-ui";

export const metadata = { title: "Spiaggia" };
export const dynamic = "force-dynamic";

export default async function SpiaggiaPage({ searchParams }: { searchParams: Promise<{ data?: string; p?: string }> }) {
  const ctx = await requirePerm("beach.operate", "beach.manage");
  const sp = await searchParams;
  const tz = ctx.facility.timezone;
  const today = todayIn(tz);
  const date = beachDate(ctx, sp.data);
  const [day, rates] = await Promise.all([getBeachDay(ctx, date), getRates(ctx.facility.id)]);
  const manage = can(ctx, "beach.manage");

  const counts: Partial<Record<PointState, number>> = {};
  for (const s of day.states.values()) counts[s.state] = (counts[s.state] ?? 0) + 1;
  const selected = day.points.find((p) => p.id === sp.p) ?? null;
  const hrefFor = (p: BeachPoint) => `/servizio/spiaggia?data=${date}&p=${p.id}#postazione`;

  return (
    <div>
      <LiveRefresh tables={["beach_bookings", "beach_point_flags"]} facilityId={ctx.facility.id} intervalMs={20000} />
      <PageHeader title="Spiaggia" subtitle="Tocca una postazione per vedere chi c'è, fare check-in, spostare o prenotare." />
      <BeachTabs ctx={ctx} active="giornata" />

      <div className="mb-4 flex flex-col gap-3">
        <DateNav date={date} today={today} basePath="/servizio/spiaggia" />
        <Legend counts={counts} />
      </div>

      {day.points.length === 0 ? (
        <Card>
          <EmptyState
            title="La mappa della spiaggia è vuota"
            text={manage ? "Crea i settori e le file di ombrelloni: bastano pochi secondi." : "Chiedi al responsabile della spiaggia di creare la mappa."}
            action={manage ? <LinkButton href="/servizio/spiaggia/mappa">Crea la mappa</LinkButton> : undefined}
          />
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1fr_24rem] lg:items-start">
          <Card className="p-3 sm:p-4">
            <BeachMap points={day.points} states={day.states} hrefFor={hrefFor} selected={selected?.id} />
          </Card>
          <div id="postazione" className="scroll-mt-4 lg:sticky lg:top-4">
            {selected ? (
              <PointPanel
                point={selected}
                date={date}
                today={today}
                tz={tz}
                manage={manage}
                bookings={day.bookings.filter((b) => b.service_point_id === selected.id)}
                state={day.states.get(selected.id)?.state ?? "libero"}
                freeSlot={day.states.get(selected.id)?.freeSlot ?? "intera"}
                oosNote={day.outOfService.has(selected.id) ? (day.outOfService.get(selected.id) ?? "") : null}
                freePoints={day.points.filter((p) => p.id !== selected.id && day.states.get(p.id)?.state === "libero" && !day.outOfService.has(p.id))}
                quote={(period: BeachPeriod, lettini: number) => {
                  const q = quotePrice(rates, selected, period, date, date, lettini);
                  return q.ok ? q.total : null;
                }}
              />
            ) : (
              <Card className="p-5">
                <p className="font-bold text-night">Nessuna postazione selezionata</p>
                <p className="mt-1 text-sm text-muted">Tocca un ombrellone sulla mappa.</p>
                <ArrivalsList bookings={day.bookings} points={day.points} date={date} />
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ArrivalsList({ bookings, points, date }: { bookings: BeachBooking[]; points: BeachPoint[]; date: string }) {
  const byId = new Map(points.map((p) => [p.id, p]));
  const waiting = bookings.filter((b) => b.status === "prenotata" || (b.status === "presente" && b.last_checkin_on !== date));
  if (waiting.length === 0) return null;
  return (
    <div className="mt-4">
      <p className="mb-2 text-sm font-bold text-night">In arrivo ({waiting.length})</p>
      <ul className="divide-y divide-sand rounded-xl border border-sand">
        {waiting.slice(0, 30).map((b) => {
          const p = byId.get(b.service_point_id);
          return (
            <li key={b.id}>
              <Link href={`/servizio/spiaggia?data=${date}&p=${b.service_point_id}#postazione`} className="flex items-center justify-between gap-2 px-3 py-2.5 hover:bg-warm">
                <span className="font-bold text-night">{b.customer_name}</span>
                <span className="text-sm text-muted">
                  {p?.label ?? "—"} · {BEACH_PERIODS[b.period].label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PointPanel({
  point,
  date,
  today,
  tz,
  manage,
  bookings,
  state,
  freeSlot,
  oosNote,
  freePoints,
  quote,
}: {
  point: BeachPoint;
  date: string;
  today: string;
  tz: string;
  manage: boolean;
  bookings: BeachBooking[];
  state: PointState;
  freeSlot: "intera" | "mattina" | "pomeriggio" | null;
  oosNote: string | null;
  freePoints: BeachPoint[];
  quote: (period: BeachPeriod, lettini: number) => number | null;
}) {
  const active = bookings.filter((b) => b.status === "prenotata" || b.status === "presente");
  const past = bookings.filter((b) => !(b.status === "prenotata" || b.status === "presente"));
  const isToday = date === today;
  const canBook = freeSlot != null && oosNote == null && (date >= today || manage);
  const walkPeriods: BeachPeriod[] =
    freeSlot === "intera" ? ["giornata", "mattina", "pomeriggio"] : freeSlot === "mattina" ? ["mattina"] : freeSlot === "pomeriggio" ? ["pomeriggio"] : [];
  const lettiniDefault = point.seats ?? 2;

  return (
    <Card className="overflow-hidden">
      <div className={cx("flex items-center justify-between gap-3 px-4 py-3", STATE_STYLE[state], "rounded-none border-0 border-b-2")}>
        <div>
          <p className="font-display text-2xl font-semibold">{pointName(point)}</p>
          <p className="text-sm font-bold opacity-90">
            {point.zone ? `Settore ${point.zone}` : ""}
            {point.row_label ? ` · fila ${point.row_label}` : ""}
            {point.seats != null ? ` · ${point.seats} lettini` : ""}
          </p>
        </div>
        <span className="rounded-full bg-white/90 px-3 py-1 text-sm font-extrabold text-night">{POINT_STATE_LABEL[state]}</span>
      </div>

      {oosNote != null && (
        <div className="px-4 pt-4">
          <Notice tone="danger">Fuori servizio: {oosNote || "senza nota"}</Notice>
        </div>
      )}

      {active.length === 0 && oosNote == null && <p className="px-4 pt-4 font-bold text-night">Libera per tutto il giorno.</p>}

      {active.map((b) => {
        const presentToday = b.status === "presente" && b.last_checkin_on === date;
        const due = balanceDue(b.price, b.paid_amount);
        return (
          <div key={b.id} className="border-b border-sand px-4 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/servizio/spiaggia/prenotazioni/${b.id}`} className="text-lg font-extrabold text-night underline-offset-2 hover:underline">
                {b.customer_name}
              </Link>
              <Badge tone={presentToday ? "ok" : "teal"}>{presentToday ? "Presente" : "Prenotata"}</Badge>
              <Badge tone="neutral">{BEACH_PERIODS[b.period].label}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted">
              {b.start_date !== b.end_date ? `Dal ${b.start_date} al ${b.end_date} · ` : ""}
              {b.lettini} lettini
              {presentToday && b.checked_in_at ? ` · entrato alle ${formatTime(b.checked_in_at, tz)}` : ""}
            </p>
            {b.customer_phone && (
              <a href={`tel:${b.customer_phone.replace(/\s+/g, "")}`} className="mt-1 inline-block text-sm font-bold text-teal-deep">
                {b.customer_phone}
              </a>
            )}
            {b.notes && <p className="mt-1 text-sm text-ink">«{b.notes}»</p>}
            <p className={cx("mt-2 text-base font-extrabold", due > 0 ? "text-danger" : "text-ok")}>
              {due > 0 ? `Da incassare ${formatEur(due)}` : "Pagato"}
              <span className="ml-2 text-sm font-semibold text-muted">su {formatEur(b.price)}</span>
            </p>

            {isToday && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                {!presentToday ? (
                  <ActionForm action={checkIn} className="col-span-2">
                    <input type="hidden" name="booking_id" value={b.id} />
                    <SubmitButton full className="min-h-14 bg-ok text-lg hover:bg-ok/90" pendingText="…">
                      Check-in
                    </SubmitButton>
                  </ActionForm>
                ) : (
                  <ActionForm action={checkOut} className="col-span-2">
                    <input type="hidden" name="booking_id" value={b.id} />
                    <SubmitButton full className="min-h-14 text-lg" pendingText="…">
                      Check-out
                    </SubmitButton>
                  </ActionForm>
                )}
                {!presentToday && b.status === "prenotata" && (b.start_date === b.end_date || manage) && (
                  <ActionForm action={markNoShow} className="col-span-2">
                    <input type="hidden" name="booking_id" value={b.id} />
                    <SubmitButton variant="secondary" full pendingText="…" confirm={`${b.customer_name} non si è presentato?`}>
                      Non presentato
                    </SubmitButton>
                  </ActionForm>
                )}
              </div>
            )}

            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-bold text-night">Cambia postazione</summary>
              {freePoints.length === 0 ? (
                <p className="mt-2 text-sm text-muted">Nessuna postazione libera in questa data.</p>
              ) : (
                <ActionForm action={moveBooking} className="mt-2 space-y-2">
                  <input type="hidden" name="booking_id" value={b.id} />
                  <input type="hidden" name="date" value={date} />
                  <Field label="Nuova postazione" hint={b.start_date !== b.end_date ? "Lo spostamento vale per tutto il periodo prenotato." : undefined}>
                    <Select name="to_point" required defaultValue="">
                      <option value="" disabled>
                        Scegli…
                      </option>
                      {freePoints.map((p) => (
                        <option key={p.id} value={p.id}>
                          {pointName(p)}
                          {p.zone ? ` — settore ${p.zone}` : ""}
                          {p.row_label ? `, fila ${p.row_label}` : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Input name="note" placeholder="Motivo (facoltativo)" maxLength={300} />
                  <SubmitButton variant="secondary" full pendingText="Sposto…">
                    Sposta
                  </SubmitButton>
                </ActionForm>
              )}
            </details>
          </div>
        );
      })}

      {canBook && walkPeriods.length > 0 && (
        <div className="bg-warm px-4 py-4">
          <h3 className="mb-3 text-base font-extrabold text-night">{isToday ? "Prenotazione al volo" : "Prenota per questa data"}</h3>
          <ActionForm action={createBooking} className="space-y-3">
            <input type="hidden" name="point_id" value={point.id} />
            <input type="hidden" name="start_date" value={date} />
            <input type="hidden" name="back" value="mappa" />
            <Field label="Cliente">
              <Input name="customer_name" required maxLength={120} placeholder="Nome e cognome" autoComplete="off" className="text-lg" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Periodo">
                <Select name="period" defaultValue={walkPeriods[0]}>
                  {walkPeriods.map((p) => {
                    const q = quote(p, lettiniDefault);
                    return (
                      <option key={p} value={p}>
                        {BEACH_PERIODS[p].label}
                        {q != null ? ` — ${formatEur(q)}` : " — senza tariffa"}
                      </option>
                    );
                  })}
                </Select>
              </Field>
              <Field label="Lettini">
                <Input name="lettini" type="number" min={0} max={20} defaultValue={lettiniDefault} inputMode="numeric" />
              </Field>
            </div>
            <Field label="Telefono (facoltativo)">
              <Input name="customer_phone" type="tel" maxLength={40} autoComplete="off" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Incassato ora €" hint="Il prezzo è quello di listino">
                <Input name="paid" type="number" min={0} step="0.01" inputMode="decimal" placeholder="0" />
              </Field>
              <Field label="Metodo">
                <Select name="method" defaultValue="contanti">
                  <option value="contanti">Contanti</option>
                  <option value="carta">Carta</option>
                  <option value="bonifico">Bonifico</option>
                  <option value="altro">Altro</option>
                </Select>
              </Field>
            </div>
            {isToday && (
              <label className="flex min-h-11 items-center gap-2 text-sm font-bold text-night">
                <input type="checkbox" name="checkin" value="1" defaultChecked className="h-5 w-5" />
                Il cliente è già qui (check-in subito)
              </label>
            )}
            <SubmitButton full className="min-h-14 text-lg" pendingText="Prenoto…">
              Prenota {point.label}
            </SubmitButton>
            <p className="text-xs text-muted">
              Più giorni, abbonamenti o prezzi diversi: <Link href={`/servizio/spiaggia/prenotazioni/nuova?p=${point.id}&data=${date}`} className="font-bold underline">prenotazione completa</Link>.
            </p>
          </ActionForm>
        </div>
      )}

      {past.length > 0 && (
        <div className="px-4 py-3">
          <p className="mb-1 text-xs font-bold text-muted uppercase">Altre prenotazioni del giorno</p>
          <ul className="space-y-1 text-sm">
            {past.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-2">
                <Link href={`/servizio/spiaggia/prenotazioni/${b.id}`} className="font-bold text-night hover:underline">
                  {b.customer_name}
                </Link>
                <Badge tone={BOOKING_STATUS[b.status].tone}>{BOOKING_STATUS[b.status].label}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isToday && (
        <details className="border-t border-sand px-4 py-3">
          <summary className="cursor-pointer text-sm font-bold text-night">{oosNote != null ? "Rimetti in servizio" : "Segnala fuori servizio"}</summary>
          <ActionForm action={setOutOfService} className="mt-2 space-y-2">
            <input type="hidden" name="point_id" value={point.id} />
            <input type="hidden" name="out" value={oosNote != null ? "0" : "1"} />
            {oosNote == null && <Input name="note" required maxLength={300} placeholder="Es. ombrellone strappato" />}
            <SubmitButton variant={oosNote != null ? "secondary" : "danger"} full pendingText="…">
              {oosNote != null ? "Di nuovo in servizio" : "Metti fuori servizio"}
            </SubmitButton>
          </ActionForm>
        </details>
      )}
    </Card>
  );
}
