import Link from "next/link";
import { BEACH_PERIODS, occupancy, todayIn } from "@ordivia/domain";
import { LiveRefresh } from "@/components/live-refresh";
import { Badge, Card, CardHeader, EmptyState, Notice, PageHeader, Row } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDate, formatEur } from "@/lib/format";
import { BOOKING_COLUMNS, beachDate, getBeachDay, normBooking, pointName } from "@/lib/beach-queries";
import { createClient } from "@/lib/supabase/server";
import { BeachTabs, DateNav } from "../beach-ui";

export const metadata = { title: "Riepilogo spiaggia" };
export const dynamic = "force-dynamic";

export default async function RiepilogoPage({ searchParams }: { searchParams: Promise<{ data?: string }> }) {
  const ctx = await requirePerm("beach.manage");
  const sp = await searchParams;
  const today = todayIn(ctx.facility.timezone);
  const date = beachDate(ctx, sp.data);
  const finance = can(ctx, "finance.view");
  const supabase = await createClient();

  const [day, subsRes, revRes] = await Promise.all([
    getBeachDay(ctx, date),
    supabase
      .from("beach_bookings")
      .select(BOOKING_COLUMNS)
      .eq("facility_id", ctx.facility.id)
      .in("period", ["mese", "stagione"])
      .in("status", ["prenotata", "presente"])
      .gte("end_date", date)
      .order("customer_name")
      .limit(500),
    finance ? supabase.rpc("beach_day_revenue", { p_facility: ctx.facility.id, p_date: date }).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  const subs = (subsRes.data ?? []).map(normBooking);
  const rev = revRes.data as { sold: number; sold_count: number; accrued: number; collected: number; collected_cash: number; collected_card: number; collected_other: number } | null;
  const occ = occupancy(day.points, day.states);
  const byId = new Map(day.points.map((p) => [p.id, p]));

  const active = day.bookings.filter((b) => b.status === "prenotata" || b.status === "presente");
  const arrived = active.filter((b) => b.status === "presente" && b.last_checkin_on === date);
  const expected = active.filter((b) => !(b.status === "presente" && b.last_checkin_on === date));
  const noShow = day.bookings.filter((b) => b.status === "no_show").length;
  const due = active.reduce((s, b) => s + Math.max(b.price - b.paid_amount, 0), 0);

  return (
    <div>
      <LiveRefresh tables={["beach_bookings"]} facilityId={ctx.facility.id} intervalMs={60000} />
      <PageHeader title="Riepilogo spiaggia" subtitle="Occupazione, arrivi, abbonati e incassi della giornata." />
      <BeachTabs ctx={ctx} active="riepilogo" />
      <div className="mb-5">
        <DateNav date={date} today={today} basePath="/servizio/spiaggia/riepilogo" />
      </div>

      {day.points.length === 0 ? (
        <Card>
          <EmptyState title="Nessuna postazione" text="Crea la mappa per vedere l'occupazione." />
        </Card>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Occupazione" value={`${occ.all.pct}%`} hint={`${occ.all.occupied} su ${occ.all.total} postazioni`} />
            <Stat label="Arrivati" value={String(arrived.length)} hint={`${expected.length} attesi`} />
            <Stat label="Fuori servizio" value={String(occ.all.outOfService)} hint={noShow ? `${noShow} non presentati` : "postazioni"} />
            {finance && rev ? (
              <Stat label="Incassato oggi" value={formatEur(rev.collected)} hint={`contanti ${formatEur(rev.collected_cash)} · carta ${formatEur(rev.collected_card)}`} />
            ) : (
              <Stat label="Abbonati" value={String(subs.length)} hint="mese e stagione" />
            )}
          </div>

          {finance && rev && (
            <Card className="mb-5">
              <CardHeader title="Incassi della giornata" hint="Visibile solo a chi ha accesso ai dati economici" />
              <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                <div><dt className="text-xs font-bold text-muted uppercase">Venduto oggi</dt><dd className="text-lg font-extrabold text-night">{formatEur(rev.sold)}</dd><dd className="text-xs text-muted">{rev.sold_count} prenotazioni create</dd></div>
                <div><dt className="text-xs font-bold text-muted uppercase">Competenza del giorno</dt><dd className="text-lg font-extrabold text-night">{formatEur(rev.accrued)}</dd><dd className="text-xs text-muted">quota giornaliera di tutte le prenotazioni</dd></div>
                <div><dt className="text-xs font-bold text-muted uppercase">Incassato</dt><dd className="text-lg font-extrabold text-night">{formatEur(rev.collected)}</dd><dd className="text-xs text-muted">altro {formatEur(rev.collected_other)}</dd></div>
                <div><dt className="text-xs font-bold text-muted uppercase">Saldi aperti del giorno</dt><dd className="text-lg font-extrabold text-danger">{formatEur(due)}</dd></div>
              </dl>
            </Card>
          )}
          {!finance && <div className="mb-5"><Notice tone="neutral">Gli incassi sono visibili solo a chi ha il permesso sui dati economici.</Notice></div>}

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Occupazione per settore" />
              <ul className="divide-y divide-sand">
                {occ.bySector.map((s) => (
                  <li key={s.zone} className="px-4 py-3">
                    <div className="mb-1 flex justify-between text-sm font-bold text-night">
                      <span>Settore {s.zone}</span>
                      <span>{s.pct}% · {s.occupied}/{s.total}{s.outOfService ? ` · ${s.outOfService} fuori servizio` : ""}</span>
                    </div>
                    <div className="h-3 overflow-hidden rounded-full bg-sand" role="progressbar" aria-valuenow={s.pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Settore ${s.zone}`}>
                      <div className="h-full rounded-full bg-teal" style={{ width: `${s.pct}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>

            <Card className="overflow-hidden">
              <CardHeader title={`Attesi (${expected.length})`} hint="Prenotati per la giornata e non ancora entrati" />
              {expected.length === 0 ? (
                <EmptyState title="Nessun arrivo atteso" />
              ) : (
                expected.slice(0, 50).map((b) => (
                  <Row key={b.id} href={`/servizio/spiaggia/prenotazioni/${b.id}`}>
                    <span className="flex-1 font-bold text-night">{b.customer_name}</span>
                    <span className="text-sm text-muted">{byId.get(b.service_point_id)?.label ?? "—"} · {BEACH_PERIODS[b.period].label}</span>
                  </Row>
                ))
              )}
            </Card>

            <Card className="overflow-hidden lg:col-span-2">
              <CardHeader
                title={`Abbonati (${subs.length})`}
                hint="Mese e stagione validi da questa data"
                action={<Link href="/servizio/spiaggia/prenotazioni?vista=abbonati" className="text-sm font-bold text-teal-deep">Cerca</Link>}
              />
              {subs.length === 0 ? (
                <EmptyState title="Nessun abbonato" text="Gli abbonamenti si registrano da «Nuova prenotazione» con periodo mese o stagione." />
              ) : (
                subs.map((b) => {
                  const p = byId.get(b.service_point_id);
                  const bal = Math.max(b.price - b.paid_amount, 0);
                  return (
                    <Row key={b.id} href={`/servizio/spiaggia/prenotazioni/${b.id}`}>
                      <div className="min-w-0 flex-1">
                        <p className="font-bold text-night">{b.customer_name}</p>
                        <p className="text-sm text-muted">
                          {p ? pointName(p) : "—"} · {BEACH_PERIODS[b.period].label} fino al {formatDate(b.end_date)}
                          {b.customer_phone ? ` · ${b.customer_phone}` : ""}
                        </p>
                      </div>
                      {bal > 0 ? <Badge tone="danger">saldo {formatEur(bal)}</Badge> : <Badge tone="ok">Pagato</Badge>}
                    </Row>
                  );
                })
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-bold text-muted uppercase">{label}</p>
      <p className="mt-1 font-display text-3xl font-semibold text-night">{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </Card>
  );
}
