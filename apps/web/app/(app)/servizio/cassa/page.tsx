import { LiveRefresh } from "@/components/live-refresh";
import { Badge, Card, CardHeader, EmptyState, LinkButton, Notice, PageHeader, Row } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatEur, formatTime } from "@/lib/format";
import { getOpenCashSession, getOpenOrders, getPendingCounts } from "@/lib/pos-queries";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Cassa" };
export const dynamic = "force-dynamic";

export default async function CassaPage() {
  const ctx = await requirePerm("pos.operate", "pos.supervise");
  const tz = ctx.facility.timezone;
  const supabase = await createClient();
  const [orders, session, closedRes, pending] = await Promise.all([
    getOpenOrders(ctx.facility.id),
    getOpenCashSession(ctx.facility.id),
    supabase
      .from("pos_orders")
      .select("id, destination_label, number, total, closed_at, pos_payments(fiscal_status)")
      .eq("facility_id", ctx.facility.id)
      .eq("status", "chiusa")
      .order("closed_at", { ascending: false })
      .limit(20),
    getPendingCounts(ctx.facility.id),
  ]);
  const closed = (closedRes.data ?? []) as unknown as { id: string; destination_label: string; number: number; total: number; closed_at: string; pos_payments: { fiscal_status: string }[] }[];
  const sorted = [...orders].sort((a, b) => Number(b.paid > 0) - Number(a.paid > 0) || a.opened_at.localeCompare(b.opened_at));
  const openTotal = orders.reduce((s, o) => s + o.total, 0);

  return (
    <div>
      <LiveRefresh tables={["pos_orders", "pos_payments", "pos_cash_sessions", "portal_submissions"]} facilityId={ctx.facility.id} />
      <PageHeader
        title="Cassa"
        subtitle={`${orders.length} conti aperti · ${formatEur(openTotal)}`}
        action={can(ctx, "pos.supervise") ? <LinkButton href="/servizio/cassa/turno" variant="secondary">Turno di cassa</LinkButton> : undefined}
      />
      <div className="mb-4 space-y-2">
        {session ? (
          <Notice tone="teal">Turno aperto alle {formatTime(session.opened_at, tz)} con fondo {formatEur(session.opening_float)}.</Notice>
        ) : (
          <Notice tone="warn">
            Nessun turno di cassa aperto: si possono incassare solo carta e altri metodi.
            {can(ctx, "pos.supervise") ? " Apri il turno da «Turno di cassa»." : " Chiedi a un responsabile di aprirlo."}
          </Notice>
        )}
        <Notice tone="neutral">Ordivia non è un registratore fiscale: per ogni pagamento emetti lo scontrino dal registratore telematico.</Notice>
      </div>

      <Card className="mb-5 overflow-hidden">
        <CardHeader title="Conti aperti" />
        {sorted.length === 0 ? (
          <EmptyState title="Nessun conto aperto" text="Le comande aperte dalla sala compaiono qui." />
        ) : (
          sorted.map((o) => (
            <Row key={o.id} href={`/servizio/cassa/${o.id}`} className="min-h-16">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 font-bold text-night">
                  {o.destination_label}
                  {o.source === "portale" && <Badge tone="teal">Online</Badge>}
                </p>
                {(pending.get(o.id) ?? 0) > 0 && (
                  <p className="text-sm font-bold text-teal-deep">
                    {pending.get(o.id) === 1 ? "1 riga online da confermare" : `${pending.get(o.id)} righe online da confermare`}
                  </p>
                )}
                <p className="text-sm text-muted">
                  #{o.number} · dalle {formatTime(o.opened_at, tz)}
                  {o.covers > 0 ? ` · ${o.covers} coperti` : ""}
                </p>
              </div>
              <div className="text-right">
                <p className="text-lg font-bold text-night">{formatEur(o.total)}</p>
                {o.paid > 0 && (o.paid >= o.total && o.total > 0 && !pending.get(o.id) ? <Badge tone="ok">Saldato, da chiudere</Badge> : <Badge tone="warn">Pagato {formatEur(o.paid)}</Badge>)}
              </div>
            </Row>
          ))
        )}
      </Card>

      {closed.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title="Chiusi di recente" />
          {closed.map((o) => {
            const toFiscal = o.pos_payments.some((p) => p.fiscal_status === "da_fiscalizzare");
            return (
              <Row key={o.id} href={`/servizio/cassa/${o.id}`}>
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-night">{o.destination_label}</p>
                  <p className="text-sm text-muted">#{o.number} · chiuso {formatTime(o.closed_at, tz)}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-night">{formatEur(o.total)}</p>
                  {toFiscal && <Badge tone="warn">Scontrino da emettere</Badge>}
                </div>
              </Row>
            );
          })}
        </Card>
      )}
    </div>
  );
}
