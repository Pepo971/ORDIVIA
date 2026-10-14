import Link from "next/link";
import { RESERVATION_SOURCE_LABEL, formatHm, todayIn, zonedParts } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Badge, Card, CardHeader, EmptyState, Field, Input, LinkButton, PageHeader, Select, cx } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import {
  getReservations,
  getServices,
  getSlots,
  getTables,
  getWaitlist,
  guestLabel,
  resDate,
  type Reservation,
  type ResService,
  type SlotRow,
  type TableRow,
} from "@/lib/reservations-queries";
import { addToWaitlist, assignTable, createReservation, promoteWaitlist, setStatus, setWaitlistStatus } from "./actions";
import { AllergyBadges, BASE, DateNav, LoadBar, ResTabs, StatusBadge } from "./res-ui";

export const metadata = { title: "Prenotazioni" };
export const dynamic = "force-dynamic";

const ACTIVE = new Set(["in_attesa_conferma", "confermata", "arrivata"]);

export default async function PrenotazioniGiornoPage({ searchParams }: { searchParams: Promise<{ data?: string; q?: string; s?: string }> }) {
  const ctx = await requirePerm("reservations.manage");
  const sp = await searchParams;
  const tz = ctx.facility.timezone;
  const today = todayIn(tz);
  const date = resDate(ctx, sp.data);
  const q = (sp.q ?? "").trim().toLowerCase().slice(0, 80);

  const [services, reservations, tables, waitlist] = await Promise.all([
    getServices(ctx.facility.id),
    getReservations(ctx.facility.id, date, date),
    getTables(ctx.facility.id),
    getWaitlist(ctx.facility.id, date),
  ]);
  const slotsByService = new Map<string, SlotRow[]>(
    await Promise.all(services.map(async (s) => [s.id, await getSlots(s.id, date)] as [string, SlotRow[]])),
  );
  const openServices = services.filter((s) => (slotsByService.get(s.id)?.length ?? 0) > 0);
  const filtered = q
    ? reservations.filter((r) =>
        [guestLabel(r), r.customer?.phone ?? "", r.customer?.email ?? "", r.notes ?? ""].some((v) => v.toLowerCase().includes(q)),
      )
    : reservations;
  const active = filtered.filter((r) => ACTIVE.has(r.status));
  const closed = filtered.filter((r) => !ACTIVE.has(r.status));
  const covers = reservations.filter((r) => ACTIVE.has(r.status) || r.status === "completata").reduce((s, r) => s + r.party_size, 0);
  const pending = reservations.filter((r) => r.status === "in_attesa_conferma").length;
  const tableById = new Map(tables.map((t) => [t.id, t]));
  const serviceById = new Map(services.map((s) => [s.id, s]));

  return (
    <div>
      <LiveRefresh tables={["reservations", "reservation_waitlist"]} facilityId={ctx.facility.id} intervalMs={30000} />
      <PageHeader
        title="Prenotazioni"
        subtitle={`${reservations.filter((r) => ACTIVE.has(r.status)).length} attive · ${covers} coperti${pending ? ` · ${pending} da confermare` : ""}`}
        action={<LinkButton href={`${BASE}/nuova?data=${date}`}>Nuova prenotazione</LinkButton>}
      />
      <ResTabs active="giorno" />

      <div className="mb-4 flex flex-col gap-3">
        <DateNav date={date} today={today} basePath={BASE} />
        <form action={BASE} className="flex gap-2">
          <input type="hidden" name="data" value={date} />
          <label className="sr-only" htmlFor="q">Cerca</label>
          <Input id="q" name="q" type="search" defaultValue={sp.q ?? ""} placeholder="Cerca per nome, telefono, email o nota" />
          <button className="rounded-xl bg-night px-4 font-bold text-warm">Cerca</button>
        </form>
      </div>

      {services.length === 0 ? (
        <Card>
          <EmptyState
            title="Nessun servizio prenotabile"
            text="Crea i servizi (cena, aperitivo, degustazione, spa…) con orari e capacità: poi potrai registrare le prenotazioni."
            action={<LinkButton href={`${BASE}/servizi`}>Crea un servizio</LinkButton>}
          />
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1fr_22rem] lg:items-start">
          <div className="space-y-5">
            {/* Timeline per servizio */}
            {openServices.length === 0 ? (
              <Card className="p-4">
                <p className="font-bold text-night">Nessun servizio aperto in questa data.</p>
                <p className="mt-1 text-sm text-muted">Controlla orari settimanali e chiusure in «Servizi e orari».</p>
              </Card>
            ) : (
              openServices.map((s) => <ServiceTimeline key={s.id} service={s} slots={slotsByService.get(s.id) ?? []} reservations={reservations} date={date} />)
            )}

            {/* Arrivi */}
            <Card className="overflow-hidden">
              <CardHeader title={q ? `Risultati per «${sp.q}»` : "Arrivi"} hint="Tocca il nome per i dettagli; i pulsanti cambiano stato al volo." />
              {active.length === 0 ? (
                <EmptyState
                  title={q ? "Nessuna prenotazione trovata" : "Nessuna prenotazione attiva"}
                  text={q ? "Prova con una parte del nome o del numero." : "Registra una prenotazione o un walk-in."}
                />
              ) : (
                <ul>
                  {active.map((r) => (
                    <ArrivalRow
                      key={r.id}
                      r={r}
                      service={serviceById.get(r.service_id)}
                      table={r.service_point_id ? tableById.get(r.service_point_id) : undefined}
                      tables={tables}
                      reservations={reservations}
                      isToday={date === today}
                    />
                  ))}
                </ul>
              )}
              {closed.length > 0 && (
                <details className="border-t border-sand">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-bold text-muted">Chiuse, annullate e non presentati ({closed.length})</summary>
                  <ul>
                    {closed.map((r) => (
                      <li key={r.id} className="flex items-center gap-3 border-t border-sand px-4 py-2.5">
                        <span className="w-12 font-bold text-muted tabular-nums">{r.res_time}</span>
                        <Link href={`${BASE}/${r.id}`} className="min-w-0 flex-1 truncate font-semibold text-night hover:underline">
                          {guestLabel(r)} · {r.party_size}
                        </Link>
                        <StatusBadge status={r.status} />
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </Card>
          </div>

          <div className="space-y-5 lg:sticky lg:top-4">
            {openServices.length > 0 && (date === today || date > today) && <WalkInCard services={openServices} tables={tables} date={date} isToday={date === today} nowTime={nowHm(tz)} />}
            <WaitlistCard services={services} openServices={openServices} waitlist={waitlist} date={date} slotsByService={slotsByService} tables={tables} />
          </div>
        </div>
      )}
    </div>
  );
}

function ServiceTimeline({ service, slots, reservations, date }: { service: ResService; slots: SlotRow[]; reservations: Reservation[]; date: string }) {
  const mine = reservations.filter((r) => r.service_id === service.id && ACTIVE.has(r.status));
  const arrivalsBySlot = new Map<string, number>();
  for (const r of mine) {
    const slot = [...slots].reverse().find((s) => s.slot_time <= r.res_time)?.slot_time ?? r.res_time;
    arrivalsBySlot.set(slot, (arrivalsBySlot.get(slot) ?? 0) + r.party_size);
  }
  const total = mine.reduce((s, r) => s + r.party_size, 0);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={service.name}
        hint={`${total} ${service.capacity_unit} prenotati · durata ${service.duration_min} min${service.event_date ? " · evento" : ""}`}
        action={
          <Link href={`${BASE}/nuova?data=${date}&s=${service.id}`} className="text-sm font-bold text-teal-deep">
            + Prenota
          </Link>
        }
      />
      <ul className="divide-y divide-sand">
        {slots.map((s) => (
          <li key={s.slot_time} className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-3 px-4 py-2">
            <span className="font-bold text-night tabular-nums">{s.slot_time}</span>
            <div>
              <LoadBar booked={s.booked} capacity={s.capacity} />
              {arrivalsBySlot.get(s.slot_time) ? <p className="mt-0.5 text-xs text-muted">arrivano {arrivalsBySlot.get(s.slot_time)}</p> : null}
            </div>
            <span className={cx("text-sm font-bold tabular-nums", s.available === 0 ? "text-danger" : "text-night")}>
              {s.available === 0 ? "Pieno" : `${s.available} liberi`}
              <span className="ml-1 font-semibold text-muted">/ {s.capacity}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function freeTables(tables: TableRow[], reservations: Reservation[], r: Reservation): TableRow[] {
  const busy = new Set(
    reservations
      .filter((o) => o.id !== r.id && o.service_point_id && ACTIVE.has(o.status) && o.starts_at < r.ends_at && r.starts_at < o.ends_at)
      .map((o) => o.service_point_id as string),
  );
  return tables.filter((t) => !busy.has(t.id));
}

function ArrivalRow({
  r,
  service,
  table,
  tables,
  reservations,
  isToday,
}: {
  r: Reservation;
  service?: ResService;
  table?: TableRow;
  tables: TableRow[];
  reservations: Reservation[];
  isToday: boolean;
}) {
  const options = freeTables(tables, reservations, r);
  const phone = r.customer?.phone;
  const late = isToday && r.status !== "arrivata" && new Date(r.starts_at).getTime() < Date.now() - 15 * 60000;
  return (
    <li className={cx("border-b border-sand px-4 py-3 last:border-b-0", r.status === "arrivata" && "bg-ok-soft/40")}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className="w-12 pt-0.5 text-lg font-extrabold text-night tabular-nums">{r.res_time}</span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <Link href={`${BASE}/${r.id}`} className="text-base font-extrabold text-night underline-offset-2 hover:underline">
              {guestLabel(r)}
            </Link>
            <span className="font-bold text-night">· {r.party_size} pers.</span>
            <StatusBadge status={r.status} />
            {late && <Badge tone="warn">In ritardo</Badge>}
            {table && <Badge tone="night">Tavolo {table.label}</Badge>}
            {r.deposit_required > 0 && <Badge tone={r.deposit_paid_at ? "ok" : "warn"}>{r.deposit_paid_at ? "Acconto ricevuto" : "Acconto da ricevere"}</Badge>}
          </p>
          <p className="text-sm text-muted">
            {service?.name ?? "—"} · {RESERVATION_SOURCE_LABEL[r.source]}
            {phone && (
              <>
                {" · "}
                <a href={`tel:${phone}`} className="font-bold text-teal-deep">
                  {phone}
                </a>
              </>
            )}
          </p>
          {(r.allergies.length > 0 || r.special_requests || r.notes) && (
            <div className="mt-1 space-y-1 text-sm">
              <AllergyBadges allergies={r.allergies} />
              {r.special_requests && <p className="text-ink">«{r.special_requests}»</p>}
              {r.notes && <p className="text-muted">{r.notes}</p>}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-0 sm:pl-[3.75rem]">
        {r.status === "in_attesa_conferma" && <QuickButton id={r.id} to="confermata" label="Conferma" />}
        {isToday && r.status !== "arrivata" && <QuickButton id={r.id} to="arrivata" label="Arrivati" primary />}
        {r.status === "arrivata" && <QuickButton id={r.id} to="completata" label="Tavolo chiuso" primary />}
        {isToday && r.status !== "arrivata" && new Date(r.starts_at).getTime() < Date.now() && <QuickButton id={r.id} to="no_show" label="Non presentati" />}
        {tables.length > 0 && (
          <ActionForm action={assignTable} className="flex items-center gap-1">
            <input type="hidden" name="reservation_id" value={r.id} />
            <label className="sr-only" htmlFor={`t-${r.id}`}>Tavolo</label>
            <select id={`t-${r.id}`} name="table_id" defaultValue={r.service_point_id ?? ""} className="h-10 rounded-xl border border-sand-deep bg-white px-2 text-sm font-bold text-night">
              <option value="">Nessun tavolo</option>
              {options.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                  {t.seats ? ` (${t.seats})` : ""}
                  {t.zone ? ` · ${t.zone}` : ""}
                </option>
              ))}
            </select>
            <SubmitButton variant="secondary" pendingText="…" className="!min-h-10 !px-3 !py-1.5 text-sm">
              Assegna
            </SubmitButton>
          </ActionForm>
        )}
      </div>
    </li>
  );
}

function QuickButton({ id, to, label, primary = false }: { id: string; to: string; label: string; primary?: boolean }) {
  return (
    <ActionForm action={setStatus}>
      <input type="hidden" name="reservation_id" value={id} />
      <input type="hidden" name="to" value={to} />
      <SubmitButton variant={primary ? "primary" : "secondary"} pendingText="…" className="!min-h-10 !px-3 !py-1.5 text-sm">
        {label}
      </SubmitButton>
    </ActionForm>
  );
}

function WalkInCard({ services, tables, date, isToday, nowTime }: { services: ResService[]; tables: TableRow[]; date: string; isToday: boolean; nowTime: string }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title={isToday ? "Walk-in" : "Prenotazione veloce"} hint={isToday ? "Clienti senza prenotazione: entrano subito." : "Per i dettagli usa «Nuova prenotazione»."} />
      <ActionForm action={createReservation} resetOnSuccess className="space-y-3 p-4">
        <input type="hidden" name="back" value="giorno" />
        <input type="hidden" name="res_date" value={date} />
        <input type="hidden" name="source" value={isToday ? "walk-in" : "telefono"} />
        <input type="hidden" name="status" value={isToday ? "arrivata" : "confermata"} />
        <Field label="Servizio">
          <Select name="service_id" required defaultValue={services[0]?.id}>
            {services.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Ora">
            <Input name="res_time" type="time" required defaultValue={isToday ? nowTime : "20:00"} />
          </Field>
          <Field label="Persone">
            <Input name="party_size" type="number" min={1} max={500} defaultValue={2} required inputMode="numeric" />
          </Field>
        </div>
        <Field label={isToday ? "Nome (facoltativo)" : "Nome"}>
          <Input name="name" maxLength={120} required={!isToday} autoComplete="off" />
        </Field>
        <Field label={isToday ? "Telefono (per la scheda cliente)" : "Telefono"}>
          <Input name="phone" type="tel" maxLength={40} required={!isToday} autoComplete="off" />
        </Field>
        {tables.length > 0 && (
          <Field label="Tavolo">
            <Select name="table_id" defaultValue="">
              <option value="">Da assegnare</option>
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                  {t.seats ? ` (${t.seats})` : ""}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <SubmitButton full pendingText="Registrazione…">{isToday ? "Fai accomodare" : "Prenota"}</SubmitButton>
      </ActionForm>
    </Card>
  );
}

/** Ora attuale nel fuso della struttura, arrotondata ai 5 minuti (solo suggerimento nel campo). */
function nowHm(tz: string) {
  const p = zonedParts(new Date(), tz);
  return formatHm(p.hour * 60 + p.minute - (p.minute % 5));
}

function WaitlistCard({
  services,
  openServices,
  waitlist,
  date,
  slotsByService,
  tables,
}: {
  services: ResService[];
  openServices: ResService[];
  waitlist: Awaited<ReturnType<typeof getWaitlist>>;
  date: string;
  slotsByService: Map<string, SlotRow[]>;
  tables: TableRow[];
}) {
  const byId = new Map(services.map((s) => [s.id, s]));
  return (
    <Card className="overflow-hidden">
      <CardHeader title={`Lista d'attesa${waitlist.length ? ` (${waitlist.length})` : ""}`} hint="Quando si libera posto, avvisa il cliente e conferma." />
      {waitlist.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted">Nessuno in attesa per questa data.</p>
      ) : (
        <ul className="divide-y divide-sand">
          {waitlist.map((w) => {
            const svc = byId.get(w.service_id);
            const slots = slotsByService.get(w.service_id) ?? [];
            const fit = slots.filter((s) => s.available >= w.party_size && s.max_party >= w.party_size);
            const phone = w.customer?.phone;
            return (
              <li key={w.id} className="px-4 py-3">
                <p className="flex flex-wrap items-center gap-2 font-bold text-night">
                  {w.customer?.full_name ?? "Cliente"} · {w.party_size} pers.
                  {w.status === "avvisato" && <Badge tone="teal">Avvisato</Badge>}
                  {w.notify && w.status === "in_attesa" && <Badge tone="warn">Da avvisare</Badge>}
                </p>
                <p className="text-sm text-muted">
                  {svc?.name ?? "—"}
                  {w.preferred_time ? ` · preferisce le ${w.preferred_time}` : ""}
                  {phone && (
                    <>
                      {" · "}
                      <a href={`tel:${phone}`} className="font-bold text-teal-deep">
                        {phone}
                      </a>
                    </>
                  )}
                </p>
                {w.notes && <p className="text-sm text-ink">{w.notes}</p>}
                {fit.length > 0 ? (
                  <ActionForm action={promoteWaitlist} className="mt-2 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="entry_id" value={w.id} />
                    <label className="sr-only" htmlFor={`wt-${w.id}`}>Orario</label>
                    <select
                      id={`wt-${w.id}`}
                      name="time"
                      defaultValue={fit.find((s) => s.slot_time === w.preferred_time)?.slot_time ?? fit[0]!.slot_time}
                      className="h-10 rounded-xl border border-sand-deep bg-white px-2 text-sm font-bold"
                    >
                      {fit.map((s) => (
                        <option key={s.slot_time} value={s.slot_time}>
                          {s.slot_time} ({s.available} liberi)
                        </option>
                      ))}
                    </select>
                    {tables.length > 0 && (
                      <select name="table_id" defaultValue="" className="h-10 rounded-xl border border-sand-deep bg-white px-2 text-sm font-bold" aria-label="Tavolo">
                        <option value="">Tavolo da assegnare</option>
                        {tables.map((t) => (
                          <option key={t.id} value={t.id}>{t.label}</option>
                        ))}
                      </select>
                    )}
                    <SubmitButton pendingText="…" className="!min-h-10 !py-1.5 text-sm">Conferma posto</SubmitButton>
                  </ActionForm>
                ) : (
                  <p className="mt-1 text-xs font-bold text-muted">Ancora nessun posto libero per {w.party_size}.</p>
                )}
                <div className="mt-2 flex gap-2">
                  {w.status === "in_attesa" && (
                    <form action={setWaitlistStatus}>
                      <input type="hidden" name="entry_id" value={w.id} />
                      <input type="hidden" name="status" value="avvisato" />
                      <button className="min-h-9 rounded-lg px-2 text-sm font-bold text-teal-deep hover:bg-teal-soft">Segna avvisato</button>
                    </form>
                  )}
                  <form action={setWaitlistStatus}>
                    <input type="hidden" name="entry_id" value={w.id} />
                    <input type="hidden" name="status" value="annullata" />
                    <button className="min-h-9 rounded-lg px-2 text-sm font-bold text-danger hover:bg-danger-soft">Togli</button>
                  </form>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {openServices.length > 0 && (
        <details className="border-t border-sand">
          <summary className="cursor-pointer px-4 py-3 text-sm font-bold text-night">+ Aggiungi in lista d'attesa</summary>
          <ActionForm action={addToWaitlist} resetOnSuccess className="space-y-3 px-4 pb-4">
            <input type="hidden" name="wait_date" value={date} />
            <Field label="Servizio">
              <Select name="service_id" required>
                {openServices.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Persone">
                <Input name="party_size" type="number" min={1} max={500} defaultValue={2} required />
              </Field>
              <Field label="Ora preferita">
                <Input name="preferred_time" type="time" />
              </Field>
            </div>
            <Field label="Nome">
              <Input name="name" maxLength={120} required />
            </Field>
            <Field label="Telefono">
              <Input name="phone" type="tel" maxLength={40} required />
            </Field>
            <Field label="Note">
              <Input name="notes" maxLength={500} />
            </Field>
            <label className="flex items-center gap-2 text-sm font-bold text-night">
              <input type="checkbox" name="notify" value="1" defaultChecked className="h-5 w-5" /> Avvisare appena si libera posto
            </label>
            <SubmitButton variant="secondary" full pendingText="Salvataggio…">Aggiungi</SubmitButton>
          </ActionForm>
        </details>
      )}
    </Card>
  );
}
