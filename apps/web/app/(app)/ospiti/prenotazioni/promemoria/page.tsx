import Link from "next/link";
import { addDays, reminderMailtoLink, reminderText, reminderWhatsappLink, todayIn } from "@ordivia/domain";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatDate, formatDateTime } from "@/lib/format";
import { getReservations, getServices, guestLabel, resDate } from "@/lib/reservations-queries";
import { markReminded } from "../actions";
import { CopyText } from "../copy-text";
import { BASE, DateNav, ResTabs, StatusBadge } from "../res-ui";

export const metadata = { title: "Promemoria prenotazioni" };
export const dynamic = "force-dynamic";

export default async function PromemoriaPage({ searchParams }: { searchParams: Promise<{ data?: string }> }) {
  const ctx = await requirePerm("reservations.manage");
  const sp = await searchParams;
  const tz = ctx.facility.timezone;
  const today = todayIn(tz);
  const date = sp.data ? resDate(ctx, sp.data) : addDays(today, 1);
  const [services, all] = await Promise.all([getServices(ctx.facility.id, true), getReservations(ctx.facility.id, date, date)]);
  const byId = new Map(services.map((s) => [s.id, s]));
  const list = all.filter((r) => r.status === "in_attesa_conferma" || r.status === "confermata");
  const toDo = list.filter((r) => !r.reminded_at);
  const done = list.filter((r) => r.reminded_at);

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={date === addDays(today, 1) ? "Da ricordare domani" : "Da ricordare"}
        subtitle="Apri WhatsApp o l'email dal tuo dispositivo con il testo già pronto, poi segna come ricordato."
      />
      <ResTabs active="promemoria" />
      <div className="mb-4">
        <DateNav date={date} today={today} basePath={`${BASE}/promemoria`} />
      </div>

      {list.length === 0 ? (
        <Card>
          <EmptyState title="Nessuna prenotazione da ricordare" text={`Nessuna prenotazione attiva per ${formatDate(date, tz)}.`} />
        </Card>
      ) : (
        <>
          {toDo.length > 1 && (
            <form action={markReminded} className="mb-3 flex justify-end">
              {toDo.map((r) => (
                <input key={r.id} type="hidden" name="reservation_id" value={r.id} />
              ))}
              <button className="min-h-11 rounded-xl border border-sand-deep bg-white px-4 text-sm font-bold text-night hover:border-night-3">Segna tutti come ricordati ({toDo.length})</button>
            </form>
          )}
          <Card className="overflow-hidden">
            <CardHeader title={`Da ricordare (${toDo.length})`} />
            {toDo.length === 0 && <p className="px-4 py-3 text-sm text-muted">Tutti ricordati.</p>}
            <ul className="divide-y divide-sand">
              {toDo.map((r) => {
                const service = byId.get(r.service_id);
                const text = reminderText({
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
                const wa = reminderWhatsappLink(r.customer?.phone, text);
                const mail = reminderMailtoLink(r.customer?.email, `Promemoria prenotazione — ${ctx.facility.name}`, text);
                return (
                  <li key={r.id} className="px-4 py-4">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-extrabold text-night tabular-nums">{r.res_time}</span>
                      <Link href={`${BASE}/${r.id}`} className="font-bold text-night hover:underline">
                        {guestLabel(r)}
                      </Link>
                      <span className="text-sm text-muted">· {r.party_size} pers. · {service?.name}</span>
                      <StatusBadge status={r.status} />
                    </p>
                    {!wa && !mail && <p className="mt-1 text-sm font-bold text-warn">Nessun recapito: chiama o aggiungi telefono/email alla scheda.</p>}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm font-bold text-muted">Vedi testo</summary>
                      <pre className="mt-2 rounded-xl bg-warm p-3 text-sm whitespace-pre-wrap text-ink">{text}</pre>
                    </details>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {wa && (
                        <a href={wa} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-xl bg-night px-4 text-sm font-bold text-warm hover:bg-night-2">
                          WhatsApp
                        </a>
                      )}
                      {mail && (
                        <a href={mail} className="inline-flex min-h-11 items-center rounded-xl border border-sand-deep bg-white px-4 text-sm font-bold text-night hover:border-night-3">
                          Email
                        </a>
                      )}
                      <CopyText text={text} />
                      <form action={markReminded}>
                        <input type="hidden" name="reservation_id" value={r.id} />
                        <button className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-bold text-teal-deep hover:bg-teal-soft">Segna ricordato</button>
                      </form>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
          {done.length > 0 && (
            <Card className="mt-4 overflow-hidden">
              <CardHeader title={`Già ricordati (${done.length})`} />
              <ul className="divide-y divide-sand">
                {done.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                    <span className="font-bold tabular-nums">{r.res_time}</span>
                    <Link href={`${BASE}/${r.id}`} className="font-semibold text-night hover:underline">
                      {guestLabel(r)}
                    </Link>
                    <Badge tone="ok">ricordato {formatDateTime(r.reminded_at, tz)}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
