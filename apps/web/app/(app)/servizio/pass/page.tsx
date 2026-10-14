import { ticketAge } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Card, EmptyState, PageHeader, cx } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { getActiveLines, getOrdersByIds, getPrepStations } from "@/lib/pos-queries";
import { setLinesStatus } from "../cucina/actions";

export const metadata = { title: "Pass" };
export const dynamic = "force-dynamic";

export default async function PassPage() {
  const ctx = await requirePerm("pos.kitchen", "pos.supervise");
  const now = new Date();
  const [lines, stations] = await Promise.all([getActiveLines(ctx.facility.id), getPrepStations(ctx.facility.id)]);
  const stName = new Map(stations.map((s) => [s.id, s.name]));
  const orders = await getOrdersByIds([...new Set(lines.map((l) => l.order_id))]);
  // Prima le comande con piatti pronti, poi per anzianità del pronto più vecchio.
  const rows = orders
    .map((o) => {
      const ls = lines.filter((l) => l.order_id === o.id);
      const ready = ls.filter((l) => l.status === "pronta");
      const oldestReady = ready.map((l) => l.ready_at ?? l.sent_at).sort()[0];
      return { o, ls, ready, cooking: ls.filter((l) => l.status !== "pronta"), oldestReady };
    })
    .sort((a, b) => (a.oldestReady && b.oldestReady ? a.oldestReady.localeCompare(b.oldestReady) : a.oldestReady ? -1 : b.oldestReady ? 1 : a.o.opened_at.localeCompare(b.o.opened_at)));
  const canServe = can(ctx, "pos.kitchen", "pos.operate");

  return (
    <div>
      <LiveRefresh tables={["pos_order_lines"]} facilityId={ctx.facility.id} intervalMs={20000} />
      <PageHeader title="Pass" subtitle={`${lines.filter((l) => l.status === "pronta").length} piatti pronti da portare`} />
      {rows.length === 0 ? (
        <Card><EmptyState title="Niente in uscita" text="Quando cucina o bar segnano un piatto pronto, compare qui." /></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map(({ o, ready, cooking, oldestReady }) => {
            const wait = oldestReady ? ticketAge(oldestReady, now, { warn: 3, late: 6 }) : null;
            return (
              <Card key={o.id} className={cx("overflow-hidden border-2", ready.length === 0 ? "border-sand-deep" : wait?.tone === "late" ? "border-danger" : wait?.tone === "warn" ? "border-warn" : "border-ok")}>
                <header className="flex items-center justify-between gap-2 border-b border-sand px-3 py-2">
                  <div>
                    <p className="font-display text-xl font-semibold text-night">{o.destination_label}</p>
                    <p className="text-xs text-muted">#{o.number}{o.covers > 0 ? ` · ${o.covers} coperti` : ""}</p>
                  </div>
                  {wait && <span className="rounded-lg bg-ok px-2 py-1 text-sm font-bold text-white">pronto da {wait.label}</span>}
                </header>
                {ready.length > 0 && (
                  <div className="bg-ok-soft px-3 py-2">
                    <p className="text-xs font-bold tracking-wide text-ok uppercase">Pronti</p>
                    <ul>
                      {ready.map((l) => (
                        <li key={l.id} className="py-0.5 text-lg font-bold text-night">
                          {l.qty}× {l.name}
                          <span className="ml-1 text-xs font-normal text-muted">U{l.course} · {l.prep_station_id ? stName.get(l.prep_station_id) : ""}</span>
                          {l.allergy && <span className="ml-1 rounded bg-danger px-1 text-xs text-white">ALLERGIA</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {cooking.length > 0 && (
                  <div className="px-3 py-2">
                    <p className="text-xs font-bold tracking-wide text-muted uppercase">Ancora in lavorazione</p>
                    <ul>
                      {cooking.map((l) => (
                        <li key={l.id} className="py-0.5 text-sm text-ink">
                          {l.qty}× {l.name} <span className="text-xs text-muted">· {l.status === "inviata" ? "da fare" : "in corso"} · {l.prep_station_id ? stName.get(l.prep_station_id) : ""}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {ready.length > 0 && canServe && (
                  <ActionForm action={setLinesStatus} className="p-2">
                    {ready.map((l) => (
                      <input key={l.id} type="hidden" name="line_id" value={l.id} />
                    ))}
                    <input type="hidden" name="to" value="servita" />
                    <SubmitButton full pendingText="…" className="min-h-12">
                      Servito{cooking.length > 0 ? " (i pronti)" : ""}
                    </SubmitButton>
                  </ActionForm>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
