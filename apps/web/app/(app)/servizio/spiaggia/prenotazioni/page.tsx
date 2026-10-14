import { BEACH_PERIODS, balanceDue, todayIn } from "@ordivia/domain";
import { Badge, Card, EmptyState, Input, LinkButton, PageHeader, Row, Select } from "@/components/ui";
import { LiveRefresh } from "@/components/live-refresh";
import { requirePerm } from "@/lib/context";
import { formatDate, formatEur } from "@/lib/format";
import { BOOKING_COLUMNS, BOOKING_STATUS, getBeachPoints, normBooking, pointName } from "@/lib/beach-queries";
import { createClient } from "@/lib/supabase/server";
import { BeachTabs } from "../beach-ui";

export const metadata = { title: "Prenotazioni spiaggia" };
export const dynamic = "force-dynamic";

const VIEWS = {
  prossime: "Da oggi in poi",
  abbonati: "Abbonamenti (mese e stagione)",
  passate: "Passate",
  tutte: "Tutte",
} as const;

export default async function PrenotazioniPage({ searchParams }: { searchParams: Promise<{ q?: string; vista?: string }> }) {
  const ctx = await requirePerm("beach.operate", "beach.manage");
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const vista = (sp.vista && sp.vista in VIEWS ? sp.vista : "prossime") as keyof typeof VIEWS;
  const today = todayIn(ctx.facility.timezone);
  const supabase = await createClient();

  let query = supabase.from("beach_bookings").select(BOOKING_COLUMNS).eq("facility_id", ctx.facility.id);
  if (vista === "prossime") query = query.gte("end_date", today).in("status", ["prenotata", "presente"]);
  if (vista === "abbonati") query = query.in("period", ["mese", "stagione"]).gte("end_date", today).in("status", ["prenotata", "presente"]);
  if (vista === "passate") query = query.lt("end_date", today);
  if (q) {
    const safe = q.replace(/[%_,()]/g, " ");
    query = query.or(`customer_name.ilike.%${safe}%,customer_phone.ilike.%${safe}%,customer_email.ilike.%${safe}%`);
  }
  const [{ data, error }, points] = await Promise.all([
    query.order("start_date", { ascending: vista !== "passate" }).limit(200),
    getBeachPoints(ctx.facility.id, true),
  ]);
  if (error) throw new Error(error.message);
  const bookings = (data ?? []).map(normBooking);
  const byId = new Map(points.map((p) => [p.id, p]));

  return (
    <div>
      <LiveRefresh tables={["beach_bookings"]} facilityId={ctx.facility.id} />
      <PageHeader title="Prenotazioni" subtitle="Cerca un cliente, controlla arrivi e abbonamenti." action={<LinkButton href="/servizio/spiaggia/prenotazioni/nuova">Nuova prenotazione</LinkButton>} />
      <BeachTabs ctx={ctx} active="prenotazioni" />

      <form className="mb-4 grid gap-2 sm:grid-cols-[1fr_16rem_auto]" action="/servizio/spiaggia/prenotazioni">
        <label className="sr-only" htmlFor="q">Cerca cliente</label>
        <Input id="q" name="q" defaultValue={q} placeholder="Nome, telefono o email del cliente" type="search" />
        <label className="sr-only" htmlFor="vista">Vista</label>
        <Select id="vista" name="vista" defaultValue={vista}>
          {Object.entries(VIEWS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </Select>
        <button className="rounded-xl bg-night px-4 py-2.5 font-bold text-warm">Cerca</button>
      </form>

      <Card className="overflow-hidden">
        {bookings.length === 0 ? (
          <EmptyState
            title={q ? "Nessun cliente trovato" : "Nessuna prenotazione"}
            text={q ? "Prova con una parte del nome o del numero di telefono." : "Le prenotazioni si creano dalla mappa della giornata o con «Nuova prenotazione»."}
          />
        ) : (
          bookings.map((b) => {
            const p = byId.get(b.service_point_id);
            const due = balanceDue(b.price, b.paid_amount);
            return (
              <Row key={b.id} href={`/servizio/spiaggia/prenotazioni/${b.id}`}>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-bold text-night">
                    {b.customer_name}
                    <Badge tone={BOOKING_STATUS[b.status].tone}>{BOOKING_STATUS[b.status].label}</Badge>
                  </p>
                  <p className="text-sm text-muted">
                    {p ? pointName(p) : "—"} · {BEACH_PERIODS[b.period].label} ·{" "}
                    {b.start_date === b.end_date ? formatDate(b.start_date) : `${formatDate(b.start_date)} → ${formatDate(b.end_date)}`}
                    {b.customer_phone ? ` · ${b.customer_phone}` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-night">{formatEur(b.price)}</p>
                  {due > 0 && b.status !== "annullata" && <p className="text-xs font-bold text-danger">saldo {formatEur(due)}</p>}
                </div>
              </Row>
            );
          })
        )}
      </Card>
      {bookings.length === 200 && <p className="mt-2 text-sm text-muted">Mostrate le prime 200: affina la ricerca.</p>}
    </div>
  );
}
