import Link from "next/link";
import { notFound } from "next/navigation";
import {
  RESERVATION_SOURCE_LABEL,
  RESERVATION_STATUS_LABEL,
  RESERVATION_TRANSITIONS,
  reminderMailtoLink,
  reminderText,
  reminderWhatsappLink,
  todayIn,
  type ReservationStatus,
} from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Field, Input, LinkButton, Notice, PageHeader, Select, Textarea } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDate, formatDateTime, formatEur } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { getReservations, getServices, getTables, guestLabel, normReservation, RES_COLUMNS, UUID_RE } from "@/lib/reservations-queries";
import { assignTable, setDepositPaid, setStatus, updateReservation } from "../actions";
import { CopyText } from "../copy-text";
import { AllergyBadges, BASE, StatusBadge } from "../res-ui";

export const dynamic = "force-dynamic";

const ACTION_LABEL: Partial<Record<ReservationStatus, string>> = {
  confermata: "Conferma",
  arrivata: "Arrivati",
  completata: "Tavolo chiuso",
  no_show: "Non presentati",
  annullata: "Annulla",
};

export default async function ReservationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ nuova?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm("reservations.manage");
  if (!UUID_RE.test(id)) notFound();
  const supabase = await createClient();
  const { data } = await supabase.from("reservations").select(RES_COLUMNS).eq("id", id).eq("facility_id", ctx.facility.id).maybeSingle();
  if (!data) notFound();
  const r = normReservation(data);
  const tz = ctx.facility.timezone;
  const today = todayIn(tz);
  const [services, tables, sameDay] = await Promise.all([getServices(ctx.facility.id, true), getTables(ctx.facility.id), getReservations(ctx.facility.id, r.res_date, r.res_date)]);
  const service = services.find((s) => s.id === r.service_id);
  const table = tables.find((t) => t.id === r.service_point_id);
  const active = ["in_attesa_conferma", "confermata", "arrivata"].includes(r.status);
  const busy = new Set(
    sameDay
      .filter((o) => o.id !== r.id && o.service_point_id && ["in_attesa_conferma", "confermata", "arrivata"].includes(o.status) && o.starts_at < r.ends_at && r.starts_at < o.ends_at)
      .map((o) => o.service_point_id as string),
  );
  const nextStates = RESERVATION_TRANSITIONS[r.status].filter((s) => {
    if (s === "arrivata" && r.res_date > today) return false;
    if (s === "no_show" && new Date(r.starts_at).getTime() > Date.now()) return false;
    return true;
  });
  const message = reminderText({
    guestName: guestLabel(r),
    facilityName: ctx.facility.name,
    serviceName: service?.name ?? "prenotazione",
    date: r.res_date,
    time: r.res_time,
    partySize: r.party_size,
    depositDue: r.deposit_required > 0 && !r.deposit_paid_at ? r.deposit_required : null,
    cancellationPolicy: service?.cancellation_policy,
    confirmNeeded: r.status === "in_attesa_conferma",
  });
  const wa = reminderWhatsappLink(r.customer?.phone, message);
  const mail = reminderMailtoLink(r.customer?.email, `Prenotazione ${ctx.facility.name}`, message);
  const timeline: [string, string | null][] = [
    ["Creata", r.created_at],
    ["Confermata", r.confirmed_at],
    ["Arrivata", r.arrived_at],
    ["Completata", r.completed_at],
    ["Non presentata", r.no_show_at],
    ["Annullata", r.cancelled_at],
    ["Promemoria inviato", r.reminded_at],
    ["Acconto ricevuto", r.deposit_paid_at],
  ];

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={guestLabel(r)}
        subtitle={
          <>
            {service?.name ?? "—"} · {formatDate(r.res_date, tz)} alle {r.res_time} · {r.party_size} {r.party_size === 1 ? "persona" : "persone"}
          </>
        }
        action={<LinkButton href={`${BASE}?data=${r.res_date}`} variant="secondary">Giornata</LinkButton>}
      />
      {sp.nuova && <div className="mb-4"><Notice tone="ok">Prenotazione salvata.</Notice></div>}

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={r.status} />
          <span className="text-sm text-muted">Canale: {RESERVATION_SOURCE_LABEL[r.source]}</span>
          {table && <span className="text-sm font-bold text-night">· Tavolo {table.label}</span>}
        </div>
        {r.customer && (
          <p className="mt-2 text-sm">
            {can(ctx, "crm.view", "crm.manage", "reservations.manage") ? (
              <Link href={`/ospiti/clienti/${r.customer.id}`} className="font-bold text-teal-deep">
                Scheda cliente
              </Link>
            ) : null}
            {r.customer.phone && (
              <>
                {" · "}
                <a href={`tel:${r.customer.phone}`} className="font-bold text-night">{r.customer.phone}</a>
              </>
            )}
            {r.customer.email && <span className="text-muted"> · {r.customer.email}</span>}
          </p>
        )}
        {r.allergies.length > 0 && <div className="mt-2"><AllergyBadges allergies={r.allergies} /></div>}
        {r.special_requests && <p className="mt-2 text-ink">«{r.special_requests}»</p>}
        {r.cancel_reason && <p className="mt-2 text-sm text-danger">Motivo annullamento: {r.cancel_reason}</p>}

        {nextStates.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {nextStates.map((s) =>
              s === "annullata" ? null : (
                <ActionForm key={s} action={setStatus}>
                  <input type="hidden" name="reservation_id" value={r.id} />
                  <input type="hidden" name="to" value={s} />
                  <SubmitButton variant={s === "no_show" ? "danger" : s === "arrivata" || s === "completata" ? "primary" : "secondary"} pendingText="…">
                    {ACTION_LABEL[s] ?? `Riporta a «${RESERVATION_STATUS_LABEL[s]}»`}
                  </SubmitButton>
                </ActionForm>
              ),
            )}
          </div>
        )}
        {nextStates.includes("annullata") && (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-bold text-danger">Annulla prenotazione</summary>
            <ActionForm action={setStatus} className="mt-2 flex flex-wrap items-end gap-2">
              <input type="hidden" name="reservation_id" value={r.id} />
              <input type="hidden" name="to" value="annullata" />
              <div className="min-w-0 flex-1">
                <Field label="Motivo (facoltativo)">
                  <Input name="reason" maxLength={300} />
                </Field>
              </div>
              <SubmitButton variant="danger" pendingText="…" confirm="Annullare la prenotazione?">Annulla</SubmitButton>
            </ActionForm>
          </details>
        )}
      </Card>

      {active && tables.length > 0 && (
        <Card className="mb-4 p-4">
          <ActionForm action={assignTable} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="reservation_id" value={r.id} />
            <div className="min-w-0 flex-1">
              <Field label="Tavolo" hint="Sono elencati solo i tavoli liberi per tutta la durata">
                <Select name="table_id" defaultValue={r.service_point_id ?? ""}>
                  <option value="">Nessun tavolo</option>
                  {tables
                    .filter((t) => !busy.has(t.id))
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                        {t.seats ? ` (${t.seats} posti)` : ""}
                        {t.zone ? ` · ${t.zone}` : ""}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <SubmitButton variant="secondary" pendingText="…">Salva tavolo</SubmitButton>
          </ActionForm>
        </Card>
      )}

      {r.deposit_required > 0 && (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="font-bold text-night">
            Acconto {formatEur(r.deposit_required)}{" "}
            <span className={r.deposit_paid_at ? "text-ok" : "text-warn"}>{r.deposit_paid_at ? `ricevuto ${formatDateTime(r.deposit_paid_at, tz)}` : "da ricevere"}</span>
          </p>
          <ActionForm action={setDepositPaid}>
            <input type="hidden" name="reservation_id" value={r.id} />
            <input type="hidden" name="paid" value={r.deposit_paid_at ? "0" : "1"} />
            <SubmitButton variant="secondary" pendingText="…">{r.deposit_paid_at ? "Segna da ricevere" : "Segna ricevuto"}</SubmitButton>
          </ActionForm>
        </Card>
      )}

      {active && (wa || mail || r.customer) && (
        <Card className="mb-4 overflow-hidden">
          <CardHeader title="Messaggio al cliente" hint="Si apre WhatsApp o l'email del tuo dispositivo: Ordivia non invia messaggi." />
          <div className="p-4">
            <pre className="max-h-56 overflow-auto rounded-xl bg-warm p-3 text-sm whitespace-pre-wrap text-ink">{message}</pre>
            <div className="mt-3 flex flex-wrap gap-2">
              {wa && (
                <a href={wa} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-xl border border-sand-deep bg-white px-4 text-sm font-bold text-night hover:border-night-3">
                  Apri WhatsApp
                </a>
              )}
              {mail && (
                <a href={mail} className="inline-flex min-h-11 items-center rounded-xl border border-sand-deep bg-white px-4 text-sm font-bold text-night hover:border-night-3">
                  Apri email
                </a>
              )}
              <CopyText text={message} />
            </div>
          </div>
        </Card>
      )}

      {active && (
        <Card className="mb-4 overflow-hidden">
          <details>
            <summary className="cursor-pointer px-4 py-3 font-bold text-night">Modifica data, orario, persone e note</summary>
            <ActionForm action={updateReservation} className="space-y-3 px-4 pb-4">
              <input type="hidden" name="reservation_id" value={r.id} />
              <div className="grid grid-cols-3 gap-3">
                <Field label="Data">
                  <Input name="res_date" type="date" defaultValue={r.res_date} min={today} required />
                </Field>
                <Field label="Ora">
                  <Input name="res_time" type="time" defaultValue={r.res_time} required />
                </Field>
                <Field label="Persone">
                  <Input name="party_size" type="number" min={1} max={500} defaultValue={r.party_size} required />
                </Field>
              </div>
              <Field label="Allergie" hint="Separate da virgola">
                <Input name="allergies" defaultValue={r.allergies.join(", ")} maxLength={600} />
              </Field>
              <Field label="Richieste speciali">
                <Textarea name="special_requests" defaultValue={r.special_requests ?? ""} maxLength={1000} rows={2} />
              </Field>
              <Field label="Note interne">
                <Textarea name="notes" defaultValue={r.notes ?? ""} maxLength={1000} rows={2} />
              </Field>
              <Field label="Acconto richiesto (€)">
                <Input name="deposit" inputMode="decimal" defaultValue={r.deposit_required ? String(r.deposit_required) : ""} />
              </Field>
              <SubmitButton pendingText="Salvataggio…">Salva modifiche</SubmitButton>
            </ActionForm>
          </details>
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader title="Cronologia" />
        <ul className="divide-y divide-sand">
          {timeline
            .filter(([, at]) => at)
            .map(([label, at]) => (
              <li key={label} className="flex justify-between px-4 py-2 text-sm">
                <span className="font-bold text-night">{label}</span>
                <span className="text-muted">{formatDateTime(at, tz)}</span>
              </li>
            ))}
        </ul>
        {r.notes && <p className="border-t border-sand px-4 py-3 text-sm text-ink">Note: {r.notes}</p>}
      </Card>
    </div>
  );
}
