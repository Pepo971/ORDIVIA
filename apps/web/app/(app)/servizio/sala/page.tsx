import Link from "next/link";
import { compareLabels, servicePointKindLabel, ticketAge } from "@ordivia/domain";
import { LiveRefresh } from "@/components/live-refresh";
import { Card, CardHeader, EmptyState, LinkButton, Notice, PageHeader, cx } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatEur } from "@/lib/format";
import { getActiveLines, getOpenOrders, getPendingCounts, getServicePoints, type PosOrder } from "@/lib/pos-queries";

export const metadata = { title: "Sala e comande" };
export const dynamic = "force-dynamic";

export default async function SalaPage({ searchParams }: { searchParams: Promise<{ tipo?: string; annullata?: string }> }) {
  const ctx = await requirePerm("pos.operate");
  const sp = await searchParams;
  const [points, orders, active, pending] = await Promise.all([
    getServicePoints(ctx.facility.id),
    getOpenOrders(ctx.facility.id),
    getActiveLines(ctx.facility.id),
    getPendingCounts(ctx.facility.id),
  ]);
  const pendingTotal = [...pending.values()].reduce((s, v) => s + v, 0);
  const now = new Date();

  const byPoint = new Map(orders.filter((o) => o.service_point_id).map((o) => [o.service_point_id!, o]));
  const loose = orders.filter((o) => !o.service_point_id);
  const readyByOrder = new Map<string, number>();
  for (const l of active) if (l.status === "pronta") readyByOrder.set(l.order_id, (readyByOrder.get(l.order_id) ?? 0) + 1);

  const kinds = [...new Set(points.map((p) => p.kind))].sort((a, b) => (a === "tavolo" ? -1 : b === "tavolo" ? 1 : a.localeCompare(b)));
  const kind = sp.tipo && kinds.includes(sp.tipo) ? sp.tipo : kinds[0];
  const visible = points.filter((p) => p.kind === kind);
  const zones = new Map<string, typeof visible>();
  for (const p of visible.sort((a, b) => compareLabels(a.label, b.label))) {
    const z = p.zone ?? "Senza zona";
    zones.set(z, [...(zones.get(z) ?? []), p]);
  }
  const canManage = can(ctx, "pos.supervise", "menu.manage", "org.manage");

  return (
    <div>
      <LiveRefresh tables={["pos_orders", "pos_order_lines", "portal_submissions"]} facilityId={ctx.facility.id} />
      <PageHeader
        title="Sala e comande"
        subtitle={`${orders.length} ${orders.length === 1 ? "comanda aperta" : "comande aperte"}`}
        action={canManage ? <LinkButton href="/servizio/sala/tavoli" variant="secondary">Tavoli e zone</LinkButton> : undefined}
      />
      {sp.annullata && <div className="mb-4"><Notice tone="ok">Comanda annullata.</Notice></div>}
      {pendingTotal > 0 && (
        <div className="mb-4">
          <Notice tone="night">
            {pendingTotal === 1 ? "1 riga online da confermare" : `${pendingTotal} righe online da confermare`}: apri le comande con il bollino «Online».
          </Notice>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-2">
        <LinkButton href="/servizio/sala/nuova?tipo=banco" variant="secondary" className="min-h-14 text-base">+ Banco</LinkButton>
        <LinkButton href="/servizio/sala/nuova?tipo=asporto" variant="secondary" className="min-h-14 text-base">+ Asporto</LinkButton>
      </div>

      {loose.length > 0 && (
        <Card className="mb-4 overflow-hidden">
          <CardHeader title="Banco e asporto" />
          <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
            {loose.map((o) => (
              <OrderTile key={o.id} order={o} label={o.destination_label} ready={readyByOrder.get(o.id) ?? 0} pending={pending.get(o.id) ?? 0} now={now} />
            ))}
          </div>
        </Card>
      )}

      {kinds.length > 1 && (
        <nav className="mb-4 flex gap-2 overflow-x-auto" aria-label="Tipo di destinazione">
          {kinds.map((k) => (
            <Link
              key={k}
              href={`/servizio/sala?tipo=${k}`}
              aria-current={k === kind ? "page" : undefined}
              className={cx(
                "flex min-h-11 items-center rounded-full border px-4 text-sm font-bold whitespace-nowrap",
                k === kind ? "border-night bg-night text-warm" : "border-sand-deep bg-white text-night",
              )}
            >
              {servicePointKindLabel(k)}
              <span className="ml-1.5 opacity-70">{points.filter((p) => p.kind === k && byPoint.has(p.id)).length}/{points.filter((p) => p.kind === k).length}</span>
            </Link>
          ))}
        </nav>
      )}

      {points.length === 0 ? (
        <Card>
          <EmptyState
            title="Nessun tavolo"
            text={canManage ? "Crea i tavoli della sala in blocco, ad esempio «1-20» in Sala e «T1-T8» in Terrazza." : "Chiedi a un responsabile di creare i tavoli. Intanto puoi aprire comande al banco o da asporto."}
            action={canManage ? <LinkButton href="/servizio/sala/tavoli">Crea i tavoli</LinkButton> : undefined}
          />
        </Card>
      ) : (
        [...zones].map(([zone, list]) => (
          <section key={zone} className="mb-5">
            <h2 className="mb-2 text-sm font-bold tracking-wide text-muted uppercase">{zone}</h2>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {list.map((p) => {
                const o = byPoint.get(p.id);
                return o ? (
                  <OrderTile key={p.id} order={o} label={p.label} ready={readyByOrder.get(o.id) ?? 0} pending={pending.get(o.id) ?? 0} now={now} />
                ) : (
                  <Link
                    key={p.id}
                    href={`/servizio/sala/nuova?punto=${p.id}`}
                    className="flex min-h-20 flex-col items-center justify-center rounded-xl border-2 border-dashed border-sand-deep bg-white p-2 text-center hover:border-teal"
                  >
                    <span className="font-display text-xl font-semibold text-night">{p.label}</span>
                    <span className="text-xs text-muted">{p.seats ? `${p.seats} posti` : "libero"}</span>
                  </Link>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function OrderTile({ order, label, ready, pending, now }: { order: PosOrder; label: string; ready: number; pending: number; now: Date }) {
  const age = ticketAge(order.opened_at, now, { warn: 60, late: 120 });
  return (
    <Link
      href={`/servizio/sala/${order.id}`}
      className={cx(
        "relative flex min-h-20 flex-col items-center justify-center rounded-xl p-2 text-center",
        ready > 0 ? "bg-ok text-white" : "bg-night text-warm",
      )}
    >
      <span className="font-display text-xl leading-tight font-semibold">{label}</span>
      <span className="text-xs opacity-80">
        {order.covers > 0 ? `${order.covers} cop. · ` : ""}
        {formatEur(order.total)}
      </span>
      <span className="text-[0.7rem] opacity-70">{age.label}</span>
      {ready > 0 && <span className="absolute -top-1.5 -right-1.5 rounded-full bg-warn px-2 text-xs font-bold text-white">{ready} pronti</span>}
      {(pending > 0 || order.source === "portale") && (
        <span className={cx("absolute -top-1.5 -left-1.5 rounded-full px-2 text-xs font-bold", pending > 0 ? "animate-pulse bg-teal text-white" : "bg-teal-soft text-teal-deep")}>
          Online{pending > 0 ? ` · ${pending}` : ""}
        </span>
      )}
    </Link>
  );
}
