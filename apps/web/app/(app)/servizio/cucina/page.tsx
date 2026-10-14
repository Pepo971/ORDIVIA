import Link from "next/link";
import { groupIncastri, incastroLabel, ticketAge, type AgeTone } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Card, CardHeader, EmptyState, LinkButton, PageHeader, cx } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatTime } from "@/lib/format";
import { getActiveLines, getOrdersByIds, getPrepStations, type PosLine } from "@/lib/pos-queries";
import { setLinesStatus } from "./actions";

export const metadata = { title: "Cucina e bar" };
export const dynamic = "force-dynamic";

const AGE_CLASS: Record<AgeTone, string> = {
  fresh: "border-ok bg-white",
  warn: "border-warn bg-warn-soft",
  late: "border-danger bg-danger-soft",
};
const AGE_BADGE: Record<AgeTone, string> = { fresh: "bg-ok text-white", warn: "bg-warn text-white", late: "bg-danger text-white" };

export default async function CucinaPage({ searchParams }: { searchParams: Promise<{ centro?: string }> }) {
  const ctx = await requirePerm("pos.kitchen");
  const sp = await searchParams;
  const stations = await getPrepStations(ctx.facility.id);
  const station = stations.find((s) => s.id === sp.centro) ?? stations[0];
  const tz = ctx.facility.timezone;
  const now = new Date();

  const all = await getActiveLines(ctx.facility.id);
  const lines = all.filter((l) => l.prep_station_id === (station?.id ?? null) && l.status !== "pronta");
  const orders = await getOrdersByIds([...new Set(lines.map((l) => l.order_id))]);
  const oMap = new Map(orders.map((o) => [o.id, o]));

  // Ticket = comanda × invio (righe inviate insieme), ordinati dal più vecchio.
  const tickets = new Map<string, PosLine[]>();
  for (const l of lines) {
    const k = `${l.order_id}|${l.sent_at.slice(0, 16)}`;
    tickets.set(k, [...(tickets.get(k) ?? []), l]);
  }
  const ticketList = [...tickets.values()].sort((a, b) => a[0]!.sent_at.localeCompare(b[0]!.sent_at));
  const incastri = groupIncastri(
    lines.map((l) => ({
      id: l.id,
      orderId: l.order_id,
      destination: oMap.get(l.order_id)?.destination_label ?? "",
      destinationKind: oMap.get(l.order_id)?.destination_kind,
      menuItemId: l.menu_item_id,
      name: l.name,
      qty: l.qty,
      status: l.status,
      sentAt: l.sent_at,
      notes: l.notes,
      without: l.without,
      allergy: l.allergy,
    })),
    now,
  );
  const readyCount = all.filter((l) => l.prep_station_id === station?.id && l.status === "pronta").length;

  return (
    <div>
      <LiveRefresh tables={["pos_order_lines"]} facilityId={ctx.facility.id} intervalMs={20000} />
      <PageHeader
        title={station ? station.name : "Cucina e bar"}
        subtitle={`${lines.length} righe da preparare${readyCount ? ` · ${readyCount} pronte al pass` : ""}`}
        action={<LinkButton href={`/servizio/cucina/disponibilita${station ? `?centro=${station.id}` : ""}`} variant="secondary">Esauriti e porzioni</LinkButton>}
      />

      {stations.length > 1 && (
        <nav className="mb-4 flex gap-2 overflow-x-auto" aria-label="Centro di produzione">
          {stations.map((s) => {
            const n = all.filter((l) => l.prep_station_id === s.id && l.status !== "pronta").length;
            return (
              <Link
                key={s.id}
                href={`/servizio/cucina?centro=${s.id}`}
                aria-current={s.id === station?.id ? "page" : undefined}
                className={cx("flex min-h-12 items-center gap-2 rounded-full border px-4 font-bold whitespace-nowrap", s.id === station?.id ? "border-night bg-night text-warm" : "border-sand-deep bg-white text-night")}
              >
                {s.name}
                {n > 0 && <span className="rounded-full bg-warn px-2 text-xs text-white">{n}</span>}
              </Link>
            );
          })}
        </nav>
      )}

      {!station ? (
        <Card><EmptyState title="Nessun centro di produzione" text="Chi gestisce il menu può creare cucina, pizzeria, bar… e collegare i piatti." /></Card>
      ) : (
        <>
          {incastri.length > 0 && (
            <Card className="mb-4 border-teal bg-teal-soft">
              <CardHeader title="Incastri" hint="Piatti uguali, senza varianti né allergie, arrivati negli ultimi 5 minuti. Solo un suggerimento: decidi tu." />
              <ul className="divide-y divide-teal/20">
                {incastri.map((g) => (
                  <li key={g.menuItemId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-lg font-bold text-night">{incastroLabel(g)}</p>
                      <p className="text-sm text-teal-deep">{g.destinations.join(" · ")}</p>
                    </div>
                    <ActionForm action={setLinesStatus}>
                      {g.lineIds.map((id) => (
                        <input key={id} type="hidden" name="line_id" value={id} />
                      ))}
                      <input type="hidden" name="to" value="in_preparazione" />
                      <SubmitButton pendingText="…" className="min-h-12">Avvia insieme</SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {ticketList.length === 0 ? (
            <Card><EmptyState title="Tutto evaso" text="Le nuove comande compaiono qui in tempo reale." /></Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {ticketList.map((t) => {
                const o = oMap.get(t[0]!.order_id);
                const age = ticketAge(t[0]!.sent_at, now);
                const todo = t.filter((l) => l.status === "inviata" || l.status === "in_preparazione");
                return (
                  <section key={`${t[0]!.order_id}${t[0]!.sent_at}`} className={cx("overflow-hidden rounded-[var(--radius-card)] border-2", AGE_CLASS[age.tone])}>
                    <header className="flex items-center justify-between gap-2 border-b border-black/5 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate font-display text-xl font-semibold text-night">{o?.destination_label ?? "Comanda"}</p>
                        <p className="text-xs text-muted">
                          #{o?.number} · {formatTime(t[0]!.sent_at, tz)}
                          {o && o.covers > 0 ? ` · ${o.covers} coperti` : ""}
                        </p>
                      </div>
                      <span className={cx("rounded-lg px-2.5 py-1 text-sm font-bold", AGE_BADGE[age.tone])}>{age.label}</span>
                    </header>
                    <ul>
                      {t
                        .sort((a, b) => a.course - b.course)
                        .map((l) => (
                          <li key={l.id} className="border-b border-black/5 last:border-b-0">
                            <ActionForm action={setLinesStatus}>
                              <input type="hidden" name="line_id" value={l.id} />
                              <input type="hidden" name="to" value={l.status === "inviata" ? "in_preparazione" : "pronta"} />
                              <button
                                type="submit"
                                className={cx("flex min-h-14 w-full items-start gap-2 px-3 py-2 text-left active:bg-black/5", l.status === "in_preparazione" && "bg-teal-soft/70")}
                                aria-label={`${l.name}: ${l.status === "inviata" ? "inizia" : "segna pronto"}`}
                              >
                                <span className="w-8 shrink-0 text-xl font-bold text-night">{l.qty}×</span>
                                <span className="min-w-0 flex-1">
                                  <span className="block text-lg leading-tight font-bold text-night">{l.name}</span>
                                  {l.without.length > 0 && <span className="block text-sm font-bold text-warn">senza {l.without.join(", ")}</span>}
                                  {l.notes && <span className="block text-sm text-ink">{l.notes}</span>}
                                  {l.allergy && (
                                    <span className="mt-0.5 block rounded bg-danger px-1.5 py-0.5 text-sm font-bold text-white">⚠ ALLERGIA{l.allergy_note ? `: ${l.allergy_note}` : ""}</span>
                                  )}
                                </span>
                                <span className="shrink-0 text-right text-xs">
                                  <span className="block font-bold text-muted">U{l.course}</span>
                                  <span className={cx("mt-1 block rounded px-1.5 py-0.5 font-bold", l.status === "inviata" ? "bg-sand text-ink" : "bg-teal text-white")}>
                                    {l.status === "inviata" ? "Da fare" : "In corso"}
                                  </span>
                                </span>
                              </button>
                            </ActionForm>
                          </li>
                        ))}
                    </ul>
                    {todo.length > 1 && (
                      <ActionForm action={setLinesStatus} className="p-2">
                        {todo.map((l) => (
                          <input key={l.id} type="hidden" name="line_id" value={l.id} />
                        ))}
                        <input type="hidden" name="to" value="pronta" />
                        <SubmitButton full variant="secondary" pendingText="…" className="min-h-12">Tutto pronto</SubmitButton>
                      </ActionForm>
                    )}
                  </section>
                );
              })}
            </div>
          )}
          <p className="mt-4 text-sm text-muted">Tocca una riga: «Da fare» → «In corso» → pronta (passa al pass). Verde sotto i 10 minuti, giallo fino a 20, rosso oltre.</p>
        </>
      )}
    </div>
  );
}
