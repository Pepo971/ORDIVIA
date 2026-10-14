import Link from "next/link";
import { addDays, isoWeekdayOf, todayIn } from "@ordivia/domain";
import { Card, EmptyState, LinkButton, PageHeader, cx } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatDate } from "@/lib/format";
import { getReservations, getServices, resDate } from "@/lib/reservations-queries";
import { BASE, DateNav, ResTabs } from "../res-ui";

export const metadata = { title: "Prenotazioni della settimana" };
export const dynamic = "force-dynamic";

const ACTIVE = new Set(["in_attesa_conferma", "confermata", "arrivata", "completata"]);

export default async function SettimanaPage({ searchParams }: { searchParams: Promise<{ data?: string }> }) {
  const ctx = await requirePerm("reservations.manage");
  const sp = await searchParams;
  const today = todayIn(ctx.facility.timezone);
  const picked = resDate(ctx, sp.data);
  const monday = addDays(picked, 1 - isoWeekdayOf(picked));
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const [services, reservations] = await Promise.all([getServices(ctx.facility.id), getReservations(ctx.facility.id, days[0]!, days[6]!)]);

  const cell = (serviceId: string, d: string) => {
    const list = reservations.filter((r) => r.service_id === serviceId && r.res_date === d && ACTIVE.has(r.status));
    return { count: list.length, covers: list.reduce((s, r) => s + r.party_size, 0), pending: list.filter((r) => r.status === "in_attesa_conferma").length };
  };
  const dayTotal = (d: string) => {
    const list = reservations.filter((r) => r.res_date === d && ACTIVE.has(r.status));
    return { count: list.length, covers: list.reduce((s, r) => s + r.party_size, 0) };
  };

  return (
    <div>
      <PageHeader title="Settimana" subtitle="Prenotazioni e coperti per giorno e servizio." action={<LinkButton href={`${BASE}/nuova`}>Nuova prenotazione</LinkButton>} />
      <ResTabs active="settimana" />
      <div className="mb-4">
        <DateNav date={monday} today={today} basePath={`${BASE}/settimana`} step={7} />
      </div>
      {services.length === 0 ? (
        <Card>
          <EmptyState title="Nessun servizio prenotabile" action={<LinkButton href={`${BASE}/servizi`}>Crea un servizio</LinkButton>} />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[42rem] text-sm">
            <thead>
              <tr className="border-b border-sand text-left">
                <th className="px-3 py-2 font-bold text-muted">Servizio</th>
                {days.map((d) => (
                  <th key={d} className={cx("px-2 py-2 text-center font-bold", d === today ? "text-teal-deep" : "text-night")}>
                    <Link href={`${BASE}?data=${d}`} className="hover:underline">
                      {formatDate(d)}
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.id} className="border-b border-sand">
                  <td className="px-3 py-2 font-bold text-night">{s.name}</td>
                  {days.map((d) => {
                    const c = cell(s.id, d);
                    return (
                      <td key={d} className="px-2 py-2 text-center">
                        {c.count === 0 ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <Link href={`${BASE}?data=${d}`} className="block rounded-lg bg-warm px-1 py-1 hover:bg-sand">
                            <span className="block font-extrabold text-night">{c.covers}</span>
                            <span className="block text-[0.7rem] text-muted">{c.count} pren.</span>
                            {c.pending > 0 && <span className="block text-[0.7rem] font-bold text-warn">{c.pending} da conf.</span>}
                          </Link>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr>
                <td className="px-3 py-2 font-bold text-muted">Totale coperti</td>
                {days.map((d) => (
                  <td key={d} className="px-2 py-2 text-center font-extrabold text-night">
                    {dayTotal(d).covers || "—"}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
